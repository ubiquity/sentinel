import assert from "node:assert/strict";
import {
  loadObserveConfig,
  ObserveConfigurationError,
  parseObserveAuthHeaders,
  parseObserveReplayKey,
  runReadOnlyObservation,
} from "../../src/observe-main.ts";

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
  assert.equal(config.adapter.baseUrl, "https://ai.ubq.fi");
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
