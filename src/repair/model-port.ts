/**
 * m04-repair: runtime ImplementationPort backed by a bounded Codex app-server
 * session (gpt-5.6-luna / max requested explicitly).
 *
 * Fail-closed receipt policy (frozen ImplementationPort has no authoritative
 * observation method or pre-call provider id): the session host supplies an
 * injectable ReceiptVerifier. The default verifier never certifies actual
 * provider model/effort, so the port returns `unavailable` and records the
 * live activation boundary — observed values are never synthesized from the
 * requested strings. A verifier is the trusted-host seam for authorized
 * runtime acceptance; without it no model budget is ever spent on a run the
 * controller cannot attribute, and the repair loop settles the durable
 * reservation ambiguous (charged) and blocks the task.
 *
 * The port never invents CLI flags/stdin controls or unsupported protocol
 * methods: thread and turn parameters come from the frozen installed schema
 * (`thread/start`, `turn/start`, `turn/interrupt`, `turn/completed`), terminal
 * settlement is awaited, and every owned timer and stream is cleared. The
 * thread sandbox is the narrowest write-capable mode (`workspace-write` over
 * the isolated checkout cwd): the session can produce its commit inside the
 * checkout but holds no read access outside it and no approval authority.
 */

import type { GitSha } from "../contracts/brands.ts";
import type {
  CandidateOutcomeV1,
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { CodexProtocolError, type CodexSessionV1 } from "./codex-transport.ts";

/** Max model task prompt characters (private finite bound). */
const MAX_PROMPT_CHARS = 32_000;
/** Max issue body characters carried into the session (private finite bound). */
const MAX_ISSUE_BODY_CHARS = 8_000;
/** Expected checkpoint ref on the model checkout, if the model recorded one. */
const CHECKPOINT_REF = "refs/sentinel/checkpoint";

export interface ActualSessionEvidenceV1 {
  /** Values the app-server itself acknowledged (configured thread metadata). */
  threadModel: string | null;
  threadModelProvider: string | null;
  threadEffort: string | null;
  /** Actual reroute observed during the run, if any (model/rerouted event). */
  rerouted: { from: string; to: string } | null;
  terminal: {
    status: "completed" | "interrupted" | "failed";
    error: string | null;
    durationMs: number | null;
  };
  outputChars: number;
}

/**
 * Trusted-host verification seam: returns the observed model/effort values
 * only when an authoritative provider receipt establishes them; null means
 * the activation boundary stays unresolved and the port must fail closed.
 */
export type ReceiptVerifierV1 = (
  evidence: ActualSessionEvidenceV1,
) => { observedModel: string; observedReasoning: string } | null;

/** The default verifier never certifies; nothing is ever synthesized. */
export const unavailableReceiptVerifier: ReceiptVerifierV1 = () => null;

/** Local credential-free checkout identity resolution (no remote, no creds). */
export interface CheckoutResolverV1 {
  resolve(): Promise<
    {
      head: GitSha | null;
      checkpointSha: GitSha | null;
      changedPaths: string[];
    } | null
  >;
}

/** Default resolver: local git in the checkout with a cleared environment. */
export class LocalCheckoutResolver implements CheckoutResolverV1 {
  constructor(
    private readonly checkoutDir: string,
    private readonly baseSha: GitSha,
  ) {}

  async resolve(): Promise<
    {
      head: GitSha | null;
      checkpointSha: GitSha | null;
      changedPaths: string[];
    } | null
  > {
    const head = await this.git(["rev-parse", "HEAD"]);
    if (head === null || !/^[0-9a-f]{40}$/.test(head.trim())) return null;
    const headSha = head.trim() as GitSha;
    const ancestor = await this.git([
      "merge-base",
      "--is-ancestor",
      this.baseSha,
      headSha,
    ]);
    if (ancestor === null || ancestor.trim() !== "") return null;
    const files = await this.git([
      "diff",
      "--name-only",
      `${this.baseSha}..${headSha}`,
    ]);
    const changedPaths = files === null
      ? []
      : files.split("\n").filter((line) => line.trim().length > 0);
    const checkpoint = await this.git([
      "rev-parse",
      "--verify",
      "-q",
      CHECKPOINT_REF,
    ]);
    const checkpointSha = checkpoint !== null &&
        /^[0-9a-f]{40}$/.test(checkpoint.trim())
      ? (checkpoint.trim() as GitSha)
      : null;
    return { head: headSha, checkpointSha, changedPaths };
  }

  private async git(args: string[]): Promise<string | null> {
    const command = new Deno.Command("git", {
      args: ["-C", this.checkoutDir, ...args],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: this.checkoutDir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const status = await command.output();
    if (status.code !== 0) return null;
    return new TextDecoder().decode(status.stdout);
  }
}

export interface CodexImplementationPortOptionsV1 {
  /** Opens one bounded app-server session per run (injectable for tests). */
  openSession(): Promise<CodexSessionV1>;
  /** Absolute path of the secret-free model checkout. */
  checkoutDir: string;
  /** Local checkout identity resolver (injectable for tests). */
  checkout?: CheckoutResolverV1;
  /** Trusted-host receipt verifier; the default never certifies. */
  receiptVerifier?: ReceiptVerifierV1;
  /** Grace for terminal settlement after an interrupt request. */
  interruptSettlementGraceMs?: number;
}

const DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS = 30_000;

export class CodexImplementationPort implements ImplementationPort {
  private readonly options: CodexImplementationPortOptionsV1;
  private readonly verifier: ReceiptVerifierV1;
  private readonly graceMs: number;

  constructor(options: CodexImplementationPortOptionsV1) {
    this.options = options;
    this.verifier = options.receiptVerifier ?? unavailableReceiptVerifier;
    this.graceMs = options.interruptSettlementGraceMs ??
      DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS;
  }

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    let session: CodexSessionV1 | null = null;
    const invocationId = `codex-${request.taskId}-${Date.now()}`;
    try {
      session = await this.options.openSession();
      await this.initialize(session);
      const prompt = buildPrompt(request);
      const thread = await this.startThread(session, request, prompt);
      const turn = await this.startTurn(
        session,
        request,
        prompt,
        thread.threadId,
      );
      const awaited = await this.awaitSettlement(
        session,
        request,
        thread.threadId,
        turn.turnId,
        request.maxOutputChars,
      );
      return this.finishReceipt(request, invocationId, thread, awaited);
    } catch (error) {
      const failure = unavailableFor(error);
      return portError(failure.kind, failure.detail);
    } finally {
      await session?.close();
    }
  }

  private async initialize(session: CodexSessionV1): Promise<unknown> {
    const response = await session.send("initialize", {
      clientInfo: {
        name: "sentinel-repair",
        title: "Sentinel repair controller",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    if (
      typeof response !== "object" || response === null ||
      typeof (response as Record<string, unknown>).userAgent !== "string"
    ) {
      throw new CodexProtocolError(
        "malformed_line",
        "initialize response missing evidence",
      );
    }
    session.notify("initialized", {});
    return response;
  }

  private async startThread(
    session: CodexSessionV1,
    request: ModelRunRequestV1,
    prompt: string,
  ): Promise<
    {
      threadId: string;
      model: string | null;
      effort: string | null;
      provider: string | null;
    }
  > {
    const response = await session.send("thread/start", {
      model: request.model,
      cwd: this.options.checkoutDir,
      // Bounded isolated-checkout write capability: the session may write
      // within the secret-free checkout only (the thread cwd is the checkout
      // root); the host approval policy stays "never" and no other sandbox is
      // granted. "read-only" would make the requested commit impossible.
      sandbox: "workspace-write",
      approvalPolicy: "never",
      ephemeral: true,
      baseInstructions: prompt,
    });
    const record = requireRecord(response, "thread/start");
    const thread = (record.thread ?? null) as Record<string, unknown> | null;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (threadId === null) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response missing thread id",
      );
    }
    const model = typeof record.model === "string" ? record.model : null;
    const effort = typeof record.reasoningEffort === "string"
      ? record.reasoningEffort
      : null;
    const provider = typeof record.modelProvider === "string"
      ? record.modelProvider
      : null;
    return { threadId, model, effort, provider };
  }

  private async startTurn(
    session: CodexSessionV1,
    request: ModelRunRequestV1,
    prompt: string,
    threadId: string,
  ): Promise<{ turnId: string }> {
    const response = await session.send("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: request.model,
      effort: request.reasoning,
    });
    const record = requireRecord(response, "turn/start");
    const turn = (record.turn ?? null) as Record<string, unknown> | null;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (turnId === null) {
      throw new CodexProtocolError(
        "malformed_line",
        "turn/start response missing turn id",
      );
    }
    return { turnId };
  }

  private async awaitSettlement(
    session: CodexSessionV1,
    request: ModelRunRequestV1,
    threadId: string,
    turnId: string,
    maxOutputChars: number,
  ): Promise<AwaitedSettlementV1> {
    let outputChars = 0;
    let rerouted: { from: string; to: string } | null = null;
    let terminal: AwaitedSettlementV1["terminal"] = null;
    let resolver: ((value: AwaitedSettlementV1) => void) | null = null;
    let interrupted = false;
    const terminalPromise = new Promise<AwaitedSettlementV1>((resolve) => {
      resolver = resolve;
    });
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      void session.send("turn/interrupt", { threadId, turnId }).catch(() => {
        // The interrupt request itself failed; the wait continues to the
        // settlement deadline and then fails closed without a terminal state.
      });
    };
    const onEvent = (method: string, params: unknown) => {
      if (method === "turn/completed") {
        const record = params as Record<string, unknown>;
        const turn = record?.turn as Record<string, unknown> | null;
        if (record?.threadId !== threadId || turn === null) return;
        const status = turn.status;
        if (
          status !== "completed" && status !== "interrupted" &&
          status !== "failed"
        ) {
          // A non-terminal status in the terminal event is malformed evidence.
          terminal = {
            status: "failed",
            error: "malformed terminal turn status",
            durationMs: null,
          };
          resolver?.({ terminal, outputChars, rerouted });
          return;
        }
        const turnError = (turn.error ?? null) as
          | Record<string, unknown>
          | null;
        const error = typeof turnError?.message === "string"
          ? turnError.message.slice(0, 300)
          : null;
        terminal = {
          status,
          error,
          durationMs: typeof turn.durationMs === "number"
            ? turn.durationMs
            : null,
        };
        resolver?.({ terminal, outputChars, rerouted });
        return;
      }
      if (method === "model/rerouted") {
        const record = params as Record<string, unknown>;
        if (
          typeof record?.fromModel === "string" &&
          typeof record?.toModel === "string"
        ) {
          rerouted = { from: record.fromModel, to: record.toModel };
        }
        return;
      }
      // Bounded output accounting: the sum of all notification payloads is
      // capped; crossing the bound interrupts the turn (never silent drift).
      outputChars += JSON.stringify(params ?? {}).length;
      if (outputChars > maxOutputChars) interrupt();
    };
    session.onNotification((event) => onEvent(event.method, event.params));

    const durationTimer = setTimeout(interrupt, request.maxDurationMs);
    const settleTimer = setTimeout(() => {
      if (terminal === null) {
        terminal = {
          status: "failed",
          error: "timeout without terminal settlement",
          durationMs: null,
        };
        resolver?.({ terminal, outputChars, rerouted });
      }
    }, request.maxDurationMs + this.graceMs + 1);

    const settled = await terminalPromise;
    clearTimeout(durationTimer);
    clearTimeout(settleTimer);
    return settled;
  }

  private async finishReceipt(
    request: ModelRunRequestV1,
    invocationId: string,
    thread: {
      threadId: string;
      model: string | null;
      effort: string | null;
      provider: string | null;
    },
    settled: AwaitedSettlementV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    const checkout = this.options.checkout ?? new LocalCheckoutResolver(
      this.options.checkoutDir,
      request.base,
    );
    const resolved = settled.terminal?.status === "completed"
      ? await checkout.resolve()
      : null;
    const candidate: CandidateOutcomeV1 | null = resolved === null ? null : {
      head: resolved.head,
      checkpointSha: resolved.checkpointSha,
      changedPaths: resolved.changedPaths,
    };

    const evidence: ActualSessionEvidenceV1 = {
      threadModel: thread.model,
      threadModelProvider: thread.provider,
      threadEffort: thread.effort,
      rerouted: settled.rerouted,
      terminal: {
        status: settled.terminal?.status ?? "failed",
        error: settled.terminal?.error ?? null,
        durationMs: settled.terminal?.durationMs ?? null,
      },
      outputChars: settled.outputChars,
    };
    const verified = this.verifier(evidence);
    if (verified === null) {
      return portError(
        "unavailable",
        "model receipt unavailable: actual provider model/effort could not be verified at this boundary",
      );
    }
    if (
      verified.observedModel !== request.model ||
      verified.observedReasoning !== request.reasoning
    ) {
      return portError(
        "unavailable",
        "model receipt mismatch: observed model/effort differ from requested Luna/max",
      );
    }
    if (settled.terminal?.status !== "completed") {
      return portOk({
        invocationId,
        outcome: settled.terminal?.status === "interrupted"
          ? "interrupted"
          : "failed",
        actual: {
          observedModel: verified.observedModel,
          observedReasoning: verified.observedReasoning,
          durationMs: settled.terminal?.durationMs ?? 0,
          outputChars: settled.outputChars,
        },
        candidate: null,
        error: settled.terminal?.error ?? null,
      });
    }
    return portOk({
      invocationId,
      outcome: "completed",
      actual: {
        observedModel: verified.observedModel,
        observedReasoning: verified.observedReasoning,
        durationMs: settled.terminal?.durationMs ?? 0,
        outputChars: settled.outputChars,
      },
      candidate,
      error: null,
    });
  }
}

interface AwaitedSettlementV1 {
  terminal: {
    status: "completed" | "interrupted" | "failed";
    error: string | null;
    durationMs: number | null;
  } | null;
  outputChars: number;
  rerouted: { from: string; to: string } | null;
}

function requireRecord(
  value: unknown,
  method: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new CodexProtocolError(
      "malformed_line",
      `${method} response missing payload`,
    );
  }
  return value as Record<string, unknown>;
}

function buildPrompt(request: ModelRunRequestV1): string {
  const parts: string[] = [
    `Repository: ${request.repository.owner}/${request.repository.name}`,
    `Base revision: ${request.base}`,
  ];
  if (request.issue !== null) {
    parts.push(
      `Issue #${request.issue.number}: ${request.issue.title}`,
      `Issue body:\n${request.issue.body.slice(0, MAX_ISSUE_BODY_CHARS)}`,
    );
  }
  if (request.evidence.length > 0) {
    parts.push(
      `Evidence refs:\n${
        request.evidence.map((ref) => `- ${ref.kind}: ${ref.ref}`).join("\n")
      }`,
    );
  }
  parts.push(
    "Produce a minimal commit on the current checkout that resolves the " +
      "problem. Follow repository AGENTS instructions. Do not modify " +
      "protected paths, do not commit credentials, do not rewrite expected " +
      "test assertions to force success.",
  );
  return parts.join("\n\n").slice(0, MAX_PROMPT_CHARS);
}

function unavailableFor(
  error: unknown,
): { kind: "unavailable"; detail: string } {
  const detail = error instanceof CodexProtocolError
    ? error.detail
    : "codex session unavailable";
  return { kind: "unavailable", detail };
}
