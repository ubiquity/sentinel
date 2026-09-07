// Bounded authenticated REST transport discipline for the release module:
// bearer headers, finite deadlines, byte caps, redirect refusal, and static
// sanitized fault details. No secret literal ever appears in a fault.
import assert from "node:assert/strict";

import { portOk } from "../../src/contracts/ports.ts";
import {
  type DenoAuthProviderV1,
  type DenoHttpTransportV1,
  denoRestCall,
} from "../../src/release/http.ts";
import { API_URL } from "./helpers.ts";

function tokenProvider(value: string): DenoAuthProviderV1 {
  return { bearerToken: () => Promise.resolve(portOk(value)) };
}

function failingProvider(): DenoAuthProviderV1 {
  return {
    bearerToken: () =>
      Promise.resolve({
        ok: false as const,
        error: { kind: "auth_failed" as const, detail: "x" },
      }),
  };
}

function throwingProvider(): DenoAuthProviderV1 {
  return {
    bearerToken: () =>
      Promise.reject(new Error("credential leak: secret-value")),
  };
}

Deno.test("release http: GET attaches bearer token, accept and redirect refusal", async () => {
  let seenInit: RequestInit | undefined;
  const transport: DenoHttpTransportV1 = (_input, init) => {
    seenInit = init;
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const result = await denoRestCall(
    {
      baseUrl: API_URL,
      path: "/v2/apps/x",
      method: "GET",
      responseByteCap: 1024,
    },
    transport,
    tokenProvider("secret-token"),
  );
  assert.ok(result.ok);
  const init = seenInit!;
  assert.equal(init.redirect, "error");
  assert.equal(init.method, "GET");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer secret-token");
  assert.equal(headers.get("accept"), "application/json");
});

Deno.test("release http: auth provider failures are typed and never raise", async () => {
  for (const auth of [failingProvider(), throwingProvider()]) {
    const transport: DenoHttpTransportV1 = () =>
      Promise.resolve(new Response("{}", { status: 200 }));
    const result = await denoRestCall(
      {
        baseUrl: API_URL,
        path: "/v2/apps/x",
        method: "GET",
        responseByteCap: 1024,
      },
      transport,
      auth,
    );
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.error.kind, "auth_failed");
  }
});

Deno.test("release http: transport rejection is a sanitized unavailable fault", async () => {
  const transport: DenoHttpTransportV1 = () => {
    throw new Error("arbitrary secret text");
  };
  const result = await denoRestCall(
    {
      baseUrl: API_URL,
      path: "/v2/apps/x",
      method: "GET",
      responseByteCap: 1024,
    },
    transport,
    tokenProvider("t"),
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(!result.error.detail.includes("secret"));
  }
});

Deno.test("release http: whole-operation deadline bounds a hanging transport", async () => {
  const transport: DenoHttpTransportV1 = (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  };
  const result = await denoRestCall(
    {
      baseUrl: API_URL,
      path: "/v2/apps/x",
      method: "GET",
      responseByteCap: 1024,
      requestTimeoutMs: 30,
    },
    transport,
    tokenProvider("t"),
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.kind, "unavailable");
});

Deno.test("release http: body byte cap is enforced while streaming", async () => {
  const transport: DenoHttpTransportV1 = () =>
    Promise.resolve(new Response("x".repeat(4096), { status: 200 }));
  const result = await denoRestCall(
    {
      baseUrl: API_URL,
      path: "/v2/apps/x",
      method: "GET",
      responseByteCap: 64,
    },
    transport,
    tokenProvider("t"),
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid");
    assert.ok(result.error.detail.includes("byte bound"));
  }
});

Deno.test("release http: invalid body read failure is sanitized", async () => {
  let reads = 0;
  const transport: DenoHttpTransportV1 = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0) {
              controller.enqueue(new TextEncoder().encode("{}"));
            } else controller.error(new Error("stream secret text"));
          },
          cancel() {},
        }),
        { status: 200 },
      ),
    );
  const result = await denoRestCall(
    {
      baseUrl: API_URL,
      path: "/v2/apps/x",
      method: "GET",
      responseByteCap: 1024,
    },
    transport,
    tokenProvider("t"),
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(!result.error.detail.includes("secret"));
  }
});
