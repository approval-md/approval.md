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
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appendEvent, withAppendLock, type EventInput, type EventRecord } from "../src/core/log.js";
import {
  describeLogLock,
  holderRecord,
  judgeHolder,
  LEGACY_LOCK_RECLAIM_AGE_MS,
  parseProcStat,
  selfIdentity,
  setLockLivenessForTests,
  tryReclaimLock,
  type LivenessProbe,
  type LockHolder,
  type SelfIdentity,
} from "../src/core/log-lock.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-lock-reclaim-"));
after(() => {
  setLockLivenessForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log.js")).href;
const WRITE_LAYER_MODULE = pathToFileURL(join(REPO_ROOT, "dist", "src", "core", "log-write-layer.js")).href;

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

/** Names in the log's directory that a reclaim may have left behind. */
function residue(logPath: string): string[] {
  const dir = join(logPath, "..");
  return readdirSync(dir).filter((name) => name.includes(".reclaim-"));
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

test("a reclaim already claimed by another writer is left to it, and an abandoned claim is cleared for the next wait", () => {
  const logPath = freshLog();
  writeLock(logPath, holder({ pid: deadPid() }));
  // Another reclaimer's claim: the exclusive link, named by the lockfile's inode.
  const lockPath = `${logPath}.lock`;
  const first = tryReclaimLock(logPath, Date.now());
  assert.equal(first.kind, "reclaimed", "the first claim succeeds and removes the lock");
  // Put a stale lock back and take the claim by hand, as a reclaimer killed
  // between its link and its rename would leave it.
  writeLock(logPath, holder({ pid: deadPid() }));
  const ino = statSync(lockPath, { bigint: true }).ino.toString();
  linkSync(lockPath, `${lockPath}.reclaim-${ino}.lock`);
  const busy = tryReclaimLock(logPath, Date.now());
  assert.equal(busy.kind, "kept");
  if (busy.kind === "kept") assert.match(busy.why, /another writer is reclaiming it now/u);
  const later = tryReclaimLock(logPath, Date.now() + 60_000);
  assert.equal(later.kind, "kept");
  if (later.kind === "kept") assert.match(later.why, /abandoned reclaim of it was cleared/u);
  assert.equal(tryReclaimLock(logPath).kind, "reclaimed", "the next wait reclaims it");
  assert.deepEqual(residue(logPath), []);
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
  const probe = (stat: { state: string; start: string } | null, exists: boolean): LivenessProbe => ({
    linuxStat: () => stat,
    pidExists: () => exists,
  });

  const cases: Array<[string, ReturnType<typeof judgeHolder>["state"], string | undefined, ReturnType<typeof judgeHolder>]> = [
    ["linux: no such pid", "gone", "holder-dead", judgeHolder(linuxHolder(), linuxSelf, probe(null, false))],
    ["linux: zombie", "gone", "holder-dead", judgeHolder(linuxHolder(), linuxSelf, probe({ state: "Z", start: "300" }, true))],
    ["linux: pid reused", "gone", "holder-replaced", judgeHolder(linuxHolder(), linuxSelf, probe({ state: "S", start: "999" }, true))],
    ["linux: same process", "live", undefined, judgeHolder(linuxHolder(), linuxSelf, probe({ state: "S", start: "300" }, true))],
    ["linux: another pid namespace", "live", undefined, judgeHolder(linuxHolder({ pidns: "pid:[2]" }), linuxSelf, probe(null, false))],
    ["linux: earlier boot, same host", "gone", "holder-boot-ended", judgeHolder(linuxHolder({ boot: "boot-b" }), linuxSelf, probe({ state: "S", start: "300" }, true))],
    ["linux: other boot, other host", "live", undefined, judgeHolder(linuxHolder({ boot: "boot-b", host: "elsewhere" }), linuxSelf, probe(null, false))],
    ["linux: record without boot", "live", undefined, judgeHolder(linuxHolder({ boot: "" }), linuxSelf, probe(null, false))],
    ["linux: record without start", "live", undefined, judgeHolder(noStart, linuxSelf, probe({ state: "S", start: "300" }, true))],
    ["linux: written off Linux", "live", undefined, judgeHolder(otherHolder(), linuxSelf, probe(null, false))],
    ["other: no such pid", "gone", "holder-dead", judgeHolder(otherHolder(), otherSelf, probe(null, false))],
    ["other: pid exists", "live", undefined, judgeHolder(otherHolder(), otherSelf, probe(null, true))],
    ["other: another host", "live", undefined, judgeHolder(otherHolder({ host: "elsewhere" }), otherSelf, probe(null, false))],
    ["other: host rebooted since", "gone", "holder-boot-ended", judgeHolder(otherHolder({ boot: "~900000" }), otherSelf, probe(null, true))],
    ["other: written on Linux", "live", undefined, judgeHolder(linuxHolder(), otherSelf, probe(null, false))],
  ];
  for (const [name, state, reason, verdict] of cases) {
    assert.equal(verdict.state, state, name);
    if (verdict.state === "gone") assert.equal(verdict.reason, reason, name);
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
  const verdict = judgeHolder(holder(), selfIdentity(), {
    linuxStat: (pid) => {
      const text = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      return parseProcStat(text);
    },
    pidExists: () => true,
  });
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
