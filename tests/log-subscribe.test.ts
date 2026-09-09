/** Verified, resumable log subscription tests (APRV-322). */

import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { appendEvent, type EventInput, type EventRecord } from "../src/core/log.js";
import {
  LogSubscriptionError,
  subscribeVerifiedLog,
} from "../src/core/log-subscribe.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-log-subscribe-"));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function freshLog(): string {
  counter += 1;
  return join(scratch, `case-${String(counter)}`, "events.jsonl");
}

function input(id: number): EventInput {
  return {
    ts: `2026-09-08T20:00:${String(id % 60).padStart(2, "0")}Z`,
    event: "task.registered",
    actor: "agent:listener-test",
    task: `task-${String(id)}`,
    channel: "cli",
    payload: { title: `Task ${String(id)}` },
  };
}

function append(logPath: string, id: number): EventRecord {
  const result = appendEvent(logPath, input(id));
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("unreachable");
  return result.record;
}

async function failureOf(next: Promise<IteratorResult<EventRecord>>): Promise<LogSubscriptionError> {
  try {
    await next;
  } catch (cause) {
    assert.ok(cause instanceof LogSubscriptionError, String(cause));
    return cause;
  }
  throw new Error("subscription unexpectedly produced a record");
}

test("replays after an exclusive cursor and resumes with its retained hash", async () => {
  const logPath = freshLog();
  const first = append(logPath, 1);
  const second = append(logPath, 2);
  const third = append(logPath, 3);

  const stream = subscribeVerifiedLog(logPath, { from: 2, expectedHash: second.hash });
  assert.deepEqual(await stream.next(), { value: third, done: false });
  await stream.return();

  const restarted = subscribeVerifiedLog(logPath, { from: 1, expectedHash: first.hash });
  assert.equal((await restarted.next()).value?.seq, 2);
  assert.equal((await restarted.next()).value?.seq, 3);
  await restarted.return();
});

test("watch setup cannot lose an append made while the first pull is pending", async () => {
  const logPath = freshLog();
  mkdirSync(dirname(logPath), { recursive: true });
  const controller = new AbortController();
  const stream = subscribeVerifiedLog(logPath, {
    signal: controller.signal,
    pollIntervalMs: 2_000,
  });
  const pending = stream.next();
  const record = append(logPath, 1);
  assert.deepEqual(await pending, { value: record, done: false });
  controller.abort();
  assert.equal((await stream.next()).done, true);
});

test("multiple real appends are delivered in chain order after one coalesced wakeup", async () => {
  const logPath = freshLog();
  mkdirSync(dirname(logPath), { recursive: true });
  const controller = new AbortController();
  const stream = subscribeVerifiedLog(logPath, {
    signal: controller.signal,
    pollIntervalMs: 2_000,
  });
  const pending = stream.next();
  const records = [append(logPath, 1), append(logPath, 2), append(logPath, 3)];
  assert.equal((await pending).value?.seq, records[0]?.seq);
  assert.equal((await stream.next()).value?.seq, records[1]?.seq);
  assert.equal((await stream.next()).value?.seq, records[2]?.seq);
  controller.abort();
  await stream.next();
});

test("bounded polling follows creation when no directory watcher can be installed", async () => {
  const logPath = freshLog();
  const controller = new AbortController();
  const stream = subscribeVerifiedLog(logPath, { signal: controller.signal, pollIntervalMs: 5 });
  const pending = stream.next();
  const record = append(logPath, 1);
  assert.deepEqual(await pending, { value: record, done: false });
  controller.abort();
  await stream.next();
});

test("a slow consumer receives the frozen verified batch before later appends", async () => {
  const logPath = freshLog();
  append(logPath, 1);
  append(logPath, 2);
  append(logPath, 3);
  const stream = subscribeVerifiedLog(logPath, { pollIntervalMs: 2_000 });

  assert.equal((await stream.next()).value?.seq, 1);
  for (let id = 4; id <= 40; id += 1) append(logPath, id);
  assert.equal((await stream.next()).value?.seq, 2);
  assert.equal((await stream.next()).value?.seq, 3);
  assert.equal((await stream.next()).value?.seq, 4);
  await stream.return();
});

test("consumer mutation cannot alter the iterator's verified continuation cursor", async () => {
  const logPath = freshLog();
  append(logPath, 1);
  append(logPath, 2);
  const stream = subscribeVerifiedLog(logPath);
  const first = await stream.next();
  assert.equal(first.done, false);
  if (first.done) throw new Error("unreachable");
  first.value.seq = 999;
  first.value.hash = "0".repeat(64);
  assert.equal((await stream.next()).value?.seq, 2);
  await stream.return();
});

test("cancellation resolves a pending pull and cleans up promptly", async () => {
  const logPath = freshLog();
  const controller = new AbortController();
  const stream = subscribeVerifiedLog(logPath, {
    signal: controller.signal,
    pollIntervalMs: 60_000,
  });
  const pending = stream.next();
  controller.abort();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("a wrong cursor hash refuses before emitting anything", async () => {
  const logPath = freshLog();
  append(logPath, 1);
  append(logPath, 2);
  const stream = subscribeVerifiedLog(logPath, { from: 1, expectedHash: "0".repeat(64) });
  const error = await failureOf(stream.next());
  assert.equal(error.kind, "integrity");
  assert.equal(error.reason, "cursor-mismatch");
});

test("a sequence-only cursor binds its first verified prefix while caught up", async () => {
  const logPath = freshLog();
  append(logPath, 1);
  const replacement = freshLog();
  append(replacement, 101);

  const stream = subscribeVerifiedLog(logPath, { from: 1, pollIntervalMs: 2_000 });
  const pending = stream.next();
  // Both files are valid one-record chains, but the second is not the prefix
  // the live subscription verified when it accepted the weak bootstrap.
  writeFileSync(logPath, readFileSync(replacement));
  append(logPath, 102);
  const error = await failureOf(pending);
  assert.equal(error.kind, "integrity");
  assert.equal(error.reason, "cursor-mismatch");
});

test("truncation behind the live cursor is refused on the next verified batch", async () => {
  const logPath = freshLog();
  append(logPath, 1);
  append(logPath, 2);
  const stream = subscribeVerifiedLog(logPath, { pollIntervalMs: 5 });
  assert.equal((await stream.next()).value?.seq, 1);
  assert.equal((await stream.next()).value?.seq, 2);
  writeFileSync(logPath, "", "utf8");
  const error = await failureOf(stream.next());
  assert.equal(error.kind, "integrity");
  assert.equal(error.reason, "cursor-mismatch");
});

test("a corrupt batch emits no intact prefix", async () => {
  const source = freshLog();
  append(source, 1);
  append(source, 2);
  const logPath = `${source}.corrupt`;
  copyFileSync(source, logPath);
  const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
  const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
  second["task"] = "tampered";
  lines[1] = JSON.stringify(second);
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

  const error = await failureOf(subscribeVerifiedLog(logPath).next());
  assert.equal(error.kind, "integrity");
  assert.equal(error.reason, "hash-mismatch");
});

test("a torn tail and an I/O failure remain distinct terminal failures", async () => {
  const source = freshLog();
  append(source, 1);
  const logPath = `${source}.torn`;
  copyFileSync(source, logPath);
  appendFileSync(logPath, '{"seq":2');
  const torn = await failureOf(subscribeVerifiedLog(logPath).next());
  assert.equal(torn.kind, "torn-tail");

  const io = await failureOf(subscribeVerifiedLog(join(scratch, `case-${String(counter)}`)).next());
  assert.equal(io.kind, "io");
});

test("invalid core cursors fail before any watcher can remain active", async () => {
  const noHashAtGenesis = subscribeVerifiedLog(freshLog(), {
    expectedHash: "0".repeat(64),
  });
  await assert.rejects(noHashAtGenesis.next(), /expectedHash requires from/u);

  const invalidPoll = subscribeVerifiedLog(freshLog(), { pollIntervalMs: 0 });
  await assert.rejects(invalidPoll.next(), /positive safe integer/u);
});
