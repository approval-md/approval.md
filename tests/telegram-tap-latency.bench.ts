/**
 * The wall-clock half of APRV-206's evidence, opt-in (APRV-248).
 *
 * Run it deliberately, on a machine you are willing to believe:
 *
 * ```
 * npm run build && APPROVAL_BENCH=1 node --test dist/tests/telegram-tap-latency.bench.js
 * ```
 *
 * Two things keep it out of `npm test`, and both are load-bearing. The runner
 * (`scripts/run-tests.mjs`) discovers `*.test.js` and this file is not one, so
 * no shard, no `--only` set and no full run can pick it up by accident; and
 * without `APPROVAL_BENCH=1` every case here fails fast rather than measuring,
 * so a future glob that does find it still cannot turn a busy box into a red
 * suite.
 *
 * Why it is separated at all, stated plainly because the numbers below are real
 * and worth keeping: a millisecond ceiling asserted on a shared machine is a
 * measurement of the machine. The APRV-228 and APRV-225 lanes hit exactly that
 * on 2026-09-02 — timing-shaped cases that pass alone and fail beside another
 * lane's build — and a suite that goes red for the box is a suite people learn
 * to re-run without reading. The claims these cases make are asserted in
 * `tests/telegram-tap-latency.test.ts` as counts and orders, which hold at any
 * load; what lives here is the magnitude, which does not.
 *
 * A failure here is therefore a REPORT, not a verdict: read the numbers, check
 * what else the machine was doing, and only then suspect the code.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture, nextKey, tap, type Fixture } from "./tap-latency-harness.js";
import { assertClean, scratchRoot } from "./scenario.js";

/**
 * The opt-in. Checked inside each case rather than at import time so that the
 * file still loads (and still type-checks, and still gets built) in an ordinary
 * run, and so the refusal names itself instead of a stack.
 */
function requireOptIn(): void {
  assert.equal(
    process.env["APPROVAL_BENCH"],
    "1",
    "this is a benchmark, not a test: its assertions are wall-clock ceilings that measure " +
      "the machine as much as the code. Run it on purpose with APPROVAL_BENCH=1, and read " +
      "`tests/telegram-tap-latency.test.ts` for the load-proof form of the same claims.",
  );
}

const scratch = scratchRoot("telegram-tap-latency-bench");

const small = fixture(scratch.root, "small", 1_000);
const large = fixture(scratch.root, "large", 10_000);

test("BOUND: the ack lands within 300 ms on a 10k-record log (APRV-206)", async () => {
  requireOptIn();
  // Best of three: the claim is about the path, and one scheduling hiccup on a
  // loaded box is not the path.
  const runs: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    runs.push((await tap(large, nextKey(large), `n-bound-${String(index)}`)).ackMs);
  }
  const best = Math.min(...runs);
  assert.ok(
    best < 300,
    `ack took ${best.toFixed(1)} ms on a ${String(large.records)}-record log (runs: ${runs
      .map((value) => value.toFixed(1))
      .join(", ")})`,
  );
  assertClean(large.unit);
});

test("RATIO: the decision path is not linear in log length (APRV-206)", async () => {
  requireOptIn();
  // Ten times the records. This is a RATIO, not a bound: it says the decision
  // path does not re-verify the log per tap, and says nothing about how many
  // milliseconds either end takes on any particular machine.
  //
  // What the ceiling of 8 is measuring against, honestly stated. The tap no
  // longer re-walks the chain (no parse, no schema check, no digest per record);
  // what remains that touches log length is the verified-read cache's proof that
  // the prefix on disk is the prefix this process verified — one SHA-256 over
  // the file, ~3 ms at 10k records — plus the gate's own in-memory passes over
  // the record list (budgets, request derivation), ~2 ms. Measured on this
  // machine that is about 2.7 ms at 1k against 16-18 ms at 10k, a ratio near 6
  // under load, against the 10 a linear path would show. Making it flat needs an
  // incremental projection of gate state, which is a task of its own; removing
  // the prefix hash instead would defeat the cache's soundness argument
  // (`core/state.ts`, APRV-43) and is deliberately not done.
  //
  // Best of five per side: a min discards a scheduling spike without pretending
  // the spike did not happen.
  const times = async (unit: Fixture, label: string): Promise<number> => {
    const runs: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      runs.push((await tap(unit, nextKey(unit), `n-ratio-${label}-${String(index)}`)).decisionMs);
    }
    return Math.min(...runs);
  };

  const one = await times(small, "small");
  const ten = await times(large, "large");
  assert.ok(
    ten < one * 8,
    `the decision path scaled with the log: ${one.toFixed(1)} ms at ${String(
      small.records,
    )} records, ${ten.toFixed(1)} ms at ${String(large.records)}`,
  );
  assertClean(small.unit);
  assertClean(large.unit);
});
