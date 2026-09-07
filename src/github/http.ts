/**
 * Injected HTTP transport boundary for the GitHub module.
 *
 * Every network read/write in this module goes through one narrow,
 * function-shaped transport: `HttpTransportV1(request) => response`. It is
 * "fetch-compatible" in shape — one request value in, one buffered response
 * value out — and production binds it to the real `fetch` through
 * `fromFetch`; tests inject scripted transports and never touch the network.
 *
 * The boundary is credential-free by construction: tokens and private keys
 * never appear in a request/response value (only the Authorization header the
 * injected token provider supplies), and no error produced by this module
 * ever echoes a response body, URL or header value.
 *
 * Lifetime discipline: `fromFetch` applies a finite whole-operation deadline
 * that begins before the request is issued and covers the response body read,
 * a strict `redirect: "error"` policy, an abort signal for the real fetch and
 * a streaming byte bound on the body. Timers are cleared, late responses are
 * canceled and late rejections are handled so no operation blocks
 * indefinitely and nothing becomes an unhandled rejection.
 */

export interface HttpRequestV1 {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** Lowercase header names; never log or echo values. */
  headers: ReadonlyMap<string, string>;
  /** UTF-8 request body; null when no body is sent. */
  body: string | null;
}

export interface HttpResponseV1 {
  status: number;
  /** Case-insensitive response headers (web Headers). */
  headers: Headers;
  /** Buffered UTF-8 response body; consumed exactly once by the caller. */
  bodyText: string;
}

export type HttpTransportV1 = (
  request: HttpRequestV1,
) => Promise<HttpResponseV1>;

/** Build the lowercase-header map used by HttpRequestV1. */
export function headerMap(
  headers: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    map.set(name.toLowerCase(), value);
  }
  return map;
}

/** Case-insensitive lookup on the lowercase request header map. */
export function requestHeader(
  headers: ReadonlyMap<string, string>,
  name: string,
): string | null {
  return headers.get(name.toLowerCase()) ?? null;
}

/**
 * The minimal response shape a fetch-compatible function must produce. The
 * real `fetch` satisfies it structurally (`Response.status`, `Response.headers`,
 * `Response.text()`); tests produce the same shape without the network.
 */
export interface HttpResponseLikeV1 {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  /** Streaming body when the implementation exposes one (web `Response`). */
  body?: ReadableStream<Uint8Array> | null;
}

/**
 * Any function with the standard fetch signature: `globalThis.fetch`
 * satisfies it, and tests may bind a scripted fake. Bound to the transport
 * with `fromFetch`.
 */
export type FetchLikeV1 = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: "error";
    signal?: AbortSignal;
  },
) => Promise<HttpResponseLikeV1>;

/** Finite default deadline for one operation (auth + request + body read). */
export const DEFAULT_HTTP_DEADLINE_MS = 30_000;
/** Finite default byte bound on a response body. */
export const DEFAULT_HTTP_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Sentinel timeout used internally; never propagated raw to callers. */
class SentinelOperationTimeout extends Error {
  constructor() {
    super("operation timed out");
    this.name = "SentinelOperationTimeout";
  }
}

/**
 * One finite deadline. `race` is a real `Promise.race` against the deadline
 * so operations that ignore an AbortSignal still cannot block indefinitely.
 * The deadline promise itself never becomes an unhandled rejection, and
 * `dispose` clears the timer exactly once.
 */
export interface DeadlineV1 {
  race<T>(promise: Promise<T>): Promise<T>;
  /** True once the deadline has fired. */
  fired(): boolean;
  /** Clear the timer; safe to call repeatedly. */
  dispose(): void;
}

export function createDeadline(ms: number): DeadlineV1 {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: Promise<never> | null = null;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      fired = true;
      reject(new SentinelOperationTimeout());
    }, ms);
  });
  promise.catch(() => {
    // The deadline itself is a control flow signal, never a leak.
  });
  deadline = promise;
  return {
    race<T>(value: Promise<T>): Promise<T> {
      return Promise.race([value, deadline as Promise<never>]);
    },
    fired(): boolean {
      return fired;
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Bind a fetch-shaped function (real or injected) to the transport boundary.
 *
 * The response body is buffered exactly once so callers can parse JSON and
 * keep a text copy. Redirects fail closed (`redirect: "error"`: the bearer
 * token must never be replayed to a different origin). A rejected promise
 * (lost/never-received response) or a deadline/body-bound failure is thrown
 * to the caller, whose raw message is never propagated — the caller maps the
 * failure into a sanitized typed error. Late-settling responses and readers
 * are canceled with rejection handlers attached.
 */
export function fromFetch(
  fetchFn: FetchLikeV1,
  options: {
    deadlineMs?: number;
    maxBodyBytes?: number;
  } = {},
): HttpTransportV1 {
  const deadlineMs = options.deadlineMs ?? DEFAULT_HTTP_DEADLINE_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES;
  return async (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const deadline = createDeadline(deadlineMs);
    const controller = new AbortController();
    try {
      const fetchPromise = fetchFn(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ?? undefined,
        redirect: "error",
        signal: controller.signal,
      });
      // A fetch that settles after the deadline fired must release its body
      // and must never surface as an unhandled rejection.
      fetchPromise.then((response) => {
        if (deadline.fired()) {
          void response.body?.cancel().catch(() => {});
        }
      }).catch(() => {});
      let response: HttpResponseLikeV1;
      try {
        response = await deadline.race(fetchPromise);
      } catch (error) {
        if (deadline.fired()) controller.abort();
        throw error;
      }
      const body = startBoundedBodyRead(response, maxBodyBytes);
      let bodyText: string;
      try {
        bodyText = await deadline.race(body.promise);
      } catch (error) {
        // Release the stream (and swallow its later rejection) either way.
        body.cancel();
        body.promise.catch(() => {});
        if (deadline.fired()) controller.abort();
        throw error;
      }
      body.promise.catch(() => {});
      return {
        status: response.status,
        headers: response.headers,
        bodyText,
      };
    } finally {
      deadline.dispose();
    }
  };
}

/** Streaming body read with a finite byte bound; cancel detaches the stream. */
function startBoundedBodyRead(
  response: HttpResponseLikeV1,
  maxBytes: number,
): { promise: Promise<string>; cancel(): void } {
  if (response.body === undefined || response.body === null) {
    return { promise: Promise.resolve(""), cancel() {} };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const promise = (async () => {
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        total += step.value.byteLength;
        if (total > maxBytes) {
          throw new Error("response body exceeds the byte bound");
        }
        chunks.push(step.value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The reader was canceled/aborted; nothing more to release.
      }
    }
    if (chunks.length === 0) return "";
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  })();
  return {
    promise,
    cancel(): void {
      void reader.cancel().catch(() => {});
    },
  };
}

/** Production transport over real fetch. */
export function fetchHttpTransport(
  fetchFn: FetchLikeV1 = globalThis.fetch as unknown as FetchLikeV1,
): HttpTransportV1 {
  return fromFetch(fetchFn);
}
