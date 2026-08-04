/**
 * Official RFC 8785 test material, embedded verbatim.
 *
 * Source: RFC 8785, "JSON Canonicalization Scheme (JCS)"
 *         https://www.rfc-editor.org/rfc/rfc8785
 *
 *   §3.2.2   "Serialization of Literals / Strings / Numbers" — the full
 *            input example (numbers, escaped string, literals).
 *   §3.2.3   "Sorting of Object Properties" — the seven-key sorting example
 *            and its canonical output.
 *   §3.2.4   "UTF-8 Generation" — the byte-level expected output for the
 *            §3.2.2 example, reproduced here as the hex dump printed in the
 *            RFC. Bytes, not display text, are what the digest commits to,
 *            so this is the strongest available pin on our serializer.
 *   Appx. B  "Number Serialization Samples" — IEEE 754 bit patterns paired
 *            with their required ECMAScript serializations, including the
 *            round-to-even and boundary cases.
 *
 * Values below are transcribed as published: input JSON is kept as *source
 * text* (in `String.raw` templates, so the RFC's own `\uXXXX` escapes survive
 * to `JSON.parse` rather than being re-encoded by hand), and Appendix B
 * doubles are reconstructed from their bit patterns rather than retyped as
 * decimal literals — retyping would test the TypeScript lexer, not our
 * serializer.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { canonicalize, JcsError } from "../src/core/jcs.js";

/* ------------------------------------------------------------------ *
 * Group 1 — RFC 8785 §3.2.3, sorting of object properties.
 * ------------------------------------------------------------------ */

/** RFC 8785 §3.2.3 input, verbatim (escapes preserved via String.raw). */
const SORTING_INPUT_SOURCE = String.raw`{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}`;

/** RFC 8785 §3.2.3 canonical output, given as the resulting value order. */
const SORTING_EXPECTED_VALUE_ORDER = [
  "Carriage Return",
  "One",
  "Control",
  "Latin Small Letter O With Diaeresis",
  "Euro Sign",
  "Emoji: Grinning Face",
  "Hebrew Letter Dalet With Dagesh",
];

/** The same ordering expressed as keys: U+000D, "1", U+0080, U+00F6, U+20AC, U+1F600, U+FB33. */
const SORTING_EXPECTED_KEY_ORDER = [
  "\r",
  "1",
  "\u0080",
  "ö",
  "€",
  "\u{1f600}",
  "דּ",
];

test("RFC 8785 §3.2.3: properties sort into the published order", () => {
  const input: unknown = JSON.parse(SORTING_INPUT_SOURCE);
  const canonical = canonicalize(input);

  // Read the order off the canonical *text*. Re-parsing it into an object
  // would hide the answer: ECMAScript re-orders integer-like keys ("1")
  // ahead of the rest on any plain object, which is exactly why the property
  // order of a parsed result proves nothing about the serialization.
  const keys = [...canonical.matchAll(/(?:^\{|,)("(?:[^"\\]|\\.)*"):/g)].map(
    (match) => JSON.parse(match[1] as string) as string,
  );
  const values = [...canonical.matchAll(/:"([^"\\]*)"/g)].map((match) => match[1]);

  assert.deepEqual(values, SORTING_EXPECTED_VALUE_ORDER);
  assert.deepEqual(keys, SORTING_EXPECTED_KEY_ORDER);
});

test("RFC 8785 §3.2.3: sorting is stable regardless of input order", () => {
  const input = JSON.parse(SORTING_INPUT_SOURCE) as Record<string, string>;
  // Re-insert the same members in reverse; canonicalization must not care.
  const reversed: Record<string, string> = {};
  for (const key of Object.keys(input).reverse()) {
    reversed[key] = input[key] as string;
  }
  assert.equal(canonicalize(reversed), canonicalize(input));
});

/* ------------------------------------------------------------------ *
 * Group 2 — RFC 8785 §3.2.2 example, pinned by its §3.2.4 UTF-8 bytes.
 * ------------------------------------------------------------------ */

/** RFC 8785 §3.2.2 input, verbatim (escapes preserved via String.raw). */
const FULL_EXAMPLE_SOURCE = String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000f\nA'B\"\\\\\"\/","literals":[null,true,false]}`;

/**
 * RFC 8785 §3.2.4, the published UTF-8 byte sequence of the canonical output
 * for the §3.2.2 example. Transcribed exactly as printed; whitespace between
 * octets is stripped before comparison.
 */
const FULL_EXAMPLE_EXPECTED_HEX = `
7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72 75 65 2c
66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a 5b 33 33 33 33 33
33 33 33 33 2e 33 33 33 33 33 33 33 2c 31 65 2b 33 30 2c 34 2e 35 2c
30 2e 30 30 32 2c 31 65 2d 32 37 5d 2c 22 73 74 72 69 6e 67 22 3a 22
e2 82 ac 24 5c 75 30 30 30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22
2f 22 7d
`;

/**
 * The same canonical output as printable text, for human review: sorted
 * members, renormalized numbers (333333333.3333333, 1e+30, 4.5, 0.002,
 * 1e-27), a lowercase `\\u000f` escape for the C0 control, a short `\\n`, doubled
 * backslashes preserved, and an *unescaped* solidus.
 */
const FULL_EXAMPLE_EXPECTED_TEXT =
  '{"literals":[null,true,false],' +
  '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
  '"string":"€$' +
  String.raw`\u000f\nA'B\"\\\\\"` +
  '/"}';

test("RFC 8785 §3.2.2/§3.2.4: the example canonicalizes to the published UTF-8 bytes", () => {
  const input: unknown = JSON.parse(FULL_EXAMPLE_SOURCE);
  const actualHex = Buffer.from(canonicalize(input), "utf8").toString("hex");
  assert.equal(actualHex, FULL_EXAMPLE_EXPECTED_HEX.replace(/\s+/g, ""));
});

test("RFC 8785 §3.2.2: the printable canonical form matches the published text", () => {
  const input: unknown = JSON.parse(FULL_EXAMPLE_SOURCE);
  const canonical = canonicalize(input);

  assert.equal(canonical, FULL_EXAMPLE_EXPECTED_TEXT);
  // The two published representations must describe the same bytes.
  assert.equal(
    Buffer.from(FULL_EXAMPLE_EXPECTED_TEXT, "utf8").toString("hex"),
    FULL_EXAMPLE_EXPECTED_HEX.replace(/\s+/g, ""),
  );
  // Round-tripping the canonical form is a fixed point.
  assert.equal(canonicalize(JSON.parse(canonical)), canonical);
});

/* ------------------------------------------------------------------ *
 * Group 3 — RFC 8785 Appendix B, number serialization samples.
 * ------------------------------------------------------------------ */

/** Reconstruct the exact double named by an IEEE 754 hex bit pattern. */
function doubleFromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

/** RFC 8785 Appendix B, transcribed verbatim: [bit pattern, expected output, RFC comment]. */
const APPENDIX_B: Array<[string, string, string]> = [
  ["0000000000000000", "0", "zero"],
  ["8000000000000000", "0", "minus zero"],
  ["0000000000000001", "5e-324", "min positive subnormal"],
  ["8000000000000001", "-5e-324", "min negative subnormal"],
  ["7fefffffffffffff", "1.7976931348623157e+308", "max positive"],
  ["ffefffffffffffff", "-1.7976931348623157e+308", "max negative"],
  ["4340000000000000", "9007199254740992", "max positive safe integer"],
  ["c340000000000000", "-9007199254740992", "max negative safe integer"],
  ["4430000000000000", "295147905179352830000", "integer boundary"],
  ["44b52d02c7e14af5", "9.999999999999997e+22", "just below 1e+23"],
  ["44b52d02c7e14af6", "1e+23", "1e+23"],
  ["44b52d02c7e14af7", "1.0000000000000001e+23", "just above 1e+23"],
  ["444b1ae4d6e2ef4e", "999999999999999700000", "just below 1e+21"],
  ["444b1ae4d6e2ef4f", "999999999999999900000", "just below 1e+21"],
  ["444b1ae4d6e2ef50", "1e+21", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7", "just below 0.000001"],
  ["3eb0c6f7a0b5ed8d", "0.000001", "0.000001"],
  ["41b3de4355555553", "333333333.3333332", "underflow"],
  ["41b3de4355555554", "333333333.33333325", "underflow"],
  ["41b3de4355555555", "333333333.3333333", "underflow"],
  ["41b3de4355555556", "333333333.3333334", "underflow"],
  ["41b3de4355555557", "333333333.33333343", "underflow"],
  ["becbf647612f3696", "-0.0000033333333333333333", "negative"],
  ["43143ff3c1cb0959", "1424953923781206.2", "round to even"],
];

for (const [bits, expected, note] of APPENDIX_B) {
  test(`RFC 8785 Appendix B: ${bits} serializes as ${expected} (${note})`, () => {
    assert.equal(canonicalize(doubleFromBits(bits)), expected);
  });
}

test("RFC 8785 Appendix B: every sample keeps its form inside a containing array", () => {
  const values = APPENDIX_B.map(([bits]) => doubleFromBits(bits));
  const expected = `[${APPENDIX_B.map(([, output]) => output).join(",")}]`;
  assert.equal(canonicalize(values), expected);
});

/**
 * RFC 8785 Appendix B also lists the two bit patterns that have no JSON
 * number form. The RFC requires them to be rejected; our canonicalizer fails
 * closed with a typed error rather than emitting `null`, which is what
 * `JSON.stringify` would do.
 */
const APPENDIX_B_NON_VALUES: Array<[string, string]> = [
  ["7fffffffffffffff", "NaN"],
  ["7ff0000000000000", "Infinity"],
];

for (const [bits, note] of APPENDIX_B_NON_VALUES) {
  test(`RFC 8785 Appendix B: ${bits} (${note}) has no canonical form and is rejected`, () => {
    const value = doubleFromBits(bits);
    assert.ok(!Number.isFinite(value));
    assert.throws(
      () => canonicalize(value),
      (error: unknown) => error instanceof JcsError && error.code === "non-finite-number",
    );
  });
}
