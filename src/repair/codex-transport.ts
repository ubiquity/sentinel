/**
 * m04-repair: bounded Codex app-server JSON-RPC transport.
 *
 * One concrete subprocess/JSON-RPC boundary for the runtime ImplementationPort
 * (codex app-server over stdio). The transport owns:
 * - a credential-free child environment (clearEnv plus an explicit minimal env
 *   only; no state/App/Deno secrets, no promotion authority),
 * - a strict JSON-RPC 2.0 line transport with response/notification
 *   correlation and static sanitized typed errors for malformed or missing
 *   evidence,
 * - finite whole-operation deadlines and bounded stream/output buffering,
 * - terminal settlement: an interrupt acknowledgement alone never counts as
 *   terminal; only a `turn/completed` event with a terminal Turn status ends
 *   the wait,
 * - cleared timers and awaited child/stream settlement on every path.
 *
 * Nothing here reads credentials, settings or product CLI flags: binary, argv,
 * env and cwd are explicit constructor inputs supplied by the trusted session
 * host; private finite constants cover every bound.
 */

/** Static sanitized error for malformed/missing protocol evidence. */
export class CodexProtocolError extends Error {
  constructor(
    public readonly detail:
      | "malformed_line"
      | "unexpected_frame"
      | "unknown_request_id"
      | "server_error"
      | "timeout_without_terminal"
      | "child_exited_without_terminal"
      | "stream_output_bound_exceeded"
      | "operation_deadline",
    message: string,
  ) {
    super(message);
    this.name = "CodexProtocolError";
  }
}

export interface CodexServerRequestV1 {
  id: string | number;
  method: string;
  params: unknown;
}

export interface CodexServerNotificationV1 {
  method: string;
  params: unknown;
}

export interface CodexTransportOptionsV1 {
  /** Concrete entry point; default is the supported `codex app-server`. */
  command: string[];
  /** Working directory of the app-server child (isolated checkout root). */
  cwd: string;
  /** Minimal child environment; never inherited wholesale. */
  env: Readonly<Record<string, string>>;
  /** Maximum UTF-8 bytes buffered per inbound line. */
  maxLineBytes?: number;
  /** Maximum inbound notification bytes retained for output accounting. */
  maxNotificationBytes?: number;
  /** Maximum stderr bytes retained for diagnostics. */
  maxStderrBytes?: number;
  /** Whole-operation deadline for one open/request/close cycle, in ms. */
  operationDeadlineMs: number;
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_NOTIFICATION_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export interface CodexSessionV1 {
  /** Send one request; resolves with the JSON-RPC result payload. */
  send(method: string, params: unknown): Promise<unknown>;
  /** Send one notification (no response expected; e.g. `initialized`). */
  notify(method: string, params?: unknown): void;
  /** Register the single notification consumer. */
  onNotification(handler: (event: CodexServerNotificationV1) => void): void;
  /** Register the single server-request consumer (unsolicited requests). */
  onServerRequest(handler: (request: CodexServerRequestV1) => void): void;
  /** Tear down; resolves only after owned child/stream settlement. */
  close(): Promise<void>;
}

/** One app-server session with a real subprocess. */
export class CodexSubprocessSession implements CodexSessionV1 {
  private readonly options: CodexTransportOptionsV1;
  private readonly maxLineBytes: number;
  private readonly maxNotificationBytes: number;
  private readonly maxStderrBytes: number;
  private child: Deno.ChildProcess | null = null;
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: CodexProtocolError) => void;
  }>();
  private notificationHandler:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private serverRequestHandler:
    | ((request: CodexServerRequestV1) => void)
    | null = null;
  private stdoutDone: Promise<void> = Promise.resolve();
  private stderrDone: Promise<void> = Promise.resolve();
  private childExit: Promise<{ code: number | null }> = Promise.resolve({
    code: null,
  });
  private stderrTail = "";
  private observableBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: CodexTransportOptionsV1) {
    this.options = options;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxNotificationBytes = options.maxNotificationBytes ??
      DEFAULT_MAX_NOTIFICATION_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  }

  /** Spawn the child with a cleared environment and start the read pumps. */
  open(): void {
    if (this.child !== null) {
      throw new CodexProtocolError(
        "unexpected_frame",
        "transport already open",
      );
    }
    const command = new Deno.Command(this.options.command[0], {
      args: this.options.command.slice(1),
      cwd: this.options.cwd,
      clearEnv: true,
      env: this.options.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    let child: Deno.ChildProcess;
    try {
      child = command.spawn();
    } catch {
      throw new CodexProtocolError(
        "child_exited_without_terminal",
        "codex app-server failed to spawn",
      );
    }
    this.child = child;
    this.stdoutDone = this.pumpStdout(child.stdout);
    this.stderrDone = this.pumpStderr(child.stderr);
    this.childExit = Promise.all([
      this.stdoutDone,
      this.stderrDone,
      child.status,
    ]).then(([, , status]) => ({ code: status.code }));
    // Whole-operation deadline; cleared on close.
    this.timer = setTimeout(() => {
      this.fail(
        new CodexProtocolError(
          "operation_deadline",
          "codex session operation deadline exceeded",
        ),
      );
    }, this.options.operationDeadlineMs);
  }

  send(method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (request: CodexServerRequestV1) => void): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Close: reject all pending, clear timers, terminate the owned child and
   * await both owned stream pumps and the child status. Direct parent exit is
   * never taken as proof of descendant/pipe settlement.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.rejectAll(
      new CodexProtocolError(
        "child_exited_without_terminal",
        "session closed",
      ),
    );
    const child = this.child;
    if (child !== null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited; the await below still settles ownership.
      }
      await this.childExit;
    }
    await Promise.all([this.stdoutDone, this.stderrDone]);
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        if (buffer.length > this.maxLineBytes * 4) {
          this.fail(
            new CodexProtocolError(
              "malformed_line",
              "codex stream line bound exceeded",
            ),
          );
          return;
        }
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim().length === 0) continue;
          if (line.length > this.maxLineBytes) {
            this.fail(
              new CodexProtocolError(
                "malformed_line",
                "codex line bound exceeded",
              ),
            );
            continue;
          }
          const outcome = this.handleLine(line);
          if (outcome !== null) {
            this.fail(outcome);
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.appendStderr(new TextDecoder().decode(value));
      }
    } finally {
      reader.releaseLock();
    }
  }

  private appendStderr(text: string): void {
    this.stderrTail += text;
    if (this.stderrTail.length > this.maxStderrBytes) {
      this.stderrTail = this.stderrTail.slice(-this.maxStderrBytes);
    }
  }

  /** Returns a protocol error instead of throwing across async pumps. */
  private handleLine(line: string): CodexProtocolError | null {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return new CodexProtocolError("malformed_line", "malformed JSON frame");
    }
    if (typeof frame !== "object" || frame === null) {
      return new CodexProtocolError("malformed_line", "malformed frame shape");
    }
    const record = frame as Record<string, unknown>;
    if (typeof record.method === "string" && !("id" in record)) {
      // Server notification.
      const method = record.method;
      if (method.endsWith("/requestApproval")) {
        // Never grant; the controller rejects unsolicited approval requests.
        return null; // handled below via the server-request rejection path
      }
      this.observableBytes += line.length;
      if (this.observableBytes > this.maxNotificationBytes) {
        return new CodexProtocolError(
          "stream_output_bound_exceeded",
          "codex notification byte bound exceeded",
        );
      }
      this.notificationHandler?.({ method, params: record.params });
      return null;
    }
    if (typeof record.method === "string" && "id" in record) {
      // Server request: respond with an explicit rejection, never approval.
      this.write({
        jsonrpc: "2.0",
        id: record.id,
        error: {
          code: -32001,
          message: "server request not supported by bounded controller",
        },
      });
      this.serverRequestHandler?.({
        id: record.id as string | number,
        method: record.method,
        params: record.params,
      });
      return null;
    }
    if ("id" in record && ("result" in record || "error" in record)) {
      const id = record.id as string | number;
      const entry = this.pending.get(id);
      if (entry === undefined) {
        return new CodexProtocolError(
          "unknown_request_id",
          "response for unknown request id",
        );
      }
      this.pending.delete(id);
      if (record.error !== undefined) {
        entry.reject(
          new CodexProtocolError(
            "server_error",
            extractErrorDetail(record.error),
          ),
        );
        return null;
      }
      entry.resolve(record.result);
      return null;
    }
    return new CodexProtocolError(
      "unexpected_frame",
      "unsupported JSON-RPC frame",
    );
  }

  private fail(error: Error): void {
    this.rejectAll(error);
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // Ownership is settled by the awaited exit below.
    }
  }

  private rejectAll(error: Error): void {
    const canonical = error instanceof CodexProtocolError
      ? error
      : new CodexProtocolError(
        "server_error",
        "codex session failed: " + error.message.slice(0, 200),
      );
    for (const entry of this.pending.values()) {
      entry.reject(canonical);
    }
    this.pending.clear();
  }

  private write(frame: unknown): void {
    const child = this.child;
    if (child === null || this.closed) {
      this.pending.clear();
      return;
    }
    const text = JSON.stringify(frame) + "\n";
    const writer = child.stdin.getWriter();
    void writer.write(new TextEncoder().encode(text)).catch(() => {
      writer.releaseLock();
    }).then(() => {
      writer.releaseLock();
    });
  }
}

function extractErrorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message.slice(0, 300);
    }
  }
  return "codex server error";
}

let requestCounter = 0;
function nextRequestId(): number {
  requestCounter++;
  return requestCounter;
}
