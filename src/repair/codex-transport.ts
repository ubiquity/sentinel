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
 * - serialized app-server writes: every JSON-RPC frame goes through one owned
 *   stdin writer queued strictly in order, so concurrent requests can never
 *   interleave partial frames on the child's stdin,
 * - terminal settlement: an interrupt acknowledgement alone never counts as
 *   terminal; only a `turn/completed` event with a terminal Turn status ends
 *   the wait,
 * - bounded close/termination: the owned process group is TERM'd, then KILL'd
 *   after a bounded grace, and the captured stream pumps are canceled and
 *   awaited within a bounded margin — close provably cannot hang on a direct
 *   child that exited while a descendant still holds the pipes.
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
  /** Bounded grace for owned-group SIGTERM settlement before SIGKILL. */
  closeTermGraceMs?: number;
  /** Bounded wait for the owned group/direct child after SIGKILL. */
  closeKillSettleMs?: number;
  /** Bounded drain wait for queued stdin writes during close. */
  closeWriteDrainMs?: number;
  /** Bounded margin for the canceled stream pumps to settle at close. */
  closeStreamSettleMs?: number;
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_NOTIFICATION_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TERM_GRACE_MS = 500;
const DEFAULT_CLOSE_KILL_SETTLE_MS = 1_000;
const DEFAULT_CLOSE_WRITE_DRAIN_MS = 2_000;
const DEFAULT_CLOSE_STREAM_SETTLE_MS = 1_000;

export interface CodexSessionV1 {
  /**
   * Start the owned subprocess when the session is lazy.  Test doubles may
   * omit this method; the model port treats the capability as optional.
   * Keeping startup here lets a trusted host return a concrete session
   * without relying on an undocumented pre-open convention.
   */
  open?(): void;
  /** Send one request; resolves with the JSON-RPC result payload. */
  send(method: string, params: unknown): Promise<unknown>;
  /** Send one notification (no response expected; e.g. `initialized`). */
  notify(method: string, params?: unknown): void;
  /** Register the single notification consumer. Notifications arriving
   * before registration are retained in a bounded ordered backlog and
   * delivered exactly once at registration, in wire order. */
  onNotification(handler: (event: CodexServerNotificationV1) => void): void;
  /** Register the single server-request consumer (unsolicited requests). */
  onServerRequest(handler: (request: CodexServerRequestV1) => void): void;
  /** Tear down; resolves only after owned child/descendant settlement. */
  close(): Promise<void>;
}

/** One app-server session with a real subprocess. */
export class CodexSubprocessSession implements CodexSessionV1 {
  private readonly options: CodexTransportOptionsV1;
  private readonly maxLineBytes: number;
  private readonly maxNotificationBytes: number;
  private readonly maxStderrBytes: number;
  private readonly closeTermGraceMs: number;
  private readonly closeKillSettleMs: number;
  private readonly closeWriteDrainMs: number;
  private readonly closeStreamSettleMs: number;
  private child: Deno.ChildProcess | null = null;
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: CodexProtocolError) => void;
  }>();
  private notificationHandler:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  /**
   * Ordered backlog for inbound notifications that arrive before the consumer
   * registers. The existing inbound notification byte bound (observableBytes
   * vs maxNotificationBytes) is applied to every notification before it is
   * queued, so this backlog is finite by the same bound as live delivery.
   */
  private readonly pendingNotifications: CodexServerNotificationV1[] = [];
  private serverRequestHandler:
    | ((request: CodexServerRequestV1) => void)
    | null = null;
  private stdoutDone: Promise<void> = Promise.resolve();
  private stderrDone: Promise<void> = Promise.resolve();
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrTail = "";
  private observableBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /**
   * First fatal stream/session error; sticky until close. Once set, no
   * further frame is queued or delivered, new sends reject with it and
   * consumer registration fails explicitly: no valid-looking completion can
   * escape a transport that already failed closed.
   */
  private fatalError: CodexProtocolError | null = null;
  private closePromise: Promise<void> | null = null;
  /** Strictly serialized stdin writes; one frame at a time, never interleaved. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CodexTransportOptionsV1) {
    this.options = options;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxNotificationBytes = options.maxNotificationBytes ??
      DEFAULT_MAX_NOTIFICATION_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.closeTermGraceMs = options.closeTermGraceMs ??
      DEFAULT_CLOSE_TERM_GRACE_MS;
    this.closeKillSettleMs = options.closeKillSettleMs ??
      DEFAULT_CLOSE_KILL_SETTLE_MS;
    this.closeWriteDrainMs = options.closeWriteDrainMs ??
      DEFAULT_CLOSE_WRITE_DRAIN_MS;
    this.closeStreamSettleMs = options.closeStreamSettleMs ??
      DEFAULT_CLOSE_STREAM_SETTLE_MS;
  }

  /** Spawn the child with a cleared environment and start the read pumps. */
  open(): void {
    if (this.closed) {
      // Closed sessions fail closed BEFORE the idempotent open guard: an
      // opened-then-closed session must never silently present as open again
      // (its child handle is still set), and a never-opened closed session
      // must never respawn. No model work can start after close.
      throw new CodexProtocolError(
        "child_exited_without_terminal",
        "transport already closed",
      );
    }
    if (this.child !== null) {
      // Opening is idempotent so a trusted host may pre-open the session and
      // the model port may also enforce the lazy-session boundary safely.
      return;
    }
    const command = new Deno.Command(this.options.command[0], {
      args: this.options.command.slice(1),
      cwd: this.options.cwd,
      clearEnv: true,
      env: this.options.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      // Owned process group: the child becomes a session/group leader so the
      // bounded close can TERM then KILL the whole group (descendants that
      // keep the captured pipes open after the direct parent exits included).
      detached: true,
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
    this.stdinWriter = child.stdin.getWriter();
    this.stdoutDone = this.pumpStdout(child.stdout);
    this.stderrDone = this.pumpStderr(child.stderr);
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
    if (this.fatalError !== null) {
      return Promise.reject(this.fatalError);
    }
    if (this.closed) {
      return Promise.reject(
        new CodexProtocolError(
          "child_exited_without_terminal",
          "session closed",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.fatalError !== null || this.closed) return;
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    if (this.fatalError !== null) throw this.fatalError;
    this.notificationHandler = handler;
    // Drain pre-registration notifications now, exactly once and in wire
    // order (the backlog is bounded by the notification byte bound above),
    // so a terminal event racing the turn/start response is never dropped.
    if (this.pendingNotifications.length > 0) {
      const backlog = this.pendingNotifications.splice(0);
      for (const event of backlog) handler(event);
    }
  }

  onServerRequest(handler: (request: CodexServerRequestV1) => void): void {
    if (this.fatalError !== null) throw this.fatalError;
    this.serverRequestHandler = handler;
  }

  /**
   * Close: reject all pending, clear timers, drain queued writes (bounded),
   * terminate the owned process group (TERM then KILL with bounded waits) and
   * cancel/await the owned stream pumps within a bounded margin. Direct parent
   * exit is never taken as proof of descendant/pipe settlement; close always
   * returns, no matter how long an uncooperative descendant holds a pipe.
   */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = this.settleClosed();
    return this.closePromise;
  }

  private async settleClosed(): Promise<void> {
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
    if (child === null) {
      this.releaseStdin();
      await Promise.allSettled([this.stdoutDone, this.stderrDone]);
      return;
    }
    // Drain queued writes within a bound so no frame is half-written when the
    // child is signaled; a stuck stdin must never hang close.
    await bounded(this.writeChain, this.closeWriteDrainMs);
    signalGroup(child, "SIGTERM");
    await boundedChildStatus(child, this.closeTermGraceMs);
    signalGroup(child, "SIGKILL");
    await boundedChildStatus(child, this.closeKillSettleMs);
    // Cancel the captured pumps: after the group signals, no owned writer
    // remains, and a canceled reader cannot keep settlement (or close) pending.
    this.cancelPumps();
    await bounded(
      Promise.allSettled([this.stdoutDone, this.stderrDone]),
      this.closeStreamSettleMs,
    );
    this.releaseStdin();
  }

  private cancelPumps(): void {
    try {
      this.stdoutReader?.cancel().catch(() => {});
    } catch {
      // Reader already released; pump settlement is still bounded below.
    }
    try {
      this.stderrReader?.cancel().catch(() => {});
    } catch {
      // Reader already released; pump settlement is still bounded below.
    }
  }

  private releaseStdin(): void {
    const writer = this.stdinWriter;
    this.stdinWriter = null;
    if (writer !== null) {
      try {
        writer.releaseLock();
      } catch {
        // A write may still be in flight; the writer is abandoned with close.
      }
    }
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    this.stdoutReader = reader;
    let buffer = "";
    try {
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch {
          // Canceled at close; settlement below is bounded.
          return;
        }
        if (read.done) break;
        buffer += new TextDecoder().decode(read.value);
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
            // A fatal bound failure ends the pump: the rest of the buffer
            // must not be re-queued or delivered.
            return;
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
      if (this.stdoutReader === reader) this.stdoutReader = null;
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    this.stderrReader = reader;
    try {
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch {
          // Canceled at close; settlement below is bounded.
          return;
        }
        if (read.done) break;
        this.appendStderr(new TextDecoder().decode(read.value));
      }
    } finally {
      reader.releaseLock();
      if (this.stderrReader === reader) this.stderrReader = null;
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
    // After a fatal failure no further frame may be queued or delivered; the
    // pump reports the sticky error and stops processing the buffer.
    if (this.fatalError !== null) return this.fatalError;
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
      const notification: CodexServerNotificationV1 = {
        method,
        params: record.params,
      };
      if (this.notificationHandler !== null) {
        this.notificationHandler(notification);
      } else {
        // No consumer yet: retain once, in wire order, until registration
        // drains the backlog (bounded by the byte bound applied above).
        this.pendingNotifications.push(notification);
      }
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
    // First failure wins and sticks: later frames, sends and registrations
    // all observe the same canonical error and never re-enter delivery.
    if (this.fatalError === null) {
      this.fatalError = error instanceof CodexProtocolError
        ? error
        : new CodexProtocolError(
          "server_error",
          "codex session failed: " + error.message.slice(0, 200),
        );
    }
    // Discard the bounded pre-registration backlog: a terminal retained
    // before the failure must never be delivered after the stream failed.
    this.pendingNotifications.length = 0;
    this.rejectAll(this.fatalError);
    const child = this.child;
    if (child !== null) {
      signalGroup(child, "SIGTERM");
    }
  }

  private rejectAll(error: Error): void {
    const canonical = this.fatalError ??
      (error instanceof CodexProtocolError ? error : new CodexProtocolError(
        "server_error",
        "codex session failed: " + error.message.slice(0, 200),
      ));
    for (const entry of this.pending.values()) {
      entry.reject(canonical);
    }
    this.pending.clear();
  }

  private write(frame: unknown): void {
    const writer = this.stdinWriter;
    if (this.closed || writer === null) {
      this.rejectAll(
        new CodexProtocolError(
          "child_exited_without_terminal",
          "session closed",
        ),
      );
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
    // Serialize: exactly one write in flight per session, strictly ordered.
    // A fresh writer per call plus releaseLock could interleave partial
    // JSON-RPC frames (or throw on a locked stream) for concurrent requests.
    this.writeChain = this.writeChain
      .then(() => writer.write(bytes))
      .catch(() => {
        // A failed write (terminated child) never breaks the chain; close
        // rejects the affected requests and settles the child.
      });
  }
}

/**
 * TERM/KILL the whole owned process group where supported, falling back to
 * the direct child handle (bounded settles below keep the caller safe either
 * way). Negative pid: the detached child is the group leader (pid == pgid),
 * so signaling reaches exactly this session's descendants, never siblings.
 */
function signalGroup(child: Deno.ChildProcess, signo: Deno.Signal): void {
  try {
    Deno.kill(-child.pid, signo);
    return;
  } catch {
    // The group is already gone (ESRCH) or group signaling is not granted
    // (NotCapable): fall through to the direct child handle.
  }
  try {
    child.kill(signo);
  } catch {
    // Already exited.
  }
}

/** Bounded wait for the direct child's status; returns after `ms` at most. */
async function boundedChildStatus(
  child: Deno.ChildProcess,
  ms: number,
): Promise<void> {
  try {
    await bounded(child.status.then(() => {}), ms);
  } catch {
    // Status observation failed; the group settle is still bounded.
  }
}

/** Race one promise against a finite deadline; always settles by `ms`. */
async function bounded(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } catch {
    // The observed promise failed; the bound still holds.
  } finally {
    if (timer !== null) clearTimeout(timer);
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
