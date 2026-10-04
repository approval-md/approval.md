/**
 * Append durability (APRV-440): the append fsyncs after the write and before it
 * reports ok, and a newly created log's directory entry is fsynced too.
 *
 * Why an injected layer. A page cache that was flushed and one that was not read
 * back identically until the machine dies, so no assertion over the file's bytes
 * can see the difference. What can be observed is the ORDER of the calls the
 * append makes, and whether `ok` depends on the fsync. The layer here records
 * every call and then delegates to the real `fs` call, so each log in this file
 * is a real log built through the real append path (repo invariant: nothing here
 * hand-writes a record). Where a case makes a call fail, the failure is the
 * layer refusing BEFORE delegating, exactly as a failing disk would.
 *
 * The incident: a hosted tenant's attestation was acknowledged (seq 17), the
 * platform killed the machine about 30 s later, and the file came back ending in
 * 456 NUL bytes where the record had been (hosted doc 02 §4.6 and §8).
 */

import assert from "node:assert/strict";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";

import { appendEvent, onLogAppended, type EventInput } from "../src/core/log.js";
import {
  setAppendWriteLayerForTests,
  type AppendWriteLayer,
} from "../src/core/log-write-layer.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-log-fsync-"));
let counter = 0;

after(() => {
  setAppendWriteLayerForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  setAppendWriteLayerForTests(null);
});

/** A case directory that exists, and a log path one level below it that does not. */
function caseDirs(): { root: string; logPath: string } {
  counter += 1;
  const root = join(scratch, `case-${String(counter)}`);
  mkdirSync(root, { recursive: true });
  return { root, logPath: join(root, "log", "events.jsonl") };
}

function input(n: number): EventInput {
  return {
    ts: `2026-09-25T10:00:${String(n).padStart(2, "0")}Z`,
    event: "task.registered",
    actor: "agent:planner",
    task: `task-${String(n)}`,
    channel: "cli",
    payload: { title: `durable ${String(n)}` },
  };
}

type Call =
  | { op: "open"; path: string; excl: boolean; dir: boolean; fd: number }
  | { op: "open-refused"; path: string; excl: boolean; code: string }
  | { op: "write"; fd: number; path: string; bytes: number }
  | { op: "fsync"; fd: number; path: string; bytesOnDiskAtSync: number | null }
  | { op: "close"; fd: number; path: string };

interface Recorder {
  calls: Call[];
  /**
   * Path each OPEN fd names. Descriptors are reused once closed, so every call
   * records the path it acted on at the time it acted.
   */
  pathOf: Map<number, string>;
}

/**
 * A layer that records and delegates. `fail` lets a case refuse one operation
 * the way a disk would; the refusal is thrown before the real call, so the real
 * file reflects exactly what a failing disk would leave.
 */
function recordingLayer(
  recorder: Recorder,
  fail: {
    fsyncFile?: boolean;
    fsyncDir?: boolean | string;
    shortWrite?: boolean;
  } = {},
): AppendWriteLayer {
  return {
    open(path, flags, mode) {
      const excl = (flags & fsConstants.O_EXCL) !== 0;
      const dir = (flags & fsConstants.O_WRONLY) === 0;
      let fd: number;
      try {
        fd = openSync(path, flags, mode);
      } catch (cause) {
        recorder.calls.push({
          op: "open-refused",
          path,
          excl,
          code: (cause as NodeJS.ErrnoException).code ?? "?",
        });
        throw cause;
      }
      recorder.pathOf.set(fd, path);
      recorder.calls.push({ op: "open", path, excl, dir, fd });
      return fd;
    },
    write(fd, data) {
      if (fail.shortWrite === true) {
        // A disk that took half the line: real bytes, really written, and the
        // count says so.
        const half = Math.floor(data.length / 2);
        const wrote = writeSync(fd, data, 0, half);
        recorder.calls.push({ op: "write", fd, path: recorder.pathOf.get(fd) ?? "", bytes: wrote });
        return wrote;
      }
      const wrote = writeSync(fd, data, 0, data.length);
      recorder.calls.push({ op: "write", fd, path: recorder.pathOf.get(fd) ?? "", bytes: wrote });
      return wrote;
    },
    fsync(fd) {
      const path = recorder.pathOf.get(fd) ?? "";
      const isLog = path.endsWith(".jsonl");
      const bytesOnDiskAtSync = isLog ? readFileSync(path).length : null;
      recorder.calls.push({ op: "fsync", fd, path, bytesOnDiskAtSync });
      if (isLog && fail.fsyncFile === true) {
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      }
      if (!isLog && fail.fsyncDir !== undefined && fail.fsyncDir !== false) {
        const code = fail.fsyncDir === true ? "EIO" : fail.fsyncDir;
        throw Object.assign(new Error(`${code}: fsync`), { code });
      }
      fsyncSync(fd);
    },
    close(fd) {
      recorder.calls.push({ op: "close", fd, path: recorder.pathOf.get(fd) ?? "" });
      recorder.pathOf.delete(fd);
      closeSync(fd);
    },
    rename(from, to) {
      // The log append never renames (APRV-457 added this for the payload
      // store); delegate without recording so the traces above stay exact.
      renameSync(from, to);
    },
  };
}

function newRecorder(): Recorder {
  return { calls: [], pathOf: new Map() };
}

/** The trace as `op:path-ish` words, which is what the ordering claims are about. */
function words(recorder: Recorder, logPath: string): string[] {
  return recorder.calls.map((call) => {
    if (call.op === "open-refused") {
      return `open-refused(${call.excl ? "excl" : "plain"},${call.code})`;
    }
    if (call.op === "open") {
      const what = call.path === logPath ? "log" : `dir:${call.path}`;
      return `open(${what}${call.excl ? ",excl" : ""})`;
    }
    const what = call.path === logPath ? "log" : `dir:${call.path}`;
    return `${call.op}(${what})`;
  });
}

// ---------------------------------------------------------------------------
// AC #1: fsync after the write, before ok; the directory on first creation
// ---------------------------------------------------------------------------

test("a first append writes, fsyncs the file, then fsyncs every directory entry it created, before ok", () => {
  const { root, logPath } = caseDirs();
  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder));

  const result = appendEvent(logPath, input(1));
  // Captured at the moment the append returned: nothing the layer records after
  // this line can have been part of the append.
  const traceAtReturn = words(recorder, logPath);
  setAppendWriteLayerForTests(null);

  assert.ok(result.ok, JSON.stringify(result));
  const logDir = dirname(logPath);
  // `log/` did not exist, so the append created it: its own entry lives in
  // `root`, and the file's entry lives in `log/`. Both are synced, innermost
  // first, and both after the file itself.
  assert.deepEqual(traceAtReturn, [
    "open(log,excl)",
    "write(log)",
    "fsync(log)",
    "close(log)",
    `open(dir:${logDir})`,
    `fsync(dir:${logDir})`,
    `close(dir:${logDir})`,
    `open(dir:${root})`,
    `fsync(dir:${root})`,
    `close(dir:${root})`,
  ]);

  // The fsync was of the bytes the write had just put there: the whole line.
  const sync = recorder.calls.find((call) => call.op === "fsync");
  assert.ok(sync !== undefined && sync.op === "fsync");
  assert.equal(sync.bytesOnDiskAtSync, Buffer.byteLength(`${result.line}\n`, "utf8"));
  assert.equal(verify(logPath).status, "clean");
});

test("an append to an existing file fsyncs the file and touches no directory", () => {
  const { logPath } = caseDirs();
  assert.ok(appendEvent(logPath, input(1)).ok);

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder));
  const result = appendEvent(logPath, input(2));
  const traceAtReturn = words(recorder, logPath);
  setAppendWriteLayerForTests(null);

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(traceAtReturn, [
    "open-refused(excl,EEXIST)",
    "open(log)",
    "write(log)",
    "fsync(log)",
    "close(log)",
  ]);
  const verdict = verify(logPath);
  assert.ok(verdict.status === "clean");
  assert.equal(verdict.records, 2);
});

test("a log created in an existing directory syncs that directory only", () => {
  const { logPath } = caseDirs();
  mkdirSync(dirname(logPath), { recursive: true });

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder));
  const result = appendEvent(logPath, input(1));
  const traceAtReturn = words(recorder, logPath);
  setAppendWriteLayerForTests(null);

  assert.ok(result.ok, JSON.stringify(result));
  const logDir = dirname(logPath);
  assert.deepEqual(traceAtReturn, [
    "open(log,excl)",
    "write(log)",
    "fsync(log)",
    "close(log)",
    `open(dir:${logDir})`,
    `fsync(dir:${logDir})`,
    `close(dir:${logDir})`,
  ]);
});

test("ok depends on the fsync: a failed fsync is an io failure that says the record may not survive", () => {
  const { logPath } = caseDirs();
  assert.ok(appendEvent(logPath, input(1)).ok);

  const notified: string[] = [];
  onLogAppended((path) => {
    if (path === logPath) notified.push(path);
  });

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder, { fsyncFile: true }));
  const result = appendEvent(logPath, input(2));
  setAppendWriteLayerForTests(null);

  assert.ok(!result.ok);
  assert.equal(result.error.code, "io");
  assert.match(result.error.message, /seq 2 was written but fsync failed/u);
  assert.match(result.error.message, /not known to be durable/u);
  // The descriptor was still closed, and the cache was still told the bytes
  // changed: a reader must not serve a proof anchored before this write.
  assert.deepEqual(words(recorder, logPath).slice(-3), ["write(log)", "fsync(log)", "close(log)"]);
  assert.deepEqual(notified, [logPath]);
});

test("a failed directory fsync after a first append is an io failure naming the directory", () => {
  const { logPath } = caseDirs();
  mkdirSync(dirname(logPath), { recursive: true });

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder, { fsyncDir: true }));
  const result = appendEvent(logPath, input(1));
  setAppendWriteLayerForTests(null);

  assert.ok(!result.ok);
  assert.equal(result.error.code, "io");
  assert.ok(result.error.message.includes(`its directory ${dirname(logPath)} could not be`));
  // The directory handle is closed even though its fsync threw.
  assert.equal(words(recorder, logPath).at(-1), `close(dir:${dirname(logPath)})`);
});

test("a filesystem that cannot fsync a directory (EINVAL) does not fail the first append", () => {
  const { logPath } = caseDirs();
  mkdirSync(dirname(logPath), { recursive: true });

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder, { fsyncDir: "EINVAL" }));
  const result = appendEvent(logPath, input(1));
  setAppendWriteLayerForTests(null);

  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(words(recorder, logPath).includes(`fsync(dir:${dirname(logPath)})`));
});

test("production's layer really calls fs.fsyncSync on the log, after the write", () => {
  // The cases above prove the ORDER through an injected layer; this one proves
  // the layer production runs is not a no-op. Node keeps the named exports of a
  // builtin in step with its default export via syncBuiltinESMExports, so the
  // spy reaches the binding core/log-write-layer.ts imported.
  const { logPath } = caseDirs();
  setAppendWriteLayerForTests(null);
  const original = fs.fsyncSync;
  const synced: number[] = [];
  fs.fsyncSync = (fd: number): void => {
    synced.push(fs.fstatSync(fd).size);
    original(fd);
  };
  syncBuiltinESMExports();
  let result: ReturnType<typeof appendEvent>;
  try {
    result = appendEvent(logPath, input(1));
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(result.ok, JSON.stringify(result));
  // The file first (its full line already written), then its directories.
  assert.ok(synced.length >= 2, `fsyncSync ran ${String(synced.length)} time(s)`);
  assert.equal(synced[0], Buffer.byteLength(`${result.line}\n`, "utf8"));
});

test("a short write is reported, never acknowledged, and is not fsynced as if whole", () => {
  const { logPath } = caseDirs();
  assert.ok(appendEvent(logPath, input(1)).ok);

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder, { shortWrite: true }));
  const result = appendEvent(logPath, input(2));
  setAppendWriteLayerForTests(null);

  assert.ok(!result.ok);
  assert.equal(result.error.code, "io");
  assert.match(result.error.message, /the write was short/u);
  assert.ok(!words(recorder, logPath).includes("fsync(log)"));
  // What a short write leaves is a torn tail, and the verifier calls it one.
  assert.equal(verify(logPath).status, "torn-tail");
});

test("a refused compare-and-append makes no write and no fsync", () => {
  const { logPath } = caseDirs();
  const first = appendEvent(logPath, input(1));
  assert.ok(first.ok);
  assert.ok(appendEvent(logPath, input(2)).ok);

  const recorder = newRecorder();
  setAppendWriteLayerForTests(recordingLayer(recorder));
  const result = appendEvent(logPath, input(3), {
    expectedHead: { seq: first.record.seq, hash: first.record.hash },
  });
  setAppendWriteLayerForTests(null);

  assert.ok(!result.ok);
  assert.equal(result.error.code, "head-moved");
  assert.deepEqual(recorder.calls, []);
});

test("the default layer is Node's own fs: an append with nothing injected still verifies", () => {
  const { logPath } = caseDirs();
  setAppendWriteLayerForTests(null);
  for (let n = 1; n <= 3; n += 1) assert.ok(appendEvent(logPath, input(n)).ok);
  const verdict = verify(logPath);
  assert.ok(verdict.status === "clean");
  assert.equal(verdict.records, 3);
});
