/**
 * Trusted model-route resolver boundaries.
 *
 * The UOS gateway stays PRIMARY: only an explicit owner override or the
 * explicit DeepSeek fallback selector (with its key present) may select the
 * DeepSeek-direct route, and every unknown/invalid value resolves back to the
 * gateway route. The resolver reads no credential value and returns only the
 * NAME of the key environment — never the key itself.
 *
 * The selected model id is also the ONLY id the runtime may request and
 * record: the receipt verifier and the implementation port both reject any
 * request/receipt that keeps another id (the gateway literal included), and
 * neither ever opens a session for an off-route model.
 */
import assert from "node:assert/strict";

import { asGitSha, asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import {
  MODEL_ROUTE_INVALID,
  resolveModelRoute,
} from "../../src/host/model-route.ts";
import {
  CodexImplementationPort,
  createRequestRuntimeReceiptVerifier,
} from "../../src/repair/model-port.ts";
import type { ActualSessionEvidenceV1 } from "../../src/repair/model-port.ts";

const GATEWAY = {
  provider: "uos",
  baseUrl: "https://ai.ubq.fi/v1",
  model: "gpt-reserve",
  reasoning: "max",
  apiKeyEnv: null,
} as const;

const DEEPSEEK_KEY = "SENTINEL_DEEPSEEK_API_KEY";
const SECRET = "sk-test-secret-value-never-returned";

Deno.test("model route: the gateway route is the default", () => {
  assert.deepEqual(resolveModelRoute({}), GATEWAY);
  // An unrelated environment changes nothing.
  assert.deepEqual(
    resolveModelRoute({
      PATH: "/usr/bin",
      UOS_AI_TOKEN: "gateway-token",
      SENTINEL_MODEL_FALLBACK: "",
      SENTINEL_DEEPSEEK_API_KEY: "",
    }),
    GATEWAY,
  );
  // The frozen reasoning effort is `max` on every route.
  assert.equal(resolveModelRoute({}).reasoning, "max");
});

Deno.test("model route: the explicit owner override selects the endpoint", () => {
  const route = resolveModelRoute({
    SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
    SENTINEL_DEEPSEEK_API_KEY: SECRET,
  });
  assert.deepEqual(route, {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    reasoning: "max",
    apiKeyEnv: DEEPSEEK_KEY,
  });
  // A declared model id is used verbatim; no other id is ever requested.
  const declared = resolveModelRoute({
    SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
    SENTINEL_MODEL_ID: "deepseek-v4-pro",
    SENTINEL_DEEPSEEK_API_KEY: SECRET,
  });
  assert.equal(declared.model, "deepseek-v4-pro");
  assert.equal(declared.baseUrl, "https://api.deepseek.com/v1");
  // A plain http override is still a bounded http endpoint.
  assert.equal(
    resolveModelRoute({
      SENTINEL_MODEL_BASE_URL: "http://127.0.0.1:8123/v1",
      SENTINEL_DEEPSEEK_API_KEY: SECRET,
    }).baseUrl,
    "http://127.0.0.1:8123/v1",
  );
  // The override wins over the fallback selector.
  assert.equal(
    resolveModelRoute({
      SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
      SENTINEL_MODEL_ID: "deepseek-v4-pro",
      SENTINEL_MODEL_FALLBACK: "deepseek",
      SENTINEL_DEEPSEEK_API_KEY: SECRET,
    }).model,
    "deepseek-v4-pro",
  );
});

Deno.test("model route: the explicit fallback selects DeepSeek direct", () => {
  const route = resolveModelRoute({
    SENTINEL_MODEL_FALLBACK: "deepseek",
    SENTINEL_DEEPSEEK_API_KEY: SECRET,
    UOS_AI_TOKEN: "gateway-token",
  });
  assert.deepEqual(route, {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    reasoning: "max",
    apiKeyEnv: DEEPSEEK_KEY,
  });
  // The fallback never keeps the gateway model id.
  assert.notEqual(route.model, GATEWAY.model);
  // A completely EMPTY override value counts as unset, so the declared
  // fallback still applies.
  assert.deepEqual(
    resolveModelRoute({
      SENTINEL_MODEL_BASE_URL: "",
      SENTINEL_MODEL_FALLBACK: "deepseek",
      SENTINEL_DEEPSEEK_API_KEY: SECRET,
    }),
    route,
  );
});

Deno.test("model route: an invalid value falls back to the gateway route", () => {
  // Unknown fallback selector.
  assert.deepEqual(
    resolveModelRoute({
      SENTINEL_MODEL_FALLBACK: "openai",
      SENTINEL_DEEPSEEK_API_KEY: SECRET,
    }),
    GATEWAY,
  );
  // Declared fallback without a usable key (absent, empty or blank).
  for (const key of ["", "   "]) {
    assert.deepEqual(
      resolveModelRoute({
        SENTINEL_MODEL_FALLBACK: "deepseek",
        SENTINEL_DEEPSEEK_API_KEY: key,
      }),
      GATEWAY,
      JSON.stringify(key),
    );
  }
  assert.deepEqual(
    resolveModelRoute({ SENTINEL_MODEL_FALLBACK: "deepseek" }),
    GATEWAY,
  );
  // Unsupported protocol / malformed endpoint. A declared but blank or padded
  // value is invalid (only a completely empty value counts as unset).
  for (
    const baseUrl of [
      "ftp://api.deepseek.com/v1",
      "api.deepseek.com/v1",
      "https://",
      " https://api.deepseek.com/v1",
      " ",
    ]
  ) {
    assert.deepEqual(
      resolveModelRoute({
        SENTINEL_MODEL_BASE_URL: baseUrl,
        SENTINEL_DEEPSEEK_API_KEY: SECRET,
      }),
      GATEWAY,
      baseUrl,
    );
  }
  // Override endpoint without its key, or with a declared but blank key.
  assert.deepEqual(
    resolveModelRoute({
      SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
    }),
    GATEWAY,
  );
  assert.deepEqual(
    resolveModelRoute({
      SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
      SENTINEL_DEEPSEEK_API_KEY: " ",
    }),
    GATEWAY,
  );
  // Malformed declared model ids never fabricate a route.
  for (
    const modelId of [
      " deepseek-flash",
      "deepseek-flash ",
      `deep_${"x".repeat(300)}`,
    ]
  ) {
    assert.deepEqual(
      resolveModelRoute({
        SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
        SENTINEL_MODEL_ID: modelId,
        SENTINEL_DEEPSEEK_API_KEY: SECRET,
      }),
      GATEWAY,
      modelId,
    );
  }
  // An over-long endpoint is out of bound.
  assert.deepEqual(
    resolveModelRoute({
      SENTINEL_MODEL_BASE_URL: `https://api.deepseek.com/${"x".repeat(2_100)}`,
      SENTINEL_DEEPSEEK_API_KEY: SECRET,
    }),
    GATEWAY,
  );
});

Deno.test("model route: only the key environment name is ever returned", () => {
  for (
    const route of [
      resolveModelRoute({}),
      resolveModelRoute({
        SENTINEL_MODEL_FALLBACK: "deepseek",
        SENTINEL_DEEPSEEK_API_KEY: SECRET,
      }),
      resolveModelRoute({
        SENTINEL_MODEL_BASE_URL: "https://api.deepseek.com/v1",
        SENTINEL_DEEPSEEK_API_KEY: SECRET,
      }),
    ]
  ) {
    assert.ok(!JSON.stringify(route).includes(SECRET));
    assert.ok(
      route.apiKeyEnv === null || route.apiKeyEnv === DEEPSEEK_KEY,
    );
  }
});

Deno.test("model route: a malformed environment mapping fails closed", () => {
  for (const value of [null, undefined, "SENTINEL_MODEL_FALLBACK=deepseek"]) {
    assert.throws(
      () =>
        resolveModelRoute(
          value as unknown as Record<string, string | undefined>,
        ),
      (error: unknown) =>
        error instanceof Error && error.message === MODEL_ROUTE_INVALID,
    );
  }
});

const ROUTE_MODEL = "deepseek-flash";
const ROUTE_PROVIDER = "deepseek";
const CHECKOUT = "/tmp/sentinel-model-route-checkout";

/** Correlated request/runtime evidence for the DeepSeek-direct route. */
function routeEvidence(
  overrides: Partial<ActualSessionEvidenceV1> = {},
): ActualSessionEvidenceV1 {
  return {
    invocationId: "invoke-route-1",
    requestedModel: ROUTE_MODEL,
    requestedProvider: ROUTE_PROVIDER,
    requestedEffort: "max",
    threadId: "thread-route-1",
    turnId: "turn-route-1",
    threadModel: ROUTE_MODEL,
    threadModelProvider: ROUTE_PROVIDER,
    threadEffort: "max",
    reroutes: [],
    terminal: { status: "completed", error: null, durationMs: 5 },
    terminalOrigin: "runtime",
    loopStopped: false,
    resultItems: [{ itemId: "ok-1", type: "fileChange" }],
    outputChars: 42,
    ...overrides,
  };
}

function routeRequest(model: string): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId("issue-route"),
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    base: asGitSha("a".repeat(40)),
    issue: null,
    evidence: [],
    model,
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
  };
}

Deno.test("model route: the receipt verifier certifies only the configured model", () => {
  const verify = createRequestRuntimeReceiptVerifier(
    ROUTE_PROVIDER,
    ROUTE_MODEL,
  );
  assert.deepEqual(verify(routeEvidence()), {
    provider: ROUTE_PROVIDER,
    observedModel: ROUTE_MODEL,
    observedReasoning: "max",
  });
  // The gateway literal is not this route's model: a receipt keeping it while
  // the fallback route was selected is never certified.
  assert.equal(
    verify(
      routeEvidence({
        requestedModel: "gpt-reserve",
        threadModel: "gpt-reserve",
      }),
    ),
    null,
  );
  // The acknowledged thread model must equal the requested model exactly.
  assert.equal(verify(routeEvidence({ threadModel: "gpt-reserve" })), null);
  // Callers that pass no model keep the frozen gateway model id, and the
  // fallback id is never accepted through that default.
  const gateway = createRequestRuntimeReceiptVerifier("uos");
  assert.equal(
    gateway(routeEvidence({
      requestedModel: "gpt-reserve",
      threadModel: "gpt-reserve",
      requestedProvider: "uos",
      threadModelProvider: "uos",
    }))?.observedModel,
    "gpt-reserve",
  );
  assert.equal(
    gateway(
      routeEvidence({ requestedProvider: "uos", threadModelProvider: "uos" }),
    ),
    null,
  );
});

Deno.test("model route: the port opens no session for an off-route model", async () => {
  let opened = 0;
  const port = new CodexImplementationPort({
    checkoutDir: CHECKOUT,
    modelProvider: ROUTE_PROVIDER,
    modelId: ROUTE_MODEL,
    openSession: () => {
      opened++;
      throw new Error("no session may open past the policy gate");
    },
  });
  assert.equal(port.modelId, ROUTE_MODEL);
  // The gateway literal is refused BEFORE any session opens: the port can
  // never request one model while its receipt claims another.
  const foreign = await port.runModel(routeRequest("gpt-reserve"));
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.error.kind, "unavailable");
  assert.equal(opened, 0, "an off-route request never opens a session");
  // The configured route model passes the same gate (the fake then stops at
  // the injected session factory, so exactly one open is attempted).
  await port.runModel(routeRequest(ROUTE_MODEL));
  assert.equal(
    opened,
    1,
    "the configured route model reaches the session boundary",
  );

  // Callers that pass no model id keep the frozen gateway model id and refuse
  // the fallback id just as strictly.
  let defaultOpened = 0;
  const defaultPort = new CodexImplementationPort({
    checkoutDir: CHECKOUT,
    modelProvider: "uos",
    openSession: () => {
      defaultOpened++;
      throw new Error("no session may open past the policy gate");
    },
  });
  assert.equal(defaultPort.modelId, "gpt-reserve");
  const fallback = await defaultPort.runModel(routeRequest(ROUTE_MODEL));
  assert.equal(fallback.ok, false);
  assert.equal(defaultOpened, 0, "the frozen default refuses the fallback id");
});
