/**
 * SQLite index projection tests (APRV-8).
 *
 * Repo invariant, restated: every log under test is built exclusively through
 * the real `appendEvent` path. Nothing here hand-writes a genuine record.
 *
 * Tamper and torn-tail fixtures are produced by *copying* a real log and
 * damaging the copy. The copy plays the crashed writer or the attacker; the
 * runtime never touches an existing byte, and neither does `reindex`.
 *
 * Every query assertion goes through real SQL against the built file, because
 * the promise in SPEC.md §9.2 is that *any* SQLite client can read this index —
 * not that our own accessors agree with themselves.
 */

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { appendEvent, type EventInput, type EventRecord } from "../src/core/log.js";
import { indexHead, reindex, INDEX_SCHEMA_VERSION } from "../src/core/reindex.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-reindex-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function caseDir(): string {
  counter += 1;
  return join(scratch, `case-${counter}`);
}

const KEY = "task-042:chaser:2026-08-04";
const OTHER_KEY = "task-099:auditor:2026-08-04";

/** Seven real events across two tasks, two actors, and a spread of timestamps. */
const CHAIN: EventInput[] = [
  {
    ts: "2026-08-04T09:11:02Z",
    event: "task.registered",
    actor: "agent:planner",
    task: "task-042",
    channel: "cli",
    payload: { title: "Chase the overdue invoice", tags: ["ap", "vendor"] },
  },
  {
    ts: "2026-08-04T09:12:00Z",
    event: "route.proposed",
    actor: "agent:planner",
    task: "task-042",
    payload: { class: "email.send", confidence: 0.9 },
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
    ts: "2026-08-04T10:14:02Z",
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: KEY,
    channel: "telegram",
    payload: { note: "go, but cc me" },
  },
  {
    ts: "2026-08-04T10:15:00Z",
    event: "execution.started",
    actor: "agent:chaser",
    task: "task-042",
    action_key: KEY,
  },
  {
    ts: "2026-08-04T11:15:09Z",
    event: "execution.completed",
    actor: "agent:chaser",
    task: "task-042",
    action_key: KEY,
    payload: { cost_usd: 0, recipient: "ap@vendor.example" },
  },
  {
    ts: "2026-08-04T12:01:00Z",
    event: "audit.sampled",
    actor: "system:auditor",
    task: "task-099",
    action_key: OTHER_KEY,
    payload: { reason: "spot check" },
  },
];

function appendOrThrow(logPath: string, input: EventInput): EventRecord {
  const result = appendEvent(logPath, input);
  assert.ok(result.ok, `append failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  return result.record;
}

interface Fixture {
  logPath: string;
  indexPath: string;
  records: EventRecord[];
}

/** Build a real log of the first `n` events of {@link CHAIN}, plus a target path. */
function buildLog(n = CHAIN.length): Fixture {
  const dir = caseDir();
  const logPath = join(dir, "log", "events.jsonl");
  const indexPath = join(dir, "index.sqlite");
  const records = CHAIN.slice(0, n).map((input) => appendOrThrow(logPath, input));
  return { logPath, indexPath, records };
}

/** Open the built index the way any third-party SQLite client would. */
function open(indexPath: string): Database.Database {
  return new Database(indexPath, { readonly: true, fileMustExist: true });
}

function query(indexPath: string, sql: string, params: unknown[] = []): unknown[] {
  const db = open(indexPath);
  try {
    return db.prepare(sql).all(...(params as never[]));
  } finally {
    db.close();
  }
}

function allEvents(indexPath: string): unknown[] {
  return query(indexPath, "SELECT * FROM events ORDER BY seq");
}

function metaRow(indexPath: string): Record<string, unknown> {
  const rows = query(indexPath, "SELECT * FROM meta");
  assert.equal(rows.length, 1, "meta must hold exactly one row");
  return rows[0] as Record<string, unknown>;
}

/** Byte-and-mtime fingerprint of the log, to prove reindex never writes to it. */
function logFingerprint(logPath: string): { bytes: string; mtimeMs: number; size: number } {
  const stat = statSync(logPath);
  return { bytes: readFileSync(logPath, "utf8"), mtimeMs: stat.mtimeMs, size: stat.size };
}

/** Copy a real log and tear its final line, the signature of a crashed write. */
function tornCopyOf(logPath: string): string {
  counter += 1;
  const target = `${logPath}.torn-${counter}`;
  copyFileSync(logPath, target);
  const lines = readFileSync(target, "utf8").split("\n").filter((line) => line.length > 0);
  const last = lines[lines.length - 1] as string;
  writeFileSync(target, lines.slice(0, -1).map((line) => `${line}\n`).join(""));
  appendFileSync(target, last.slice(0, Math.floor(last.length / 2)));
  return target;
}

/** Copy a real log and mutate a middle record's contents without resealing it. */
function corruptCopyOf(logPath: string): string {
  counter += 1;
  const target = `${logPath}.corrupt-${counter}`;
  copyFileSync(logPath, target);
  const lines = readFileSync(target, "utf8").split("\n").filter((line) => line.length > 0);
  const middle = Math.floor(lines.length / 2);
  const record = JSON.parse(lines[middle] as string) as EventRecord;
  record.actor = "human:mallory";
  lines[middle] = JSON.stringify(record);
  writeFileSync(target, lines.map((line) => `${line}\n`).join(""));
  return target;
}

// -------------------------------------------------------- 1. clean rebuild --

test("a clean log rebuilds into a queryable index with the right head", () => {
  const { logPath, indexPath, records } = buildLog();
  const result = reindex(logPath, indexPath);

  assert.ok(result.ok, `reindex failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  assert.equal(result.records, CHAIN.length);
  assert.equal(result.truncated, false);
  const last = records[records.length - 1] as EventRecord;
  assert.deepEqual(result.head, { seq: last.seq, hash: last.hash });

  const rows = allEvents(indexPath) as EventRecord[];
  assert.equal(rows.length, CHAIN.length);
  assert.deepEqual(
    rows.map((row) => row.seq),
    records.map((record) => record.seq),
  );
  assert.deepEqual(
    rows.map((row) => row.hash),
    records.map((record) => record.hash),
  );

  const meta = metaRow(indexPath);
  assert.equal(meta["schema_version"], INDEX_SCHEMA_VERSION);
  assert.equal(meta["built_from_seq"], last.seq);
  assert.equal(meta["built_from_hash"], last.hash);
  assert.equal(meta["truncated"], 0);
  assert.equal(meta["intact_through_seq"], null);
});

test("events are queryable by task, event type, actor, and time range", () => {
  const { logPath, indexPath } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);

  const byTask = query(indexPath, "SELECT seq FROM events WHERE task = ? ORDER BY seq", [
    "task-042",
  ]) as { seq: number }[];
  assert.deepEqual(byTask.map((row) => row.seq), [1, 2, 3, 4, 5, 6]);

  const byOtherTask = query(indexPath, "SELECT seq FROM events WHERE task = ?", ["task-099"]) as {
    seq: number;
  }[];
  assert.deepEqual(byOtherTask.map((row) => row.seq), [7]);

  const byEvent = query(indexPath, "SELECT seq, actor FROM events WHERE event = ?", [
    "approval.granted",
  ]) as { seq: number; actor: string }[];
  assert.deepEqual(byEvent, [{ seq: 4, actor: "human:carter" }]);

  const byActor = query(
    indexPath,
    "SELECT seq FROM events WHERE actor = ? ORDER BY seq",
    ["agent:chaser"],
  ) as { seq: number }[];
  assert.deepEqual(byActor.map((row) => row.seq), [3, 5, 6]);

  // RFC 3339 UTC timestamps sort lexicographically, so a TEXT range is a time range.
  const byWindow = query(
    indexPath,
    "SELECT seq FROM events WHERE ts >= ? AND ts < ? ORDER BY seq",
    ["2026-08-04T10:00:00Z", "2026-08-04T12:00:00Z"],
  ) as { seq: number }[];
  assert.deepEqual(byWindow.map((row) => row.seq), [4, 5, 6]);

  // The SPEC.md §9.2 query shape: pending manual approvals, oldest first.
  const pending = query(
    indexPath,
    "SELECT action_key FROM events WHERE event = 'approval.requested' ORDER BY ts ASC",
  ) as { action_key: string }[];
  assert.deepEqual(pending, [{ action_key: KEY }]);
});

test("payload round-trips as canonical JSON text; absent payload is NULL", () => {
  const { logPath, indexPath, records } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);

  const rows = query(indexPath, "SELECT seq, payload FROM events ORDER BY seq") as {
    seq: number;
    payload: string | null;
  }[];

  for (const [index, record] of records.entries()) {
    const row = rows[index] as { seq: number; payload: string | null };
    assert.equal(row.seq, record.seq);
    if (record.payload === undefined) {
      assert.equal(row.payload, null, `seq ${record.seq} should have a NULL payload`);
    } else {
      assert.deepEqual(JSON.parse(row.payload as string), record.payload);
    }
  }

  // Canonical text: object keys sorted, so the stored bytes are deterministic.
  const first = rows[0] as { payload: string };
  assert.equal(first.payload, '{"tags":["ap","vendor"],"title":"Chase the overdue invoice"}');

  // And SQLite can read it as JSON, which is the point of storing text.
  const titles = query(
    indexPath,
    "SELECT json_extract(payload, '$.title') AS title FROM events WHERE seq = 1",
  ) as { title: string }[];
  assert.deepEqual(titles, [{ title: "Chase the overdue invoice" }]);
});

test("nullable columns are NULL, not empty strings, when the record omits them", () => {
  const { logPath, indexPath } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);

  const row = query(
    indexPath,
    "SELECT task, action_key, channel, prev FROM events WHERE seq = 1",
  )[0] as Record<string, unknown>;
  assert.equal(row["action_key"], null);
  assert.equal(row["prev"], null, "genesis prev is null");
  assert.equal(row["channel"], "cli");

  const noChannel = query(indexPath, "SELECT channel FROM events WHERE seq = 2")[0] as Record<
    string,
    unknown
  >;
  assert.equal(noChannel["channel"], null);
});

// ---------------------------------------------------------- 2. determinism --

test("the same log rebuilt into two paths yields identical rows and meta", () => {
  const { logPath, indexPath, records } = buildLog();
  const second = `${indexPath}.b`;

  const a = reindex(logPath, indexPath);
  const b = reindex(logPath, second);
  assert.ok(a.ok);
  assert.ok(b.ok);
  assert.deepEqual(a, b);

  assert.deepEqual(allEvents(indexPath), allEvents(second));
  assert.deepEqual(metaRow(indexPath), metaRow(second));

  // Identical schema, too — the table and index DDL must not vary.
  const ddl = (path: string): unknown[] =>
    query(path, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name");
  assert.deepEqual(ddl(indexPath), ddl(second));

  assert.equal((allEvents(indexPath) as EventRecord[]).length, records.length);
});

test("rebuilding over an existing index replaces it with identical content", () => {
  const { logPath, indexPath } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);
  const before = allEvents(indexPath);
  const beforeMeta = metaRow(indexPath);

  assert.ok(reindex(logPath, indexPath).ok);
  assert.deepEqual(allEvents(indexPath), before);
  assert.deepEqual(metaRow(indexPath), beforeMeta);
});

test("delete the index and rebuild: nothing is lost", () => {
  const { logPath, indexPath } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);

  const before = allEvents(indexPath);
  const beforeMeta = metaRow(indexPath);
  const beforeQueries = [
    query(indexPath, "SELECT * FROM events WHERE task = 'task-042' ORDER BY seq"),
    query(indexPath, "SELECT * FROM events WHERE event = 'approval.granted'"),
    query(indexPath, "SELECT * FROM events WHERE actor = 'agent:chaser' ORDER BY seq"),
    query(indexPath, "SELECT * FROM events WHERE ts >= '2026-08-04T10:00:00Z' ORDER BY ts"),
  ];

  rmSync(indexPath);
  assert.equal(existsSync(indexPath), false);
  assert.equal(indexHead(indexPath), null, "a deleted index reports no provenance");

  const rebuilt = reindex(logPath, indexPath);
  assert.ok(rebuilt.ok);
  assert.deepEqual(allEvents(indexPath), before);
  assert.deepEqual(metaRow(indexPath), beforeMeta);
  assert.deepEqual(
    [
      query(indexPath, "SELECT * FROM events WHERE task = 'task-042' ORDER BY seq"),
      query(indexPath, "SELECT * FROM events WHERE event = 'approval.granted'"),
      query(indexPath, "SELECT * FROM events WHERE actor = 'agent:chaser' ORDER BY seq"),
      query(indexPath, "SELECT * FROM events WHERE ts >= '2026-08-04T10:00:00Z' ORDER BY ts"),
    ],
    beforeQueries,
  );
});

// ------------------------------------------------------------- 3. refusals --

test("a corrupt log is refused, with the verification result attached", () => {
  const { logPath, indexPath } = buildLog();
  const tampered = corruptCopyOf(logPath);
  const target = `${indexPath}.corrupt`;

  const result = reindex(tampered, target);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not-clean");
  assert.ok(result.error.message.length > 0);
  assert.ok(result.error.verify !== undefined);
  assert.equal(result.error.verify.status, "corrupt");

  assert.equal(existsSync(target), false, "a refused reindex creates no index file");
});

test("a refused reindex leaves an existing index exactly as it was", () => {
  const { logPath, indexPath } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);
  const before = allEvents(indexPath);
  const beforeBytes = readFileSync(indexPath);

  const tampered = corruptCopyOf(logPath);
  const result = reindex(tampered, indexPath);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not-clean");

  assert.deepEqual(readFileSync(indexPath), beforeBytes);
  assert.deepEqual(allEvents(indexPath), before);
});

test("a torn tail is refused without force, and the message points at force", () => {
  const { logPath, indexPath } = buildLog();
  const torn = tornCopyOf(logPath);
  const target = `${indexPath}.torn`;

  const result = reindex(torn, target);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "torn-tail");
  assert.match(result.error.message, /force/);
  assert.ok(result.error.verify !== undefined);
  assert.equal(result.error.verify.status, "torn-tail");
  assert.equal(existsSync(target), false);
});

test("force indexes the intact prefix of a torn log and records the truncation", () => {
  const { logPath, indexPath, records } = buildLog();
  const torn = tornCopyOf(logPath);
  const target = `${indexPath}.forced`;

  const verified = verify(torn);
  assert.ok(verified.status === "torn-tail");
  const intact = verified.intactThroughSeq;
  assert.equal(intact, CHAIN.length - 1);

  const result = reindex(torn, target, { force: true });
  assert.ok(result.ok, `forced reindex failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  assert.equal(result.records, intact);
  assert.equal(result.truncated, true);

  const expectedHead = records[intact - 1] as EventRecord;
  assert.deepEqual(result.head, { seq: expectedHead.seq, hash: expectedHead.hash });

  const rows = allEvents(target) as EventRecord[];
  assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4, 5, 6]);

  const meta = metaRow(target);
  assert.equal(meta["truncated"], 1);
  assert.equal(meta["intact_through_seq"], intact);
  assert.equal(meta["built_from_seq"], expectedHead.seq);
  assert.equal(meta["built_from_hash"], expectedHead.hash);

  assert.deepEqual(indexHead(target), {
    head: { seq: expectedHead.seq, hash: expectedHead.hash },
    truncated: true,
  });
});

test("force does not rescue a corrupt log", () => {
  const { logPath, indexPath } = buildLog();
  const tampered = corruptCopyOf(logPath);
  const target = `${indexPath}.forced-corrupt`;

  const result = reindex(tampered, target, { force: true });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not-clean");
  assert.equal(existsSync(target), false);
});

// ---------------------------------------------------- 4. the log is truth --

test("reindex never writes to the log: bytes and mtime unchanged (clean path)", () => {
  const { logPath, indexPath } = buildLog();
  const before = logFingerprint(logPath);

  assert.ok(reindex(logPath, indexPath).ok);
  assert.ok(reindex(logPath, indexPath).ok);

  assert.deepEqual(logFingerprint(logPath), before);
  assert.equal(existsSync(`${logPath}.lock`), false, "reindex takes no write lock");
});

test("reindex never writes to the log: bytes and mtime unchanged (refusal paths)", () => {
  const { logPath, indexPath } = buildLog();
  const tampered = corruptCopyOf(logPath);
  const torn = tornCopyOf(logPath);

  const beforeTampered = logFingerprint(tampered);
  const beforeTorn = logFingerprint(torn);

  assert.ok(!reindex(tampered, `${indexPath}.a`).ok);
  assert.ok(!reindex(torn, `${indexPath}.b`).ok);
  // Even the forced path, which reads a damaged log, must not repair it.
  assert.ok(reindex(torn, `${indexPath}.c`, { force: true }).ok);

  assert.deepEqual(logFingerprint(tampered), beforeTampered);
  assert.deepEqual(logFingerprint(torn), beforeTorn);
});

// ------------------------------------------------------------ 5. emptiness --

test("an empty log yields a valid, empty index with a null head", () => {
  const dir = caseDir();
  const logPath = join(dir, "log", "events.jsonl");
  const indexPath = join(dir, "index.sqlite");

  const result = reindex(logPath, indexPath);
  assert.ok(result.ok, `reindex failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  assert.equal(result.records, 0);
  assert.equal(result.head, null);
  assert.equal(result.truncated, false);

  assert.deepEqual(allEvents(indexPath), []);
  const meta = metaRow(indexPath);
  assert.equal(meta["built_from_seq"], null);
  assert.equal(meta["built_from_hash"], null);
  assert.equal(meta["truncated"], 0);

  assert.deepEqual(indexHead(indexPath), { head: null, truncated: false });
});

// ------------------------------------------------------------ 6. staleness --

test("appending to the log makes the index detectably stale", () => {
  const { logPath, indexPath } = buildLog(3);
  assert.ok(reindex(logPath, indexPath).ok);

  const atBuild = indexHead(indexPath);
  assert.ok(atBuild !== null);
  assert.deepEqual(atBuild, {
    head: (() => {
      const fresh = verify(logPath);
      assert.ok(fresh.status === "clean");
      return fresh.head;
    })(),
    truncated: false,
  });

  appendOrThrow(logPath, CHAIN[3] as EventInput);

  const fresh = verify(logPath);
  assert.ok(fresh.status === "clean");
  assert.notDeepEqual(atBuild.head, fresh.head, "the index head must now differ");
  assert.equal(indexHead(indexPath)?.head?.seq, 3);
  assert.equal(fresh.head?.seq, 4);

  // Rebuilding closes the gap.
  assert.ok(reindex(logPath, indexPath).ok);
  assert.deepEqual(indexHead(indexPath), { head: fresh.head, truncated: false });
});

test("indexHead returns null for a missing or unreadable index", () => {
  const { logPath, indexPath } = buildLog(1);
  assert.equal(indexHead(indexPath), null, "nothing built yet");

  // A file that is not a SQLite database at all: unreadable, not trustworthy.
  const garbage = `${indexPath}.garbage`;
  copyFileSync(logPath, garbage);
  assert.equal(indexHead(garbage), null);
});

// ------------------------------------------------------------ 7. atomicity --

test("a successful rebuild leaves no temp file behind", () => {
  const { logPath, indexPath } = buildLog();
  assert.ok(reindex(logPath, indexPath).ok);
  assert.ok(reindex(logPath, indexPath).ok);

  const leftovers = readdirSync(dirname(indexPath)).filter(
    (name) => name.includes("reindex") || name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, [], `unexpected leftovers: ${leftovers.join(", ")}`);
  assert.deepEqual(readdirSync(dirname(indexPath)).sort(), ["index.sqlite", "log"]);
});
