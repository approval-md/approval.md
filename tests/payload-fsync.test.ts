/**
 * Payload store durability (APRV-457): `writeAtomic` fsyncs the temp file
 * before the rename and the store directory after it, so the bytes a proposal
 * or grant binds are on disk before the record that binds them is appended.
 *
 * The failure this closes. The log append has fsynced since APRV-440, the
 * payload beside it did not: a platform kill between the rename and writeback
 * could keep the record (synced) and lose its payload (not), leaving a verified
 * `payload_hash` that points at a NUL-filled or missing file. Every consumer that
 * binds on payload bytes then sees an unexplained mismatch.
 *
 * Why a crash model. A page cache that was flushed and one that was not read
 * back identically until the machine dies, so this file installs a write layer
 * (the APRV-440 seam, `core/log-write-layer.ts`) that delegates every call to
 * the real `fs` and also keeps a ledger of what a crash would keep: a file's
 * data survives only once its descriptor was fsynced, and a name survives only
 * once its directory was fsynced. {@link CrashDisk.crash} then rewrites the
 * store directory into what the disk would hold after the machine stopped:
 * unsynced data comes back as NUL bytes at the length written (the signature
 * observed on the hosted tenant, hosted doc 02 sections 4.6 and 8), an
 * unsynced name is gone, and a file the layer never saw written is gone too,
 * because nothing proves it reached the disk.
 *
 * The same model is run against the pre-APRV-457 call sequence (open, write,
 * close, rename, no fsync) so the test shows what it is protecting against,
 * and the new sequence's survival is not an artefact of a model that keeps
 * everything. Before the fix the store bypassed the layer entirely, so every
 * survival case below failed against it (recorded in the task notes).
 *
 * Nothing here hand-writes a log line: registrations and requests go through
 * `core/gate.ts`, and the crash is applied to the store directory only. The
 * log's own durability is `tests/log-fsync.test.ts`'s claim.
 */

import assert from "node:assert/strict";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";

import { canonicalize } from "../src/core/jcs.js";
import {
  setAppendWriteLayerForTests,
  type AppendWriteLayer,
} from "../src/core/log-write-layer.js";
import { payloadHash } from "../src/core/payload.js";
import {
  loadPayload,
  payloadPath,
  payloadStoreDirFor,
  storePayload,
} from "../src/core/payload-store.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { register, request } from "./clock-adapters.js";
import { at, attest, newScenario, scratchRoot, T0 } from "./scenario.js";

const scratch = scratchRoot("payload-fsync");
let counter = 0;

after(() => {
  setAppendWriteLayerForTests(null);
  scratch.cleanup();
});

afterEach(() => {
  setAppendWriteLayerForTests(null);
});

const PAYLOAD = {
  to: ["agency@example.co.uk"],
  subject: "Deposit refund chaser",
  body: "Following up on the deposit refund.",
};
const HASH = payloadHash(PAYLOAD);
const BYTES = Buffer.from(canonicalize(PAYLOAD), "utf8");

/** A fresh case directory that exists. */
function caseRoot(): string {
  counter += 1;
  const root = join(scratch.root, `case-${String(counter)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// The crash model
// ---------------------------------------------------------------------------

interface FileNode {
  /** Bytes written through the layer since the file was created. */
  written: number;
  /** Whether the data written so far was fsynced. */
  synced: boolean;
}

interface Failures {
  /** fsync of a FILE descriptor throws this code. */
  fsyncFile?: string;
  /** fsync of a DIRECTORY descriptor throws this code. */
  fsyncDir?: string;
  /** The write takes half the buffer. */
  shortWrite?: boolean;
}

/**
 * A delegating layer that records the call order and keeps a durability ledger
 * for one watched directory (the store). Refusals are thrown BEFORE the real
 * call, exactly as a failing disk would leave things.
 */
class CrashDisk implements AppendWriteLayer {
  readonly trace: string[] = [];
  private readonly files = new Map<number, FileNode>();
  private readonly dirs = new Map<number, string>();
  private readonly fdPath = new Map<number, string>();
  /** Names in a directory whose entry was fsynced, mapped to their file. */
  private readonly durable = new Map<string, FileNode>();
  /** Names created or renamed into place whose directory was not fsynced since. */
  private readonly pending = new Map<string, FileNode>();
  /** Files already in the watched directory when the model was installed. */
  private readonly baseline: Set<string>;

  constructor(
    private readonly watched: string,
    private readonly fail: Failures = {},
  ) {
    this.baseline = new Set(existsSync(watched) ? readdirSync(watched) : []);
  }

  private word(path: string): string {
    if (path === this.watched) return "store-dir";
    if (path.endsWith(".jsonl")) return "log";
    if (dirname(path) === this.watched) {
      return basename(path).startsWith(".") ? "temp" : "payload";
    }
    return `dir:${path}`;
  }

  open(path: string, flags: number, mode: number): number {
    const fd = openSync(path, flags, mode);
    this.fdPath.set(fd, path);
    const writable = (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) !== 0;
    if (writable) {
      const node: FileNode = { written: 0, synced: false };
      this.files.set(fd, node);
      if ((flags & fsConstants.O_CREAT) !== 0) this.pending.set(path, node);
      this.trace.push(`open(${this.word(path)}${(flags & fsConstants.O_EXCL) !== 0 ? ",excl" : ""})`);
    } else {
      this.dirs.set(fd, path);
      this.trace.push(`open(${this.word(path)})`);
    }
    return fd;
  }

  write(fd: number, data: Buffer): number {
    const node = this.files.get(fd);
    const length = this.fail.shortWrite === true ? Math.floor(data.length / 2) : data.length;
    const wrote = writeSync(fd, data, 0, length);
    if (node !== undefined) {
      node.written += wrote;
      node.synced = false;
    }
    this.trace.push(`write(${this.word(this.fdPath.get(fd) ?? "")})`);
    return wrote;
  }

  fsync(fd: number): void {
    const dir = this.dirs.get(fd);
    this.trace.push(`fsync(${this.word(this.fdPath.get(fd) ?? "")})`);
    if (dir !== undefined) {
      if (this.fail.fsyncDir !== undefined) {
        throw Object.assign(new Error(`${this.fail.fsyncDir}: fsync`), { code: this.fail.fsyncDir });
      }
      fsyncSync(fd);
      for (const [name, node] of this.pending) {
        if (dirname(name) !== dir) continue;
        this.pending.delete(name);
        this.durable.set(name, node);
      }
      return;
    }
    if (this.fail.fsyncFile !== undefined) {
      throw Object.assign(new Error(`${this.fail.fsyncFile}: fsync`), { code: this.fail.fsyncFile });
    }
    fsyncSync(fd);
    const node = this.files.get(fd);
    if (node !== undefined) node.synced = true;
  }

  close(fd: number): void {
    this.trace.push(`close(${this.word(this.fdPath.get(fd) ?? "")})`);
    this.files.delete(fd);
    this.dirs.delete(fd);
    this.fdPath.delete(fd);
    closeSync(fd);
  }

  rename(from: string, to: string): void {
    this.trace.push(`rename(${this.word(from)}->${this.word(to)})`);
    renameSync(from, to);
    const node = this.pending.get(from) ?? this.durable.get(from);
    this.pending.delete(from);
    this.durable.delete(from);
    // Until its directory is synced, the new name may not survive.
    this.durable.delete(to);
    if (node !== undefined) this.pending.set(to, node);
  }

  /**
   * Rewrite the watched directory into what the disk holds after the machine
   * stops now. Returns what happened to each name, for the assertions.
   */
  crash(): Map<string, "kept" | "nul-filled" | "lost"> {
    const outcome = new Map<string, "kept" | "nul-filled" | "lost">();
    if (!existsSync(this.watched)) return outcome;
    for (const name of readdirSync(this.watched)) {
      if (this.baseline.has(name)) continue;
      const path = join(this.watched, name);
      const node = this.durable.get(path);
      if (node === undefined) {
        // Never written through the layer, or its name was never synced.
        unlinkSync(path);
        outcome.set(name, "lost");
      } else if (!node.synced) {
        writeFileSync(path, Buffer.alloc(node.written));
        outcome.set(name, "nul-filled");
      } else {
        outcome.set(name, "kept");
      }
    }
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// AC #1: the order, at the moment storePayload returns
// ---------------------------------------------------------------------------

test("a store writes the temp, fsyncs it, closes, renames, then fsyncs the store directory, before ok", () => {
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  const disk = new CrashDisk(storeDir);
  setAppendWriteLayerForTests(disk);

  const stored = storePayload(storeDir, PAYLOAD);
  const traceAtReturn = [...disk.trace];
  setAppendWriteLayerForTests(null);

  assert.ok(stored.ok, JSON.stringify(stored));
  assert.deepEqual(traceAtReturn, [
    "open(temp,excl)",
    "write(temp)",
    "fsync(temp)",
    "close(temp)",
    "rename(temp->payload)",
    "open(store-dir)",
    "fsync(store-dir)",
    "close(store-dir)",
  ]);
  // The bytes and the name are what they always were.
  assert.equal(stored.hash, HASH);
  assert.deepEqual(readFileSync(payloadPath(storeDir, HASH)), BYTES);
  assert.deepEqual(readdirSync(storeDir), [`${HASH}.json`]);
});

test("a first store that creates the store directory also syncs every directory that gained an entry", () => {
  const root = caseRoot();
  const home = join(root, ".approval");
  const storeDir = join(home, "payloads");
  const disk = new CrashDisk(storeDir);
  setAppendWriteLayerForTests(disk);

  const stored = storePayload(storeDir, PAYLOAD);
  const traceAtReturn = [...disk.trace];
  setAppendWriteLayerForTests(null);

  assert.ok(stored.ok, JSON.stringify(stored));
  // `.approval/` and `payloads/` were both created: the file's entry lives in
  // `payloads/`, `payloads/`'s in `.approval/`, `.approval/`'s in the root.
  // Innermost first, all after the rename.
  assert.deepEqual(traceAtReturn.slice(4), [
    "rename(temp->payload)",
    "open(store-dir)",
    "fsync(store-dir)",
    "close(store-dir)",
    `open(dir:${home})`,
    `fsync(dir:${home})`,
    `close(dir:${home})`,
    `open(dir:${root})`,
    `fsync(dir:${root})`,
    `close(dir:${root})`,
  ]);
});

// ---------------------------------------------------------------------------
// AC #1: a crash after ok drops nothing the binding needs
// ---------------------------------------------------------------------------

test("a crash right after the store reports ok keeps the payload, and it loads and verifies", () => {
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  const disk = new CrashDisk(storeDir);
  setAppendWriteLayerForTests(disk);
  const stored = storePayload(storeDir, PAYLOAD);
  setAppendWriteLayerForTests(null);
  assert.ok(stored.ok, JSON.stringify(stored));

  const outcome = disk.crash();

  assert.deepEqual([...outcome], [[`${HASH}.json`, "kept"]]);
  const loaded = loadPayload(storeDir, HASH);
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.deepEqual(loaded.value, PAYLOAD);
});

test("the pre-APRV-457 sequence, replayed through the same layer, loses the payload in the same crash", () => {
  // What writeAtomic did before: open the temp, one write, close, rename. No
  // fsync of the file, no fsync of the directory.
  function legacyWrite(disk: CrashDisk, storeDir: string): void {
    const path = payloadPath(storeDir, HASH);
    const temp = join(storeDir, `.${basename(path)}.tmp-legacy`);
    const fd = disk.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o666);
    disk.write(fd, BYTES);
    disk.close(fd);
    disk.rename(temp, path);
  }

  // Alone: the name was never synced, so the file is gone after the crash.
  const lostDir = join(caseRoot(), "payloads");
  mkdirSync(lostDir);
  const lost = new CrashDisk(lostDir);
  legacyWrite(lost, lostDir);
  assert.deepEqual([...lost.crash()], [[`${HASH}.json`, "lost"]]);
  const absent = loadPayload(lostDir, HASH);
  assert.equal(absent.ok === false && absent.code, "absent");

  // With the directory synced by someone else afterwards (another store into
  // the same directory, say), the NAME survives and the DATA does not: the
  // NUL-filled file the hosted tenant's log showed, now under a payload name.
  const tornDir = join(caseRoot(), "payloads");
  mkdirSync(tornDir);
  const torn = new CrashDisk(tornDir);
  legacyWrite(torn, tornDir);
  const dirFd = torn.open(tornDir, fsConstants.O_RDONLY, 0);
  torn.fsync(dirFd);
  torn.close(dirFd);
  assert.deepEqual([...torn.crash()], [[`${HASH}.json`, "nul-filled"]]);
  assert.deepEqual(readFileSync(payloadPath(tornDir, HASH)), Buffer.alloc(BYTES.length));
  const unreadable = loadPayload(tornDir, HASH);
  assert.equal(unreadable.ok, false);
});

// ---------------------------------------------------------------------------
// End to end: the record verifies after the crash, and so does its payload
// ---------------------------------------------------------------------------

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

test("a request whose approval.requested survives a crash keeps the payload it binds", () => {
  const unit = newScenario(caseRoot(), POLICY);
  attest(unit, T0);
  const task = "task-457";
  const actionKey = `${task}:chaser`;
  const registered = register(
    unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "demo", created_by: "agent:drafter" },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            summary: "Send the deposit chaser",
            reversible: false,
            est_cost_usd: "0.02",
            idempotency_key: actionKey,
            payload_hash: HASH,
          },
        ],
      },
    },
    T0,
    "agent:drafter",
    unit.options,
  );
  assert.ok(registered.ok, JSON.stringify(registered));

  const storeDir = payloadStoreDirFor(unit.logPath);
  const disk = new CrashDisk(storeDir);
  setAppendWriteLayerForTests(disk);
  const result = request(
    unit.logPath,
    {
      task,
      actionKey,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      payload: { value: PAYLOAD },
    },
    at(1),
    "agent:drafter",
    unit.options,
  );
  setAppendWriteLayerForTests(null);
  assert.ok(result.ok, JSON.stringify(result));

  // The payload's data and name are synced before the append that binds it
  // writes a byte.
  const payloadSynced = disk.trace.indexOf("fsync(store-dir)");
  const logWritten = disk.trace.indexOf("write(log)");
  assert.ok(payloadSynced >= 0 && logWritten > payloadSynced, disk.trace.join(" "));

  disk.crash();

  const verified = verifyWithRecords(unit.logPath);
  assert.equal(verified.result.status, "clean");
  const requested = verified.records.find((record) => record.event === "approval.requested");
  assert.ok(requested !== undefined);
  assert.equal((requested.payload as Record<string, unknown>)["payload_hash"], HASH);
  const loaded = loadPayload(storeDir, HASH);
  assert.ok(loaded.ok, JSON.stringify(loaded));
});

// ---------------------------------------------------------------------------
// Failures: nothing is reported stored that is not known durable
// ---------------------------------------------------------------------------

function storeResidue(storeDir: string): string[] {
  return existsSync(storeDir) ? readdirSync(storeDir).sort() : [];
}

test("a failed fsync of the temp file is write-failed, renames nothing and leaves no temp", () => {
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  const disk = new CrashDisk(storeDir, { fsyncFile: "EIO" });
  setAppendWriteLayerForTests(disk);
  const stored = storePayload(storeDir, PAYLOAD);
  setAppendWriteLayerForTests(null);

  assert.equal(stored.ok === false && stored.code, "write-failed");
  assert.ok(!stored.ok && /EIO/u.test(stored.message), JSON.stringify(stored));
  assert.ok(!disk.trace.some((word) => word.startsWith("rename")), disk.trace.join(" "));
  // The descriptor was closed even though its fsync threw.
  assert.equal(disk.trace.at(-1), "close(temp)");
  assert.deepEqual(storeResidue(storeDir), []);
});

test("a short write is write-failed, is never fsynced as if whole, and leaves no temp", () => {
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  const disk = new CrashDisk(storeDir, { shortWrite: true });
  setAppendWriteLayerForTests(disk);
  const stored = storePayload(storeDir, PAYLOAD);
  setAppendWriteLayerForTests(null);

  assert.equal(stored.ok === false && stored.code, "write-failed");
  assert.ok(!stored.ok && /short/u.test(stored.message), JSON.stringify(stored));
  assert.deepEqual(disk.trace, ["open(temp,excl)", "write(temp)", "close(temp)"]);
  assert.deepEqual(storeResidue(storeDir), []);
});

test("a failed directory fsync after the rename is write-failed and says the file may be in place", () => {
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  const disk = new CrashDisk(storeDir, { fsyncDir: "EIO" });
  setAppendWriteLayerForTests(disk);
  const stored = storePayload(storeDir, PAYLOAD);
  setAppendWriteLayerForTests(null);

  assert.equal(stored.ok === false && stored.code, "write-failed");
  assert.ok(!stored.ok && stored.message.includes(`directory ${storeDir} could not be synced`), JSON.stringify(stored));
  assert.ok(!stored.ok && /may be present now and absent after a crash/u.test(stored.message));
  // The directory handle is closed even though its fsync threw.
  assert.equal(disk.trace.at(-1), "close(store-dir)");
});

test("a filesystem that cannot fsync a directory (EINVAL) does not fail the store", () => {
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  const disk = new CrashDisk(storeDir, { fsyncDir: "EINVAL" });
  setAppendWriteLayerForTests(disk);
  const stored = storePayload(storeDir, PAYLOAD);
  setAppendWriteLayerForTests(null);

  assert.ok(stored.ok, JSON.stringify(stored));
  assert.ok(disk.trace.includes("fsync(store-dir)"));
});

test("production's layer really calls fs.fsyncSync on the payload, then on its directory", () => {
  // The cases above prove the ORDER through an injected layer; this one proves
  // the layer production runs is not a no-op for the store, the same spy
  // tests/log-fsync.test.ts uses for the log.
  const storeDir = join(caseRoot(), "payloads");
  mkdirSync(storeDir);
  setAppendWriteLayerForTests(null);
  const original = fs.fsyncSync;
  const synced: Array<{ size: number; dir: boolean }> = [];
  fs.fsyncSync = (fd: number): void => {
    const stats = fs.fstatSync(fd);
    synced.push({ size: stats.size, dir: stats.isDirectory() });
    original(fd);
  };
  syncBuiltinESMExports();
  let stored: ReturnType<typeof storePayload>;
  try {
    stored = storePayload(storeDir, PAYLOAD);
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(stored.ok, JSON.stringify(stored));
  assert.equal(synced.length, 2, JSON.stringify(synced));
  assert.deepEqual(synced[0], { size: BYTES.length, dir: false });
  assert.equal(synced[1]?.dir, true);
});
