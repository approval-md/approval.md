/**
 * Progress reporting for the slow, silent phases (APRV-167).
 *
 * Two layers, tested separately because they answer to different rules. The
 * core callback is deterministic and count-based (`core/verify.ts` has no clock
 * and takes no view on terminals); the CLI reporter is the one that knows
 * whether anybody is watching and how often a line may be repainted.
 *
 * Repo invariant, unchanged: every log under test is built through the real
 * `appendEvent` path. Nothing here hand-writes a record.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { appendEvent, type EventInput } from "../src/core/log.js";
import { PROGRESS_INTERVAL, verifyWithRecords, type VerifyProgress } from "../src/core/verify.js";
import { createProgress, silentProgress } from "../src/cli/progress.js";
import { readVerifiedRecords } from "../src/core/state.js";
import type { Streams } from "../src/cli/main.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-progress-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A real log of `n` records.
 *
 * Comfortably more than {@link PROGRESS_INTERVAL} so the interval is exercised
 * rather than assumed, and not so many that the suite pays for it: the claim
 * under test is the shape of the callback, and the shape is the same at 600
 * records as at the three thousand that made a human think `amend` had hung.
 */
function buildLog(n: number): string {
  counter += 1;
  const logPath = join(scratch, `case-${String(counter)}`, "log", "events.jsonl");
  for (let index = 0; index < n; index += 1) {
    const input: EventInput = {
      ts: "2026-08-04T09:11:02Z",
      event: "task.registered",
      actor: "agent:planner",
      task: `task-${String(index).padStart(4, "0")}`,
      channel: "cli",
      payload: { title: `record ${String(index)}` },
    };
    const result = appendEvent(logPath, input);
    assert.ok(result.ok, `append failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  }
  return logPath;
}

const RECORDS = PROGRESS_INTERVAL * 2 + 100;

// ---------------------------------------------------------------------------
// The core callback
// ---------------------------------------------------------------------------

test("verification reports progress with strictly increasing counts, ending at the total", () => {
  const logPath = buildLog(RECORDS);
  const seen: VerifyProgress[] = [];

  const verified = verifyWithRecords(logPath, {
    onProgress: (progress) => {
      seen.push(progress);
    },
  });

  assert.equal(verified.result.status, "clean");
  assert.ok(seen.length > 1, `a ${String(RECORDS)}-record walk reported ${String(seen.length)} times`);

  for (const [index, progress] of seen.entries()) {
    assert.equal(progress.total, RECORDS, "the total moved during one walk");
    assert.ok(progress.done >= 1 && progress.done <= progress.total);
    const previous = seen[index - 1];
    if (previous !== undefined) {
      assert.ok(
        progress.done > previous.done,
        `progress went backwards or repeated: ${String(previous.done)} then ${String(progress.done)}`,
      );
    }
  }

  assert.equal(seen[0]?.done, PROGRESS_INTERVAL);
  assert.equal(seen.at(-1)?.done, RECORDS, "the last call did not reach the total");
});

test("a verification with no listener behaves identically to one with", () => {
  const logPath = buildLog(PROGRESS_INTERVAL + 5);

  const quiet = verifyWithRecords(logPath);
  const watched = verifyWithRecords(logPath, {
    onProgress: () => {
      // Observed and discarded: the point is that observing changes nothing.
    },
  });

  assert.deepEqual(watched.result, quiet.result);
  assert.deepEqual(watched.records, quiet.records);
});

test("the listener rides the whole read seam, so `readVerifiedRecords` reports too", () => {
  const logPath = buildLog(PROGRESS_INTERVAL + 5);
  const seen: VerifyProgress[] = [];

  // `cache: null` is the cold path; the warm one is the case below.
  const read = readVerifiedRecords(logPath, {
    cache: null,
    onProgress: (progress) => {
      seen.push(progress);
    },
  });

  assert.ok(read.ok, read.ok ? "" : read.message);
  assert.equal(seen.at(-1)?.done, PROGRESS_INTERVAL + 5);
  assert.equal(seen.at(-1)?.total, PROGRESS_INTERVAL + 5);
});

test("counts are absolute over the log, not over the resumed remainder", () => {
  const logPath = buildLog(PROGRESS_INTERVAL + 5);

  // Warm the process cache, then append and read again: the second read walks
  // only the new records but must still describe the whole log, or an operator
  // watching a warm process sees the count restart at zero.
  const first = readVerifiedRecords(logPath);
  assert.ok(first.ok, first.ok ? "" : first.message);

  const appended = appendEvent(logPath, {
    ts: "2026-08-04T09:11:02Z",
    event: "task.registered",
    actor: "agent:planner",
    task: "task-tail",
    channel: "cli",
    payload: { title: "the appended one" },
  });
  assert.ok(appended.ok);

  const seen: VerifyProgress[] = [];
  const second = readVerifiedRecords(logPath, {
    onProgress: (progress) => {
      seen.push(progress);
    },
  });

  assert.ok(second.ok, second.ok ? "" : second.message);
  assert.equal(seen.at(-1)?.done, PROGRESS_INTERVAL + 6);
  assert.equal(seen.at(-1)?.total, PROGRESS_INTERVAL + 6);
});

// ---------------------------------------------------------------------------
// The CLI reporter
// ---------------------------------------------------------------------------

interface Captured {
  streams: Streams;
  out: string[];
  err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
  };
}

/** A clock the test advances by hand, so the throttle is not a race. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

test("non-TTY progress is line-oriented: newline-terminated, and no carriage return", () => {
  const { streams, out, err } = capture();
  const time = clock();
  const progress = createProgress(streams, { tty: false, now: time.now, throttleMs: 200 });

  progress.phase("verifying the log chain");
  progress.step(250, 3000);
  time.advance(500);
  progress.step(500, 3000);
  progress.done();

  const text = err.join("");
  assert.equal(text.includes("\r"), false, "a pipe was sent a carriage return");
  assert.deepEqual(out, [], "progress reached stdout, where --json lives");
  const lines = text.split("\n").filter((line) => line.length > 0);
  assert.deepEqual(lines, ["verifying the log chain", "  250/3000 records", "  500/3000 records"]);
});

test("the phase line is written immediately, before any count arrives", () => {
  const { streams, err } = capture();
  const progress = createProgress(streams, { tty: false, now: clock().now });

  progress.phase("verifying the log chain before anything is read from it");

  // One write, already flushed, with no count and no waiting: this is the
  // "first line within a second" the ceremony was missing.
  assert.deepEqual(err, ["verifying the log chain before anything is read from it\n"]);
});

test("a terminal repaints one line, and the phase name survives above it", () => {
  const { streams, err } = capture();
  const time = clock();
  const progress = createProgress(streams, { tty: true, now: time.now, throttleMs: 200 });

  progress.phase("verifying the log chain");
  progress.step(250, 3000);
  time.advance(500);
  progress.step(500, 3000);
  progress.done();

  const text = err.join("");
  assert.match(text, /^verifying the log chain\n/u);
  assert.ok(text.includes("\r"), "a terminal got no repaint");
  assert.match(text, /250\/3000 records/u);
  assert.match(text, /500\/3000 records/u);
  // The repainted line is erased on close, so the report that follows starts
  // clean rather than under a stale count.
  assert.match(text, /\r {2,}\r$/u);
});

test("counts are throttled, and the last one is never dropped", () => {
  const { streams, err } = capture();
  const time = clock();
  const progress = createProgress(streams, { tty: false, now: time.now, throttleMs: 200 });

  progress.phase("verifying");
  progress.step(250, 1000); // first of the phase: always drawn
  progress.step(500, 1000); // 0ms later: throttled away
  progress.step(750, 1000); // still 0ms later: throttled away
  progress.step(1000, 1000); // done === total: drawn regardless
  progress.done();

  const counts = err.join("").match(/\d+\/1000/gu) ?? [];
  assert.deepEqual(counts, ["250/1000", "1000/1000"]);
});

test("a count with no open phase is ignored rather than refused", () => {
  const { streams, err } = capture();
  const progress = createProgress(streams, { tty: false, now: clock().now });

  progress.step(1, 10);
  progress.done();

  assert.deepEqual(err, [], "a stray count printed a bare number");
});

test("the silent reporter writes nothing at all", () => {
  const { streams, out, err } = capture();
  assert.equal(silentProgress.active, false);
  silentProgress.phase("verifying");
  silentProgress.step(1, 2);
  silentProgress.done("finished");
  void streams;
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});
