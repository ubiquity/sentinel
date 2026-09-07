// Deterministic canonical JSON serialization: sorted keys, stable escapes,
// rejection of non-JSON-safe values, and the committed determinism fixture.
import assert from "node:assert/strict";

import {
  CanonicalizationError,
  canonicalStringify,
  canonicalStringifySha256,
} from "../../src/contracts/canonical.ts";

Deno.test("canonical stringify sorts object keys recursively and preserves array order", () => {
  const a = { b: 1, a: { y: 2, x: 3 }, list: ["b", "a"] };
  const b = { list: ["b", "a"], a: { x: 3, y: 2 }, b: 1 };
  assert.equal(canonicalStringify(a), canonicalStringify(b));
  assert.equal(
    canonicalStringify(a),
    '{"a":{"x":3,"y":2},"b":1,"list":["b","a"]}',
  );
});

Deno.test("canonical stringify is deterministic for scalars and unicode", () => {
  assert.equal(canonicalStringify("café ☕"), JSON.stringify("café ☕"));
  assert.equal(canonicalStringify(0.5), "0.5");
  assert.equal(canonicalStringify(true), "true");
  assert.equal(canonicalStringify(null), "null");
  assert.equal(canonicalStringify(-0), "0");
});

Deno.test("canonical stringify rejects values JSON cannot represent", () => {
  assert.throws(() => canonicalStringify(undefined), CanonicalizationError);
  assert.throws(() => canonicalStringify(NaN), CanonicalizationError);
  assert.throws(() => canonicalStringify(Infinity), CanonicalizationError);
  assert.throws(
    () => canonicalStringify({ a: undefined }),
    CanonicalizationError,
  );
  assert.throws(() => canonicalStringify([undefined]), CanonicalizationError);
  assert.throws(
    () => canonicalStringify({ f: () => 0 }),
    CanonicalizationError,
  );
  assert.throws(() => canonicalStringify(10n), CanonicalizationError);
  assert.throws(() => canonicalStringify(new Map()), CanonicalizationError);
  // sparse arrays must not serialize holes as empty strings
  const sparse: unknown[] = [1];
  sparse.length = 3;
  assert.throws(() => canonicalStringify(sparse), CanonicalizationError);
  // [ , ] (one hole) is not the same as []: it must fail, not serialize as []
  const hole: unknown[] = [];
  hole.length = 1;
  assert.throws(() => canonicalStringify(hole), CanonicalizationError);
  assert.throws(() => canonicalStringify(new Date()), CanonicalizationError);
});

Deno.test("canonical stringify rejects cycles with CanonicalizationError, not a stack overflow", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => canonicalStringify(cyclic), CanonicalizationError);
  const nested: Record<string, unknown> = { list: [] };
  (nested.list as unknown[]).push(nested);
  assert.throws(() => canonicalStringify(nested), CanonicalizationError);
  const pairA: Record<string, unknown> = {};
  const pairB: Record<string, unknown> = {};
  pairA.b = pairB;
  pairB.a = pairA;
  assert.throws(() => canonicalStringify(pairA), CanonicalizationError);
  // A repeated (non-cyclic shared) reference is fine; only cycles fail.
  const shared = { x: 1 };
  assert.equal(
    canonicalStringify({ a: shared, b: shared }),
    '{"a":{"x":1},"b":{"x":1}}',
  );
});

Deno.test("canonical stringify never silently drops or reads symbol/accessor properties", () => {
  const withSymbol: Record<string | symbol, unknown> = { a: 1 };
  withSymbol[Symbol("hidden")] = 2;
  assert.throws(() => canonicalStringify(withSymbol), CanonicalizationError);

  const withAccessor: Record<string, unknown> = {};
  Object.defineProperty(withAccessor, "a", {
    enumerable: true,
    get: () => 42,
  });
  assert.throws(() => canonicalStringify(withAccessor), CanonicalizationError);

  const withNonEnumerable: Record<string, unknown> = {};
  Object.defineProperty(withNonEnumerable, "a", {
    value: 1,
    enumerable: false,
  });
  assert.throws(
    () => canonicalStringify(withNonEnumerable),
    CanonicalizationError,
  );
});

Deno.test("canonical stringify rejects array extra properties and symbol keys", () => {
  const withProp = [1, 2] as unknown[];
  (withProp as unknown as Record<string, unknown>).extra = "x";
  assert.throws(() => canonicalStringify(withProp), CanonicalizationError);
  const withArraySymbol = [1, 2] as unknown[];
  (withArraySymbol as unknown as Record<string | symbol, unknown>)[
    Symbol("s")
  ] = 3;
  assert.throws(
    () => canonicalStringify(withArraySymbol),
    CanonicalizationError,
  );
});

Deno.test("committed canonical determinism fixture parses to the recorded form", async () => {
  const input = JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/contracts/canonical/input.json", import.meta.url),
    ),
  );
  const expected = await Deno.readTextFile(
    new URL("../fixtures/contracts/canonical/expected.txt", import.meta.url),
  );
  assert.equal(canonicalStringify(input), expected.trim());
});

Deno.test("canonical SHA-256 is stable across repeated calls", async () => {
  const value = { repo: "ubiquity/ai.ubq.fi", revision: "v1" };
  const first = await canonicalStringifySha256(value);
  const second = await canonicalStringifySha256(value);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  const other = await canonicalStringifySha256({
    repo: "ubiquity/ai.ubq.fi",
    revision: "v2",
  });
  assert.notEqual(first, other);
});
