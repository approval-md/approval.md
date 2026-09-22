/**
 * The per-gate Telegram transport lease (APRV-424, review finding 1).
 *
 * The finding this file reproduces: an `approval up` long-polling and an
 * `approval channel telegram webhook` started in the SAME project both passed
 * every check that existed. `getWebhookInfo` was empty, because the poller
 * registers nothing; the per-machine ownership registry compared instance ids,
 * which were equal because it was one instance. Each process then ran its own
 * dispatch cycle over its own `DispatchState` against one log, so every pending
 * request reached the phone twice under two nonces and only the webhook copy
 * could resolve a tap.
 *
 * So the four cases the fix is judged on are here: a poller refuses a webhook,
 * a webhook refuses a poller, a lease whose process is gone is reclaimed rather
 * than fatal, and a clean stop gives the gate back. The lease is a pid, so a
 * second PROCESS is what a test has to stand in for: `pid` and `alive` are
 * injectable for exactly that, and nothing here signals anything.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  channelLeaseDirFor,
  channelLeasePathFor,
  pidIsAlive,
  readChannelLease,
  takeChannelLease,
  CHANNEL_LEASE_FILE,
  CHANNEL_LEASE_REFUSAL_CODES,
  type ChannelLeaseMode,
  type ChannelLeaseRefusalCode,
} from "../src/core/channel-lease.js";
import { scratchRoot } from "./scenario.js";

const scratch = scratchRoot("channel-lease");
let gates = 0;

after(() => {
  scratch.cleanup();
});

/** A fresh gate's log path. No log is written: the lease derives from the PATH. */
function gate(): string {
  gates += 1;
  const logPath = join(scratch.root, `gate-${String(gates)}`, ".approval", "log", "events.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  return logPath;
}

/** A pid that is not this process and is not running. */
const DEAD_PID = 999_001;

/** Stands in for a second, live process. */
const OTHER_PID = 999_002;
const otherIsAlive = (pid: number): boolean => pid === OTHER_PID;

test("the lease lives in the gate's own derived daemon directory (APRV-424)", () => {
  const logPath = gate();
  assert.equal(channelLeaseDirFor(logPath), join(dirname(dirname(logPath)), "daemon"));
  assert.equal(channelLeasePathFor(logPath), join(channelLeaseDirFor(logPath), CHANNEL_LEASE_FILE));
  // `.approval/daemon/` is the directory `.gitignore` already holds whole, and
  // the one `core/live-draw.ts` puts the daemon's socket in: derived per-gate
  // runtime state a clone must not inherit.
  assert.match(channelLeasePathFor(logPath), /\.approval\/daemon\//u);
  assert.equal(readChannelLease(logPath), null, "a gate that has never run holds a lease");
});

test("a poller holding the gate refuses a webhook, naming its pid and mode (APRV-424)", () => {
  const logPath = gate();

  // Another process, long-polling this gate.
  const held = takeChannelLease(logPath, "poll", { pid: OTHER_PID, alive: otherIsAlive });
  assert.equal(held.ok, true, JSON.stringify(held));

  const refused = takeChannelLease(logPath, "webhook", { alive: otherIsAlive });
  assert.equal(refused.ok, false, "a webhook runner started beside a live poller");
  if (refused.ok) return;
  assert.equal(refused.code, "telegram-poller-running");
  assert.ok(
    CHANNEL_LEASE_REFUSAL_CODES.includes(refused.code as ChannelLeaseRefusalCode),
    `${refused.code} is not in the frozen union`,
  );
  assert.equal(refused.holder?.pid, OTHER_PID);
  assert.equal(refused.holder?.mode, "poll");
  // The pid and the mode are what an operator acts on, and the path is the
  // recovery of last resort, so all three are in the sentence.
  assert.match(refused.message, new RegExp(`pid ${String(OTHER_PID)}`, "u"));
  assert.match(refused.message, /poll mode/u);
  assert.match(refused.message, /telegram-transport\.lock/u);
  // And the refusal took nothing: the holder's record is untouched.
  assert.equal(readChannelLease(logPath)?.pid, OTHER_PID);
});

test("a webhook holding the gate refuses a poller (APRV-424)", () => {
  const logPath = gate();
  const held = takeChannelLease(logPath, "webhook", { pid: OTHER_PID, alive: otherIsAlive });
  assert.equal(held.ok, true, JSON.stringify(held));

  const refused = takeChannelLease(logPath, "poll", { alive: otherIsAlive });
  assert.equal(refused.ok, false, "a poller started beside a live webhook runner");
  if (refused.ok) return;
  // The same code the Bot API probe uses, because it is the same repair: stop
  // the webhook runner, which removes its registration as it exits.
  assert.equal(refused.code, "webhook-registered");
  assert.equal(refused.holder?.mode, "webhook");
  assert.match(refused.message, new RegExp(`pid ${String(OTHER_PID)}`, "u"));
});

test("two of one transport refuse each other as well (APRV-424)", () => {
  const logPath = gate();
  takeChannelLease(logPath, "poll", { pid: OTHER_PID, alive: otherIsAlive });
  const second = takeChannelLease(logPath, "poll", { alive: otherIsAlive });
  assert.equal(second.ok, false, "two pollers took one gate");
  if (!second.ok) assert.equal(second.code, "telegram-poller-running");
});

test("a lease whose process is gone is reclaimed, not fatal (APRV-424)", () => {
  const logPath = gate();
  const crashed = takeChannelLease(logPath, "webhook", { pid: DEAD_PID, alive: () => true });
  assert.equal(crashed.ok, true, JSON.stringify(crashed));
  assert.ok(existsSync(channelLeasePathFor(logPath)), "the crashed process left no lease behind");

  // The real probe, which is what runs in production: DEAD_PID is not running.
  assert.equal(pidIsAlive(DEAD_PID), false);
  const taken = takeChannelLease(logPath, "poll");
  assert.equal(taken.ok, true, `a dead lease locked the gate out: ${JSON.stringify(taken)}`);
  if (!taken.ok) return;
  assert.equal(taken.reclaimed?.pid, DEAD_PID, "the reclaim was silent about whose lease it was");
  assert.equal(taken.reclaimed?.mode, "webhook");
  assert.equal(readChannelLease(logPath)?.pid, process.pid);
  assert.equal(readChannelLease(logPath)?.mode, "poll");
  taken.lease.release();
});

test("an unreadable lease is reclaimed rather than locking the gate (APRV-424)", () => {
  const logPath = gate();
  mkdirSync(channelLeaseDirFor(logPath), { recursive: true });
  writeFileSync(channelLeasePathFor(logPath), "{ half a fi", "utf8");
  assert.equal(readChannelLease(logPath), null);

  const taken = takeChannelLease(logPath, "poll");
  assert.equal(taken.ok, true, `a torn lease locked the gate out: ${JSON.stringify(taken)}`);
  if (taken.ok) {
    assert.equal(readChannelLease(logPath)?.pid, process.pid);
    taken.lease.release();
  }
});

test("both transports release the lease on a clean stop (APRV-424)", () => {
  const logPath = gate();
  for (const mode of ["poll", "webhook"] as const satisfies readonly ChannelLeaseMode[]) {
    const taken = takeChannelLease(logPath, mode);
    assert.equal(taken.ok, true, JSON.stringify(taken));
    if (!taken.ok) return;
    assert.equal(readChannelLease(logPath)?.mode, mode);

    taken.lease.release();
    assert.equal(existsSync(channelLeasePathFor(logPath)), false, `a ${mode} stop left its lease`);
    // Idempotent: a stop path that runs twice (a signal, then the promise
    // settling) must not throw and must not delete a later process's lease.
    taken.lease.release();

    // And the gate is free for the other transport at once, which is the whole
    // point of releasing: swapping transports must not need a stale-lock wait.
    const next = takeChannelLease(logPath, mode === "poll" ? "webhook" : "poll", {
      pid: OTHER_PID,
      alive: otherIsAlive,
    });
    assert.equal(next.ok, true, "a released gate refused the other transport");
    if (next.ok) next.lease.release();
  }
});

test("a release never removes another process's lease (APRV-424)", () => {
  const logPath = gate();
  const mine = takeChannelLease(logPath, "poll");
  assert.equal(mine.ok, true);
  if (!mine.ok) return;

  // A crash, then a second process taking the gate over: the first process's
  // stop path must not delete the second's lease on its way out.
  writeFileSync(
    channelLeasePathFor(logPath),
    `${JSON.stringify({
      version: 1,
      pid: OTHER_PID,
      mode: "webhook",
      started_at: new Date().toISOString(),
      instance_home: dirname(dirname(logPath)),
    })}\n`,
    "utf8",
  );
  mine.lease.release();
  assert.equal(
    readChannelLease(logPath)?.pid,
    OTHER_PID,
    "a stale stop path deleted the live holder's lease",
  );
});

test("one process re-taking its own gate rewrites the record (APRV-424)", () => {
  const logPath = gate();
  const first = takeChannelLease(logPath, "poll");
  assert.equal(first.ok, true);
  const again = takeChannelLease(logPath, "webhook");
  // One process runs one transport, and the in-process guard against two is
  // `TelegramChannel.claimTransport`. A supervisor restarting its own channel
  // part must not have to fight its own lockfile.
  assert.equal(again.ok, true, "a process was refused its own lease");
  if (again.ok) {
    assert.equal(readChannelLease(logPath)?.mode, "webhook");
    assert.equal(readChannelLease(logPath)?.pid, process.pid);
    again.lease.release();
  }
});

test("the lease record carries the pid, the mode and when it started (APRV-424)", () => {
  const logPath = gate();
  const taken = takeChannelLease(logPath, "webhook", { now: () => new Date("2026-09-21T10:00:00Z") });
  assert.equal(taken.ok, true);
  if (!taken.ok) return;
  const raw = JSON.parse(readFileSync(channelLeasePathFor(logPath), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(raw["version"], 1);
  assert.equal(raw["pid"], process.pid);
  assert.equal(raw["mode"], "webhook");
  assert.equal(raw["started_at"], "2026-09-21T10:00:00.000Z");
  assert.equal(raw["instance_home"], dirname(dirname(logPath)));
  taken.lease.release();
});

test("an unwritable gate refuses rather than promising exclusion it cannot keep (APRV-424)", () => {
  // A path whose parent is a FILE: the lease directory cannot be created, so
  // there is no lockfile and no exclusion. Unlike the bot registry, whose
  // absence is the status quo, this one is the only thing keeping a gate from
  // running two transports, so the refusal is the honest answer.
  const blocked = join(scratch.root, "blocked");
  mkdirSync(blocked, { recursive: true });
  const asFile = join(blocked, ".approval");
  writeFileSync(asFile, "not a directory\n", "utf8");
  const refused = takeChannelLease(join(asFile, "log", "events.jsonl"), "poll");
  assert.equal(refused.ok, false, "a gate with nowhere to write a lease started anyway");
  if (!refused.ok) {
    assert.equal(refused.code, "telegram-lease-unavailable");
    assert.equal(refused.holder, null);
    assert.match(refused.message, /telegram-transport\.lock/u);
  }
});
