/**
 * Injected transport and credential boundary for the gateway adapter.
 *
 * The transport is a native-Fetch-compatible function (the production host
 * injects `fetch`); credentials are supplied by a constructor-injected auth
 * provider and never touch contract records or public state. Response bodies
 * are read with an explicit byte cap; a body exceeding the cap is a typed
 * `invalid` fault, never a silent truncation. Error `detail` strings are
 * static and never echo response contents, credential literals or thrown
 * messages (which may be arbitrary secrets).
 *
 * Transport guarantees:
 *
 * - Every failure of the auth provider — a typed `!ok` result, a thrown
 *   rejection, or malformed/invalid header values — is a typed `auth_failed`
 *   fault with a static detail. A credential source fault never escapes as a
 *   raw rejection and never leaks its own error text, and no fetch is ever
 *   started without validated credential headers.
 * - One finite whole-operation deadline (default `GATEWAY_DEFAULT_TIMEOUT_MS`,
 *   overridable per call via `requestTimeoutMs` for deterministic tests) is
 *   started before authentication and stays active through fetch headers and
 *   the streaming body until EOF. Once expired, a later fetch is never
 *   started, the in-flight fetch is aborted, and the fault is a typed
 *   `unavailable`. A transport or body read that ignores the abort signal
 *   still cannot outlive the bound: each settlement is raced against the
 *   deadline, and a response delivered after expiry is cancelled — never
 *   delivered — while its late rejection is swallowed.
 * - Redirects are refused (`redirect: "error"`), so an arbitrary 3xx can
 *   never carry the authorization header to another origin; a refused
 *   redirect is a typed `unavailable` fault.
 * - On status rejection, deadline or body-read failure the response body is
 *   cancelled and its reader released, and cancellation is never awaited
 *   (a stuck peer cannot hang the typed result). Timers are cleared on every
 *   exit path.
 */

import {
  portError,
  type PortErrorKindV1,
  portOk,
  type PortResultV1,
} from "../../contracts/ports.ts";

/** Default whole-operation deadline for one authenticated GET, in ms. */
export const GATEWAY_DEFAULT_TIMEOUT_MS = 30_000;
/** setTimeout ceiling: values above it overflow and fire immediately. */
const GATEWAY_MAX_TIMEOUT_MS = 2_147_483_647;
/** Static fault detail; never interpolated with transport or auth values. */
const GATEWAY_TIMEOUT_DETAIL = "gateway request exceeded the time bound";

/** Native-Fetch-compatible transport; production injects `fetch`. */
export type GatewayTransportV1 = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Constructor-injected credential source. The provider returns the exact
 * header name/value pairs to attach to every gateway request; a typed failure
 * or a thrown rejection means no credential is available and is mapped to
 * `auth_failed`. No credential literal is ever part of a contract record.
 */
export interface GatewayAuthProviderV1 {
  headers(): Promise<PortResultV1<Record<string, string>>>;
}

export interface GatewayHttpRequestV1 {
  baseUrl: string;
  path: string;
  query: URLSearchParams;
  /** Hard cap on the buffered response body, in bytes. */
  responseByteCap: number;
  /**
   * Optional whole-operation deadline override in ms (default
   * `GATEWAY_DEFAULT_TIMEOUT_MS`). Helper-level only: no env/CLI/config
   * surface; deterministic tests pass tiny values. Must be a safe integer in
   * `1..GATEWAY_MAX_TIMEOUT_MS`.
   */
  requestTimeoutMs?: number;
}

export interface GatewayHttpResponseV1 {
  status: number;
  body: unknown;
}

/**
 * One authenticated GET with a bounded response body and a fail-closed status
 * mapping. A missing/unreachable endpoint (404) is `unavailable` — never an
 * empty successful page.
 */
export async function gatewayRead(
  request: GatewayHttpRequestV1,
  transport: GatewayTransportV1,
  auth: GatewayAuthProviderV1,
): Promise<PortResultV1<GatewayHttpResponseV1>> {
  const timeoutMs = resolveTimeoutMs(request.requestTimeoutMs);
  if (timeoutMs === null) {
    return portError(
      "invalid",
      "gateway request timeout is outside the accepted bounds",
    );
  }
  const deadline = startDeadline(timeoutMs);
  try {
    // The deadline starts before authentication; a hanging credential source
    // cannot outlive the operation bound, and expiry never starts a fetch.
    // Promise.resolve() also converts a synchronous provider throw into a
    // rejection handled below, so no credential-source fault ever escapes.
    const authOutcome = await Promise.race([
      Promise.resolve().then(() => auth.headers()).then(
        (result): AuthRaceV1 => ({ kind: "settled", result }),
        (): AuthRaceV1 => ({ kind: "rejected" }),
      ),
      deadline.happened.then((): AuthRaceV1 => ({ kind: "expired" })),
    ]);
    if (deadline.isExpired()) return deadlineFault();
    if (authOutcome.kind === "expired") return deadlineFault();
    if (
      authOutcome.kind === "rejected" ||
      !authOutcome.result.ok
    ) {
      return portError("auth_failed", "gateway credentials are unavailable");
    }
    const headers = buildAuthHeaders(authOutcome.result.value);
    if (!headers.ok) return headers;
    if (deadline.isExpired()) return deadlineFault();

    const url = joinUrl(request.baseUrl, request.path, request.query);
    // The deadline races the transport settlement: a transport that ignores
    // the abort signal must not hold the operation past its bound. The raw
    // promise still receives settlement handlers, so a late response is
    // cancelled and a late rejection swallowed — never delivered and never an
    // unhandled rejection. Promise.resolve() also turns a synchronous
    // transport throw into the rejection handled below.
    const transportOutcome = await Promise.race([
      Promise.resolve().then(() =>
        transport(url, {
          method: "GET",
          headers: headers.value,
          // Never follow a redirect: an arbitrary 3xx must never carry the
          // authorization header to another origin. Refusal surfaces as a
          // transport rejection, mapped below to typed `unavailable`.
          redirect: "error",
          signal: deadline.signal,
        })
      ).then(
        (response: Response): TransportRaceV1 => {
          if (deadline.isExpired()) {
            // Settlement after the bound: the fault is already decided, so
            // this late response is never delivered and its body released.
            releaseBody(response);
          }
          return { kind: "settled", response };
        },
        (): TransportRaceV1 => ({ kind: "rejected" }),
      ),
      deadline.happened.then((): TransportRaceV1 => ({ kind: "expired" })),
    ]);
    if (deadline.isExpired() || transportOutcome.kind === "expired") {
      return deadlineFault();
    }
    if (transportOutcome.kind === "rejected") {
      return portError("unavailable", "gateway transport is unavailable");
    }
    const response = transportOutcome.response;
    const status = response.status;
    const statusFault = mapStatus(status);
    if (statusFault !== null) {
      releaseBody(response);
      return portError(statusFault.kind, statusFault.detail);
    }
    const bodyResult = await readBoundedBody(
      response,
      request.responseByteCap,
      deadline,
    );
    if (!bodyResult.ok) return bodyResult;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyResult.value));
    } catch {
      return portError("invalid", "gateway response is not valid JSON");
    }
    return portOk({ status, body: parsed });
  } finally {
    deadline.close();
  }
}

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

interface GatewayDeadlineV1 {
  /** Aborts the in-flight fetch and its streamed body when the timer fires. */
  readonly signal: AbortSignal;
  /** Resolves once the deadline fires; never rejects. */
  readonly happened: Promise<void>;
  isExpired(): boolean;
  /** Clears the timer; no-op after the timer already fired. */
  close(): void;
}

function startDeadline(ms: number): GatewayDeadlineV1 {
  const controller = new AbortController();
  let expired = false;
  let resolveHappened: () => void = () => {};
  const happened = new Promise<void>((resolve) => {
    resolveHappened = resolve;
  });
  const timer = setTimeout(() => {
    expired = true;
    try {
      controller.abort();
    } catch {
      // The caller owns teardown; abort is best-effort.
    }
    resolveHappened();
  }, ms);
  return {
    signal: controller.signal,
    happened,
    isExpired: () => expired,
    close: () => clearTimeout(timer),
  };
}

function deadlineFault(): PortResultV1<never> {
  return portError("unavailable", GATEWAY_TIMEOUT_DETAIL);
}

function resolveTimeoutMs(requested: number | undefined): number | null {
  const ms = requested ?? GATEWAY_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(ms) || ms < 1 || ms > GATEWAY_MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Credential headers
// ---------------------------------------------------------------------------

type AuthRaceV1 =
  | { kind: "settled"; result: PortResultV1<Record<string, string>> }
  | { kind: "rejected" }
  | { kind: "expired" };

/** Settlement race between one transport call and the operation deadline. */
type TransportRaceV1 =
  | { kind: "settled"; response: Response }
  | { kind: "rejected" }
  | { kind: "expired" };

/**
 * Validates the provider-returned header record and attaches the fixed
 * accept header. A non-record value, a non-string header value or a header
 * name the Headers constructor rejects is a typed `auth_failed` fault with a
 * static detail — the offending name/value is never echoed.
 */
function buildAuthHeaders(
  value: Record<string, string>,
): PortResultV1<Headers> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    return malformedHeaders();
  }
  const entries = value as Record<string, unknown>;
  for (const [name, headerValue] of Object.entries(entries)) {
    if (name.length === 0 || typeof headerValue !== "string") {
      return malformedHeaders();
    }
  }
  try {
    return portOk(
      new Headers({
        ...(entries as Record<string, string>),
        accept: "application/json",
      }),
    );
  } catch {
    return malformedHeaders();
  }
}

function malformedHeaders(): PortResultV1<never> {
  return portError(
    "auth_failed",
    "gateway auth provider returned malformed headers",
  );
}

// ---------------------------------------------------------------------------
// Status mapping and bounded body
// ---------------------------------------------------------------------------

function mapStatus(
  status: number,
): { kind: PortErrorKindV1; detail: string } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 400) {
    return {
      kind: "invalid",
      detail: "gateway rejected the request as invalid",
    };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth_failed", detail: "gateway authentication failed" };
  }
  if (status === 404) {
    // The producer endpoint is missing/unreachable — never an empty page.
    return {
      kind: "unavailable",
      detail: "gateway producer endpoint is unavailable",
    };
  }
  if (status === 429) {
    return { kind: "rate_limited", detail: "gateway rate limit reached" };
  }
  return { kind: "unavailable", detail: "gateway producer is unavailable" };
}

/**
 * Fire-and-forget body teardown. Cancellation is never awaited: a peer that
 * refuses to end a stream must not turn a typed result into a hang.
 */
function releaseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Best-effort teardown; the typed result is already determined.
  }
}

async function readBoundedBody(
  response: Response,
  cap: number,
  deadline: GatewayDeadlineV1,
): Promise<PortResultV1<Uint8Array<ArrayBuffer>>> {
  if (response.body === null) return portOk(new Uint8Array());
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      if (deadline.isExpired()) return deadlineFault();
      // The deadline races each pending read: a body that ignores the abort
      // signal cannot hold the operation past its bound. The read promise
      // still receives a rejection handler, so a late failure is swallowed
      // instead of surfacing as an unhandled rejection after the fault.
      const readOutcome = await Promise.race([
        reader.read().then(
          (result) => ({ kind: "chunk" as const, result }),
          (): { kind: "failed" } => ({ kind: "failed" as const }),
        ),
        deadline.happened
          .then((): { kind: "expired" } => ({ kind: "expired" as const })),
      ]);
      if (deadline.isExpired() || readOutcome.kind === "expired") {
        return deadlineFault();
      }
      if (readOutcome.kind === "failed") {
        return portError(
          "unavailable",
          "gateway response body could not be read",
        );
      }
      const { done, value } = readOutcome.result;
      if (done) break;
      // Enforce the cap while streaming: an oversized chunk is rejected
      // immediately, never buffered and inspected after EOF.
      if (value.byteLength > cap - total) {
        return portError("invalid", "gateway response exceeds the byte bound");
      }
      total += value.byteLength;
      parts.push(new Uint8Array(value));
    }
    if (deadline.isExpired()) return deadlineFault();
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return portOk(output);
  } catch {
    if (deadline.isExpired()) return deadlineFault();
    return portError(
      "unavailable",
      "gateway response body could not be read",
    );
  } finally {
    // Cancel without awaiting, then release the lock so the stream can be
    // reclaimed; a pending cancellation must never block teardown.
    try {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } catch {
      // A pending read can make releaseLock throw; the aborted fetch or the
      // abandoned reader owns the remaining teardown.
    }
  }
}

function joinUrl(
  baseUrl: string,
  path: string,
  query: URLSearchParams,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const search = query.toString();
  return `${base}${path}${search.length > 0 ? `?${search}` : ""}`;
}
