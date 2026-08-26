/**
 * Monetary representation and its arithmetic (APRV-121).
 *
 * Three things are pinned here, and they are the three the task exists for:
 *
 * 1. **The representation.** A USD amount in hashed material is a canonical
 *    decimal string, one value has one spelling, and the write boundary refuses
 *    the JSON number that used to be written there.
 * 2. **Historical compatibility.** Records written before the change carry
 *    numbers, and the log is append-only, so they must still validate, verify,
 *    hash to the digests they were frozen at, and feed budget math identically.
 *    The evidence is the repository's own committed log and the pre-APRV-121
 *    known-answer vectors, both read exactly as they are on disk.
 * 3. **The arithmetic.** Budget sums run in integer micro-USD, so a window of
 *    amounts that drift as IEEE-754 doubles adds up to the cent it should.
 *
 * Every record fed to the evaluator here is built through the real `appendEvent`
 * path, so nothing in this file proves a property of an object the write
 * boundary would have refused.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { evaluateBudgets, type BudgetScope } from "../src/core/budgets.js";
import {
  appendEvent,
  computeRecordHash,
  type EventInput,
  type EventRecord,
  type UnhashedRecord,
} from "../src/core/log.js";
import {
  isUsdString,
  microsToUsdString,
  normalizeUsd,
  usdOrZero,
  usdStringToMicros,
  usdToMicros,
  USD_MICROS_SCALE,
  USD_STRING_PATTERN,
} from "../src/core/money.js";
import { validate, WIDENED_DEFS } from "../src/core/validate.js";
import { verify } from "../src/core/verify.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA_DIR = join(REPO_ROOT, "schema");

const scratch = mkdtempSync(join(tmpdir(), "approval-md-money-"));
let scratchCounter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function log(...inputs: EventInput[]): EventRecord[] {
  scratchCounter += 1;
  const path = join(scratch, `log-${String(scratchCounter)}`, "events.jsonl");
  const records: EventRecord[] = [];
  for (const input of inputs) {
    const result = appendEvent(path, input);
    assert.equal(result.ok, true, `append failed: ${result.ok ? "" : result.error.message}`);
    if (result.ok) records.push(result.record);
  }
  return records;
}

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...segments), "utf8"));
}

// ---------------------------------------------------------------------------
// 1. The canonical form
// ---------------------------------------------------------------------------

test("the canonical form admits one spelling per value", () => {
  for (const value of ["0", "1", "0.5", "0.02", "1200.5", "0.000001", "999999"]) {
    assert.equal(isUsdString(value), true, `${value} should be canonical`);
    assert.equal(normalizeUsd(value), value, `${value} should round-trip unchanged`);
  }
});

test("every other spelling of a number is refused, so two records cannot disagree", () => {
  const refused = [
    "0.10", // a trailing zero is a second spelling of "0.1"
    "01", // a leading zero is a second spelling of "1"
    "+1", // a sign
    "-1", // money declared here is never negative
    ".5", // no integer part
    "1.", // no fraction after the point
    "1e3", // an exponent is the float notation, in a string costume
    "1_000",
    "0.1234567", // beyond the micro-USD resolution
    " 0.5",
    "0.5 ",
    "",
    "NaN",
  ];
  for (const value of refused) {
    assert.equal(isUsdString(value), false, `${value} should not be canonical`);
    assert.equal(usdStringToMicros(value), null, `${value} should not parse`);
  }
});

test("a decimal string parses to micros without passing through a double", () => {
  assert.equal(usdStringToMicros("0"), 0);
  assert.equal(usdStringToMicros("0.1"), 100_000);
  assert.equal(usdStringToMicros("0.000001"), 1);
  assert.equal(usdStringToMicros("1200.5"), 1_200_500_000);
  assert.equal(usdStringToMicros("25"), 25 * USD_MICROS_SCALE);
});

test("micros format back to the canonical spelling, trailing zeros trimmed", () => {
  assert.equal(microsToUsdString(0), "0");
  assert.equal(microsToUsdString(100_000), "0.1");
  assert.equal(microsToUsdString(20_000), "0.02");
  assert.equal(microsToUsdString(1), "0.000001");
  assert.equal(microsToUsdString(25_000_000), "25");
  // Headroom already spent is the one negative a verdict reports.
  assert.equal(microsToUsdString(-10_000), "-0.01");
});

test("an unusable amount is `null`, and `usdOrZero` names the fallback", () => {
  for (const value of [undefined, null, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
    assert.equal(normalizeUsd(value), null);
    assert.equal(usdOrZero(value), "0");
  }
});

test("the schemas and the CLI's frozen shapes carry the runtime's own pattern", () => {
  for (const name of ["envelope", "event"]) {
    const schema = readJson("schema", `${name}.schema.json`) as {
      $defs: Record<string, { pattern?: string }>;
    };
    assert.equal(
      schema.$defs["usd_amount_string"]?.pattern,
      USD_STRING_PATTERN,
      `${name}.schema.json drifted from core/money.ts`,
    );
    // Every widened definition names a replacement that actually exists, or a
    // historical validation would silently stay strict.
    for (const [strict, widened] of Object.entries(WIDENED_DEFS)) {
      assert.ok(schema.$defs[strict] !== undefined, `${name}.schema.json lost $defs.${strict}`);
      assert.ok(schema.$defs[widened] !== undefined, `${name}.schema.json lost $defs.${widened}`);
    }
  }
  const registry = readFileSync(join(REPO_ROOT, "src", "cli", "verb-registry.ts"), "utf8");
  assert.ok(
    registry.includes(JSON.stringify(USD_STRING_PATTERN)),
    "src/cli/verb-registry.ts no longer spells the canonical pattern the way core/money.ts does",
  );
});

// ---------------------------------------------------------------------------
// 2. The write boundary refuses the number
// ---------------------------------------------------------------------------

const NUMERIC_ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "awaiting",
  actions: [
    { class: "financial.spend", est_cost_usd: 0.02, idempotency_key: "task-042:refund" },
  ],
  budget: { max_cost_usd: 25 },
};

test("an envelope declaring a bare number is refused at the write boundary", () => {
  const result = validate("envelope", NUMERIC_ENVELOPE, { schemaDir: SCHEMA_DIR });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.deepEqual(
    result.errors.map((error) => error.path).sort(),
    ["/actions/0/est_cost_usd", "/budget/max_cost_usd"],
  );
});

test("the same envelope validates in historical mode, and only there", () => {
  assert.deepEqual(
    validate("envelope", NUMERIC_ENVELOPE, { schemaDir: SCHEMA_DIR, mode: "historical" }),
    { ok: true },
  );
  // The default is the strict boundary: a caller that names no mode gets the
  // schemas as written, never the relaxation.
  assert.equal(validate("envelope", NUMERIC_ENVELOPE, { schemaDir: SCHEMA_DIR }).ok, false);
});

test("a non-canonical string is refused in BOTH modes: widening is about the old form only", () => {
  const envelope = {
    ...NUMERIC_ENVELOPE,
    actions: [
      { class: "financial.spend", est_cost_usd: "0.020", idempotency_key: "task-042:refund" },
    ],
    budget: { max_cost_usd: "25" },
  };
  assert.equal(validate("envelope", envelope, { schemaDir: SCHEMA_DIR }).ok, false);
  assert.equal(
    validate("envelope", envelope, { schemaDir: SCHEMA_DIR, mode: "historical" }).ok,
    false,
  );
});

test("appendEvent refuses a payload amount that is a number", () => {
  scratchCounter += 1;
  const path = join(scratch, `refused-${String(scratchCounter)}`, "events.jsonl");
  const result = appendEvent(path, {
    ts: "2026-08-05T09:00:00Z",
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: "task-042:a",
    payload: { class: "financial.spend", est_cost_usd: 0.02 },
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "validation");
});

// ---------------------------------------------------------------------------
// 3. Historical compatibility
// ---------------------------------------------------------------------------

interface KnownAnswer {
  name: string;
  input: UnhashedRecord;
  expected_canonical: string;
  expected_hash: string;
}

const PRE_121 = readJson("schema", "fixtures", "hash", "known-answer-pre-121.json") as KnownAnswer[];

test("the pre-APRV-121 vectors still hash to the digests they were frozen at", () => {
  // The hash scheme did not change; the type of one value did. A record written
  // under the old scheme therefore still digests to exactly what the log says,
  // which is what makes every historical chain still verifiable.
  for (const vector of PRE_121) {
    assert.equal(computeRecordHash(vector.input), vector.expected_hash, vector.name);
  }
});

test("the pre-APRV-121 record with a numeric amount validates on read and is refused on write", () => {
  const numeric = PRE_121.find((vector) => vector.name === "chained-approval-requested");
  assert.ok(numeric !== undefined, "the frozen pre-121 vectors lost the record with an amount");
  const record = { ...numeric.input, hash: numeric.expected_hash };
  assert.deepEqual(
    validate("event", record, { schemaDir: SCHEMA_DIR, mode: "historical" }),
    { ok: true },
  );
  const strict = validate("event", record, { schemaDir: SCHEMA_DIR });
  assert.equal(strict.ok, false);
  if (strict.ok) throw new Error("unreachable");
  assert.deepEqual(
    strict.errors.map((error) => error.path),
    ["/payload/est_cost_usd"],
  );
});

test("this repository's own committed log, written under the float scheme, still verifies", () => {
  // The corpus is not a fixture anyone wrote for this test: it is the project's
  // live append-only log, three hundred of whose records carry `est_cost_usd`
  // as a JSON number. Read-only, exactly as `approval log verify` reads it.
  const logPath = join(REPO_ROOT, ".approval", "log", "events.jsonl");
  const result = verify(logPath, { schemaDir: SCHEMA_DIR });
  assert.equal(result.status, "clean", `the committed log stopped verifying: ${result.status}`);
});

test("historical amounts feed budget math exactly as the strings do", () => {
  const asString = log({
    ts: "2026-08-05T09:00:00Z",
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: "task-042:a",
    payload: { class: "financial.spend", est_cost_usd: "1.25" },
  });
  // The historical twin cannot be appended (the write boundary refuses it), so
  // it is read the way a verifier reads a line already in the log.
  const historical: EventRecord[] = asString.map((record) => ({
    ...record,
    payload: { class: "financial.spend", est_cost_usd: 1.25 },
  }));

  const scope: BudgetScope = {
    classLimits: { daily_usd: 10 },
    classPattern: "financial.*",
    globalBudgets: null,
  };
  const action = { class: "financial.spend", est_cost_usd: "0.75" };
  assert.deepEqual(
    evaluateBudgets(historical, scope, action, "2026-08-05T12:00:00Z"),
    evaluateBudgets(asString, scope, action, "2026-08-05T12:00:00Z"),
  );
  assert.equal(usdToMicros(1.25), usdToMicros("1.25"));
});

// ---------------------------------------------------------------------------
// 4. The arithmetic
// ---------------------------------------------------------------------------

/** A grant of `cost` (canonical string) at `ts`. */
function grant(cost: string, ts: string, key: string): EventInput {
  return {
    ts,
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: key,
    payload: { class: "financial.spend", est_cost_usd: cost },
  };
}

const CLASS_SCOPE: BudgetScope = {
  classLimits: { daily_usd: 100 },
  classPattern: "financial.*",
  globalBudgets: null,
};

const EVAL_TS = "2026-08-05T12:00:00Z";

test("0.1 + 0.2 is 0.3, which as doubles it is not", () => {
  const records = log(
    grant("0.1", "2026-08-05T09:00:00Z", "task-042:a"),
    grant("0.2", "2026-08-05T10:00:00Z", "task-042:b"),
  );
  const result = evaluateBudgets(records, CLASS_SCOPE, { class: "financial.spend" }, EVAL_TS);
  const daily = result.verdicts.find((entry) => entry.limit === "daily_usd");
  assert.equal(daily?.consumed, "0.3");
  assert.equal(0.1 + 0.2 === 0.3, false, "the double sum this avoids");
});

test("a window of a thousand cents sums to exactly ten dollars", () => {
  const inputs: EventInput[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const minute = new Date(Date.parse(EVAL_TS) - (index + 1) * 60_000).toISOString();
    inputs.push(grant("0.01", minute, `task-042:cent-${String(index)}`));
  }
  const records = log(...inputs);
  const result = evaluateBudgets(records, CLASS_SCOPE, { class: "financial.spend" }, EVAL_TS);
  const daily = result.verdicts.find((entry) => entry.limit === "daily_usd");
  assert.equal(daily?.consumed, "10");
  assert.equal(daily?.remaining, "90");

  // The same thousand amounts added as doubles do not land on 10.
  let drifted = 0;
  for (let index = 0; index < 1000; index += 1) drifted += 0.01;
  assert.equal(drifted === 10, false, "the double sum this avoids");
});

test("the boundary is exact: the cent that fits passes and the micro over it fails", () => {
  const records = log(grant("99.99", "2026-08-05T09:00:00Z", "task-042:a"));
  const exact = evaluateBudgets(
    records,
    CLASS_SCOPE,
    { class: "financial.spend", est_cost_usd: "0.01" },
    EVAL_TS,
  );
  assert.equal(exact.pass, true);
  assert.equal(exact.verdicts.find((entry) => entry.limit === "daily_usd")?.remaining, "0");

  const over = evaluateBudgets(
    records,
    CLASS_SCOPE,
    { class: "financial.spend", est_cost_usd: "0.010001" },
    EVAL_TS,
  );
  assert.equal(over.pass, false);
  assert.equal(
    over.verdicts.find((entry) => entry.limit === "daily_usd")?.remaining,
    "-0.000001",
  );
});

test("a fractional policy ceiling is pinned to a micro once, before any comparison", () => {
  const records = log(grant("0.1", "2026-08-05T09:00:00Z", "task-042:a"));
  const scope: BudgetScope = {
    classLimits: { daily_usd: 0.3 },
    classPattern: "financial.*",
    globalBudgets: null,
  };
  const result = evaluateBudgets(
    records,
    scope,
    { class: "financial.spend", est_cost_usd: "0.2" },
    EVAL_TS,
  );
  assert.equal(result.pass, true);
  assert.equal(result.verdicts.find((entry) => entry.limit === "daily_usd")?.remaining, "0");
});

test("verdict figures are strings, so a budget.exceeded payload carries no float", () => {
  const records = log(grant("0.1", "2026-08-05T09:00:00Z", "task-042:a"));
  const result = evaluateBudgets(
    records,
    CLASS_SCOPE,
    { class: "financial.spend", est_cost_usd: "0.2" },
    EVAL_TS,
  );
  for (const verdict of result.verdicts) {
    assert.equal(typeof verdict.consumed, "string");
    assert.equal(typeof verdict.requested, "string");
    assert.equal(typeof verdict.remaining, "string");
  }
  // And the whole verdict list survives the write boundary as a payload.
  scratchCounter += 1;
  const path = join(scratch, `verdicts-${String(scratchCounter)}`, "events.jsonl");
  const appended = appendEvent(path, {
    ts: EVAL_TS,
    event: "budget.exceeded",
    actor: "agent:claude",
    task: "task-042",
    action_key: "task-042:a",
    payload: { class: "financial.spend", est_cost_usd: "0.2", verdicts: result.verdicts },
  });
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
});
