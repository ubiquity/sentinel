/**
 * Wave C trusted-host provider adapters.
 *
 * The composition seams consume typed auth providers (`GitHubAuthProviderV1`,
 * `GatewayAuthProviderV1`, `DenoAuthProviderV1`) and a typed restricted-
 * execution isolation capability (`ReplayIsolationCapabilityV1`). A trusted
 * host keeps credential material inside explicit caller-supplied closures and
 * its isolation attestation as raw host data; these small adapters translate
 * that boundary without introducing a transport or abstraction layer:
 *
 * - a credential/header closure adapter awaits the raw value and maps a
 *   thrown/rejected closure or a malformed value (wrong type, empty, control
 *   characters, over-bound length) to the SAME typed fail-closed result
 *   kind/detail the existing consumers use (`auth_failed` / `invalid` with
 *   static detail). No credential, token, header name/value or thrown message
 *   is ever echoed, and a malformed value never reaches a `Headers`
 *   constructor or a transport;
 * - the isolation adapter validates the raw attestation BEFORE any capability
 *   exists and throws one static non-echoing `TypeError` unless the
 *   attestation is the exact `v1` shape with `restrictedExecution === true`
 *   (clearEnv is not a sandbox). It never manufactures an attestation.
 *
 * Every helper is side-effect free: no `Deno.env`, filesystem, network,
 * credential construction, worktree or external call.
 */

import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { MaxText } from "../contracts/validation.ts";
import type { GitHubAuthProviderV1 } from "../github/auth.ts";
import type { GatewayAuthProviderV1 } from "../adapters/gateway/http.ts";
import type { DenoAuthProviderV1 } from "../release/http.ts";
import type {
  ReplayIsolationAttestationV1,
  ReplayIsolationCapabilityV1,
} from "../replay/port.ts";

/** Static rejection text; no attestation field is ever echoed. */
const ERR_ISOLATION =
  "replay isolation host rejected: the attestation does not prove " +
  "restricted execution (clearEnv is not a sandbox)";
/** Static failure detail; no credential value is ever echoed. */
const ERR_CREDENTIALS_UNAVAILABLE = "provider credentials are unavailable";
/** Static malformed detail; no credential value is ever echoed. */
const ERR_MALFORMED = "provider credentials are malformed";

/** Frozen bounds from the shared validation contract. */
const MAX_HEADER_VALUE = MaxText.headerValue;
const MAX_HEADER_NAME = MaxText.headerName;
const MAX_TOKEN = MaxText.token;
/** A bounded credential record cannot carry an unbounded header set. */
const MAX_CREDENTIAL_HEADERS = 16;

/** Control characters (CR/LF included) never belong in a header line. */
const CONTROL_CHARACTER_RE = /[\p{Cc}]/u;
/** RFC 7230 field-name tokens: the only names a Headers record accepts. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// ---------------------------------------------------------------------------
// Credential/header closure adapters
// ---------------------------------------------------------------------------

async function settle<Value>(
  source: () => Value | Promise<Value>,
): Promise<PortResultV1<Value>> {
  try {
    // Promise.resolve().then keeps a synchronous throw inside the typed
    // settle path: no credential-source fault can escape as a raw rejection.
    return portOk(await Promise.resolve().then(source));
  } catch {
    return portError("auth_failed", ERR_CREDENTIALS_UNAVAILABLE);
  }
}

/**
 * One `GitHubAuthProviderV1` over a caller-supplied closure that returns the
 * EXACT `Authorization` header value (the same value
 * `GitHubInstallationTokenProvider.authorizationHeader()` returns). A thrown
 * or rejected closure is a typed `auth_failed`; a non-string, empty,
 * control-character-bearing or over-bound value is a typed `invalid`. No
 * value is ever echoed and no transport is ever reached by the adapter.
 */
export function createGitHubAuthProvider(
  source: () => string | Promise<string>,
): GitHubAuthProviderV1 {
  return {
    async authorizationHeader(): Promise<PortResultV1<string>> {
      const settled = await settle(source);
      if (!settled.ok) return settled;
      const header = settled.value;
      if (
        typeof header !== "string" || header.length === 0 ||
        header.length > MAX_HEADER_VALUE ||
        CONTROL_CHARACTER_RE.test(header)
      ) {
        return portError("invalid", ERR_MALFORMED);
      }
      return portOk(header);
    },
  };
}

/**
 * One `DenoAuthProviderV1` over a caller-supplied closure that returns the
 * bearer token (no `Bearer` prefix; the module adds it). A thrown or rejected
 * closure and every malformed value (non-string, control characters,
 * over-bound length) are typed `auth_failed` — the same fail-closed outcome
 * the Deno transport produces — and an empty token keeps the existing
 * empty-token detail. Header injection never reaches `Headers`.
 */
export function createDenoAuthProvider(
  source: () => string | Promise<string>,
): DenoAuthProviderV1 {
  return {
    async bearerToken(): Promise<PortResultV1<string>> {
      const settled = await settle(source);
      if (!settled.ok) return settled;
      const token = settled.value;
      if (typeof token !== "string" || token.length === 0) {
        return portError(
          "auth_failed",
          "deno auth provider returned an empty token",
        );
      }
      if (
        token.length > MAX_TOKEN ||
        CONTROL_CHARACTER_RE.test(token)
      ) {
        return portError("auth_failed", ERR_MALFORMED);
      }
      return portOk(token);
    },
  };
}

/**
 * One `GatewayAuthProviderV1` over a caller-supplied closure that returns the
 * header record attached to gateway requests. A thrown or rejected closure,
 * a non-record value, an invalid header name, a non-string/empty/control-
 * character-bearing header value, an over-bound value or over-bound record
 * are all typed `auth_failed` — never a raw rejection and never a value that
 * a `Headers` constructor or transport would reject later.
 */
export function createGatewayAuthProvider(
  source: () => Record<string, string> | Promise<Record<string, string>>,
): GatewayAuthProviderV1 {
  return {
    async headers(): Promise<PortResultV1<Record<string, string>>> {
      const settled = await settle(source);
      if (!settled.ok) return settled;
      const value = settled.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return malformedRecord();
      }
      const entries: [string, string][] = Object.entries(value);
      if (entries.length > MAX_CREDENTIAL_HEADERS) return malformedRecord();
      for (const [name, headerValue] of entries) {
        if (
          typeof name !== "string" || name.length === 0 ||
          name.length > MAX_HEADER_NAME || !HEADER_NAME_RE.test(name) ||
          CONTROL_CHARACTER_RE.test(name)
        ) {
          return malformedRecord();
        }
        if (
          typeof headerValue !== "string" || headerValue.length === 0 ||
          headerValue.length > MAX_HEADER_VALUE ||
          CONTROL_CHARACTER_RE.test(headerValue)
        ) {
          return malformedRecord();
        }
      }
      return portOk(Object.fromEntries(entries) as Record<string, string>);
    },
  };
}

function malformedRecord(): PortResultV1<never> {
  return portError(
    "auth_failed",
    "gateway auth provider returned malformed headers",
  );
}

// ---------------------------------------------------------------------------
// Restricted-execution isolation adapter
// ---------------------------------------------------------------------------

/**
 * Validate a caller-supplied restricted-execution attestation and return the
 * typed capability the replay port requires. The check mirrors the concrete
 * `ReplayPortImpl` requirement exactly: `version === "v1"`,
 * `restrictedExecution === true` (a false/omitted flag is never coerced) and
 * non-empty `host`/`boundary`/`attestationRef` strings. Any other input —
 * including an omitted or `null` attestation — throws one static
 * non-echoing `TypeError` before any capability exists, so the assembly can
 * never make a target-controlled command runnable on its own.
 */
export function createReplayIsolationHost(
  attestation: unknown,
): ReplayIsolationCapabilityV1 {
  if (typeof attestation !== "object" || attestation === null) {
    throw new TypeError(ERR_ISOLATION);
  }
  const record = attestation as Record<string, unknown>;
  if (record.version !== "v1" || record.restrictedExecution !== true) {
    throw new TypeError(ERR_ISOLATION);
  }
  if (
    typeof record.host !== "string" || record.host.length === 0 ||
    typeof record.boundary !== "string" || record.boundary.length === 0 ||
    typeof record.attestationRef !== "string" ||
    record.attestationRef.length === 0
  ) {
    throw new TypeError(ERR_ISOLATION);
  }
  return { attestation: attestation as ReplayIsolationAttestationV1 };
}
