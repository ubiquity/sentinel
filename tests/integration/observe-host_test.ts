import assert from "node:assert/strict";
import {
  loadObserveConfig,
  ObserveConfigurationError,
  parseObserveAuthHeaders,
  parseObserveReplayKey,
  runReadOnlyObservation,
} from "../../src/observe-main.ts";
import {
  FakeClock,
  FINGERPRINT_B,
  INCIDENT_A,
  INCIDENT_B,
  jsonResponse,
  makeCapture,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  sha256hex,
  syntheticBytes,
  T0,
} from "../adapters/gateway/helpers.ts";

function base64For(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

Deno.test("observe config is pinned to the ai.ubq.fi gateway", async () => {
  const config = await loadObserveConfig();
  assert.equal(config.repository.owner, "ubiquity");
  assert.equal(config.repository.name, "ai.ubq.fi");
  assert.equal(config.adapter.kind, "gateway");
  // The adapter is a discriminated variant: narrow before reading the
  // gateway-only base address.
  const adapter = config.adapter;
  if (adapter.kind !== "gateway") {
    throw new Error("observe config must name the gateway adapter");
  }
  assert.equal(adapter.baseUrl, "https://ai.ubq.fi");
});

Deno.test("observe replay key accepts exactly 32 bytes", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  assert.deepEqual(parseObserveReplayKey(base64For(bytes)), bytes);
  assert.deepEqual(parseObserveReplayKey("00".repeat(32)), bytes.map(() => 0));
  assert.throws(
    () => parseObserveReplayKey(base64For(bytes.slice(0, 31))),
    (error: unknown) =>
      error instanceof ObserveConfigurationError &&
      error.code === "observe_replay_key_invalid",
  );
});

Deno.test("observe auth parser keeps header values out of diagnostics", () => {
  assert.deepEqual(
    parseObserveAuthHeaders('{"authorization":"Bearer test"}'),
    { authorization: "Bearer test" },
  );
  assert.throws(
    () => parseObserveAuthHeaders("not-json"),
    (error: unknown) =>
      error instanceof ObserveConfigurationError &&
      error.code === "observe_auth_invalid",
  );
});

Deno.test("read-only observation retains no plaintext for an empty index", async () => {
  const config = await loadObserveConfig();
  const root = await Deno.makeTempDir({
    prefix: "sentinel-observe-test-",
    dir: Deno.cwd(),
  });
  const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  let requestUrl = "";
  try {
    const result = await runReadOnlyObservation({
      config,
      authHeaders: { authorization: "Bearer test" },
      keyBytes,
      storeRoot: root,
      transport: (input) => {
        requestUrl = String(input);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [],
              cursor: null,
              coverage: { status: "complete" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    if (!result.ok) {
      assert.fail("read-only observer returned a typed failure");
    }
    assert.equal(result.value.status, "read_only");
    assert.equal(result.value.target, "ai.ubq.fi");
    assert.equal(result.value.incidents, 0);
    assert.equal(result.value.retainedCiphertexts, 0);
    assert(requestUrl.includes("https://ai.ubq.fi/admin/sentinel/incidents"));
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      assert.fail(`unexpected retained entry: ${entry.name}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * Production regression: the scheduled observer stayed red on every run
 * because one incident whose replay export exceeded the contract
 * artifact-count bound aborted the entire pass. That incident is now counted
 * and the pass continues, so every other incident's evidence is still read.
 */
Deno.test("observe blocks one unrepresentable incident without losing the pass", async () => {
  const config = await loadObserveConfig();
  const root = await Deno.makeTempDir({
    prefix: "sentinel-observe-bound-test-",
    dir: Deno.cwd(),
  });
  const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const now = T0 + 1_000;
  // One more capture than GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE (16): the adapter
  // refuses to represent this incident's evidence record.
  const captures = Array.from(
    { length: 17 },
    (_, index) =>
      makeCapture(syntheticBytes(64, index + 1), {
        capture_id: `cap-${index}`,
        captured_at_ms: T0,
      }),
  );
  // A digest that matches none of them, so the walk cannot resolve the
  // reference before it reaches the bound.
  const absentDigest = await sha256hex(syntheticBytes(64, 99));
  const overBoundRow = makeIndexRow({
    incident_id: INCIDENT_A,
    evidence_ref: {
      ref: "artifact://sentinel/absent/cap-none",
      digest: absentDigest,
    },
    evidence_expires_at_ms: now + 48 * 60 * 60 * 1_000,
  });
  const cleanRow = makeIndexRow({
    incident_id: INCIDENT_B,
    fingerprint: FINGERPRINT_B,
    evidence_ref: null,
    evidence_expires_at_ms: null,
  });
  const replayRequests: string[] = [];
  try {
    const result = await runReadOnlyObservation({
      config,
      authHeaders: { authorization: "Bearer test" },
      keyBytes,
      storeRoot: root,
      clock: new FakeClock(now),
      transport: (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/admin/sentinel/incidents") {
          const filter = url.searchParams.get("incident_id");
          const rows = filter === null
            ? [overBoundRow, cleanRow]
            : [filter === INCIDENT_A ? overBoundRow : cleanRow];
          return Promise.resolve(jsonResponse(makeIndexPage(rows)));
        }
        if (url.pathname === "/admin/sentinel/replay-captures") {
          const cursor = url.searchParams.get("cursor");
          const index = cursor === null ? 0 : Number(cursor);
          replayRequests.push(String(index));
          const next = index + 1 < captures.length ? String(index + 1) : null;
          return Promise.resolve(
            jsonResponse(makeReplayPage(captures[index]!, next)),
          );
        }
        return Promise.resolve(jsonResponse({ error: "unexpected" }, 404));
      },
    });
    if (!result.ok) {
      assert.fail(
        `one unrepresentable incident must not abort the pass: ${
          JSON.stringify(result)
        }`,
      );
    }
    assert.equal(result.value.incidents, 2);
    // The bounded incident is named, not silently dropped...
    assert.equal(result.value.blockedIncidents, 1);
    assert.equal(
      result.value.blockedDetail,
      "replay export exceeds the contract artifact-count bound",
    );
    // ...and the incident after it was still read.
    assert.equal(result.value.evidenceRecords, 1);
    // The walk stopped AT the bound instead of exhausting the export.
    assert.equal(replayRequests.length, 17);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
