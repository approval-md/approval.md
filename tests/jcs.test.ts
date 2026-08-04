/**
 * RFC 8785 (JCS) canonicalization tests (APRV-6 Part A).
 *
 * Expected strings are hardcoded literals, not recomputed from the
 * implementation — a canonicalizer that agrees with itself proves nothing. All
 * vectors are derivable by hand from RFC 8785 §3.2 and ECMAScript
 * `Number::toString`; nothing here was fetched from the network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalize, JcsError } from "../src/core/jcs.js";

test("primitives serialize to their JSON forms", () => {
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(false), "false");
  assert.equal(canonicalize("hi"), '"hi"');
  assert.equal(canonicalize(42), "42");
});

test("object keys sort by UTF-16 code units, not insertion order", () => {
  assert.equal(canonicalize({ b: 1, a: 2, C: 3 }), '{"C":3,"a":2,"b":1}');
  // Digits < uppercase < underscore < lowercase in ASCII/UTF-16 order.
  assert.equal(
    canonicalize({ zebra: 1, _under: 2, Apple: 3, "1st": 4 }),
    '{"1st":4,"Apple":3,"_under":2,"zebra":1}',
  );
});

test("empty keys and empty containers are handled", () => {
  assert.equal(canonicalize({}), "{}");
  assert.equal(canonicalize([]), "[]");
  assert.equal(canonicalize({ "": 1, a: 2 }), '{"":1,"a":2}');
});

test("key ordering is by code unit, so astral keys sort before U+FFFF", () => {
  // RFC 8785 §3.2.3 sorts UTF-16 code units. U+1F600 is the surrogate pair
  // D83D DE00 and U+10000 is D800 DC00; both lead units are *below* FFFF, so
  // they sort before a U+FFFF key — a code-point sort would put them after.
  // This is the classic JCS trap.
  const astral = "\u{1F600}";
  const bmpHigh = "￿";
  const linearB = "\u{10000}";
  const input: Record<string, number> = {};
  input[bmpHigh] = 1;
  input[astral] = 2;
  input[linearB] = 3;
  const out = canonicalize(input);
  const keyOrder = [...out.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((match) => match[1]);
  assert.deepEqual(keyOrder, [linearB, astral, bmpHigh]);
});

test("keys sharing a prefix order by the shorter string first", () => {
  assert.equal(canonicalize({ ab: 1, a: 2, abc: 3 }), '{"a":2,"ab":1,"abc":3}');
});

test("number serialization follows ECMAScript Number::toString", () => {
  assert.equal(canonicalize(0), "0");
  assert.equal(canonicalize(-0), "0", "RFC 8785: negative zero serializes as 0");
  assert.equal(canonicalize(1), "1");
  assert.equal(canonicalize(-1), "-1");
  assert.equal(canonicalize(0.1), "0.1");
  assert.equal(canonicalize(0.5), "0.5");
  assert.equal(canonicalize(100), "100");
  assert.equal(canonicalize(1e21), "1e+21");
  assert.equal(canonicalize(1e-7), "1e-7");
  assert.equal(canonicalize(1e-6), "0.000001");
  assert.equal(canonicalize(1e20), "100000000000000000000");
  assert.equal(canonicalize(9007199254740991), "9007199254740991");
  assert.equal(canonicalize(1.5e300), "1.5e+300");
  assert.equal(canonicalize(-1.5e-300), "-1.5e-300");
});

test("string escaping uses shortest forms and lowercase hex controls", () => {
  assert.equal(canonicalize('a"b'), '"a\\"b"');
  assert.equal(canonicalize("a\\b"), '"a\\\\b"');
  assert.equal(canonicalize("\b\t\n\f\r"), '"\\b\\t\\n\\f\\r"');
  assert.equal(canonicalize("\u0000"), '"\\u0000"');
  assert.equal(canonicalize("\u0007"), '"\\u0007"');
  assert.equal(canonicalize("\u001b"), '"\\u001b"');
  assert.equal(canonicalize("\u001f"), '"\\u001f"');
  // Solidus and DEL are NOT escaped; non-ASCII is emitted literally.
  assert.equal(canonicalize("/"), '"/"');
  assert.equal(canonicalize("\u007f"), '"\u007f"');
  assert.equal(canonicalize("é☑£"), '"é☑£"');
  assert.equal(canonicalize("\u{1F600}"), '"\u{1F600}"');
});

test("arrays keep their order and nest", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  assert.equal(
    canonicalize({ z: [{ b: 1, a: [true, null] }], a: "x" }),
    '{"a":"x","z":[{"a":[true,null],"b":1}]}',
  );
});

test("a nested record canonicalizes with every level sorted", () => {
  const input = {
    payload: { note: "go, but cc me", amount: 0.5, tags: ["b", "a"] },
    actor: "human:carter",
    seq: 17,
  };
  assert.equal(
    canonicalize(input),
    '{"actor":"human:carter","payload":{"amount":0.5,"note":"go, but cc me","tags":["b","a"]},"seq":17}',
  );
});

test("values JCS cannot represent are rejected, not coerced", () => {
  const cases: Array<[unknown, string]> = [
    [undefined, "undefined"],
    [Number.NaN, "non-finite-number"],
    [Number.POSITIVE_INFINITY, "non-finite-number"],
    [Number.NEGATIVE_INFINITY, "non-finite-number"],
    [10n, "bigint"],
    [() => 1, "function"],
    [Symbol("s"), "symbol"],
    [new Date(0), "unsupported-object"],
    [new Map(), "unsupported-object"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => canonicalize(value),
      (error: unknown) => error instanceof JcsError && error.code === code,
      `expected ${code} for ${String(value)}`,
    );
  }
});

test("rejection reaches into nested positions and reports a path", () => {
  assert.throws(
    () => canonicalize({ a: { b: [1, Number.NaN] } }),
    (error: unknown) =>
      error instanceof JcsError && error.code === "non-finite-number" && error.path === "/a/b/1",
  );
  assert.throws(
    () => canonicalize({ payload: { note: undefined } }),
    (error: unknown) => error instanceof JcsError && error.code === "undefined",
  );
});

test("cycles are refused rather than overflowing the stack", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  assert.throws(
    () => canonicalize(cyclic),
    (error: unknown) => error instanceof JcsError && error.code === "cycle",
  );
});

test("canonicalization is idempotent under JSON round-trip", () => {
  const input = { b: [1, { d: "é", c: 2 }], a: 0.1 };
  const once = canonicalize(input);
  assert.equal(canonicalize(JSON.parse(once)), once);
});
