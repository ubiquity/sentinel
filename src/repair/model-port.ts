/**
 * m04-repair: runtime ImplementationPort backed by a bounded Codex app-server
 * session (gpt-5.6-luna / max requested explicitly).
 *
 * Fail-closed receipt policy (frozen ImplementationPort has no authoritative
 * observation method or pre-call provider id): the session host supplies an
 * injectable ReceiptVerifier. The default verifier never certifies actual
 * provider model/effort, so the port returns `unavailable` and records the
 * live activation boundary — observed values are never synthesized from the
 * requested strings. An EXPLICIT valid `modelProvider` is required before ANY
 * session opens (including the custom-verifier path): a missing provider
 * stays unavailable and a callback never enables a missing provider. With a
 * selected provider the port binds the real request/runtime receipt producer
 * (`createRequestRuntimeReceiptVerifier(expectedProvider)`): the receipt then
 * proofs trusted submitted provider/model/effort configuration bound to the
 * exact invocation/thread/turn and runtime routing/terminal events, labeled
 * request/runtime evidence — never backend provider attestation. A supplied
 * custom verifier remains only an ADDITIONAL restriction after the concrete
 * core request/runtime checks; with no provider and no verifier the default
 * stays unavailable and no model budget is ever spent on a run the controller
 * cannot attribute; the repair loop settles the durable reservation ambiguous
 * (charged) and blocks the task.
 *
 * Correlation, routing and model-policy validation are port duties and cannot
 * be bypassed by an injected verifier: the port binds the exact session
 * identity/thread/turn, rejects any matching reroute off the required Luna
 * runtime model (even when routed back later), never synthesizes an actual
 * identity or route fallback, and requires nonempty correlated output evidence
 * for a completed run. Protocol or routing uncertainty (malformed reroute/
 * terminal identity, off-policy route, registration failure) sets a sticky
 * unavailable-evidence disposition: finishReceipt returns `unavailable`
 * before ANY verifier or candidate action — such uncertainty is never
 * certified as a valid failed runtime receipt. A HOST timeout (bounds elapsed
 * without a runtime terminal) may retain failed ACCOUNTING with an explicit
 * `host-timeout` terminal origin and the exact invocation/thread/turn
 * identities, but never claims an observed terminal (observed status null).
 * Failed/interrupted receipts may lack output; they are kept for accounting
 * and can never authorize a successful candidate.
 *
 * The port never invents CLI flags/stdin controls or unsupported protocol
 * methods: thread and turn parameters come from the frozen installed schema
 * (`thread/start`, `turn/start`, `turn/interrupt`, `turn/completed`), command
 * and edit items arrive as `item/started` / `item/completed` with an item
 * `type` of `commandExecution` or `fileChange`, terminal settlement is
 * awaited, and every owned timer and stream is cleared. The thread sandbox is
 * the narrowest write-capable mode (`workspace-write` over the isolated
 * checkout cwd): the session can produce its commit inside the checkout but
 * holds no read access outside it and no approval authority.
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
import { checkoutContentCheckpoint } from "./checkout-content.ts";
import { CodexProtocolError, type CodexSessionV1 } from "./codex-transport.ts";
import {
  FailedCommandLoopGuard,
  type FailedCommandObservation,
} from "./failed-command-loop.ts";

/** Max model task prompt characters (private finite bound). */
const MAX_PROMPT_CHARS = 32_000;
/** Max issue body characters carried into the session (private finite bound). */
const MAX_ISSUE_BODY_CHARS = 8_000;
/** Expected checkpoint ref on the model checkout, if the model recorded one. */
const CHECKPOINT_REF = "refs/sentinel/checkpoint";

/** Sanitized loop-stop marker recorded through the receipt error path. */
export const LOOP_STOP_MARKER = "failed_command_loop" as const;

/** Fixed corrective steer text: trusted fixed prose plus a sanitized digest. */
const STEER_TEXT =
  "The last commands produced the same verified failure. Inspect the saved " +
  "failure evidence and change your approach; repeating the failing command " +
  "will be stopped.";

/**
 * Nonlocal-only steer: focused repository tests remain allowed. The exact local
 * host scope suppresses this sentence so the owner's local-iteration directive
 * is never contradicted by an older tests-allowed instruction.
 */
const FOCUSED_TESTS_ALLOWED =
  " Focused repository tests and the necessary source context they need " +
  "remain allowed.";

// Private finite bounds for the observation pipeline (no new config surface).
const MAX_ITEM_ID_CHARS = 256;
const MAX_COMMAND_CHARS = 4096;
const MAX_CWD_CHARS = 4096;
const MAX_OUTPUT_CHARS = 64 * 1024; // 64Ki characters; larger output is inconclusive
const MAX_PENDING_OBSERVATIONS = 16;
const MAX_UNIQUE_ITEM_IDS = 1024;
const MAX_ACTIVE_COMMAND_IDS = 16;
/** Settle deadline from ANY interrupt: grace from the request, never the old ceiling. */
const SETTLE_GRACE_MS_EXTRA = 1;
/** Bound for thread/turn/reroute identity strings; larger identities are never accepted. */
const MAX_ID_CHARS = 256;
/** Bound for the configured provider name (nonempty finite string). */
const MAX_PROVIDER_CHARS = 256;
/** Bounded complete correlated routing events retained, oldest first. */
const MAX_REROUTES = 16;
/** Bounded correlated successful output items retained. */
const MAX_RESULT_ITEMS = 8;
/** Private bound for one file-change change path (nonempty per schema). */
const MAX_FILE_CHANGE_PATH_CHARS = 1024;
/** Private bound for one file-change diff text (presence only; never stored). */
const MAX_FILE_CHANGE_DIFF_CHARS = 256 * 1024;
/** Private bound for changes entries inside one file-change item. */
const MAX_CHANGES_PER_ITEM = 256;
/** Private bound for one command item's best-effort parsed actions array. */
const MAX_COMMAND_ACTIONS = 64;
/** The frozen runtime model id; no fallback is ever synthesized. */
const REQUIRED_MODEL_ID = "gpt-5.6-luna";
/** The frozen runtime reasoning effort; no fallback is ever synthesized. */
const REQUIRED_REASONING_EFFORT = "max";
/**
 * Trusted named permission profile: a host-defined name only. Built-in
 * full-access mode identifiers are never accepted as a named profile binding.
 */
const PERMISSION_PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BUILTIN_FULL_ACCESS_PERMISSION_PROFILE_IDS = new Set([
  "full-access",
  "danger-full-access",
]);

/** A nonempty bounded identity (thread/turn/reroute/id strings). */
function isBoundedId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_CHARS;
}

/**
 * Schema-shaped completed file-change output proof per the installed
 * ThreadItem schema: status is exactly `completed` and `changes` is a nonempty
 * bounded array whose entries carry the required `path` (nonempty bounded),
 * `kind` ({type: add|delete|update}) and `diff` (bounded string) fields.
 * Failed/declined/missing-status/empty-or-malformed changes can never prove
 * output.
 */
function hasValidCompletedChanges(item: Record<string, unknown>): boolean {
  if (item.status !== "completed") return false;
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) return false;
  if (changes.length > MAX_CHANGES_PER_ITEM) return false;
  for (const raw of changes) {
    const change = raw as Record<string, unknown> | null;
    if (typeof change !== "object" || change === null) return false;
    const path = change.path;
    if (
      typeof path !== "string" || path.trim().length === 0 ||
      path.length > MAX_FILE_CHANGE_PATH_CHARS
    ) {
      return false;
    }
    const kind = change.kind as Record<string, unknown> | null;
    if (typeof kind !== "object" || kind === null) return false;
    if (
      kind.type !== "add" && kind.type !== "delete" && kind.type !== "update"
    ) {
      return false;
    }
    const diff = change.diff;
    if (typeof diff !== "string" || diff.length > MAX_FILE_CHANGE_DIFF_CHARS) {
      return false;
    }
  }
  return true;
}

/** A bounded string that is neither empty nor whitespace-only. */
function isNonemptyBounded(value: string, maxChars: number): boolean {
  return value.trim().length > 0 && value.length <= maxChars;
}

/**
 * Schema-shaped successful command-execution output proof per the installed
 * ThreadItem/CommandAction schema: status exactly `completed`, exit code
 * exactly 0, nonempty bounded `command` and `cwd`, a required bounded
 * `commandActions` array (empty is supported) whose members obey the
 * installed CommandAction oneOf — read requires type/command/name/path;
 * listFiles type/command with an optional string|null path; search
 * type/command with optional string|null path/query; unknown type/command —
 * and any supplied optional aggregatedOutput/durationMs/source fields within
 * their supported types/bounds (absent optional fields keep their schema
 * defaults). Missing/invalid command/cwd/actions and malformed optional
 * fields can never prove output; failed-command-loop classification is
 * untouched by this proof gate.
 */
function hasValidCommandExecution(item: Record<string, unknown>): boolean {
  if (item.status !== "completed" || item.exitCode !== 0) return false;
  const command = item.command;
  if (
    typeof command !== "string" ||
    !isNonemptyBounded(command, MAX_COMMAND_CHARS)
  ) {
    return false;
  }
  const cwd = item.cwd;
  if (typeof cwd !== "string" || !isNonemptyBounded(cwd, MAX_CWD_CHARS)) {
    return false;
  }
  const actions = item.commandActions;
  if (!Array.isArray(actions) || actions.length > MAX_COMMAND_ACTIONS) {
    return false;
  }
  for (const raw of actions) {
    if (!isValidCommandAction(raw)) return false;
  }
  // Optional supplied fields: schema-typed and bounded when present; nothing
  // not supplied is invented.
  const output = item.aggregatedOutput;
  if (output !== undefined && output !== null) {
    if (typeof output !== "string" || output.length > MAX_OUTPUT_CHARS) {
      return false;
    }
  }
  const durationMs = item.durationMs;
  if (durationMs !== undefined && durationMs !== null) {
    if (
      typeof durationMs !== "number" ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0
    ) return false;
  }
  const source = item.source;
  if (
    source !== undefined && source !== "agent" &&
    source !== "userShell" && source !== "unifiedExecStartup" &&
    source !== "unifiedExecInteraction"
  ) {
    return false;
  }
  return true;
}

/** One CommandAction member of the installed schema, with exact required fields. */
function isValidCommandAction(raw: unknown): boolean {
  const action = raw as Record<string, unknown> | null;
  if (typeof action !== "object" || action === null) return false;
  const command = action.command;
  if (
    typeof command !== "string" ||
    !isNonemptyBounded(command, MAX_COMMAND_CHARS)
  ) {
    return false;
  }
  const optionalText = (value: unknown): boolean =>
    value === undefined || value === null ||
    (typeof value === "string" && isNonemptyBounded(value, MAX_COMMAND_CHARS));
  switch (action.type) {
    case "read": {
      const name = action.name;
      const path = action.path;
      return typeof name === "string" &&
        isNonemptyBounded(name, MAX_COMMAND_CHARS) &&
        typeof path === "string" &&
        isNonemptyBounded(path, MAX_CWD_CHARS);
    }
    case "listFiles":
      return optionalText(action.path);
    case "search":
      return optionalText(action.path) && optionalText(action.query);
    case "unknown":
      return true;
    default:
      return false;
  }
}

/**
 * The configured provider must be a nonempty finite string with no control
 * characters and no leading/trailing whitespace; anything else is rejected
 * before any session or model work begins.
 */
function isValidProvider(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PROVIDER_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * A configured named permission profile must be a valid host-defined name and
 * never a built-in full-access mode identifier.
 */
function isValidPermissionProfile(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!PERMISSION_PROFILE_PATTERN.test(value)) return false;
  return !BUILTIN_FULL_ACCESS_PERMISSION_PROFILE_IDS.has(value.toLowerCase());
}

/** One correlated runtime routing event acknowledged for the exact thread/turn. */
export interface ModelRerouteV1 {
  threadId: string;
  turnId: string;
  from: string;
  to: string;
  /** Routing reason when the event carried one; null when absent. */
  reason: string | null;
}

/** One successful correlated output item; notification-byte totals are not proof. */
export interface SessionResultItemV1 {
  itemId: string;
  type: "commandExecution" | "fileChange" | "agentMessage";
}

/**
 * Trusted request/runtime evidence for ONE exact invocation/thread/turn.
 * Values are the submitted provider/model/effort configuration acknowledged by
 * the app-server plus the exact session identities and runtime routing/terminal
 * events the port bound itself — NEVER backend-observed provider attestation.
 */
export interface ActualSessionEvidenceV1 {
  /** Exact invocation identity carried top-level by the receipt. */
  invocationId: string;
  /** Requested runtime model submitted with the run (frozen Luna policy). */
  requestedModel: string;
  /** Requested provider configuration; null when no provider is selected. */
  requestedProvider: string | null;
  /** Requested reasoning effort submitted with the run (frozen max policy). */
  requestedEffort: string;
  /** Exact thread identity acknowledged by thread/start. */
  threadId: string;
  /** Exact turn identity acknowledged by turn/start. */
  turnId: string;
  /** Values the app-server itself acknowledged (configured thread metadata). */
  threadModel: string | null;
  threadModelProvider: string | null;
  threadEffort: string | null;
  /** Bounded complete correlated routing events, oldest first. */
  reroutes: ModelRerouteV1[];
  terminal: {
    /** Observed runtime terminal status; null when none was observed (host timeout). */
    status: "completed" | "interrupted" | "failed" | null;
    error: string | null;
    durationMs: number | null;
  };
  /**
   * Terminal evidence origin: `runtime` when the correlated runtime terminal
   * event was observed; `host-timeout` when the host's own bounds elapsed
   * without any runtime terminal (observed status stays null — the receipt is
   * failed accounting only and never claims an observed terminal).
   */
  terminalOrigin: "runtime" | "host-timeout";
  /**
   * Own failed-command loop stop disposition: the early interrupt already
   * decided the run; a completed runtime terminal racing the stop is preserved
   * but may only ever produce interrupted/no-candidate accounting without
   * successful output.
   */
  loopStopped: boolean;
  /** Bounded successful output items for the exact thread/turn. */
  resultItems: SessionResultItemV1[];
  /** Notification-byte accounting total; never output proof. */
  outputChars: number;
}

/** Validated provider/model/effort values a verifier certifies. */
export interface VerifiedRuntimeValuesV1 {
  provider: string;
  observedModel: string;
  observedReasoning: string;
}

/**
 * Trusted-host verification seam: returns the validated provider/model/effort
 * values only when the request/runtime evidence establishes them; null means
 * the activation boundary stays unresolved and the port must fail closed.
 * The verifier never reads config/env/files and never returns a caller-supplied
 * output string as provider attestation.
 */
export type ReceiptVerifierV1 = (
  evidence: ActualSessionEvidenceV1,
) => VerifiedRuntimeValuesV1 | null;

/**
 * The real request/runtime receipt producer. It certifies ONLY the acknowledged
 * submitted configuration bound to the exact invocation/thread/turn: expected
 * provider plus the frozen Luna/max model/effort policy, correlated terminal
 * status with its explicit origin and bounded complete routing. Exactly the
 * validated provider/model/effort values are returned; the expected provider is
 * the only trusted provider identity this function accepts. A completed run
 * needs nonempty correlated output items (a command/file-change/agent
 * deliverable — never the notification-byte total) UNLESS the host itself
 * stopped the run (explicit loopStopped disposition), in which case only
 * interrupted/no-candidate accounting is permitted. A host-timeout evidence
 * (null observed status, `host-timeout` origin) stays certifiable for failed
 * accounting without ever claiming an observed terminal. Failed/interrupted
 * runtime evidence is certifiable without output.
 */
export function createRequestRuntimeReceiptVerifier(
  expectedProvider: string,
): ReceiptVerifierV1 {
  return (evidence: ActualSessionEvidenceV1) => {
    if (!isValidProvider(expectedProvider)) return null;
    // Request/thread/turn correlation: exact identities and requested policy.
    if (
      evidence.requestedModel !== REQUIRED_MODEL_ID ||
      evidence.requestedEffort !== REQUIRED_REASONING_EFFORT ||
      evidence.requestedProvider !== expectedProvider ||
      !isBoundedId(evidence.threadId) || !isBoundedId(evidence.turnId) ||
      !isBoundedId(evidence.invocationId)
    ) {
      return null;
    }
    // The thread response must acknowledge exactly the requested configuration.
    if (
      evidence.threadModel !== evidence.requestedModel ||
      evidence.threadEffort !== evidence.requestedEffort ||
      evidence.threadModelProvider !== expectedProvider
    ) {
      return null;
    }
    // Terminal origin must be explicit and consistent: an observed terminal is
    // only certifiable as runtime evidence; a null observed status is only
    // certifiable as a host-timeout (never an observed terminal).
    if (evidence.terminalOrigin === "runtime") {
      if (evidence.terminal.status === null) return null;
    } else if (evidence.terminalOrigin === "host-timeout") {
      if (evidence.terminal.status !== null) return null;
    } else {
      return null;
    }
    // Terminal status: completed runs need nonempty correlated output — unless
    // the host itself stopped the run (loopStopped), where only interrupted/
    // no-candidate accounting is permitted without successful output. A
    // failed/interrupted/host-timeout receipt may lack output and stays
    // certifiable for accounting (it can never authorize a candidate).
    if (
      evidence.terminal.status === "completed" &&
      evidence.resultItems.length === 0 && !evidence.loopStopped
    ) {
      return null;
    }
    // Bounded complete routing: any matching reroute off required Luna fails
    // even if the run was routed back later; well-formed unrelated events are
    // ignored; over-bound or matching malformed events fail closed.
    if (evidence.reroutes.length > MAX_REROUTES) return null;
    for (const reroute of evidence.reroutes) {
      if (
        reroute.threadId !== evidence.threadId ||
        reroute.turnId !== evidence.turnId
      ) {
        continue;
      }
      if (
        !isBoundedId(reroute.from) || !isBoundedId(reroute.to) ||
        reroute.from === reroute.to ||
        reroute.from !== evidence.requestedModel ||
        reroute.to !== evidence.requestedModel ||
        (reroute.reason !== null && !isBoundedId(reroute.reason))
      ) {
        return null;
      }
    }
    return {
      provider: expectedProvider,
      observedModel: evidence.requestedModel,
      observedReasoning: evidence.requestedEffort,
    };
  };
}

/** The default verifier never certifies; nothing is ever synthesized. */
export const unavailableReceiptVerifier: ReceiptVerifierV1 = () => null;

/** Exact existing typed `unavailable` detail for the unverified-receipt boundary. */
const UNAVAILABLE_RECEIPT_DETAIL =
  "model receipt unavailable: actual provider model/effort could not be verified at this boundary";

/** Static fail-closed detail: requested runtime model/effort is not Luna/max. */
const MODEL_POLICY_DETAIL =
  "model receipt unavailable: requested runtime model/effort is not the required Luna/max";

/** Static fail-closed detail: configured provider is not a nonempty finite string. */
const PROVIDER_POLICY_DETAIL =
  "model receipt unavailable: configured provider is not a nonempty finite string";

/** Static fail-closed detail: configured permission profile is not a valid name. */
const PERMISSION_PROFILE_POLICY_DETAIL =
  "model receipt unavailable: configured permission profile is not a valid named profile";

/** Static fail-closed detail: completed run produced no correlated output evidence. */
const OUTPUT_EVIDENCE_DETAIL =
  "model receipt unavailable: completed run has no correlated output evidence";

/** Static fail-closed detail: terminal replay identity is missing/over bound. */
const IDENTITY_POLICY_DETAIL =
  "model receipt unavailable: session identity is missing or over bound";

/** Static fail-closed detail: an additional verifier contradicted the core. */
const RECEIPT_MISMATCH_DETAIL =
  "model receipt mismatch: verifier values differ from the validated request/runtime evidence";

/**
 * Static sanitized accounting error for a host timeout: the host's own bounds
 * elapsed before any runtime terminal evidence, so the receipt is failed
 * ACCOUNTING only — it never claims an observed terminal (the observed status
 * stays null and the terminal origin is `host-timeout`).
 */
const HOST_TIMEOUT_ACCOUNTING_ERROR =
  "host timeout without terminal settlement";

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

/**
 * Trusted host capability that turns a completed model working tree into one
 * candidate commit. The model session itself may be unable to write `.git`
 * metadata under the app-server workspace sandbox; this capability runs after
 * the session has settled, outside that sandbox, and never publishes or edits
 * durable Sentinel state.
 */
export interface CandidateCommitterV1 {
  commit(base: GitSha): Promise<boolean>;
}

/**
 * Local candidate committer for a trusted host. It only commits when HEAD is
 * still the requested base and the model left a non-empty working-tree
 * change. A model-created descendant is accepted for later identity
 * validation; an unrelated or malformed checkout fails closed.
 */
export class LocalCandidateCommitter implements CandidateCommitterV1 {
  constructor(
    private readonly checkoutDir: string,
    private readonly message = "sentinel: autonomous repair candidate",
  ) {}

  async commit(base: GitSha): Promise<boolean> {
    const before = await this.run(["rev-parse", "HEAD"]);
    if (before === null || !/^[0-9a-f]{40}$/.test(before.trim())) {
      return false;
    }
    const beforeSha = before.trim() as GitSha;
    const ancestry = await this.runResult([
      "merge-base",
      "--is-ancestor",
      base,
      beforeSha,
    ]);
    if (ancestry === null || ancestry.code !== 0) return false;

    // The model may have created its own commit when the host permits it.
    // Leave that exact descendant untouched; the resolver will bind it to the
    // requested base and changed paths below.
    if (beforeSha !== base) return true;

    const status = await this.run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status === null || status.length === 0) return false;
    // Unmerged entries cannot be made into a trusted candidate by guessing at
    // conflict resolution. Keep every other path under the host's normal
    // protected-path and review gates.
    const entries = status.split("\0").filter((entry) => entry.length > 0);
    if (
      entries.some((entry) => {
        const x = entry[0] ?? "";
        const y = entry[1] ?? "";
        return x === "U" || y === "U" || (x === "A" && y === "A") ||
          (x === "D" && y === "D");
      })
    ) return false;

    const staged = await this.runResult(["add", "-A", "--", "."]);
    if (staged === null || staged.code !== 0) return false;
    const diff = await this.runResult([
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
    ]);
    if (diff === null || diff.code === 0 || diff.code !== 1) return false;
    const committed = await this.runResult([
      "-c",
      "user.name=Sentinel",
      "-c",
      "user.email=sentinel@localhost",
      "commit",
      "--no-verify",
      "-m",
      this.message,
    ]);
    if (committed === null || committed.code !== 0) return false;
    const after = await this.run(["rev-parse", "HEAD"]);
    if (after === null || !/^[0-9a-f]{40}$/.test(after.trim())) return false;
    return after.trim() !== base;
  }

  private async run(args: string[]): Promise<string | null> {
    const result = await this.runResult(args);
    return result?.code === 0 ? result.stdout : null;
  }

  private async runResult(args: string[]): Promise<
    {
      code: number;
      stdout: string;
    } | null
  > {
    try {
      const result = await new Deno.Command("git", {
        args: ["-C", this.checkoutDir, ...args],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          HOME: this.checkoutDir,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
      };
    } catch {
      return null;
    }
  }
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
      "--no-renames",
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
  /**
   * Trusted host mode for the owner-only local iteration pause. Repository
   * identity is not a mode because hosted repair also operates on Sentinel.
   */
  localIteration?: boolean;
  /** Local checkout identity resolver (injectable for tests). */
  checkout?: CheckoutResolverV1;
  /**
   * Explicit selected provider, e.g. `openai` or a host provider name. A
   * nonempty finite string is REQUIRED before any session opens — including
   * the custom-verifier path: a missing provider stays unavailable and a
   * callback never enables a missing provider. With a selected provider the
   * port always binds the real request/runtime receipt producer for that exact
   * provider, submits the provider explicitly on thread/start, and validates
   * the acknowledged thread provider/model/effort and bounded thread id BEFORE
   * any turn starts.
   */
  modelProvider?: string;
  /**
   * Optional trusted host-defined named permission profile. When present it
   * must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ and is never a built-in
   * full-access id; an invalid value returns static unavailable before any
   * session opens. With a configured profile the port enables the app-server
   * experimental capabilities, submits `permissions` INSTEAD of the legacy
   * `sandbox` on thread/start, and requires the exact
   * `activePermissionProfile.id` acknowledgement BEFORE any turn starts.
   * When omitted the legacy workspace-write sandbox behavior is unchanged.
   */
  permissionProfile?: string;
  /**
   * Trusted-host receipt verifier (kept for tests/host injection); it is only
   * an ADDITIONAL restriction applied AFTER the concrete core request/runtime
   * checks, so it can never bypass correlation, routing or model-policy
   * validation. Without a provider the port stays unavailable regardless.
   */
  receiptVerifier?: ReceiptVerifierV1;
  /** Optional trusted host commit step for sandboxed model checkouts. */
  commitCandidate?: CandidateCommitterV1;
  /** Grace for terminal settlement after an interrupt request. */
  interruptSettlementGraceMs?: number;
}

const DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS = 30_000;

export class CodexImplementationPort implements ImplementationPort {
  private readonly options: CodexImplementationPortOptionsV1;
  /** Core concrete request/runtime producer; ALWAYS the first receipt gate. */
  private readonly coreVerifier: ReceiptVerifierV1;
  /** Optional additional restriction applied only after the core checks. */
  private readonly customVerifier: ReceiptVerifierV1 | null;
  private readonly graceMs: number;
  /** Trusted configured named permission profile; null when omitted. */
  private readonly permissionProfile: string | null;
  /** Whether this session is the explicitly paused owner-local iteration. */
  private readonly localIteration: boolean;

  constructor(options: CodexImplementationPortOptionsV1) {
    this.options = options;
    // The concrete request/runtime receipt producer for the exact selected
    // provider is ALWAYS the core gate (an invalid/missing provider returns
    // unavailable before any session opens, so an empty expected provider is
    // just a never-satisfied gate). A custom verifier can only restrict.
    this.coreVerifier = createRequestRuntimeReceiptVerifier(
      options.modelProvider ?? "",
    );
    this.customVerifier = options.receiptVerifier ?? null;
    this.graceMs = options.interruptSettlementGraceMs ??
      DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS;
    this.permissionProfile = options.permissionProfile ?? null;
    this.localIteration = options.localIteration === true;
  }

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    // Fail-closed model policy validation BEFORE any session or model work:
    // the requested runtime model/effort must be exactly Luna/max.
    if (
      request.model !== REQUIRED_MODEL_ID ||
      request.reasoning !== REQUIRED_REASONING_EFFORT
    ) {
      return portError("unavailable", MODEL_POLICY_DETAIL);
    }
    // An explicit valid modelProvider is REQUIRED before ANY session opens,
    // including the custom-verifier path: a missing provider stays
    // unavailable and a callback never enables a missing provider.
    if (this.options.modelProvider === undefined) {
      return portError("unavailable", UNAVAILABLE_RECEIPT_DETAIL);
    }
    if (!isValidProvider(this.options.modelProvider)) {
      return portError("unavailable", PROVIDER_POLICY_DETAIL);
    }
    // A configured named permission profile must be a valid host-defined name
    // BEFORE any session opens; built-in full-access ids are never permitted.
    if (
      this.permissionProfile !== null &&
      !isValidPermissionProfile(this.permissionProfile)
    ) {
      return portError("unavailable", PERMISSION_PROFILE_POLICY_DETAIL);
    }
    let session: CodexSessionV1 | null = null;
    const invocationId = `codex-${request.taskId}-${Date.now()}`;
    try {
      session = await this.options.openSession();
      // CodexSubprocessSession is intentionally lazy so construction remains
      // side-effect free.  Open it at the exact model boundary; an already
      // opened concrete session is accepted because open() is idempotent.
      session.open?.();
      await this.initialize(session);
      const prompt = buildPrompt(request, this.localIteration);
      const thread = await this.startThread(session, request, prompt);
      const turn = await this.startTurn(
        session,
        request,
        prompt,
        thread.threadId,
      );
      const captureSettlement = await this.awaitSettlement(
        session,
        request,
        thread.threadId,
        turn.turnId,
        request.maxOutputChars,
      );
      // The model must be fully closed, including its owned process group,
      // before the trusted host inspects or commits the checkout. A direct
      // child exit is not proof that a descendant has stopped writing files.
      const ownedSession = session;
      session = null;
      await ownedSession.close();
      if (ownedSession.isSettled !== undefined && !ownedSession.isSettled()) {
        return portError(
          "unavailable",
          "model session process group did not settle",
        );
      }
      // A fatal transport/session error observed before close is static typed
      // unavailable evidence: a verified receipt can never escape a transport
      // that already failed closed. Intentionally closing a healthy session
      // never manufactures one (getFailure stays null after a clean close).
      if (ownedSession.getFailure !== undefined) {
        const failure = ownedSession.getFailure();
        if (failure !== null) {
          return portError("unavailable", failure.detail);
        }
      }
      // Final evidence capture happens ONLY after the session is fully closed
      // and its settlement/transport state is verified: bounded correlated
      // routing notifications delivered during close are still validated into
      // this snapshot, and a later notification can never change the receipt.
      const settled = captureSettlement();
      return await this.finishReceipt(
        request,
        invocationId,
        thread,
        turn.turnId,
        settled,
      );
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
      capabilities: {
        // Experimental app-server capabilities are enabled ONLY for a trusted
        // configured named permission profile; the legacy path stays as is.
        experimentalApi: this.permissionProfile !== null,
        requestAttestation: false,
      },
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
    const startParams: Record<string, unknown> = {
      model: request.model,
      // The thread response is the only app-server model/effort evidence
      // available to this bounded port.  Bind the required runtime effort in
      // the thread config as well as the per-turn override below so the
      // observed thread receipt cannot silently inherit a weaker host default.
      config: { model_reasoning_effort: request.reasoning },
      cwd: this.options.checkoutDir,
      approvalPolicy: "never",
      ephemeral: true,
      baseInstructions: prompt,
      // A valid provider is required before this session opened: submit it
      // explicitly so the thread response can acknowledge the exact provider.
      modelProvider: this.options.modelProvider,
    };
    if (this.permissionProfile !== null) {
      // Trusted named profile: the installed schema forbids combining
      // `permissions` with the legacy `sandbox` field, so the configured
      // profile replaces the sandbox entirely for this thread.
      startParams.permissions = this.permissionProfile;
    } else {
      // Bounded isolated-checkout write capability: the session may write
      // within the secret-free checkout only (the thread cwd is the checkout
      // root); the host approval policy stays "never" and no other sandbox is
      // granted. "read-only" would make the requested commit impossible.
      startParams.sandbox = "workspace-write";
    }
    const response = await session.send("thread/start", startParams);
    const record = requireRecord(response, "thread/start");
    const thread = (record.thread ?? null) as Record<string, unknown> | null;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (threadId === null || !isBoundedId(threadId)) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response missing a nonempty bounded thread id",
      );
    }
    const model = typeof record.model === "string" ? record.model : null;
    const effort = typeof record.reasoningEffort === "string"
      ? record.reasoningEffort
      : null;
    const provider = typeof record.modelProvider === "string"
      ? record.modelProvider
      : null;
    // The thread response MUST acknowledge the exact provider, Luna/max and a
    // nonempty bounded thread id BEFORE any turn starts: a mismatch never
    // spends a model turn.
    if (
      model !== request.model || effort !== request.reasoning ||
      provider !== this.options.modelProvider
    ) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response does not acknowledge the requested provider/model/effort",
      );
    }
    // A configured named profile must be acknowledged exactly BEFORE any turn
    // starts; a missing or wrong acknowledgement fails closed (the session is
    // settled by the caller's owned close path) and no model turn is spent.
    if (this.permissionProfile !== null) {
      const active = record.activePermissionProfile;
      if (
        typeof active !== "object" || active === null ||
        (active as Record<string, unknown>).id !== this.permissionProfile
      ) {
        throw new CodexProtocolError(
          "malformed_line",
          "thread/start response does not acknowledge the configured permission profile",
        );
      }
    }
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
    if (turnId === null || !isBoundedId(turnId)) {
      throw new CodexProtocolError(
        "malformed_line",
        "turn/start response missing a nonempty bounded turn id",
      );
    }
    return { turnId };
  }

  /**
   * Bounded settlement wait. Returns a PRIVATE final-snapshot getter: the
   * settlement promise only signals that the loop guard/turn work has stopped
   * and the bounded drain finished, while the returned getter captures the
   * final routing/terminal evidence at the exact moment the caller has also
   * completed its close/settlement/transport checks. A routing notification
   * delivered during close is therefore still validated into the receipt.
   */
  private async awaitSettlement(
    session: CodexSessionV1,
    request: ModelRunRequestV1,
    threadId: string,
    turnId: string,
    maxOutputChars: number,
  ): Promise<() => AwaitedSettlementV1> {
    let outputChars = 0;
    // Bounded COMPLETE correlated routing events for this exact thread/turn
    // (well-formed events for other threads/turns are ignored at receipt);
    // a malformed or matching off-Luna event fails closed immediately.
    const reroutes: ModelRerouteV1[] = [];
    // Bounded correlated successful output items (command/file-change/agent
    // output) for this exact thread/turn; notification-byte totals are never
    // output proof.
    const resultItems: SessionResultItemV1[] = [];
    let terminal: AwaitedSettlementV1["terminal"] = null;
    // Host-timeout until a runtime terminal is actually observed; a settlement
    // without a runtime terminal is never presented as an observed terminal.
    let terminalOrigin: AwaitedSettlementV1["terminalOrigin"] = "host-timeout";
    // Sticky unavailable-evidence disposition: protocol/routing uncertainty
    // (malformed reroute/terminal identity, off-policy route, registration
    // failure) makes the receipt `unavailable` before ANY verifier/candidate
    // action — it is never certified as a valid failed runtime receipt.
    let unavailable: AwaitedSettlementV1["unavailable"] = null;
    // Evidence-capture finalization: set by the returned getter. Once set, no
    // later notification — including a late correlated reroute — can mutate
    // the captured receipt evidence.
    let evidenceFinalized = false;
    let resolver: (() => void) | null = null;
    const terminalPromise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    const resolveSettlement = () => {
      resolver?.();
    };

    // --- loop-guard observability state. Every field below is initialized
    // BEFORE the notification listener is registered: the terminal listener
    // may fire synchronously from the pre-registration backlog, so a
    // half-built handler must never be reachable.
    let loopStopped = false;
    let interruptRequested = false;
    let generation = 0;
    let steerSent = false;
    let steerAcked = false;
    let guardDisabled = false;
    // Bounded EXACT active command ids: only unique started ids are added and
    // a completion deletes only that exact id, so a completion can never
    // consume an unrelated command's active state (see collectStarted /
    // collectCompleted).
    const activeCommandIds = new Set<string>();
    const seenItemIds = new Set<string>();
    const guard = new FailedCommandLoopGuard(threadId, turnId);
    const jobs: CapturedObservationV1[] = [];
    let draining: Promise<void> | null = null;
    let stopped = false;
    // Private cancellation for a pending steer/settlement wait: resolved by
    // settleNow so a terminal (or any other stop) resolves the pending steer
    // race immediately instead of leaving its default-grace timer (or a hung
    // steer send) alive past settlement.
    let cancelSettlement: (() => void) | null = null;
    const cancelled = new Promise<void>((resolve) => {
      cancelSettlement = resolve;
    });

    const settleNow = () => {
      if (stopped) return;
      stopped = true;
      jobs.length = 0;
      clearTimeout(durationTimer);
      clearTimeout(settleTimer);
      // Cancel the pending steer FIRST: a drain in-flight inside `sendSteer`
      // must not wait (or depend) on the default-grace steer timer once the
      // terminal stop has happened; the race loses to this resolution and the
      // sendSteer continuation observes `stopped` and returns without sending.
      cancelSettlement?.();
      // The settlement signal carries no evidence snapshot: the final
      // snapshot is captured separately by the returned getter AFTER the
      // caller's close/settlement/transport checks, so a routing event
      // delivered during close is still validated and counted.
      if (draining === null) {
        resolveSettlement();
        return;
      }
      // Await the bounded drain after canceling the steer: queued jobs were
      // dropped above, the in-flight job observes `stopped` and performs no
      // side effects, and the checkpoint work is privately bounded, so the
      // wait is finite and no separate cleanup timer can outlive settlement.
      // A rejection never escapes as a dangling rejecting finally chain.
      void draining.catch(() => {}).finally(() => {
        resolveSettlement();
      });
    };

    /**
     * Request a turn interrupt and start the settlement grace NOW: every
     * interrupt path (duration ceiling, output-bound crossing, own loop stop)
     * uses the same immediate grace, so a stopped run never waits for the old
     * duration ceiling. Once the wait is settled, no callback sends anything.
     */
    const requestInterrupt = () => {
      if (stopped || interruptRequested) return;
      interruptRequested = true;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        // Host timeout: no runtime terminal arrived inside the grace. The
        // settlement keeps the null observed terminal and the `host-timeout`
        // origin — the run may retain failed accounting but never pretends it
        // observed a terminal.
        settleNow();
      }, this.graceMs + SETTLE_GRACE_MS_EXTRA);
      try {
        session.send("turn/interrupt", { threadId, turnId }).catch(() => {
          // The interrupt request itself failed; the wait continues to the
          // grace deadline and then settles as a host timeout.
        });
      } catch {
        // A synchronously-throwing session must never escape the receiver.
      }
    };

    /**
     * Early loop stop: the repair loop guard owns the stop, so settlement
     * grace starts NOW (never at the old duration ceiling) and the exact
     * terminal is awaited from this point.
     */
    const earlyLoopInterrupt = () => {
      if (loopStopped || stopped) return;
      loopStopped = true;
      requestInterrupt();
    };

    /**
     * Sticky unavailable-evidence disposition: protocol/routing uncertainty.
     * It latches even AFTER the loop guard stopped (a correlated routing
     * event can arrive during close), preserving the FIRST failure, and only
     * drives the stop path when the run has not stopped yet.
     */
    const failEvidence = (detail: string) => {
      if (evidenceFinalized) return;
      if (unavailable === null) unavailable = { detail };
      if (stopped) return;
      settleNow();
    };

    /**
     * Record one successful correlated output item (bounded, earliest first).
     * Only adequately identified items of the exact thread/turn qualify; an
     * unidentifiable deliverable is never output proof and a completed run
     * then fails closed instead of counting bytes.
     */
    const recordResultItem = (
      item: Record<string, unknown>,
      type: SessionResultItemV1["type"],
    ) => {
      if (resultItems.length >= MAX_RESULT_ITEMS) return;
      const itemId = typeof item.id === "string" && isBoundedId(item.id)
        ? item.id
        : null;
      if (itemId === null) return;
      resultItems.push({ itemId, type });
    };

    /**
     * Correlated routing validation for the EXACT thread/turn. Well-formed
     * events for other threads/turns are ignored; a missing/malformed identity
     * or a matching malformed/off-Luna event sets the sticky unavailable
     * disposition (this routing uncertainty is never certified as a failed
     * runtime receipt). Any matching reroute off the required Luna model
     * rejects the run even when it is routed back later; no route fallback or
     * synthesized identity exists. The bounded complete history is preserved
     * (the well-formed event is recorded) BEFORE the off-policy rejection.
     */
    const collectReroute = (params: unknown) => {
      const record = params as Record<string, unknown> | null;
      const eventThreadId = typeof record?.threadId === "string"
        ? record.threadId
        : null;
      const eventTurnId = typeof record?.turnId === "string"
        ? record.turnId
        : null;
      if (
        eventThreadId === null || eventTurnId === null ||
        !isBoundedId(eventThreadId) || !isBoundedId(eventTurnId)
      ) {
        failEvidence("malformed reroute identity");
        return;
      }
      if (eventThreadId !== threadId || eventTurnId !== turnId) return;
      const from = typeof record?.fromModel === "string"
        ? record.fromModel
        : null;
      const to = typeof record?.toModel === "string" ? record.toModel : null;
      const rawReason = record?.reason;
      const reason = typeof rawReason === "string" ? rawReason : null;
      if (
        from === null || to === null || !isBoundedId(from) ||
        !isBoundedId(to) ||
        (rawReason !== undefined && typeof rawReason !== "string") ||
        (reason !== null && !isBoundedId(reason))
      ) {
        failEvidence("malformed matching reroute");
        return;
      }
      if (reroutes.length >= MAX_REROUTES) {
        failEvidence("reroute evidence exceeded bound");
        return;
      }
      // Preserve the bounded correlated history before rejecting an off-policy
      // route: the well-formed event is recorded, then the rejection is set.
      reroutes.push({ threadId, turnId, from, to, reason });
      if (
        from === to || from !== request.model || to !== request.model
      ) {
        failEvidence("run routed off required Luna/max");
      }
    };

    const collectStarted = (params: unknown) => {
      const record = params as Record<string, unknown> | null;
      if (record?.threadId !== threadId || record?.turnId !== turnId) return;
      const item = record?.item as Record<string, unknown> | null;
      if (item?.type === "fileChange") {
        // Any edit is state progress: the repeated-failure sequence resets
        // even when the committed HEAD did not change (the model is changing
        // files), and pending observations no longer attest their state.
        generation++;
        guard.resetProgress();
        return;
      }
      if (item?.type !== "commandExecution") return;
      if (
        typeof item.id !== "string" || item.id.length === 0 ||
        item.id.length > MAX_ITEM_ID_CHARS
      ) {
        // An unidentifiable start makes active-command bookkeeping
        // untrustworthy: disable the early guard conservatively and reset the
        // sequence; the start is still progress for pending observations.
        guardDisabled = true;
        generation++;
        guard.resetProgress();
        return;
      }
      if (activeCommandIds.has(item.id) || seenItemIds.has(item.id)) {
        // Duplicate start: no state change. An id that already completed
        // (seenItemIds) must never re-enter active bookkeeping as a ghost
        // active command, or pending failure evidence would be invalidated.
        return;
      }
      if (activeCommandIds.size >= MAX_ACTIVE_COMMAND_IDS) {
        // The active-id bound is exceeded: conservatively disable the guard.
        guardDisabled = true;
        generation++;
        guard.resetProgress();
        return;
      }
      activeCommandIds.add(item.id);
      // The start is a progress generation: any observation still pending
      // when this start was received is invalid (see observeWork below).
      generation++;
    };

    const captureCompleted = (
      item: Record<string, unknown>,
      itemId: string,
      receivedOthersActive: boolean,
    ): CapturedObservationV1 => {
      const rawCommand = typeof item.command === "string" ? item.command : null;
      const rawCwd = typeof item.cwd === "string" ? item.cwd : null;
      const rawOutput = typeof item.aggregatedOutput === "string"
        ? item.aggregatedOutput
        : null;
      return {
        receivedGeneration: generation,
        receivedSteerAcked: steerAcked,
        receivedOthersActive,
        itemId,
        command: rawCommand !== null && rawCommand.length <= MAX_COMMAND_CHARS
          ? rawCommand
          : null,
        cwd: rawCwd !== null && rawCwd.length <= MAX_CWD_CHARS ? rawCwd : null,
        status: typeof item.status === "string" ? item.status : null,
        output: rawOutput !== null && rawOutput.length <= MAX_OUTPUT_CHARS
          ? rawOutput
          : null,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      };
    };

    const collectCompleted = (params: unknown) => {
      const record = params as Record<string, unknown> | null;
      // Normalize exact completed items for this thread/turn only; events for
      // other threads/turns are stale and ignored (never a sequence break).
      if (record?.threadId !== threadId || record?.turnId !== turnId) return;
      const item = record?.item as Record<string, unknown> | null;
      if (item?.type === "fileChange") {
        // Any edit is state progress (the repeated-failure sequence resets);
        // only a COMPLETED file change with a nonempty valid changes array
        // (required path/kind/diff fields per the installed ThreadItem schema)
        // is genuine successful output — failed/declined/missing-status/empty-
        // or-malformed changes can never prove output.
        generation++;
        guard.resetProgress();
        if (hasValidCompletedChanges(item)) {
          recordResultItem(item, "fileChange");
        }
        return;
      }
      if (item?.type === "agentMessage") {
        // Only the supported nonblank bounded `text` field is genuine output
        // evidence; the unsupported `content` fallback was removed and
        // anything missing/blank/over-bound is never recorded as proof.
        const text = typeof item.text === "string" ? item.text : null;
        if (
          text !== null && text.trim().length > 0 &&
          text.length <= MAX_OUTPUT_CHARS
        ) {
          recordResultItem(item, "agentMessage");
        }
        return;
      }
      if (item?.type !== "commandExecution") return;
      // Only a schema-valid successful command proves output: status
      // completed, exit code 0, nonempty bounded command/cwd and a bounded
      // schema-valid commandActions array (empty supported). The failed-
      // command-loop classification below is untouched by this proof gate.
      if (hasValidCommandExecution(item)) {
        recordResultItem(item, "commandExecution");
      }
      let itemId: string | null = null;
      if (
        typeof item.id === "string" && item.id.length > 0 &&
        item.id.length <= MAX_ITEM_ID_CHARS
      ) {
        itemId = item.id;
      }
      if (itemId === null) {
        // A completion without an exact bounded id cannot be attributed or
        // deduplicated: it never becomes an observation (no empty-string item
        // id through the helper) — reset the sequence directly and discard it.
        guard.resetProgress();
        return;
      }
      // Dedup before any async work or active-state change; a duplicate
      // stream delivery of an already-observed item is ignored (same evidence,
      // never re-counted).
      if (seenItemIds.has(itemId)) return;
      if (seenItemIds.size >= MAX_UNIQUE_ITEM_IDS) {
        guardDisabled = true;
        guard.resetProgress();
        return;
      }
      seenItemIds.add(itemId);
      // Delete only this exact id from the active set (never decrement a
      // count for an unrelated completion); what remains are the OTHER
      // commands still active at receipt, captured before any async work.
      activeCommandIds.delete(itemId);
      const job = captureCompleted(item, itemId, activeCommandIds.size > 0);
      enqueue(job);
    };

    const enqueue = (job: CapturedObservationV1) => {
      if (stopped) return;
      if (jobs.length >= MAX_PENDING_OBSERVATIONS) {
        // Bounded queue overflow: the guard is disabled (stale evidence), the
        // accumulated sequence is conservatively reset, and the overflow item
        // is dropped.
        guardDisabled = true;
        guard.resetProgress();
        return;
      }
      jobs.push(job);
      if (draining === null) {
        draining = drain().catch(() => {}).finally(() => {
          draining = null;
        });
      }
    };

    const drain = async () => {
      while (!stopped) {
        const job = jobs.shift();
        if (job === undefined) break;
        await handleWork(job);
      }
    };

    const handleWork = async (job: CapturedObservationV1) => {
      if (stopped || guardDisabled || interruptRequested) return;
      await observeWork(job);
    };

    const observeWork = async (job: CapturedObservationV1) => {
      // Receipt-time capture: an observation that was received while another
      // command was active, before the steer acknowledgement, or that somehow
      // aged in the bounded queue is uncertain — never counted, conservatively
      // reset instead of turning it into post-ack or concurrent evidence.
      if (
        job.receivedOthersActive ||
        job.receivedGeneration !== generation ||
        job.receivedSteerAcked !== steerAcked
      ) {
        guard.resetProgress();
        return;
      }
      const normalized = await normalizeObservation(
        job,
        this.options.checkoutDir,
      );
      if (stopped || interruptRequested || guardDisabled) return;
      // A new command start or edit during the pending checkpoint/hash work
      // invalidates this observation (its checkpoint no longer attests the
      // state the failure ran in) and resets the repeated sequence; a
      // serial start after this observation fully settles is preserved.
      if (
        job.receivedOthersActive ||
        activeCommandIds.size > 0 ||
        job.receivedGeneration !== generation ||
        job.receivedSteerAcked !== steerAcked
      ) {
        guard.resetProgress();
        return;
      }
      const observation = normalized.inconclusive
        ? inconclusiveObservation(threadId, turnId, job)
        : {
          threadId,
          turnId,
          itemId: job.itemId,
          command: normalized.command!,
          cwd: normalized.cwd!,
          exitCode: normalized.exitCode!,
          outputDigest: normalized.outputDigest!,
          checkpoint: normalized.checkpoint!,
          conclusiveFailure: true,
        };
      const result = await guard.observe(observation);
      if (stopped || interruptRequested || guardDisabled) return;
      // Recheck generation/active/ack state AFTER the observe await as well:
      // a stale result must never fire a steer/interrupt.
      if (
        job.receivedOthersActive ||
        activeCommandIds.size > 0 ||
        job.receivedGeneration !== generation ||
        job.receivedSteerAcked !== steerAcked
      ) {
        guard.resetProgress();
        return;
      }
      if (result.kind === "steer") {
        await sendSteer(result.evidenceDigest);
      } else if (result.kind === "interrupt") {
        earlyLoopInterrupt();
      }
    };

    const sendSteer = async (evidenceDigest: string) => {
      if (steerSent) return;
      steerSent = true;
      // Private bounded wait for the acknowledgement: one bounded race inside
      // the existing duration/grace bounds. No replacement turn, session or
      // admission authority; awaiting this can never become unbounded.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("steer acknowledgement timeout")),
          this.graceMs + SETTLE_GRACE_MS_EXTRA,
        );
      });
      try {
        const response = await Promise.race([
          session.send("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: [{
              type: "text",
              text: `${STEER_TEXT}\n[Sanitized evidence: ${evidenceDigest}]`,
              text_elements: [],
            }],
          }),
          bound,
          // A terminal (or any other stop) resolves this race immediately:
          // the default-grace steer timer is cleared in finally and no late
          // response processing can create a request after settlement.
          cancelled,
        ]);
        // Late resolution after a stop/interrupt must not mark anything.
        if (stopped || loopStopped) return;
        const record = response as Record<string, unknown> | null;
        // Acknowledged only by an exact returned turn id for THIS same turn;
        // malformed/rejected/unsupported/unavailable -> interrupt, and the
        // single steer is never retried. The ack state flips at this exact
        // boundary, so pre-ack jobs (captured with their false flag) are
        // discarded/reset by the recheck instead of counting as post-ack.
        if (typeof record?.turnId !== "string" || record.turnId !== turnId) {
          earlyLoopInterrupt();
          return;
        }
        steerAcked = true;
        guard.markSteered();
      } catch {
        if (stopped || loopStopped) return;
        earlyLoopInterrupt();
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    };

    const handleTerminal = (params: unknown) => {
      const record = params as Record<string, unknown> | null;
      // Identity validation happens BEFORE the stale comparison: a nonempty
      // bounded thread id and turn id are required for a successful or
      // interrupted settlement. A missing/nonobject turn (or missing,
      // empty/over-bound thread or turn identity) sets the sticky unavailable
      // disposition (protocol uncertainty is never certified as a failed
      // runtime receipt); valid bounded unrelated identities are ignored.
      const eventThreadId = typeof record?.threadId === "string"
        ? record.threadId
        : null;
      if (eventThreadId === null || !isBoundedId(eventThreadId)) {
        failEvidence("malformed terminal thread id");
        return;
      }
      const turn = record?.turn;
      if (typeof turn !== "object" || turn === null) {
        failEvidence("malformed terminal turn");
        return;
      }
      const turnRecord = turn as Record<string, unknown>;
      const eventTurnId = typeof turnRecord.id === "string"
        ? turnRecord.id
        : null;
      if (eventTurnId === null || !isBoundedId(eventTurnId)) {
        failEvidence("malformed terminal turn id");
        return;
      }
      if (eventThreadId !== threadId || eventTurnId !== turnId) return;
      const status = turnRecord.status;
      if (
        status !== "completed" && status !== "interrupted" &&
        status !== "failed"
      ) {
        failEvidence("malformed terminal turn status");
        return;
      }
      const turnError = (turnRecord.error ?? null) as
        | Record<string, unknown>
        | null;
      const error = typeof turnError?.message === "string"
        ? turnError.message.slice(0, 300)
        : null;
      terminal = {
        status,
        error,
        durationMs: typeof turnRecord.durationMs === "number"
          ? turnRecord.durationMs
          : null,
      };
      // An actual runtime terminal was observed for the exact thread/turn.
      terminalOrigin = "runtime";
      settleNow();
    };

    const onEvent = (method: string, params: unknown) => {
      // Once the final evidence is captured nothing can change the receipt.
      if (evidenceFinalized) return;
      if (stopped) {
        // Post-terminal/stop: the loop guard and every turn/output/job path
        // stay stopped. ONLY bounded correlated routing evidence remains
        // live, because a reroute can be emitted during close after the
        // terminal; it uses the same identity/bound/off-policy validation and
        // still counts toward routing output.
        if (method === "model/rerouted") {
          outputChars += JSON.stringify(params ?? {}).length;
          if (outputChars > maxOutputChars) {
            failEvidence("routing evidence exceeded output bound");
            return;
          }
          collectReroute(params);
        }
        return;
      }
      // Bounded output accounting FIRST: every nonterminal event contributes
      // to the total (malformed, over-bound and unknown events included) and
      // crossing the bound interrupts the turn — no event bypasses the total
      // through an event-specific early return.
      outputChars += JSON.stringify(params ?? {}).length;
      if (method !== "turn/completed" && outputChars > maxOutputChars) {
        requestInterrupt();
      }
      if (method === "item/started") {
        collectStarted(params);
        return;
      }
      if (method === "item/completed") {
        collectCompleted(params);
        return;
      }
      if (method === "turn/completed") {
        handleTerminal(params);
        return;
      }
      if (method === "model/rerouted") {
        // Bounded complete correlated routing validation; the port alone
        // decides reroute policy, never the injected verifier.
        collectReroute(params);
        return;
      }
      // Unknown methods were counted above; nothing else is inferred.
    };

    // Timers are armed before the listener registers so a synchronous
    // terminal at registration still observes fully initialized state. Every
    // interrupt path re-arms the settlement grace immediately
    // (see requestInterrupt), so the initial arm is only the fully initialized
    // placeholder never observed by a live interrupt.
    const durationTimer = setTimeout(requestInterrupt, request.maxDurationMs);
    let settleTimer: ReturnType<typeof setTimeout>;
    settleTimer = setTimeout(() => {
      // Final host timeout: no runtime terminal was ever observed, so the
      // settlement keeps the null observed terminal and the `host-timeout`
      // origin — never a synthesized failed terminal.
      settleNow();
    }, request.maxDurationMs + this.graceMs + SETTLE_GRACE_MS_EXTRA);

    try {
      session.onNotification((event) => onEvent(event.method, event.params));
    } catch {
      // Registration is part of the bounded session lifecycle. If a trusted
      // transport rejects it synchronously, settle through the same path as
      // every other protocol failure so both timers are cleared immediately;
      // a registration failure is protocol uncertainty and sets the sticky
      // unavailable disposition (never a certifiable failed receipt).
      failEvidence("notification registration failed");
    }

    await terminalPromise;
    clearTimeout(durationTimer);
    clearTimeout(settleTimer);
    // Private final-snapshot getter: cloned arrays plus the CURRENT terminal
    // and sticky unavailable values, captured only after the caller closed
    // and verified the session. It finalizes evidence capture so a later
    // notification can never change the returned receipt.
    return () => {
      evidenceFinalized = true;
      return {
        terminal,
        terminalOrigin,
        unavailable,
        outputChars,
        reroutes: [...reroutes],
        resultItems: [...resultItems],
        loopStopped,
      };
    };
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
    turnId: string,
    settled: AwaitedSettlementV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    // Sticky unavailable-evidence disposition FIRST: protocol/routing
    // uncertainty (malformed reroute/terminal identity, off-policy route,
    // registration failure) returns unavailable before ANY verifier or
    // candidate action — it is never certified as a failed runtime receipt.
    if (settled.unavailable !== null) {
      return portError("unavailable", settled.unavailable.detail);
    }
    const evidence: ActualSessionEvidenceV1 = {
      invocationId,
      requestedModel: request.model,
      requestedProvider: this.options.modelProvider ?? null,
      requestedEffort: request.reasoning,
      threadId: thread.threadId,
      turnId,
      threadModel: thread.model,
      threadModelProvider: thread.provider,
      threadEffort: thread.effort,
      reroutes: settled.reroutes,
      terminal: {
        // Observed runtime terminal status; null means a host timeout, which
        // never pretends a terminal was observed.
        status: settled.terminal?.status ?? null,
        error: settled.terminal?.error ?? null,
        durationMs: settled.terminal?.durationMs ?? null,
      },
      terminalOrigin: settled.terminalOrigin,
      loopStopped: settled.loopStopped,
      resultItems: settled.resultItems,
      outputChars: settled.outputChars,
    };
    // Port-side correlation and output-evidence validation: it runs for EVERY
    // verifier (including a permissive injected one), so no custom callback
    // can bypass exact-identity/routing/model-policy checks.
    if (
      !isBoundedId(evidence.threadId) || !isBoundedId(evidence.turnId) ||
      !isBoundedId(evidence.invocationId)
    ) {
      return portError("unavailable", IDENTITY_POLICY_DETAIL);
    }
    if (
      settled.terminal?.status === "completed" && !settled.loopStopped &&
      settled.resultItems.length === 0
    ) {
      return portError("unavailable", OUTPUT_EVIDENCE_DETAIL);
    }
    // The concrete core request/runtime checks ALWAYS run first: correlation,
    // thread acknowledgment, routing and output evidence are port duties and
    // cannot be bypassed by a permissive injected verifier.
    const verified = this.coreVerifier(evidence);
    if (verified === null) {
      return portError("unavailable", UNAVAILABLE_RECEIPT_DETAIL);
    }
    // A custom verifier is only an ADDITIONAL restriction applied after the
    // core checks; it can never bypass and its returned values must agree
    // with the core validation.
    if (this.customVerifier !== null) {
      const custom = this.customVerifier(evidence);
      if (
        custom === null ||
        custom.provider !== verified.provider ||
        custom.observedModel !== verified.observedModel ||
        custom.observedReasoning !== verified.observedReasoning
      ) {
        return portError("unavailable", RECEIPT_MISMATCH_DETAIL);
      }
    }
    if (settled.terminal?.status === "completed" && !settled.loopStopped) {
      if (this.options.commitCandidate !== undefined) {
        const committed = await this.options.commitCandidate.commit(
          request.base,
        );
        if (!committed) {
          return portError(
            "unavailable",
            "candidate checkout could not be committed",
          );
        }
      }
    }
    const checkout = this.options.checkout ?? new LocalCheckoutResolver(
      this.options.checkoutDir,
      request.base,
    );
    const resolved = settled.terminal?.status === "completed" &&
        !settled.loopStopped
      ? await checkout.resolve()
      : null;
    const candidate: CandidateOutcomeV1 | null = resolved !== null &&
        resolved.head !== null && resolved.head !== request.base &&
        resolved.changedPaths.length > 0
      ? {
        head: resolved.head,
        checkpointSha: resolved.checkpointSha,
        changedPaths: resolved.changedPaths,
      }
      : null;
    const actual = this.buildActual(thread.threadId, turnId, settled, verified);
    if (settled.loopStopped) {
      // Own early loop stop: the model/session did not fail as an application
      // defect and no candidate may be produced — even if a completed runtime
      // terminal races the interrupt, the completed terminal is preserved in
      // the evidence but only interrupted/no-candidate accounting is
      // permitted without successful output. The receipt carries only the
      // sanitized marker.
      return portOk({
        invocationId,
        outcome: settled.terminal?.status === "failed"
          ? "failed"
          : "interrupted",
        actual,
        candidate: null,
        error: LOOP_STOP_MARKER,
      });
    }
    if (settled.terminal === null) {
      // HOST timeout: the host's own bounds elapsed without any runtime
      // terminal. The run may retain failed ACCOUNTING with the explicit
      // `host-timeout` origin and the exact invocation/thread/turn identities,
      // but it never pretends a terminal was observed (observed status null).
      return portOk({
        invocationId,
        outcome: "failed",
        actual,
        candidate: null,
        error: HOST_TIMEOUT_ACCOUNTING_ERROR,
      });
    }
    if (settled.terminal.status !== "completed") {
      return portOk({
        invocationId,
        outcome: settled.terminal.status === "interrupted"
          ? "interrupted"
          : "failed",
        actual,
        candidate: null,
        error: settled.terminal.error ?? null,
      });
    }
    return portOk({
      invocationId,
      outcome: "completed",
      actual,
      candidate,
      error: null,
    });
  }

  /** Identity-bound `actual` block: exact session identities copied from the port state. */
  private buildActual(
    threadId: string,
    turnId: string,
    settled: AwaitedSettlementV1,
    verified: VerifiedRuntimeValuesV1,
  ): ModelRunReceiptV1["actual"] {
    return {
      evidenceKind: "request-runtime",
      provider: verified.provider,
      threadId,
      turnId,
      terminalOrigin: settled.terminalOrigin,
      observedTerminalStatus: settled.terminal?.status ?? null,
      observedModel: verified.observedModel,
      observedReasoning: verified.observedReasoning,
      durationMs: settled.terminal?.durationMs ?? 0,
      outputChars: settled.outputChars,
    };
  }
}

interface AwaitedSettlementV1 {
  /** Observed runtime terminal; null when the host's own bounds elapsed first. */
  terminal: {
    status: "completed" | "interrupted" | "failed";
    error: string | null;
    durationMs: number | null;
  } | null;
  /** Terminal evidence origin: runtime observation vs host timeout. */
  terminalOrigin: "runtime" | "host-timeout";
  /**
   * Sticky unavailable-evidence disposition: protocol/routing uncertainty
   * makes the receipt `unavailable` before any verifier/candidate action.
   */
  unavailable: { detail: string } | null;
  outputChars: number;
  /** Bounded complete correlated routing events for the exact thread/turn. */
  reroutes: ModelRerouteV1[];
  /** Bounded correlated successful output items for the exact thread/turn. */
  resultItems: SessionResultItemV1[];
  /** Own failed-command loop stop: early interrupt already decided. */
  loopStopped: boolean;
}

/** Bounded capture of one completed command item, taken at receipt time. */
interface CapturedObservationV1 {
  /** Progress generation at receipt (starts and edits advance it). */
  receivedGeneration: number;
  /** Steering-ack state at receipt; async work must not relabel pre-ack items. */
  receivedSteerAcked: boolean;
  /** Other commands were still active at receipt; the item is never counted. */
  receivedOthersActive: boolean;
  /** Exact bounded item id; unidentifiable completions are discarded at receipt. */
  itemId: string;
  command: string | null;
  cwd: string | null;
  status: string | null;
  output: string | null;
  exitCode: number | null;
}

interface NormalizedObservationV1 {
  inconclusive: boolean;
  command: string | null;
  cwd: string | null;
  exitCode: number | null;
  outputDigest: string | null;
  checkpoint: string | null;
}

type CommandClassV1 =
  | "deno_check"
  | "deno_lint"
  | "deno_test"
  | "rg_grep"
  | "unknown";

/** Deno diagnostic line: `error: ...` or `error (rule): ...` / `error[rule]: ...`. */
const DIAGNOSTIC_LINE = /^\s*error(?:\s*\([^)\n]*\)|\[[^\]\n]*\])?\s*:/m;

/** A literal single-quoted `/bin/bash -lc` or `/bin/zsh -lc` command wrapper. */
const LITERAL_WRAPPER = /^\/bin\/(?:bash|zsh) -lc '([^']*)'$/;

/** One simple-command token: a literal word or a balanced double-quoted word. */
const LITERAL_TOKEN_SRC = "[A-Za-z0-9_.,@%+=:/\\-]+";
const QUOTED_TOKEN_SRC = '"[^"\\r\\n\\\\$`]+"';

/**
 * Conservative full-string simple-command syntax applied to BOTH bare commands
 * and literal wrapped commands: only literal (or balanced double-quoted) words
 * with no substitutions, operators, pipeline/compound syntax, escape
 * sequences or unbalanced quoting can classify as a deno check/lint command.
 */
const SIMPLE_COMMAND = new RegExp(
  `^(?:${LITERAL_TOKEN_SRC}|${QUOTED_TOKEN_SRC})` +
    `(?: +(?:${LITERAL_TOKEN_SRC}|${QUOTED_TOKEN_SRC}))*$`,
);

function classifyCommand(rawCommand: string): CommandClassV1 {
  const wrapper = LITERAL_WRAPPER.exec(rawCommand);
  const inner = wrapper !== null ? wrapper[1] : rawCommand;
  if (!SIMPLE_COMMAND.test(inner)) return "unknown";
  const tokens = tokenizeCommand(inner);
  if (tokens.length === 0) return "unknown";
  if (tokens[0] === "deno") {
    switch (tokens[1]) {
      case "check":
        return "deno_check";
      case "lint":
        return "deno_lint";
      case "test":
        return "deno_test";
      default:
        return "unknown";
    }
  }
  if (tokens[0] === "rg" || tokens[0] === "grep") {
    return "rg_grep";
  }
  return "unknown";
}

/** Simple token split that keeps double-quoted arguments as one token. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of command.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (ch === " " && !quoted) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function hasRealDiagnostics(output: string): boolean {
  return DIAGNOSTIC_LINE.test(output);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Normalize one completed command observation for the EXACT thread/turn.
 * Returns an inconclusive record when any metadata is missing, over-bound,
 * untrusted (symlink/outside/absent cwd), unknown-command or otherwise not a
 * certified repeated failure; such evidence breaks the repeated sequence and
 * is never counted. Only potentially conclusive failure commands are hashed
 * against a trusted checkout-content checkpoint (never a truncated output).
 */
async function normalizeObservation(
  job: CapturedObservationV1,
  checkoutDir: string,
): Promise<NormalizedObservationV1> {
  const inconclusive = (): NormalizedObservationV1 => ({
    inconclusive: true,
    command: null,
    cwd: null,
    exitCode: null,
    outputDigest: null,
    checkpoint: null,
  });
  if (
    job.command === null || job.cwd === null || job.status === null ||
    job.output === null || job.exitCode === null ||
    !Number.isInteger(job.exitCode)
  ) {
    return inconclusive();
  }
  // Declined and non-terminal statuses are not completed failures.
  if (job.status !== "completed" && job.status !== "failed") {
    return inconclusive();
  }
  const classification = classifyCommand(job.command);
  if (
    classification !== "deno_check" && classification !== "deno_lint"
  ) {
    // Unknown commands, successful reads, rg/grep no-match and deno
    // test/replay (expected baseline phases unknown) are inconclusive.
    return inconclusive();
  }
  if (job.exitCode === 0) return inconclusive();
  if (!hasRealDiagnostics(job.output)) return inconclusive();

  const cwd = await normalizedCheckoutCwd(job.cwd, checkoutDir);
  if (cwd === null) return inconclusive();
  // Hash the FULL bounded output only; a larger or missing output stays
  // inconclusive and is never hashed truncated.
  const outputDigest = await sha256Hex(job.output);
  const checkpoint = await checkoutContentCheckpoint(checkoutDir);
  if (checkpoint === null) return inconclusive();
  return {
    inconclusive: false,
    command: job.command,
    cwd,
    exitCode: job.exitCode,
    outputDigest,
    checkpoint,
  };
}

/**
 * Resolve cwd to inside the real checkout. The raw absolute normalized path
 * must equal its own real path (a symlink alias is rejected, never accepted
 * as an uncertain path identity), and that real path must stay inside the
 * checkout root normalized to its real path; outside/alias/absent is null.
 */
async function normalizedCheckoutCwd(
  cwd: string,
  checkoutDir: string,
): Promise<string | null> {
  try {
    const raw = normalizeAbsolutePath(cwd);
    if (raw === null) return null;
    const real = await Deno.realPath(raw);
    const root = await Deno.realPath(checkoutDir);
    if (real !== root && !real.startsWith(`${root}/`)) return null;
    if (raw !== real) return null;
    return real === root ? "." : real.slice(root.length + 1);
  } catch {
    return null;
  }
}

/** Collapse `.`/`..` of an absolute path without resolving symlinks. */
function normalizeAbsolutePath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

/** Inconclusive guard observation: breaks the sequence, never counts. */
function inconclusiveObservation(
  threadId: string,
  turnId: string,
  job: CapturedObservationV1,
): FailedCommandObservation {
  return {
    threadId,
    turnId,
    itemId: job.itemId ?? "",
    command: job.command ?? "",
    cwd: "",
    exitCode: 0,
    outputDigest: "",
    checkpoint: "",
    conclusiveFailure: false,
  };
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

function buildPrompt(
  request: ModelRunRequestV1,
  localIteration: boolean,
): string {
  const parts: string[] = [
    `Repository: ${request.repository.owner}/${request.repository.name}`,
    `Base revision: ${request.base}`,
  ];
  if (localIteration) {
    parts.push(
      "Owner instruction for this local iteration: do not create, modify or run tests; do not request or run reviews. This supersedes older issue or repository instructions requiring tests or reviews for this pass. Implement only the smallest source fix in the current checkout, keep the candidate local, and report the files changed and observed behavior.",
    );
  }
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
    "Runtime implementer role: you are the bounded runtime implementer for " +
      "this task. Edit only the current provided checkout, and only the files " +
      "needed to resolve the problem. Do not run git add, git commit or git " +
      "push, do not create or use worktrees, and do not delegate to other " +
      "agents or subagents: the trusted host owns commits, pushes, review and " +
      "release. Follow the applicable repository instructions for this " +
      "checkout, but do not take over master-plan orchestration or change " +
      "admission, budget, credential or model policy. The runtime model " +
      `policy is fixed at ${request.model} with ${request.reasoning} ` +
      "reasoning; do not change it or introduce a fallback. Do not modify " +
      "protected paths, do not write or commit credentials, and do not " +
      "rewrite expected test assertions to force success. Keep the change " +
      "minimal and do not refactor beyond it. Your total event output " +
      `allowance is ${request.maxOutputChars} characters, and every tool ` +
      "notification counts against it; repeated full output is charged " +
      "again. Keep every command's max_output_tokens at or below 2000 and " +
      "keep individual command output bounded: prefer targeted symbol " +
      "searches followed by excerpts of at most 100 lines. Read the " +
      "applicable instructions only once, never repeat a full file read, " +
      "and check the actual failure instead of retrying the same failing " +
      "command unchanged. Stop broad source surveying once the target " +
      "behavior is understood and make the smallest edit; reserve most of " +
      "the allowance for implementation and focused validation of observed " +
      "runtime behavior." +
      (localIteration
        ? " No tests or reviews are allowed in this local pass."
        : FOCUSED_TESTS_ALLOWED) +
      " Never dump docs/build-status.md in full; inspect only the " +
      "current checkpoint or bounded matching sections. Finish with a " +
      "concise final response listing the files changed and the checks " +
      "run.",
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
