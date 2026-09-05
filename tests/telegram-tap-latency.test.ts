/**
 * What one tap costs, at 1k records and at 10k (APRV-206), asserted structurally.
 *
 * The complaint this suite pins: the grant/reject buttons used to stop spinning
 * at once and grew to 1-3 s as this repository's own log went from ~5,200
 * records to ~8,400 in a day. The cause was structural rather than accidental —
 * since APRV-196 the single `answerCallbackQuery` was sent AFTER the decision
 * branch finished, so everything the gate does (read the verified log, re-check
 * the budgets, append under the lock) sat in front of the human's spinner, and
 * the parts of it that scale with the log therefore scaled the spinner.
 *
 * **Where the milliseconds went (APRV-248).** This file used to carry two
 * wall-clock claims as well: a BOUND (the ack lands within 300 ms on a
 * 10k-record log) and a RATIO (the decision path costs less than 8x more at 10k
 * than at 1k). Both are true, both are worth measuring, and neither is a
 * property of the code on a machine running fifteen other things: under load
 * they measure the machine, go red for it, and teach every lane to re-run rather
 * than to read. They now live in `tests/telegram-tap-latency.bench.ts`, which
 * `npm test` never discovers and which refuses to run without `APPROVAL_BENCH=1`.
 *
 * What is left here asserts the same two claims by COUNTING rather than by
 * timing, which is what makes them load-proof:
 *
 * - the ack does not wait on the gate, stated as the ORDER of the Bot API calls
 *   one tap makes and as the log's line count at the instant the ack was sent;
 * - the decision path does not scale with the log, stated as the verified-read
 *   work one tap does: identical at 1k records and at 10k, with no read from
 *   genesis at either size. A path that re-verified the chain per tap would show
 *   a miss, and a path that read more of a longer log would show more reads. Ten
 *   times the records, the same counters.
 *
 * The rest was always structural: that the ack REACHES the Bot API before the
 * decision is appended (checked by counting the log's lines from inside the
 * stubbed call), that it claims no decision, and that there is exactly one per
 * callback.
 *
 * No network: the Bot API is a stub function, and `assertLocal` still guards the
 * base URL the channel is given. Both live in `tests/tap-latency-harness.ts`,
 * which builds the fixtures and drives one tap for this file and for the
 * benchmark, so the two halves measure the same thing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TELEGRAM_ACK_HEARD } from "../src/channels/telegram.js";
import { processReadCache } from "../src/core/state.js";
import { fixture, lineCount, nextKey, tap, type Fixture } from "./tap-latency-harness.js";
import { assertClean, scratchRoot } from "./scenario.js";

const scratch = scratchRoot("telegram-tap-latency");

// The two fixtures, built once and shared: building them is the expensive part
// of this file, and every case below reads them without writing anything but
// its own decision.
const small = fixture(scratch.root, "small", 1_000);
const large = fixture(scratch.root, "large", 10_000);

test("the fixtures are the sizes the claims are about", () => {
  assert.ok(small.records >= 1_000, `small fixture is ${String(small.records)} records`);
  assert.ok(large.records >= 10_000, `large fixture is ${String(large.records)} records`);
  assert.ok(
    large.records >= small.records * 9,
    "the two fixtures must differ by about an order of magnitude for the comparison to mean anything",
  );
});

test("a tap is acked before the decision is appended, and the ack claims none (APRV-206)", async () => {
  const before = lineCount(large.unit.logPath);
  const measured = await tap(large, nextKey(large), "n-order");

  // Structural, not timed: the log had not grown when the ack was sent, and it
  // had by the time the poll returned. The ack is therefore in front of the
  // append rather than merely fast.
  assert.equal(measured.recordsAtAck, before, "the ack was sent after the decision was appended");
  assert.equal(measured.recordsAfter, before + 1, "the tap appended no decision");

  const acks = measured.calls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(acks.length, 1, "APRV-196: exactly one answerCallbackQuery per callback");
  const text = String(acks[0]?.body["text"] ?? "");
  assert.equal(text, TELEGRAM_ACK_HEARD);
  assert.doesNotMatch(
    text,
    /approved|granted|rejected|recorded in the log/iu,
    "the ack must not claim a decision that had not been appended when it was sent",
  );

  // And the outcome still follows, on the message, from the appended record.
  const edit = measured.calls.filter((call) => call.method === "editMessageText").at(-1);
  assert.match(String(edit?.body["text"] ?? ""), /APPROVED/u);
  assertClean(large.unit);
});

test("SEQUENCE: the ack is the first call a tap makes, ahead of every gate call (APRV-248)", async () => {
  // The load-proof form of the old 300 ms bound. What a human experiences as a
  // spinner that stops at once is not a number of milliseconds: it is the ack
  // being the very next thing the channel does after reading the callback, with
  // nothing that touches the log in front of it. That is an ORDER, and an order
  // holds on a machine with sixteen busy cores exactly as it holds on an idle
  // one.
  const measured = await tap(large, nextKey(large), "n-sequence");
  const methods = measured.calls.map((call) => call.method);

  assert.deepEqual(
    methods.slice(0, 2),
    ["getUpdates", "answerCallbackQuery"],
    `the ack was not the first call after the callback was read: ${methods.join(", ")}`,
  );

  // Everything carrying the decision comes after the ack, and the log was still
  // untouched when the ack went out: the ack overtook the gate rather than
  // winning a photo finish with it.
  const ackAt = methods.indexOf("answerCallbackQuery");
  const editAt = methods.indexOf("editMessageText");
  assert.ok(editAt > ackAt, `the outcome edit preceded the ack: ${methods.join(", ")}`);
  assert.equal(
    measured.calls[ackAt]?.logRecords,
    measured.recordsAfter - 1,
    "the log had already grown when the ack was sent",
  );
  assertClean(large.unit);
});

test("a tap re-verifies nothing it has already verified (APRV-206)", async () => {
  // The other half of the old ratio, stated structurally: after the first read
  // of a log, a tap's verified read is a cache HIT — the verified head is reused
  // and only the tail appended since is walked. A miss here would mean the whole
  // chain was re-verified, which is the cost the ratio was about.
  const first = processReadCache.stats;
  await tap(large, nextKey(large), "n-cache-warm");
  const warmed = processReadCache.stats;

  await tap(large, nextKey(large), "n-cache-hit");
  const after = processReadCache.stats;

  assert.ok(warmed.hits >= first.hits, "the cache went backwards");
  assert.equal(
    after.misses,
    warmed.misses,
    "a tap on an already-verified log re-verified it from genesis",
  );
  assert.ok(after.hits > warmed.hits, "a tap made no verified read at all");
  assertClean(large.unit);
});

test("COUNTED: one tap costs the same verified reads at 1k records and at 10k (APRV-248)", async () => {
  // The load-proof form of the old ratio. Its claim was never "16 ms": it was
  // "the decision path does not re-walk the log per tap", and that claim is a
  // count rather than a duration. Both fixtures are warmed first (the first read
  // of any log verifies it from genesis, once, by design), and then one tap on
  // each must do the SAME number of verified reads with NO read from genesis.
  // Ten times the records, the same counters.
  const measure = async (unit: Fixture, nonce: string) => {
    const before = processReadCache.stats;
    await tap(unit, nextKey(unit), nonce);
    const after = processReadCache.stats;
    return {
      hits: after.hits - before.hits,
      misses: after.misses - before.misses,
      resumed: after.resumed - before.resumed,
    };
  };

  // Warm both: a cold log is verified from genesis exactly once per process.
  await measure(small, "n-counted-warm-small");
  await measure(large, "n-counted-warm-large");

  const one = await measure(small, "n-counted-small");
  const ten = await measure(large, "n-counted-large");

  // Not vacuous: a tap that made no verified read at all would compare zero
  // against zero and prove nothing about either size.
  assert.ok(one.hits > 0, "a tap on the 1k fixture made no verified read at all");
  assert.equal(one.misses, 0, "a warmed 1k log was re-verified from genesis");
  assert.equal(ten.misses, 0, "a warmed 10k log was re-verified from genesis");
  assert.deepEqual(
    ten,
    one,
    `a tap's verified-read work grew with the log: ${JSON.stringify(one)} at ${String(
      small.records,
    )} records against ${JSON.stringify(ten)} at ${String(large.records)}`,
  );
  assertClean(small.unit);
  assertClean(large.unit);
});

// The invalidation side of that cache — a head that moved, a prefix tampered
// with, a shrunken or substituted file, a different schema directory — is
// enumerated case by case in `tests/state-cache.test.ts`, which asserts that
// each one discards the entry and re-verifies from genesis, and that a resumed
// read is identical to a cold read of the same bytes. It is not repeated here:
// the tap has no cache of its own, and this file's claim is that it uses that
// one rather than that that one is sound.
