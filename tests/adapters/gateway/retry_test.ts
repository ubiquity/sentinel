/**
 * Bounded transient retry for GatewayIncidentAdapter read-only requests.
 *
 * Exercised through the real `listUnresolvedIncidents` consumer with a
 * scripted transport (no helper-only assertions): a transient HTTP 502 or a
 * rejected transport is retried within a shared budget; 404/401/timeout
 * faults are never retried; the default (no retry option) preserves the
 * exact fail-closed single-attempt behavior; the budget is shared across the
 * adapter instance so a full producer outage still fails fast.
 */

import assert from "node:assert/strict";

import { GatewayIncidentAdapter } from "../../../src/adapters/gateway/incident-adapter.ts";
import type { GatewayAuthProviderV1 } from "../../../src/adapters/gateway/http.ts";
import { LocalArtifactStore } from "../../../src/adapters/gateway/store.ts";
import { portOk } from "../../../src/contracts/ports.ts";

import {
  FakeClock,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  recordingTransport,
  T0,
  validConfig,
} from "./helpers.ts";

const LIMITS = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

function authProvider(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve(portOk({ Authorization: "Bearer <redacted>" })),
  };
}

async function makeRetryAdapter(
  script: Array<Response | Error>,
  retry?: { budget: number; baseDelayMs: number },
): Promise<{
  adapter: GatewayIncidentAdapter;
  transport: ReturnType<typeof recordingTransport>;
  root: string;
}> {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-m02-retry-",
  });
  const store = new LocalArtifactStore({ root, limits: LIMITS });
  const opened = await store.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);
  let calls = 0;
  const transport = recordingTransport(() => {
    const next = script[Math.min(calls, script.length - 1)]!;
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const adapter = new GatewayIncidentAdapter({
    config: validConfig(),
    transport,
    auth: authProvider(),
    clock: new FakeClock(T0),
    store,
    retry,
  });
  return { adapter, transport, root };
}

async function removeRoot(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true }).catch(() => {});
}

const successPage = () =>
  jsonResponse(makeIndexPage([makeIndexRow()], null), 200);

Deno.test("transient 502 is retried once and then succeeds", async () => {
  const { adapter, transport, root } = await makeRetryAdapter(
    [jsonResponse({ error: "bad gateway" }, 502), successPage()],
    { budget: 3, baseDelayMs: 0 },
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 10);
    assert.ok(result.ok, `expected success: ${JSON.stringify(result)}`);
    assert.equal(result.value.items.length, 1);
    assert.equal(transport.requests.length, 2);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("rejected transport is retried as transient", async () => {
  const { adapter, transport, root } = await makeRetryAdapter(
    [new Error("connection refused"), successPage()],
    { budget: 3, baseDelayMs: 0 },
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 10);
    assert.ok(result.ok, `expected success: ${JSON.stringify(result)}`);
    assert.equal(transport.requests.length, 2);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("persistent 502 stops when the budget is exhausted", async () => {
  const { adapter, transport, root } = await makeRetryAdapter(
    [jsonResponse({ error: "bad gateway" }, 502)],
    { budget: 2, baseDelayMs: 0 },
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 10);
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "unavailable");
    assert.match(result.error.detail, /HTTP 502/);
    // 1 initial attempt + 2 budgeted retries.
    assert.equal(transport.requests.length, 3);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("404 producer fault is never retried", async () => {
  const { adapter, transport, root } = await makeRetryAdapter(
    [jsonResponse({ error: "gone" }, 404)],
    { budget: 3, baseDelayMs: 0 },
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 10);
    assert.ok(!result.ok);
    assert.equal(transport.requests.length, 1);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("401 auth failure is never retried", async () => {
  const { adapter, transport, root } = await makeRetryAdapter(
    [jsonResponse({ error: "denied" }, 401)],
    { budget: 3, baseDelayMs: 0 },
  );
  try {
    const result = await adapter.listUnresolvedIncidents(null, 10);
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "auth_failed");
    assert.equal(transport.requests.length, 1);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("no retry option preserves single-attempt behavior on 502", async () => {
  const { adapter, transport, root } = await makeRetryAdapter([
    jsonResponse({ error: "bad gateway" }, 502),
    successPage(),
  ]);
  try {
    const result = await adapter.listUnresolvedIncidents(null, 10);
    assert.ok(!result.ok);
    assert.match(result.error.detail, /HTTP 502/);
    assert.equal(transport.requests.length, 1);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("constructor rejects an out-of-range retry policy", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-m02-retry-",
  });
  const store = new LocalArtifactStore({ root, limits: LIMITS });
  const opened = await store.open();
  assert.ok(opened.ok);
  try {
    assert.throws(
      () =>
        new GatewayIncidentAdapter({
          config: validConfig(),
          transport: recordingTransport(() => successPage()),
          auth: authProvider(),
          clock: new FakeClock(T0),
          store,
          retry: { budget: 11, baseDelayMs: 0 },
        }),
      /retry budget/,
    );
    assert.throws(
      () =>
        new GatewayIncidentAdapter({
          config: validConfig(),
          transport: recordingTransport(() => successPage()),
          auth: authProvider(),
          clock: new FakeClock(T0),
          store,
          retry: { budget: 3, baseDelayMs: -1 },
        }),
      /retry base delay/,
    );
  } finally {
    await removeRoot(root);
  }
});
