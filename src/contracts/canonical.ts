/**
 * Deterministic canonical JSON serialization for contract records.
 *
 * Rules:
 * - Object keys are emitted in UTF-16 code-unit order (the ECMAScript default
 *   sort), recursively; array order is preserved.
 * - Values must be JSON-safe: null, boolean, finite number, string, array or
 *   plain object. undefined, functions, symbols, bigint, NaN, Infinity,
 *   class instances and sparse arrays are rejected instead of being dropped,
 *   so a canonicalized record never silently loses data.
 * - Cycles are rejected with CanonicalizationError (never a stack overflow).
 * - Own symbol keys, non-enumerable own keys and accessor properties are
 *   rejected: they would otherwise be silently dropped or (for getters) read
 *   with side effects, altering the hash in ways the plain record never
 *   intended. Arrays reject extra own properties beyond canonical indices.
 * - -0 is normalized to 0; strings are escaped via JSON.stringify semantics.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function canonicalStringify(value: unknown): string {
  return encode(value, new WeakSet<object>());
}

function encode(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          "cannot canonically serialize non-finite number",
        );
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      const object = value as object;
      if (ancestors.has(object)) {
        throw new CanonicalizationError(
          "cannot canonically serialize cyclic object",
        );
      }
      ancestors.add(object);
      try {
        if (Array.isArray(value)) {
          return encodeArray(value as unknown[], ancestors);
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new CanonicalizationError(
            "cannot canonically serialize non-plain object (class instances are not JSON)",
          );
        }
        return encodeRecord(value as Record<string, unknown>, ancestors);
      } finally {
        ancestors.delete(value as object);
      }
    }
    default:
      throw new CanonicalizationError(
        `cannot canonically serialize value of type ${describeType(value)}`,
      );
  }
}

function encodeArray(value: unknown[], ancestors: WeakSet<object>): string {
  // Index-wise encoding: holes in a sparse array resolve to undefined and fail
  // closed instead of being silently serialized as empty or null.
  const items: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) {
      throw new CanonicalizationError(
        `cannot canonically serialize sparse array (hole at index ${i})`,
      );
    }
    items.push(encode(value[i], ancestors));
  }
  // Any own property beyond the canonical indices (symbols, named props or
  // non-enumerable keys) would be silently dropped or alter hashing; reject.
  // "length" is the built-in non-enumerable own key and is not serialized.
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") {
      throw new CanonicalizationError(
        "cannot canonically serialize object with symbol-keyed property",
      );
    }
    if (!isCanonicalArrayIndex(key, value.length)) {
      throw new CanonicalizationError(
        "cannot canonically serialize array with non-index property",
      );
    }
    rejectAccessor(value, key, "array");
  }
  return `[${items.join(",")}]`;
}

function encodeRecord(
  value: Record<string, unknown>,
  ancestors: WeakSet<object>,
): string {
  const ownKeys = Reflect.ownKeys(value);
  const keys: string[] = [];
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      throw new CanonicalizationError(
        "cannot canonically serialize object with symbol-keyed property",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      throw new CanonicalizationError(
        "cannot canonically serialize object with unreadable property",
      );
    }
    if ("get" in descriptor || "set" in descriptor) {
      throw new CanonicalizationError(
        "cannot canonically serialize object with accessor property",
      );
    }
    if (!descriptor.enumerable) {
      throw new CanonicalizationError(
        "cannot canonically serialize object with non-enumerable property",
      );
    }
    keys.push(key);
  }
  keys.sort();
  const entries = keys.map((key) =>
    `${JSON.stringify(key)}:${encode(value[key], ancestors)}`
  );
  return `{${entries.join(",")}}`;
}

function rejectAccessor(
  value: object,
  key: PropertyKey,
  kind: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor !== undefined && ("get" in descriptor || "set" in descriptor)
  ) {
    throw new CanonicalizationError(
      `cannot canonically serialize ${kind} with accessor property`,
    );
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  // "0" .. "4294967294" style index that is also within the array length.
  if (key === "length") return false;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * SHA-256 over the canonical serialization, returned as unbranded lowercase
 * hex. Callers assign the exact brand with `as*Digest` from brands.ts; the
 * hash of one record is never a record's identity field by itself.
 */
export async function canonicalStringifySha256(
  value: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
