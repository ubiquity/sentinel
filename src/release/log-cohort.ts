/**
 * Deno log cohort parsing and classification.
 *
 * The Deno logs resource returns entries `{ timestamp, level, message,
 * revision_id }`. The gateway (frozen target snapshot) emits two structured
 * events for its request cohort:
 *
 *   [ai.ubq.fi] request_accepted {"request_id": "...", "route": "...",
 *                                 "git_sha": "...", "deno_revision": "..."}
 *   [ai.ubq.fi] request_terminal {..., "status": 200,
 *                                 "delivery_outcome": "delivered",
 *                                 "stream": ..., "stream_terminal_type": ...,
 *                                 "failure_kind": ..., "git_sha": ...,
 *                                 "deno_revision": ...}
 *
 * Accepted events are the request denominator; terminal events carry the
 * failure classification. Both must carry the EXACT deployment identity the
 * sample is bound to — an entry under any other Git SHA or Deno revision is
 * not this release's evidence and makes the source scan incomplete.
 *
 * Only sanitized aggregates are produced: request counts and classification
 * counts. Raw log messages, request IDs and payloads never enter state.
 */
import { DENO_MAX_LOG_MESSAGE_CHARS } from "./config.ts";

export interface CohortKindsV1 {
  /** `failure_kind` values classified as timeouts (owner rule). */
  timeoutFailureKinds: readonly string[];
  /** `failure_kind` values classified as upstream-wide faults (owner rule). */
  upstreamWideFailureKinds: readonly string[];
}

export interface CohortAcceptedV1 {
  requestId: string;
  route: string;
  gitSha: string;
  revisionId: string;
}

export interface CohortTerminalV1 {
  requestId: string;
  route: string;
  status: number;
  deliveryOutcome: string;
  stream: boolean | null;
  streamTerminalType: string | null;
  failureKind: string | null;
  gitSha: string;
  revisionId: string;
}

export type CohortParseV1 =
  | { kind: "ignored" }
  | { kind: "unreadable" }
  | { kind: "accepted"; event: CohortAcceptedV1 }
  | { kind: "terminal"; event: CohortTerminalV1 };

/**
 * One log entry's message, parsed against the exact gateway event format.
 * Messages outside the sentinel event namespace are ignored (other app
 * logging); a sentinel-namespaced message that is malformed, carries a
 * non-string/bounded-invalid field, or was produced under a different
 * deployment identity is unreadable — it makes the producing scan incomplete,
 * never a silent drop.
 */
export function parseCohortMessage(
  message: string,
  identity: { gitSha: string; revisionId: string },
): CohortParseV1 {
  if (message.length > DENO_MAX_LOG_MESSAGE_CHARS) {
    return { kind: "unreadable" };
  }
  if (!message.startsWith("[ai.ubq.fi] ")) return { kind: "ignored" };
  const rest = message.slice("[ai.ubq.fi] ".length);
  const space = rest.indexOf(" ");
  if (space <= 0) return { kind: "unreadable" };
  const eventName = rest.slice(0, space);
  const payloadText = rest.slice(space + 1).trim();
  if (payloadText.length === 0) return { kind: "unreadable" };

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { kind: "unreadable" };
  }
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload)
  ) {
    return { kind: "unreadable" };
  }
  const obj = payload as Record<string, unknown>;

  const requestId = expectBoundedString(obj.request_id, 256);
  const route = expectBoundedString(obj.route, 256);
  const gitSha = expectGitSha(obj.git_sha);
  const revisionId = expectBoundedString(obj.deno_revision, 256);
  if (
    requestId === null || route === null || gitSha === null ||
    revisionId === null
  ) {
    return { kind: "unreadable" };
  }
  if (gitSha !== identity.gitSha || revisionId !== identity.revisionId) {
    // Evidence under a different deployment identity is not this release's
    // evidence; it makes the scan incomplete rather than being counted.
    return { kind: "unreadable" };
  }

  if (eventName === "request_accepted") {
    return {
      kind: "accepted",
      event: { requestId, route, gitSha, revisionId },
    };
  }
  if (eventName === "request_terminal") {
    const status = expectHttpStatus(obj.status);
    const deliveryOutcome = expectBoundedString(obj.delivery_outcome, 64);
    const stream = expectNullableBoolean(obj.stream);
    const streamTerminalType = expectNullableBoundedString(
      obj.stream_terminal_type,
      64,
    );
    const failureKind = expectNullableBoundedString(obj.failure_kind, 64);
    if (
      status === null || deliveryOutcome === null ||
      stream.status === "invalid" || streamTerminalType.status === "invalid" ||
      failureKind.status === "invalid"
    ) {
      return { kind: "unreadable" };
    }
    return {
      kind: "terminal",
      event: {
        requestId,
        route,
        status,
        deliveryOutcome,
        stream: stream.status === "null" ? null : stream.value,
        streamTerminalType: streamTerminalType.status === "null"
          ? null
          : streamTerminalType.value,
        failureKind: failureKind.status === "null" ? null : failureKind.value,
        gitSha,
        revisionId,
      },
    };
  }
  return { kind: "unreadable" };
}

export interface CohortCountsV1 {
  /** Distinct accepted request ids (the denominator). */
  acceptedCount: number;
  /** Terminal events with HTTP status >= 500. */
  fiveXxCount: number;
  /** Terminal events classified as timeouts by the owner rule. */
  timeoutCount: number;
  /** Terminal events with a stream read error. */
  streamFailureCount: number;
  /** Terminal events classified as upstream-wide by the owner rule. */
  upstreamWideCount: number;
  /** Entries consumed that could not be classified as evidence. */
  unreadableCount: number;
  /**
   * Distinct terminal request ids without an accepted event in this scan.
   * These outcomes may belong to a different sampling window, so the caller
   * must treat the sample as incomplete instead of dropping the outcome.
   */
  unresolvedOutcomeCount: number;
}

/**
 * Aggregates a scan's events into sanitized counts. Accepted events are
 * deduplicated by request id (log re-delivery is not a second request);
 * terminals are deduplicated per request id per classification.
 *
 * The failure classifications are joined to THE SAME request cohort that
 * provides the denominator: only a request whose accepted event was observed
 * in this scan may contribute a failure classification. A terminal without a
 * matching accepted event may belong to another window's cohort (its request
 * was accepted earlier) or may have missing accepted-event evidence. It is
 * therefore excluded from both the denominator and failure counts, and the
 * unresolved outcome is reported so the caller marks the scan incomplete.
 * This preserves the failure as an explicit evidence gap rather than silently
 * allowing it to disappear across sampling windows or emitting inconsistent
 * metrics such as `requestCount: 0, fiveXxCount: 1`.
 *
 * Classification follows the owner-configured rules only:
 * - five_xx:     terminal HTTP status >= 500
 * - timeout:     failure_kind in `timeoutFailureKinds`
 * - stream:      stream === true && stream_terminal_type === "error"
 * - upstream:    failure_kind in `upstreamWideFailureKinds`
 */
export class CohortAccumulatorV1 {
  private readonly acceptedIds = new Set<string>();
  private readonly fiveXxIds = new Set<string>();
  private readonly timeoutIds = new Set<string>();
  private readonly streamIds = new Set<string>();
  private readonly upstreamIds = new Set<string>();
  private readonly terminalIds = new Set<string>();
  private unreadableCount = 0;

  add(parse: CohortParseV1, kinds: CohortKindsV1): void {
    if (parse.kind === "unreadable") {
      this.unreadableCount++;
      return;
    }
    if (parse.kind === "ignored") return;
    if (parse.kind === "accepted") {
      this.acceptedIds.add(parse.event.requestId);
      return;
    }
    const terminal = parse.event;
    this.terminalIds.add(terminal.requestId);
    if (terminal.status >= 500) this.fiveXxIds.add(terminal.requestId);
    if (
      terminal.failureKind !== null &&
      kinds.timeoutFailureKinds.includes(terminal.failureKind)
    ) {
      this.timeoutIds.add(terminal.requestId);
    }
    if (terminal.stream === true && terminal.streamTerminalType === "error") {
      this.streamIds.add(terminal.requestId);
    }
    if (
      terminal.failureKind !== null &&
      kinds.upstreamWideFailureKinds.includes(terminal.failureKind)
    ) {
      this.upstreamIds.add(terminal.requestId);
    }
  }

  counts(): CohortCountsV1 {
    const inCohort = (ids: ReadonlySet<string>): number => {
      let count = 0;
      for (const id of ids) {
        if (this.acceptedIds.has(id)) count++;
      }
      return count;
    };
    return {
      acceptedCount: this.acceptedIds.size,
      fiveXxCount: inCohort(this.fiveXxIds),
      timeoutCount: inCohort(this.timeoutIds),
      streamFailureCount: inCohort(this.streamIds),
      upstreamWideCount: inCohort(this.upstreamIds),
      unreadableCount: this.unreadableCount,
      unresolvedOutcomeCount:
        [...this.acceptedIds].filter((id) => !this.terminalIds.has(id)).length +
        [...this.terminalIds].filter((id) => !this.acceptedIds.has(id)).length,
    };
  }
}

export function aggregateCohortCounts(
  entries: readonly { parse: CohortParseV1 }[],
  kinds: CohortKindsV1,
): CohortCountsV1 {
  const accumulator = new CohortAccumulatorV1();
  for (const entry of entries) accumulator.add(entry.parse, kinds);
  return accumulator.counts();
}

function expectBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    return null;
  }
  return value;
}

type OptionalV1<T> =
  | { status: "invalid" }
  | { status: "null" }
  | { status: "value"; value: T };

function expectNullableBoundedString(
  value: unknown,
  max: number,
): OptionalV1<string> {
  if (value === null) return { status: "null" };
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    return { status: "invalid" };
  }
  return { status: "value", value };
}

function expectNullableBoolean(value: unknown): OptionalV1<boolean> {
  if (value === null) return { status: "null" };
  if (typeof value !== "boolean") return { status: "invalid" };
  return { status: "value", value };
}

function expectHttpStatus(value: unknown): number | null {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 ||
    value > 599
  ) {
    return null;
  }
  return value;
}

function expectGitSha(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    return null;
  }
  return value;
}

export const emptyCohortCounts = (): CohortCountsV1 => ({
  acceptedCount: 0,
  fiveXxCount: 0,
  timeoutCount: 0,
  streamFailureCount: 0,
  upstreamWideCount: 0,
  unreadableCount: 0,
  unresolvedOutcomeCount: 0,
});
