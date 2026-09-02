/**
 * The incremental prefix proof (APRV-217): what it hashes, what it still
 * refuses, and that it never answers differently from a cold walk.
 *
 * `docs/proposals/incremental-prefix-proof.md` is the design. Three properties
 * are asserted here, and they are the whole of the claim:
 *
 * 1. **The work really moves.** The cache counts the bytes it feeds to SHA-256
 *    (`hashedByteCount`), so "the incremental path hashes only the appended
 *    bytes" is asserted structurally rather than with a stopwatch on a loaded
 *    machine. Under `full`, every read hashes the whole prefix, exactly as it
 *    did before this existed.
 *
 * 2. **Nothing survives an incremental read that would not survive a cold
 *    one.** The guard matrix from §9 of the design runs under both modes: an
 *    interior rewrite, a truncation, a same-size head-line rewrite, a torn
 *    tail, a schema-directory change, and a longer forged chain that keeps the
 *    head line. The one case where the two modes differ in TIMING (an interior
 *    rewrite is served from cache until the cadence) is asserted as exactly
 *    that: the window, and then the same refusal `full` gives immediately.
 *
 * 3. **Equivalence.** Records and head from `incremental` deep-equal `full`
 *    deep-equal a cold walk, at every read of a growing log.
 *
 * Plus the two boundaries the design draws: this process's own `appendEvent`
 * forces a full re-proof on the next read, and the Claude Code hook never
 * selects the incremental path whatever the policy says.
 *
 * Every log here is built through the real `appendEvent`; damage is applied
 * afterwards, and the damaged file plays the attacker.
 */

import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { commandHook } from "../src/cli/hook.js";
import {
  appendEvent,
  computeRecordHash,
  serializeRecord,
  type EventInput,
  type EventRecord,
} from "../src/core/log.js";
import {
  hashedByteCount,
  processReadCache,
  readVerifiedRecords,
  resetHashedByteCount,
  VerifiedReadCache,
  type ReadProof,
  type ReadRecordsResult,
} from "../src/core/state.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import { assertClean, attest, newScenario, scratchRoot } from "./scenario.js";

const scratch = scratchRoot("read-proof");
let counter = 0;

after(() => {
  scratch.cleanup();
});

/** A cadence no test trips by accident: count and clock both far away. */
const NEVER_DUE: ReadProof = { mode: "incremental", everyReads: 10_000, afterMs: 3_600_000 };
/** One incremental read per full re-proof: the anchor, then one, then a full. */
const EVERY_SECOND: ReadProof = { mode: "incremental", everyReads: 2, afterMs: 3_600_000 };
const FULL: ReadProof = { mode: "full", everyReads: 10_000, afterMs: 3_600_000 };

/**
 * A record whose payload carries a fixed-width marker, so a tamper can change
 * its contents without changing any byte count.
 */
function event(index: number): EventInput {
  const stamp = String(index).padStart(2, "0");
  return {
    ts: `2026-08-05T09:${stamp}:00Z`,
    event: "task.registered",
    actor: "agent:planner",
    task: `task-${stamp}`,
    payload: { note: `marker-${stamp}` },
  };
}

function appendOrThrow(logPath: string, index: number): EventRecord {
  const result = appendEvent(logPath, event(index));
  assert.ok(result.ok, `append ${index} failed`);
  return result.record;
}

function freshPath(): string {
  counter += 1;
  const dir = join(scratch.root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "events.jsonl");
}

/** A real log of `count` records, at a path no other case touches. */
function buildLog(count: number): string {
  const logPath = freshPath();
  for (let index = 1; index <= count; index += 1) appendOrThrow(logPath, index);
  return logPath;
}

function sizeOf(logPath: string): number {
  return statSync(logPath).size;
}

function lines(logPath: string): string[] {
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

/** Length-preserving substitution: the only attack the prefix hash exists for. */
function substitute(logPath: string, from: string, to: string): void {
  assert.equal(from.length, to.length, "the attack must preserve length");
  const raw = readFileSync(logPath, "utf8");
  assert.equal(raw.split(from).length - 1, 1, `${from} must occur exactly once`);
  writeFileSync(logPath, raw.replace(from, to));
}

function ok(result: ReadRecordsResult): { records: EventRecord[]; head: unknown } {
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return { records: result.records, head: result.head };
}

function refusal(result: ReadRecordsResult): { code: string; message: string } {
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, message: result.message };
}

/** One read under `proof`, reporting the bytes it fed to SHA-256. */
function readCounting(
  logPath: string,
  cache: VerifiedReadCache,
  proof: ReadProof,
): { result: ReadRecordsResult; hashed: number } {
  resetHashedByteCount();
  const result = readVerifiedRecords(logPath, { cache, readProof: proof });
  return { result, hashed: hashedByteCount() };
}

// ===========================================================================
// 1. The work moves: what each mode hashes
// ===========================================================================

test("under incremental a repeat read hashes only the appended bytes", () => {
  const logPath = buildLog(20);
  const cache = new VerifiedReadCache();

  // The first read of a log in a process is always full: there is no state to
  // anchor to, and it is built from the same single pass over the file.
  const anchor = readCounting(logPath, cache, NEVER_DUE);
  ok(anchor.result);
  assert.equal(anchor.hashed, sizeOf(logPath), "the anchoring read hashes the whole file");

  let previous = sizeOf(logPath);
  for (let index = 21; index <= 30; index += 1) {
    appendOrThrow(logPath, index);
    const size = sizeOf(logPath);
    const read = readCounting(logPath, cache, NEVER_DUE);
    const seen = ok(read.result);
    assert.equal(seen.records.length, index, "every record is still returned");
    assert.equal(
      read.hashed,
      size - previous,
      `read after append ${String(index)} hashed ${String(read.hashed)} bytes for a ${String(
        size - previous,
      )}-byte append; the prefix is being re-hashed`,
    );
    previous = size;
  }

  assert.deepEqual(
    cache.stats,
    { hits: 10, misses: 1, resumed: 0, fullReproofs: 1 },
    "one full re-proof anchored the ten reads that followed it",
  );
});

test("under full every read hashes the whole prefix, as it always has", () => {
  const logPath = buildLog(20);
  const cache = new VerifiedReadCache();

  const anchor = readCounting(logPath, cache, FULL);
  ok(anchor.result);
  assert.equal(anchor.hashed, sizeOf(logPath));

  // Unchanged file: the prefix hash is recomputed and compared, and the digest
  // the entry already holds is reused rather than derived a second time.
  const prefix = sizeOf(logPath);
  const again = readCounting(logPath, cache, FULL);
  ok(again.result);
  assert.equal(again.hashed, prefix, "an unchanged file is re-hashed in full");

  // Grown file: the proved prefix, and then the digest of the new whole. Both
  // passes are today's behaviour, unchanged by APRV-217.
  appendOrThrow(logPath, 21);
  const grown = readCounting(logPath, cache, FULL);
  ok(grown.result);
  assert.equal(grown.hashed, prefix + sizeOf(logPath));
  assert.equal(cache.stats.fullReproofs, cache.stats.hits + cache.stats.misses);
});

test("the read count brings a full re-proof round on its own", () => {
  const logPath = buildLog(10);
  const cache = new VerifiedReadCache();
  ok(readCounting(logPath, cache, EVERY_SECOND).result);

  // `everyReads: 2` — the anchoring read covers itself and one more.
  const served = readCounting(logPath, cache, EVERY_SECOND);
  ok(served.result);
  assert.equal(served.hashed, 0, "an unchanged file has no appended bytes to hash");

  const due = readCounting(logPath, cache, EVERY_SECOND);
  ok(due.result);
  assert.equal(due.hashed, sizeOf(logPath), "the cadence read re-proves the whole prefix");
  assert.equal(cache.stats.fullReproofs, 2, "the anchor and the cadence boundary");

  // …and the cadence starts again from the read that re-anchored it.
  const nextServed = readCounting(logPath, cache, EVERY_SECOND);
  ok(nextServed.result);
  assert.equal(nextServed.hashed, 0);
  assert.equal(cache.stats.fullReproofs, 2);
});

test("the wall clock brings a full re-proof round on its own", () => {
  const logPath = buildLog(10);
  const cache = new VerifiedReadCache();
  // A zero-millisecond window: every read is overdue the instant it starts, so
  // the clock bound is asserted without a test that sleeps.
  const immediate: ReadProof = { mode: "incremental", everyReads: 10_000, afterMs: 0 };

  ok(readCounting(logPath, cache, immediate).result);
  for (let read = 0; read < 3; read += 1) {
    const next = readCounting(logPath, cache, immediate);
    ok(next.result);
    assert.equal(next.hashed, sizeOf(logPath), "an overdue read hashes the whole prefix");
  }
  assert.equal(cache.stats.fullReproofs, 4, "every read was a full re-proof");
});

// ===========================================================================
// 2. The guard matrix, per mode
// ===========================================================================

test("an interior rewrite is served from cache until the cadence, then refused exactly as full refuses it", () => {
  // The whole cost of this design, as a test. The attacker must preserve the
  // file length, the head line, its offset AND the mtime — the cheap guards
  // reject anything less, in both modes — and even then the window closes at
  // the cadence with the verdict `full` gives immediately.
  const pinned = new Date("2026-08-05T09:30:00.000Z");
  const logPath = buildLog(5);
  utimesSync(logPath, pinned, pinned);
  const incremental = new VerifiedReadCache();
  const before = ok(readVerifiedRecords(logPath, { cache: incremental, readProof: EVERY_SECOND }));

  const sizeBefore = sizeOf(logPath);
  const headLineBefore = lines(logPath)[4];
  substitute(logPath, "marker-02", "forged-02");
  utimesSync(logPath, pinned, pinned);
  assert.equal(sizeOf(logPath), sizeBefore, "the attack changed the file size");
  assert.equal(lines(logPath)[4], headLineBefore, "the attack moved the head line");
  assert.equal(statSync(logPath).mtimeMs, pinned.getTime(), "the attack moved the mtime");

  // The window this design buys, stated as a test rather than left implicit:
  // one read inside the cadence is served from the records already held.
  const served = ok(readVerifiedRecords(logPath, { cache: incremental, readProof: EVERY_SECOND }));
  assert.deepEqual(served.records, before.records, "the cached records are served unchanged");

  // …and the cadence closes it, with the verdict `full` gives immediately.
  const caught = refusal(
    readVerifiedRecords(logPath, { cache: incremental, readProof: EVERY_SECOND }),
  );

  const full = new VerifiedReadCache();
  const fullLog = buildLog(5);
  utimesSync(fullLog, pinned, pinned);
  ok(readVerifiedRecords(fullLog, { cache: full, readProof: FULL }));
  substitute(fullLog, "marker-02", "forged-02");
  utimesSync(fullLog, pinned, pinned);
  const immediate = refusal(readVerifiedRecords(fullLog, { cache: full, readProof: FULL }));

  assert.equal(caught.code, "log-corrupt");
  assert.equal(caught.code, immediate.code, "the same code, one cadence later");
  assert.match(caught.message, /hash-mismatch at seq 2/u);
  assert.match(immediate.message, /hash-mismatch at seq 2/u);
});

test("a truncated log discards the entry under incremental and reports its own head", () => {
  const logPath = buildLog(5);
  const cache = new VerifiedReadCache();
  ok(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));

  writeFileSync(logPath, lines(logPath).slice(0, 4).map((line) => `${line}\n`).join(""));

  const shrunk = ok(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));
  assert.equal(shrunk.records.length, 4, "the removed record must not survive in the cache");
  assert.deepEqual(shrunk, ok(readVerifiedRecords(logPath, { cache: null })), "a cold read agrees");
  assert.equal(cache.stats.hits, 0, "a shorter file is never a hit");
  assert.equal(cache.stats.fullReproofs, 2, "the guard failure fell back to the whole-file read");
});

test("a same-size rewrite of the head line is caught by the head-line guard", () => {
  const logPath = buildLog(5);
  const cache = new VerifiedReadCache();
  ok(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));

  const sizeBefore = sizeOf(logPath);
  substitute(logPath, "marker-05", "forged-05");
  assert.equal(sizeOf(logPath), sizeBefore, "the attack must preserve the file size");

  const caught = refusal(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));
  assert.equal(caught.code, "log-corrupt");
  assert.match(caught.message, /hash-mismatch at seq 5/u);
  assert.equal(cache.stats.hits, 0, "the head-line guard rejected before any reuse");
});

test("a torn tail reads the same under incremental as cold", () => {
  const logPath = buildLog(5);
  const cache = new VerifiedReadCache();
  ok(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));

  // A crashed write: a complete record, then a line that never finished.
  writeFileSync(logPath, `${readFileSync(logPath, "utf8")}{"seq":6,"partial":`);

  const torn = refusal(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));
  const cold = refusal(readVerifiedRecords(logPath, { cache: null }));
  assert.equal(torn.code, "log-torn-tail");
  assert.deepEqual(torn, cold, "the same refusal, word for word");
  assert.equal(cache.stats.hits, 1, "the prefix was legitimately reusable; the tail was not");
});

test("a schema directory change never reaches the incremental path", () => {
  const logPath = buildLog(5);
  const cache = new VerifiedReadCache();
  const other = join(scratch.root, `schemas-${String(counter)}`);
  cpSync(DEFAULT_SCHEMA_DIR, other, { recursive: true });

  ok(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));
  const elsewhere = ok(
    readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE, schemaDir: other }),
  );
  assert.deepEqual(
    elsewhere,
    ok(readVerifiedRecords(logPath, { cache: null, schemaDir: other })),
    "records verified against one schema set are not evidence under another",
  );
  assert.equal(cache.stats.hits, 0, "the schema key discarded the entry before any proof");
});

test("a longer forged chain that keeps the head line is caught by the tail walk", () => {
  const logPath = buildLog(5);
  const cache = new VerifiedReadCache();
  ok(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));

  // The file is replaced by a LONGER chain whose fifth line is the head line
  // this cache holds, at the same offset — so every guard above the digest
  // passes. The forged tail must chain onto that head, and it does not.
  const honest = lines(logPath);
  const forged = { ...(JSON.parse(honest[0] as string) as EventRecord), seq: 6, prev: "0".repeat(64) };
  forged.hash = computeRecordHash(forged);
  writeFileSync(
    logPath,
    `${honest.map((line) => `${line}\n`).join("")}${serializeRecord(forged)}\n`,
  );

  const caught = refusal(readVerifiedRecords(logPath, { cache, readProof: NEVER_DUE }));
  assert.equal(caught.code, "log-corrupt");
  assert.match(caught.message, /prev-mismatch at seq 6/u);
  assert.equal(caught.code, refusal(readVerifiedRecords(logPath, { cache: null })).code);
});

// ===========================================================================
// 3. Equivalence
// ===========================================================================

test("incremental, full and a cold walk agree at every read of a growing log", () => {
  const logPath = buildLog(3);
  const incremental = new VerifiedReadCache();
  const full = new VerifiedReadCache();

  for (let index = 4; index <= 24; index += 1) {
    const cold = ok(readVerifiedRecords(logPath, { cache: null }));
    const warmFull = ok(readVerifiedRecords(logPath, { cache: full, readProof: FULL }));
    const warmIncremental = ok(
      readVerifiedRecords(logPath, { cache: incremental, readProof: EVERY_SECOND }),
    );
    assert.deepEqual(warmIncremental, warmFull, `read at ${String(index)} records disagrees`);
    assert.deepEqual(warmIncremental, cold, `read at ${String(index)} records is not the cold one`);
    appendOrThrow(logPath, index);
  }

  // Both cadence paths were exercised: some of those reads re-proved in full.
  assert.ok(incremental.stats.fullReproofs > 1, "the cadence boundary was crossed");
  assert.ok(
    incremental.stats.fullReproofs < full.stats.fullReproofs,
    "and it still re-proved less often than `full` does",
  );
});

// ===========================================================================
// 4. The boundaries: the writer, and the hook
// ===========================================================================

test("this process's own append forces a full re-proof on the next read", () => {
  const logPath = buildLog(5);
  processReadCache.clear();

  // The process cache is the one `core/log.ts` notifies, so this is the daemon's
  // own situation: it reads, it appends, it reads again.
  ok(readVerifiedRecords(logPath, { readProof: NEVER_DUE }));
  const anchored = processReadCache.stats.fullReproofs;
  appendOrThrow(logPath, 6);
  ok(readVerifiedRecords(logPath, { readProof: NEVER_DUE }));
  assert.equal(
    processReadCache.stats.fullReproofs,
    anchored + 1,
    "the read after this process's own append re-proved the whole prefix",
  );

  // A private cache nobody told is the control: the same sequence stays
  // incremental, so the assertion above is about the hook and not the cadence.
  const private_ = new VerifiedReadCache();
  ok(readVerifiedRecords(logPath, { cache: private_, readProof: NEVER_DUE }));
  appendOrThrow(logPath, 7);
  const after_ = readCounting(logPath, private_, NEVER_DUE);
  ok(after_.result);
  assert.equal(private_.stats.fullReproofs, 1, "the control cache re-proved once");
  assert.ok(after_.hashed < sizeOf(logPath), "and hashed only the appended bytes");

  processReadCache.clear();
});

test("the Claude Code hook never selects the incremental proof, whatever the policy says", () => {
  // The policy says `incremental` as loudly as a policy can. The hook is a
  // one-shot process with no prior full pass of its own to anchor a state to,
  // so it proves in full regardless — the design's §6, asserted on the cache's
  // own counters.
  const unit = newScenario(
    scratch.root,
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: manual",
      "classes:",
      "  read.*:",
      "    autonomy: autonomous",
      "daemon:",
      "  read_proof: incremental",
      "  full_reproof_every: 1000",
      '  full_reproof_after: "1h"',
      "```",
      "",
    ].join("\n"),
  );
  attest(unit);

  const out: string[] = [];
  processReadCache.clear();
  const code = commandHook(
    ["claude-code", "--as", "agent:claude-code", "--dir", unit.dir],
    { out: (text) => out.push(text), err: () => undefined },
    unit.dir,
    () =>
      JSON.stringify({
        session_id: "sess-read-proof",
        transcript_path: "/dev/null",
        cwd: unit.dir,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la", description: "read the directory" },
        tool_use_id: "tu-read-proof",
      }),
  );
  assert.equal(code, 0, out.join(""));

  const stats = processReadCache.stats;
  assert.ok(stats.misses + stats.hits > 0, "the hook really did read the log");
  assert.equal(
    stats.fullReproofs,
    stats.hits + stats.misses,
    `the hook made ${String(stats.hits + stats.misses)} reads and re-proved in full ${String(
      stats.fullReproofs,
    )} of them; a hook read must never be served from a carried hash state`,
  );
  processReadCache.clear();
  assertClean(unit);
});

test("a cache: null read ignores the proof mode entirely", () => {
  const logPath = buildLog(4);
  resetHashedByteCount();
  const cold = ok(readVerifiedRecords(logPath, { cache: null, readProof: NEVER_DUE }));
  assert.equal(cold.records.length, 4);
  assert.equal(hashedByteCount(), 0, "the cold path never touches this module's hash counter");
  rmSync(logPath, { force: true });
});
