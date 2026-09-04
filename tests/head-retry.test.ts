/**
 * The bounded head-moved retry, at the seam where its arithmetic lives
 * (APRV-236, `src/core/head-retry.ts`).
 *
 * `tests/concurrency.test.ts` proves the property that matters with real
 * processes racing a real log: the write lands, and a request decided in the
 * window refuses with the decided code. This file proves the things a race
 * cannot pin deterministically — how many times the cycle runs, what stops it
 * early, and what the refusal says once the bound is spent — by handing the
 * helper a cycle that counts its own calls.
 *
 * Nothing here writes a log or fabricates a record. The subject is the loop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attemptsOf,
  HEAD_MOVED_ATTEMPTS,
  isHeadMoved,
  withHeadRetry,
  type HeadRetryable,
} from "../src/core/head-retry.js";

const HEAD_MOVED: HeadRetryable = {
  ok: false,
  code: "append-failed",
  message: "the execution.started could not be appended",
  append: { code: "head-moved", message: "head moved: expected seq 14218, found 14219" },
};

const LOCKED: HeadRetryable = {
  ok: false,
  code: "append-failed",
  message: "the append lock was not available",
  append: { code: "lock-timeout", message: "lock held for 5000ms" },
};

const DECIDED: HeadRetryable = {
  ok: false,
  code: "already-decided",
  message: "action task-042:chaser was already granted at seq 14219",
};

/** A cycle that answers from a script, one entry per call, and counts calls. */
function scripted(results: HeadRetryable[]): { cycle: () => HeadRetryable; calls: () => number } {
  let calls = 0;
  return {
    cycle: () => {
      const result = results[Math.min(calls, results.length - 1)] as HeadRetryable;
      calls += 1;
      return result;
    },
    calls: () => calls,
  };
}

test("the count APRV-150 chose is the count every writer gets", () => {
  assert.equal(HEAD_MOVED_ATTEMPTS, 3);
});

test("a cycle that succeeds first time runs once", () => {
  const script = scripted([{ ok: true }]);
  const result = withHeadRetry(HEAD_MOVED_ATTEMPTS, script.cycle);

  assert.equal(result.ok, true);
  assert.equal(script.calls(), 1);
});

test("a head-moved refusal is re-run, and a cycle that then succeeds returns the success", () => {
  const script = scripted([HEAD_MOVED, HEAD_MOVED, { ok: true }]);
  const result = withHeadRetry(HEAD_MOVED_ATTEMPTS, script.cycle);

  assert.equal(result.ok, true);
  assert.equal(script.calls(), 3);
});

test("a verdict the fresh head produces is returned as itself, and stops the loop", () => {
  // The property the whole design rests on: the re-run is a re-DERIVATION. A
  // request someone decided in the window refuses `already-decided`, which is
  // the fact the caller needs, and no further attempt is made to write over it.
  const script = scripted([HEAD_MOVED, DECIDED, { ok: true }]);
  const result = withHeadRetry(HEAD_MOVED_ATTEMPTS, script.cycle);

  assert.equal(result.ok, false);
  assert.equal(result.code, "already-decided");
  assert.equal(script.calls(), 2);
});

test("only head-moved retries: a lock timeout is returned on the first attempt", () => {
  const script = scripted([LOCKED, { ok: true }]);
  const result = withHeadRetry(HEAD_MOVED_ATTEMPTS, script.cycle);

  assert.equal(result.ok, false);
  assert.equal(result.code, "append-failed");
  assert.equal(result.append?.code, "lock-timeout");
  assert.equal(script.calls(), 1);
  // And the message is the writer's own: nothing is appended to a refusal that
  // was never retried.
  assert.equal(result.message, LOCKED.message);
});

test("the bound is spent after exactly N cycles, never more", () => {
  const script = scripted([HEAD_MOVED]);
  withHeadRetry(HEAD_MOVED_ATTEMPTS, script.cycle);

  assert.equal(script.calls(), HEAD_MOVED_ATTEMPTS);
});

test("the final refusal is append-failed, with the attempt count in its message", () => {
  const script = scripted([HEAD_MOVED]);
  const result = withHeadRetry(HEAD_MOVED_ATTEMPTS, script.cycle);

  // The code and the writer's own error are untouched: a caller branching on
  // `append-failed` still fails closed, exactly as it did before the retry
  // existed.
  assert.equal(result.ok, false);
  assert.equal(result.code, "append-failed");
  assert.equal(result.append?.code, "head-moved");
  // What is added is how hard the writer tried. One lost race and a log under
  // sustained contention are different operational facts.
  assert.match(String(result.message), /3 attempts were made/u);
  assert.ok(String(result.message).startsWith(String(HEAD_MOVED.message)));
});

test("a bound of one says so in the singular, which is the unretried writer's shape", () => {
  const script = scripted([HEAD_MOVED]);
  const result = withHeadRetry(1, script.cycle);

  assert.equal(script.calls(), 1);
  assert.match(String(result.message), /1 attempt was made/u);
});

test("the ceiling is lowered by a caller and never raised", () => {
  assert.equal(attemptsOf(1), 1);
  assert.equal(attemptsOf(2), 2);
  // Asking for more than the runtime allows gets the runtime's own number.
  assert.equal(attemptsOf(99), HEAD_MOVED_ATTEMPTS);
  // Ambiguity resolves to the runtime's value rather than the caller's, in the
  // one direction that cannot be used to widen anything.
  assert.equal(attemptsOf(undefined), HEAD_MOVED_ATTEMPTS);
  assert.equal(attemptsOf(0), HEAD_MOVED_ATTEMPTS);
  assert.equal(attemptsOf(-4), HEAD_MOVED_ATTEMPTS);
  assert.equal(attemptsOf(1.5), HEAD_MOVED_ATTEMPTS);
  assert.equal(attemptsOf(Number.NaN), HEAD_MOVED_ATTEMPTS);
});

test("a module with its own ceiling clamps against that one", () => {
  // `core/gate-window.ts` allows one attempt more than the gate writers get, and
  // it passes its own ceiling rather than keeping its own copy of the loop.
  assert.equal(attemptsOf(undefined, 4), 4);
  assert.equal(attemptsOf(99, 4), 4);
  assert.equal(attemptsOf(2, 4), 2);
});

test("isHeadMoved is true for the precondition alone", () => {
  assert.equal(isHeadMoved(HEAD_MOVED), true);
  assert.equal(isHeadMoved(LOCKED), false);
  assert.equal(isHeadMoved(DECIDED), false);
  assert.equal(isHeadMoved({ ok: true }), false);
  // A success carrying an `append` field it has no business carrying is still
  // not a refusal, and must never be re-run: re-running a landed write is the
  // one thing this helper exists to avoid.
  assert.equal(isHeadMoved({ ok: true, append: { code: "head-moved", message: "" } }), false);
});
