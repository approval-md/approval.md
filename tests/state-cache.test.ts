/**
 * The verified-read cache (APRV-43): tamper-after-cache, and equivalence.
 *
 * This file exists to attack the accelerator, because an accelerator on an
 * enforcement path is a bypass until proved otherwise (Global invariant 1:
 * enforcement paths read only verified records). Two properties are asserted:
 *
 * 1. **Nothing survives a cached read that would not survive a cold one.** The
 *    tamper matrix mutates a log *in place, on the same path a warm cache holds*
 *    — before the cached head, at it, after it, plus truncation and reorder —
 *    and requires every case to be caught. The interesting one is the mutation
 *    strictly before the head that preserves file size, head-line bytes, and
 *    head-line offset: the cheap "head bytes match" cache theory admits it, and
 *    the prefix-hash design this repo ships rejects it. That case is asserted
 *    twice over: the attack's stealth is checked (size and head line really are
 *    unchanged), then the read is required to refuse.
 *
 * 2. **A cached read is a cold read.** A scenario corpus covering the damage
 *    shapes of `tests/verify.test.ts` and `tests/state.test.ts` is replayed
 *    through three readers — warm cache, cold cache, no cache — and their
 *    results must be deep-equal, messages and line numbers included.
 *
 * As everywhere in this repo, every log is built through the real `appendEvent`
 * path; damage is applied afterwards, and the damaged file plays the attacker.
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  appendEvent,
  computeRecordHash,
  serializeRecord,
  type EventInput,
  type EventRecord,
  type LogHead,
} from "../src/core/log.js";
import {
  readVerifiedRecords,
  VerifiedReadCache,
  type ReadRecordsResult,
} from "../src/core/state.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-state-cache-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A record whose payload carries a fixed-width marker, so a tamper can change
 * its contents without changing any byte count — the whole point of the matrix.
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

/** A fresh path in its own directory. Nothing is written yet. */
function freshPath(): string {
  counter += 1;
  return join(scratch, `case-${counter}`, "events.jsonl");
}

/** A real log of `count` records, at a path no other case touches. */
function buildLog(count: number): string {
  const logPath = freshPath();
  for (let index = 1; index <= count; index += 1) appendOrThrow(logPath, index);
  return logPath;
}

/**
 * A real log of `count` records whose lines are the same length as
 * {@link buildLog}'s and whose contents differ in every one. The substitution
 * attack needs a plausible replacement, not a copy.
 */
function buildAltLog(count: number): string {
  const logPath = freshPath();
  for (let index = 1; index <= count; index += 1) {
    const stamp = String(index).padStart(2, "0");
    const result = appendEvent(logPath, {
      ...event(index),
      payload: { note: `cuckoo-${stamp}` },
    });
    assert.ok(result.ok, `append ${index} failed`);
  }
  return logPath;
}

function lines(logPath: string): string[] {
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function writeLines(logPath: string, contents: string[]): void {
  writeFileSync(logPath, contents.map((line) => `${line}\n`).join(""));
}

/**
 * Replace `from` with `to` in the file's bytes. Both must be the same length and
 * `from` must occur exactly once: this is the length-preserving attack, and a
 * sloppy edit would prove nothing.
 */
function substitute(logPath: string, from: string, to: string): void {
  assert.equal(from.length, to.length, "the attack must preserve length");
  const raw = readFileSync(logPath, "utf8");
  assert.equal(raw.split(from).length - 1, 1, `${from} must occur exactly once`);
  writeFileSync(logPath, raw.replace(from, to));
}

function head(logPath: string): LogHead {
  const parsed = lines(logPath).map((line) => JSON.parse(line) as EventRecord);
  const last = parsed[parsed.length - 1];
  assert.ok(last !== undefined);
  return { seq: last.seq, hash: last.hash };
}

function refusal(result: ReadRecordsResult): { code: string; message: string } {
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, message: result.message };
}

// ---------------------------------------------------------------------------
// The tamper matrix: damage applied in place, against a warm cache
// ---------------------------------------------------------------------------

/** Build a 5-record log and leave `cache` holding a clean verified read of it. */
function warmed(count = 5): { logPath: string; cache: VerifiedReadCache } {
  const logPath = buildLog(count);
  const cache = new VerifiedReadCache();
  const first = readVerifiedRecords(logPath, { cache });
  assert.equal(first.ok, true, "the warm-up read must be clean");
  // `fullReproofs` (APRV-217) equals `hits + misses` throughout this file, and
  // that is the assertion: these reads run the DEFAULT proof, under which every
  // one of them hashes the whole prefix exactly as it did before that task.
  assert.deepEqual(cache.stats, { hits: 0, misses: 1, resumed: 0, fullReproofs: 1 });
  return { logPath, cache };
}

test("tamper before the cached head, preserving size and head bytes, is refused", () => {
  const { logPath, cache } = warmed();
  const sizeBefore = statSync(logPath).size;
  const headLineBefore = lines(logPath)[4];

  // The attack the cheap cache theory would admit: record 2's contents change,
  // the file's length does not, and the head line stays byte-identical at the
  // same offset. Only re-hashing the prefix catches this.
  substitute(logPath, "marker-02", "forged-02");

  assert.equal(statSync(logPath).size, sizeBefore, "the attack changed the file size");
  assert.equal(lines(logPath)[4], headLineBefore, "the attack moved the head line");

  const result = readVerifiedRecords(logPath, { cache });
  const { code, message } = refusal(result);
  assert.equal(code, "log-corrupt");
  assert.match(message, /hash-mismatch at seq 2/u);
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, resumed: 0, fullReproofs: 2 }, "the prefix hash must discard the entry");
});

test("tamper at the cached head is refused", () => {
  const { logPath, cache } = warmed();
  substitute(logPath, "marker-05", "forged-05");

  const { code, message } = refusal(readVerifiedRecords(logPath, { cache }));
  assert.equal(code, "log-corrupt");
  assert.match(message, /hash-mismatch at seq 5/u);
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, resumed: 0, fullReproofs: 2 });
});

test("tamper in the appended suffix is refused on the resumed walk", () => {
  const { logPath, cache } = warmed();
  appendOrThrow(logPath, 6);
  appendOrThrow(logPath, 7);
  // The prefix is untouched, so the cache legitimately hits — and the suffix
  // still gets the full check ladder.
  substitute(logPath, "marker-06", "forged-06");

  const { code, message } = refusal(readVerifiedRecords(logPath, { cache }));
  assert.equal(code, "log-corrupt");
  assert.match(message, /hash-mismatch at seq 6/u);
  assert.deepEqual(cache.stats, { hits: 1, misses: 1, resumed: 0, fullReproofs: 2 }, "an intact prefix is reused");
});

test("a forged suffix record that does not link is refused", () => {
  const { logPath, cache } = warmed();
  const forged = {
    ...(JSON.parse(lines(logPath)[0] as string) as EventRecord),
    seq: 6,
    prev: "0".repeat(64),
  };
  forged.hash = computeRecordHash(forged);
  writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${serializeRecord(forged)}\n`);

  const { code, message } = refusal(readVerifiedRecords(logPath, { cache }));
  assert.equal(code, "log-corrupt");
  assert.match(message, /prev-mismatch at seq 6/u);
  assert.deepEqual(cache.stats, { hits: 1, misses: 1, resumed: 0, fullReproofs: 2 });
});

test("a shrunken log reports its own head, never the remembered one", () => {
  const { logPath, cache } = warmed();
  writeLines(logPath, lines(logPath).slice(0, 4));

  const result = readVerifiedRecords(logPath, { cache });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.records.length, 4, "the removed record must not survive in the cache");
  assert.equal(result.head?.seq, 4);
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, resumed: 0, fullReproofs: 2 }, "a shorter file discards the entry");
});

test("a reordered log is refused", () => {
  const { logPath, cache } = warmed();
  const contents = lines(logPath);
  const second = contents[1] as string;
  contents[1] = contents[2] as string;
  contents[2] = second;
  writeLines(logPath, contents);

  const { code } = refusal(readVerifiedRecords(logPath, { cache }));
  assert.equal(code, "log-corrupt");
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, resumed: 0, fullReproofs: 2 });
});

test("a same-size, same-mtime substitution of the whole log is still caught", () => {
  // The starkest form of "size and mtime prove nothing": every record replaced
  // by a different valid record, the file length unchanged, and the mtime put
  // back to the microsecond. Only re-hashing the prefix stands between this and
  // a gate acting on records that are no longer in the file.
  // The timestamp is pinned through `utimesSync` on both sides so the two
  // values are identical to the last bit, rather than merely close: an mtime
  // that differed by a rounding error would let the cheap check do the catching
  // and leave the expensive one untested.
  const pinned = new Date("2026-08-05T09:30:00.000Z");
  const logPath = buildLog(5);
  utimesSync(logPath, pinned, pinned);
  const cache = new VerifiedReadCache();
  assert.equal(readVerifiedRecords(logPath, { cache }).ok, true);

  const before = statSync(logPath);
  const substituteLog = buildAltLog(5);

  writeLines(logPath, lines(substituteLog));
  utimesSync(logPath, pinned, pinned);
  const after = statSync(logPath);
  assert.equal(after.size, before.size, "the substitution must preserve the file size");
  assert.equal(after.mtimeMs, before.mtimeMs, "the substitution must preserve the mtime");

  const result = readVerifiedRecords(logPath, { cache });
  assert.equal(result.ok, true, "the substituted log is itself a valid chain");
  if (!result.ok) throw new Error("unreachable");
  assert.deepEqual(
    result.records.map((record) => record.hash),
    lines(substituteLog).map((line) => (JSON.parse(line) as EventRecord).hash),
    "the records returned are the file's, not the remembered ones",
  );
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, resumed: 0, fullReproofs: 2 }, "the prefix hash must discard the entry");
});

test("an honest append verifies only the suffix and agrees with a cold read", () => {
  const { logPath, cache } = warmed();
  appendOrThrow(logPath, 6);

  const cached = readVerifiedRecords(logPath, { cache });
  const cold = readVerifiedRecords(logPath, { cache: null });
  assert.deepEqual(cached, cold);
  assert.equal(cached.ok && cached.records.length, 6);
  assert.deepEqual(cache.stats, { hits: 1, misses: 1, resumed: 0, fullReproofs: 2 });
});

test("a re-read of an unchanged log is identical to the cold read of the same bytes", () => {
  const { logPath, cache } = warmed();
  const cached = readVerifiedRecords(logPath, { cache });
  const cold = readVerifiedRecords(logPath, { cache: null });
  assert.deepEqual(cached, cold);
  assert.deepEqual(cache.stats, { hits: 1, misses: 1, resumed: 0, fullReproofs: 2 });
});

test("records handed out of the cache are frozen against mutation", () => {
  const { logPath, cache } = warmed();
  const result = readVerifiedRecords(logPath, { cache });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const record = result.records[0] as EventRecord & { payload: { note: string } };
  assert.throws(() => {
    record.payload.note = "rewritten";
  }, TypeError);
  assert.throws(() => {
    (record as { hash: string }).hash = "0".repeat(64);
  }, TypeError);
});

test("a schema directory change discards the entry: other schemas are other evidence", () => {
  const { logPath, cache } = warmed();
  const elsewhere = join(scratch, "no-such-schema-dir");
  const refused = readVerifiedRecords(logPath, { cache, schemaDir: elsewhere });
  assert.equal(refused.ok, false, "a missing schema dir fails closed");
  assert.deepEqual(cache.stats, { hits: 0, misses: 2, resumed: 0, fullReproofs: 2 });

  // And the failed read left nothing behind that the default schemas could reuse.
  const back = readVerifiedRecords(logPath, { cache });
  assert.equal(back.ok, true);
  assert.deepEqual(cache.stats, { hits: 0, misses: 3, resumed: 0, fullReproofs: 3 });
});

test("caches are per-instance, and eviction costs correctness nothing", () => {
  const cache = new VerifiedReadCache();
  const paths = Array.from({ length: 10 }, () => buildLog(2));
  for (const path of paths) assert.equal(readVerifiedRecords(path, { cache }).ok, true);
  assert.ok(cache.size <= 8, `bounded, got ${cache.size}`);

  // The evicted log still reads correctly; it is merely read cold again.
  const first = paths[0] as string;
  const cached = readVerifiedRecords(first, { cache });
  assert.deepEqual(cached, readVerifiedRecords(first, { cache: null }));

  const isolated = new VerifiedReadCache();
  assert.equal(isolated.size, 0);
  assert.deepEqual(isolated.stats, { hits: 0, misses: 0, resumed: 0, fullReproofs: 0 });
});

// ---------------------------------------------------------------------------
// Equivalence: the corpus, three readers, one result
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** Build a log (or not) and return the path plus any read options. */
  setUp: () => { logPath: string; options?: { expectedHead?: LogHead } };
  /** Damage or extend the log after the cache has been warmed on it. */
  damage?: (logPath: string) => void;
}

/**
 * The damage shapes of `tests/verify.test.ts` and `tests/state.test.ts`, applied
 * *in place* so that the warm reader is the one being tested. Appended garbage
 * lands past the cached head on purpose: the reported line numbers are then only
 * correct if a resumed walk still counts from the start of the file.
 */
const CORPUS: Scenario[] = [
  { name: "absent log", setUp: () => ({ logPath: freshPath() }) },
  {
    name: "empty file",
    setUp: () => {
      const logPath = buildLog(3);
      return { logPath };
    },
    damage: (logPath) => writeFileSync(logPath, ""),
  },
  { name: "clean, untouched", setUp: () => ({ logPath: buildLog(5) }) },
  { name: "single record", setUp: () => ({ logPath: buildLog(1) }) },
  {
    name: "honest growth",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => {
      appendOrThrow(logPath, 6);
      appendOrThrow(logPath, 7);
    },
  },
  {
    name: "torn tail",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) =>
      writeFileSync(logPath, `${readFileSync(logPath, "utf8")}{"seq":6,"ts":"2026-08`),
  },
  {
    name: "blank line appended",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => writeFileSync(logPath, `${readFileSync(logPath, "utf8")}   \n`),
  },
  {
    name: "malformed JSON appended",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => writeFileSync(logPath, `${readFileSync(logPath, "utf8")}{not json}\n`),
  },
  {
    name: "bad alg appended",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => {
      const record = JSON.parse(lines(logPath)[4] as string) as Record<string, unknown>;
      record["alg"] = "sha256/none";
      writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify(record)}\n`);
    },
  },
  {
    name: "schema-invalid appended",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => {
      const record = JSON.parse(lines(logPath)[4] as string) as Record<string, unknown>;
      delete record["actor"];
      writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify(record)}\n`);
    },
  },
  {
    name: "duplicate seq appended",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${lines(logPath)[4]}\n`),
  },
  {
    name: "deleted middle record",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => {
      const contents = lines(logPath);
      contents.splice(2, 1);
      writeLines(logPath, contents);
    },
  },
  {
    name: "reordered records",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => {
      const contents = lines(logPath);
      const second = contents[1] as string;
      contents[1] = contents[2] as string;
      contents[2] = second;
      writeLines(logPath, contents);
    },
  },
  {
    name: "truncated tail",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => writeLines(logPath, lines(logPath).slice(0, 3)),
  },
  {
    name: "non-genesis first record",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => writeLines(logPath, lines(logPath).slice(1)),
  },
  {
    name: "length-preserving mutation before the head",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => substitute(logPath, "marker-02", "forged-02"),
  },
  {
    name: "length-preserving mutation at the head",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => substitute(logPath, "marker-05", "forged-05"),
  },
  {
    name: "length-preserving mutation in the suffix",
    setUp: () => ({ logPath: buildLog(5) }),
    damage: (logPath) => {
      appendOrThrow(logPath, 6);
      substitute(logPath, "marker-06", "forged-06");
    },
  },
  {
    name: "anchored head, satisfied",
    setUp: () => {
      const logPath = buildLog(5);
      return { logPath, options: { expectedHead: head(logPath) } };
    },
  },
  {
    name: "anchored head, truncated away",
    setUp: () => {
      const logPath = buildLog(5);
      return { logPath, options: { expectedHead: head(logPath) } };
    },
    damage: (logPath) => writeLines(logPath, lines(logPath).slice(0, 4)),
  },
  {
    name: "anchored head, grown past",
    setUp: () => {
      const logPath = buildLog(5);
      return { logPath, options: { expectedHead: head(logPath) } };
    },
    damage: (logPath) => appendOrThrow(logPath, 6),
  },
];

for (const scenario of CORPUS) {
  test(`${scenario.name}: warm, cold, and uncached reads agree exactly`, () => {
    const { logPath, options = {} } = scenario.setUp();

    const warm = new VerifiedReadCache();
    readVerifiedRecords(logPath, { ...options, cache: warm });
    scenario.damage?.(logPath);

    const fromWarmCache = readVerifiedRecords(logPath, { ...options, cache: warm });
    const fromColdCache = readVerifiedRecords(logPath, {
      ...options,
      cache: new VerifiedReadCache(),
    });
    const uncached = readVerifiedRecords(logPath, { ...options, cache: null });

    assert.deepEqual(fromWarmCache, uncached, "a warm cached read must equal the uncached read");
    assert.deepEqual(fromColdCache, uncached, "a cold cached read must equal the uncached read");

    // Refusal messages carry file-absolute line numbers; a resumed walk that
    // counted from the suffix would differ here even when the code did not.
    if (!uncached.ok) assert.equal(refusal(fromWarmCache).message, uncached.message);

    // Reading twice more through the same warm cache changes nothing either.
    assert.deepEqual(readVerifiedRecords(logPath, { ...options, cache: warm }), uncached);
    assert.deepEqual(readVerifiedRecords(logPath, { ...options, cache: warm }), uncached);
  });
}
