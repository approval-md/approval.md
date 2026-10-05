/**
 * A lock left by a writer that died holding it is reclaimed, and only then
 * (APRV-479).
 *
 * `core/log.ts` never stole a lock, so a writer killed while it held
 * `<log>.lock` (a hook under SIGTERM with no listener, anything under SIGKILL, a
 * Hermes gateway restart mid-append) wedged every later writer on
 * `lock-timeout` until a human removed the file. These pin the way out and its
 * limits:
 *
 * - the APRV-478 refuter's repro: a lockfile naming a dead pid is reclaimed by
 *   the next writer, which appends `audit.lock_reclaimed` first and then its own
 *   record, and the chain verifies;
 * - a lockfile naming a live process is never reclaimed, however old, and the
 *   writer times out as it always did, naming the holder;
 * - a pid that now names a later process is reclaimed where the start time can
 *   be read (Linux), and treated as live where it cannot;
 * - a lockfile with no holder record is kept until it is ten minutes old, then
 *   reclaimed with no holder in the record;
 * - a sync snapshot beside the log, or an absent log, keeps even a dead
 *   holder's lock;
 * - compare-and-append is unchanged: a head read before the reclaim is refused
 *   `head-moved`, and a fresh read appends;
 * - a SIGTERM that arrives while a process holds the lock mid-append no longer
 *   leaves the lockfile: the process still dies of the signal, after release;
 * - writers racing to reclaim the same stale lock: exactly one reclaims, every
 *   append lands, one reclaim record, the chain verifies;
 * - the liveness check is load-bearing: with it replaced by "gone", the live
 *   holder's lock is taken.
 *
 * Fix round 1 (the A2 refuter's findings) adds, each failing on 01abbddd:
 *
 * - B1: a `/proc` entry this reader cannot see or read is never "gone" on its
 *   own: absent needs `kill(pid, 0)` to answer ESRCH, and anything unreadable is
 *   live (decision table; hidepid across uids in a privileged Linux container);
 * - B2/S4: a boot reading that differs (a wall-clock step on macOS, another
 *   kernel on Linux) proves nothing, and a running pid keeps its lock;
 * - B3: a claim is passed over only when its claimant is provably gone, never by
 *   age: a reclaimer stalled at any step keeps its claim against a writer whose
 *   clock reads an hour later, and a claimant killed mid-reclaim is succeeded by
 *   exactly one reclaimer;
 * - S1: the record of a reclaim is written before the lock is freed and appended
 *   by whichever writer takes the lock next, so a reclaimer that never gets the
 *   lock cannot lose it;
 * - S2: a verb that appends and then waits synchronously (`approval policy
 *   amend`) dies of Ctrl-C at once rather than at the end of its wait;
 * - S3: a `/proc` that is not this pid namespace's is not trusted (unit; an
 *   unshared pid namespace in a privileged Linux container);
 * - N2: a lockfile that changes hands between the last check and the rename
 *   (same inode rewritten, or a new inode) survives the reclaim;
 * - N3: what a killed reclaimer leaves beside the lock is excluded from the
 *   tenant export.
 *
 * Fix round 2 (the A2 recheck), each failing on 1b764242:
 *
 * - RB1: a FIFO or a symbolic link at the lock path or a pending name never
 *   hangs a writer and is never followed;
 * - RB2: a calendar-impossible `created` makes the record unreadable, so the
 *   lock is kept, and no pending file can make every later append fail;
 * - RB3: a committed reclaim is always recorded before any other record, as
 *   `unverified` when the next writer cannot judge it, and a pending directory
 *   that cannot be listed refuses the append (`reclaim-pending-unreadable`);
 * - RS1: a stop request during `approval run`'s `execution.started` append, or
 *   during a reclaim, ends the process before the command (or the append) runs;
 * - RS3/RS4: one hold reads at most 64 pending names and records at most 16,
 *   oldest first, and every pending file leaves `pending/`;
 * - RS5: a claimant that sees a next-generation claim backs off;
 * - a writer killed between recording a pending reclaim and moving it out does
 *   not leave a duplicate record.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appendEvent, withAppendLock, type EventInput, type EventRecord } from "../src/core/log.js";
import {
  describeLogLock,
  holderRecord,
  judgeHolder,
  LEGACY_LOCK_RECLAIM_AGE_MS,
  NODE_LIVENESS_PROBE,
  parseProcStat,
  procIsOwnNamespace,
  selfIdentity,
  setLockLivenessForTests,
  setReclaimSeamForTests,
  tryReclaimLock,
  type LivenessProbe,
  type LockHolder,
  type ProcStatRead,
  type SelfIdentity,
} from "../src/core/log-lock.js";
import { runPayloadHash } from "../src/core/payload.js";
import { verify } from "../src/core/verify.js";
import { isExcludedPath } from "../src/serve/archive.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-lock-reclaim-"));
after(() => {
  setLockLivenessForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log.js")).href;
const LOCK_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log-lock.js")).href;
const WRITE_LAYER_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log-write-layer.js")).href;
const CLI_ENTRY = join(REPO_ROOT, "dist", "src", "cli", "main.js");

const LINUX = process.platform === "linux";

let counter = 0;
function freshLog(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`, "log");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "events.jsonl");
  const first = appendEvent(logPath, REGISTERED);
  assert.ok(first.ok, "the log exists before the lock is left behind");
  return logPath;
}

const REGISTERED: EventInput = {
  ts: "2026-10-05T07:00:00Z",
  event: "task.registered",
  actor: "agent:planner",
  task: "task-479",
  channel: "cli",
  payload: { title: "a stale lock" },
};

function granted(n: number): EventInput {
  return {
    ts: "2026-10-05T07:00:01Z",
    event: "approval.granted",
    actor: "human:carter",
    task: "task-479",
    action_key: `task-479:writer:${String(n)}`,
    channel: "cli",
  };
}

function records(logPath: string): EventRecord[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function writeLock(logPath: string, content: LockHolder | string): void {
  writeFileSync(`${logPath}.lock`, typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
}

/** A holder record exactly as this process would write it, with fields replaced. */
function holder(overrides: Partial<LockHolder> = {}): LockHolder {
  return { ...holderRecord("append", new Date(Date.now() - 60_000)), ...overrides };
}

/** A pid that existed a moment ago and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
  assert.ok(typeof child.pid === "number" && child.pid > 0);
  return child.pid;
}

/** What a reclaim may have left behind: everything under `<log>.lock.d/`, and any stray name beside the lock. */
function residue(logPath: string): string[] {
  const found = readdirSync(join(logPath, "..")).filter((name) => name.startsWith("events.jsonl.lock.") && name !== "events.jsonl.lock.d");
  const root = `${logPath}.lock.d`;
  for (const part of ["claims", "pending", "quarantine"]) {
    const dir = join(root, part);
    if (existsSync(dir)) for (const name of readdirSync(dir)) found.push(`${part}/${name}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The repro and its controls
// ---------------------------------------------------------------------------

test("a lock left by a dead pid is reclaimed: the writer appends, and the log records the reclaim first", () => {
  const logPath = freshLog();
  const pid = deadPid();
  const left = holder({ pid, created: new Date(Date.now() - 5_000).toISOString() });
  writeLock(logPath, left);

  const result = appendEvent(logPath, granted(1), { lockTimeoutMs: 500, lockRetryMs: 5 });
  assert.ok(result.ok, `the writer reclaimed and appended: ${result.ok ? "" : result.error.message}`);

  const log = records(logPath);
  assert.deepEqual(
    log.map((record) => record.event),
    ["task.registered", "audit.lock_reclaimed", "approval.granted"],
  );
  const reclaim = log[1] as EventRecord;
  assert.equal(reclaim.actor, "system:log");
  assert.deepEqual(reclaim.payload?.["holder"], { pid, op: "append", created: left.created });
  assert.equal(reclaim.payload?.["reason"], "holder-dead");
  assert.equal(reclaim.payload?.["lockfile"], "events.jsonl.lock");
  assert.ok((reclaim.payload?.["age_ms"] as number) >= 4_000);
  assert.equal(existsSync(`${logPath}.lock`), false, "the writer's own lock is released");
  assert.deepEqual(residue(logPath), [], "the reclaim leaves no names behind");
  assert.equal(verify(logPath).status, "clean");
});

test("a lock held by a live process is never reclaimed, however old: the writer times out as before and names the holder", () => {
  const logPath = freshLog();
  const before = readFileSync(logPath);
  // This process is alive, and its record is exactly the one it would write.
  const live = holder({ created: new Date(Date.now() - 24 * 3_600_000).toISOString() });
  writeLock(logPath, live);
  const lockBytes = readFileSync(`${logPath}.lock`);

  const result = appendEvent(logPath, granted(2), { lockTimeoutMs: 80, lockRetryMs: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "lock-timeout");
    assert.match(result.error.message, /another writer holds .*events\.jsonl\.lock; gave up after 80ms/u);
    assert.match(result.error.message, new RegExp(`pid ${String(process.pid)} `, "u"));
    assert.match(result.error.message, /is running/u);
  }
  assert.deepEqual(readFileSync(logPath), before, "nothing was appended");
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the live holder's lockfile is untouched");
  assert.deepEqual(residue(logPath), []);
  rmSync(`${logPath}.lock`);
});

test("a pid that now names a later process: reclaimed where the start time can be read, kept as live where it cannot", () => {
  const logPath = freshLog();
  // This process's pid, with a start time that is not this process's.
  writeLock(logPath, holder({ start: "1" }));
  const result = appendEvent(logPath, granted(3), { lockTimeoutMs: 80, lockRetryMs: 5 });
  if (LINUX) {
    assert.ok(result.ok, `reclaimed on Linux: ${result.ok ? "" : result.error.message}`);
    const reclaim = records(logPath).find((record) => record.event === "audit.lock_reclaimed");
    assert.equal(reclaim?.payload?.["reason"], "holder-replaced");
    assert.equal(verify(logPath).status, "clean");
  } else {
    assert.equal(result.ok, false, "off Linux a running pid is taken to be the holder");
    if (!result.ok) {
      assert.equal(result.error.code, "lock-timeout");
      assert.match(result.error.message, /no way to read its start time without ps/u);
    }
    rmSync(`${logPath}.lock`);
  }
  assert.deepEqual(residue(logPath), []);
});

test("an unattributed lockfile is kept while it is younger than the reclaim age, and reclaimed once older", () => {
  const logPath = freshLog();
  writeLock(logPath, "");
  const young = appendEvent(logPath, granted(4), { lockTimeoutMs: 60, lockRetryMs: 5 });
  assert.equal(young.ok, false);
  if (!young.ok) {
    assert.equal(young.error.code, "lock-timeout");
    assert.match(young.error.message, /names no holder/u);
  }
  assert.equal(records(logPath).length, 1);

  const old = (Date.now() - LEGACY_LOCK_RECLAIM_AGE_MS - 60_000) / 1000;
  utimesSync(`${logPath}.lock`, old, old);
  const aged = appendEvent(logPath, granted(4), { lockTimeoutMs: 60, lockRetryMs: 5 });
  assert.ok(aged.ok, `the aged lockfile was reclaimed: ${aged.ok ? "" : aged.error.message}`);
  const reclaim = records(logPath)[1] as EventRecord;
  assert.equal(reclaim.event, "audit.lock_reclaimed");
  assert.equal(reclaim.payload?.["reason"], "legacy-aged");
  assert.equal(reclaim.payload?.["holder"], undefined, "no holder record, none recorded");
  assert.ok((reclaim.payload?.["age_ms"] as number) >= LEGACY_LOCK_RECLAIM_AGE_MS);
  assert.equal(verify(logPath).status, "clean");
});

test("a holder record in a format this version does not read is never reclaimed", () => {
  const logPath = freshLog();
  writeLock(logPath, `${JSON.stringify({ v: 2, pid: deadPid() })}\n`);
  const outcome = tryReclaimLock(logPath);
  assert.equal(outcome.kind, "kept");
  assert.ok(existsSync(`${logPath}.lock`));
});

test("a sync snapshot beside the log, or an absent log, keeps even a dead holder's lock", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  writeFileSync(`${logPath}.sync-snapshot`, readFileSync(logPath));
  const synced = appendEvent(logPath, granted(5), { lockTimeoutMs: 60, lockRetryMs: 5 });
  assert.equal(synced.ok, false);
  if (!synced.ok) assert.match(synced.error.message, /sync snapshot .* is beside the log/u);
  assert.ok(existsSync(`${logPath}.lock`));
  assert.equal(records(logPath).length, 1);

  const absent = join(scratch, "absent", "events.jsonl");
  mkdirSync(join(scratch, "absent"), { recursive: true });
  writeLock(absent, holder({ pid: deadPid() }));
  const outcome = tryReclaimLock(absent);
  assert.equal(outcome.kind, "kept");
  if (outcome.kind === "kept") assert.match(outcome.why, /the log itself is absent/u);
  assert.equal(existsSync(absent), false, "nothing created a log");
});

test("compare-and-append is unchanged: a head read before the reclaim is refused head-moved, and a fresh read appends", () => {
  const logPath = freshLog();
  const head = records(logPath).at(-1) as EventRecord;
  writeLock(logPath, holder({ pid: deadPid() }));
  const stale = appendEvent(logPath, granted(6), {
    expectedHead: { seq: head.seq, hash: head.hash },
    lockTimeoutMs: 200,
    lockRetryMs: 5,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "head-moved");
  const log = records(logPath);
  assert.deepEqual(
    log.map((record) => record.event),
    ["task.registered", "audit.lock_reclaimed"],
    "the reclaim is recorded, and the caller's record is not",
  );
  const now = log.at(-1) as EventRecord;
  const fresh = appendEvent(logPath, granted(6), { expectedHead: { seq: now.seq, hash: now.hash } });
  assert.ok(fresh.ok);
  assert.equal(verify(logPath).status, "clean");
});

test("a whole-operation holder (withAppendLock) reclaims too, and the record precedes its work", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid(), op: "hold" }));
  const held = withAppendLock(logPath, () => records(logPath).map((record) => record.event));
  assert.ok(held.ok);
  if (held.ok) assert.deepEqual(held.value, ["task.registered", "audit.lock_reclaimed"]);
  const reclaim = records(logPath)[1] as EventRecord;
  const recordedHolder = (reclaim.payload ?? {})["holder"] as { op?: string } | undefined;
  assert.equal(recordedHolder?.op, "hold");
  assert.equal(existsSync(`${logPath}.lock`), false);
});

test("a writer releases only its own lockfile", () => {
  const logPath = freshLog();
  const other = `${JSON.stringify(holder({ pid: 1, nonce: "someone-else" }))}\n`;
  const held = withAppendLock(logPath, () => {
    // Somebody replaced the lockfile while this writer held it.
    rmSync(`${logPath}.lock`);
    writeFileSync(`${logPath}.lock`, other);
    return true;
  });
  assert.ok(held.ok);
  assert.equal(readFileSync(`${logPath}.lock`, "utf8"), other, "the release left the other lockfile alone");
  rmSync(`${logPath}.lock`);
});

test("describeLogLock names the holder without touching the file", () => {
  const logPath = freshLog();
  assert.equal(describeLogLock(logPath), null);
  writeLock(logPath, holder());
  assert.match(describeLogLock(logPath) ?? "", /held by pid/u);
  writeLock(logPath, holder({ pid: deadPid() }));
  assert.match(describeLogLock(logPath) ?? "", /the next writer reclaims it/u);
  assert.ok(existsSync(`${logPath}.lock`));
  rmSync(`${logPath}.lock`);
});

// ---------------------------------------------------------------------------
// The judgement, platform by platform, with the operating system stubbed
// ---------------------------------------------------------------------------

test("judgeHolder: the decision table on Linux and elsewhere", () => {
  const linuxSelf: SelfIdentity = {
    pid: 100,
    host: "box",
    boot: "boot-a",
    pidns: "pid:[1]",
    start: "500",
    linux: true,
  };
  const otherSelf: SelfIdentity = { pid: 100, host: "box", boot: "~1000000", pidns: undefined, start: undefined, linux: false };
  const linuxHolder = (overrides: Partial<LockHolder> = {}): LockHolder => ({
    v: 1,
    pid: 42,
    host: "box",
    boot: "boot-a",
    pidns: "pid:[1]",
    start: "300",
    created: "2026-10-05T07:00:00.000Z",
    op: "append",
    nonce: "n",
    ...overrides,
  });
  const otherHolder = (overrides: Partial<LockHolder> = {}): LockHolder => ({
    v: 1,
    pid: 42,
    host: "box",
    boot: "~1000003",
    created: "2026-10-05T07:00:00.000Z",
    op: "append",
    nonce: "n",
    ...overrides,
  });
  const noStart = linuxHolder();
  delete noStart.start;
  const probe = (stat: ProcStatRead, exists: boolean): LivenessProbe => ({
    linuxStat: () => stat,
    pidExists: () => exists,
  });
  const ABSENT: ProcStatRead = { kind: "absent" };
  const stat = (state: string, start: string): ProcStatRead => ({ kind: "stat", state, start });
  const unreadable = (why: string): ProcStatRead => ({ kind: "unreadable", why });

  const cases: Array<[string, ReturnType<typeof judgeHolder>["state"], string | undefined, ReturnType<typeof judgeHolder>]> = [
    ["linux: no /proc entry and kill(pid, 0) says ESRCH", "gone", "holder-dead", judgeHolder(linuxHolder(), linuxSelf, probe(ABSENT, false))],
    // B1: hidepid=invisible hides another uid's process as ENOENT; kill answers EPERM.
    ["linux: no /proc entry but kill(pid, 0) finds the pid (hidepid)", "live", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(ABSENT, true))],
    // B1: hidepid=noaccess (EACCES), an LSM denial, a parse failure: nothing is concluded.
    ["linux: /proc entry unreadable (EACCES), even with kill saying ESRCH", "live", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(unreadable("EACCES"), false))],
    ["linux: /proc entry unreadable (EPERM)", "live", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(unreadable("EPERM"), false))],
    ["linux: /proc stat unparseable", "live", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(unreadable("an unparseable stat line"), false))],
    ["linux: zombie", "gone", "holder-dead", judgeHolder(linuxHolder(), linuxSelf, probe(stat("Z", "300"), true))],
    ["linux: pid reused", "gone", "holder-replaced", judgeHolder(linuxHolder(), linuxSelf, probe(stat("S", "999"), true))],
    ["linux: same process", "live", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(stat("S", "300"), true))],
    ["linux: another pid namespace", "live", undefined, judgeHolder(linuxHolder({ pidns: "pid:[2]" }), linuxSelf, probe(ABSENT, false))],
    // S4: an earlier boot of this host and another kernel sharing the volume look the same.
    ["linux: another boot id, same host (reboot or another kernel)", "live", undefined, judgeHolder(linuxHolder({ boot: "boot-b" }), linuxSelf, probe(ABSENT, false))],
    ["linux: other boot, other host", "live", undefined, judgeHolder(linuxHolder({ boot: "boot-b", host: "elsewhere" }), linuxSelf, probe(ABSENT, false))],
    ["linux: record without boot", "live", undefined, judgeHolder(linuxHolder({ boot: "" }), linuxSelf, probe(ABSENT, false))],
    ["linux: record without start", "live", undefined, judgeHolder(noStart, linuxSelf, probe(stat("S", "300"), true))],
    ["linux: written off Linux", "live", undefined, judgeHolder(otherHolder(), linuxSelf, probe(ABSENT, false))],
    // S3: this reader's /proc belongs to another pid namespace.
    ["linux: this reader's /proc is foreign", "live", undefined, judgeHolder(linuxHolder(), { ...linuxSelf, procIsOwn: false }, probe(ABSENT, false))],
    ["linux: holder under another time namespace, start differs", "live", undefined, judgeHolder(linuxHolder({ timens: "time:[9]" }), linuxSelf, probe(stat("S", "999"), true))],
    ["linux: both in one time namespace, start differs", "gone", "holder-replaced", judgeHolder(linuxHolder({ timens: "time:[9]" }), { ...linuxSelf, timens: "time:[9]" }, probe(stat("S", "999"), true))],
    ["other: no such pid", "gone", "holder-dead", judgeHolder(otherHolder(), otherSelf, probe(ABSENT, false))],
    ["other: pid exists", "live", undefined, judgeHolder(otherHolder(), otherSelf, probe(ABSENT, true))],
    ["other: another host", "live", undefined, judgeHolder(otherHolder({ host: "elsewhere" }), otherSelf, probe(ABSENT, false))],
    // B2: the boot reading moves with every wall-clock step; the pid decides.
    ["other: boot reading moved, pid exists", "live", undefined, judgeHolder(otherHolder({ boot: "~900000" }), otherSelf, probe(ABSENT, true))],
    ["other: boot reading moved, pid gone", "gone", "holder-dead", judgeHolder(otherHolder({ boot: "~900000" }), otherSelf, probe(ABSENT, false))],
    ["other: written on Linux", "live", undefined, judgeHolder(linuxHolder(), otherSelf, probe(ABSENT, false))],
  ];
  for (const [name, state, reason, verdict] of cases) {
    assert.equal(verdict.state, state, name);
    if (verdict.state === "gone") assert.equal(verdict.reason, reason, name);
  }
});

test("procIsOwnNamespace: /proc is trusted only when /proc/self names this process", () => {
  assert.equal(procIsOwnNamespace(() => "8", 8), true);
  // `unshare --pid --fork` without a /proc remount: process.pid 8, /proc/self -> 15.
  assert.equal(procIsOwnNamespace(() => "15", 8), false);
  assert.equal(
    procIsOwnNamespace(() => {
      throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
    }, 8),
    false,
  );
});

test("the real probe: kill(pid, 0) EPERM is a pid that exists, and on Linux a dead pid's /proc entry is absent, never 'gone' by itself", () => {
  assert.equal(NODE_LIVENESS_PROBE.pidExists(process.pid), true);
  const dead = deadPid();
  assert.equal(NODE_LIVENESS_PROBE.pidExists(dead), false);
  if (typeof process.getuid === "function" && process.getuid() !== 0 && process.platform !== "win32") {
    // pid 1 belongs to root: EPERM, which is existence.
    assert.equal(NODE_LIVENESS_PROBE.pidExists(1), true);
  }
  if (LINUX) {
    assert.deepEqual(NODE_LIVENESS_PROBE.linuxStat(dead), { kind: "absent" });
    const own = NODE_LIVENESS_PROBE.linuxStat(process.pid);
    assert.equal(own.kind, "stat");
  }
});

test("parseProcStat counts fields from the last parenthesis, so a command name with spaces cannot shift them", () => {
  const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
  fields[0] = "S";
  const parsed = parseProcStat(`1234 (node (a) b) ${fields.join(" ")}`);
  assert.deepEqual(parsed, { state: "S", start: "22" });
  assert.equal(parseProcStat("garbage"), null);
});

test("this process's own record is judged live by the real check", () => {
  const verdict = judgeHolder(holder(), selfIdentity(), NODE_LIVENESS_PROBE);
  assert.equal(verdict.state, "live");
});

// ---------------------------------------------------------------------------
// The mutation pin: without the liveness check, the live holder's lock is taken
// ---------------------------------------------------------------------------

test("the liveness check is load-bearing: replaced by 'gone', a live holder's lock is reclaimed", () => {
  const logPath = freshLog();
  writeLock(logPath, holder());
  setLockLivenessForTests(() => ({ state: "gone", reason: "holder-dead", why: "mutated" }));
  try {
    const result = appendEvent(logPath, granted(7), { lockTimeoutMs: 80, lockRetryMs: 5 });
    assert.ok(result.ok, "with the check gone, the live holder's lock was taken");
  } finally {
    setLockLivenessForTests(null);
  }
});

// ---------------------------------------------------------------------------
// SIGTERM mid-append
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a SIGTERM while a process holds the lock mid-append releases it: the process still dies of the signal, the lockfile is gone", { skip: process.platform === "win32" }, async () => {
  const logPath = freshLog();
  const marker = `${logPath}.writing`;
  const script = join(scratch, `sigterm-${String(counter)}.mjs`);
  writeFileSync(
    script,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { appendWriteLayer, setAppendWriteLayerForTests } from ${JSON.stringify(WRITE_LAYER_MODULE)};`,
      `import { writeFileSync } from "node:fs";`,
      `const real = appendWriteLayer();`,
      `setAppendWriteLayerForTests({ ...real, write(fd, data) {`,
      `  writeFileSync(${JSON.stringify(marker)}, "x");`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);`,
      `  return real.write(fd, data);`,
      `} });`,
      `const result = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(8))});`,
      `writeFileSync(${JSON.stringify(`${logPath}.result`)}, JSON.stringify(result.ok));`,
      `setTimeout(() => {}, 3000);`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(() => existsSync(marker), 10_000);
  assert.ok(existsSync(`${logPath}.lock`), "the child holds the lock mid-append");
  child.kill("SIGTERM");
  const { signal } = await exited;
  assert.equal(signal, "SIGTERM", "the process died of the signal, as it would have");
  assert.equal(existsSync(`${logPath}.lock`), false, "and left no lockfile behind");
  assert.equal(readFileSync(`${logPath}.result`, "utf8"), "true", "the append it was in finished first");
  assert.deepEqual(
    records(logPath).map((record) => record.event),
    ["task.registered", "approval.granted"],
  );
  assert.equal(verify(logPath).status, "clean");
  const next = appendEvent(logPath, granted(9), { lockTimeoutMs: 100 });
  assert.ok(next.ok, "the next writer is not wedged");
});

// ---------------------------------------------------------------------------
// Writers racing to reclaim the same stale lock
// ---------------------------------------------------------------------------

test("writers racing to reclaim one stale lock: exactly one reclaims, every append lands, the chain verifies", async () => {
  const WRITERS = 6;
  const EACH = 3;
  const script = join(scratch, "racer.mjs");
  writeFileSync(
    script,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { existsSync } from "node:fs";`,
      `const [logPath, go, id] = process.argv.slice(2);`,
      `while (!existsSync(go)) { /* spin to the barrier */ }`,
      `let failed = 0;`,
      `for (let n = 0; n < ${String(EACH)}; n += 1) {`,
      `  const result = appendEvent(logPath, { ts: "2026-10-05T07:00:02Z", event: "approval.granted", actor: "human:carter", task: "task-479", action_key: "task-479:racer:" + id + ":" + n, channel: "cli" }, { lockTimeoutMs: 15000 });`,
      `  if (!result.ok) { failed += 1; console.error(JSON.stringify(result.error)); }`,
      `}`,
      `process.exit(failed === 0 ? 0 : 1);`,
    ].join("\n"),
  );
  for (let round = 1; round <= 3; round += 1) {
    const logPath = freshLog();
    writeLock(logPath, holder({ pid: deadPid() }));
    const go = `${logPath}.go`;
    const children = Array.from({ length: WRITERS }, (_, id) =>
      spawn(process.execPath, [script, logPath, go, String(id)], { stdio: ["ignore", "ignore", "pipe"] }),
    );
    const outcomes = children.map(
      (child) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.on("exit", (code) => resolve({ code, stderr }));
        }),
    );
    // Let every child reach the barrier, then release them at once.
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(go, "go");
    const results = await Promise.all(outcomes);
    for (const result of results) assert.equal(result.code, 0, `a racer failed: ${result.stderr}`);
    const log = records(logPath);
    assert.equal(
      log.filter((record) => record.event === "audit.lock_reclaimed").length,
      1,
      `round ${String(round)}: exactly one writer reclaimed`,
    );
    assert.equal(log.filter((record) => record.event === "approval.granted").length, WRITERS * EACH);
    // The reclaim record is the first write under the RECLAIMER's lock. A writer
    // whose own create won the instant after the stale lockfile was removed is
    // ordinary contention and may append before it; nothing appended before the
    // reclaim is under the stale lock.
    const reclaimAt = log.findIndex((record) => record.event === "audit.lock_reclaimed");
    assert.ok(reclaimAt >= 1, "the reclaim is recorded after the stale lock's last record");
    assert.equal(verify(logPath).status, "clean");
    assert.equal(existsSync(`${logPath}.lock`), false);
    assert.deepEqual(residue(logPath), []);
  }
});

// ---------------------------------------------------------------------------
// Fix round 1: B2 and S4, a boot reading that differs proves nothing
// ---------------------------------------------------------------------------

test("a running holder whose boot reading differs (a wall-clock step, or another kernel) keeps its lock", () => {
  const logPath = freshLog();
  const before = readFileSync(logPath);
  const self = selfIdentity();
  // macOS: the holder read its boot before a 700 s clock step (XNU moves
  // kern.boottime on every clock set). Linux: another kernel's boot id.
  const boot = self.linux
    ? "00000000-0000-4000-8000-000000000000"
    : `~${String(Number((self.boot ?? "~0").slice(1)) - 700)}`;
  writeLock(logPath, holder({ boot }));
  const lockBytes = readFileSync(`${logPath}.lock`);
  const result = appendEvent(logPath, granted(10), { lockTimeoutMs: 80, lockRetryMs: 5 });
  assert.equal(result.ok, false, "the live holder's lock was not taken");
  if (!result.ok) {
    assert.equal(result.error.code, "lock-timeout");
    assert.match(result.error.message, self.linux ? /another kernel/u : /is running/u);
  }
  assert.deepEqual(readFileSync(logPath), before);
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes);
  assert.deepEqual(residue(logPath), []);
  rmSync(`${logPath}.lock`);
});

// ---------------------------------------------------------------------------
// Fix round 1: S1, the record of a reclaim cannot be lost
// ---------------------------------------------------------------------------

test("a reclaim whose reclaimer never takes the lock is still recorded, by the next writer that does", () => {
  const logPath = freshLog();
  const pid = deadPid();
  writeLock(logPath, holder({ pid }));
  // The reclaim alone: this "reclaimer" never takes the lock afterwards.
  const outcome = tryReclaimLock(logPath);
  assert.equal(outcome.kind, "reclaimed");
  assert.equal(existsSync(`${logPath}.lock`), false);

  const other = appendEvent(logPath, granted(11));
  assert.ok(other.ok, other.ok ? "" : other.error.message);
  const log = records(logPath);
  assert.deepEqual(
    log.map((record) => record.event),
    ["task.registered", "audit.lock_reclaimed", "approval.granted"],
    "the next writer recorded the reclaim before its own record",
  );
  assert.equal((log[1]?.payload?.["holder"] as { pid?: number } | undefined)?.pid, pid);
  assert.deepEqual(residue(logPath), []);
  assert.equal(verify(logPath).status, "clean");
});

test("a try-once reclaimer whose create another writer wins gets lock-timeout, and the reclaim is recorded exactly once all the same", () => {
  const logPath = freshLog();
  const lockPath = `${logPath}.lock`;
  writeLock(logPath, holder({ pid: deadPid() }));
  // Another writer wins the create the instant the stale lock is gone, and holds
  // past this writer's deadline (a try-once caller has none).
  setReclaimSeamForTests((step) => {
    if (step === "after-commit") writeLock(logPath, holder());
  });
  let lost;
  try {
    lost = appendEvent(logPath, granted(12), { lockTimeoutMs: 0 });
  } finally {
    setReclaimSeamForTests(null);
  }
  assert.equal(lost.ok, false);
  if (!lost.ok) assert.equal(lost.error.code, "lock-timeout");
  assert.deepEqual(
    records(logPath).map((record) => record.event),
    ["task.registered"],
  );
  // That other writer finishes; the next append records the reclaim first.
  rmSync(lockPath);
  const next = appendEvent(logPath, granted(13));
  assert.ok(next.ok);
  const again = appendEvent(logPath, granted(14));
  assert.ok(again.ok);
  assert.deepEqual(
    records(logPath).map((record) => record.event),
    ["task.registered", "audit.lock_reclaimed", "approval.granted", "approval.granted"],
  );
  assert.deepEqual(residue(logPath), []);
  assert.equal(verify(logPath).status, "clean");
});

// ---------------------------------------------------------------------------
// Fix round 1: B3, exactly one reclaimer, judged by liveness and never by age
// ---------------------------------------------------------------------------

/**
 * A reclaimer in its own process, stopped at `step` until the test says go (a
 * SIGSTOP, a VM pause, a laptop asleep): it writes `<marker>.at` when it stops
 * there and `<marker>.out` with its outcome when it finishes.
 */
function stalledReclaimer(logPath: string, step: string, marker: string): ReturnType<typeof spawn> {
  const script = `${marker}.mjs`;
  writeFileSync(
    script,
    [
      `import { setReclaimSeamForTests, tryReclaimLock } from ${JSON.stringify(LOCK_MODULE)};`,
      `import { existsSync, writeFileSync } from "node:fs";`,
      `setReclaimSeamForTests((step) => {`,
      `  if (step !== ${JSON.stringify(step)}) return;`,
      `  writeFileSync(${JSON.stringify(`${marker}.at`)}, step);`,
      `  while (!existsSync(${JSON.stringify(`${marker}.go`)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);`,
      `});`,
      `const outcome = tryReclaimLock(${JSON.stringify(logPath)});`,
      `writeFileSync(${JSON.stringify(`${marker}.out`)}, JSON.stringify(outcome));`,
    ].join("\n"),
  );
  return spawn(process.execPath, [script], { stdio: "ignore" });
}

function exitOf(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

for (const step of ["claimed", "before-commit"] as const) {
  test(`a reclaimer stalled at '${step}' keeps its claim against a writer whose clock reads an hour later; it then finishes, and the chain verifies`, async () => {
    const logPath = freshLog();
    const lockPath = `${logPath}.lock`;
    writeLock(logPath, holder({ pid: deadPid() }));
    const stale = readFileSync(lockPath);
    const marker = join(scratch, `stalled-${step}-${String(counter)}`);
    const r1 = stalledReclaimer(logPath, step, marker);
    const r1Exit = exitOf(r1);
    try {
      await waitFor(() => existsSync(`${marker}.at`), 10_000);
      // An hour later by this writer's clock (a long stall, or a filesystem
      // clock far behind): the live claimant still holds its claim.
      const r2 = tryReclaimLock(logPath, Date.now() + 3_600_000);
      assert.equal(r2.kind, "kept");
      if (r2.kind === "kept") assert.match(r2.why, /another writer is reclaiming it now/u);
      const w = appendEvent(logPath, granted(20), { lockTimeoutMs: 100, lockRetryMs: 5 });
      assert.equal(w.ok, false);
      if (!w.ok) assert.equal(w.error.code, "lock-timeout");
      assert.deepEqual(readFileSync(lockPath), stale, "nothing touched the lock while R1 was stalled");
    } finally {
      writeFileSync(`${marker}.go`, "go");
    }
    assert.equal((await r1Exit).code, 0);
    assert.equal((JSON.parse(readFileSync(`${marker}.out`, "utf8")) as { kind: string }).kind, "reclaimed");
    const after = appendEvent(logPath, granted(21));
    assert.ok(after.ok);
    const log = records(logPath);
    assert.deepEqual(
      log.map((record) => record.event),
      ["task.registered", "audit.lock_reclaimed", "approval.granted"],
    );
    assert.deepEqual(residue(logPath), []);
    assert.equal(verify(logPath).status, "clean");
  });

  test(`a reclaimer killed at '${step}' is succeeded by exactly one reclaimer; what it left is excluded from the export`, async () => {
    const logPath = freshLog();
    writeLock(logPath, holder({ pid: deadPid() }));
    const marker = join(scratch, `killed-${step}-${String(counter)}`);
    const r1 = stalledReclaimer(logPath, step, marker);
    const r1Exit = exitOf(r1);
    await waitFor(() => existsSync(`${marker}.at`), 10_000);
    r1.kill("SIGKILL");
    assert.equal((await r1Exit).signal, "SIGKILL");

    const results = [
      appendEvent(logPath, granted(22), { lockTimeoutMs: 500, lockRetryMs: 5 }),
      appendEvent(logPath, granted(23), { lockTimeoutMs: 500, lockRetryMs: 5 }),
    ];
    for (const result of results) assert.ok(result.ok, result.ok ? "" : result.error.message);
    const log = records(logPath);
    assert.equal(log.filter((record) => record.event === "audit.lock_reclaimed").length, 1);
    assert.equal(log.filter((record) => record.event === "approval.granted").length, 2);
    assert.equal(verify(logPath).status, "clean");
    // The dead claimant's claim stays (nothing ever removes another's claim);
    // it is the lock's bookkeeping and never leaves in a tenant export.
    const left = residue(logPath);
    assert.ok(left.length >= 1 && left.every((name) => name.startsWith("claims/") && name.endsWith(".claim-0.lock")), left.join(", "));
    for (const name of left) {
      assert.equal(isExcludedPath(`.approval/log/events.jsonl.lock.d/${name}`, ".approval/log/events.jsonl.lock"), true, name);
    }
  });
}

// ---------------------------------------------------------------------------
// Fix round 1: N2, a lockfile that changes hands at the worst moment survives
// ---------------------------------------------------------------------------

test("a lockfile rewritten in place (same inode, a new holder) after the claim is left alone, and nothing is recorded", () => {
  const logPath = freshLog();
  const lockPath = `${logPath}.lock`;
  writeLock(logPath, holder({ pid: deadPid() }));
  const ino = statSync(lockPath, { bigint: true }).ino;
  const fresh = `${JSON.stringify(holder({ created: new Date().toISOString() }))}\n`;
  setReclaimSeamForTests((step) => {
    if (step === "claimed") writeFileSync(lockPath, fresh);
  });
  let outcome;
  try {
    outcome = tryReclaimLock(logPath);
  } finally {
    setReclaimSeamForTests(null);
  }
  assert.equal(statSync(lockPath, { bigint: true }).ino, ino, "the same inode, as the case requires");
  assert.equal(outcome.kind, "kept");
  assert.equal(readFileSync(lockPath, "utf8"), fresh, "the new holder's lock is where it was");
  assert.deepEqual(residue(logPath), [], "no claim, no pending record, nothing aside");
  rmSync(lockPath);
  assert.ok(appendEvent(logPath, granted(30)).ok);
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "approval.granted"]);
});

test("a lockfile replaced (a new inode) between the last check and the rename is put back, and nothing is left at a pending name", () => {
  const logPath = freshLog();
  const lockPath = `${logPath}.lock`;
  writeLock(logPath, holder({ pid: deadPid() }));
  const fresh = `${JSON.stringify(holder({ created: new Date().toISOString() }))}\n`;
  // After the last re-check and before the rename: only an actor outside the
  // protocol (a human rm, an older version's unconditional release) is here.
  setReclaimSeamForTests((step) => {
    if (step === "at-commit") {
      rmSync(lockPath);
      writeFileSync(lockPath, fresh);
    }
  });
  let outcome;
  try {
    outcome = tryReclaimLock(logPath);
  } finally {
    setReclaimSeamForTests(null);
  }
  assert.equal(outcome.kind, "kept");
  if (outcome.kind === "kept") assert.match(outcome.why, /was put back/u);
  assert.equal(readFileSync(lockPath, "utf8"), fresh, "the new holder's lock is back at the path");
  assert.deepEqual(residue(logPath), []);
  rmSync(lockPath);
  assert.ok(appendEvent(logPath, granted(31)).ok);
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "approval.granted"]);
});

// ---------------------------------------------------------------------------
// Fix round 1: N3, the reclaim's files never leave in an export
// ---------------------------------------------------------------------------

test("the export excludes every file named from the lockfile, and nothing else that merely ends in .lock", () => {
  const lock = ".approval/log/events.jsonl.lock";
  for (const name of [
    "events.jsonl.lock",
    "events.jsonl.lock.d",
    "events.jsonl.lock.d/claims/12-abcdef012345.claim-0.lock",
    "events.jsonl.lock.d/claims/12-abcdef012345.0011223344556677.tmp.lock",
    "events.jsonl.lock.d/pending/000001791180356-12-abcdef012345-0011223344556677.lock",
    "events.jsonl.lock.d/quarantine/3f9a0c1d5e7b2468-0a1b2c3d.lock",
  ]) {
    assert.equal(isExcludedPath(`.approval/log/${name}`, lock), true, name);
  }
  assert.equal(isExcludedPath(".approval/payloads/x.lock", lock), false);
  assert.equal(isExcludedPath(".approval/log/events.jsonl.locked", lock), false);
  assert.equal(isExcludedPath(".approval/log/events.jsonl", lock), false);
});

// ---------------------------------------------------------------------------
// Fix round 1: S2, a verb that waits after its append answers Ctrl-C at once
// ---------------------------------------------------------------------------

function policyText(body: string[]): string {
  return ["# Policy", "", "```yaml approval-policy", ...body, "```", ""].join("\n");
}

const WITH_CHANNEL = (resolution: "autonomous" | "supervised"): string =>
  policyText([
    'version: "0.1"',
    "defaults:",
    "  autonomy: supervised",
    "  approval_ttl: 24h",
    "approvers:",
    "  carter:",
    "    channels: [telegram]",
    "channels:",
    "  telegram:",
    "    token_env: TELEGRAM_TOKEN",
    "    chat_id_env: TELEGRAM_CHAT",
    "classes:",
    "  read.*:",
    `    autonomy: ${resolution}`,
  ]);

test("`approval policy amend` waiting on its prompt dies of SIGINT at once, not when its wait ends", { skip: process.platform === "win32" }, async () => {
  counter += 1;
  const dir = join(scratch, `amend-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), WITH_CHANNEL("autonomous"));
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  for (const args of [
    ["init", "-q", "."],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
    ["add", "-A"],
    ["commit", "-qm", "policy"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: dir }).status, 0, `git ${args.join(" ")}`);
  }
  const attest = spawnSync(process.execPath, [CLI_ENTRY, "policy", "attest", "--as", "human:carter"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(attest.status, 0, attest.stderr);
  writeFileSync(join(dir, "APPROVAL.md"), WITH_CHANNEL("supervised"));

  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "policy", "amend", "--as", "agent:planner", "--wait", "12s", "--interval", "200ms", "--json"],
    { cwd: dir, env, stdio: "ignore" },
  );
  const exited = exitOf(child);
  // The proposal is appended, so the verb is in its synchronous poll.
  await waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes('"policy.proposed"'), 15_000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const sentAt = Date.now();
  child.kill("SIGINT");
  const { signal } = await exited;
  const elapsed = Date.now() - sentAt;
  assert.equal(signal, "SIGINT", "the process died of the signal");
  assert.ok(elapsed < 4_000, `it died ${String(elapsed)} ms after the signal; before fix round 1 it was held until the 12 s wait ended`);
  assert.equal(existsSync(`${logPath}.lock`), false, "and left no lockfile");
});

// ---------------------------------------------------------------------------
// Fix round 1: B1 and S3 on real Linux, in a disposable privileged container
// ---------------------------------------------------------------------------

/**
 * These remount `/proc` or unshare a pid namespace, which only root in a
 * throwaway container should do. They run when APPROVAL_LOCK_TEST_PRIVILEGED=1
 * on Linux as root, and are skipped (saying why) everywhere else, CI included:
 * the decision-table rows above pin the same judgements on every platform.
 */
const PRIVILEGED =
  LINUX && process.env["APPROVAL_LOCK_TEST_PRIVILEGED"] === "1" && typeof process.getuid === "function" && process.getuid() === 0
    ? false
    : "needs Linux, root, and APPROVAL_LOCK_TEST_PRIVILEGED=1 in a disposable container (it remounts /proc or unshares a pid namespace)";

/** A holder child (as `uid`, when given) that stalls 2.5 s inside its append, holding the lock. */
function holderScript(logPath: string, marker: string): string {
  const script = `${marker}.holder.mjs`;
  writeFileSync(
    script,
    [
      `process.umask(0);`,
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { appendWriteLayer, setAppendWriteLayerForTests } from ${JSON.stringify(WRITE_LAYER_MODULE)};`,
      `import { writeFileSync } from "node:fs";`,
      `const real = appendWriteLayer();`,
      `setAppendWriteLayerForTests({ ...real, write(fd, data) {`,
      `  writeFileSync(${JSON.stringify(`${marker}.writing`)}, "x");`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);`,
      `  return real.write(fd, data);`,
      `} });`,
      `const result = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(40))});`,
      `writeFileSync(${JSON.stringify(`${marker}.holder-result`)}, JSON.stringify(result.ok));`,
    ].join("\n"),
  );
  chmodSync(script, 0o644);
  return script;
}

function readerScript(logPath: string, marker: string): string {
  const script = `${marker}.reader.mjs`;
  writeFileSync(
    script,
    [
      `process.umask(0);`,
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { writeFileSync } from "node:fs";`,
      `const result = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(41))}, { lockTimeoutMs: 400, lockRetryMs: 5 });`,
      `writeFileSync(${JSON.stringify(`${marker}.reader-result`)}, JSON.stringify(result.ok ? { ok: true } : { ok: false, code: result.error.code, message: result.error.message }));`,
    ].join("\n"),
  );
  chmodSync(script, 0o644);
  return script;
}

function sharedLog(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `approval-md-lock-${name}-`));
  chmodSync(dir, 0o777);
  mkdirSync(join(dir, "log"), { mode: 0o777 });
  chmodSync(join(dir, "log"), 0o777);
  const logPath = join(dir, "log", "events.jsonl");
  const previous = process.umask(0);
  try {
    assert.ok(appendEvent(logPath, REGISTERED).ok);
  } finally {
    process.umask(previous);
  }
  return logPath;
}

test("B1: under hidepid, a reader of another uid finds a live holder's lock held (lock-timeout), never reclaims it", { skip: PRIVILEGED }, async () => {
  const remount = spawnSync("mount", ["-o", "remount,hidepid=invisible", "/proc"], { encoding: "utf8" });
  assert.equal(remount.status, 0, `remount /proc hidepid=invisible: ${remount.stderr}`);
  try {
    const logPath = sharedLog("hidepid");
    const marker = join(dirname(dirname(logPath)), "m");
    const holderChild = spawn(process.execPath, [holderScript(logPath, marker)], { uid: 1000, gid: 1000, stdio: "ignore" });
    const holderExit = exitOf(holderChild);
    await waitFor(() => existsSync(`${marker}.writing`), 10_000);
    const reader = spawnSync(process.execPath, [readerScript(logPath, marker)], { uid: 65534, gid: 65534 });
    assert.equal(reader.status, 0);
    const result = JSON.parse(readFileSync(`${marker}.reader-result`, "utf8")) as { ok: boolean; code?: string; message?: string };
    assert.equal(result.ok, false, "the reader did not take the live holder's lock");
    assert.equal(result.code, "lock-timeout");
    assert.match(result.message ?? "", /\/proc hides it from this process, but kill\(pid, 0\) finds it/u);
    assert.equal((await holderExit).code, 0);
    assert.equal(readFileSync(`${marker}.holder-result`, "utf8"), "true");
    assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "approval.granted"]);
    assert.equal(verify(logPath).status, "clean");
  } finally {
    const restore = spawnSync("mount", ["-o", "remount,hidepid=0", "/proc"], { encoding: "utf8" });
    if (restore.status !== 0) spawnSync("mount", ["-o", "remount,hidepid=off", "/proc"]);
  }
});

test("S3: in a pid namespace whose /proc was not remounted, a reader keeps a live holder's lock (lock-timeout), never reclaims it", { skip: PRIVILEGED }, () => {
  const logPath = sharedLog("pidns");
  const marker = join(dirname(dirname(logPath)), "m");
  const holder = holderScript(logPath, marker);
  const reader = readerScript(logPath, marker);
  const driver = `${marker}.driver.mjs`;
  writeFileSync(
    driver,
    [
      `import { spawn, spawnSync } from "node:child_process";`,
      `import { existsSync, readlinkSync } from "node:fs";`,
      `const ownProc = readlinkSync("/proc/self") === String(process.pid);`,
      // Burn pids first, so the holder's pid in this namespace names an exited
      // process in the outer /proc that both it and the reader read: before
      // fix round 1 the reader then judged the live holder dead.
      `for (let n = 0; n < 64; n += 1) spawnSync("true");`,
      `const h = spawn(process.execPath, [${JSON.stringify(holder)}], { stdio: "ignore" });`,
      `const done = new Promise((resolve) => h.on("exit", resolve));`,
      `while (!existsSync(${JSON.stringify(`${marker}.writing`)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
      `spawnSync(process.execPath, [${JSON.stringify(reader)}]);`,
      `await done;`,
      `console.log(JSON.stringify({ pid: process.pid, ownProc }));`,
    ].join("\n"),
  );
  const run = spawnSync("unshare", ["--pid", "--fork", process.execPath, driver], { encoding: "utf8" });
  assert.equal(run.status, 0, `unshare: ${run.stderr}`);
  const inside = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as { pid?: number; ownProc?: boolean };
  assert.equal(inside.ownProc, false, "the case requires a /proc from another pid namespace");
  const result = JSON.parse(readFileSync(`${marker}.reader-result`, "utf8")) as { ok: boolean; code?: string; message?: string };
  assert.equal(result.ok, false);
  assert.equal(result.code, "lock-timeout");
  assert.match(result.message ?? "", /\/proc belongs to another pid namespace/u);
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "approval.granted"]);
  assert.equal(verify(logPath).status, "clean");
});

// ---------------------------------------------------------------------------
// Security review of fix round 1: files beside the lock are written by anyone
// who can write the log's directory, so nothing in them is taken on trust
// ---------------------------------------------------------------------------

/** Plant `content` under `<log>.lock.d/pending/` (as anyone who can write the log directory can). */
function plantPending(logPath: string, name: string, content: string | null): string {
  const dir = join(`${logPath}.lock.d`, "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (content === null) mkdirSync(path);
  else writeFileSync(path, content);
  return path;
}

test("a hostile pending file costs one truthful 'unverified' record with nothing taken from it, and cannot block, silence or forge", () => {
  const logPath = freshLog();
  const pending = (n: number): string => `${String(n).padStart(15, "0")}-1-aaaaaaaaaaaa-${String(n).padStart(16, "0")}.lock`;
  // The round-1 note shape, with chosen fields.
  plantPending(logPath, pending(1), `${JSON.stringify({ v: 1, kind: "reclaim-pending", note: { lockfile: "../../etc/passwd", reason: "holder-dead", age_ms: -5, holder: { pid: 1, op: "append", created: "\u001b[31mforged" } } })}\n`);
  // A live holder (this process).
  plantPending(logPath, pending(2), `${JSON.stringify(holder())}\n`);
  // A `created` with a newline and an escape, and a calendar-impossible one.
  plantPending(logPath, pending(3), `${JSON.stringify(holder({ pid: deadPid(), created: "2026-10-05T07:00:00.000Z\n\u001b[2J" }))}\n`);
  plantPending(logPath, pending(4), `${JSON.stringify(holder({ pid: deadPid(), created: "2026-02-30T00:00:00.000Z" }))}\n`);
  // A newer format naming an event and an actor; a directory; an empty file.
  plantPending(logPath, pending(5), `${JSON.stringify({ v: 2, pid: deadPid(), event: "approval.granted", actor: "human:carter" })}\n`);
  plantPending(logPath, pending(6), null);
  plantPending(logPath, pending(7), "");
  const result = appendEvent(logPath, granted(50));
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const log = records(logPath);
  assert.deepEqual(
    log.map((record) => record.event),
    ["task.registered", ...Array.from({ length: 7 }, () => "audit.lock_reclaimed"), "approval.granted"],
    "every pending file is recorded, before the caller's record",
  );
  for (const record of log.filter((entry) => entry.event === "audit.lock_reclaimed")) {
    assert.equal(record.actor, "system:log");
    assert.deepEqual(Object.keys(record.payload ?? {}).sort(), ["lockfile", "reason", "reclaim_id"]);
    assert.equal(record.payload?.["reason"], "unverified");
    assert.equal(record.payload?.["lockfile"], "events.jsonl.lock");
    assert.match(String(record.payload?.["reclaim_id"]), /^[0-9a-f]{16}$/u);
  }
  // Nothing stays in pending/; each is in quarantine/, named by its record's id.
  const left = residue(logPath);
  assert.equal(left.filter((name) => name.startsWith("pending/")).length, 0);
  const quarantined = left.filter((name) => name.startsWith("quarantine/"));
  assert.equal(quarantined.length, 7);
  for (const record of log.filter((entry) => entry.event === "audit.lock_reclaimed")) {
    assert.ok(quarantined.some((name) => name.startsWith(`quarantine/${String(record.payload?.["reclaim_id"])}-`)));
  }
  // The next writer is not blocked and records nothing more.
  assert.ok(appendEvent(logPath, granted(51)).ok);
  assert.equal(records(logPath).filter((record) => record.event === "audit.lock_reclaimed").length, 7);
  assert.equal(verify(logPath).status, "clean");
});

test("a dead holder's lockfile planted as pending is recorded as what it is, and a flood is bounded per hold, oldest first", () => {
  const logPath = freshLog();
  const pid = deadPid();
  const forged = holder({ pid, nonce: "x".repeat(1000) });
  for (let n = 0; n < 40; n += 1) {
    plantPending(logPath, `${String(1000 + n).padStart(15, "0")}-1-bbbbbbbbbbbb-${String(n).padStart(16, "0")}.lock`, `${JSON.stringify({ ...forged, extra: "field" })}\n`);
  }
  const first = appendEvent(logPath, granted(52));
  assert.ok(first.ok);
  const reclaims = records(logPath).filter((record) => record.event === "audit.lock_reclaimed");
  assert.equal(reclaims.length, 16, "at most sixteen pending reclaims are recorded per hold");
  for (const record of reclaims) {
    assert.deepEqual(Object.keys(record.payload ?? {}).sort(), ["age_ms", "holder", "lockfile", "reason", "reclaim_id"]);
    assert.equal(record.payload?.["lockfile"], "events.jsonl.lock", "the writer's own lockfile name, never the file's");
    assert.deepEqual(record.payload?.["holder"], { pid, op: "append", created: forged.created });
    assert.equal(record.payload?.["reason"], "holder-dead");
  }
  // Oldest first: the sixteen recorded were the sixteen earliest names.
  const left = residue(logPath).filter((name) => name.startsWith("pending/"));
  assert.equal(left.length, 24);
  assert.ok(left.every((name) => Number(name.slice("pending/".length, "pending/".length + 15)) >= 1016), left.join(", "));
  assert.ok(appendEvent(logPath, granted(53)).ok);
  assert.ok(appendEvent(logPath, granted(54)).ok);
  assert.equal(records(logPath).filter((record) => record.event === "audit.lock_reclaimed").length, 40);
  assert.equal(residue(logPath).filter((name) => name.startsWith("pending/")).length, 0);
  assert.equal(verify(logPath).status, "clean");
});

test("a hostile lockfile cannot put control characters or its own text into a refusal", () => {
  const logPath = freshLog();
  // A live holder (this process) whose host carries escapes and a newline.
  writeLock(logPath, holder({ host: "\u001b]0;pwned\u0007\nFORGED LINE" }));
  const live = appendEvent(logPath, granted(52), { lockTimeoutMs: 0 });
  assert.equal(live.ok, false);
  if (!live.ok) {
    assert.equal(live.error.code, "lock-timeout");
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(live.error.message, /[\u0000-\u001f\u007f]/u);
  }
  // A `created` that is not a timestamp, or a version that is a wall of text:
  // the record is unreadable, so the lock is kept, and none of it is echoed.
  writeLock(logPath, holder({ pid: deadPid(), created: "2026-10-05T07:00:00.000Z\nFORGED" }));
  const created = appendEvent(logPath, granted(53), { lockTimeoutMs: 0 });
  assert.equal(created.ok, false);
  if (!created.ok) assert.doesNotMatch(created.error.message, /FORGED/u);
  writeLock(logPath, `${JSON.stringify({ v: "X".repeat(5000) })}\n`);
  const version = appendEvent(logPath, granted(54), { lockTimeoutMs: 0 });
  assert.equal(version.ok, false);
  if (!version.ok) assert.doesNotMatch(version.error.message, /XXXX/u);
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered"]);
  rmSync(`${logPath}.lock`);
});

// ---------------------------------------------------------------------------
// Fix round 2: RB1, nothing under the log directory can hang a writer
// ---------------------------------------------------------------------------

/** Run one append in a child process; resolve with how it ended, or "hung" after `ms`. */
async function appendInChild(logPath: string, n: number, ms: number, lockTimeoutMs = 300): Promise<string> {
  counter += 1;
  const script = join(scratch, `child-append-${String(counter)}.mjs`);
  writeFileSync(
    script,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `const r = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(n))}, { lockTimeoutMs: ${String(lockTimeoutMs)} });`,
      `process.stdout.write(r.ok ? "ok" : r.error.code);`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  const ended = await Promise.race([
    exitOf(child).then(() => out),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
  if (ended === "hung") child.kill("SIGKILL");
  return ended;
}

test("a FIFO at a pending name is recorded as unverified and quarantined; the writer never hangs", { skip: process.platform === "win32" }, async () => {
  const logPath = freshLog();
  const fifo = join(`${logPath}.lock.d`, "pending", "000000000000001-1-cccccccccccc-0000000000000001.lock");
  mkdirSync(dirname(fifo), { recursive: true });
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.equal(await appendInChild(logPath, 60, 8_000), "ok");
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  assert.equal(records(logPath)[1]?.payload?.["reason"], "unverified");
  assert.equal(existsSync(fifo), false);
  assert.equal(existsSync(`${logPath}.lock`), false);
});

test("a FIFO or a symbolic link at the lock path is kept as unjudgeable: the writer times out, never hangs, never follows it", { skip: process.platform === "win32" }, async () => {
  const logPath = freshLog();
  const lockPath = `${logPath}.lock`;
  assert.equal(spawnSync("mkfifo", [lockPath]).status, 0);
  assert.equal(await appendInChild(logPath, 61, 8_000), "lock-timeout");
  assert.match(describeLogLock(logPath) ?? "", /does not read \(not a regular file\)/u);
  rmSync(lockPath);
  // A link to a dead holder's lockfile elsewhere: not followed, not reclaimed.
  const target = join(scratch, `elsewhere-${String(counter)}.lock`);
  writeFileSync(target, `${JSON.stringify(holder({ pid: deadPid() }))}\n`);
  symlinkSync(target, lockPath);
  assert.equal(await appendInChild(logPath, 62, 8_000), "lock-timeout");
  assert.ok(existsSync(target), "the link's target is untouched");
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered"]);
  rmSync(lockPath);
});

// ---------------------------------------------------------------------------
// Fix round 2: RB2, a record that could not be appended is never committed
// ---------------------------------------------------------------------------

test("a lockfile whose `created` is calendar-impossible is kept as unreadable, so no writer is ever refused for good", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid(), created: "2026-02-30T00:00:00.000Z" }));
  for (let n = 0; n < 3; n += 1) {
    const result = appendEvent(logPath, granted(70 + n), { lockTimeoutMs: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "lock-timeout", "kept, never a validation refusal");
  }
  assert.equal(existsSync(`${logPath}.lock`), true);
  assert.deepEqual(residue(logPath), []);
  rmSync(`${logPath}.lock`);
  // The control: a real, odd instant still records.
  writeLock(logPath, holder({ pid: deadPid(), created: "0000-01-01T00:00:00.000Z" }));
  assert.ok(appendEvent(logPath, granted(73)).ok);
  assert.equal(records(logPath).filter((record) => record.event === "audit.lock_reclaimed").length, 1);
  assert.equal(verify(logPath).status, "clean");
});

// ---------------------------------------------------------------------------
// Fix round 2: RB3, a committed reclaim is always recorded first
// ---------------------------------------------------------------------------

test("a committed reclaim the next writer cannot judge (it now reads the holder as live) is recorded as unverified before that writer's record", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  assert.equal(tryReclaimLock(logPath).kind, "reclaimed");
  // The next writer sees the holder as another container's would: live.
  setLockLivenessForTests(() => ({ state: "live", why: "in another pid namespace" }));
  try {
    assert.ok(appendEvent(logPath, granted(80)).ok);
  } finally {
    setLockLivenessForTests(null);
  }
  const log = records(logPath);
  assert.deepEqual(log.map((record) => record.event), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  assert.equal(log[1]?.payload?.["reason"], "unverified");
  assert.deepEqual(residue(logPath).filter((name) => !name.startsWith("quarantine/")), []);
  assert.equal(verify(logPath).status, "clean");
});

const ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("a log directory that cannot be listed (mode 0333) no longer hides a reclaim: it is recorded first", { skip: process.platform === "win32" || ROOT ? "needs a non-root POSIX user (permissions)" : false }, () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  const dir = dirname(logPath);
  chmodSync(dir, 0o333);
  let result;
  try {
    result = appendEvent(logPath, granted(81), { lockTimeoutMs: 500 });
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  assert.equal(verify(logPath).status, "clean");
});

test("a pending directory that cannot be listed refuses the append (reclaim-pending-unreadable); once it can, the reclaim is recorded first", { skip: process.platform === "win32" || ROOT ? "needs a non-root POSIX user (permissions)" : false }, () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  assert.equal(tryReclaimLock(logPath).kind, "reclaimed");
  const pendingDir = join(`${logPath}.lock.d`, "pending");
  chmodSync(pendingDir, 0o333);
  let refused;
  try {
    refused = appendEvent(logPath, granted(82), { lockTimeoutMs: 500 });
  } finally {
    chmodSync(pendingDir, 0o755);
  }
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "reclaim-pending-unreadable");
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered"], "nothing was appended");
  assert.ok(appendEvent(logPath, granted(83)).ok);
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
});

test("a writer killed between recording a pending reclaim and moving it out leaves no duplicate", { skip: process.platform === "win32" }, async () => {
  const logPath = freshLog();
  const pid = deadPid();
  writeLock(logPath, holder({ pid }));
  counter += 1;
  const script = join(scratch, `dup-${String(counter)}.mjs`);
  writeFileSync(
    script,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { appendWriteLayer, setAppendWriteLayerForTests } from ${JSON.stringify(WRITE_LAYER_MODULE)};`,
      `const real = appendWriteLayer(); let n = 0;`,
      `setAppendWriteLayerForTests({ ...real, fsync(fd) { real.fsync(fd); n += 1; if (n === 1) process.kill(process.pid, "SIGKILL"); } });`,
      `appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(84))});`,
    ].join("\n"),
  );
  const killed = spawnSync(process.execPath, [script]);
  assert.equal(killed.signal, "SIGKILL");
  assert.ok(appendEvent(logPath, granted(85), { lockTimeoutMs: 500 }).ok);
  const reclaims = records(logPath).filter((record) => record.event === "audit.lock_reclaimed");
  const forDead = reclaims.filter((record) => (record.payload?.["holder"] as { pid?: number } | undefined)?.pid === pid);
  assert.equal(forDead.length, 1, "the dead holder's reclaim is recorded once");
  assert.equal(reclaims.length, 2, "and the killed writer's own lock once");
  assert.deepEqual(residue(logPath).filter((name) => name.startsWith("pending/")), []);
  assert.equal(verify(logPath).status, "clean");
});

// ---------------------------------------------------------------------------
// Fix round 2: RS5, a claimant that sees a next-generation claim backs off
// ---------------------------------------------------------------------------

test("a claimant that finds a next-generation claim beside its own (it was judged gone) backs off and touches nothing", () => {
  const logPath = freshLog();
  const lockPath = `${logPath}.lock`;
  writeLock(logPath, holder({ pid: deadPid() }));
  const stale = readFileSync(lockPath);
  const claims = join(`${logPath}.lock.d`, "claims");
  setReclaimSeamForTests((step) => {
    if (step !== "claimed") return;
    const own = readdirSync(claims).find((name) => name.endsWith(".claim-0.lock"));
    assert.ok(own !== undefined);
    writeFileSync(join(claims, own.replace(".claim-0.lock", ".claim-1.lock")), "{}\n");
  });
  let outcome;
  try {
    outcome = tryReclaimLock(logPath);
  } finally {
    setReclaimSeamForTests(null);
  }
  assert.equal(outcome.kind, "kept");
  assert.deepEqual(readFileSync(lockPath), stale, "the lock is where it was");
  assert.deepEqual(residue(logPath).filter((name) => name.startsWith("pending/")), []);
  rmSync(lockPath);
});

// ---------------------------------------------------------------------------
// Fix round 2: RS1, a stop request is never followed by the work starting
// ---------------------------------------------------------------------------

test("a SIGTERM that lands during a reclaim kills the writer there: nothing is appended after it", { skip: process.platform === "win32" }, async () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  counter += 1;
  const marker = join(scratch, `reclaim-signal-${String(counter)}`);
  writeFileSync(
    `${marker}.mjs`,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { setReclaimSeamForTests } from ${JSON.stringify(LOCK_MODULE)};`,
      `import { writeFileSync } from "node:fs";`,
      `setReclaimSeamForTests((step) => { if (step === "claimed") { writeFileSync(${JSON.stringify(`${marker}.at`)}, "x"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); } });`,
      `appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(90))}, { lockTimeoutMs: 2000 });`,
      `setTimeout(() => {}, 2000);`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [`${marker}.mjs`], { stdio: "ignore" });
  const exited = exitOf(child);
  await waitFor(() => existsSync(`${marker}.at`), 10_000);
  child.kill("SIGTERM");
  assert.equal((await exited).signal, "SIGTERM");
  assert.deepEqual(records(logPath).map((record) => record.event), ["task.registered"], "nothing was appended after the stop request");
  // The reclaim it abandoned before its commit is the next writer's.
  assert.ok(appendEvent(logPath, granted(91), { lockTimeoutMs: 500 }).ok);
  assert.equal(verify(logPath).status, "clean");
});

const RUN_POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "classes:",
  "  files.write.*:",
  "    autonomy: supervised",
  "```",
  "",
].join("\n");

function runTaskFile(binding: string): string {
  return [
    "---",
    "id: task-479",
    "title: Write a file",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: example-capture",
    '    created_by: "human:carter"',
    "  state: proposed",
    "  actions:",
    "    - class: files.write.local",
    '      summary: "Write the marker"',
    "      reversible: true",
    '      est_cost_usd: "0.01"',
    '      idempotency_key: "task-479:write"',
    `      payload_hash: "${binding}"`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

test("`approval run`: a SIGTERM during the execution.started append ends the process before the command starts", { skip: process.platform === "win32" }, async () => {
  counter += 1;
  mkdirSync(join(scratch, `run-${String(counter)}`), { recursive: true });
  // The real path: `run` binds the payload to the cwd it will spawn in.
  const dir = realpathSync(join(scratch, `run-${String(counter)}`));
  const ran = join(dir, "the-command-ran");
  const command = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ran)}, "x")`];
  writeFileSync(join(dir, "APPROVAL.md"), RUN_POLICY);
  writeFileSync(join(dir, "task-479.md"), runTaskFile(runPayloadHash(command, dir)));
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const cli = (args: string[]): number | null => spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd: dir, env }).status;
  assert.equal(cli(["policy", "attest", "--as", "human:carter"]), 0);
  assert.equal(cli(["register", "task-479.md", "--as", "agent:claude"]), 0);
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const marker = join(dir, "writing");
  const wrapper = join(scratch, `run-wrapper-${String(counter)}.mjs`);
  writeFileSync(
    wrapper,
    [
      `import { appendWriteLayer, setAppendWriteLayerForTests } from ${JSON.stringify(WRITE_LAYER_MODULE)};`,
      `import { writeFileSync } from "node:fs";`,
      `const real = appendWriteLayer();`,
      `setAppendWriteLayerForTests({ ...real, write(fd, data) {`,
      `  if (Buffer.from(data).toString("utf8").includes('"execution.started"')) {`,
      `    writeFileSync(${JSON.stringify(marker)}, "x");`,
      `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);`,
      `  }`,
      `  return real.write(fd, data);`,
      `} });`,
      `const { main } = await import(${JSON.stringify(pathToFileURL(CLI_ENTRY).href)});`,
      `process.exitCode = await main(${JSON.stringify(["run", "task-479:write", "--as", "agent:claude", "--no-sandbox", "--", ...command])});`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [wrapper], { cwd: dir, env, stdio: "ignore" });
  const exited = exitOf(child);
  await waitFor(() => existsSync(marker), 15_000);
  child.kill("SIGTERM");
  const { signal } = await exited;
  assert.equal(signal, "SIGTERM", "the process died of the signal");
  assert.equal(existsSync(ran), false, "the command never started");
  const events = records(logPath).map((record) => record.event);
  assert.equal(events.at(-1), "execution.started", "the append it was in finished, and nothing ran after it");
  assert.equal(existsSync(`${logPath}.lock`), false);
});

test("RB3: a reclaim committed in one pid namespace is recorded by a writer in another before its own records (two containers, one volume)", { skip: PRIVILEGED }, () => {
  const logPath = sharedLog("twons");
  const a = join(dirname(dirname(logPath)), "a.mjs");
  writeFileSync(
    a,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { setReclaimSeamForTests } from ${JSON.stringify(LOCK_MODULE)};`,
      // A holder record written in THIS namespace (A), then its reclaimer killed right after the commit.
      `setReclaimSeamForTests((step) => { if (step === "after-commit") process.kill(process.pid, "SIGKILL"); });`,
      `appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(100))});`,
    ].join("\n"),
  );
  const b = join(dirname(dirname(logPath)), "b.mjs");
  writeFileSync(
    b,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `for (const n of [101, 102]) { const r = appendEvent(${JSON.stringify(logPath)}, { ...${JSON.stringify(granted(0))}, action_key: "task-479:writer:" + n }); if (!r.ok) { console.error(r.error.code); process.exit(1); } }`,
    ].join("\n"),
  );
  // The lock in the volume names a holder in A's pid namespace: plant it there.
  const plantA = join(dirname(dirname(logPath)), "plant.mjs");
  writeFileSync(
    plantA,
    [
      `import { spawnSync } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `import { holderRecord } from ${JSON.stringify(LOCK_MODULE)};`,
      `const dead = spawnSync(process.execPath, ["--version"]).pid;`,
      `writeFileSync(${JSON.stringify(`${logPath}.lock`)}, JSON.stringify({ ...holderRecord("append", new Date(Date.now() - 60000)), pid: dead }) + "\\n");`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(a)}]);`,
      `process.exit(r.signal === "SIGKILL" ? 0 : 1);`,
    ].join("\n"),
  );
  const inA = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", process.execPath, plantA], { encoding: "utf8" });
  assert.equal(inA.status, 0, `container A: ${inA.stderr}`);
  assert.equal(existsSync(`${logPath}.lock`), false, "A's reclaimer committed before it died");
  const inB = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", process.execPath, b], { encoding: "utf8" });
  assert.equal(inB.status, 0, `container B: ${inB.stderr}`);
  const log = records(logPath);
  assert.deepEqual(log.map((record) => record.event), ["task.registered", "audit.lock_reclaimed", "approval.granted", "approval.granted"]);
  // B cannot see A's namespace: unverified, unless the kernel reused A's namespace inode, where the pid decides.
  assert.ok(["unverified", "holder-dead"].includes(String(log[1]?.payload?.["reason"])), String(log[1]?.payload?.["reason"]));
  assert.equal(verify(logPath).status, "clean");
});
