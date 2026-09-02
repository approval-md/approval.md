/**
 * Append-only event log writer tests (APRV-6 Part B).
 *
 * Repo invariant: every log under test is built exclusively through
 * `appendEvent`. Nothing here hand-writes a record line, because a hand-written
 * line is a fabricated log entry. The one file this suite writes by hand is a
 * deliberately *corrupt* tail — an artefact of a crashed writer, not a record —
 * used to prove the writer refuses to chain onto it.
 */

import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  ALG,
  APPEND_ERROR_CODES,
  GENESIS_PREV,
  appendEvent,
  computeRecordHash,
  serializeRecord,
  verifyRecordHash,
  type EventInput,
  type EventRecord,
} from "../src/core/log.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-log-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh log path inside a fresh directory (nested, to exercise mkdir). */
function freshLog(): string {
  counter += 1;
  return join(scratch, `case-${counter}`, "log", "events.jsonl");
}

const REGISTERED: EventInput = {
  ts: "2026-08-04T09:11:02Z",
  event: "task.registered",
  actor: "agent:planner",
  task: "task-042",
  channel: "cli",
  payload: { title: "Chase the overdue invoice" },
};

const REQUESTED: EventInput = {
  ts: "2026-08-04T09:13:40Z",
  event: "approval.requested",
  actor: "agent:chaser",
  task: "task-042",
  action_key: "task-042:chaser:2026-08-04",
  channel: "telegram",
};

const GRANTED: EventInput = {
  ts: "2026-08-04T09:14:02Z",
  event: "approval.granted",
  actor: "human:carter",
  task: "task-042",
  action_key: "task-042:chaser:2026-08-04",
  channel: "telegram",
  payload: { note: "go, but cc me" },
};

function appendOrThrow(logPath: string, input: EventInput): EventRecord {
  const result = appendEvent(logPath, input);
  assert.ok(result.ok, `append failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  return result.record;
}

function readRecords(logPath: string): EventRecord[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

test("the first record is genesis: seq 1, prev null, alg stamped", () => {
  const logPath = freshLog();
  const record = appendOrThrow(logPath, REGISTERED);

  assert.equal(record.seq, 1);
  assert.equal(record.prev, GENESIS_PREV);
  assert.equal(record.prev, null);
  assert.equal(record.alg, ALG);
  assert.equal(record.alg, "sha256/jcs");
  assert.match(record.hash, /^[a-f0-9]{64}$/);
  assert.ok(verifyRecordHash(record));
});

test("a chain of records links prev[i] to hash[i-1] with seq 1..N", () => {
  const logPath = freshLog();
  const inputs: EventInput[] = [
    REGISTERED,
    REQUESTED,
    GRANTED,
    {
      ts: "2026-08-04T09:15:00Z",
      event: "execution.started",
      actor: "agent:chaser",
      task: "task-042",
      action_key: "task-042:chaser:2026-08-04",
    },
    {
      ts: "2026-08-04T09:15:09Z",
      event: "execution.completed",
      actor: "agent:chaser",
      task: "task-042",
      action_key: "task-042:chaser:2026-08-04",
      payload: { cost_usd: 0, recipient: "ap@vendor.example" },
    },
  ];
  const appended = inputs.map((input) => appendOrThrow(logPath, input));

  const stored = readRecords(logPath);
  assert.equal(stored.length, inputs.length);
  assert.deepEqual(stored, appended, "stored lines parse back to exactly the returned records");

  assert.equal(stored[0]?.prev, null);
  for (const [index, record] of stored.entries()) {
    assert.equal(record.seq, index + 1);
    assert.equal(record.alg, "sha256/jcs");
    assert.ok(verifyRecordHash(record), `record ${record.seq} hash must verify`);
    if (index > 0) {
      assert.equal(record.prev, stored[index - 1]?.hash, `record ${record.seq} must chain`);
    }
  }
});

test("stored bytes are the canonicalization that was hashed, one line each", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);
  const second = appendOrThrow(logPath, GRANTED);

  const raw = readFileSync(logPath, "utf8");
  assert.equal(raw, `${serializeRecord(first)}\n${serializeRecord(second)}\n`);
  assert.equal(raw.split("\n").length - 1, 2, "exactly one newline per record");

  for (const record of readRecords(logPath)) {
    assert.equal(computeRecordHash(record), record.hash);
  }
});

test("computeRecordHash ignores the hash field and is deterministic", () => {
  const logPath = freshLog();
  const record = appendOrThrow(logPath, GRANTED);
  const { hash, ...unhashed } = record;

  assert.equal(computeRecordHash(unhashed), hash);
  assert.equal(computeRecordHash(record), hash);
  assert.equal(computeRecordHash(record), computeRecordHash(record));
});

test("verifyRecordHash rejects a record whose content was altered", () => {
  const logPath = freshLog();
  const record = appendOrThrow(logPath, GRANTED);

  assert.ok(verifyRecordHash(record));
  assert.equal(verifyRecordHash({ ...record, actor: "human:mallory" }), false);
  assert.equal(verifyRecordHash({ ...record, prev: "0".repeat(64) }), false);
  assert.equal(verifyRecordHash({ ...record, seq: record.seq + 1 }), false);
  assert.equal(
    verifyRecordHash({ ...record, payload: { note: "go, but cc me " } }),
    false,
    "a single trailing space must break the digest",
  );
});

test("a schema-invalid event is rejected and the file is left byte-identical", () => {
  const logPath = freshLog();
  appendOrThrow(logPath, REGISTERED);
  const before = readFileSync(logPath);
  const sizeBefore = statSync(logPath).size;

  // approval.granted from an agent: the gate approving itself (schema forbids it).
  const selfGrant = appendEvent(logPath, {
    ...GRANTED,
    actor: "agent:chaser",
  });
  assert.equal(selfGrant.ok, false);
  if (!selfGrant.ok) {
    assert.equal(selfGrant.error.code, "validation");
    assert.ok((selfGrant.error.errors ?? []).length > 0);
  }

  // An event type outside the closed v0.1 set.
  const unknownType = appendEvent(logPath, {
    ...REGISTERED,
    event: "task.deleted" as EventInput["event"],
  });
  assert.equal(unknownType.ok, false);
  if (!unknownType.ok) assert.equal(unknownType.error.code, "validation");

  // approval.requested without an action_key.
  const noActionKey = appendEvent(logPath, {
    ts: "2026-08-04T09:13:40Z",
    event: "approval.requested",
    actor: "agent:chaser",
    task: "task-042",
  });
  assert.equal(noActionKey.ok, false);
  if (!noActionKey.ok) assert.equal(noActionKey.error.code, "validation");

  // An actor with an unrecognized prefix (SPEC.md §8: exactly three prefixes).
  const badActor = appendEvent(logPath, { ...REGISTERED, actor: "robot:chaser" });
  assert.equal(badActor.ok, false);
  if (!badActor.ok) assert.equal(badActor.error.code, "validation");

  assert.deepEqual(readFileSync(logPath), before, "log bytes must be untouched");
  assert.equal(statSync(logPath).size, sizeBefore);
});

test("a rejected append does not consume a seq: the next good append gets it", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);
  const rejected = appendEvent(logPath, { ...GRANTED, actor: "agent:chaser" });
  assert.equal(rejected.ok, false);

  const second = appendOrThrow(logPath, GRANTED);
  assert.equal(second.seq, 2);
  assert.equal(second.prev, first.hash);
});

test("an unparseable ts is caught by the write boundary", () => {
  const logPath = freshLog();
  const result = appendEvent(logPath, { ...REGISTERED, ts: "yesterday afternoon" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "validation");
});

test("a truncated tail is refused rather than chained onto", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);
  const good = readFileSync(logPath, "utf8");

  // Simulate a writer killed mid-line: a complete record plus a partial one.
  const partial = serializeRecord(first).slice(0, 40);
  writeFileSync(logPath, `${good}${partial}`, "utf8");
  const before = readFileSync(logPath);

  const result = appendEvent(logPath, GRANTED);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "corrupt-tail");
    assert.match(result.error.message, /truncated/);
  }
  assert.deepEqual(readFileSync(logPath), before, "a refused append writes nothing");
});

test("an unparseable last line is refused", () => {
  const logPath = freshLog();
  appendOrThrow(logPath, REGISTERED);
  const good = readFileSync(logPath, "utf8");
  writeFileSync(logPath, `${good}{"seq":2,"ts":\n`, "utf8");

  const result = appendEvent(logPath, GRANTED);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "corrupt-tail");
});

test("a last line without a usable seq or hash is refused", () => {
  const logPath = freshLog();
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `{"seq":1,"hash":"nope"}\n`, "utf8");
  const result = appendEvent(logPath, GRANTED);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /64-hex/);

  writeFileSync(logPath, `{"hash":"${"a".repeat(64)}"}\n`, "utf8");
  const noSeq = appendEvent(logPath, GRANTED);
  assert.equal(noSeq.ok, false);
  if (!noSeq.ok) assert.match(noSeq.error.message, /"seq"/);
});

test("sequential appenders take the lock in turn and produce a clean chain", () => {
  const logPath = freshLog();
  // Each call acquires and releases the lockfile; contention-free runs must
  // leave no lock behind and no gap in the chain.
  const records = [REGISTERED, REQUESTED, GRANTED].map((input) => appendOrThrow(logPath, input));
  assert.deepEqual(
    records.map((record) => record.seq),
    [1, 2, 3],
  );
  assert.throws(() => statSync(`${logPath}.lock`), /ENOENT/, "the lock is released");
});

test("a held lock makes the next append time out cleanly, without corruption", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);
  const before = readFileSync(logPath);

  // Stand in for a concurrent writer mid-transaction: hold the lockfile.
  closeSync(openSync(`${logPath}.lock`, "wx"));
  try {
    const started = Date.now();
    const blocked = appendEvent(logPath, GRANTED, { lockTimeoutMs: 60, lockRetryMs: 5 });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.error.code, "lock-timeout");
      assert.match(blocked.error.message, /another writer holds/);
    }
    assert.ok(Date.now() - started >= 50, "the writer waits for the timeout before giving up");
    assert.deepEqual(readFileSync(logPath), before, "a blocked append writes nothing");
  } finally {
    unlinkSync(`${logPath}.lock`);
  }

  // Once the lock is free the chain continues from where it left off.
  const second = appendOrThrow(logPath, GRANTED);
  assert.equal(second.seq, 2);
  assert.equal(second.prev, first.hash);
});

// ---------------------------------------------------------------------------
// compare-and-append (APRV-20 finding B1)
// ---------------------------------------------------------------------------

test("expectedHead matching the tail lets the append through", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);

  const result = appendEvent(logPath, REQUESTED, {
    expectedHead: { seq: first.seq, hash: first.hash },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.seq, 2);
    assert.equal(result.record.prev, first.hash);
  }
});

test("a moved head refuses head-moved and writes nothing", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);
  const stale = { seq: first.seq, hash: first.hash };

  // Someone else appends between the caller's read and the caller's append.
  appendOrThrow(logPath, REQUESTED);
  const before = readFileSync(logPath);

  const result = appendEvent(logPath, GRANTED, { expectedHead: stale });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "head-moved");
    assert.match(result.error.message, /head moved/);
    assert.match(result.error.message, /Nothing was written/);
  }
  assert.deepEqual(readFileSync(logPath), before, "a refused append writes nothing");
});

test("a head-moved refusal does not consume a seq", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);
  const second = appendOrThrow(logPath, REQUESTED);

  const refused = appendEvent(logPath, GRANTED, {
    expectedHead: { seq: first.seq, hash: first.hash },
  });
  assert.equal(refused.ok, false);

  const third = appendOrThrow(logPath, GRANTED);
  assert.equal(third.seq, 3);
  assert.equal(third.prev, second.hash);
});

test("expectedHead null asserts an empty log", () => {
  const logPath = freshLog();

  const genesis = appendEvent(logPath, REGISTERED, { expectedHead: null });
  assert.equal(genesis.ok, true);
  if (genesis.ok) assert.equal(genesis.record.seq, 1);

  // The log is no longer empty, so the same precondition must now refuse.
  const second = appendEvent(logPath, REQUESTED, { expectedHead: null });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, "head-moved");
    assert.match(second.error.message, /expected to be empty/);
  }
  assert.equal(readRecords(logPath).length, 1);
});

test("a same-seq, different-hash head is refused: the digest is compared too", () => {
  const logPath = freshLog();
  const first = appendOrThrow(logPath, REGISTERED);

  const result = appendEvent(logPath, REQUESTED, {
    expectedHead: { seq: first.seq, hash: "0".repeat(64) },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "head-moved");
});

test("omitting expectedHead keeps the unconditional append behaviour", () => {
  const logPath = freshLog();
  appendOrThrow(logPath, REGISTERED);
  // No precondition: an append with no read-dependent decision behind it (the
  // attestation path) is unaffected by whatever landed first.
  appendOrThrow(logPath, REQUESTED);
  assert.deepEqual(
    readRecords(logPath).map((record) => record.seq),
    [1, 2],
  );
});

test("head-moved is pinned in the append-error union", () => {
  assert.deepEqual([...APPEND_ERROR_CODES], [
    "lock-timeout",
    "corrupt-tail",
    "validation",
    "canonicalization",
    "io",
    // APRV-20 finding B1, human-approved 2026-08-07: an addition to the closed
    // union, not a rename of anything in it.
    "head-moved",
  ]);
});

test("the module exposes no mutation, reorder, or truncate operation", async () => {
  const module = await import("../src/core/log.js");
  assert.deepEqual(
    Object.keys(module).sort(),
    [
      // APRV-20 added the pinned append-error union. It is a constant, not an
      // operation: nothing here mutates, reorders, or truncates.
      "ALG",
      "APPEND_ERROR_CODES",
      "GENESIS_PREV",
      "appendEvent",
      "computeRecordHash",
      "serializeRecord",
      "verifyRecordHash",
      // APRV-125 added the whole-operation lock holder. It hands its callback
      // no handle and no write primitive: what it grants is EXCLUSION, and a
      // caller holding it still has only the append-only API everyone else has.
      // Nothing here mutates, reorders, or truncates.
      "withAppendLock",
    ],
  );
});

test("a record larger than the tail read window is still chained onto (APRV-206)", () => {
  // The append reads the END of the file rather than all of it, in a window it
  // doubles until the last line is whole inside it. A record bigger than the
  // first window is the case that exercises the doubling, and this repository
  // writes them: a policy proposal carries the policy text, and a payload
  // census carries a rendering.
  const logPath = freshLog();
  appendOrThrow(logPath, REGISTERED);

  const huge: EventInput = {
    ...REGISTERED,
    task: "task-huge",
    payload: { title: "x".repeat(200_000) },
  };
  const big = appendOrThrow(logPath, huge);
  assert.ok(big.hash.length === 64);

  // The next append must chain onto that oversized line, which means it must
  // have read the whole of it back.
  const next = appendOrThrow(logPath, REQUESTED);
  assert.equal(next.seq, 3);
  assert.equal(next.prev, big.hash);

  const records = readRecords(logPath);
  assert.equal(records.length, 3);
  const stored = (records[1] as EventRecord).payload?.["title"];
  assert.equal(typeof stored === "string" ? stored.length : -1, 200_000);
  for (const record of readRecords(logPath)) assert.ok(verifyRecordHash(record));
});

test("a multi-byte character in the last line survives the tail read (APRV-206)", () => {
  // The tail window is cut at a newline before it is decoded, so a character
  // whose bytes straddle the cut cannot be mangled into a different `prev`.
  const logPath = freshLog();
  const accented = appendOrThrow(logPath, {
    ...REGISTERED,
    payload: { title: "£1,200 — naïve — 🧾".repeat(64) },
  });
  const next = appendOrThrow(logPath, REQUESTED);
  assert.equal(next.prev, accented.hash);
  for (const record of readRecords(logPath)) assert.ok(verifyRecordHash(record));
});

test("withAppendLock grants exclusion and no write primitive", async () => {
  const { withAppendLock } = await import("../src/core/log.js");
  const logPath = freshLog();
  appendOrThrow(logPath, REGISTERED);
  const before = readFileSync(logPath);

  // The callback receives nothing at all: exclusion is the whole grant.
  let argumentCount = -1;
  const held = withAppendLock(logPath, (...args: unknown[]) => {
    argumentCount = args.length;
    // An append attempted from INSIDE the hold cannot take the lock the hold is
    // already holding, so it refuses rather than interleaving. That refusal is
    // the property `log sync` depends on for the whole of its ceremony.
    return appendEvent(logPath, REQUESTED, { lockTimeoutMs: 20, lockRetryMs: 5 });
  });

  assert.equal(argumentCount, 0);
  assert.equal(held.ok, true);
  if (held.ok) {
    assert.equal(held.value.ok, false);
    if (!held.value.ok) assert.equal(held.value.error.code, "lock-timeout");
  }
  assert.deepEqual(readFileSync(logPath), before, "nothing was written under the hold");

  // The lock is released even though the callback's own result was a refusal.
  assert.equal(appendEvent(logPath, REQUESTED).ok, true);
});
