/**
 * The verified-head snapshot (APRV-188): what it endorses, and everything that
 * makes a reader refuse it.
 *
 * The claim under test has two halves and they are asserted separately.
 *
 * **Equivalence.** A read resumed behind a snapshot returns exactly what a cold
 * read of the same bytes returns: the same records, in the same order, with the
 * same head. Every positive case ends by comparing against
 * `readVerifiedRecords(path, { cache: null })`, the explicitly cold read, so a
 * snapshot can never be observed to change an answer.
 *
 * **Refusal.** Every check in the admission is exercised by a case that trips
 * exactly it, and every one of them lands in the same place: the cold walk, with
 * the same records and the same head. A refused snapshot is not an error
 * anywhere — it is the behaviour of a machine with no snapshot at all.
 *
 * The forgery case the task names is here twice: a snapshot that endorses bytes
 * that are not the log's (`digest-mismatch`), and a snapshot that endorses the
 * log's real bytes while naming a head they do not end at (`head-mismatch`).
 * The second is the one a lying publisher would produce, and it is caught by the
 * reader's own parse rather than by trust.
 *
 * Nothing here hand-writes a log line: every record is appended through
 * `core/log.ts`, and the snapshots are published through the same
 * `publishSnapshot` the daemon uses, except where a case must forge one — which
 * it does by writing the snapshot FILE, never the log.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { appendEvent } from "../src/core/log.js";
import {
  processReadCache,
  readVerifiedRecords,
  useVerifiedSnapshots,
  VerifiedReadCache,
  verifiedSnapshotsEnabled,
} from "../src/core/state.js";
import {
  admitSnapshot,
  clearSnapshot,
  forgetPublishedSnapshots,
  publishSnapshot,
  readSnapshot,
  snapshotPathFor,
  SNAPSHOT_VERSION,
  type VerifiedSnapshot,
} from "../src/core/verified-snapshot.js";
import { assertClean, attest, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("verified-snapshot");

after(() => {
  useVerifiedSnapshots(false);
  scratch.cleanup();
});

/** A log of `size` records, built through the only sanctioned writer. */
function fixture(size: number): Scenario {
  const unit = newScenario(scratch.root);
  attest(unit, T0);
  const existing = readFileSync(unit.logPath, "utf8").split("\n").filter((line) => line).length;
  for (let index = existing; index < size; index += 1) {
    const appended = appendEvent(unit.logPath, {
      ts: T0,
      event: "task.registered",
      actor: "agent:planner",
      task: `filler-${String(index).padStart(5, "0")}`,
      channel: "cli",
      payload: { title: `filler ${String(index)}` },
    });
    assert.ok(appended.ok, `filler append failed: ${JSON.stringify(appended)}`);
  }
  assertClean(unit);
  return unit;
}

/** Publish for `unit` exactly as the daemon does: on a clean verified read. */
function publish(unit: Scenario): void {
  const read = readVerifiedRecords(unit.logPath, {
    cache: new VerifiedReadCache(),
    publishSnapshot: true,
  });
  assert.equal(read.ok, true, "the publishing read must be clean");
}

/** The snapshot on disk, parsed. Fails the test when there is none. */
function published(unit: Scenario): VerifiedSnapshot {
  const read = readSnapshot(unit.logPath);
  assert.equal(read.ok, true, `expected a snapshot: ${JSON.stringify(read)}`);
  return (read as { ok: true; snapshot: VerifiedSnapshot }).snapshot;
}

/** Overwrite the snapshot file with `snapshot`, forging what a publisher said. */
function forge(unit: Scenario, snapshot: VerifiedSnapshot): void {
  writeFileSync(snapshotPathFor(unit.logPath), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

/** The cold truth this suite compares every resumed read against. */
function coldRead(unit: Scenario): { records: unknown[]; head: unknown } {
  const read = readVerifiedRecords(unit.logPath, { cache: null });
  assert.equal(read.ok, true, `the cold read must be clean: ${JSON.stringify(read)}`);
  const ok = read as { ok: true; records: unknown[]; head: unknown };
  return { records: ok.records, head: ok.head };
}

/**
 * One read with snapshots enabled and an empty cache: what a fresh hook process
 * does. Returns the read and whether the snapshot was actually used.
 */
function hookRead(unit: Scenario): { records: unknown[]; head: unknown; resumed: number } {
  const cache = new VerifiedReadCache();
  useVerifiedSnapshots(true);
  try {
    const read = readVerifiedRecords(unit.logPath, { cache });
    assert.equal(read.ok, true, `the resumed read must be clean: ${JSON.stringify(read)}`);
    const ok = read as { ok: true; records: unknown[]; head: unknown };
    return { records: ok.records, head: ok.head, resumed: cache.stats.resumed };
  } finally {
    useVerifiedSnapshots(false);
  }
}

/** The whole claim, in one assertion: same answer, and the walk was skipped. */
function assertEquivalent(unit: Scenario, expectResumed: boolean): void {
  const cold = coldRead(unit);
  const hook = hookRead(unit);
  assert.deepEqual(hook.records, cold.records, "a resumed read returns the cold read's records");
  assert.deepEqual(hook.head, cold.head, "a resumed read returns the cold read's head");
  assert.equal(
    hook.resumed,
    expectResumed ? 1 : 0,
    expectResumed ? "the snapshot must have been used" : "the snapshot must have been refused",
  );
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a fresh snapshot serves the whole log, and serves the cold read's answer", () => {
  const unit = fixture(60);
  publish(unit);
  assertEquivalent(unit, true);
});

test("a stale snapshot serves the prefix and the reader walks the tail", () => {
  const unit = fixture(40);
  publish(unit);
  const endorsed = published(unit).byte_length;

  // The log grows after the snapshot was published, exactly as it does between
  // a daemon tick and the next hook.
  for (let index = 0; index < 5; index += 1) {
    const appended = appendEvent(unit.logPath, {
      ts: T0,
      event: "task.registered",
      actor: "agent:planner",
      task: `later-${String(index)}`,
      channel: "cli",
      payload: { title: "later" },
    });
    assert.ok(appended.ok, JSON.stringify(appended));
  }
  assert.ok(readFileSync(unit.logPath).length > endorsed, "the log grew past the endorsed prefix");

  assertEquivalent(unit, true);
  // The head the resumed read reports is the FILE's head, not the snapshot's.
  const snapshot = published(unit);
  const hook = hookRead(unit);
  assert.notEqual(
    (hook.head as { seq: number }).seq,
    snapshot.head.seq,
    "the resumed head is the log's, not the endorsed prefix's",
  );
});

test("an empty and a one-record log need no snapshot and get the same answer", () => {
  const unit = newScenario(scratch.root);
  // No log at all: an absent log is an empty log, and there is nothing to
  // endorse. The read must still succeed.
  assertEquivalent(unit, false);
  attest(unit, T0);
  publish(unit);
  assertEquivalent(unit, true);
});

test("publishing is off unless a caller asks, and consuming is off unless the process opts in", () => {
  const unit = fixture(20);
  clearSnapshot(unit.logPath);

  // An ordinary read publishes nothing.
  const read = readVerifiedRecords(unit.logPath, { cache: new VerifiedReadCache() });
  assert.equal(read.ok, true);
  assert.equal(readSnapshot(unit.logPath).ok, false, "an ordinary read must publish no snapshot");

  publish(unit);
  assert.equal(verifiedSnapshotsEnabled(), false, "consumption is off by default");
  const cache = new VerifiedReadCache();
  const unopted = readVerifiedRecords(unit.logPath, { cache });
  assert.equal(unopted.ok, true);
  assert.equal(cache.stats.resumed, 0, "a process that did not opt in walks the log");
});

test("an explicitly cold read stays cold even with a snapshot in place", () => {
  // `cache: null` is what an audit asks for. A caller that opted out of this
  // process's own proved prefix has not opted into another process's.
  const unit = fixture(20);
  publish(unit);
  useVerifiedSnapshots(true);
  try {
    const before = { ...processReadCache.stats };
    const read = readVerifiedRecords(unit.logPath, { cache: null });
    assert.equal(read.ok, true);
    assert.deepEqual(processReadCache.stats, before, "cache: null touches no cache and no snapshot");
  } finally {
    useVerifiedSnapshots(false);
  }
});

test("a publisher and a reader that spell the log differently still agree", () => {
  // The alias case, and it is not exotic: on macOS `/var/folders/...` and
  // `/private/var/folders/...` are one directory, and Node hands a process its
  // `cwd` already resolved while a daemon may have been started with the other
  // spelling. Comparing spellings would refuse every snapshot there, which is
  // safe and useless. Both sides resolve the path, so the aliases collapse.
  const unit = fixture(20);
  publish(unit);

  const alias = join(scratch.root, `alias-${String(Date.now())}`);
  mkdirSync(alias, { recursive: true });
  const linked = join(alias, "link");
  symlinkSync(realpathSync(unit.dir), linked);

  const viaLink: Scenario = {
    ...unit,
    dir: linked,
    logPath: join(linked, ".approval", "log", "events.jsonl"),
  };
  const read = hookRead(viaLink);
  assert.equal(read.resumed, 1, "the same log reached by a symlink is the same log");
  assert.deepEqual(read.records, coldRead(unit).records);
});

test("the file is written at mode 0600 and beside the log", () => {
  const unit = fixture(10);
  publish(unit);
  const path = snapshotPathFor(unit.logPath);
  assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  assert.match(path, /verified-head\.json$/u);
});

// ---------------------------------------------------------------------------
// Refusals. Every one of these must land on the cold walk, silently.
// ---------------------------------------------------------------------------

test("no snapshot at all is the pre-APRV-188 behaviour", () => {
  const unit = fixture(30);
  clearSnapshot(unit.logPath);
  assert.equal((readSnapshot(unit.logPath) as { reason: string }).reason, "absent");
  assertEquivalent(unit, false);
});

test("a snapshot endorsing bytes the log does not have is refused", () => {
  // The forgery the task names: the publisher claims a digest, and the bytes on
  // disk hash to something else. This is the check the whole design rests on.
  const unit = fixture(30);
  publish(unit);
  forge(unit, { ...published(unit), sha256: "b".repeat(64) });

  const raw = readFileSync(unit.logPath);
  const admitted = admitSnapshot(unit.logPath, raw, published(unit), undefined);
  assert.equal(admitted.ok, false);
  assert.equal((admitted as { reason: string }).reason, "digest-mismatch");
  assertEquivalent(unit, false);
});

test("a snapshot naming a head the endorsed bytes do not end at is refused", () => {
  // The lying publisher: the digest is honest, so the bytes are the log's own,
  // but the head is not the head those bytes reach. The reader re-derives it
  // from its own parse and refuses.
  const unit = fixture(30);
  publish(unit);
  const honest = published(unit);
  forge(unit, { ...honest, head: { seq: honest.head.seq, hash: "c".repeat(64) } });

  const raw = readFileSync(unit.logPath);
  const admitted = admitSnapshot(unit.logPath, raw, published(unit), undefined);
  assert.equal(admitted.ok, false);
  assert.equal((admitted as { reason: string }).reason, "head-mismatch");
  assertEquivalent(unit, false);
});

test("a snapshot naming the wrong number of lines is refused", () => {
  const unit = fixture(30);
  publish(unit);
  const honest = published(unit);
  forge(unit, { ...honest, lines: honest.lines - 1 });

  const raw = readFileSync(unit.logPath);
  const admitted = admitSnapshot(unit.logPath, raw, published(unit), undefined);
  assert.equal(admitted.ok, false);
  assert.equal((admitted as { reason: string }).reason, "line-count-mismatch");
  assertEquivalent(unit, false);
});

test("a snapshot for another log is refused", () => {
  const unit = fixture(20);
  const other = fixture(20);
  publish(unit);
  forge(unit, { ...published(unit), log: other.logPath });
  assertEquivalent(unit, false);
});

test("a snapshot verified against other schemas is refused", () => {
  const unit = fixture(20);
  publish(unit);
  forge(unit, { ...published(unit), schema_dir: "/nowhere/schema" });
  assertEquivalent(unit, false);
});

test("a snapshot of a longer prefix than the file holds is refused", () => {
  const unit = fixture(20);
  publish(unit);
  forge(unit, { ...published(unit), byte_length: readFileSync(unit.logPath).length + 4096 });
  assertEquivalent(unit, false);
});

test("a prefix that does not end at a line boundary is refused", () => {
  const unit = fixture(20);
  publish(unit);
  const honest = published(unit);
  forge(unit, { ...honest, byte_length: honest.byte_length - 3 });
  assertEquivalent(unit, false);
});

test("a snapshot of an unknown version is refused", () => {
  const unit = fixture(20);
  publish(unit);
  forge(unit, { ...published(unit), v: SNAPSHOT_VERSION + 1 });
  assert.equal((readSnapshot(unit.logPath) as { reason: string }).reason, "version");
  assertEquivalent(unit, false);
});

test("a malformed snapshot is refused", () => {
  const unit = fixture(20);
  publish(unit);
  writeFileSync(snapshotPathFor(unit.logPath), "{not json", { mode: 0o600 });
  assert.equal((readSnapshot(unit.logPath) as { reason: string }).reason, "malformed");
  assertEquivalent(unit, false);

  // Structurally valid JSON with a field of the wrong type is equally refused:
  // there is no partial admission.
  writeFileSync(snapshotPathFor(unit.logPath), '{"v":1,"log":3}\n', { mode: 0o600 });
  assert.equal((readSnapshot(unit.logPath) as { reason: string }).reason, "malformed");
  assertEquivalent(unit, false);
});

test("a snapshot anyone else could have written is refused", () => {
  // The ownership argument in the module header is only true while this holds:
  // a snapshot at a mode that lets another user write it is not evidence of
  // anything, and the reader must not even parse it.
  const unit = fixture(20);
  publish(unit);
  chmodSync(snapshotPathFor(unit.logPath), 0o666);
  const read = readSnapshot(unit.logPath);
  assert.equal(read.ok, false);
  assert.equal((read as { reason: string }).reason, "loose-permissions");
  assertEquivalent(unit, false);
});

test("a snapshot whose prefix holds a broken chain is refused", () => {
  // A publisher that endorsed bytes it had not actually walked, with an HONEST
  // digest of them: only the reader's own link check stands between it and a bad
  // read, and this is what that check is for.
  //
  // The spliced bytes exist only in memory and are handed straight to
  // `admitSnapshot`, which reads no file. No log on disk is fabricated, edited
  // or reordered anywhere in this suite.
  const unit = fixture(20);
  const lines = readFileSync(unit.logPath, "utf8").split("\n").filter((line) => line);
  const spliced = Buffer.from(`${[...lines.slice(0, -1), lines[0] as string].join("\n")}\n`, "utf8");

  const forged: VerifiedSnapshot = {
    v: SNAPSHOT_VERSION,
    log: realpathSync(unit.logPath),
    schema_dir: "",
    byte_length: spliced.length,
    sha256: createHash("sha256").update(spliced).digest("hex"),
    lines: lines.length,
    head: { seq: 1, hash: JSON.parse(lines[0] as string).hash as string },
    verified_at: T0,
    pid: 1,
  };
  const admitted = admitSnapshot(unit.logPath, spliced, forged, undefined);
  assert.equal(admitted.ok, false);
  assert.equal((admitted as { reason: string }).reason, "chain-broken");
});

test("publishSnapshot refuses a prefix that is not newline-terminated", () => {
  const unit = fixture(10);
  const raw = readFileSync(unit.logPath);
  const truncated = raw.subarray(0, raw.length - 1);
  assert.equal(
    publishSnapshot(
      unit.logPath,
      truncated,
      createHash("sha256").update(truncated).digest("hex"),
      10,
      { seq: 10, hash: "e".repeat(64) },
      undefined,
    ),
    false,
    "a prefix that does not end at a line boundary is never published",
  );
});

// ---------------------------------------------------------------------------
// Publishing only what changed (APRV-211)
// ---------------------------------------------------------------------------

/** The log's bytes, its digest, its line count and its head: what a publish takes. */
function endorsement(unit: Scenario): {
  raw: Buffer;
  digest: string;
  lines: number;
  head: { seq: number; hash: string };
} {
  const raw = readFileSync(unit.logPath);
  const read = readVerifiedRecords(unit.logPath, { cache: null });
  assert.equal(read.ok, true, "the log must verify before it may be endorsed");
  const ok = read as { ok: true; records: unknown[]; head: { seq: number; hash: string } };
  return {
    raw,
    digest: createHash("sha256").update(raw).digest("hex"),
    lines: ok.records.length,
    head: ok.head,
  };
}

/** The snapshot file's identity: a temp-and-rename publish always changes it. */
function snapshotIdentity(unit: Scenario): string {
  const stats = statSync(snapshotPathFor(unit.logPath));
  return `${String(stats.ino)}:${String(stats.mtimeMs)}`;
}

test("publishing the same bytes twice writes the file once", () => {
  // APRV-211. The snapshot lands in the directory the daemon watches, so a
  // publish that re-states an unchanged endorsement is a filesystem event whose
  // only cause was the previous tick — the daemon waking itself. Nothing about
  // what a reader may believe changes: the file on disk is the same file.
  const unit = fixture(15);
  forgetPublishedSnapshots(unit.logPath);
  const { raw, digest, lines, head } = endorsement(unit);

  assert.equal(publishSnapshot(unit.logPath, raw, digest, lines, head, undefined), true);
  const first = snapshotIdentity(unit);
  assert.equal(
    publishSnapshot(unit.logPath, raw, digest, lines, head, undefined),
    false,
    "the same endorsement must not be written a second time",
  );
  assert.equal(snapshotIdentity(unit), first, "the file was rewritten");

  // The same suppression through the read path the daemon actually uses.
  publish(unit);
  assert.equal(snapshotIdentity(unit), first, "a clean read of an unchanged log republished");
  assertEquivalent(unit, true);
});

test("a changed prefix publishes again", () => {
  const unit = fixture(15);
  forgetPublishedSnapshots(unit.logPath);
  publish(unit);
  const before = snapshotIdentity(unit);
  const endorsed = published(unit).byte_length;

  const appended = appendEvent(unit.logPath, {
    ts: T0,
    event: "task.registered",
    actor: "agent:planner",
    task: "one-more",
    channel: "cli",
    payload: { title: "one more" },
  });
  assert.ok(appended.ok, JSON.stringify(appended));

  publish(unit);
  assert.notEqual(snapshotIdentity(unit), before, "a log that grew must be endorsed again");
  assert.ok(published(unit).byte_length > endorsed, "the new endorsement covers the new bytes");
  assertEquivalent(unit, true);
});

test("the published sha256 is the digest the publisher was handed", () => {
  // The digest is a parameter now rather than a recomputation, so the file must
  // carry exactly what the verifying read proved over the bytes it walked.
  const unit = fixture(15);
  forgetPublishedSnapshots(unit.logPath);
  const { raw, digest, lines, head } = endorsement(unit);
  assert.equal(publishSnapshot(unit.logPath, raw, digest, lines, head, undefined), true);

  const snapshot = published(unit);
  assert.equal(snapshot.sha256, digest);
  assert.equal(snapshot.byte_length, raw.length);
  assert.equal(snapshot.lines, lines);
  assert.deepEqual(snapshot.head, head);
  assertEquivalent(unit, true);
});

test("clearing a snapshot makes the next clean read publish it again", () => {
  // The memo describes a file. Removing the file must not leave this process
  // believing a snapshot is in place that is not.
  const unit = fixture(15);
  publish(unit);
  clearSnapshot(unit.logPath);
  assert.equal(readSnapshot(unit.logPath).ok, false, "the file is gone");
  publish(unit);
  assert.equal(readSnapshot(unit.logPath).ok, true, "the same bytes are endorsed again");
  assertEquivalent(unit, true);
});
