/**
 * Trusted model-route resolver (gateway PRIMARY, DeepSeek-direct FALLBACK).
 *
 * The hosted UOS gateway (`https://ai.ubq.fi/v1`, `gpt-5.6-luna`, `max`
 * reasoning) stays the primary route. Exactly one explicit, deterministic
 * selection decides which endpoint and model id a run requests, and the
 * selected model id is the id the runtime actually submits and records — a
 * route is never swapped per request and a receipt never keeps one model id
 * while another was requested.
 *
 * Selection precedence (first matching branch wins; every branch explicit):
 *   1. Owner override: a non-empty, bounded `http`/`https`
 *      `SENTINEL_MODEL_BASE_URL` selects that endpoint with
 *      `SENTINEL_MODEL_ID` (default `deepseek-flash`) and provider
 *      `deepseek`; it requires a non-empty `SENTINEL_DEEPSEEK_API_KEY`.
 *   2. Fallback: `SENTINEL_MODEL_FALLBACK === "deepseek"` together with a
 *      non-empty `SENTINEL_DEEPSEEK_API_KEY` selects the DeepSeek-direct
 *      endpoint (`https://api.deepseek.com/v1`) and `deepseek-flash`.
 *   3. Gateway: the existing primary route (`uos`, `gpt-5.6-luna`, no key
 *      environment; the caller keeps its existing `UOS_AI_TOKEN` input).
 *
 * An unknown, malformed or incomplete value never fabricates a route: every
 * invalid case resolves to the gateway route, and only an EMPTY value counts
 * as unset. The resolver is pure and dependency-free, reads no credential
 * value and returns only the NAME of the environment variable that holds the
 * selected route's key — never the key.
 */

/** Exact trusted route one run requests and records. */
export interface ModelRouteV1 {
  readonly provider: "uos" | "deepseek";
  readonly baseUrl: string;
  readonly model: string;
  readonly reasoning: "max";
  readonly apiKeyEnv: string | null;
}

/** Static fail-closed error for a malformed resolver input (never a route). */
export const MODEL_ROUTE_INVALID =
  "sentinel model route rejected: environment input is not a mapping";

/** The existing primary gateway route. */
const GATEWAY_PROVIDER = "uos";
const GATEWAY_BASE_URL = "https://ai.ubq.fi/v1";
const GATEWAY_MODEL_ID = "gpt-5.6-luna";
/** The DeepSeek-direct fallback route. */
const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL_ID = "deepseek-flash";
const DEEPSEEK_API_KEY_ENV = "SENTINEL_DEEPSEEK_API_KEY";
/** Explicit owner-override inputs. */
const MODEL_BASE_URL_ENV = "SENTINEL_MODEL_BASE_URL";
const MODEL_ID_ENV = "SENTINEL_MODEL_ID";
const MODEL_FALLBACK_ENV = "SENTINEL_MODEL_FALLBACK";
/** The only `SENTINEL_MODEL_FALLBACK` value that selects the fallback route. */
const FALLBACK_SELECTOR = "deepseek";
/** The frozen reasoning effort of every route. */
const REASONING = "max";
/** Private finite bounds (no new configuration surface). */
const MAX_BASE_URL_CHARS = 2_048;
const MAX_MODEL_ID_CHARS = 256;

/** A DECLARED environment value: a non-empty string; null when unset or empty. */
function declared(
  env: Record<string, string | undefined>,
  name: string,
): string | null {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/**
 * A key is usable only when it carries non-whitespace content: a declared but
 * blank key is never a usable route key.
 */
function isUsableKey(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/**
 * A bounded absolute `http`/`https` endpoint: within the private bound, no
 * leading/trailing whitespace, no control characters or inner whitespace, a
 * parseable URL and a nonempty host. Anything else is invalid.
 */
function isBoundedBaseUrl(value: string): boolean {
  if (value.length > MAX_BASE_URL_CHARS || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * A bounded model id: a nonempty, exactly-trimmed string within the private
 * bound with no control characters. The route resolver never rewrites it.
 */
function isBoundedModelId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MODEL_ID_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** The frozen primary gateway route. */
function gatewayRoute(): ModelRouteV1 {
  return {
    provider: GATEWAY_PROVIDER,
    baseUrl: GATEWAY_BASE_URL,
    model: GATEWAY_MODEL_ID,
    reasoning: REASONING,
    apiKeyEnv: null,
  };
}

/** A DeepSeek-direct route carrying only the key's environment variable name. */
function deepseekRoute(baseUrl: string, model: string): ModelRouteV1 {
  return {
    provider: DEEPSEEK_PROVIDER,
    baseUrl,
    model,
    reasoning: REASONING,
    apiKeyEnv: DEEPSEEK_API_KEY_ENV,
  };
}

/**
 * Resolve exactly one model route from the trusted environment mapping.
 *
 * Pure and total: every input yields a route, and no invalid/unknown value can
 * fabricate a non-gateway route. A malformed mapping (not an object) is the
 * one fail-closed refusal.
 */
export function resolveModelRoute(
  env: Record<string, string | undefined>,
): ModelRouteV1 {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error(MODEL_ROUTE_INVALID);
  }
  // A declared key must carry non-whitespace content to be usable; a declared
  // but blank key selects nothing.
  const deepseekKey = declared(env, DEEPSEEK_API_KEY_ENV);
  const usableKey = isUsableKey(deepseekKey);
  const overrideBaseUrl = declared(env, MODEL_BASE_URL_ENV);
  if (overrideBaseUrl !== null) {
    // An explicitly attempted override never degrades into a different
    // fabricated route: an invalid endpoint, an invalid model id or a missing
    // key keeps the gateway primary. Only an EMPTY value counts as unset.
    if (!isBoundedBaseUrl(overrideBaseUrl) || !usableKey) {
      return gatewayRoute();
    }
    const overrideModelId = declared(env, MODEL_ID_ENV);
    if (overrideModelId !== null && !isBoundedModelId(overrideModelId)) {
      return gatewayRoute();
    }
    return deepseekRoute(overrideBaseUrl, overrideModelId ?? DEEPSEEK_MODEL_ID);
  }
  if (
    declared(env, MODEL_FALLBACK_ENV) === FALLBACK_SELECTOR && usableKey
  ) {
    return deepseekRoute(DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_ID);
  }
  return gatewayRoute();
}
