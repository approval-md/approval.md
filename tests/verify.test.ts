/**
 * Log chain verification tests (APRV-7).
 *
 * Repo invariant: every log under test is built exclusively through the real
 * `appendEvent` path. Nothing here hand-writes a genuine record.
 *
 * Tamper fixtures are produced by *copying* a real log and corrupting the copy.
 * Mutating a copy is legitimate here and only here: the copy plays the
 * attacker, not the runtime. The runtime never touches an existing byte.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
} from "../src/core/log.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import { verify, type VerifyResult } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-verify-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function freshLog(): string {
  counter += 1;
  return join(scratch, `case-${counter}`, "log", "events.jsonl");
}

const KEY = "task-042:chaser:2026-08-04";

/** Six real events: registration, routing, approval, execution. */
const CHAIN: EventInput[] = [
  {
    ts: "2026-08-04T09:11:02Z",
    event: "task.registered",
    actor: "agent:planner",
    task: "task-042",
    channel: "cli",
    payload: { title: "Chase the overdue invoice" },
  },
  {
    ts: "2026-08-04T09:12:00Z",
    event: "route.proposed",
    actor: "agent:planner",
    task: "task-042",
    payload: { class: "email.send" },
  },
  {
    ts: "2026-08-04T09:13:40Z",
    event: "approval.requested",
    actor: "agent:chaser",
    task: "task-042",
    action_key: KEY,
    channel: "telegram",
  },
  {
    ts: "2026-08-04T09:14:02Z",
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: KEY,
    channel: "telegram",
    payload: { note: "go, but cc me" },
  },
  {
    ts: "2026-08-04T09:15:00Z",
    event: "execution.started",
    actor: "agent:chaser",
    task: "task-042",
    action_key: KEY,
  },
  {
    ts: "2026-08-04T09:15:09Z",
    event: "execution.completed",
    actor: "agent:chaser",
    task: "task-042",
    action_key: KEY,
    payload: { cost_usd: 0, recipient: "ap@vendor.example" },
  },
];

function appendOrThrow(logPath: string, input: EventInput): EventRecord {
  const result = appendEvent(logPath, input);
  assert.ok(result.ok, `append failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  return result.record;
}

/** Build a real log of the first `n` events of {@link CHAIN}. */
function buildLog(n = CHAIN.length): { logPath: string; records: EventRecord[] } {
  const logPath = freshLog();
  const records = CHAIN.slice(0, n).map((input) => appendOrThrow(logPath, input));
  return { logPath, records };
}

/** Copy a real log so the attacker works on the copy, never the original. */
function copyOf(logPath: string): string {
  const target = `${logPath}.tampered-${(counter += 1)}`;
  copyFileSync(logPath, target);
  return target;
}

function readRecords(logPath: string): EventRecord[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

/** Serialize an arbitrary (possibly malformed) record object to one line. */
function lineOf(record: unknown): string {
  return serializeRecord(record as EventRecord);
}

/**
 * The attacker: copy `logPath`, hand the parsed records to `transform`, and
 * rewrite the copy from whatever it returns. Returns the tampered path.
 */
function tamper(
  logPath: string,
  transform: (records: EventRecord[]) => unknown[],
): string {
  const target = copyOf(logPath);
  const rewritten = transform(readRecords(target));
  writeFileSync(target, rewritten.map((record) => `${lineOf(record)}\n`).join(""));
  return target;
}

/** Re-derive a record's own digest after its contents were altered. */
function reseal(record: EventRecord): EventRecord {
  const clone = { ...record };
  clone.hash = computeRecordHash(clone);
  return clone;
}

function assertCorrupt(
  result: VerifyResult,
  reason: string,
  firstBadSeq: number | null,
): void {
  assert.ok(
    result.status === "corrupt",
    `expected corrupt, got ${JSON.stringify(result)}`,
  );
  assert.equal(result.reason, reason);
  assert.equal(result.firstBadSeq, firstBadSeq);
  assert.ok(result.message.length > 0);
}

// ---------------------------------------------------------------- 1. clean --

test("an absent log is an empty log: clean, zero records, null head", () => {
  const result = verify(join(scratch, "does-not-exist", "events.jsonl"));
  assert.ok(result.status === "clean");
  assert.equal(result.records, 0);
  assert.equal(result.head, null);
});

test("a zero-byte log is clean with a null head", () => {
  const logPath = freshLog();
  appendOrThrow(logPath, CHAIN[0] as EventInput);
  const empty = copyOf(logPath);
  writeFileSync(empty, "");

  const result = verify(empty);
  assert.ok(result.status === "clean");
  assert.equal(result.records, 0);
  assert.equal(result.head, null);
});

test("a single genesis record verifies clean and reports its head", () => {
  const { logPath, records } = buildLog(1);
  const genesis = records[0] as EventRecord;
  assert.equal(genesis.prev, null);

  const result = verify(logPath);
  assert.ok(result.status === "clean");
  assert.equal(result.records, 1);
  assert.deepEqual(result.head, { seq: 1, hash: genesis.hash });
});

test("a six-record chain verifies clean and reports the last record as head", () => {
  const { logPath, records } = buildLog();
  const last = records[records.length - 1] as EventRecord;

  const result = verify(logPath);
  assert.ok(result.status === "clean");
  assert.equal(result.records, 6);
  assert.deepEqual(result.head, { seq: 6, hash: last.hash });
});

test("a clean log with a matching expectedHead anchor stays clean", () => {
  const { logPath, records } = buildLog();
  const last = records[records.length - 1] as EventRecord;

  const result = verify(logPath, {
    expectedHead: { seq: last.seq, hash: last.hash },
    schemaDir: DEFAULT_SCHEMA_DIR,
  });
  assert.ok(result.status === "clean");
  assert.equal(result.records, 6);
});

// ------------------------------------------------------------- 2. mutation --

test("a payload edit is caught as hash-mismatch at that record", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 4
        ? { ...record, payload: { note: "go, and do not cc me" } }
        : record,
    ),
  );

  assertCorrupt(verify(tampered), "hash-mismatch", 4);
});

test("an actor swap is caught as hash-mismatch at that record", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 4 ? { ...record, actor: "human:mallory" } : record,
    ),
  );

  assertCorrupt(verify(tampered), "hash-mismatch", 4);
});

test("a ts change is caught as hash-mismatch at that record", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 2 ? { ...record, ts: "2026-08-04T23:59:59Z" } : record,
    ),
  );

  assertCorrupt(verify(tampered), "hash-mismatch", 2);
});

// ------------------------------------------------- 3. deletion and reorder --

test("tail truncation verifies clean from the file alone — only an anchor catches it", () => {
  const { logPath, records } = buildLog();
  const honestHead = records[records.length - 1] as EventRecord;
  const truncated = tamper(logPath, (all) => all.slice(0, 5));

  // Documented limitation: dropping records off the tail leaves a valid chain.
  // verify() on the file alone CANNOT tell this from an honest five-record log.
  const unanchored = verify(truncated);
  assert.ok(unanchored.status === "clean");
  assert.equal(unanchored.records, 5);

  // With an externally anchored head, the truncation is evidence.
  const anchored = verify(truncated, {
    expectedHead: { seq: honestHead.seq, hash: honestHead.hash },
  });
  assertCorrupt(anchored, "head-mismatch", 5);
});

test("an anchor also catches truncation all the way to an empty log", () => {
  const { logPath, records } = buildLog();
  const honestHead = records[records.length - 1] as EventRecord;
  const emptied = copyOf(logPath);
  writeFileSync(emptied, "");

  assertCorrupt(
    verify(emptied, { expectedHead: { seq: honestHead.seq, hash: honestHead.hash } }),
    "head-mismatch",
    null,
  );
});

test("deleting a middle record breaks seq succession before prev linkage", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.filter((record) => record.seq !== 3),
  );

  // seq is checked before prev, so the surviving record 4 lands where 3 was
  // expected and reports seq-gap.
  assertCorrupt(verify(tampered), "seq-gap", 4);
});

test("reordering two records is caught", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) => {
    const swapped = [...records];
    const third = swapped[2] as EventRecord;
    const fourth = swapped[3] as EventRecord;
    swapped[2] = fourth;
    swapped[3] = third;
    return swapped;
  });

  assertCorrupt(verify(tampered), "seq-gap", 4);
});

// --------------------------------------------------------------- 4. splice --

test("a splice — self-consistent record re-pointed at an older ancestor — is prev-mismatch", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) => {
    const ancestor = records[0] as EventRecord; // hash of seq 1, not seq 3
    return records.map((record) =>
      record.seq === 4 ? reseal({ ...record, prev: ancestor.hash }) : record,
    );
  });

  // Record 4's own digest is valid — that is the point of the case: only the
  // chain linkage betrays it.
  const stored = readRecords(tampered);
  const spliced = stored[3] as EventRecord;
  assert.equal(computeRecordHash(spliced), spliced.hash);

  assertCorrupt(verify(tampered), "prev-mismatch", 4);
});

// --------------------------------------------------- 5. partial forged tail --

test("mutating a record and resealing only itself breaks the chain at the next record", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 3 ? reseal({ ...record, channel: "sms" }) : record,
    ),
  );

  assertCorrupt(verify(tampered), "prev-mismatch", 4);
});

// ------------------------------------------- 6. fully recomputed forgery --

test("a fully recomputed suffix is indistinguishable without an anchor, and caught with one", () => {
  const { logPath, records } = buildLog();
  const honestHead = records[records.length - 1] as EventRecord;

  const forged = tamper(logPath, (all) => {
    const rebuilt: EventRecord[] = [];
    let prev: string | null = null;
    for (const record of all) {
      const next: EventRecord =
        record.seq === 4
          ? { ...record, prev, payload: { note: "approved, no conditions" } }
          : { ...record, prev };
      rebuilt.push(reseal(next));
      prev = (rebuilt[rebuilt.length - 1] as EventRecord).hash;
    }
    return rebuilt;
  });

  // Documented detection boundary: the forged file is internally perfect.
  const unanchored = verify(forged);
  assert.ok(
    unanchored.status === "clean",
    "a full recompute is self-consistent by construction",
  );
  assert.equal(unanchored.records, 6);
  assert.ok(unanchored.head !== null);
  assert.notEqual(unanchored.head.hash, honestHead.hash);

  // The external anchor is what closes the gap.
  assertCorrupt(
    verify(forged, { expectedHead: { seq: honestHead.seq, hash: honestHead.hash } }),
    "head-mismatch",
    6,
  );
});

// ------------------------------------------------------------------ 7. alg --

test("a record with alg stripped reports bad-alg, not schema noise", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) => {
      if (record.seq !== 3) return record;
      const stripped: Record<string, unknown> = { ...record };
      delete stripped["alg"];
      delete stripped["hash"];
      stripped["hash"] = computeRecordHash(stripped as unknown as EventRecord);
      return stripped;
    }),
  );

  assertCorrupt(verify(tampered), "bad-alg", 3);
});

test("an unrecognized alg reports bad-alg even when the record hashes correctly", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 3
        ? reseal({ ...record, alg: "sha1/jcs" as unknown as typeof record.alg })
        : record,
    ),
  );

  const stored = readRecords(tampered);
  const swapped = stored[2] as EventRecord;
  assert.equal(computeRecordHash(swapped), swapped.hash, "digest is self-consistent");

  assertCorrupt(verify(tampered), "bad-alg", 3);
});

// ------------------------------------------------------------------ 8. seq --

test("a verbatim duplicated record reports seq-duplicate", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) => {
    const doubled: EventRecord[] = [];
    for (const record of records) {
      doubled.push(record);
      if (record.seq === 3) doubled.push(record);
    }
    return doubled;
  });

  assertCorrupt(verify(tampered), "seq-duplicate", 3);
});

test("a renumbered record with a recomputed hash reports seq-gap", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records
      .filter((record) => record.seq <= 4)
      .map((record) => (record.seq === 4 ? reseal({ ...record, seq: 5 }) : record)),
  );

  assertCorrupt(verify(tampered), "seq-gap", 5);
});

test("a first record with a non-null prev reports not-genesis", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) => {
    const genesis = records[0] as EventRecord;
    const orphaned = reseal({ ...genesis, prev: (records[1] as EventRecord).hash });
    return [orphaned];
  });

  assertCorrupt(verify(tampered), "not-genesis", 1);
});

// ------------------------------------------------------------ 9. torn tail --

test("garbage appended without a newline is a torn tail, not corruption", () => {
  const { logPath } = buildLog();
  const torn = copyOf(logPath);
  appendFileSync(torn, '{"seq":7,"ts":"2026-0');

  const result = verify(torn);
  assert.ok(result.status === "torn-tail", JSON.stringify(result));
  assert.equal(result.records, 6);
  assert.equal(result.intactThroughSeq, 6);
  assert.match(result.message, /crashed write/);
});

test("a non-JSON unterminated tail on an otherwise clean log is also torn-tail", () => {
  const { logPath } = buildLog(3);
  const torn = copyOf(logPath);
  appendFileSync(torn, "  not json at all");

  const result = verify(torn);
  assert.ok(result.status === "torn-tail");
  assert.equal(result.records, 3);
  assert.equal(result.intactThroughSeq, 3);
});

test("a torn tail on top of a corrupt prefix reports the corruption, not the tear", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 2 ? { ...record, actor: "human:mallory" } : record,
    ),
  );
  appendFileSync(tampered, '{"seq":7,"ts":');

  assertCorrupt(verify(tampered), "hash-mismatch", 2);
});

// ------------------------------------------------------------ 10. read-only --

interface FileState {
  bytes: string;
  size: number;
  mtimeMs: number;
}

function snapshot(path: string): FileState {
  const stats = statSync(path);
  return { bytes: readFileSync(path, "utf8"), size: stats.size, mtimeMs: stats.mtimeMs };
}

test("verify never modifies the log, on every status path", () => {
  const { logPath, records } = buildLog();

  const corruptPath = tamper(logPath, (all) =>
    all.map((record) => (record.seq === 5 ? { ...record, ts: "2026-08-05T00:00:00Z" } : record)),
  );
  const tornPath = copyOf(logPath);
  appendFileSync(tornPath, "{partial");

  const cases: Array<[string, VerifyResult["status"]]> = [
    [logPath, "clean"],
    [corruptPath, "corrupt"],
    [tornPath, "torn-tail"],
  ];

  for (const [path, expected] of cases) {
    const before = snapshot(path);
    const result = verify(path, {
      expectedHead: { seq: 6, hash: (records[5] as EventRecord).hash },
    });
    const after = snapshot(path);

    assert.equal(result.status, expected, `status for ${path}`);
    assert.equal(after.bytes, before.bytes, `bytes unchanged for ${path}`);
    assert.equal(after.size, before.size, `size unchanged for ${path}`);
    assert.equal(after.mtimeMs, before.mtimeMs, `mtime unchanged for ${path}`);
  }
});

test("verify creates no lockfile and no sibling files", () => {
  const { logPath } = buildLog(2);
  verify(logPath);
  assert.throws(() => statSync(`${logPath}.lock`), /ENOENT/);
});

// ------------------------------------------------------- 11. malformed line --

test("an invalid JSON line mid-chain is malformed-line with an unknowable seq", () => {
  const { logPath } = buildLog();
  const target = copyOf(logPath);
  const lines = readFileSync(target, "utf8").split("\n").filter((line) => line.length > 0);
  lines[2] = '{"seq":3,"ts":"2026-08-04T09:13:40Z",';
  writeFileSync(target, `${lines.join("\n")}\n`);

  const result = verify(target);
  assertCorrupt(result, "malformed-line", null);
  assert.match(result.status === "corrupt" ? result.message : "", /line 3/);
});

test("a blank line mid-chain is malformed-line", () => {
  const { logPath } = buildLog();
  const target = copyOf(logPath);
  const lines = readFileSync(target, "utf8").split("\n").filter((line) => line.length > 0);
  lines.splice(2, 0, "");
  writeFileSync(target, `${lines.join("\n")}\n`);

  const result = verify(target);
  assertCorrupt(result, "malformed-line", null);
  assert.match(result.status === "corrupt" ? result.message : "", /line 3/);
});

// ----------------------------------------------------- 12. schema-invalid --

test("a schema-invalid record mid-chain is caught even when its digest is self-consistent", () => {
  const { logPath } = buildLog();
  // SPEC.md §10.1: approval.granted MUST come from a `human:` actor. Forge an
  // agent-granted approval and reseal it so the failure is the schema, not the
  // hash — the write boundary would never have accepted this record.
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 4 ? reseal({ ...record, actor: "agent:chaser" }) : record,
    ),
  );

  const stored = readRecords(tampered);
  const forged = stored[3] as EventRecord;
  assert.equal(computeRecordHash(forged), forged.hash, "digest is self-consistent");

  assertCorrupt(verify(tampered, { schemaDir: DEFAULT_SCHEMA_DIR }), "schema-invalid", 4);
});

test("an unrecognized actor prefix is rejected (SPEC.md §8) as schema-invalid", () => {
  const { logPath } = buildLog();
  const tampered = tamper(logPath, (records) =>
    records.map((record) =>
      record.seq === 2 ? reseal({ ...record, actor: "robot:rogue" }) : record,
    ),
  );

  assertCorrupt(verify(tampered), "schema-invalid", 2);
});
