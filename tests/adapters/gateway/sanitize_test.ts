/**
 * Permanent sanitizer regression tests: phase-3 gateway replay sanitization
 * (`sanitizeGatewayReplay`). Synthetic public objects and bytes only, built
 * directly from the retained-capture shapes; every case exercises the real
 * export — no mocks, no duplicated sanitizer logic, no private capture data.
 */

import assert from "node:assert/strict";

import { canonicalStringifySha256 } from "../../../src/contracts/canonical.ts";
import type {
  RetainedGatewayCaptureV1,
  RetainedGatewayUpstreamAttemptV1,
  RetainedGatewayUpstreamV1,
} from "../../../src/adapters/gateway/decrypt.ts";
import {
  type GatewaySanitizerPolicyV1,
  sanitizeGatewayReplay,
} from "../../../src/adapters/gateway/sanitize.ts";

const PUBLIC_MODEL = "gpt-reserve";
const UNAVAILABLE_DETAIL = "Gateway replay cannot be sanitized";
const INVALID_POLICY_DETAIL = "Invalid gateway sanitizer policy";

const POLICY: GatewaySanitizerPolicyV1 = {
  publicModels: [PUBLIC_MODEL],
  publicHeaders: {
    // Trusted host literals: a capture value must match one exactly.
    accept: ["*/*", "application/json"],
    originator: ["sentinel-gateway"],
    "user-agent": ["sentinel-test-agent/1.0"],
  },
};

const CAPTURE_ID = "capture-synth-0001";
const FINGERPRINT = "af".repeat(32);
const CASE_GROUP_DIGEST = "cd".repeat(32);
const GIT_SHA = "1a".repeat(20);

// ---------------------------------------------------------------------------
// Synthetic helper bytes
// ---------------------------------------------------------------------------

function textBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Independently decode the joined fixture chunks (never a sanitizer path). */
function decodeJoin(chunks: readonly string[]): string {
  let binary = "";
  for (const chunk of chunks) binary += atob(chunk);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// ---------------------------------------------------------------------------
// Synthetic request/upstream shapes (public fabrications only)
// ---------------------------------------------------------------------------

const RESPONSES_REQUEST: Record<string, unknown> = {
  model: PUBLIC_MODEL,
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: "private question text" }],
    },
    {
      type: "function_call",
      call_id: "call_priv_001",
      name: "search_private",
      arguments: JSON.stringify({ q: "private query" }),
    },
  ],
  stream: true,
  temperature: 0.5,
  max_output_tokens: 1024,
  store: false,
};

const CHAT_REQUEST: Record<string, unknown> = {
  model: PUBLIC_MODEL,
  messages: [
    {
      role: "tool",
      tool_call_id: "call_priv_001",
      content: "private tool result",
    },
    { role: "user", content: "private question text" },
  ],
  tools: [{ type: "function", function: { name: "search_private" } }],
  stream: true,
  top_p: 0.9,
  max_completion_tokens: 256,
  parallel_tool_calls: true,
};

/** SSE body for the Responses capture: LF, CRLF and blank boundaries. */
function responsesSseText(): string {
  return [
    "event:response.created\r\n",
    'data:{"type":"response.created","response":{"id":"resp_priv_001","object":"response","status":"in_progress","model":"gpt-reserve"}}\r\n',
    "\r\n",
    'data:{"type":"response.output_item.added","output_index":0,"item":{"id":"item_priv_001","type":"message","status":"in_progress","role":"assistant","content":[]}}\n',
    "\n",
    'data:{"type":"response.content_part.added","item_id":"item_priv_001","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n',
    "\n",
    'data:{"type":"response.output_text.delta","item_id":"item_priv_001","output_index":0,"content_index":0,"delta":"private streaming answer"}\n',
    "\n",
    ":server note\n",
    "\n",
    'data:{"type":"response.completed","response":{"id":"resp_priv_001","object":"response","status":"completed","model":"gpt-reserve","output":[{"id":"item_priv_001","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"private final answer"}]}],"usage":{"input_tokens":12,"output_tokens":34,"total_tokens":46}}}\n',
    "\n",
    "data:[DONE]\n",
  ].join("");
}

const CHAT_UPSTREAM: Record<string, unknown> = {
  id: "call_priv_001",
  object: "chat.completion",
  created: 1_700_000_000,
  model: PUBLIC_MODEL,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_priv_001",
          type: "function",
          function: {
            name: "search_private",
            arguments: JSON.stringify({ q: "private query" }),
          },
        }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
};

// ---------------------------------------------------------------------------
// Retained-capture builders (exact public wire shapes, fresh per call)
// ---------------------------------------------------------------------------

type AttemptOverrides = Partial<
  Omit<RetainedGatewayUpstreamAttemptV1, "chunks_base64"> & {
    chunks: readonly string[];
  }
>;

function makeAttempt(
  overrides: AttemptOverrides = {},
): RetainedGatewayUpstreamAttemptV1 {
  const { chunks = [], ...rest } = overrides;
  return {
    provider: "chatgpt_codex",
    status: null,
    content_type: null,
    chunks_base64: chunks,
    terminal: "fetch_error",
    ...rest,
  };
}

function makeTrace(
  attempts: readonly RetainedGatewayUpstreamAttemptV1[] = [makeAttempt()],
  overrides: Partial<
    Pick<
      RetainedGatewayUpstreamV1,
      "attempts_truncated" | "bytes_truncated" | "chunks_truncated"
    >
  > = {},
): RetainedGatewayUpstreamV1 {
  return {
    version: 1,
    attempts: [...attempts],
    attempts_truncated: overrides.attempts_truncated ?? false,
    bytes_truncated: overrides.bytes_truncated ?? false,
    chunks_truncated: overrides.chunks_truncated ?? false,
  };
}

function responsesTrace(): RetainedGatewayUpstreamV1 {
  return makeTrace([
    makeAttempt({
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks: [b64(textBytes(responsesSseText()))],
      terminal: "eof",
    }),
  ]);
}

function chatTrace(): RetainedGatewayUpstreamV1 {
  return makeTrace([
    makeAttempt({
      provider: "chatgpt_codex",
      status: 200,
      content_type: "application/json",
      chunks: [b64(textBytes(JSON.stringify(CHAT_UPSTREAM)))],
      terminal: "eof",
    }),
  ]);
}

function makeCapture(
  body: Uint8Array<ArrayBuffer>,
  options: {
    endpoint?: "/v1/responses" | "/v1/chat/completions";
    headers?: Record<string, string>;
    upstream?: RetainedGatewayUpstreamV1;
    captureId?: string;
    fingerprint?: string;
    caseGroupDigest?: string;
    gitSha?: string;
  } = {},
): RetainedGatewayCaptureV1 {
  return {
    version: 1,
    captureId: options.captureId ?? CAPTURE_ID,
    fingerprint: options.fingerprint ?? FINGERPRINT,
    caseGroupDigest: options.caseGroupDigest ?? CASE_GROUP_DIGEST,
    capturedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 48 * 60 * 60 * 1_000,
    requestId: "req-synth-0001",
    gitSha: options.gitSha ?? GIT_SHA,
    denoRevision: "revision-synth-0001",
    endpoint: options.endpoint ?? "/v1/responses",
    method: "POST",
    contentType: "application/json; charset=utf-8",
    compatibilityHeaders: options.headers ?? {},
    failureSignature: "sig-synth-0001",
    observation: {
      status: 200,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "gateway_error",
      syntheticTerminalType: null,
      providerRoute: "chatgpt_codex",
    },
    clientObservation: {
      status: 200,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "gateway_error",
      framingValid: true,
      providerRoute: "chatgpt_codex",
    },
    upstream: options.upstream ?? makeTrace(),
    body,
  };
}

// ---------------------------------------------------------------------------
// Result assertions (exact fixed error text, no input echo)
// ---------------------------------------------------------------------------

async function expectUnavailable(
  capture: RetainedGatewayCaptureV1,
  markers: readonly string[] = [],
  policy: GatewaySanitizerPolicyV1 = POLICY,
): Promise<void> {
  const result = await sanitizeGatewayReplay(capture, policy);
  assert.deepEqual(result, {
    ok: false,
    error: { kind: "unavailable", detail: UNAVAILABLE_DETAIL },
  });
  const json = JSON.stringify(result);
  for (const marker of markers) {
    assert.equal(json.includes(marker), false, `marker leaked: ${marker}`);
  }
}

async function expectInvalidPolicy(
  policy: unknown,
  markers: readonly string[] = [],
): Promise<void> {
  const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)));
  const result = await sanitizeGatewayReplay(
    capture,
    policy as GatewaySanitizerPolicyV1,
  );
  assert.deepEqual(result, {
    ok: false,
    error: { kind: "invalid", detail: INVALID_POLICY_DETAIL },
  });
  const json = JSON.stringify(result);
  for (const marker of markers) {
    assert.equal(json.includes(marker), false, `marker leaked: ${marker}`);
  }
}

// ---------------------------------------------------------------------------
// Acceptance: real Responses replay, headers, provenance bounds
// ---------------------------------------------------------------------------

Deno.test("sanitize: responses replay redacts request and SSE body, links IDs, keeps public controls", async () => {
  const body = textBytes(JSON.stringify(RESPONSES_REQUEST));
  const capture = makeCapture(body, {
    upstream: responsesTrace(),
    headers: {
      accept: "text/html", // non-matching literal -> omitted
      authorization: "Bearer private-token-abc123", // unapproved name -> omitted
      originator: "private-originator-value", // non-matching literal -> omitted
      "user-agent": "sentinel-test-agent/1.0", // exact policy literal -> kept
      "User-Agent": "sentinel-test-agent/1.0", // wrong case -> omitted
    },
  });

  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const { fixture, restrictedProvenance } = result.value;

  assert.equal(fixture.version, 1);
  assert.equal(fixture.request.endpoint, "/v1/responses");
  assert.equal(fixture.request.method, "POST");
  assert.equal(fixture.request.contentType, "application/json");
  assert.deepEqual(fixture.request.compatibilityHeaders, {
    "user-agent": "sentinel-test-agent/1.0",
  });

  const request = JSON.parse(fixture.request.body) as Record<string, unknown>;
  assert.equal(request.model, PUBLIC_MODEL);
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.equal(request.temperature, 0.5);
  assert.equal(request.max_output_tokens, 1024);
  const input = request.input as Record<string, unknown>[];
  assert.equal(
    (input[0]!.content as Record<string, unknown>[])[0]!.text,
    "fixture text",
  );
  assert.equal(input[1]!.call_id, "fixture_id_1");
  assert.equal(input[1]!.name, "fixture_name_1");
  assert.equal(input[1]!.arguments, "{}");
  assert.equal(fixture.request.body.includes("priv"), false);
  assert.equal(
    JSON.stringify(fixture.request).includes("Bearer private-token-abc123"),
    false,
  );

  const attempt = fixture.upstream.attempts[0]!;
  assert.equal(attempt.provider, "chatgpt_codex");
  assert.equal(attempt.status, 200);
  assert.equal(attempt.content_type, "text/event-stream");
  assert.equal(attempt.terminal, "eof");
  assert.equal(fixture.upstream.version, 1);
  assert.equal(fixture.upstream.attempts_truncated, false);
  assert.equal(fixture.upstream.bytes_truncated, false);
  assert.equal(fixture.upstream.chunks_truncated, false);

  // Decoded output: placeholders link the request ids to the upstream events.
  const decoded = decodeJoin(attempt.chunks_base64);
  assert.equal(decoded.includes("priv"), false);
  assert.equal(decoded.includes("fixture text"), true);
  assert.equal(decoded.includes('"id":"fixture_id_2"'), true);
  assert.equal(decoded.includes('"item_id":"fixture_id_3"'), true);
  assert.equal(decoded.includes(": fixture comment\n"), true);
  assert.equal(decoded.includes("data:[DONE]\n"), true);
  const order = [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.completed",
  ].map((event) => decoded.indexOf(event));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));

  assert.equal(restrictedProvenance.redacted, true);
  assert.equal(restrictedProvenance.equivalence, "unverified");
  assert.equal(restrictedProvenance.sanitizer, "gateway-structural-v1");
  assert.equal(restrictedProvenance.sourceCaptureId, CAPTURE_ID);
  assert.equal(restrictedProvenance.sourceGitSha, GIT_SHA);
  assert.equal(restrictedProvenance.sourceFingerprint, FINGERPRINT);
  assert.equal(restrictedProvenance.sourceCaseGroupDigest, CASE_GROUP_DIGEST);
});

Deno.test("sanitize: chat replay links IDs across request and JSON upstream, zeroes private numbers", async () => {
  const body = textBytes(JSON.stringify(CHAT_REQUEST));
  const capture = makeCapture(body, {
    endpoint: "/v1/chat/completions",
    upstream: chatTrace(),
  });

  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const { fixture } = result.value;

  assert.equal(fixture.request.endpoint, "/v1/chat/completions");
  const request = JSON.parse(fixture.request.body) as Record<string, unknown>;
  assert.equal(request.model, PUBLIC_MODEL);
  assert.equal(request.stream, true);
  assert.equal(request.top_p, 0.9);
  assert.equal(request.max_completion_tokens, 256);
  assert.equal(request.parallel_tool_calls, true);
  const messages = request.messages as Record<string, unknown>[];
  assert.equal(messages[0]!.content, "fixture text");
  assert.equal(messages[1]!.content, "fixture text");
  const tools = request.tools as Record<string, unknown>[];
  assert.equal(
    (tools[0]!.function as Record<string, unknown>).name,
    "fixture_name_1",
  );

  const attempt = fixture.upstream.attempts[0]!;
  assert.equal(attempt.content_type, "application/json");
  assert.equal(attempt.terminal, "eof");
  const upstream = JSON.parse(decodeJoin(attempt.chunks_base64)) as Record<
    string,
    unknown
  >;
  // Same original id string in request and upstream -> one placeholder.
  assert.equal(messages[0]!.tool_call_id, "fixture_id_1");
  assert.equal(upstream.id, "fixture_id_1");
  assert.deepEqual(
    ((upstream.choices as Record<string, unknown>[])[0]!.message as Record<
      string,
      unknown
    >).tool_calls,
    [{
      id: "fixture_id_1",
      type: "function",
      function: { name: "fixture_name_1", arguments: "{}" },
    }],
  );
  assert.equal(upstream.created, 0);
  assert.deepEqual(upstream.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  assert.equal(JSON.stringify(upstream).includes("priv"), false);
});

Deno.test("sanitize: digests are independently recomputable and bind the exact source", async () => {
  const body = textBytes(JSON.stringify(RESPONSES_REQUEST));
  const upstream = responsesTrace();
  const capture = makeCapture(body, { upstream });

  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const { fixture, restrictedProvenance } = result.value;

  assert.equal(
    restrictedProvenance.sourceRequestDigest,
    await sha256hex(body),
  );
  assert.equal(
    restrictedProvenance.sourceUpstreamDigest,
    await canonicalStringifySha256(upstream),
  );
  assert.equal(
    restrictedProvenance.payloadDigest,
    await canonicalStringifySha256(fixture),
  );
});

Deno.test("sanitize: public fixture excludes every restricted provenance field and private value", async () => {
  const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
    upstream: responsesTrace(),
  });
  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const fixture = result.value.fixture;
  const forbiddenKeys = [
    "redacted",
    "equivalence",
    "sourceCaptureId",
    "sourceGitSha",
    "sourceFingerprint",
    "sourceCaseGroupDigest",
    "sourceRequestDigest",
    "sourceUpstreamDigest",
    "payloadDigest",
  ];
  const keys: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        collect(child);
      }
    }
  };
  collect(fixture);
  for (const key of forbiddenKeys) {
    assert.equal(keys.includes(key), false, `restricted key leaked: ${key}`);
  }
  const json = JSON.stringify(fixture);
  for (
    const privateValue of [
      CAPTURE_ID,
      FINGERPRINT,
      CASE_GROUP_DIGEST,
      GIT_SHA,
      "private question text",
    ]
  ) {
    assert.equal(json.includes(privateValue), false);
  }
});

// ---------------------------------------------------------------------------
// Acceptance: SSE framing, terminals and bodyless statuses
// ---------------------------------------------------------------------------

Deno.test("sanitize: SSE line endings, blank boundaries, split UTF-8, comments, DONE and ordering survive", async () => {
  const sse = [
    'data:{"type":"response.output_text.delta","delta":"hé"}\n',
    "\n",
    "event:response.output_text.done\r\n",
    'data:{"type":"response.output_text.done","text":"private done"}\r\n',
    "\r\n",
    ": note\r",
    "\ndata:[DONE]\r",
  ].join("");
  const bytes = textBytes(sse);
  // Split inside the two-byte "é" (C3 A9): the first chunk ends between the
  // lead byte and the continuation byte of the character.
  const splitAt = textBytes(sse.slice(0, sse.indexOf("é") + 1)).length - 1;
  const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
    upstream: makeTrace([
      makeAttempt({
        status: 200,
        content_type: "text/event-stream",
        chunks: [b64(bytes.slice(0, splitAt)), b64(bytes.slice(splitAt))],
        terminal: "eof",
      }),
    ]),
  });

  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const chunks = result.value.fixture.upstream.attempts[0]!.chunks_base64;
  assert.equal(chunks.length, 2);
  const decoded = decodeJoin(chunks);
  assert.equal(
    decoded,
    [
      'data:{"type":"response.output_text.delta","delta":"fixture text"}\n',
      "\n",
      "event:response.output_text.done\r\n",
      'data:{"type":"response.output_text.done","text":"fixture text"}\r\n',
      "\r\n",
      ": fixture comment\r",
      "\n",
      "data:[DONE]\r",
    ].join(""),
  );
});

Deno.test("sanitize: eof, read_error, cancelled and headerless fetch_error terminals are preserved", async () => {
  const chunk = b64(
    textBytes('data:{"type":"response.output_text.delta","delta":"x"}\n'),
  );
  const attempts = [
    makeAttempt({
      status: 200,
      content_type: "text/event-stream",
      chunks: [chunk],
      terminal: "eof",
    }),
    makeAttempt({
      status: 200,
      content_type: "text/event-stream",
      chunks: [chunk],
      terminal: "read_error",
    }),
    makeAttempt({
      status: 200,
      content_type: "text/event-stream",
      chunks: [chunk],
      terminal: "cancelled",
    }),
    makeAttempt({
      status: null,
      content_type: null,
      chunks: [],
      terminal: "fetch_error",
    }),
  ];
  const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
    upstream: makeTrace(attempts),
  });

  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const out = result.value.fixture.upstream.attempts;
  assert.equal(out.length, 4);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(out[index]!.terminal, attempts[index]!.terminal);
    assert.equal(out[index]!.status, 200);
    assert.equal(out[index]!.content_type, "text/event-stream");
    assert.equal(
      decodeJoin(out[index]!.chunks_base64),
      'data:{"type":"response.output_text.delta","delta":"fixture text"}\n',
    );
  }
  assert.deepEqual(out[3], {
    provider: "chatgpt_codex",
    status: null,
    content_type: null,
    chunks_base64: [],
    terminal: "fetch_error",
  });
});

Deno.test("sanitize: valid bodyless 204/205/304 responses stay bodyless", async () => {
  for (const status of [204, 205, 304]) {
    const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
      upstream: makeTrace([
        makeAttempt({
          status,
          content_type: "other",
          chunks: [],
          terminal: "eof",
        }),
      ]),
    });
    const result = await sanitizeGatewayReplay(capture, POLICY);
    assert.ok(result.ok);
    assert.deepEqual(result.value.fixture.upstream.attempts[0], {
      provider: "chatgpt_codex",
      status,
      content_type: "other",
      chunks_base64: [],
      terminal: "eof",
    });
  }
});

// ---------------------------------------------------------------------------
// Acceptance: refusal classes with static errors and no marker leaks
// ---------------------------------------------------------------------------

Deno.test("sanitize: request refusals — unknown keys, enums, non-allowlisted models, prototype keys, wrong roles", async () => {
  const cases: {
    body: unknown;
    endpoint?: "/v1/responses" | "/v1/chat/completions";
  }[] = [
    {
      body: {
        model: PUBLIC_MODEL,
        input: [{ role: "user", content: [] }],
        secretKey: "SECRET-MARKER",
      },
    },
    {
      body: {
        model: PUBLIC_MODEL,
        messages: [{ role: "admin", content: "x" }],
      },
      endpoint: "/v1/chat/completions",
    },
    {
      body: {
        model: "private-model-zz",
        input: [{ role: "user", content: [] }],
      },
    },
    {
      body: {
        model: PUBLIC_MODEL,
        input: [{ role: "user", content: [] }],
        constructor: {},
      },
    },
    {
      body: {
        model: PUBLIC_MODEL,
        input: [{ role: "user", content: [] }],
        toString: "x",
      },
    },
    {
      body: {
        model: PUBLIC_MODEL,
        input: [{ role: "user", content: [] }],
        ["__proto__"]: "x",
      },
    },
    { body: { model: 7, input: [{ role: "user", content: [] }] } },
    { body: { model: PUBLIC_MODEL, input: 7 } },
    {
      body: { model: PUBLIC_MODEL, messages: {} },
      endpoint: "/v1/chat/completions",
    },
    { body: { model: PUBLIC_MODEL, input: [{ role: 7, content: "x" }] } },
    { body: { model: PUBLIC_MODEL, input: [{ role: "user", content: 7 }] } },
  ];
  for (const item of cases) {
    const capture = makeCapture(textBytes(JSON.stringify(item.body)), {
      endpoint: item.endpoint ?? "/v1/responses",
    });
    await expectUnavailable(capture, ["SECRET-MARKER", "private-model-zz"]);
  }
});

Deno.test("sanitize: policy refusals — bad allowlist, unapproved header names and invalid literals", async () => {
  const cases: { policy: unknown; marker?: string }[] = [
    { policy: { publicModels: [], publicHeaders: { "user-agent": ["x"] } } },
    {
      policy: {
        publicModels: [PUBLIC_MODEL, PUBLIC_MODEL],
        publicHeaders: { "user-agent": ["x"] },
      },
    },
    {
      policy: {
        publicModels: ["bad model"],
        publicHeaders: { "user-agent": ["x"] },
      },
      marker: "bad model",
    },
    { policy: { publicModels: [7], publicHeaders: { "user-agent": ["x"] } } },
    {
      policy: {
        publicModels: [PUBLIC_MODEL],
        publicHeaders: { authorization: ["Bearer SECRET-TOKEN"] },
      },
      marker: "SECRET-TOKEN",
    },
    {
      policy: {
        publicModels: [PUBLIC_MODEL],
        publicHeaders: { "user-agent": [] },
      },
    },
    {
      policy: {
        publicModels: [PUBLIC_MODEL],
        publicHeaders: { "user-agent": ["x".repeat(257)] },
      },
    },
    {
      policy: {
        publicModels: [PUBLIC_MODEL, NaN],
        publicHeaders: { "user-agent": ["x"] },
      },
    },
    {
      policy: {
        publicModels: [PUBLIC_MODEL],
        publicHeaders: { "user-agent": ["x"], accept: [Infinity] },
      },
    },
  ];
  for (const item of cases) {
    await expectInvalidPolicy(
      item.policy,
      item.marker === undefined ? [] : [item.marker],
    );
  }
});

Deno.test("sanitize: trace refusals — pending, truncation, empty, unknown fields, bad provider/status/MIME/base64/UTF-8", async () => {
  const cases: RetainedGatewayUpstreamV1[] = [
    makeTrace([
      makeAttempt({ terminal: "pending", status: null, content_type: null }),
    ]),
    makeTrace([makeAttempt()], { attempts_truncated: true }),
    makeTrace([makeAttempt()], { chunks_truncated: true }),
    makeTrace([]),
    Object.assign(makeTrace(), { extra_field: 1 }),
    Object.assign(makeTrace(), { [Symbol("hidden")]: 1 }),
    makeTrace([
      Object.assign(makeAttempt(), { retries: 1 }),
    ]),
    makeTrace([{
      provider: "openai",
      status: null,
      content_type: null,
      chunks_base64: [],
      terminal: "fetch_error",
    } as unknown as RetainedGatewayUpstreamAttemptV1]),
    makeTrace([makeAttempt({ status: 600 })]),
    makeTrace([makeAttempt({ status: 200.5 })]),
    makeTrace([
      makeAttempt({
        content_type:
          "text/html" as unknown as AttemptOverrides["content_type"],
      }),
    ]),
    makeTrace([makeAttempt({ chunks: ["a"] })]),
    makeTrace([makeAttempt({ chunks: ["AB=="] })]),
    makeTrace([makeAttempt({ chunks: [""] })]),
    makeTrace([
      makeAttempt({
        status: 200,
        content_type: "application/json",
        chunks: ["gA=="],
        terminal: "eof",
      }),
    ]),
  ];
  for (const upstream of cases) {
    await expectUnavailable(
      makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), { upstream }),
    );
  }
});

Deno.test("sanitize: SSE body refusals — partial JSON, id/retry fields, multiline data, unknown events, non-object data", async () => {
  const bodies = [
    'data:{"type":"response.output_text.delta","delta":"x"\n',
    'data:{"type":"response.output_text.delta","delta":"x"}\ndata:{"type":"response.output_text.delta","delta":"y"}\n',
    'id:1\ndata:{"type":"response.output_text.delta","delta":"x"}\n',
    'retry:100\ndata:{"type":"response.output_text.delta","delta":"x"}\n',
    'event:response.teleport\ndata:{"type":"response.output_text.delta","delta":"x"}\n',
    "data:123\n",
    "data:\n",
  ];
  for (const body of bodies) {
    const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
      upstream: makeTrace([
        makeAttempt({
          status: 200,
          content_type: "text/event-stream",
          chunks: [b64(textBytes(body))],
          terminal: "eof",
        }),
      ]),
    });
    await expectUnavailable(capture);
  }
});

Deno.test("sanitize: inconsistent status/body/terminal combinations are refused", async () => {
  const oneByte = b64(textBytes("x"));
  const cases: AttemptOverrides[] = [
    {
      status: 200,
      content_type: "text/event-stream",
      chunks: [],
      terminal: "fetch_error",
    },
    {
      status: null,
      content_type: null,
      chunks: [oneByte],
      terminal: "fetch_error",
    },
    {
      status: null,
      content_type: "text/event-stream",
      chunks: [],
      terminal: "fetch_error",
    },
    { status: 204, content_type: "other", chunks: [], terminal: "cancelled" },
    { status: 204, content_type: "other", chunks: [oneByte], terminal: "eof" },
    { status: null, content_type: null, chunks: [], terminal: "eof" },
    { status: 200, content_type: "other", chunks: [oneByte], terminal: "eof" },
    {
      status: 200,
      content_type: "application/json",
      chunks: [],
      terminal: "eof",
    },
  ];
  for (const overrides of cases) {
    await expectUnavailable(
      makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
        upstream: makeTrace([makeAttempt(overrides)]),
      }),
    );
  }
});

Deno.test("sanitize: accessors and cycles at the public boundary are refused without invoking traps", async () => {
  const body = textBytes(JSON.stringify(RESPONSES_REQUEST));
  let captureReads = 0;
  const capture = makeCapture(body, { upstream: responsesTrace() });
  Object.defineProperty(capture, "body", {
    get() {
      captureReads += 1;
      return body;
    },
    enumerable: true,
    configurable: true,
  });
  await expectUnavailable(capture);
  assert.equal(captureReads, 0);

  let policyReads = 0;
  const policy = {
    publicModels: [PUBLIC_MODEL],
    publicHeaders: { "user-agent": ["x"] },
  };
  Object.defineProperty(policy, "publicHeaders", {
    get() {
      policyReads += 1;
      return { "user-agent": ["x"] };
    },
    enumerable: true,
    configurable: true,
  });
  await expectInvalidPolicy(policy);
  assert.equal(policyReads, 0);

  const cyclicHeaders: Record<string, string> = { "user-agent": "x" };
  (cyclicHeaders as Record<string, unknown>).self = cyclicHeaders;
  await expectUnavailable(
    makeCapture(body, { headers: cyclicHeaders, upstream: responsesTrace() }),
  );

  const cyclicPolicy = {
    publicModels: [PUBLIC_MODEL],
    publicHeaders: { "user-agent": ["x"] },
  } as unknown as Record<string, unknown>;
  cyclicPolicy.publicModels = [cyclicPolicy] as unknown as string[];
  await expectInvalidPolicy(cyclicPolicy);
});

// ---------------------------------------------------------------------------
// Acceptance: focused limits and bounds
// ---------------------------------------------------------------------------

Deno.test("sanitize: attempt, chunk, aggregate-byte and source-body bounds are enforced", async () => {
  const nineAttempts: RetainedGatewayUpstreamAttemptV1[] = [];
  for (let index = 0; index < 9; index += 1) nineAttempts.push(makeAttempt());
  await expectUnavailable(
    makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
      upstream: makeTrace(nineAttempts),
    }),
  );

  const tooManyChunks: string[] = [];
  for (let index = 0; index < 257; index += 1) {
    tooManyChunks.push(b64(new Uint8Array([0x79])));
  }
  await expectUnavailable(
    makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
      upstream: makeTrace([
        makeAttempt({
          status: 200,
          content_type: "application/json",
          chunks: tooManyChunks,
          terminal: "eof",
        }),
      ]),
    }),
  );

  const overBytes = new Uint8Array(131_073).fill(0x79);
  await expectUnavailable(
    makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
      upstream: makeTrace([
        makeAttempt({
          status: 200,
          content_type: "application/json",
          chunks: [b64(overBytes)],
          terminal: "eof",
        }),
      ]),
    }),
  );

  await expectUnavailable(makeCapture(new Uint8Array(0)));
  await expectUnavailable(makeCapture(new Uint8Array(33_554_433)));
});

Deno.test("sanitize: transformed expansion beyond the aggregate byte bound is refused", async () => {
  // 2100 SSE data events (data line + blank boundary): 2100 * 55 decoded
  // bytes (within the 131072 bound) but 2100 * 66 transformed bytes (beyond
  // it), because every "x" becomes the 12-character "fixture text". The node
  // budget (3 touches per data line) stays under the shared 8192 limit.
  const line = 'data:{"type":"response.output_text.delta","delta":"x"}\n\n';
  const count = 2100;
  const body = line.repeat(count);
  const capture = makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
    upstream: makeTrace([
      makeAttempt({
        status: 200,
        content_type: "text/event-stream",
        chunks: [b64(textBytes(body))],
        terminal: "eof",
      }),
    ]),
  });
  await expectUnavailable(capture);
});

// ---------------------------------------------------------------------------
// Acceptance: immutability, independence, determinism
// ---------------------------------------------------------------------------

Deno.test("sanitize: source is never mutated and outputs are independent copies", async () => {
  const body = textBytes(JSON.stringify(RESPONSES_REQUEST));
  const headers = {
    accept: "*/*",
    authorization: "Bearer private-token-abc123",
    "user-agent": "sentinel-test-agent/1.0",
  };
  const capture = makeCapture(body, { upstream: responsesTrace(), headers });
  const bodyBefore = capture.body.slice();
  const upstreamBefore = JSON.parse(
    JSON.stringify(capture.upstream),
  ) as RetainedGatewayUpstreamV1;
  const headersBefore = structuredClone(capture.compatibilityHeaders);
  const policyBefore = structuredClone(POLICY);

  const result = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(result.ok);
  const fixture = result.value.fixture;

  assert.deepEqual(capture.body, bodyBefore);
  assert.deepEqual(capture.upstream, upstreamBefore);
  assert.deepEqual(capture.compatibilityHeaders, headersBefore);
  assert.deepEqual(POLICY, policyBefore);

  assert.notEqual(fixture.upstream, capture.upstream);
  assert.notEqual(fixture.upstream.attempts, capture.upstream.attempts);
  assert.notEqual(
    fixture.upstream.attempts[0]!.chunks_base64,
    capture.upstream.attempts[0]!.chunks_base64,
  );
  assert.notEqual(
    fixture.request.compatibilityHeaders,
    capture.compatibilityHeaders,
  );

  const sourceChunk = upstreamBefore.attempts[0]!.chunks_base64[0]!;
  const fixtureChunk = fixture.upstream.attempts[0]!.chunks_base64[0]!;
  // The fixture chunk is transformed content; it must differ from the source.
  assert.notEqual(fixtureChunk, sourceChunk);
  // Mutating the fixture never changes the source (distinct allocations).
  (fixture.upstream.attempts[0]!.chunks_base64 as string[])[0] = "mutated";
  (fixture.request.compatibilityHeaders as Record<string, string>).accept =
    "mutated";
  assert.equal(capture.upstream.attempts[0]!.chunks_base64[0], sourceChunk);
  assert.equal(capture.compatibilityHeaders.accept, "*/*");
  assert.equal(
    capture.compatibilityHeaders.authorization,
    "Bearer private-token-abc123",
  );
  // The untouched source still sanitizes to the same fixture.
  const again = await sanitizeGatewayReplay(capture, POLICY);
  assert.ok(again.ok);
  assert.equal(
    again.value.fixture.upstream.attempts[0]!.chunks_base64[0],
    fixtureChunk,
  );
});

Deno.test("sanitize: deterministic results and source snapshot before the first await", async () => {
  const build = (): RetainedGatewayCaptureV1 =>
    makeCapture(textBytes(JSON.stringify(RESPONSES_REQUEST)), {
      upstream: responsesTrace(),
      headers: { "user-agent": "sentinel-test-agent/1.0" },
    });

  const first = await sanitizeGatewayReplay(build(), POLICY);
  const second = await sanitizeGatewayReplay(build(), POLICY);
  assert.ok(first.ok);
  assert.ok(second.ok);
  assert.deepEqual(second.value, first.value);
  const expectedChunk = first.value.fixture.upstream.attempts[0]!
    .chunks_base64[0]!;

  // Mutate the source synchronously right after the call starts: the result
  // must reflect the original bytes (snapshot before await), not the mutation.
  const capture = build();
  const bodyCopy = capture.body.slice();
  const pending = sanitizeGatewayReplay(capture, POLICY);
  capture.body.fill(0);
  (capture.upstream.attempts[0]!.chunks_base64 as string[])[0] = "corrupted";
  (capture.compatibilityHeaders as Record<string, string>)["user-agent"] =
    "corrupted";
  capture.captureId = "capture-corrupted";
  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.value.restrictedProvenance.sourceCaptureId, CAPTURE_ID);
  assert.equal(
    result.value.restrictedProvenance.sourceRequestDigest,
    await sha256hex(bodyCopy),
  );
  assert.equal(
    result.value.fixture.upstream.attempts[0]!.chunks_base64[0],
    expectedChunk,
  );
  assert.equal(
    result.value.fixture.request.compatibilityHeaders["user-agent"],
    "sentinel-test-agent/1.0",
  );
});
