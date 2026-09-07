/**
 * gatewayRead transport boundary tests: sanitized auth-provider failures and
 * malformed credential headers, explicit redirect refusal, one finite
 * whole-operation deadline that starts before auth and stays active through
 * the streaming body, fire-and-forget body cancellation with reader release,
 * static error details that never echo private text, timer cleanup and the
 * ordinary success path.
 *
 * Two bounded delayed probes also prove the bound beats a transport/body
 * that ignores the abort signal: a settlement 80 ms after the deadline never
 * outlives a 10 ms request timeout, the late response is cancelled and never
 * delivered, the pending body read is cancelled without awaiting settlement
 * and its late rejection is swallowed.
 *
 * All deadlines are tiny (25–100 ms) deterministic overrides; no test ever
 * waits for the real 30 s default.
 */

import assert from "node:assert/strict";

import {
  GATEWAY_DEFAULT_TIMEOUT_MS,
  type GatewayAuthProviderV1,
  type GatewayHttpRequestV1,
  gatewayRead,
  type GatewayTransportV1,
} from "../../../src/adapters/gateway/http.ts";
import { portError, portOk } from "../../../src/contracts/ports.ts";

import { jsonResponse, recordingTransport } from "./helpers.ts";

const BASE = "https://gateway.example";
const PATH = "/admin/sentinel/incidents";
const DEADLINE_DETAIL = "gateway request exceeded the time bound";
const SECRET_MARKER = "TOPSECRET-PRIVATE-MARKER";

function baseRequest(
  overrides: Partial<GatewayHttpRequestV1> = {},
): GatewayHttpRequestV1 {
  return {
    baseUrl: BASE,
    path: PATH,
    query: new URLSearchParams({ limit: "1" }),
    responseByteCap: 64 * 1_024,
    requestTimeoutMs: 30,
    ...overrides,
  };
}

function okAuth(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve(portOk({ Authorization: "Bearer synthetic-token" })),
  };
}

/** Provider whose rejection carries a plausible private secret in its text. */
function throwingAuth(message: string): GatewayAuthProviderV1 {
  return {
    headers: () => Promise.reject(new Error(message)),
  };
}

function typedFailAuth(): GatewayAuthProviderV1 {
  return {
    headers: () => Promise.resolve(portError("unavailable", "no token store")),
  };
}

/** Provider returning runtime-invalid header data through a type cast. */
function malformedAuth(headers: unknown): GatewayAuthProviderV1 {
  return {
    headers: () => Promise.resolve(portOk(headers as Record<string, string>)),
  };
}

function hangingAuth(): GatewayAuthProviderV1 {
  return {
    headers: () => new Promise(() => {}),
  };
}

interface BodySpyV1 {
  stream: ReadableStream<Uint8Array>;
  pulls(): number;
  cancelled(): boolean;
  errored(): boolean;
}

/** Streaming body over custom chunks; records pulls and teardown callbacks. */
function chunkedBody(chunks: Uint8Array[]): BodySpyV1 {
  let index = 0;
  let pulls = 0;
  let cancelled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
    pull() {
      pulls++;
      if (index < chunks.length) {
        controller!.enqueue(chunks[index++]!);
      } else {
        controller!.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    pulls: () => pulls,
    cancelled: () => cancelled,
    errored: () => false,
  };
}

/**
 * Stalled body: response headers arrived, but the body never produces a
 * chunk. Like native fetch, aborting the request errors the body stream, so
 * the pending read rejects when the deadline fires.
 */
function stalledBody(signal: AbortSignal | null): BodySpyV1 {
  let cancelled = false;
  let errored = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      if (signal !== null) {
        signal.addEventListener("abort", () => {
          if (!errored) {
            errored = true;
            try {
              controller!.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // Stream already settled; teardown is complete either way.
            }
          }
        });
      }
    },
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    pulls: () => 0,
    cancelled: () => cancelled,
    errored: () => errored,
  };
}

function bodyTransport(
  makeBody: (signal: AbortSignal | null) => BodySpyV1,
  status = 200,
): {
  transport: GatewayTransportV1;
  bodies: BodySpyV1[];
} {
  const bodies: BodySpyV1[] = [];
  const transport: GatewayTransportV1 = (input, init) => {
    assert.ok(input !== undefined);
    const spy = makeBody(init?.signal ?? null);
    bodies.push(spy);
    return Promise.resolve(new Response(spy.stream, { status }));
  };
  return { transport, bodies };
}

/** Fetch that never delivers headers; rejects on abort, like native fetch. */
function stalledHeadersTransport(): {
  transport: GatewayTransportV1;
  signals: (AbortSignal | null)[];
} {
  const signals: (AbortSignal | null)[] = [];
  const transport: GatewayTransportV1 = (_input, init) => {
    signals.push(init?.signal ?? null);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  };
  return { transport, signals };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the stream is unlocked, i.e. the body reader was released. */
function readerReleased(stream: ReadableStream<Uint8Array>): boolean {
  try {
    const reader = stream.getReader();
    reader.releaseLock();
    return true;
  } catch {
    return false;
  }
}

function assertStatic(
  result: { ok: false; error: { kind: string; detail: string } },
  kind: string,
  detail: string,
): void {
  assert.equal(result.error.kind, kind);
  assert.equal(result.error.detail, detail);
  assert.ok(!result.error.detail.includes(SECRET_MARKER));
}

Deno.test("gateway http: auth provider rejection is a sanitized typed auth_failed", async () => {
  // Both an async rejection and a synchronous throw must become the same
  // typed auth_failed fault and never escape as a raw rejection.
  const providers: { name: string; auth: GatewayAuthProviderV1 }[] = [
    {
      name: "reject",
      auth: throwingAuth(
        `credential file /Users/nv/.secrets/${SECRET_MARKER} missing`,
      ),
    },
    {
      name: "throw",
      auth: {
        headers(): Promise<never> {
          throw new Error(`sync credential read failed: ${SECRET_MARKER}`);
        },
      },
    },
  ];
  for (const { name, auth } of providers) {
    const transport = recordingTransport(() =>
      jsonResponse({ data: [], cursor: null })
    );
    const result = await gatewayRead(baseRequest(), transport, auth);
    assert.ok(!result.ok, `${name}: expected a typed failure`);
    if (!result.ok) {
      assertStatic(
        result,
        "auth_failed",
        "gateway credentials are unavailable",
      );
    }
    // The credential failure must never reach the transport, and the private
    // marker must never surface in the typed detail.
    assert.equal(transport.requests.length, 0, name);
  }
});

Deno.test("gateway http: typed credential failure is auth_failed without a request", async () => {
  const transport = recordingTransport(() => jsonResponse({ ok: true }));
  const result = await gatewayRead(baseRequest(), transport, typedFailAuth());
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "auth_failed", "gateway credentials are unavailable");
  }
  assert.equal(transport.requests.length, 0);
});

Deno.test("gateway http: malformed credential headers are a sanitized auth_failed", async () => {
  // Non-string value (a plausible secret shape that Headers would coerce).
  const badValue = await gatewayRead(
    baseRequest(),
    recordingTransport(() => jsonResponse({ ok: true })),
    malformedAuth({ Authorization: SECRET_MARKER, count: 42 }),
  );
  assert.ok(!badValue.ok);
  if (!badValue.ok) {
    assertStatic(
      badValue,
      "auth_failed",
      "gateway auth provider returned malformed headers",
    );
    assert.ok(!badValue.error.detail.includes("Authorization"));
  }

  // Header name the Headers constructor rejects.
  const badName = await gatewayRead(
    baseRequest(),
    recordingTransport(() => jsonResponse({ ok: true })),
    malformedAuth({ "bad\nname": SECRET_MARKER }),
  );
  assert.ok(!badName.ok);
  if (!badName.ok) {
    assertStatic(
      badName,
      "auth_failed",
      "gateway auth provider returned malformed headers",
    );
  }

  // Non-record credential value.
  const badShape = await gatewayRead(
    baseRequest(),
    recordingTransport(() => jsonResponse({ ok: true })),
    malformedAuth(`Bearer ${SECRET_MARKER}`),
  );
  assert.ok(!badShape.ok);
  if (!badShape.ok) {
    assertStatic(
      badShape,
      "auth_failed",
      "gateway auth provider returned malformed headers",
    );
  }
});

Deno.test("gateway http: redirects are refused and a refusal is a sanitized unavailable", async () => {
  // A native fetch with redirect: "error" rejects on a 3xx; the rejection
  // message is host-specific and could name a private location.
  const refusal = await gatewayRead(
    baseRequest(),
    recordingTransport(() => {
      throw new TypeError(
        `Fetch failed: Encountered redirect while redirecting to https://evil.example/steal?${SECRET_MARKER}`,
      );
    }),
    okAuth(),
  );
  assert.ok(!refusal.ok);
  if (!refusal.ok) {
    assertStatic(refusal, "unavailable", "gateway transport is unavailable");
  }

  // The success path must explicitly carry redirect: "error".
  const recording = recordingTransport(() => jsonResponse({ ok: true }));
  const success = await gatewayRead(baseRequest(), recording, okAuth());
  assert.ok(success.ok);
  assert.equal(recording.requests.length, 1);
  assert.equal(recording.requests[0]!.redirect, "error");
});

Deno.test("gateway http: stalled headers abort at the deadline with a static fault", async () => {
  const { transport, signals } = stalledHeadersTransport();
  const started = Date.now();
  const result = await gatewayRead(baseRequest(), transport, okAuth());
  const elapsed = Date.now() - started;
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "unavailable", DEADLINE_DETAIL);
  }
  // The stall is cut at the tiny test deadline, far below any real wait.
  assert.ok(elapsed < 3_000, `stall survived ${elapsed}ms`);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

Deno.test("gateway http: whole-operation deadline covers a hanging credential source", async () => {
  let transportCalls = 0;
  const transport: GatewayTransportV1 = () => {
    transportCalls++;
    return Promise.resolve(jsonResponse({ ok: true }));
  };
  const result = await gatewayRead(baseRequest(), transport, hangingAuth());
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "unavailable", DEADLINE_DETAIL);
  }
  // Expiry during authentication must never start a later fetch.
  assert.equal(transportCalls, 0);
});

Deno.test("gateway http: stalled body after headers aborts and releases the reader", async () => {
  const { transport, bodies } = bodyTransport((signal) => stalledBody(signal));
  const result = await gatewayRead(baseRequest(), transport, okAuth());
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "unavailable", DEADLINE_DETAIL);
  }
  assert.equal(bodies.length, 1);
  const spy = bodies[0]!;
  assert.equal(spy.errored(), true, "deadline must error the stalled body");
  assert.equal(
    readerReleased(spy.stream),
    true,
    "body reader must be released",
  );
});

Deno.test("gateway http: over-cap body is cancelled while streaming, never buffered first", async () => {
  const chunks = Array.from({ length: 6 }, () => new Uint8Array(20).fill(7));
  const { transport, bodies } = bodyTransport(() => chunkedBody(chunks));
  const result = await gatewayRead(
    baseRequest({ responseByteCap: 50 }),
    transport,
    okAuth(),
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "invalid", "gateway response exceeds the byte bound");
  }
  const spy = bodies[0]!;
  // The body is rejected as it streams: only the chunks up to the first
  // over-cap read were pulled (at most one lookahead chunk; a full drain
  // would pull all six plus the close pull).
  assert.ok(
    spy.pulls() <= 4,
    `body was drained before the cap check: ${spy.pulls()} pulls`,
  );
  assert.equal(spy.cancelled(), true, "over-cap reader must be cancelled");
  assert.equal(readerReleased(spy.stream), true, "reader must be released");
});

Deno.test("gateway http: status rejection releases the body with a typed status fault", async () => {
  const { transport, bodies } = bodyTransport(
    () => chunkedBody([new Uint8Array(8).fill(1)]),
    503,
  );
  const result = await gatewayRead(baseRequest(), transport, okAuth());
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "unavailable", "gateway producer is unavailable");
  }
  assert.equal(bodies[0]!.cancelled(), true, "rejected body must be cancelled");
});

Deno.test("gateway http: invalid timeout override is rejected before any I/O", async () => {
  let authCalls = 0;
  let transportCalls = 0;
  const countingAuth: GatewayAuthProviderV1 = {
    headers: () => {
      authCalls++;
      return Promise.resolve(portOk({ Authorization: "Bearer x" }));
    },
  };
  const countingTransport: GatewayTransportV1 = () => {
    transportCalls++;
    return Promise.resolve(jsonResponse({ ok: true }));
  };
  for (
    const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]
  ) {
    const result = await gatewayRead(
      baseRequest({ requestTimeoutMs: bad }),
      countingTransport,
      countingAuth,
    );
    assert.ok(!result.ok);
    if (!result.ok) {
      assertStatic(
        result,
        "invalid",
        "gateway request timeout is outside the accepted bounds",
      );
    }
  }
  assert.equal(authCalls, 0);
  assert.equal(transportCalls, 0);
  // The production surface exposes the recorded default, never env/CLI knobs.
  assert.equal(GATEWAY_DEFAULT_TIMEOUT_MS, 30_000);
});

Deno.test("gateway http: timer is cleared on ordinary success and never fires later", async () => {
  const transport = recordingTransport(() => jsonResponse({ ok: true }));
  const result = await gatewayRead(
    baseRequest({ requestTimeoutMs: 100 }),
    transport,
    okAuth(),
  );
  assert.ok(result.ok);
  const signal = transport.requests[0]!.signal;
  assert.ok(signal !== null, "transport must receive an AbortSignal");
  assert.equal(signal!.aborted, false);
  // Past the deadline: a leaked timer would have aborted the signal by now.
  await sleep(250);
  assert.equal(signal!.aborted, false, "timer must be cleared on exit");
});

Deno.test("gateway http: abort-ignoring headers cannot outlive the deadline and the late response is cancelled", async () => {
  // The transport ignores the abort signal and only settles 80 ms after the
  // 10 ms request timeout. Without the deadline race the call would wait for
  // the late settlement; with it the typed fault returns at the bound.
  let lateCancelled = false;
  const signals: (AbortSignal | null)[] = [];
  const transport: GatewayTransportV1 = (_input, init) => {
    signals.push(init?.signal ?? null);
    return new Promise<Response>((resolve) => {
      setTimeout(() => {
        const stream = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            lateCancelled = true;
          },
        });
        resolve(new Response(stream, { status: 200 }));
      }, 80);
    });
  };
  const started = Date.now();
  const result = await gatewayRead(
    baseRequest({ requestTimeoutMs: 10 }),
    transport,
    okAuth(),
  );
  const elapsed = Date.now() - started;
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "unavailable", DEADLINE_DETAIL);
  }
  assert.ok(
    elapsed < 60,
    `abort-ignoring headers held the operation for ${elapsed}ms`,
  );
  assert.equal(signals[0]?.aborted, true, "fetch must be aborted on deadline");
  // The late response settles after the assertions; it must be cancelled,
  // never delivered, and its settlement must not surface as an error.
  await sleep(120);
  assert.equal(lateCancelled, true, "late response body must be cancelled");
});

Deno.test("gateway http: pending body read ignoring abort is cancelled at the deadline and its late rejection is swallowed", async () => {
  // The body never reacts to the abort signal: the pending read settles only
  // 80 ms after the 10 ms request timeout, with a rejection. The deadline
  // race must return the fault at the bound, cancel the reader while the
  // read is still pending (never awaiting its settlement), and the late
  // rejection must be handled, not surface as an unhandled rejection.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new DOMException("Aborted", "AbortError")),
          80,
        );
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  const transport: GatewayTransportV1 = () =>
    Promise.resolve(new Response(stream, { status: 200 }));
  const started = Date.now();
  const result = await gatewayRead(
    baseRequest({ requestTimeoutMs: 10 }),
    transport,
    okAuth(),
  );
  const elapsed = Date.now() - started;
  assert.ok(!result.ok);
  if (!result.ok) {
    assertStatic(result, "unavailable", DEADLINE_DETAIL);
  }
  assert.ok(
    elapsed < 60,
    `abort-ignoring body held the operation for ${elapsed}ms`,
  );
  assert.equal(
    cancelled,
    true,
    "pending body read must be cancelled without awaiting settlement",
  );
  // Let the late read rejection settle; the abandoned deadline race must
  // swallow it (a leak here fails the test via an unhandled rejection).
  await sleep(120);
});

Deno.test("gateway http: ordinary success sends one authenticated GET with error redirect", async () => {
  const transport = recordingTransport(() =>
    jsonResponse({ data: [], cursor: null })
  );
  const result = await gatewayRead(baseRequest(), transport, okAuth());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.status, 200);
  assert.deepEqual(result.value.body, { data: [], cursor: null });
  assert.equal(transport.requests.length, 1);
  const request = transport.requests[0]!;
  assert.equal(request.method, "GET");
  assert.equal(request.redirect, "error");
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.signal!.aborted, false);
  assert.equal(request.headers.get("accept"), "application/json");
  assert.equal(
    request.headers.get("authorization"),
    "Bearer synthetic-token",
  );
});
