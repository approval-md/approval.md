/**
 * The SQLite index projection (SPEC.md §9.2, `.approval/index.sqlite`).
 *
 * **The database is a cache; the log is the truth.** Everything in this module
 * follows from that one sentence:
 *
 * - The index is *derived*. It is rebuilt from scratch on every call — there is
 *   no incremental path, no upsert, no "catch up from seq N". A projection that
 *   can drift is a second source of truth, and this project only has one.
 * - Deleting `index.sqlite` loses nothing. Every byte in it is recomputable
 *   from `events.jsonl`; the file is a query surface, never a record.
 * - Nothing here writes to the log. {@link reindex} opens `logPath` for reading
 *   only: it never appends, never truncates, never repairs a torn tail.
 * - It refuses to index what it cannot vouch for. Chain verification (APRV-7)
 *   runs *first*, always. A corrupt log is refused outright; a torn tail is
 *   refused unless the caller explicitly opts in, and even then only the intact
 *   prefix is indexed and the truncation is recorded in the index metadata. An
 *   index that silently contains tampered rows is worse than no index at all.
 *
 * **Determinism.** The same log always produces the same index *content*: rows
 * are inserted in `seq` order inside a single transaction, `payload` is stored
 * as its RFC 8785 canonicalization (so key order cannot vary), and no clock,
 * hostname, or random value is ever written. SQLite's internal file bytes are
 * explicitly *not* claimed to be reproducible — page layout and freelist state
 * are the engine's business. Equality is asserted at the SQL level: identical
 * logs yield identical query results.
 *
 * **Crash safety.** The index is built at a temporary path in the *same*
 * directory and `rename(2)`d over `indexPath` once complete. A reindex killed
 * halfway therefore never leaves a half-built index where a reader expects a
 * whole one: the previous index survives untouched, and the temp file is
 * cleaned up.
 *
 * **Staleness** is the caller's call to make, not this module's. The index
 * records the log head `(seq, hash)` it was built from; {@link indexHead} reads
 * it back so a caller can compare it against a fresh {@link verify} head and
 * decide whether to rebuild.
 *
 * Dependency note: `better-sqlite3`, exact-pinned. `node:sqlite` was ruled out —
 * `engines.node` is `>=20` and `node:sqlite` does not exist before Node 22.5.
 */

import Database from "better-sqlite3";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalize } from "./jcs.js";
import type { EventRecord } from "./log.js";
import type { ValidateOptions } from "./validate.js";
import { verify, type LogHead, type VerifyResult } from "./verify.js";

/**
 * Version of the index's own table layout. Bumped whenever the SQL schema
 * below changes shape, so a reader can tell an index it understands from one it
 * does not. It is not the log's version: the log is versioned by SPEC.md.
 */
export const INDEX_SCHEMA_VERSION = 1;

/** Why a reindex was refused. Every failure is one of these, never a throw. */
export type ReindexErrorCode = "not-clean" | "torn-tail" | "io";

export interface ReindexError {
  code: ReindexErrorCode;
  message: string;
  /** The verification result behind the refusal, when there is one. */
  verify?: VerifyResult;
}

export type ReindexResult =
  | {
      ok: true;
      /** Rows written to `events`. */
      records: number;
      /** The log head the index was built from; `null` for an empty log. */
      head: LogHead | null;
      /** True when only an intact prefix was indexed (forced torn tail). */
      truncated: boolean;
    }
  | { ok: false; error: ReindexError };

/** Options for {@link reindex}. */
export interface ReindexOptions extends ValidateOptions {
  /**
   * Index the intact prefix of a torn-tail log (records `1..intactThroughSeq`)
   * instead of refusing. The truncation is recorded in `meta`. This never
   * repairs the log — the torn line stays exactly where it is.
   */
  force?: boolean;
}

/**
 * The index's table layout, applied to a freshly created database.
 *
 * Column set mirrors the log record one-to-one (SPEC.md §8) so a row is a
 * faithful projection of a line rather than an interpretation of one. `payload`
 * is canonical JSON *text*: SQLite has no object type, and storing the RFC 8785
 * form keeps the stored bytes deterministic and re-hashable.
 *
 * The four secondary indexes serve the query shapes SPEC.md §9.2 names —
 * by task, by event type, by actor, by time window.
 *
 * `meta` is a singleton by construction (`CHECK (id = 1)`): an index that could
 * hold two provenance rows could disagree with itself about where it came from.
 * Deliberately *not* a STRICT table — DuckDB and older SQLite clients must be
 * able to open this file, and SPEC.md §9.2 promises exactly that.
 */
const SCHEMA_SQL = `
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY,
  ts         TEXT    NOT NULL,
  event      TEXT    NOT NULL,
  actor      TEXT    NOT NULL,
  task       TEXT,
  action_key TEXT,
  channel    TEXT,
  alg        TEXT    NOT NULL,
  prev       TEXT,
  hash       TEXT    NOT NULL,
  payload    TEXT
);
CREATE INDEX events_task_idx  ON events (task);
CREATE INDEX events_event_idx ON events (event);
CREATE INDEX events_actor_idx ON events (actor);
CREATE INDEX events_ts_idx    ON events (ts);
CREATE TABLE meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version     INTEGER NOT NULL,
  built_from_seq     INTEGER,
  built_from_hash    TEXT,
  truncated          INTEGER NOT NULL,
  intact_through_seq INTEGER
);
`;

const INSERT_EVENT_SQL = `
INSERT INTO events (seq, ts, event, actor, task, action_key, channel, alg, prev, hash, payload)
VALUES (@seq, @ts, @event, @actor, @task, @action_key, @channel, @alg, @prev, @hash, @payload)
`;

const INSERT_META_SQL = `
INSERT INTO meta (id, schema_version, built_from_seq, built_from_hash, truncated, intact_through_seq)
VALUES (1, @schema_version, @built_from_seq, @built_from_hash, @truncated, @intact_through_seq)
`;

/** Row shape of the `meta` singleton, as SQLite returns it. */
interface MetaRow {
  id: number;
  schema_version: number;
  built_from_seq: number | null;
  built_from_hash: string | null;
  truncated: number;
  intact_through_seq: number | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fail(code: ReindexErrorCode, message: string, result?: VerifyResult): ReindexResult {
  return {
    ok: false,
    error: result === undefined ? { code, message } : { code, message, verify: result },
  };
}

/**
 * Read the first `count` complete records of the log.
 *
 * Called only after {@link verify} has passed over the same file, so every line
 * taken here is known to be a schema-valid, correctly chained record. Anything
 * that still goes wrong is a concurrent write or a filesystem problem, and is
 * reported as `io` rather than assumed away.
 */
function readRecords(
  logPath: string,
  count: number,
): { ok: true; records: EventRecord[] } | { ok: false; error: ReindexError } {
  if (count === 0) return { ok: true, records: [] };

  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (cause) {
    return {
      ok: false,
      error: { code: "io", message: `log ${logPath} could not be read: ${errorMessage(cause)}` },
    };
  }

  const lines = raw.split("\n");
  const records: EventRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      return {
        ok: false,
        error: {
          code: "io",
          message: `log ${logPath} lost line ${index + 1} between verification and read; refusing to index a moving target`,
        },
      };
    }
    try {
      records.push(JSON.parse(line) as EventRecord);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "io",
          message: `log ${logPath} line ${index + 1} changed between verification and read (${errorMessage(cause)}); refusing to index`,
        },
      };
    }
  }
  return { ok: true, records };
}

/** Bound values for one `events` row. `undefined` is not a SQLite value. */
interface EventRow {
  seq: number;
  ts: string;
  event: string;
  actor: string;
  task: string | null;
  action_key: string | null;
  channel: string | null;
  alg: string;
  prev: string | null;
  hash: string;
  payload: string | null;
}

function toRow(record: EventRecord): EventRow {
  return {
    seq: record.seq,
    ts: record.ts,
    event: record.event,
    actor: record.actor,
    task: record.task ?? null,
    action_key: record.action_key ?? null,
    channel: record.channel ?? null,
    alg: record.alg,
    prev: record.prev,
    hash: record.hash,
    // Canonical text, not JSON.stringify: the stored bytes must not depend on
    // the key order the parser happened to hand us.
    payload: record.payload === undefined ? null : canonicalize(record.payload),
  };
}

/** Distinct temp name per call, in the index's own directory so rename is atomic. */
let tempCounter = 0;
function tempPathFor(indexPath: string): string {
  tempCounter += 1;
  return join(dirname(indexPath), `.reindex-${process.pid}-${tempCounter}.sqlite.tmp`);
}

function discard(path: string): void {
  // SQLite may leave a sidecar journal beside a half-built database.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

/**
 * Rebuild the SQLite index at `indexPath` from the log at `logPath`.
 *
 * Always verifies the chain first. Returns a structured result rather than
 * throwing; on any refusal the existing index (if any) is left exactly as it
 * was and no new file is created.
 */
export function reindex(
  logPath: string,
  indexPath: string,
  options: ReindexOptions = {},
): ReindexResult {
  const verifyOptions: ValidateOptions =
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir };

  // 1. The log is the truth, so ask it first. Nothing below runs on a log we
  //    cannot vouch for.
  const verified = verify(logPath, verifyOptions);

  let count: number;
  let head: LogHead | null;
  let truncated: boolean;
  let intactThroughSeq: number | null;

  if (verified.status === "corrupt") {
    return fail(
      "not-clean",
      `log ${logPath} failed chain verification (${verified.reason}); refusing to index tampered data: ${verified.message}`,
      verified,
    );
  }

  if (verified.status === "torn-tail") {
    if (options.force !== true) {
      return fail(
        "torn-tail",
        `log ${logPath} ends with a torn line; refusing to index a partial log. Pass force: true to index the intact prefix (records 1..${verified.intactThroughSeq}) only — the log itself is never repaired.`,
        verified,
      );
    }
    count = verified.records;
    intactThroughSeq = verified.intactThroughSeq;
    truncated = true;
    head = null; // filled from the last indexed record below
  } else {
    count = verified.records;
    intactThroughSeq = null;
    truncated = false;
    head = verified.head;
  }

  const read = readRecords(logPath, count);
  if (!read.ok) return { ok: false, error: read.error };
  const records = read.records;

  if (truncated) {
    const last = records[records.length - 1];
    head = last === undefined ? null : { seq: last.seq, hash: last.hash };
  }

  let rows: EventRow[];
  try {
    rows = records.map(toRow);
  } catch (cause) {
    return fail("io", `log ${logPath} holds a record that cannot be canonicalized: ${errorMessage(cause)}`);
  }

  try {
    mkdirSync(dirname(indexPath), { recursive: true });
  } catch (cause) {
    return fail("io", `index directory for ${indexPath} could not be created: ${errorMessage(cause)}`);
  }

  // 2. Build beside the target, then swap. A crash mid-build leaves the old
  //    index in place rather than a truncated one.
  const tempPath = tempPathFor(indexPath);
  discard(tempPath);

  let db: Database.Database;
  try {
    db = new Database(tempPath);
  } catch (cause) {
    discard(tempPath);
    return fail("io", `index ${tempPath} could not be created: ${errorMessage(cause)}`);
  }

  try {
    db.exec(SCHEMA_SQL);
    const insertEvent = db.prepare(INSERT_EVENT_SQL);
    const insertMeta = db.prepare(INSERT_META_SQL);
    // One transaction for the whole projection: an index is complete or absent.
    const build = db.transaction((batch: EventRow[]) => {
      for (const row of batch) insertEvent.run(row); // seq order, as read
      insertMeta.run({
        schema_version: INDEX_SCHEMA_VERSION,
        built_from_seq: head === null ? null : head.seq,
        built_from_hash: head === null ? null : head.hash,
        truncated: truncated ? 1 : 0,
        intact_through_seq: intactThroughSeq,
      });
    });
    build(rows);
    db.close();
  } catch (cause) {
    try {
      db.close();
    } catch {
      // Nothing actionable; the temp file is being discarded regardless.
    }
    discard(tempPath);
    return fail("io", `index ${indexPath} could not be built: ${errorMessage(cause)}`);
  }

  try {
    renameSync(tempPath, indexPath);
  } catch (cause) {
    discard(tempPath);
    return fail("io", `index ${indexPath} could not be replaced: ${errorMessage(cause)}`);
  }
  // The rename consumed the temp database; drop any sidecar left beside it.
  discard(tempPath);

  return { ok: true, records: rows.length, head, truncated };
}

/**
 * The provenance recorded in an existing index: the log head it was built from,
 * and whether it covers only an intact prefix.
 *
 * Returns `null` when the file is missing, unreadable, or carries no `meta`
 * row — all of which mean the same thing to a caller: there is no index to
 * trust, rebuild. Compare `head` against a fresh `verify(logPath).head` to
 * detect staleness. Deleting `indexPath` loses nothing.
 */
export function indexHead(
  indexPath: string,
): { head: LogHead | null; truncated: boolean } | null {
  let db: Database.Database;
  try {
    db = new Database(indexPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db.prepare("SELECT * FROM meta WHERE id = 1").get() as MetaRow | undefined;
    if (row === undefined) return null;
    const head =
      row.built_from_seq === null || row.built_from_hash === null
        ? null
        : { seq: row.built_from_seq, hash: row.built_from_hash };
    return { head, truncated: row.truncated !== 0 };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Read-only handle; a failed close has nothing to lose.
    }
  }
}
