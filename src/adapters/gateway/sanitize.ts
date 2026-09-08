/**
 * Gateway protocol JSON sanitizer — phase 1 (transform only).
 *
 * Converts common Responses and Chat Completions request, JSON-response and
 * SSE event payload shapes into an independent, fixed-vocabulary JSON value:
 *
 * - Only the literal keys in PROTOCOL_KEYS are ever emitted. An unknown key —
 *   including a key inherited from Object.prototype — makes the whole
 *   sanitize call fail (never echoed, never flattened, never claimed as
 *   universal sanitization).
 * - Enum values are restricted to the exported finite literal sets. An enum
 *   string outside its set makes the whole sanitize call fail; it is never
 *   copied as a value. Non-string enum inputs are rejected.
 * - Free strings become the fixed placeholder "fixture text" (empty stays
 *   empty), id/item_id/call_id/tool_call_id become sequential encounter-order
 *   fixture_id_N values and name strings become fixture_name_N values,
 *   deterministic per factory and stable across sanitize calls. Raw text is
 *   never hashed into a public identifier and source lengths are not exposed.
 * - Numeric request controls in range are preserved; private timing, usage and
 *   logprob numbers are replaced with 0; byte arrays are zeroed; booleans are
 *   preserved.
 * - Typed keys reject wrong types; scalar keys reject object/array values.
 * - Limits: max depth 32, max 8192 aggregate visited nodes per factory (shared
 *   across sanitize calls), max 1024 items per array, no cycles.
 * - Unsupported input fails with the fixed UNSUPPORTED_ERROR text, which never
 *   echoes values, keys or paths. The allowlist policy is validated at
 *   construction and fails with the fixed POLICY_ERROR text.
 *
 * Phase 1 deliberately has no capture, decryption, SSE unwrapping, provenance
 * or hash, header or output API and defines no sanitizer success/equivalence
 * attestation; Phase 3 adds that replay sanitization API without weakening
 * the rule.
 *
 * Phase 2 adds sanitizeRecordedUpstream: a captured upstream trace is
 * re-encoded attempt by attempt with the same fixed vocabulary and a shared
 * per-factory ID map; SSE/JSON bodies are transformed, rechunked to the
 * original chunk capacities, and failures use a fixed error text that never
 * echoes input.
 *
 * Phase 3 adds sanitizeGatewayReplay: an authenticated retained capture is
 * converted into a bounded public replay fixture (request plus upstream) and
 * restricted provenance. Request and upstream are sanitized through one
 * protocol factory (request first), so ID placeholders link across both;
 * only captured header values that exactly match trusted host policy
 * literals are copied and unknown/unapproved captured headers are omitted.
 * The transform is structural only and attests no equivalence: real
 * before/after validation of the fixture against the original request and
 * upstream behavior is required in the replay module before any fixture is
 * trusted (hence equivalence "unverified").
 */

import type {
  RetainedGatewayCaptureV1,
  RetainedGatewayUpstreamAttemptV1,
  RetainedGatewayUpstreamV1,
} from "./decrypt.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../../contracts/canonical.ts";
import { portError, portOk, type PortResultV1 } from "../../contracts/ports.ts";

/** Structural role enum for messages, parts and items. */
export type ProtocolRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";
/** Finite set of protocol role strings. */
export const PROTOCOL_ROLES: readonly ProtocolRole[] = [
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
];

/** Structural object-kind enum. */
export type ProtocolObjectKind =
  | "response"
  | "chat.completion"
  | "chat.completion.chunk"
  | "list";
/** Finite set of protocol object-kind strings. */
export const PROTOCOL_OBJECT_KINDS: readonly ProtocolObjectKind[] = [
  "response",
  "chat.completion",
  "chat.completion.chunk",
  "list",
];

/** Status enum for responses, items and requests. */
export type ProtocolStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";
/** Finite set of protocol status strings. */
export const PROTOCOL_STATUSES: readonly ProtocolStatus[] = [
  "queued",
  "in_progress",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
];

/** Reasoning effort enum. */
export type ProtocolEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
/** Finite set of reasoning effort strings. */
export const PROTOCOL_EFFORTS: readonly ProtocolEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/** Summary mode enum. */
export type ProtocolSummary = "auto" | "concise" | "detailed";
/** Finite set of summary mode strings. */
export const PROTOCOL_SUMMARIES: readonly ProtocolSummary[] = [
  "auto",
  "concise",
  "detailed",
];

/** Finish-reason enum (null is allowed where the protocol permits it). */
export type ProtocolFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";
/** Finite set of finish-reason strings. */
export const PROTOCOL_FINISH_REASONS: readonly ProtocolFinishReason[] = [
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
];

/** Tool-choice string enum; the object form uses only known keys. */
export type ProtocolToolChoice = "auto" | "none" | "required";
/** Finite set of tool-choice strings. */
export const PROTOCOL_TOOL_CHOICES: readonly ProtocolToolChoice[] = [
  "auto",
  "none",
  "required",
];

/** Response-format enum; the object form uses only known keys. */
export type ProtocolFormat = "text" | "json_object" | "json_schema";
/** Finite set of response-format strings. */
export const PROTOCOL_FORMATS: readonly ProtocolFormat[] = [
  "text",
  "json_object",
  "json_schema",
];

/**
 * Type enum for parts/items, Responses event types and error types. No
 * wildcard prefix acceptance: a string outside this finite list is rejected.
 */
export type ProtocolType =
  | "message"
  | "input_text"
  | "output_text"
  | "text"
  | "refusal"
  | "function"
  | "function_call"
  | "function_call_output"
  | "reasoning"
  | "summary_text"
  | "json_object"
  | "json_schema"
  | "invalid_request_error"
  | "server_error"
  | "rate_limit_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "response.created"
  | "response.in_progress"
  | "response.completed"
  | "response.failed"
  | "response.incomplete"
  | "response.queued"
  | "response.output_item.added"
  | "response.output_item.done"
  | "response.content_part.added"
  | "response.content_part.done"
  | "response.output_text.delta"
  | "response.output_text.done"
  | "response.refusal.delta"
  | "response.refusal.done"
  | "response.function_call_arguments.delta"
  | "response.function_call_arguments.done"
  | "response.reasoning_summary_part.added"
  | "response.reasoning_summary_part.done"
  | "response.reasoning_summary_text.delta"
  | "response.reasoning_summary_text.done"
  | "error";
/** Finite set of protocol type strings. */
export const PROTOCOL_TYPES: readonly ProtocolType[] = [
  "message",
  "input_text",
  "output_text",
  "text",
  "refusal",
  "function",
  "function_call",
  "function_call_output",
  "reasoning",
  "summary_text",
  "json_object",
  "json_schema",
  "invalid_request_error",
  "server_error",
  "rate_limit_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.queued",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "error",
];

/** Literal keys the sanitizer can emit. */
export type ProtocolKey =
  | "model"
  | "input"
  | "messages"
  | "instructions"
  | "stream"
  | "store"
  | "temperature"
  | "top_p"
  | "max_tokens"
  | "max_completion_tokens"
  | "max_output_tokens"
  | "parallel_tool_calls"
  | "reasoning"
  | "effort"
  | "summary"
  | "text"
  | "format"
  | "type"
  | "role"
  | "content"
  | "output"
  | "id"
  | "item_id"
  | "call_id"
  | "tool_call_id"
  | "name"
  | "arguments"
  | "tools"
  | "tool_choice"
  | "tool_calls"
  | "function"
  | "refusal"
  | "annotations"
  | "object"
  | "choices"
  | "index"
  | "finish_reason"
  | "message"
  | "delta"
  | "status"
  | "error"
  | "code"
  | "param"
  | "detail"
  | "response"
  | "item"
  | "part"
  | "output_index"
  | "content_index"
  | "sequence_number"
  | "created"
  | "created_at"
  | "usage"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "prompt_tokens"
  | "completion_tokens"
  | "input_tokens_details"
  | "output_tokens_details"
  | "prompt_tokens_details"
  | "completion_tokens_details"
  | "cached_tokens"
  | "reasoning_tokens"
  | "incomplete_details"
  | "reason"
  | "logprobs"
  | "token"
  | "bytes"
  | "top_logprobs";
/** Finite set of literal keys the sanitizer can emit. */
export const PROTOCOL_KEYS: readonly ProtocolKey[] = [
  "model",
  "input",
  "messages",
  "instructions",
  "stream",
  "store",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "parallel_tool_calls",
  "reasoning",
  "effort",
  "summary",
  "text",
  "format",
  "type",
  "role",
  "content",
  "output",
  "id",
  "item_id",
  "call_id",
  "tool_call_id",
  "name",
  "arguments",
  "tools",
  "tool_choice",
  "tool_calls",
  "function",
  "refusal",
  "annotations",
  "object",
  "choices",
  "index",
  "finish_reason",
  "message",
  "delta",
  "status",
  "error",
  "code",
  "param",
  "detail",
  "response",
  "item",
  "part",
  "output_index",
  "content_index",
  "sequence_number",
  "created",
  "created_at",
  "usage",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "prompt_tokens",
  "completion_tokens",
  "input_tokens_details",
  "output_tokens_details",
  "prompt_tokens_details",
  "completion_tokens_details",
  "cached_tokens",
  "reasoning_tokens",
  "incomplete_details",
  "reason",
  "logprobs",
  "token",
  "bytes",
  "top_logprobs",
];

/** A per-factory protocol JSON sanitizer. */
export interface ProtocolSanitizer {
  /** Returns an independent sanitized copy; rejects unsupported input. */
  sanitize(value: unknown): unknown;
}

/** Fixed placeholder for redacted free strings. */
const FIXTURE_TEXT = "fixture text";
/** Fixed placeholder replacing stringified tool arguments. */
const FIXTURE_ARGUMENTS = "{}";
/** Prefix for encounter-order identifier placeholders. */
const FIXTURE_ID_PREFIX = "fixture_id_";
/** Prefix for encounter-order name placeholders. */
const FIXTURE_NAME_PREFIX = "fixture_name_";
/** Fixed error text for unsupported input; never echoes values/keys/paths. */
const UNSUPPORTED_ERROR = "Unsupported protocol value";
/** Fixed error text for an invalid public model allowlist. */
const POLICY_ERROR = "Invalid public model allowlist";
/** Maximum nesting depth. */
const MAX_DEPTH = 32;
/** Maximum aggregate visited nodes per factory (shared across calls). */
const MAX_NODES = 8192;
/** Maximum items per array. */
const MAX_ARRAY_ITEMS = 1024;

/** Public model identifier: 1..128 ASCII characters, alphanumeric start. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ROLE_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_ROLES);
const OBJECT_KIND_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_OBJECT_KINDS,
);
const STATUS_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_STATUSES);
const EFFORT_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_EFFORTS);
const SUMMARY_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_SUMMARIES);
const FINISH_REASON_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_FINISH_REASONS,
);
const TOOL_CHOICE_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_TOOL_CHOICES,
);
const FORMAT_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_FORMATS);
const TYPE_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_TYPES);

/**
 * Validate the public model allowlist: 1..128 distinct identifiers matching
 * MODEL_PATTERN. An invalid policy throws the fixed POLICY_ERROR.
 */
function validatePublicModelAllowlist(publicModels: readonly string[]): void {
  if (!Array.isArray(publicModels)) throw new Error(POLICY_ERROR);
  const distinct = new Set<string>(publicModels);
  const valid = publicModels.length >= 1 &&
    publicModels.length <= 128 &&
    distinct.size === publicModels.length &&
    publicModels.every((model) =>
      typeof model === "string" && MODEL_PATTERN.test(model)
    );
  if (!valid) throw new Error(POLICY_ERROR);
}

/** True for a plain JSON object (Object.prototype or null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Create a protocol sanitizer for the given public model allowlist. The
 * factory holds private encounter-order ID/name maps shared across sanitize
 * calls, and the aggregate visited-node budget is per factory.
 */
export function createProtocolSanitizer(
  publicModels: readonly string[],
): ProtocolSanitizer {
  try {
    validatePublicModelAllowlist(publicModels);

    const models = new Set<string>(publicModels);
    const ids = new Map<string, string>();
    const names = new Map<string, string>();
    let nextId = 0;
    let nextName = 0;
    let visited = 0;

    const fail = (): never => {
      throw new Error(UNSUPPORTED_ERROR);
    };

    /** Applies the per-factory node budget and depth gate to one visited value. */
    const touch = (depth: number): void => {
      if (visited >= MAX_NODES || depth > MAX_DEPTH) fail();
      visited += 1;
    };

    /** Encounter-order placeholder for a non-empty identifier string. */
    const mapId = (value: string): string => {
      if (value.length === 0) return "";
      const existing = ids.get(value);
      if (existing !== undefined) return existing;
      nextId += 1;
      const mapped = `${FIXTURE_ID_PREFIX}${nextId}`;
      ids.set(value, mapped);
      return mapped;
    };

    /** Encounter-order placeholder for a non-empty name string. */
    const mapName = (value: string): string => {
      if (value.length === 0) return "";
      const existing = names.get(value);
      if (existing !== undefined) return existing;
      nextName += 1;
      const mapped = `${FIXTURE_NAME_PREFIX}${nextName}`;
      names.set(value, mapped);
      return mapped;
    };

    type Handler = (
      value: unknown,
      depth: number,
      path: Set<object>,
    ) => unknown;

    /**
     * Generic value walk: null, strings become "fixture text", numbers become
     * 0, booleans are preserved, arrays are rebuilt item by item and plain
     * objects are rebuilt through the fixed key table.
     */
    const walkValue = (
      value: unknown,
      depth: number,
      path: Set<object>,
    ): unknown => {
      touch(depth);
      if (value === null) return null;
      if (typeof value === "string") {
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (typeof value === "number") {
        return Number.isFinite(value) ? 0 : fail();
      }
      if (typeof value === "boolean") return value;
      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_ITEMS) fail();
        if (path.has(value)) fail();
        path.add(value);
        const out: unknown[] = [];
        for (const item of value) out.push(walkValue(item, depth + 1, path));
        path.delete(value);
        return out;
      }
      if (isPlainObject(value)) {
        if (path.has(value)) fail();
        path.add(value);
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(KEY_HANDLERS, key)) fail();
          const handler = KEY_HANDLERS[key];
          out[key] = handler(value[key], depth + 1, path);
        }
        path.delete(value);
        return out;
      }
      return fail();
    };

    /** model: only an allowlist member is copied; other values are rejected. */
    const handlerModel: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return models.has(value) ? value : fail();
    };

    /** id/item_id/call_id/tool_call_id: deterministic encounter-order IDs. */
    const handlerId: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return mapId(value);
    };

    /** name: deterministic encounter-order name placeholders. */
    const handlerName: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return mapName(value);
    };

    /** Boolean-only keys (stream/store/parallel_tool_calls). */
    const handlerBoolean: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "boolean") return fail();
      return value;
    };

    /** Strict free text: string only, replaced by the fixed placeholder. */
    const handlerText: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "string") return fail();
      return value.length === 0 ? "" : FIXTURE_TEXT;
    };

    /** Free text or optional null (code/param/refusal). */
    const handlerTextOrNull: Handler = (value, depth) => {
      touch(depth);
      if (value === null) return null;
      if (typeof value !== "string") return fail();
      return value.length === 0 ? "" : FIXTURE_TEXT;
    };

    /** Free text, known-key object, or null (message/delta/error/detail/text). */
    const handlerTextOrObject: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (typeof value === "string") {
        touch(depth);
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** input: free text or array of protocol items. */
    const handlerInput: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (Array.isArray(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** content: free text, array of parts, or null. */
    const handlerContent: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (typeof value === "string") {
        touch(depth);
        return value.length === 0 ? "" : FIXTURE_TEXT;
      }
      if (Array.isArray(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** Array-only keys (messages/choices/tools/top_logprobs/output). */
    const handlerArrayOnly: Handler = (value, depth, path) => {
      if (!Array.isArray(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Array or null (tool_calls/annotations). */
    const handlerArrayOrNull: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (!Array.isArray(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Object-only keys (reasoning/usage/details/response/item/part/function). */
    const handlerObjectOnly: Handler = (value, depth, path) => {
      if (value === null || !isPlainObject(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Object or null (logprobs). */
    const handlerObjectOrNull: Handler = (value, depth, path) => {
      if (value === null) {
        touch(depth);
        return null;
      }
      if (!isPlainObject(value)) return fail();
      return walkValue(value, depth, path);
    };

    /** Preserved numeric request controls within the allowed closed range. */
    const handlerRange =
      (min: number, max: number): Handler => (value, depth) => {
        touch(depth);
        if (
          typeof value !== "number" || !Number.isFinite(value) || value < min ||
          value > max
        ) {
          return fail();
        }
        return value;
      };

    /** Preserved nonnegative safe integers (token counts and indices). */
    const handlerSafeInt = (max: number): Handler => (value, depth) => {
      touch(depth);
      if (
        typeof value !== "number" || !Number.isSafeInteger(value) ||
        value < 0 ||
        value > max
      ) {
        return fail();
      }
      return value;
    };

    /** Timing/usage numbers retain the number type but become 0. */
    const handlerZero: Handler = (value, depth) => {
      touch(depth);
      if (typeof value !== "number" || !Number.isFinite(value)) return fail();
      return 0;
    };

    /** bytes: array of integers 0..255; each value is replaced with 0. */
    const handlerBytes: Handler = (value, depth, path) => {
      touch(depth);
      if (!Array.isArray(value)) return fail();
      if (value.length > MAX_ARRAY_ITEMS) return fail();
      if (path.has(value)) fail();
      path.add(value);
      const out: number[] = [];
      for (const byte of value) {
        touch(depth + 1);
        if (
          typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 ||
          byte > 255
        ) {
          return fail();
        }
        out.push(0);
      }
      path.delete(value);
      return out;
    };

    /** Fixed literal-set enum; null only where the protocol allows it. */
    const handlerEnum =
      (values: ReadonlySet<string>, allowNull: boolean): Handler =>
      (value, depth) => {
        touch(depth);
        if (value === null) return allowNull ? null : fail();
        if (typeof value !== "string") return fail();
        return values.has(value) ? value : fail();
      };

    /** finish_reason: fixed set or null. */
    const handlerFinishReason: Handler = (value, depth) => {
      touch(depth);
      if (value === null) return null;
      if (typeof value !== "string") return fail();
      return FINISH_REASON_SET.has(value) ? value : fail();
    };

    /** tool_choice: string enum or an object using only known keys. */
    const handlerToolChoice: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return TOOL_CHOICE_SET.has(value) ? value : fail();
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** format: string enum or an object using only known keys. */
    const handlerFormat: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return FORMAT_SET.has(value) ? value : fail();
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** summary: string enum, or known-key object/array of summary parts. */
    const handlerSummary: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return SUMMARY_SET.has(value) ? value : fail();
      }
      if (
        value === null || typeof value === "number" ||
        typeof value === "boolean"
      ) return fail();
      if (Array.isArray(value) || isPlainObject(value)) {
        return walkValue(value, depth, path);
      }
      return fail();
    };

    /** arguments: stringified arguments become "{}"; objects use known keys. */
    const handlerArguments: Handler = (value, depth, path) => {
      if (typeof value === "string") {
        touch(depth);
        return FIXTURE_ARGUMENTS;
      }
      if (isPlainObject(value)) return walkValue(value, depth, path);
      return fail();
    };

    /** Fixed key table; an unlisted key (own or inherited) is rejected. */
    const KEY_HANDLERS: Record<string, Handler> = {
      model: handlerModel,
      input: handlerInput,
      messages: handlerArrayOnly,
      instructions: handlerText,
      stream: handlerBoolean,
      store: handlerBoolean,
      temperature: handlerRange(0, 2),
      top_p: handlerRange(0, 1),
      max_tokens: handlerSafeInt(1_000_000),
      max_completion_tokens: handlerSafeInt(1_000_000),
      max_output_tokens: handlerSafeInt(1_000_000),
      parallel_tool_calls: handlerBoolean,
      reasoning: handlerObjectOnly,
      effort: handlerEnum(EFFORT_SET, false),
      summary: handlerSummary,
      text: handlerTextOrObject,
      format: handlerFormat,
      type: handlerEnum(TYPE_SET, false),
      role: handlerEnum(ROLE_SET, false),
      content: handlerContent,
      output: handlerArrayOnly,
      id: handlerId,
      item_id: handlerId,
      call_id: handlerId,
      tool_call_id: handlerId,
      name: handlerName,
      arguments: handlerArguments,
      tools: handlerArrayOnly,
      tool_choice: handlerToolChoice,
      tool_calls: handlerArrayOrNull,
      function: handlerObjectOnly,
      refusal: handlerTextOrNull,
      annotations: handlerArrayOrNull,
      object: handlerEnum(OBJECT_KIND_SET, false),
      choices: handlerArrayOnly,
      index: handlerSafeInt(8192),
      finish_reason: handlerFinishReason,
      message: handlerTextOrObject,
      delta: handlerTextOrObject,
      status: handlerEnum(STATUS_SET, false),
      error: handlerTextOrObject,
      code: handlerTextOrNull,
      param: handlerTextOrNull,
      detail: handlerTextOrObject,
      response: handlerObjectOnly,
      item: handlerObjectOnly,
      part: handlerObjectOnly,
      output_index: handlerSafeInt(8192),
      content_index: handlerSafeInt(8192),
      sequence_number: handlerSafeInt(8192),
      created: handlerZero,
      created_at: handlerZero,
      usage: handlerObjectOnly,
      input_tokens: handlerZero,
      output_tokens: handlerZero,
      total_tokens: handlerZero,
      prompt_tokens: handlerZero,
      completion_tokens: handlerZero,
      input_tokens_details: handlerObjectOnly,
      output_tokens_details: handlerObjectOnly,
      prompt_tokens_details: handlerObjectOnly,
      completion_tokens_details: handlerObjectOnly,
      cached_tokens: handlerZero,
      reasoning_tokens: handlerZero,
      incomplete_details: handlerObjectOnly,
      reason: handlerText,
      logprobs: handlerObjectOrNull,
      token: handlerText,
      bytes: handlerBytes,
      top_logprobs: handlerArrayOnly,
    };

    return {
      sanitize(value: unknown): unknown {
        // Root must be a plain object; scalar/array bodies are unsupported.
        try {
          if (!isPlainObject(value)) fail();
          return walkValue(value, 1, new Set<object>());
        } catch {
          // A traversal, accessor or proxy exception is normalized to the
          // fixed unsupported-input error; details are never echoed.
          throw new Error(UNSUPPORTED_ERROR);
        }
      },
    };
  } catch {
    // An unexpected construction-phase exception (invalid policy type or
    // iterator) is normalized to the fixed policy error; details are never
    // echoed.
    throw new Error(POLICY_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Captured upstream trace transformation (phase 2, transform only): a
// recorded upstream is re-encoded attempt by attempt with the same fixed
// vocabulary, sharing the supplied sanitizer's per-factory ID map.
// ---------------------------------------------------------------------------

/** Fixed error text for unsupported captured upstream traces; never echoes. */
const UPSTREAM_ERROR = "gateway upstream cannot be sanitized";

/** Minimum attempts on a recorded upstream trace. */
const MIN_ATTEMPTS = 1;
/** Maximum attempts on a recorded upstream trace. */
const MAX_ATTEMPTS = 8;
/** Maximum aggregate chunk count across attempts. */
const MAX_CHUNKS = 256;
/** Maximum aggregate decoded byte count across attempts. */
const MAX_BYTES = 131072;
/** Encoded-length bound of one base64 chunk before it is decoded. */
const MAX_BASE64_ENCODED = Math.ceil(MAX_BYTES / 3) * 4;

/**
 * SSE event names: exactly the fixed PROTOCOL_TYPES members starting with
 * "response." plus "error"; no wildcard or prefix acceptance.
 */
const SSE_EVENT_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_TYPES.filter((t) => t.startsWith("response.") || t === "error"),
);

/** True for the bodyless HTTP statuses 204/205/304. */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function failUpstream(): never {
  throw new Error(UPSTREAM_ERROR);
}

/**
 * Reject records with unknown/symbol own keys, hidden non-enumerable keys or
 * accessor properties (even with undefined get/set); the own-key set must
 * match the allowed set exactly with enumerable data descriptors only.
 */
function assertRecordShape(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length) failUpstream();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) failUpstream();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) failUpstream();
    if ("get" in descriptor || "set" in descriptor) failUpstream();
    if (!descriptor.enumerable) failUpstream();
  }
}

/**
 * Reject arrays with symbol/non-index own keys, hidden non-enumerable keys,
 * accessor properties or missing dense indices: only the built-in own
 * "length" plus the enumerable data indices 0..length-1 are accepted.
 */
function assertArrayShape(value: readonly unknown[]): void {
  let indexCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue; // normal special built-in
    if (typeof key !== "string") failUpstream();
    const index = Number(key);
    if (
      !Number.isInteger(index) || index < 0 || index > 4294967294 ||
      String(index) !== key || index >= value.length
    ) {
      failUpstream();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) failUpstream();
    if ("get" in descriptor || "set" in descriptor) failUpstream();
    if (!descriptor.enumerable) failUpstream();
    indexCount += 1;
  }
  if (indexCount !== value.length) failUpstream();
}

/** Decode a canonical standard base64 chunk into bytes. */
function decodeChunk(chunk: string): Uint8Array {
  if (chunk.length > MAX_BASE64_ENCODED) failUpstream();
  let binary: string;
  try {
    binary = atob(chunk);
  } catch {
    failUpstream();
  }
  if (btoa(binary) !== chunk) failUpstream();
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Concatenate byte arrays into one buffer. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** Standard base64 encode one byte array. */
function encodeChunk(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Rechunk transformed bytes with the original chunk byte lengths as
 * successive capacities; remaining bytes go to the last chunk and empty
 * chunks are omitted.
 */
function rechunk(bytes: Uint8Array, capacities: readonly number[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < capacities.length; i += 1) {
    if (i === capacities.length - 1) {
      if (pos < bytes.length) {
        out.push(encodeChunk(bytes.subarray(pos, bytes.length)));
        pos = bytes.length;
      }
      break;
    }
    const n = Math.min(capacities[i], bytes.length - pos);
    if (n > 0) {
      out.push(encodeChunk(bytes.subarray(pos, pos + n)));
      pos += n;
    }
  }
  if (pos < bytes.length) out.push(encodeChunk(bytes.subarray(pos)));
  return out;
}

type SseLine = { content: string; ending: string };

/** Split text into lines preserving each exact LF/CRLF/CR ending. */
function splitSseLines(text: string): SseLine[] {
  const lines: SseLine[] = [];
  let pos = 0;
  while (pos < text.length) {
    const lf = text.indexOf("\n", pos);
    const cr = text.indexOf("\r", pos);
    if (lf === -1 && cr === -1) {
      lines.push({ content: text.slice(pos), ending: "" });
      break;
    }
    if (cr !== -1 && (lf === -1 || cr < lf)) {
      const ending = text.charCodeAt(cr + 1) === 10 ? "\r\n" : "\r";
      lines.push({ content: text.slice(pos, cr), ending });
      pos = cr + ending.length;
    } else {
      lines.push({ content: text.slice(pos, lf), ending: "\n" });
      pos = lf + 1;
    }
  }
  return lines;
}

type SseField =
  | { kind: "comment" }
  | { kind: "event" | "data"; separator: string; value: string };

/**
 * Parse one non-empty SSE line. Unknown fields (including id/retry) are
 * rejected; the field separator is one optional standard space.
 */
function parseSseField(content: string): SseField {
  const colon = content.indexOf(":");
  if (colon === 0) return { kind: "comment" };
  const name = colon === -1 ? content : content.slice(0, colon);
  if (name !== "event" && name !== "data") failUpstream();
  const separator = colon !== -1 && content.charAt(colon + 1) === " "
    ? " "
    : "";
  const value = colon === -1
    ? ""
    : content.slice(colon + (separator === " " ? 2 : 1));
  return { kind: name, separator, value };
}

/**
 * One independent JSON object run through the shared protocol sanitizer; a
 * complete object and a string serialization are required.
 */
function transformJsonField(
  value: string,
  protocol: ProtocolSanitizer,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failUpstream();
  }
  if (!isPlainObject(parsed)) failUpstream();
  let sanitized: unknown;
  try {
    sanitized = protocol.sanitize(parsed);
  } catch {
    failUpstream();
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    failUpstream();
  }
  if (typeof serialized !== "string") failUpstream();
  return serialized;
}

/**
 * Transform an SSE body. Every data field is an independent JSON object or
 * the literal [DONE]; more than one data field per event, unknown fields,
 * partial/malformed JSON and unknown event names fail. Line endings, blank
 * boundaries and field separators are preserved exactly.
 */
function transformSseBody(text: string, protocol: ProtocolSanitizer): string {
  const lines = splitSseLines(text);
  const out: string[] = [];
  let dataFieldsInEvent = 0;
  for (const line of lines) {
    if (line.content === "") {
      out.push(line.ending);
      dataFieldsInEvent = 0;
      continue;
    }
    const field = parseSseField(line.content);
    if (field.kind === "comment") {
      out.push(`: fixture comment${line.ending}`);
      continue;
    }
    if (field.kind === "event") {
      if (!SSE_EVENT_SET.has(field.value)) failUpstream();
      out.push(`event:${field.separator}${field.value}${line.ending}`);
      continue;
    }
    dataFieldsInEvent += 1;
    if (dataFieldsInEvent > 1) failUpstream();
    const value = field.value === "[DONE]"
      ? "[DONE]"
      : transformJsonField(field.value, protocol);
    out.push(`data:${field.separator}${value}${line.ending}`);
  }
  return out.join("");
}

interface TraceStats {
  chunks: number;
  outputChunks: number;
  decodedBytes: number;
  outputBytes: number;
}

/**
 * Transform one recorded attempt, or fail the whole trace. fetch_error keeps
 * the no-body shape, bodyless statuses require EOF with zero chunks, and any
 * other status requires a supported MIME with a non-empty transformed body
 * rechunked to the original chunk capacities.
 */
function transformAttempt(
  attemptValue: unknown,
  protocol: ProtocolSanitizer,
  path: Set<object>,
  stats: TraceStats,
): RetainedGatewayUpstreamAttemptV1 {
  if (!isPlainObject(attemptValue)) failUpstream();
  const attempt = attemptValue;
  assertRecordShape(attempt, [
    "provider",
    "status",
    "content_type",
    "chunks_base64",
    "terminal",
  ]);
  if (path.has(attempt)) failUpstream();
  path.add(attempt);

  const provider = attempt.provider;
  if (
    provider !== "chatgpt_codex" && provider !== "surplus" &&
    provider !== "metered" && provider !== "cerebras"
  ) {
    failUpstream();
  }
  const status = attempt.status;
  if (
    status !== null &&
    (typeof status !== "number" || !Number.isInteger(status) ||
      status < 200 || status > 599)
  ) {
    failUpstream();
  }
  const contentType = attempt.content_type;
  if (
    contentType !== null && contentType !== "text/event-stream" &&
    contentType !== "application/json" && contentType !== "other"
  ) {
    failUpstream();
  }
  const terminal = attempt.terminal;
  if (
    terminal !== "fetch_error" && terminal !== "eof" &&
    terminal !== "read_error" && terminal !== "cancelled"
  ) {
    failUpstream();
  }

  const chunksValue = attempt.chunks_base64;
  if (!Array.isArray(chunksValue)) failUpstream();
  if (chunksValue.length > MAX_CHUNKS - stats.chunks) failUpstream();
  assertArrayShape(chunksValue);
  if (path.has(chunksValue)) failUpstream();
  path.add(chunksValue);

  const capacities: number[] = [];
  const bytesParts: Uint8Array[] = [];
  let decoded = 0;
  for (const chunk of chunksValue) {
    if (typeof chunk !== "string") failUpstream();
    const part = decodeChunk(chunk);
    decoded += part.length;
    if (stats.decodedBytes + decoded > MAX_BYTES) failUpstream();
    capacities.push(part.length);
    bytesParts.push(part);
  }
  path.delete(chunksValue);

  let outChunks: string[];
  let outputBytes = 0;

  if (terminal === "fetch_error") {
    if (status !== null || contentType !== null || chunksValue.length !== 0) {
      failUpstream();
    }
    outChunks = [];
  } else if (status !== null && isBodylessStatus(status)) {
    if (terminal !== "eof" || chunksValue.length !== 0) failUpstream();
    outChunks = [];
  } else {
    if (status === null) failUpstream();
    if (
      contentType !== "application/json" &&
      contentType !== "text/event-stream"
    ) {
      failUpstream();
    }
    if (decoded === 0) failUpstream();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        concatBytes(bytesParts),
      );
    } catch {
      failUpstream();
    }
    const transformed = contentType === "application/json"
      ? transformJsonField(text, protocol)
      : transformSseBody(text, protocol);
    const outBytes = new TextEncoder().encode(transformed);
    if (outBytes.length === 0) failUpstream();
    if (outBytes.length > MAX_BYTES) failUpstream();
    outputBytes = outBytes.length;
    outChunks = rechunk(outBytes, capacities);
  }

  stats.chunks += chunksValue.length;
  stats.outputChunks += outChunks.length;
  stats.decodedBytes += decoded;
  stats.outputBytes += outputBytes;
  if (stats.outputChunks > MAX_CHUNKS) failUpstream();
  if (stats.outputBytes > MAX_BYTES) failUpstream();
  path.delete(attempt);

  return {
    provider,
    status,
    content_type: contentType,
    chunks_base64: outChunks,
    terminal,
  };
}

/** Validate and transform the whole recorded upstream trace. */
function sanitizeTrace(
  upstream: unknown,
  protocol: ProtocolSanitizer,
): RetainedGatewayUpstreamV1 {
  if (!isPlainObject(upstream)) failUpstream();
  assertRecordShape(upstream, [
    "version",
    "attempts",
    "attempts_truncated",
    "bytes_truncated",
    "chunks_truncated",
  ]);
  if (upstream.version !== 1) failUpstream();
  if (upstream.attempts_truncated !== false) failUpstream();
  if (upstream.bytes_truncated !== false) failUpstream();
  if (upstream.chunks_truncated !== false) failUpstream();
  const attemptsValue = upstream.attempts;
  if (!Array.isArray(attemptsValue)) failUpstream();
  if (
    attemptsValue.length < MIN_ATTEMPTS ||
    attemptsValue.length > MAX_ATTEMPTS
  ) {
    failUpstream();
  }
  assertArrayShape(attemptsValue);

  const path = new Set<object>();
  path.add(upstream);
  const stats: TraceStats = {
    chunks: 0,
    outputChunks: 0,
    decodedBytes: 0,
    outputBytes: 0,
  };
  const outAttempts: RetainedGatewayUpstreamAttemptV1[] = [];
  for (const attempt of attemptsValue) {
    outAttempts.push(transformAttempt(attempt, protocol, path, stats));
  }
  if (stats.chunks > MAX_CHUNKS) failUpstream();
  if (stats.outputChunks > MAX_CHUNKS) failUpstream();
  if (stats.decodedBytes > MAX_BYTES) failUpstream();
  if (stats.outputBytes > MAX_BYTES) failUpstream();

  return {
    version: 1,
    attempts: outAttempts,
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
}

/**
 * Transform a recorded upstream trace into an independent sanitized trace:
 * attempt order, provider, status, MIME type and terminal are preserved while
 * every parsed JSON object is re-encoded through the supplied protocol
 * sanitizer, so the per-factory ID map is shared. All failures throw the
 * fixed "gateway upstream cannot be sanitized" error; input is never echoed
 * or mutated and no partial trace is returned.
 */
export function sanitizeRecordedUpstream(
  upstream: RetainedGatewayUpstreamV1,
  protocol: ProtocolSanitizer,
): RetainedGatewayUpstreamV1 {
  try {
    return sanitizeTrace(upstream, protocol);
  } catch {
    // Any validation or unexpected exception (including proxy/accessor traps
    // and protocol sanitizer failures) is normalized to the fixed error text;
    // captured input is never echoed.
    throw new Error(UPSTREAM_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: authenticated gateway replay sanitization. A retained decrypt
// capture is converted into a bounded public replay fixture (request plus
// upstream) plus restricted provenance with the same fixed-vocabulary
// sanitizer. Policy is trusted fixed host code; headers are copied only when
// the captured value is exactly a trusted policy literal.
// ---------------------------------------------------------------------------

/** Trusted fixed host policy for replay sanitization (never capture-derived). */
export interface GatewaySanitizerPolicyV1 {
  publicModels: readonly string[];
  publicHeaders: Readonly<Record<string, readonly string[]>>;
}

/** The public request header of a replay fixture. */
export interface GatewaySanitizedRequestV1 {
  endpoint: "/v1/responses" | "/v1/chat/completions";
  method: "POST";
  contentType: "application/json";
  compatibilityHeaders: Readonly<Record<string, string>>;
  body: string;
}

/** The minimal public replay fixture: request plus transformed upstream. */
export interface SanitizedGatewayFixtureV1 {
  version: 1;
  request: GatewaySanitizedRequestV1;
  upstream: RetainedGatewayUpstreamV1;
}

/**
 * Restricted provenance binding the fixture to the authenticated source
 * identity. Never public: it carries the source capture identity, source
 * shas, the exact source body digest, the canonical original upstream digest
 * and the canonical public fixture digest, and attests no equivalence or
 * coverage. No canonical request digest is part of the contract.
 */
export interface GatewayRestrictedProvenanceV1 {
  sanitizer: "gateway-structural-v1";
  redacted: true;
  equivalence: "unverified";
  sourceCaptureId: string;
  sourceGitSha: string;
  sourceFingerprint: string;
  sourceCaseGroupDigest: string;
  sourceRequestDigest: string;
  sourceUpstreamDigest: string;
  payloadDigest: string;
}

/** Result of sanitizing one authenticated retained gateway capture. */
export interface SanitizedGatewayReplayV1 {
  fixture: SanitizedGatewayFixtureV1;
  restrictedProvenance: GatewayRestrictedProvenanceV1;
}

/** Fixed invalid-policy detail; never echoes host policy content. */
const POLICY_ERROR_DETAIL = "Invalid gateway sanitizer policy";
/** Fixed unavailable detail; never echoes capture content or exceptions. */
const UNAVAILABLE_DETAIL = "Gateway replay cannot be sanitized";

/** Fixed lowercase header names the replay sanitizer may emit. */
const ALLOWED_HEADER_NAMES: readonly string[] = [
  "accept",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "user-agent",
  "x-codex-client-version",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
];

const ALLOWED_HEADER_SET: ReadonlySet<string> = new Set<string>(
  ALLOWED_HEADER_NAMES,
);

/** One policy header value list: 1..32 printable ASCII strings 1..256 chars. */
const MIN_POLICY_HEADER_VALUES = 1;
const MAX_POLICY_HEADER_VALUES = 32;
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]{1,256}$/;
/** Captured identity bounds: nonempty, at most 256 characters. */
const MAX_CAPTURE_ID_LENGTH = 256;
/** Exact original request body bytes: at least 1, at most 32 MiB. */
const MAX_BODY_BYTES = 33554432;
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
const LOWERCASE_HEX_40 = /^[0-9a-f]{40}$/;
/** Defensive structural cap for JSON snapshots (protocol depth is 32). */
const MAX_SNAPSHOT_DEPTH = 64;

/** Validated, independently copied host policy; no input references. */
interface SanitizerPolicySnapshotV1 {
  publicModels: string[];
  publicHeaders: Record<string, string[]>;
}

/**
 * Validated capture fields consumed by this API. Identity, header and body
 * values are copied; the single `upstream` read is stored once and handed to
 * the synchronous bounded transform and then to its snapshot before any
 * await, so the transform and the hash always agree on one value.
 */
interface CaptureSnapshotV1 {
  captureId: string;
  fingerprint: string;
  caseGroupDigest: string;
  gitSha: string;
  endpoint: "/v1/responses" | "/v1/chat/completions";
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
  upstream: RetainedGatewayUpstreamV1;
}

/** Reject an own-key descriptor that is not an enumerable data descriptor. */
function assertOwnDataDescriptor(
  value: object,
  key: PropertyKey,
  kind: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) throw new TypeError(`unreadable ${kind}`);
  if ("get" in descriptor || "set" in descriptor) {
    throw new TypeError(`accessor ${kind}`);
  }
  if (!descriptor.enumerable) throw new TypeError(`non-enumerable ${kind}`);
}

/** True for a canonical dense array index within the array length. */
function isDenseArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length &&
    String(index) === key;
}

/**
 * Independently copy a JSON-safe value without ever invoking accessors:
 * symbol keys, accessors, non-enumerable keys, cycles, sparse arrays,
 * non-plain prototypes and non-JSON values are rejected up front.
 */
function snapshotValue(value: unknown): unknown {
  return snapshotValueAt(value, 0, new Set<object>());
}

function snapshotValueAt(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("non-finite number in snapshot");
    }
    return value;
  }
  if (type !== "object") throw new TypeError("non-JSON value in snapshot");
  const object = value as object;
  if (depth > MAX_SNAPSHOT_DEPTH) throw new TypeError("snapshot too deep");
  if (seen.has(object)) throw new TypeError("cyclic snapshot");
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const array = object as unknown[];
      for (const key of Reflect.ownKeys(array)) {
        if (key === "length") continue;
        if (typeof key !== "string") {
          throw new TypeError("symbol array key in snapshot");
        }
        if (!isDenseArrayIndex(key, array.length)) {
          throw new TypeError("non-index array key in snapshot");
        }
        assertOwnDataDescriptor(array, key, "array element");
      }
      const out: unknown[] = [];
      for (let i = 0; i < array.length; i += 1) {
        if (!(i in array)) throw new TypeError("sparse array in snapshot");
        out.push(snapshotValueAt(array[i], depth + 1, seen));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("non-plain object in snapshot");
    }
    const record = object as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string") {
        throw new TypeError("symbol key in snapshot");
      }
      assertOwnDataDescriptor(record, key, "property");
      out[key] = snapshotValueAt(record[key], depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Copy and structurally validate the trusted host policy. */
function snapshotPolicy(
  policy: GatewaySanitizerPolicyV1,
): SanitizerPolicySnapshotV1 {
  const snapshot = snapshotValue(policy);
  if (!isPlainObject(snapshot)) throw new TypeError("policy is not a record");
  const record = snapshot as Record<string, unknown>;
  const publicModels = record.publicModels;
  if (!Array.isArray(publicModels)) {
    throw new TypeError("policy models are not an array");
  }
  const models: string[] = [];
  for (const model of publicModels) {
    if (typeof model !== "string") {
      throw new TypeError("policy model is not a string");
    }
    models.push(model);
  }
  const publicHeaders = record.publicHeaders;
  if (!isPlainObject(publicHeaders)) {
    throw new TypeError("policy headers are not a record");
  }
  const headers: Record<string, string[]> = {};
  for (const key of Reflect.ownKeys(publicHeaders)) {
    if (typeof key !== "string") {
      throw new TypeError("policy header key is not a string");
    }
    if (!ALLOWED_HEADER_SET.has(key)) {
      throw new TypeError("policy header name is not allowed");
    }
    const values = (publicHeaders as Record<string, unknown>)[key];
    if (
      !Array.isArray(values) || values.length < MIN_POLICY_HEADER_VALUES ||
      values.length > MAX_POLICY_HEADER_VALUES
    ) {
      throw new TypeError("policy header value list is out of bounds");
    }
    const literals: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !HEADER_VALUE_PATTERN.test(value)) {
        throw new TypeError("policy header value is invalid");
      }
      literals.push(value);
    }
    headers[key] = literals;
  }
  return { publicModels: models, publicHeaders: headers };
}

/** True when the MIME base type (case-insensitive) is application/json. */
function isApplicationJson(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "application/json";
}

/**
 * Exact fields this API consumes from a retained capture, in read order. The
 * own descriptor of every required field is validated to be an enumerable
 * data descriptor before that field is read; unrelated private capture
 * fields are never inspected.
 */
const CAPTURE_CONSUMED_FIELDS: readonly string[] = [
  "version",
  "captureId",
  "fingerprint",
  "caseGroupDigest",
  "gitSha",
  "endpoint",
  "method",
  "contentType",
  "compatibilityHeaders",
  "body",
  "upstream",
];

/** Copy and defensively validate every capture field this API consumes. */
function snapshotCapture(capture: RetainedGatewayCaptureV1): CaptureSnapshotV1 {
  if (typeof capture !== "object" || capture === null) {
    throw new TypeError("capture is not an object");
  }
  // Validate the own descriptor of every consumed field before reading it:
  // an accessor (even with undefined get/set), a missing own descriptor or a
  // non-enumerable own field is rejected, so no getter/proxy trap can run.
  for (const key of CAPTURE_CONSUMED_FIELDS) {
    assertOwnDataDescriptor(capture, key, `capture ${key}`);
  }
  if (capture.version !== 1) throw new TypeError("unsupported capture version");
  const captureId = capture.captureId;
  if (
    typeof captureId !== "string" || captureId.length < 1 ||
    captureId.length > MAX_CAPTURE_ID_LENGTH
  ) {
    throw new TypeError("invalid capture id");
  }
  const fingerprint = capture.fingerprint;
  if (typeof fingerprint !== "string" || !LOWERCASE_HEX_64.test(fingerprint)) {
    throw new TypeError("invalid fingerprint");
  }
  const caseGroupDigest = capture.caseGroupDigest;
  if (
    typeof caseGroupDigest !== "string" ||
    !LOWERCASE_HEX_64.test(caseGroupDigest)
  ) {
    throw new TypeError("invalid case group digest");
  }
  const gitSha = capture.gitSha;
  if (typeof gitSha !== "string" || !LOWERCASE_HEX_40.test(gitSha)) {
    throw new TypeError("invalid git sha");
  }
  const endpoint = capture.endpoint;
  if (endpoint !== "/v1/responses" && endpoint !== "/v1/chat/completions") {
    throw new TypeError("invalid endpoint");
  }
  if (capture.method !== "POST") throw new TypeError("invalid method");
  const contentType = capture.contentType;
  if (typeof contentType !== "string" || !isApplicationJson(contentType)) {
    throw new TypeError("invalid content type");
  }
  const body = capture.body;
  if (
    !(body instanceof Uint8Array) || body.length < 1 ||
    body.length > MAX_BODY_BYTES
  ) {
    throw new TypeError("invalid body");
  }
  const headersSnapshot = snapshotValue(capture.compatibilityHeaders);
  if (!isPlainObject(headersSnapshot)) {
    throw new TypeError("capture headers are not a record");
  }
  const headers: Record<string, string> = {};
  for (const key of Reflect.ownKeys(headersSnapshot)) {
    if (typeof key !== "string") {
      throw new TypeError("capture header key is not a string");
    }
    const value = (headersSnapshot as Record<string, unknown>)[key];
    if (typeof value !== "string") {
      throw new TypeError("capture header value is not a string");
    }
    headers[key] = value;
  }
  // The upstream value is read exactly once here; the same stored value is
  // handed to the synchronous bounded transform and then its snapshot.
  const upstream = capture.upstream;
  return {
    captureId,
    fingerprint,
    caseGroupDigest,
    gitSha,
    endpoint,
    headers,
    body: body.slice(),
    upstream,
  };
}

/**
 * Fatal UTF-8 decode, JSON parse, plain-object root and the protocol field
 * checks the fixture semantics depend on. The existing protocol sanitizer
 * performs the structural transform afterwards.
 */
function parseRequest(
  body: Uint8Array,
  endpoint: "/v1/responses" | "/v1/chat/completions",
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new TypeError("request body is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("request body is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError("request body is not a plain object");
  }
  const request = parsed;
  if (typeof request.model !== "string") {
    throw new TypeError("request model is not a string");
  }
  if (endpoint === "/v1/responses") {
    if (typeof request.input !== "string" && !Array.isArray(request.input)) {
      throw new TypeError("responses input is not a string or array");
    }
  } else if (!Array.isArray(request.messages)) {
    throw new TypeError("chat messages are not an array");
  }
  return request;
}

/**
 * Copy only captured headers whose value is exactly a trusted policy literal;
 * unknown, unapproved or non-matching headers are omitted. The emitted value
 * is the trusted literal, never the captured string directly.
 */
function projectHeaders(
  captured: Readonly<Record<string, string>>,
  allowed: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ALLOWED_HEADER_NAMES) {
    if (!Object.hasOwn(captured, name)) continue;
    const literals = allowed[name];
    if (literals === undefined) continue;
    const value = captured[name];
    for (const literal of literals) {
      if (literal === value) {
        out[name] = literal;
        break;
      }
    }
  }
  return out;
}

/** Lowercase hex encoding of a digest byte array. */
function toLowerHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sanitize one authenticated retained gateway capture into a minimal public
 * replay fixture with restricted provenance.
 *
 * Policy is trusted host code and is validated first (fixed model allowlist
 * plus the fixed header-name allowlist and literal bounds); an unknown
 * header name, an invalid policy or a bad model allowlist is an `invalid`
 * result with a static detail. The capture is validated defensively and every
 * consumed value (body bytes, identities, headers, upstream) is copied before
 * the first await; the upstream trace is bounded by the accepted synchronous
 * upstream sanitizer before its canonical snapshot is hashed. Request and
 * upstream are sanitized through the same protocol factory, request first,
 * so encounter-order ID placeholders link across both. Any unexpected input,
 * parser or hash problem is a static `unavailable` result; no raw exception
 * and no captured content ever escapes and no input is mutated.
 */
export async function sanitizeGatewayReplay(
  capture: RetainedGatewayCaptureV1,
  policy: GatewaySanitizerPolicyV1,
): Promise<PortResultV1<SanitizedGatewayReplayV1>> {
  let policySnapshot: SanitizerPolicySnapshotV1;
  try {
    policySnapshot = snapshotPolicy(policy);
    // Canonical snapshot proof: reject non-JSON values, accessors, symbol or
    // non-enumerable keys and cycles in the host policy before use.
    canonicalStringify(policySnapshot);
  } catch {
    return portError("invalid", POLICY_ERROR_DETAIL);
  }

  let protocol: ProtocolSanitizer;
  try {
    protocol = createProtocolSanitizer(policySnapshot.publicModels);
  } catch {
    return portError("invalid", POLICY_ERROR_DETAIL);
  }

  try {
    // All consumed inputs are copied before the first await below.
    const snapshot = snapshotCapture(capture);
    const request = parseRequest(snapshot.body, snapshot.endpoint);

    // Request first, then upstream, sharing one per-factory ID map so the
    // fixture IDs link the request to the upstream trace.
    const sanitizedRequest = protocol.sanitize(request);
    const sanitizedUpstream = sanitizeRecordedUpstream(
      snapshot.upstream,
      protocol,
    );

    // The synchronous upstream transform above validates and bounds the
    // trace; only now is the same single upstream value snapshotted and
    // canonicalized, so the transform and the hash cannot diverge.
    const upstreamSnapshot = snapshotValue(snapshot.upstream);
    canonicalStringify(snapshot.headers);
    canonicalStringify(upstreamSnapshot);

    const fixture: SanitizedGatewayFixtureV1 = {
      version: 1,
      request: {
        endpoint: snapshot.endpoint,
        method: "POST",
        contentType: "application/json",
        compatibilityHeaders: projectHeaders(
          snapshot.headers,
          policySnapshot.publicHeaders,
        ),
        body: canonicalStringify(sanitizedRequest),
      },
      upstream: sanitizedUpstream,
    };

    // Digests: the source request digest binds the exact original request
    // body bytes, the source upstream digest binds the canonical original
    // upstream snapshot and the payload digest binds the canonical public
    // fixture. No canonical request digest is part of the contract.
    const bodyDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", snapshot.body),
    );
    const sourceRequestDigest = toLowerHex(bodyDigest);
    const sourceUpstreamDigest = await canonicalStringifySha256(
      upstreamSnapshot,
    );
    const payloadDigest = await canonicalStringifySha256(fixture);

    const restrictedProvenance: GatewayRestrictedProvenanceV1 = {
      sanitizer: "gateway-structural-v1",
      redacted: true,
      equivalence: "unverified",
      sourceCaptureId: snapshot.captureId,
      sourceGitSha: snapshot.gitSha,
      sourceFingerprint: snapshot.fingerprint,
      sourceCaseGroupDigest: snapshot.caseGroupDigest,
      sourceRequestDigest,
      sourceUpstreamDigest,
      payloadDigest,
    };

    return portOk({ fixture, restrictedProvenance });
  } catch {
    // No raw exception crosses this boundary: every unexpected input,
    // validation, parser or digest failure is a static unavailable result.
    return portError("unavailable", UNAVAILABLE_DETAIL);
  }
}
