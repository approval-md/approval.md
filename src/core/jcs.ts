/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * SPEC.md §8 fixes the hash scheme at `sha256/jcs`: SHA-256 over the RFC 8785
 * canonical serialization of an event record with `prev` included. The digest
 * is a permanent wire commitment, so this module is part of the deterministic
 * core: same input, same bytes, forever. No clock, no locale, no randomness,
 * no configuration knobs.
 *
 * Implemented by hand — zero dependencies (CLAUDE.md: minimal dependencies,
 * and a canonicalizer is exactly the kind of code that must not drift beneath
 * us). Three rules do all the work:
 *
 * 1. **Object keys** are sorted by their UTF-16 code units (RFC 8785 §3.2.3).
 *    That is JavaScript's own `<` on strings, which is why a naive code-point
 *    sort is *wrong*: a key starting U+10000 (surrogate pair D800 DC00) sorts
 *    *before* a key starting U+FFFF under code units and *after* it under code
 *    points. The comparator below is deliberately code-unit based.
 * 2. **Numbers** use ECMAScript `Number::toString` (RFC 8785 §3.2.2.3), which
 *    is precisely what `JSON.stringify` emits for a finite number — including
 *    `1e+21`, `1e-7`, and `-0` collapsing to `0`. Delegating is not a shortcut
 *    around the RFC; the RFC's normative reference *is* the ECMAScript
 *    algorithm.
 * 3. **Strings** use the ECMAScript `QuoteJSONString` escaping (RFC 8785
 *    §3.2.2.2): shortest form for `\b \t \n \f \r \" \\`, `\u00xx` with
 *    lowercase hex for the remaining C0 controls, and every other code point
 *    literal. `JSON.stringify` on a string implements exactly this, including
 *    the well-formed-stringify escaping of lone surrogates (ES2019+).
 *
 * Everything JCS cannot represent is rejected loudly rather than coerced:
 * `undefined`, functions, symbols, `BigInt`, `NaN`, `±Infinity`, and non-plain
 * objects (a `Date` or `Map` would silently canonicalize to `{}`). Silent
 * coercion in a hash input is a tamper-evidence hole, so this module fails
 * closed by throwing {@link JcsError}.
 */

/** Reason a value could not be canonicalized. */
export type JcsErrorCode =
  | "undefined"
  | "function"
  | "symbol"
  | "bigint"
  | "non-finite-number"
  | "unsupported-object"
  | "cycle";

/** Thrown when a value has no RFC 8785 canonical form. */
export class JcsError extends Error {
  /** Machine-readable reason. */
  readonly code: JcsErrorCode;
  /** JSON Pointer-ish location of the offending value ("" for the root). */
  readonly path: string;

  constructor(code: JcsErrorCode, path: string, message: string) {
    super(message);
    this.name = "JcsError";
    this.code = code;
    this.path = path;
  }
}

/**
 * RFC 8785 §3.2.3 key ordering: lexicographic over UTF-16 code units.
 * `<`/`>` on JS strings compare code units, which is the required order.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const tag = Object.prototype.toString.call(value);
  return tag.slice(8, -1).toLowerCase();
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number": {
      if (!Number.isFinite(value)) {
        throw new JcsError(
          "non-finite-number",
          path,
          `JCS cannot serialize the non-finite number ${String(value)} at ${path || "<root>"}`,
        );
      }
      // ECMAScript Number::toString; `-0` becomes "0" exactly as RFC 8785 §3.2.2.3 requires.
      return JSON.stringify(value);
    }

    case "string":
      // ECMAScript QuoteJSONString: shortest escapes, lowercase \u00xx controls.
      return JSON.stringify(value);

    case "undefined":
      throw new JcsError(
        "undefined",
        path,
        `JCS has no representation for undefined at ${path || "<root>"}`,
      );

    case "function":
      throw new JcsError(
        "function",
        path,
        `JCS has no representation for a function at ${path || "<root>"}`,
      );

    case "symbol":
      throw new JcsError(
        "symbol",
        path,
        `JCS has no representation for a symbol at ${path || "<root>"}`,
      );

    case "bigint":
      throw new JcsError(
        "bigint",
        path,
        `JCS has no representation for a BigInt at ${path || "<root>"} (JSON numbers are IEEE 754 doubles)`,
      );

    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new JcsError("cycle", path, `cyclic reference at ${path || "<root>"}`);
  }

  if (Array.isArray(object)) {
    seen.add(object);
    // RFC 8785 §3.2.1: array element order is preserved, never sorted.
    const parts = (object as unknown[]).map((element, index) =>
      serialize(element, `${path}/${index}`, seen),
    );
    seen.delete(object);
    return `[${parts.join(",")}]`;
  }

  if (!isPlainObject(object)) {
    throw new JcsError(
      "unsupported-object",
      path,
      `JCS cannot serialize a ${describe(object)} at ${path || "<root>"}; convert it to plain JSON data first`,
    );
  }

  seen.add(object);
  const record = object as Record<string, unknown>;
  // Own enumerable string keys only; symbol keys are not JSON data.
  const keys = Object.keys(record).sort(compareCodeUnits);
  const members: string[] = [];
  for (const key of keys) {
    const serialized = serialize(record[key], `${path}/${key}`, seen);
    members.push(`${JSON.stringify(key)}:${serialized}`);
  }
  seen.delete(object);
  return `{${members.join(",")}}`;
}

/**
 * Canonicalize `value` to its RFC 8785 (JCS) serialization: sorted object
 * keys, no whitespace, ECMAScript number and string formatting.
 *
 * @throws {JcsError} if the value contains anything JCS cannot represent.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "", new Set<object>());
}
