/**
 * Monetary amounts in hashed material (APRV-121).
 *
 * ## The representation, and why
 *
 * Every USD amount that enters hashed material — an envelope's
 * `actions[].est_cost_usd` and `budget.max_cost_usd`, the `est_cost_usd` the
 * gate records on `approval.requested`, `approval.granted`, `execution.started`
 * and `budget.exceeded`, and the `est_cost_usd` an execution token binds to —
 * is a **decimal string**: `"0"`, `"0.02"`, `"1200.5"`. Not a JSON number.
 *
 * RFC 8785 pins ES6 number serialization, so a single TypeScript runtime is
 * internally consistent with itself. Cross-language it is not: the fast-path of
 * SPEC.md §13 and any second implementation must reproduce the same bytes from
 * the same value, and float formatting is precisely where that breaks. A
 * decimal string has one spelling, and every language agrees on it because
 * nobody has to reserialize anything.
 *
 * **String decimal, not integer minor units.** Both remove the float; the
 * choice is about what a human writes and reads. The field is named
 * `est_cost_usd` and a task author writes it in YAML frontmatter next to a
 * one-line summary; `est_cost_usd: "0.02"` still says two cents, while
 * `est_cost_usd: 20000` says nothing without knowing the exponent this project
 * picked, and picking one commits the format to a currency decision (USD has
 * two decimal places, other currencies do not) that the field name does not
 * make. The string also round-trips into and out of a channel message, a CLI
 * table, and a policy discussion without a conversion anyone can get wrong.
 *
 * ## The canonical form
 *
 * {@link USD_STRING_PATTERN}: an optional integer part with no leading zeros,
 * an optional fraction of one to six digits, no sign, no exponent, no trailing
 * dot, no trailing zeros beyond the last significant digit. One value, one
 * spelling — `"0.10"` and `"0.1"` cannot both be written, so two records
 * carrying the same amount always hash the same way.
 *
 * Six fractional digits is the resolution, matching the micro-USD unit the
 * arithmetic below runs in. It is far finer than any real amount and far
 * coarser than IEEE-754 drift.
 *
 * ## The arithmetic
 *
 * All budget arithmetic runs in **integer micro-USD**. A decimal string parses
 * to micros by integer string manipulation, never through a double, so no
 * rounding happens on the way in and none is possible on the way back out.
 * Sums, comparisons, and remainders are exact integers: `"0.1" + "0.2"` is
 * `"0.3"`, and a window of ten thousand two-cent actions is exactly `"200"`
 * rather than a value that depends on the order they were added in.
 *
 * ## Historical compatibility (SPEC.md §8, additive-change precedent)
 *
 * The log is append-only, so records written before this change carry JSON
 * numbers and must keep validating, verifying, and feeding budget math exactly
 * as before. Every reader here therefore accepts both forms: a decimal string
 * (the only form the write boundary now admits) and a finite non-negative JSON
 * number (the historical form). A historical number converts to micros by
 * `Math.round(value * 1e6)`, which is deterministic for every amount the old
 * write boundary could have admitted. The write boundary is the only place the
 * two forms are told apart: `schema/*.schema.json` types the fields as decimal
 * strings, and `validate(..., { mode: "historical" })` is the one documented
 * relaxation, used by the verifier and nothing else.
 */

/** Micro-USD per USD: the resolution of every amount in this module. */
export const USD_MICROS_SCALE = 1_000_000;

/** Fractional digits the canonical form admits (the micro-USD resolution). */
export const USD_FRACTION_DIGITS = 6;

/**
 * The canonical decimal-string form, as a JSON Schema `pattern` source.
 *
 * Exported so the schemas and the runtime cannot drift: `tests/money.test.ts`
 * asserts the schema files carry exactly this string.
 */
export const USD_STRING_PATTERN = "^(0|[1-9][0-9]*)(\\.[0-9]{0,5}[1-9])?$";

const CANONICAL = /^(0|[1-9][0-9]*)(\.([0-9]{0,5}[1-9]))?$/u;

/** Is `value` a canonical decimal USD string? */
export function isUsdString(value: unknown): value is string {
  return typeof value === "string" && CANONICAL.test(value);
}

/**
 * A canonical decimal string as integer micro-USD, or `null` when the string is
 * not canonical.
 *
 * Parsed by integer arithmetic on the digits: the fraction is padded to six
 * places and the two halves are combined, so the double never sees the value.
 */
export function usdStringToMicros(value: string): number | null {
  const match = CANONICAL.exec(value);
  if (match === null) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[3] ?? "").padEnd(USD_FRACTION_DIGITS, "0");
  const micros = Number(whole) * USD_MICROS_SCALE + Number(fraction);
  return Number.isSafeInteger(micros) ? micros : null;
}

/**
 * A historical JSON number as integer micro-USD, or `null` when it is not a
 * usable amount (non-finite, negative, or beyond the safe-integer range once
 * scaled).
 *
 * `Math.round` is the documented conversion. It is deterministic, and for every
 * value the pre-APRV-121 write boundary admitted (`minimum: 0`, ES6-serialized)
 * it lands on the micro the author wrote.
 */
export function usdNumberToMicros(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const micros = Math.round(value * USD_MICROS_SCALE);
  return Number.isSafeInteger(micros) ? micros : null;
}

/**
 * Either accepted form as integer micro-USD, or `null` when the value is not a
 * usable amount.
 *
 * This is the reader every enforcement path uses. It accepts the historical
 * number deliberately: a record already in the log must feed budget math
 * identically to before this change.
 */
export function usdToMicros(value: unknown): number | null {
  if (typeof value === "string") return usdStringToMicros(value);
  if (typeof value === "number") return usdNumberToMicros(value);
  return null;
}

/** Integer micro-USD as the canonical decimal string. */
export function microsToUsdString(micros: number): string {
  if (!Number.isFinite(micros)) return "0";
  const rounded = Math.round(micros);
  const negative = rounded < 0;
  const magnitude = Math.abs(rounded);
  const whole = Math.floor(magnitude / USD_MICROS_SCALE);
  const fraction = String(magnitude % USD_MICROS_SCALE)
    .padStart(USD_FRACTION_DIGITS, "0")
    .replace(/0+$/u, "");
  const text = fraction === "" ? String(whole) : `${String(whole)}.${fraction}`;
  // A negative amount is not a canonical value and never enters hashed
  // material; it exists only as budget headroom already spent, which the
  // verdict reports as a number rather than through this function.
  return negative ? `-${text}` : text;
}

/**
 * Integer micro-USD as a JSON number, for **display and CLI output only**.
 *
 * Never write the result of this function into hashed material: that is the
 * float this module exists to remove. Budget verdicts report through it because
 * a verdict is a rendered explanation of a decision the integers already made.
 */
export function microsToUsdNumber(micros: number): number {
  return Math.round(micros) / USD_MICROS_SCALE;
}

/**
 * Either accepted form as a canonical decimal string, or `null` when the value
 * is not a usable amount.
 *
 * The normalizer at every boundary where an amount arrives from outside: a task
 * envelope, a CLI flag, a historical log record.
 */
export function normalizeUsd(value: unknown): string | null {
  const micros = usdToMicros(value);
  return micros === null ? null : microsToUsdString(micros);
}

/**
 * Either accepted form as a canonical decimal string, defaulting to `"0"`.
 *
 * The budgets contract of `core/budgets.ts` requires `est_cost_usd` on every
 * consuming event, and an action that declared no cost is recorded as `"0"` —
 * an authorization with no declared cost is still an authorization.
 */
export function usdOrZero(value: unknown): string {
  return normalizeUsd(value) ?? "0";
}

/**
 * Either accepted form as a JSON number, for **display surfaces only**: a
 * channel card, a CLI table, a `--json` field a human reads.
 *
 * `0` for anything unusable, so a renderer never has to decide what to print
 * for a malformed amount. Same warning as {@link microsToUsdNumber}: the result
 * of this function must never be written into hashed material.
 */
export function usdNumber(value: unknown): number {
  return microsToUsdNumber(usdToMicros(value) ?? 0);
}

/**
 * Either accepted form as a JSON number, or `null` when there is no amount.
 *
 * The display counterpart of {@link normalizeUsd}: it keeps "declared nothing"
 * distinct from "declared zero", which is a distinction the queue's own columns
 * make.
 */
export function usdNumberOrNull(value: unknown): number | null {
  const micros = usdToMicros(value);
  return micros === null ? null : microsToUsdNumber(micros);
}

/** An amount as accepted from a caller: canonical string, or historical number. */
export type UsdInput = string | number;
