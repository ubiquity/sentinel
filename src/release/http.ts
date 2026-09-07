/**
 * Authenticated Deno REST transport for the release module.
 *
 * Mirrors the module boundary discipline: the transport is a
 * native-Fetch-compatible function injected by the trusted host, credentials
 * come from a constructor-injected auth provider, and every response body is
 * buffered under explicit byte caps. Redirects are refused so a 3xx can never
 * carry the Authorization header to another origin. Error `detail` strings
 * are static; they never echo response contents, credential literals or
 * thrown messages.
 *
 * Every call runs under one finite whole-operation deadline that starts
 * before authentication and stays active through the streaming body. A late
 * settlement after expiry is cancelled, never delivered, and its rejection is
 * swallowed. Timers are cleared on every exit path.
 *
 * GET and POST share the same dead-line/byte-cap discipline; POST is used for
 * promotion (which requires HTTP 204 with an empty body) and never follows a
 * redirect either.
 */

import {
  portError,
  type PortErrorKindV1,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import { DENO_DEFAULT_TIMEOUT_MS } from "./config.ts";

/** Native-Fetch-compatible transport; production injects `fetch`. */
export type DenoHttpTransportV1 = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Constructor-injected credential source. A typed failure or a thrown
 * rejection means no credential is available and maps to `auth_failed`; no
 * credential literal ever reaches a contract record or fault detail.
 */
export interface DenoAuthProviderV1 {
  /** Authorization header value (bearer token) for Deno REST calls. */
  bearerToken(): Promise<PortResultV1<string>>;
}

/** One GET or POST against the Deno REST API with bounded response bytes. */
export interface DenoRestRequestV1 {
  baseUrl: string;
  path: string;
  query?: URLSearchParams;
  method: "GET" | "POST";
  /** Hard cap on the buffered response body, in bytes. */
  responseByteCap: number;
  /** Optional whole-operation deadline override in ms (helper-level only). */
  requestTimeoutMs?: number;
}

export interface DenoRestResponseV1 {
  status: number;
  body: Uint8Array;
}

const DENO_TIMEOUT_DETAIL = "deno request exceeded the time bound";
/** setTimeout ceiling: values above it overflow and fire immediately. */
const DENO_MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * One bounded authenticated Deno REST call. Status handling is left to the
 * caller (promotion expects 204; reads expect 200); this function only
 * enforces the transport discipline and returns the status plus the bounded
 * body.
 */
export async function denoRestCall(
  request: DenoRestRequestV1,
  transport: DenoHttpTransportV1,
  auth: DenoAuthProviderV1,
): Promise<PortResultV1<DenoRestResponseV1>> {
  const timeoutMs = resolveTimeoutMs(request.requestTimeoutMs);
  if (timeoutMs === null) {
    return portError(
      "invalid",
      "deno request timeout is outside the accepted bounds",
    );
  }
  const deadline = startDeadline(timeoutMs);
  try {
    const authSettled = await settleWithin(
      Promise.resolve().then(() => auth.bearerToken()),
      deadline,
    );
    if (deadline.isExpired() || authSettled.status === "expired") {
      return deadlineFault();
    }
    if (
      authSettled.status === "rejected" ||
      !authSettled.result.ok
    ) {
      return portError("auth_failed", "deno credentials are unavailable");
    }
    const token = authSettled.result.value;
    if (token.length === 0) {
      return portError(
        "auth_failed",
        "deno auth provider returned an empty token",
      );
    }

    const url = buildUrl(request.baseUrl, request.path, request.query);
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      accept: "application/json",
    });
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "error",
      signal: deadline.signal,
    };
    const transportSettled = await settleWithin(
      Promise.resolve().then(() => transport(url, init)),
      deadline,
    );
    if (deadline.isExpired() || transportSettled.status === "expired") {
      return deadlineFault();
    }
    if (transportSettled.status === "rejected") {
      return portError("unavailable", "deno transport is unavailable");
    }
    const response = transportSettled.result;
    const bodyResult = await readBoundedBody(
      response,
      request.responseByteCap,
      deadline,
    );
    if (!bodyResult.ok) return bodyResult;
    return portOk({ status: response.status, body: bodyResult.value });
  } finally {
    deadline.close();
  }
}

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

interface DenoDeadlineV1 {
  readonly signal: AbortSignal;
  readonly happened: Promise<void>;
  isExpired(): boolean;
  close(): void;
}

function startDeadline(ms: number): DenoDeadlineV1 {
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
      // Best-effort teardown; the caller owns the result.
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
  return portError("unavailable", DENO_TIMEOUT_DETAIL);
}

function resolveTimeoutMs(requested: number | undefined): number | null {
  const ms = requested ?? DENO_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(ms) || ms < 1 || ms > DENO_MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return ms;
}

type SettledV1<T> =
  | { status: "settled"; result: T }
  | { status: "rejected" }
  | { status: "expired" };

/**
 * Races one settlement (with its rejection converted) against the deadline.
 * The raw promise always receives settlement handlers, so a late response is
 * cancelled by the caller and a late rejection is swallowed — never an
 * unhandled rejection.
 */
function settleWithin<T>(
  promise: Promise<T>,
  deadline: DenoDeadlineV1,
): Promise<SettledV1<T>> {
  return Promise.race([
    promise.then(
      (result): SettledV1<T> => ({ status: "settled", result }),
      (): SettledV1<T> => ({ status: "rejected" }),
    ),
    deadline.happened.then((): SettledV1<T> => ({ status: "expired" })),
  ]);
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** Fire-and-forget body teardown; cancellation is never awaited. */
export function releaseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Best-effort teardown; the typed result is already determined.
  }
}

async function readBoundedBody(
  response: Response,
  cap: number,
  deadline: DenoDeadlineV1,
): Promise<PortResultV1<Uint8Array>> {
  if (response.body === null) return portOk(new Uint8Array());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (deadline.isExpired()) return deadlineFault();
      const outcome = await settleWithin(reader.read(), deadline);
      if (deadline.isExpired() || outcome.status === "expired") {
        return deadlineFault();
      }
      if (outcome.status === "rejected") {
        return portError(
          "unavailable",
          "deno response body could not be read",
        );
      }
      const { done, value } = outcome.result;
      if (done) break;
      if (value.byteLength > cap - total) {
        return portError("invalid", "deno response exceeds the byte bound");
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
      "deno response body could not be read",
    );
  } finally {
    try {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } catch {
      // A pending read can make releaseLock throw; the aborted fetch owns
      // the remaining teardown.
    }
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: URLSearchParams | undefined,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const search = query?.toString() ?? "";
  return `${base}${path}${search.length > 0 ? `?${search}` : ""}`;
}

export type { PortErrorKindV1 };
