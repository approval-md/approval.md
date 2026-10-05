/**
 * A lock left by a writer that died holding it is taken back, and only then
 * (APRV-479, round 3: the smaller design).
 *
 * `core/log.ts` never stole a lock, so a writer killed while it held
 * `<log>.lock` (a hook under SIGTERM with no listener, anything under SIGKILL, a
 * Hermes gateway restart mid-append) wedged every later writer on
 * `lock-timeout` until a human removed the file. These pin the way out and its
 * limits:
 *
 * - a writer that has waited out its whole timeout takes a dead pid's lock
 *   (same pid namespace and boot) and appends `audit.lock_reclaimed` first;
 * - a live holder, an EPERM pid, a holder in another pid namespace or boot or
 *   host, a FIFO, a link, an unreadable or malformed lockfile: never taken, and
 *   the refusal names the pid and the human verb (`approval log unlock`);
 * - a pid reused by a later process (Linux, start time) counts as gone;
 * - an empty lockfile is taken only once it is ten minutes old;
 * - the claim (`link(2)` to the stale name) admits one reclaimer: a second one
 *   waits again, a stalled one whose lock changed hands touches nothing, and a
 *   planted file at the stale name keeps the lock (for a human) rather than
 *   being trusted or removed;
 * - six writers racing one stale lock: one record, every append, a clean chain;
 * - the signal guard is installed before the lockfile exists: SIGTERM mid-append
 *   or in the create's own window leaves no lockfile, and the process still dies
 *   of the signal;
 * - `approval log unlock` takes what no writer could, refuses a wrong pid or a
 *   running holder, and records the person who did it.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";
import { clearDaemonIdentity, declareDaemonIdentity, setDaemonAllowlist } from "../src/core/daemon-identity.js";
import { appendEvent, unlockAppendLock, withAppendLock, type EventInput, type EventRecord } from "../src/core/log.js";
import {
  BOOT_SLACK_S,
  holderRecord,
  judgeHolder,
  LEGACY_LOCK_RECLAIM_AGE_MS,
  NODE_LIVENESS_PROBE,
  parseProcStat,
  procIsOwnNamespace,
  reclaimStaleLock,
  selfIdentity,
  setLockLivenessForTests,
  setLockSeamForTests,
  type LivenessProbe,
  type LockHolder,
  type ProcStatRead,
  type SelfIdentity,
  type SignalZero,
} from "../src/core/log-lock.js";
import { runPayloadHash } from "../src/core/payload.js";
import { verify } from "../src/core/verify.js";
import { isExcludedPath } from "../src/serve/archive.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-lock-reclaim-"));
after(() => {
  setLockLivenessForTests(null);
  setLockSeamForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log.js")).href;
const LOCK_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log-lock.js")).href;
const WRITE_LAYER_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log-write-layer.js")).href;
const CLI_ENTRY = join(REPO_ROOT, "dist", "src", "cli", "main.js");

const LINUX = process.platform === "linux";
const POSIX = process.platform !== "win32";
const ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** Whether pid 1 belongs to another user here (it does not in a container whose pid 1 is this test's own runner). */
const PID1_IS_FOREIGN = ((): boolean => {
  try {
    process.kill(1, 0);
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
})();

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

function events(logPath: string): string[] {
  return records(logPath).map((record) => record.event);
}

function writeLock(logPath: string, content: LockHolder | string): void {
  writeFileSync(`${logPath}.lock`, typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
}

/** A holder record exactly as this process would write it, with fields replaced. */
function holder(overrides: Partial<LockHolder> = {}): LockHolder {
  return { ...holderRecord("append", new Date(Date.now() - 60_000)), ...overrides };
}

/** The same, with `start` removed (a record whose start time cannot be compared). */
function holderWithoutStart(overrides: Partial<LockHolder> = {}): LockHolder {
  const record = holder(overrides);
  delete record.start;
  return record;
}

/** A pid that existed a moment ago and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
  assert.ok(typeof child.pid === "number" && child.pid > 0);
  return child.pid;
}

/** The stale name a reclaim of `record` claims. */
function staleOf(logPath: string, record: LockHolder): string {
  return `${logPath}.lock.stale.${String(record.pid)}.${String(Date.parse(record.created))}`;
}

/** Every name beside the lock that the protocol writes (`<lock>.stale.*`, `<lock>.take.*`). */
function residue(logPath: string): string[] {
  return readdirSync(dirname(logPath)).filter((name) => name.startsWith("events.jsonl.lock."));
}

async function waitFor(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

/** Run one append in a child process; resolve with how it ended, or "hung" after `ms`. */
async function appendInChild(logPath: string, n: number, ms: number, lockTimeoutMs = 100): Promise<string> {
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

/** Append with a short wait and expect lock-timeout; return the message. */
function refused(logPath: string, n: number): string {
  const result = appendEvent(logPath, granted(n), { lockTimeoutMs: 40, lockRetryMs: 5 });
  assert.equal(result.ok, false, "the lock was kept");
  if (result.ok) return "";
  assert.equal(result.error.code, "lock-timeout");
  return result.error.message;
}

// ---------------------------------------------------------------------------
// The repro, and the holders that are never taken
// ---------------------------------------------------------------------------

test("a lock left by a dead pid is taken after the wait: the reclaim is the first record under the new lock, then the writer's own", () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid(), created: new Date(Date.now() - 5_000).toISOString() });
  writeLock(logPath, left);

  const started = Date.now();
  const result = appendEvent(logPath, granted(1), { lockTimeoutMs: 150, lockRetryMs: 5 });
  assert.ok(result.ok, `the writer reclaimed and appended: ${result.ok ? "" : result.error.message}`);
  assert.ok(Date.now() - started >= 140, "the reclaim waited out the writer's whole lock timeout first");

  assert.deepEqual(events(logPath), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  const reclaim = records(logPath)[1] as EventRecord;
  assert.equal(reclaim.actor, "system:log");
  assert.deepEqual(reclaim.payload, {
    lockfile: "events.jsonl.lock",
    reason: "holder-dead",
    age_ms: reclaim.payload?.["age_ms"],
    holder: { pid: left.pid, op: "append", created: left.created },
  });
  assert.ok((reclaim.payload?.["age_ms"] as number) >= 4_000);
  assert.equal(existsSync(`${logPath}.lock`), false, "the writer's own lock is released");
  assert.deepEqual(residue(logPath), [], "the stale name is removed once the record is in the log");
  assert.equal(verify(logPath).status, "clean");
});

test("a lock held by a live process is never taken, however old: lock-timeout names the holder, and the lockfile is untouched", () => {
  const logPath = freshLog();
  const before = readFileSync(logPath);
  writeLock(logPath, holder({ created: new Date(Date.now() - 24 * 3_600_000).toISOString() }));
  const lockBytes = readFileSync(`${logPath}.lock`);

  const result = appendEvent(logPath, granted(2), { lockTimeoutMs: 80, lockRetryMs: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "lock-timeout");
    assert.match(result.error.message, /another writer holds .*events\.jsonl\.lock; gave up after 80ms/u);
    assert.match(result.error.message, new RegExp(`pid ${String(process.pid)} `, "u"));
    assert.match(result.error.message, /is running/u);
    assert.match(result.error.message, /a running holder's lock is never taken/u);
  }
  assert.deepEqual(readFileSync(logPath), before, "nothing was appended");
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the live holder's lockfile is untouched");
  assert.deepEqual(residue(logPath), []);
});

test("a holder that answers EPERM (another user's pid) is live: kept, and the refusal says why", { skip: !POSIX || !PID1_IS_FOREIGN ? "needs pid 1 to be another user's process (kill(1, 0) answering EPERM)" : false }, () => {
  const logPath = freshLog();
  // No start time, so on Linux the pid cannot be told apart by its start.
  writeLock(logPath, holderWithoutStart({ pid: 1 }));
  const message = refused(logPath, 3);
  assert.match(message, /EPERM/u);
  assert.ok(existsSync(`${logPath}.lock`));
  assert.deepEqual(events(logPath), ["task.registered"]);
  assert.deepEqual(residue(logPath), []);
});

test("a holder in another pid namespace, under another boot, or on another host is never taken automatically: the refusal names the pid and `approval log unlock`", () => {
  const self = selfIdentity();
  const pid = deadPid();
  const shifted = `~${String(Number((self.boot ?? "~0").slice(1)) - 3 * BOOT_SLACK_S)}`;
  const cases: Array<[string, Partial<LockHolder>, RegExp]> = LINUX
    ? [
        ["another pid namespace", { pidns: "pid:[1]" }, /another pid namespace/u],
        ["another boot id", { boot: "00000000-0000-0000-0000-000000000000" }, /another boot id/u],
      ]
    : [
        ["another boot (or a stepped clock)", { boot: shifted }, /another boot, or before a clock step/u],
        ["another host", { host: "elsewhere.example" }, /another host/u],
      ];
  for (const [name, overrides, why] of cases) {
    const logPath = freshLog();
    writeLock(logPath, holder({ pid, ...overrides }));
    const message = refused(logPath, 4);
    assert.match(message, why, name);
    assert.match(message, new RegExp(`approval log unlock --pid ${String(pid)}`, "u"), name);
    assert.match(message, /never reclaimed automatically/u, name);
    assert.ok(existsSync(`${logPath}.lock`), name);
    assert.deepEqual(residue(logPath), [], name);
  }
});

test("a pid now naming a later process: gone where the start time is read (Linux), live where it cannot be", () => {
  const logPath = freshLog();
  // This process's pid, with a start time that is not this process's.
  writeLock(logPath, holder({ start: "1" }));
  const result = appendEvent(logPath, granted(5), { lockTimeoutMs: 40, lockRetryMs: 5 });
  if (LINUX) {
    assert.ok(result.ok, `reclaimed on Linux: ${result.ok ? "" : result.error.message}`);
    const reclaim = records(logPath).find((record) => record.event === "audit.lock_reclaimed");
    assert.equal(reclaim?.payload?.["reason"], "holder-dead");
    assert.equal(verify(logPath).status, "clean");
  } else {
    assert.equal(result.ok, false, "off Linux a running pid is taken to be the holder");
    if (!result.ok) assert.match(result.error.message, /cannot read its start time/u);
    rmSync(`${logPath}.lock`);
  }
  assert.deepEqual(residue(logPath), []);
});

test("an empty lockfile is kept while younger than ten minutes, and taken once older (legacy-aged, no holder recorded)", () => {
  const logPath = freshLog();
  writeLock(logPath, "");
  assert.match(refused(logPath, 6), /names no holder .* reclaimed at 10 minutes/u);
  assert.equal(records(logPath).length, 1);

  const old = (Date.now() - LEGACY_LOCK_RECLAIM_AGE_MS - 60_000) / 1000;
  utimesSync(`${logPath}.lock`, old, old);
  const aged = appendEvent(logPath, granted(6), { lockTimeoutMs: 40, lockRetryMs: 5 });
  assert.ok(aged.ok, `the aged lockfile was taken: ${aged.ok ? "" : aged.error.message}`);
  const reclaim = records(logPath)[1] as EventRecord;
  assert.equal(reclaim.event, "audit.lock_reclaimed");
  assert.equal(reclaim.payload?.["reason"], "legacy-aged");
  assert.equal(reclaim.payload?.["holder"], undefined, "no holder record, none recorded");
  assert.ok((reclaim.payload?.["age_ms"] as number) >= LEGACY_LOCK_RECLAIM_AGE_MS);
  assert.deepEqual(residue(logPath), []);
  assert.equal(verify(logPath).status, "clean");
});

test("a lockfile that does not parse strictly is not this writer's to judge, however old: another version, malformed JSON, text, an impossible date", () => {
  for (const content of [
    `${JSON.stringify({ v: 2, pid: deadPid() })}\n`,
    "{not json\n",
    "a note somebody left\n",
    `${JSON.stringify(holder({ pid: deadPid(), created: "2026-02-30T00:00:00.000Z" }))}\n`,
    `${JSON.stringify({ ...holder({ pid: deadPid() }), op: "steal" })}\n`,
  ]) {
    const logPath = freshLog();
    writeLock(logPath, content);
    const old = (Date.now() - 2 * LEGACY_LOCK_RECLAIM_AGE_MS) / 1000;
    utimesSync(`${logPath}.lock`, old, old);
    const message = refused(logPath, 7);
    assert.match(message, /does not hold a holder record this version reads/u, content);
    assert.match(message, /rm -v /u, content);
    assert.equal(readFileSync(`${logPath}.lock`, "utf8"), content, "untouched");
    assert.deepEqual(residue(logPath), []);
  }
});

test("a FIFO or a symbolic link at the lock path is live: the writer times out, never hangs, never follows it", { skip: !POSIX }, async () => {
  const logPath = freshLog();
  const lockPath = `${logPath}.lock`;
  assert.equal(spawnSync("mkfifo", [lockPath]).status, 0);
  assert.equal(await appendInChild(logPath, 8, 8_000), "lock-timeout");
  const fifo = reclaimStaleLock(logPath, "append");
  assert.equal(fifo.kind, "kept");
  if (fifo.kind === "kept") assert.match(fifo.why, /not a regular file, not a lockfile any writer made/u);
  rmSync(lockPath);
  // A link to a dead holder's lockfile elsewhere: not followed, not taken.
  const target = join(scratch, `elsewhere-${String(counter)}.lock`);
  writeFileSync(target, `${JSON.stringify(holder({ pid: deadPid() }))}\n`);
  symlinkSync(target, lockPath);
  assert.equal(await appendInChild(logPath, 9, 8_000), "lock-timeout");
  assert.ok(existsSync(target), "the link's target is untouched");
  assert.deepEqual(events(logPath), ["task.registered"]);
  assert.deepEqual(residue(logPath), []);
  rmSync(lockPath);
});

test("a sync snapshot beside the log, or an absent log, keeps even a dead holder's lock", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  writeFileSync(`${logPath}.sync-snapshot`, readFileSync(logPath));
  assert.match(refused(logPath, 10), /a log sync snapshot is beside the log/u);
  assert.ok(existsSync(`${logPath}.lock`));
  assert.equal(records(logPath).length, 1);

  const absent = join(scratch, "absent", "events.jsonl");
  mkdirSync(join(scratch, "absent"), { recursive: true });
  writeLock(absent, holder({ pid: deadPid() }));
  const outcome = reclaimStaleLock(absent, "append");
  assert.equal(outcome.kind, "kept");
  if (outcome.kind === "kept") assert.match(outcome.why, /the log itself is absent/u);
  assert.equal(existsSync(absent), false, "nothing created a log");
});

test("a hostile lockfile cannot put control characters or its own text into a refusal", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ host: "\u001b]0;pwned\u0007\nFORGED LINE" }));
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(refused(logPath, 11), /[\u0000-\u001f\u007f]/u);
  writeLock(logPath, holder({ pid: deadPid(), created: "2026-10-05T07:00:00.000Z\nFORGED" }));
  assert.doesNotMatch(refused(logPath, 12), /FORGED/u);
  writeLock(logPath, `${JSON.stringify({ v: "X".repeat(3000) })}\n`);
  assert.doesNotMatch(refused(logPath, 13), /XXXX/u);
  assert.deepEqual(events(logPath), ["task.registered"]);
});

// ---------------------------------------------------------------------------
// The claim: one reclaimer, and nothing else touched
// ---------------------------------------------------------------------------

test("two reclaimers of one dead lock: the second's claim fails (EEXIST on the stale name) and it waits again; one record", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  let second: ReturnType<typeof appendEvent> | undefined;
  setLockSeamForTests((step) => {
    if (step !== "claimed" || second !== undefined) return;
    // The first reclaimer holds the claim and has not taken the lock yet.
    second = appendEvent(logPath, granted(20), { lockTimeoutMs: 0 });
  });
  let first: ReturnType<typeof appendEvent>;
  try {
    first = appendEvent(logPath, granted(21), { lockTimeoutMs: 20, lockRetryMs: 5 });
  } finally {
    setLockSeamForTests(null);
  }
  assert.ok(first.ok, "the claimant took the lock and appended");
  assert.ok(second !== undefined && !second.ok, "the second reclaimer did not take it");
  if (second !== undefined && !second.ok) {
    assert.equal(second.error.code, "lock-timeout");
    // The claimant (this process) wrote its own lockfile before its claim and
    // is running, so the second waits for it rather than naming unlock.
    assert.match(second.error.message, new RegExp(`a reclaim of events\\.jsonl\\.lock is in flight \\(events\\.jsonl\\.lock\\.take\\.${String(process.pid)}\\.`, "u"));
  }
  assert.deepEqual(events(logPath), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  assert.deepEqual(residue(logPath), []);
  assert.equal(verify(logPath).status, "clean");
});

test("a reclaimer whose judged lock changed hands before its claim touches nothing: the live lock that replaced it survives", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  let liveBytes: Buffer | undefined;
  setLockSeamForTests((step) => {
    if (step !== "judged" || liveBytes !== undefined) return;
    // While this reclaimer is stalled between its judgement and its claim,
    // another writer reclaims, records and releases, and a live writer (this
    // process's record) takes the lock.
    setLockSeamForTests(null);
    assert.ok(appendEvent(logPath, granted(22), { lockTimeoutMs: 0 }).ok);
    writeLock(logPath, holder());
    liveBytes = readFileSync(`${logPath}.lock`);
  });
  let stalled: ReturnType<typeof appendEvent>;
  try {
    stalled = appendEvent(logPath, granted(23), { lockTimeoutMs: 20, lockRetryMs: 5 });
  } finally {
    setLockSeamForTests(null);
  }
  assert.equal(stalled.ok, false);
  if (!stalled.ok) {
    assert.equal(stalled.error.code, "lock-timeout");
    assert.match(stalled.error.message, /is running/u, "it judged the new lock afresh");
  }
  assert.deepEqual(readFileSync(`${logPath}.lock`), liveBytes, "the live lock is untouched");
  assert.deepEqual(events(logPath), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  assert.deepEqual(residue(logPath), [], "its own link to the live lock was removed, nothing else");
  rmSync(`${logPath}.lock`);
  assert.equal(verify(logPath).status, "clean");
});

test("a planted file at the stale name is neither trusted nor removed: the lock is kept for a human, and `approval log unlock` clears both", () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid() });
  writeLock(logPath, left);
  const planted = staleOf(logPath, left);
  writeFileSync(planted, "planted\n");
  const lockBytes = readFileSync(`${logPath}.lock`);

  const message = refused(logPath, 24);
  assert.match(message, /already exists and is not that lockfile/u);
  assert.match(message, new RegExp(`approval log unlock --pid ${String(left.pid)}`, "u"));
  assert.equal(readFileSync(planted, "utf8"), "planted\n", "the planted file is untouched");
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the lock is untouched");
  assert.deepEqual(events(logPath), ["task.registered"]);

  const unlocked = unlockAppendLock(logPath, left.pid, "human:carter");
  assert.equal(unlocked.kind, "unlocked");
  assert.equal(existsSync(planted), false);
  assert.deepEqual(residue(logPath), []);
  assert.ok(appendEvent(logPath, granted(25), { lockTimeoutMs: 40 }).ok);
  assert.deepEqual(events(logPath), ["task.registered", "audit.lock_reclaimed", "approval.granted"]);
  assert.equal(verify(logPath).status, "clean");
});

test("a directory at the stale name: the writer and `approval log unlock` both name `rm -r` for it, and touch nothing (R3-5)", () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid() });
  writeLock(logPath, left);
  const planted = staleOf(logPath, left);
  mkdirSync(planted);
  writeFileSync(join(planted, "x"), "y");
  const lockBytes = readFileSync(`${logPath}.lock`);

  const message = refused(logPath, 29);
  assert.match(message, /is a directory/u);
  assert.ok(message.includes(`(\`rm -r ${planted}\`)`), message);
  assert.doesNotMatch(message, /clears both/u, "unlock does not remove a directory, so the writer does not say it does");
  const unlocked = unlockAppendLock(logPath, left.pid, "human:carter");
  assert.equal(unlocked.kind, "refused");
  if (unlocked.kind === "refused") assert.match(unlocked.message, /is a directory.*`rm -r .*`/u);
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the lock is untouched");
  assert.equal(readFileSync(join(planted, "x"), "utf8"), "y", "the directory is untouched");
  assert.deepEqual(residue(logPath).sort(), [`events.jsonl.lock.stale.${String(left.pid)}.${String(Date.parse(left.created))}`]);
  assert.deepEqual(events(logPath), ["task.registered"]);

  rmSync(planted, { recursive: true });
  assert.equal(unlockAppendLock(logPath, left.pid, "human:carter").kind, "unlocked", "and once it is removed, unlock clears the lock");
  assert.deepEqual(residue(logPath), []);
  assert.equal(verify(logPath).status, "clean");
});

test("a reclaimer SIGKILLed after its claim leaves a wedge, never a fork: the next writers wait and refuse, and `approval log unlock` finishes it", { skip: !POSIX }, () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid() });
  writeLock(logPath, left);
  counter += 1;
  const script = join(scratch, `killed-claimant-${String(counter)}.mjs`);
  writeFileSync(
    script,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { setLockSeamForTests } from ${JSON.stringify(LOCK_MODULE)};`,
      `setLockSeamForTests((step) => { if (step === "claimed") process.kill(process.pid, "SIGKILL"); });`,
      `appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(26))}, { lockTimeoutMs: 0 });`,
    ].join("\n"),
  );
  assert.equal(spawnSync(process.execPath, [script]).signal, "SIGKILL");
  assert.ok(existsSync(staleOf(logPath, left)), "the dead claimant's claim");
  assert.match(refused(logPath, 27), /another writer has claimed its reclaim .* `approval log unlock --pid \d+` finishes it/u);
  assert.deepEqual(events(logPath), ["task.registered"]);

  const unlocked = unlockAppendLock(logPath, left.pid, "human:carter");
  assert.equal(unlocked.kind, "unlocked");
  assert.deepEqual(residue(logPath), []);
  assert.ok(appendEvent(logPath, granted(28), { lockTimeoutMs: 40 }).ok);
  assert.equal(verify(logPath).status, "clean");
});

test("a claimant stopped between its claim and its take is seen running: writers wait for it, `approval log unlock` refuses naming its pid, and one reclaim is recorded (R3-2)", { skip: !POSIX }, async () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid() });
  writeLock(logPath, left);
  const lockBytes = readFileSync(`${logPath}.lock`);
  counter += 1;
  const marker = join(scratch, `stopped-claimant-${String(counter)}`);
  writeFileSync(
    `${marker}.mjs`,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `import { setLockSeamForTests } from ${JSON.stringify(LOCK_MODULE)};`,
      `import { writeFileSync } from "node:fs";`,
      `let once = false;`,
      `setLockSeamForTests((step) => { if (step === "claimed" && !once) { once = true; writeFileSync(${JSON.stringify(`${marker}.claimed`)}, "1"); process.kill(process.pid, "SIGSTOP"); } });`,
      `const r = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(70))}, { lockTimeoutMs: 0 });`,
      `writeFileSync(${JSON.stringify(`${marker}.result`)}, JSON.stringify(r.ok));`,
    ].join("\n"),
  );
  const claimant = spawn(process.execPath, [`${marker}.mjs`], { stdio: "ignore" });
  const exited = exitOf(claimant);
  const pid = String(claimant.pid);
  try {
    await waitFor(() => existsSync(`${marker}.claimed`), 10_000);
    assert.ok(existsSync(staleOf(logPath, left)), "the claimant's claim");
    assert.ok(residue(logPath).some((name) => name.startsWith(`events.jsonl.lock.take.${pid}.`)), "its own lockfile, written before the claim");

    const told = refused(logPath, 71);
    assert.match(told, new RegExp(`a reclaim of events\\.jsonl\\.lock is in flight .*pid ${pid} .*is running`, "u"));
    assert.doesNotMatch(told, /finishes it/u, "a writer does not send the person to unlock around a running reclaimer");

    const unlocked = unlockAppendLock(logPath, left.pid, "human:carter");
    assert.equal(unlocked.kind, "refused", "the person's unlock is refused while the claimant runs");
    if (unlocked.kind === "refused") assert.match(unlocked.message, new RegExp(`pid ${pid} .*is running.*rather than unlock`, "u"));
    assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the lock is untouched");
    assert.ok(existsSync(staleOf(logPath, left)), "and so is the claim");
  } finally {
    claimant.kill("SIGCONT");
  }
  assert.equal((await exited).code, 0);
  assert.equal(readFileSync(`${marker}.result`, "utf8"), "true", "the claimant took the lock and appended");
  assert.deepEqual(events(logPath), ["task.registered", "audit.lock_reclaimed", "approval.granted"], "one reclaim record");
  assert.deepEqual(residue(logPath), []);
  assert.equal(verify(logPath).status, "clean");
});

test("a take whose claim was removed and whose lock changed hands moves nothing: the live lock that replaced it survives (R3-2)", () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid() });
  writeLock(logPath, left);
  let liveBytes: Buffer | undefined;
  setLockSeamForTests((step) => {
    if (step !== "before-take" || liveBytes !== undefined) return;
    // Between this reclaimer's claim and its rename: its claim is removed and
    // a live writer holds the lock (what a person's unlock and the next writer
    // would leave).
    rmSync(staleOf(logPath, left));
    rmSync(`${logPath}.lock`);
    writeLock(logPath, holder());
    liveBytes = readFileSync(`${logPath}.lock`);
  });
  let result: ReturnType<typeof appendEvent>;
  try {
    result = appendEvent(logPath, granted(72), { lockTimeoutMs: 20, lockRetryMs: 5 });
  } finally {
    setLockSeamForTests(null);
  }
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "lock-timeout");
    assert.match(result.error.message, /is running/u, "it judged the new lock afresh");
  }
  assert.deepEqual(readFileSync(`${logPath}.lock`), liveBytes, "the live lock is untouched");
  assert.deepEqual(events(logPath), ["task.registered"]);
  assert.deepEqual(residue(logPath), [], "its own lockfile was removed, nothing else");
  rmSync(`${logPath}.lock`);
});

test("six writers, three appends each, over one stale lock: exactly one reclaim record, every append lands, the chain verifies", async () => {
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
      `  const result = appendEvent(logPath, { ts: "2026-10-05T07:00:02Z", event: "approval.granted", actor: "human:carter", task: "task-479", action_key: "task-479:racer:" + id + ":" + n, channel: "cli" }, { lockTimeoutMs: 1500 });`,
      `  if (!result.ok) { failed += 1; console.error(JSON.stringify(result.error)); }`,
      `}`,
      `process.exit(failed === 0 ? 0 : 1);`,
    ].join("\n"),
  );
  for (let round = 1; round <= 2; round += 1) {
    const logPath = freshLog();
    writeLock(logPath, holder({ pid: deadPid() }));
    const go = join(scratch, `go-${String(counter)}-${String(round)}`);
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(go, "go");
    const results = await Promise.all(outcomes);
    for (const result of results) assert.equal(result.code, 0, `a racer failed: ${result.stderr}`);
    const log = records(logPath);
    assert.equal(log.filter((record) => record.event === "audit.lock_reclaimed").length, 1, `round ${String(round)}: one reclaim`);
    assert.equal(log[1]?.event, "audit.lock_reclaimed", "the reclaim is the first record after the stale lock's");
    assert.equal(log.filter((record) => record.event === "approval.granted").length, WRITERS * EACH);
    assert.equal(verify(logPath).status, "clean");
    assert.equal(existsSync(`${logPath}.lock`), false);
    assert.deepEqual(residue(logPath), []);
  }
});

// ---------------------------------------------------------------------------
// Compare-and-append and the rest of the writer, unchanged
// ---------------------------------------------------------------------------

test("a writer that could not record a reclaim does not make it: a refused daemon stamp or a torn tail keeps the lock, claims nothing, appends nothing (R3-3)", () => {
  const logPath = freshLog();
  const left = holder({ pid: deadPid() });
  writeLock(logPath, left);
  const lockBytes = readFileSync(`${logPath}.lock`);
  const asRefusedDaemon = <T>(run: () => T): T => {
    declareDaemonIdentity({ id: "d-refused", source: "environment" });
    setDaemonAllowlist(["d-other"]);
    try {
      return run();
    } finally {
      clearDaemonIdentity();
    }
  };

  // The S3 shape: a daemon whose id the attested list does not admit holds the
  // lock for a whole operation (the export path), over a dead holder's lock.
  const held = asRefusedDaemon(() => withAppendLock(logPath, () => "exported", { lockTimeoutMs: 0 }));
  assert.equal(held.ok, false);
  if (!held.ok) {
    assert.equal(held.error.code, "lock-timeout");
    assert.match(held.error.message, /could not record the reclaim \(its records are refused: daemon-not-allowed\)/u);
  }
  const unlockedAsDaemon = asRefusedDaemon(() => unlockAppendLock(logPath, left.pid, "human:carter"));
  assert.equal(unlockedAsDaemon.kind, "refused");
  if (unlockedAsDaemon.kind === "refused") assert.match(unlockedAsDaemon.message, /daemon-not-allowed.*nothing was touched/u);
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the lock is untouched");
  assert.deepEqual(residue(logPath), [], "no claim was made");
  assert.deepEqual(events(logPath), ["task.registered"], "nothing was appended");

  // A writer killed mid-append leaves a torn tail beside its lock.
  appendFileSync(logPath, '{"seq":2,"event":"approval.gra');
  assert.match(refused(logPath, 80), /could not record the reclaim \(the log's tail refuses an append \(corrupt-tail\)/u);
  const unlockedTorn = unlockAppendLock(logPath, left.pid, "human:carter");
  assert.equal(unlockedTorn.kind, "refused");
  if (unlockedTorn.kind === "refused") assert.match(unlockedTorn.message, /corrupt-tail/u);
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the lock is untouched");
  assert.deepEqual(residue(logPath), [], "no claim was made");
});

test("compare-and-append is unchanged: a head read before the reclaim is refused head-moved, and a fresh read appends", () => {
  const logPath = freshLog();
  const head = records(logPath).at(-1) as EventRecord;
  writeLock(logPath, holder({ pid: deadPid() }));
  const stale = appendEvent(logPath, granted(30), { expectedHead: { seq: head.seq, hash: head.hash }, lockTimeoutMs: 20, lockRetryMs: 5 });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "head-moved");
  assert.deepEqual(events(logPath), ["task.registered", "audit.lock_reclaimed"], "the reclaim is recorded, and the caller's record is not");
  const now = records(logPath).at(-1) as EventRecord;
  assert.ok(appendEvent(logPath, granted(30), { expectedHead: { seq: now.seq, hash: now.hash } }).ok);
  assert.equal(verify(logPath).status, "clean");
});

test("a whole-operation holder (withAppendLock) reclaims too, and the record precedes its work", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid(), op: "hold" }));
  const held = withAppendLock(logPath, () => events(logPath), { lockTimeoutMs: 20, lockRetryMs: 5 });
  assert.ok(held.ok);
  if (held.ok) assert.deepEqual(held.value, ["task.registered", "audit.lock_reclaimed"]);
  const recorded = (records(logPath)[1]?.payload ?? {})["holder"] as { op?: string } | undefined;
  assert.equal(recorded?.op, "hold");
  assert.equal(existsSync(`${logPath}.lock`), false);
});

test("a writer releases only its own lockfile", () => {
  const logPath = freshLog();
  const other = `${JSON.stringify(holder({ pid: 1, nonce: "someone-else" }))}\n`;
  const held = withAppendLock(logPath, () => {
    rmSync(`${logPath}.lock`);
    writeFileSync(`${logPath}.lock`, other);
    return true;
  });
  assert.ok(held.ok);
  assert.equal(readFileSync(`${logPath}.lock`, "utf8"), other, "the release left the other lockfile alone");
  rmSync(`${logPath}.lock`);
});

test("the export excludes the names the protocol writes beside the lock, and nothing else that merely ends in .lock", () => {
  const lock = ".approval/log/events.jsonl.lock";
  assert.equal(isExcludedPath(lock, lock), true);
  assert.equal(isExcludedPath(`${lock}.stale.4242.1791182345123`, lock), true);
  assert.equal(isExcludedPath(`${lock}.take.4242.0011223344556677`, lock), true);
  assert.equal(isExcludedPath(".approval/log/other.lock", lock), false);
  assert.equal(isExcludedPath(".approval/log/events.jsonl", lock), false);
});

// ---------------------------------------------------------------------------
// The judgement, platform by platform, with the operating system stubbed
// ---------------------------------------------------------------------------

test("judgeHolder: the decision table on Linux and elsewhere", () => {
  const linuxSelf: SelfIdentity = { pid: 100, host: "box", boot: "boot-a", pidns: "pid:[1]", start: "500", linux: true };
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
    boot: "~1000030",
    created: "2026-10-05T07:00:00.000Z",
    op: "append",
    nonce: "n",
    ...overrides,
  });
  const noStart = linuxHolder();
  delete noStart.start;
  const probe = (stat: ProcStatRead, signal: SignalZero): LivenessProbe => ({ linuxStat: () => stat, signalZero: () => signal });
  const ABSENT: ProcStatRead = { kind: "absent" };
  const stat = (state: string, start: string): ProcStatRead => ({ kind: "stat", state, start });
  const unreadable = (why: string): ProcStatRead => ({ kind: "unreadable", why });

  type Row = [string, "gone" | "live", boolean | undefined, ReturnType<typeof judgeHolder>];
  const rows: Row[] = [
    ["linux: ESRCH and no /proc entry", "gone", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(ABSENT, "ESRCH"))],
    ["linux: ESRCH and a zombie entry", "gone", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(stat("Z", "300"), "ESRCH"))],
    ["linux: a zombie that kill(pid, 0) still finds", "live", false, judgeHolder(linuxHolder(), linuxSelf, probe(stat("Z", "300"), "ok"))],
    ["linux: pid reused (start differs)", "gone", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(stat("S", "999"), "ok"))],
    ["linux: pid reused, EPERM (start differs)", "gone", undefined, judgeHolder(linuxHolder(), linuxSelf, probe(stat("S", "999"), "EPERM"))],
    ["linux: the same process", "live", true, judgeHolder(linuxHolder(), linuxSelf, probe(stat("S", "300"), "ok"))],
    ["linux: EPERM, /proc hidden (hidepid)", "live", false, judgeHolder(linuxHolder(), linuxSelf, probe(ABSENT, "EPERM"))],
    ["linux: EPERM, /proc unreadable", "live", false, judgeHolder(linuxHolder(), linuxSelf, probe(unreadable("EACCES"), "EPERM"))],
    ["linux: ESRCH but /proc unreadable", "live", false, judgeHolder(linuxHolder(), linuxSelf, probe(unreadable("EACCES"), "ESRCH"))],
    ["linux: kill finds it, /proc absent", "live", false, judgeHolder(linuxHolder(), linuxSelf, probe(ABSENT, "ok"))],
    ["linux: kill fails otherwise", "live", false, judgeHolder(linuxHolder(), linuxSelf, probe(ABSENT, "other"))],
    ["linux: record without start, running", "live", false, judgeHolder(noStart, linuxSelf, probe(stat("S", "300"), "ok"))],
    ["linux: another time namespace, start differs", "live", false, judgeHolder(linuxHolder({ timens: "time:[9]" }), linuxSelf, probe(stat("S", "999"), "ok"))],
    ["linux: one time namespace, start differs", "gone", undefined, judgeHolder(linuxHolder({ timens: "time:[9]" }), { ...linuxSelf, timens: "time:[9]" }, probe(stat("S", "999"), "ok"))],
    ["linux: another pid namespace", "live", false, judgeHolder(linuxHolder({ pidns: "pid:[2]" }), linuxSelf, probe(ABSENT, "ESRCH"))],
    ["linux: another boot id", "live", false, judgeHolder(linuxHolder({ boot: "boot-b" }), linuxSelf, probe(ABSENT, "ESRCH"))],
    ["linux: record without boot", "live", false, judgeHolder(linuxHolder({ boot: "" }), linuxSelf, probe(ABSENT, "ESRCH"))],
    ["linux: record written off Linux", "live", false, judgeHolder(otherHolder(), linuxSelf, probe(ABSENT, "ESRCH"))],
    ["linux: this reader's /proc is foreign", "live", false, judgeHolder(linuxHolder(), { ...linuxSelf, procIsOwn: false }, probe(ABSENT, "ESRCH"))],
    ["other: ESRCH, same host and boot", "gone", undefined, judgeHolder(otherHolder(), otherSelf, probe(ABSENT, "ESRCH"))],
    ["other: pid exists", "live", true, judgeHolder(otherHolder(), otherSelf, probe(ABSENT, "ok"))],
    ["other: EPERM", "live", true, judgeHolder(otherHolder(), otherSelf, probe(ABSENT, "EPERM"))],
    ["other: kill fails otherwise", "live", false, judgeHolder(otherHolder(), otherSelf, probe(ABSENT, "other"))],
    ["other: boot readings 61 s apart, ESRCH", "live", false, judgeHolder(otherHolder({ boot: "~1000061" }), otherSelf, probe(ABSENT, "ESRCH"))],
    ["other: boot reading unreadable", "live", false, judgeHolder(otherHolder({ boot: "" }), otherSelf, probe(ABSENT, "ESRCH"))],
    ["other: another host, ESRCH", "live", false, judgeHolder(otherHolder({ host: "elsewhere" }), otherSelf, probe(ABSENT, "ESRCH"))],
    ["other: record written on Linux", "live", false, judgeHolder(linuxHolder({ host: "box" }), otherSelf, probe(ABSENT, "ESRCH"))],
  ];
  for (const [name, state, running, verdict] of rows) {
    assert.equal(verdict.state, state, name);
    if (verdict.state === "live") assert.equal(verdict.running, running, name);
  }
});

test("procIsOwnNamespace: /proc is trusted only when /proc/self names this process", () => {
  assert.equal(procIsOwnNamespace(() => "8", 8), true);
  assert.equal(procIsOwnNamespace(() => "15", 8), false);
  assert.equal(
    procIsOwnNamespace(() => {
      throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
    }, 8),
    false,
  );
});

test("the real probe: kill(pid, 0) answers ok, ESRCH and EPERM; on Linux a dead pid's /proc entry is absent", () => {
  assert.equal(NODE_LIVENESS_PROBE.signalZero(process.pid), "ok");
  const dead = deadPid();
  assert.equal(NODE_LIVENESS_PROBE.signalZero(dead), "ESRCH");
  if (PID1_IS_FOREIGN) assert.equal(NODE_LIVENESS_PROBE.signalZero(1), "EPERM");
  if (LINUX) {
    assert.deepEqual(NODE_LIVENESS_PROBE.linuxStat(dead), { kind: "absent" });
    assert.equal(NODE_LIVENESS_PROBE.linuxStat(process.pid).kind, "stat");
  }
});

test("parseProcStat counts fields from the last parenthesis, so a command name with spaces cannot shift them", () => {
  const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
  fields[0] = "S";
  assert.deepEqual(parseProcStat(`1234 (node (a) b) ${fields.join(" ")}`), { state: "S", start: "22" });
  assert.equal(parseProcStat("garbage"), null);
});

test("this process's own record is judged live and running by the real check", () => {
  const verdict = judgeHolder(holder(), selfIdentity(), NODE_LIVENESS_PROBE);
  assert.equal(verdict.state, "live");
  if (verdict.state === "live") assert.equal(verdict.running, true);
});

test("the liveness check is load-bearing: replaced by 'gone', a live holder's lock is taken", () => {
  const logPath = freshLog();
  writeLock(logPath, holder());
  setLockLivenessForTests(() => ({ state: "gone", why: "mutated" }));
  try {
    const result = appendEvent(logPath, granted(40), { lockTimeoutMs: 20, lockRetryMs: 5 });
    assert.ok(result.ok, "with the check gone, the live holder's lock was taken");
  } finally {
    setLockLivenessForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Signals: the guard is installed before the lockfile exists
// ---------------------------------------------------------------------------

test("a SIGTERM while a process holds the lock mid-append: the append finishes, the lockfile is removed, and the process dies of the signal", { skip: !POSIX }, async () => {
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
      `const result = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(41))});`,
      `writeFileSync(${JSON.stringify(`${logPath}.result`)}, JSON.stringify(result.ok));`,
      `setTimeout(() => {}, 3000);`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const exited = exitOf(child);
  await waitFor(() => existsSync(marker), 10_000);
  assert.ok(existsSync(`${logPath}.lock`), "the child holds the lock mid-append");
  child.kill("SIGTERM");
  const { signal } = await exited;
  assert.equal(signal, "SIGTERM", "the process died of the signal, as it would have");
  assert.equal(existsSync(`${logPath}.lock`), false, "and left no lockfile behind");
  assert.equal(readFileSync(`${logPath}.result`, "utf8"), "true", "the append it was in finished first");
  assert.deepEqual(events(logPath), ["task.registered", "approval.granted"]);
  assert.equal(verify(logPath).status, "clean");
});

for (const [step, label, stale] of [
  ["after-open", "between the create and the holder record", false],
  ["before-take", "between a reclaim's own lockfile and its take", true],
  // R3-1: the claim is the reclaim's first durable state, so the guard covers it.
  ["claimed", "between a reclaim's claim and its take", true],
] as const) {
  test(`a SIGTERM ${label} leaves no lockfile and no stale name, and the process dies of it once the lock is released`, { skip: !POSIX }, () => {
    const logPath = freshLog();
    if (stale) writeLock(logPath, holder({ pid: deadPid() }));
    counter += 1;
    const result = join(scratch, `window-${String(counter)}.result`);
    const script = join(scratch, `window-${String(counter)}.mjs`);
    writeFileSync(
      script,
      [
        `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
        `import { setLockSeamForTests } from ${JSON.stringify(LOCK_MODULE)};`,
        `import { writeFileSync } from "node:fs";`,
        `let sent = false;`,
        `setLockSeamForTests((step) => { if (step === ${JSON.stringify(step)} && !sent) { sent = true; process.kill(process.pid, "SIGTERM"); } });`,
        `const r = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(42))}, { lockTimeoutMs: 0 });`,
        `writeFileSync(${JSON.stringify(result)}, JSON.stringify(r.ok));`,
        `setTimeout(() => {}, 3000);`,
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, [script], { timeout: 10_000 });
    assert.equal(run.signal, "SIGTERM", "the process died of the signal");
    assert.equal(existsSync(`${logPath}.lock`), false, "no lockfile is left behind");
    assert.equal(readFileSync(result, "utf8"), "true", "the append under the lock finished first");
    assert.deepEqual(events(logPath), stale ? ["task.registered", "audit.lock_reclaimed", "approval.granted"] : ["task.registered", "approval.granted"]);
    assert.deepEqual(residue(logPath), [], "no stale name or take file is left behind");
    assert.equal(verify(logPath).status, "clean");
  });
}

// ---------------------------------------------------------------------------
// Synchronous waits after an append answer a signal at once (kept from round 1)
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

test("`approval policy amend` waiting on its prompt dies of SIGINT at once, not when its wait ends", { skip: !POSIX }, async () => {
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
  await waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes('"policy.proposed"'), 15_000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const sentAt = Date.now();
  child.kill("SIGINT");
  const { signal } = await exited;
  const elapsed = Date.now() - sentAt;
  assert.equal(signal, "SIGINT", "the process died of the signal");
  assert.ok(elapsed < 4_000, `it died ${String(elapsed)} ms after the signal, not at the end of its 12 s wait`);
  assert.equal(existsSync(`${logPath}.lock`), false, "and left no lockfile");
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

test("`approval run`: a SIGTERM during the execution.started append ends the process before the command starts", { skip: !POSIX }, async () => {
  counter += 1;
  mkdirSync(join(scratch, `run-${String(counter)}`), { recursive: true });
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
  assert.equal(events(logPath).at(-1), "execution.started", "the append it was in finished, and nothing ran after it");
  assert.equal(existsSync(`${logPath}.lock`), false);
});

// ---------------------------------------------------------------------------
// `approval log unlock`: the human verb
// ---------------------------------------------------------------------------

test("unlock takes a lock no writer would (another pid namespace or boot), and records the person under the lock it took", () => {
  const logPath = freshLog();
  const self = selfIdentity();
  const foreign = LINUX ? { pidns: "pid:[1]" } : { boot: `~${String(Number((self.boot ?? "~0").slice(1)) - 3 * BOOT_SLACK_S)}` };
  const left = holder({ pid: 31, ...foreign });
  writeLock(logPath, left);
  assert.match(refused(logPath, 50), /approval log unlock --pid 31/u);

  const result = unlockAppendLock(logPath, 31, "human:carter");
  assert.equal(result.kind, "unlocked");
  const reclaim = records(logPath)[1] as EventRecord;
  assert.equal(reclaim.event, "audit.lock_reclaimed");
  assert.equal(reclaim.actor, "human:carter");
  assert.equal(reclaim.payload?.["reason"], "operator-cleared", "a person's word, never recorded as a writer's proof");
  assert.deepEqual(reclaim.payload?.["holder"], { pid: 31, op: "append", created: left.created });
  assert.equal(existsSync(`${logPath}.lock`), false);
  assert.deepEqual(residue(logPath), []);
  assert.ok(appendEvent(logPath, granted(51), { lockTimeoutMs: 40 }).ok);
  assert.equal(verify(logPath).status, "clean");
});

test("unlock refuses a --pid that is not the lockfile's, a holder it sees running, and a non-lockfile; nothing is touched", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: 31, pidns: "pid:[1]", boot: "~1" }));
  const bytes = readFileSync(`${logPath}.lock`);
  const wrong = unlockAppendLock(logPath, 32, "human:carter");
  assert.equal(wrong.kind, "refused");
  if (wrong.kind === "refused") assert.match(wrong.message, /names pid 31, not pid 32/u);
  assert.equal(unlockAppendLock(logPath, null, "human:carter").kind, "refused");
  assert.deepEqual(readFileSync(`${logPath}.lock`), bytes);

  writeLock(logPath, holder());
  const running = unlockAppendLock(logPath, process.pid, "human:carter");
  assert.equal(running.kind, "refused");
  if (running.kind === "refused") assert.match(running.message, /is running.*stop that process/u);

  writeLock(logPath, "{not json\n");
  const malformed = unlockAppendLock(logPath, null, "human:carter");
  assert.equal(malformed.kind, "refused");
  if (malformed.kind === "refused") assert.match(malformed.message, /rm -v /u);
  assert.deepEqual(events(logPath), ["task.registered"]);
  assert.deepEqual(residue(logPath), []);
  rmSync(`${logPath}.lock`);
  assert.equal(unlockAppendLock(logPath, 31, "human:carter").kind, "none");
});

test("unlock --pid none takes an empty lockfile at once and records no holder", () => {
  const logPath = freshLog();
  writeLock(logPath, "");
  assert.equal(unlockAppendLock(logPath, null, "human:carter").kind, "unlocked");
  const reclaim = records(logPath)[1] as EventRecord;
  assert.equal(reclaim.payload?.["reason"], "operator-cleared");
  assert.equal(reclaim.payload?.["holder"], undefined);
  assert.equal(verify(logPath).status, "clean");
});

test("the CLI verb: `approval log unlock` is human-only, says what it did, and the hook classifies it policy.core", () => {
  const logPath = freshLog();
  const store = dirname(dirname(logPath));
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  writeLock(logPath, holder({ pid: 31, pidns: "pid:[1]", boot: "~1" }));
  const cli = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [CLI_ENTRY, "log", "unlock", "--log", logPath, ...args], { cwd: store, env, encoding: "utf8" });

  assert.equal(cli(["--pid", "31", "--as", "agent:planner", "--json"]).status, 2, "an agent actor is a usage error");
  assert.equal(cli(["--pid", "31", "--json"]).status, 2, "no human identity is a usage error");
  assert.equal(cli(["--as", "human:carter"]).status, 2, "--pid is required");
  const wrong = cli(["--pid", "32", "--as", "human:carter", "--json"]);
  assert.equal(wrong.status, 4);
  assert.equal((JSON.parse(String(wrong.stderr)) as { error: { code: string } }).error.code, "unlock-refused");

  const done = cli(["--pid", "31", "--as", "human:carter", "--json"]);
  assert.equal(done.status, 0, String(done.stderr));
  const out = JSON.parse(String(done.stdout)) as { ok: boolean; unlocked: boolean; seq: number; actor: string };
  assert.deepEqual([out.ok, out.unlocked, out.seq, out.actor], [true, true, 2, "human:carter"]);
  const again = cli(["--pid", "31", "--as", "human:carter", "--json"]);
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(String(again.stdout)), { ok: true, unlocked: false });

  const classified = classifyCommand("approval log unlock --pid 31 --as human:carter");
  assert.ok(classified.ok);
  if (classified.ok) assert.deepEqual(classified.classes, ["policy.core"]);
  // R3-6: whichever launcher spells it.
  for (const command of ["npx approval log unlock --pid 5", "npx approval log checkpoint", "npx approval gate open"]) {
    const viaNpx = classifyCommand(command);
    assert.ok(viaNpx.ok, command);
    if (viaNpx.ok) assert.equal(viaNpx.segments[0]?.class, "policy.core", command);
  }
});

// ---------------------------------------------------------------------------
// Real Linux, in a disposable privileged container
// ---------------------------------------------------------------------------

/**
 * These remount `/proc` or unshare a pid namespace, which only root in a
 * throwaway container should do. They run when APPROVAL_LOCK_TEST_PRIVILEGED=1
 * on Linux as root, and are skipped (saying why) everywhere else, CI included:
 * the decision table above pins the same judgements on every platform.
 */
const PRIVILEGED =
  LINUX && process.env["APPROVAL_LOCK_TEST_PRIVILEGED"] === "1" && ROOT
    ? false
    : "needs Linux, root, and APPROVAL_LOCK_TEST_PRIVILEGED=1 in a disposable container (it remounts /proc or unshares a pid namespace)";

/** A holder child that stalls 2.5 s inside its append, holding the lock. */
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
      `const result = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(60))});`,
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
      `const result = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(61))}, { lockTimeoutMs: 400, lockRetryMs: 5 });`,
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

test("hidepid: a reader of another uid finds a live holder's lock held (EPERM), never takes it", { skip: PRIVILEGED }, async () => {
  const remount = spawnSync("mount", ["-o", "remount,hidepid=invisible", "/proc"], { encoding: "utf8" });
  assert.equal(remount.status, 0, `remount /proc hidepid=invisible: ${remount.stderr}`);
  try {
    const logPath = sharedLog("hidepid");
    const marker = join(dirname(dirname(logPath)), "m");
    const holderExit = exitOf(spawn(process.execPath, [holderScript(logPath, marker)], { uid: 1000, gid: 1000, stdio: "ignore" }));
    await waitFor(() => existsSync(`${marker}.writing`), 10_000);
    assert.equal(spawnSync(process.execPath, [readerScript(logPath, marker)], { uid: 65534, gid: 65534 }).status, 0);
    const result = JSON.parse(readFileSync(`${marker}.reader-result`, "utf8")) as { ok: boolean; code?: string; message?: string };
    assert.equal(result.ok, false, "the reader did not take the live holder's lock");
    assert.equal(result.code, "lock-timeout");
    assert.match(result.message ?? "", /EPERM/u);
    assert.equal((await holderExit).code, 0);
    assert.deepEqual(events(logPath), ["task.registered", "approval.granted"]);
    assert.equal(verify(logPath).status, "clean");
  } finally {
    const restore = spawnSync("mount", ["-o", "remount,hidepid=0", "/proc"], { encoding: "utf8" });
    if (restore.status !== 0) spawnSync("mount", ["-o", "remount,hidepid=off", "/proc"]);
  }
});

test("a pid namespace whose /proc was not remounted: a reader keeps a live holder's lock, never takes it", { skip: PRIVILEGED }, () => {
  const logPath = sharedLog("pidns");
  const marker = join(dirname(dirname(logPath)), "m");
  const holderPath = holderScript(logPath, marker);
  const reader = readerScript(logPath, marker);
  const driver = `${marker}.driver.mjs`;
  writeFileSync(
    driver,
    [
      `import { spawn, spawnSync } from "node:child_process";`,
      `import { existsSync, readlinkSync } from "node:fs";`,
      `const ownProc = readlinkSync("/proc/self") === String(process.pid);`,
      `for (let n = 0; n < 64; n += 1) spawnSync("true");`,
      `const h = spawn(process.execPath, [${JSON.stringify(holderPath)}], { stdio: "ignore" });`,
      `const done = new Promise((resolve) => h.on("exit", resolve));`,
      `while (!existsSync(${JSON.stringify(`${marker}.writing`)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
      `spawnSync(process.execPath, [${JSON.stringify(reader)}]);`,
      `await done;`,
      `console.log(JSON.stringify({ ownProc }));`,
    ].join("\n"),
  );
  const run = spawnSync("unshare", ["--pid", "--fork", process.execPath, driver], { encoding: "utf8" });
  assert.equal(run.status, 0, `unshare: ${run.stderr}`);
  const inside = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as { ownProc?: boolean };
  assert.equal(inside.ownProc, false, "the case requires a /proc from another pid namespace");
  const result = JSON.parse(readFileSync(`${marker}.reader-result`, "utf8")) as { ok: boolean; code?: string; message?: string };
  assert.equal(result.ok, false);
  assert.equal(result.code, "lock-timeout");
  assert.match(result.message ?? "", /\/proc belongs to another pid namespace/u);
  assert.deepEqual(events(logPath), ["task.registered", "approval.granted"]);
  assert.equal(verify(logPath).status, "clean");
});

test("two pid namespaces on one volume: a dead holder's lock from container A is kept by container B, and unlock clears it", { skip: PRIVILEGED }, () => {
  const logPath = sharedLog("twons");
  const base = dirname(dirname(logPath));
  const plant = join(base, "plant.mjs");
  writeFileSync(
    plant,
    [
      `import { spawnSync } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `import { holderRecord } from ${JSON.stringify(LOCK_MODULE)};`,
      `const dead = spawnSync(process.execPath, ["--version"]).pid;`,
      `writeFileSync(${JSON.stringify(`${logPath}.lock`)}, JSON.stringify({ ...holderRecord("append", new Date(Date.now() - 60000)), pid: dead }) + "\\n");`,
      `console.log(dead);`,
    ].join("\n"),
  );
  const inA = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", process.execPath, plant], { encoding: "utf8" });
  assert.equal(inA.status, 0, `container A: ${inA.stderr}`);
  const pid = Number(inA.stdout.trim());
  const b = join(base, "b.mjs");
  writeFileSync(
    b,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE)};`,
      `const r = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(62))}, { lockTimeoutMs: 100 });`,
      `console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, message: r.error.message }));`,
    ].join("\n"),
  );
  const inB = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", process.execPath, b], { encoding: "utf8" });
  assert.equal(inB.status, 0, `container B: ${inB.stderr}`);
  const result = JSON.parse(inB.stdout.trim()) as { ok: boolean; message?: string };
  // The kernel may hand B the namespace inode A had; then the pid decides, and it is dead.
  if (!result.ok) {
    assert.match(result.message ?? "", new RegExp(`another pid namespace.*approval log unlock --pid ${String(pid)}`, "u"));
    assert.equal(unlockAppendLock(logPath, pid, "human:carter").kind, "unlocked");
  }
  assert.equal(events(logPath)[1], "audit.lock_reclaimed");
  assert.equal(verify(logPath).status, "clean");
});

test("two uids: a lockfile only its owner or root may link (fs.protected_hardlinks) is kept, and both refusals name the owner and `rm -v` (R3-4)", { skip: PRIVILEGED }, (t) => {
  if (readFileSync("/proc/sys/fs/protected_hardlinks", "utf8").trim() !== "1") {
    t.skip("needs fs.protected_hardlinks=1");
    return;
  }
  const logPath = sharedLog("xuid");
  const base = dirname(dirname(logPath));
  // The hook (uid 1000, umask 022) was SIGKILLed holding the lock: 0644, its own.
  writeLock(logPath, holder({ pid: deadPid() }));
  chownSync(`${logPath}.lock`, 1000, 1000);
  chmodSync(`${logPath}.lock`, 0o644);
  const lockBytes = readFileSync(`${logPath}.lock`);
  const daemon = join(base, "daemon.mjs");
  writeFileSync(
    daemon,
    [
      `import { appendEvent, unlockAppendLock } from ${JSON.stringify(LOG_MODULE)};`,
      `import { readFileSync, writeFileSync } from "node:fs";`,
      `const pid = JSON.parse(readFileSync(${JSON.stringify(`${logPath}.lock`)}, "utf8")).pid;`,
      `const r = appendEvent(${JSON.stringify(logPath)}, ${JSON.stringify(granted(63))}, { lockTimeoutMs: 0 });`,
      `const u = unlockAppendLock(${JSON.stringify(logPath)}, pid, "human:carter");`,
      `writeFileSync(${JSON.stringify(join(base, "daemon-result"))}, JSON.stringify({ writer: r.ok ? "ok" : r.error.message, unlock: u.kind === "refused" ? u.message : u.kind }));`,
    ].join("\n"),
  );
  chmodSync(daemon, 0o644);
  // The daemon runs as uid 1001.
  const run = spawnSync(process.execPath, [daemon], { uid: 1001, gid: 1001, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(readFileSync(join(base, "daemon-result"), "utf8")) as { writer: string; unlock: string };
  for (const message of [result.writer, result.unlock]) {
    assert.match(message, /link: EPERM\): it is owned by uid 1000/u);
    assert.match(message, /as that user or root, or `rm -v .*events\.jsonl\.lock` once no writer runs/u);
  }
  assert.deepEqual(readFileSync(`${logPath}.lock`), lockBytes, "the lock is untouched");
  assert.deepEqual(residue(logPath), [], "the daemon's own lockfile went with its failed claim");
  assert.deepEqual(events(logPath), ["task.registered"]);
});
