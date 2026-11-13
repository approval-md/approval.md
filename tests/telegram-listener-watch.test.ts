/** APRV-534: filesystem hints wake the existing verified dispatch, including
 * while a real mock Bot API holds getUpdates. All event fixtures use the gate. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { type FSWatcher } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { actionRefOf, TelegramChannel, type TelegramListenOptions, type TelegramConfig } from "../src/channels/telegram.js";
import { startListener, type ListenSetup, type RunningListener } from "../src/cli/channel-telegram.js";
import { appendAttestation } from "../src/core/attest.js";
import { decide, register, request } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { assertClean, newScenario, scratchRoot } from "./scenario.js";
import { assertLocal, callbackUpdate, messageUpdate, startMockBotApi } from "./telegram-mock.js";

const TOKEN = "7654321:AA-fake-listener-watch-tests-DO-NOT-USE";
const CHAT = "9911";
const POLICY = '# Policy\n```yaml approval-policy\nversion: "0.1"\ndefaults:\n  autonomy: manual\n```\n';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out: ${why}`);
    await delay(5);
  }
}

async function fixture(t: TestContext, delivery: "burst" | "paced" = "burst", config: Partial<TelegramConfig> = {}) {
  const scratch = scratchRoot("telegram-watch");
  const unit = newScenario(scratch.root, POLICY);
  const mock = await startMockBotApi(TOKEN);
  const channel = new TelegramChannel({
    token: TOKEN, chatId: CHAT, apiBase: assertLocal(mock.url),
    pollTimeoutSeconds: 60, requestTimeoutMs: 65000, backoffMs: 5, maxBackoffMs: 20,
    log: () => {}, ...config,
  });
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter").ok, true);
  const payloads = new Map<string, unknown>();
  const errors: string[] = [];
  const outputs: string[] = [];
  const setup: ListenSetup = {
    channel, logPath: unit.logPath, actor: "human:carter", json: false, once: false,
    crossInstance: [], allowCrossInstance: false, apiBase: mock.url, delivery,
    gateOptions: unit.options,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
    checkpoint: { logPath: unit.logPath, policy: { file: unit.policyPath }, keyFile: null, vault: null },
  };
  let running: RunningListener | undefined;
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const release of releases) release();
    running?.stop();
    await running?.done.catch(() => {});
    await mock.close();
    scratch.cleanup();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  let ordinal = 0;
  const append = () => {
    ordinal += 1;
    const key = `task-${ordinal}:watch`;
    const payload = { ordinal, message: `request ${ordinal}` };
    payloads.set(key, payload);
    assert.equal(register(unit.logPath, {
      task: `task-${ordinal}`,
      envelope: { origin: { app: "manual", created_by: "agent:test" }, state: "awaiting", actions: [{
        class: "communicate.email.external", idempotency_key: key,
        summary: `watch request ${ordinal}`, reversible: false, payload_hash: payloadHash(payload),
      }] },
    }, "agent:test", unit.options).ok, true);
    const requested = request(unit.logPath, {
      task: `task-${ordinal}`, actionKey: key, cls: "communicate.email.external",
      summary: `watch request ${ordinal}`, reversible: false,
    }, "agent:test", unit.options);
    assert.equal(requested.ok, true, JSON.stringify(requested));
    return key;
  };
  const appendGrouped = () => {
    ordinal += 1;
    const task = `grouped-${ordinal}`;
    const keys = [`${task}:a`, `${task}:b`];
    const payload = { message: "same task, two declared actions" };
    for (const key of keys) payloads.set(key, payload);
    assert.equal(register(unit.logPath, {
      task,
      envelope: { origin: { app: "manual", created_by: "agent:test" }, state: "awaiting",
        actions: keys.map((key) => ({ class: "communicate.email.external", idempotency_key: key,
          summary: "grouped request", reversible: false, payload_hash: payloadHash(payload) })),
      },
    }, "agent:test", unit.options).ok, true);
    for (const key of keys) assert.equal(request(unit.logPath, {
      task, actionKey: key, cls: "communicate.email.external", summary: "grouped request", reversible: false,
    }, "agent:test", unit.options).ok, true);
    return keys;
  };
  return {
    unit, mock, channel, setup, append, appendGrouped, errors, outputs,
    releaseOnCleanup(release: () => void) { releases.push(release); },
    start() { running = startListener(setup, { out: (line) => outputs.push(line), err: (line) => errors.push(line) }); return running; },
  };
}

/** Controlled OS notification seam, leaving real stat, verified reads and sends. */
function observation(t: TestContext, options: { failAttach?: boolean } = {}) {
  let tick: (() => void) | undefined;
  let attaches = 0;
  let closed = 0;
  let cleared = 0;
  let failAttach = options.failAttach ?? false;
  const handles: EventEmitter[] = [];
  const hints: ((event: string, filename: string | null) => void)[] = [];
  t.mock.method(fs, "watch", (_path: unknown, hint: (event: string, filename: string | null) => void) => {
    attaches += 1;
    if (failAttach) throw new Error("watch budget exhausted");
    const handle = new EventEmitter();
    Object.assign(handle, { close: () => { closed += 1; } });
    handles.push(handle);
    hints.push(hint);
    return handle as FSWatcher;
  });
  t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
    assert.equal(ms, 1000);
    tick = callback;
    return {} as ReturnType<typeof setInterval>;
  });
  t.mock.method(globalThis, "clearInterval", () => { cleared += 1; tick = undefined; });
  syncBuiltinESMExports();
  return {
    tick() { assert.ok(tick); tick(); },
    hint(event = "change", filename: string | null = "events.jsonl") { hints.at(-1)?.(event, filename); },
    error() { handles.at(-1)?.emit("error", new Error("watch failed")); },
    allowAttach() { failAttach = false; },
    get attaches() { return attaches; }, get closed() { return closed; }, get cleared() { return cleared; },
  };
}

async function heldPoll(world: Awaited<ReturnType<typeof fixture>>) {
  const running = world.start();
  await until(() => world.mock.requests.some((entry) => entry.method === "getUpdates"), "held getUpdates");
  return running;
}
function cards(world: Awaited<ReturnType<typeof fixture>>, key: string) {
  const suffix = `:${actionRefOf(key)}`;
  return world.mock.requests.filter((entry) => {
    const markup = entry.body["reply_markup"] as
      { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    return entry.method === "sendMessage" &&
      markup?.inline_keyboard?.some((row) => row.some((button) => button.callback_data?.endsWith(suffix))) === true;
  }).length;
}

test("real append sends before the held getUpdates completes; idle stop releases watcher", async (t) => {
  const world = await fixture(t);
  let pollsAnswered = 0;
  world.mock.onGetUpdatesAnswered(() => { pollsAnswered += 1; });
  const running = await heldPoll(world);
  const key = world.append();
  await until(() => cards(world, key) === 1, "watch-driven request card");
  assert.equal(pollsAnswered, 0);
  running.stop();
  assert.deepEqual(await running.done, { kind: "stopped" });
  assertClean(world.unit);
});

test("missed notifications use stat fallback; stable ticks and atime reads do no dispatch", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  const passes = t.mock.method(world.channel, "takeReleased");
  const running = await heldPoll(world);
  const initial = passes.mock.callCount();
  for (let i = 0; i < 5; i += 1) {
    fs.readFileSync(world.unit.logPath); // atime is not a version change
    observer.tick(); observer.hint();
  }
  await delay(10);
  assert.equal(passes.mock.callCount(), initial);
  const key = world.append();
  observer.tick();
  await until(() => cards(world, key) === 1, "stat fallback card");
  await delay(10);
  const after = passes.mock.callCount();
  observer.tick(); observer.hint();
  await delay(10);
  assert.equal(passes.mock.callCount(), after);
  running.stop();
  await running.done;
  assert.equal(observer.closed, 1);
  assert.equal(observer.cleared, 1);
});

test("failed watch attach and watch error recover on bounded ticks without redispatching stable logs", async (t) => {
  const world = await fixture(t);
  const observer = observation(t, { failAttach: true });
  const passes = t.mock.method(world.channel, "takeReleased");
  const running = await heldPoll(world);
  const key = world.append();
  observer.tick();
  await until(() => cards(world, key) === 1, "fallback after attachment failure");
  observer.allowAttach();
  observer.tick();
  assert.equal(observer.attaches, 3);
  observer.error();
  assert.equal(observer.closed, 1);
  const before = passes.mock.callCount();
  observer.tick();
  await delay(10);
  assert.equal(observer.attaches, 4);
  assert.equal(passes.mock.callCount(), before);
  observer.hint("change", null);
  assert.equal(observer.closed, 2);
  observer.tick();
  assert.equal(observer.attaches, 5);
  running.stop(); await running.done;
  assert.equal(observer.closed, 3);
});

test("disappearance, recreation, rename and inode replacement reattach and retain verified delivery", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  const running = await heldPoll(world);
  const hidden = join(world.unit.dir, "retained-events.jsonl");
  fs.renameSync(world.unit.logPath, hidden);
  observer.hint("rename");
  await delay(10);
  assert.equal(world.mock.sentTexts().length, 0);
  observer.tick();
  assert.equal(fs.existsSync(world.unit.logPath), false, "observation creates no paths");
  fs.renameSync(hidden, world.unit.logPath);
  observer.tick();
  const first = world.append(); observer.hint();
  await until(() => cards(world, first) === 1, "recreated-log delivery");
  // Copy only real appender-written bytes to a new inode: the same valid log.
  const replacement = join(world.unit.dir, "replacement.jsonl");
  fs.copyFileSync(world.unit.logPath, replacement);
  fs.renameSync(replacement, world.unit.logPath);
  observer.tick();
  const second = world.append(); observer.hint();
  await until(() => cards(world, second) === 1, "replacement-inode delivery");
  assert.equal(cards(world, first), 1);
  assert.ok(observer.attaches >= 4);
  running.stop(); await running.done;
  assertClean(world.unit);
});

test("bursts and beforePoll coalesce during a held send; a request appended during it gets a trailing pass", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  let beforePoll!: () => Promise<void>;
  const listening = deferred();
  world.releaseOnCleanup(listening.resolve);
  t.mock.method(world.channel, "listen", async (options: TelegramListenOptions) => {
    beforePoll = options.beforePoll!; await listening.promise;
  });
  const running = world.start();
  await until(() => beforePoll !== undefined, "listen entry");
  const send = deferred();
  world.releaseOnCleanup(send.resolve);
  const original = world.channel.notify.bind(world.channel);
  let sends = 0;
  let concurrent = 0;
  let peak = 0;
  t.mock.method(world.channel, "notify", async (...args: Parameters<typeof original>) => {
    sends += 1; concurrent += 1; peak = Math.max(peak, concurrent);
    if (sends === 1) await send.promise;
    try { return await original(...args); } finally { concurrent -= 1; }
  });
  const first = world.append(); observer.hint();
  await until(() => sends === 1, "held send");
  const second = world.append();
  for (let i = 0; i < 10; i += 1) { observer.hint(); observer.tick(); }
  const pollDispatch = beforePoll();
  send.resolve();
  await pollDispatch;
  assert.equal(peak, 1);
  assert.equal(cards(world, first), 1);
  assert.equal(cards(world, second), 1);
  assert.equal(sends, 2);
  running.stop(); listening.resolve(); await running.done;
});

test("stop drains in-flight sends before emitting final JSON stats and suppresses queued passes", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  world.setup.json = true;
  const running = await heldPoll(world);
  const send = deferred();
  world.releaseOnCleanup(send.resolve);
  const original = world.channel.notify.bind(world.channel);
  let sends = 0;
  t.mock.method(world.channel, "notify", async (...args: Parameters<typeof original>) => {
    sends += 1; await send.promise; return original(...args);
  });
  const first = world.append(); observer.hint();
  await until(() => sends === 1, "active send");
  world.append(); observer.hint();
  let settled = false;
  void running.done.then(() => { settled = true; });
  running.stop();
  assert.equal(observer.closed, 1);
  assert.equal(observer.cleared, 1);
  observer.hint();
  await delay(10);
  assert.equal(settled, false);
  assert.equal(world.outputs.some((line) => JSON.parse(line).event === "stopped"), false);
  send.resolve(); await running.done;
  const stopped = world.outputs.map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["event"] === "stopped");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]?.["notified"], 1);
  assert.equal(cards(world, first), 1);
  assert.equal(sends, 1);
});

test("once completion and unexpected listen rejection release observation", async (t) => {
  for (const reject of [false, true]) {
    const world = await fixture(t);
    const observer = observation(t);
    world.setup.once = true;
    t.mock.method(world.channel, "listen", async (options: TelegramListenOptions) => {
      assert.equal(options.once, true);
      if (reject) throw new Error("unexpected listen failure");
    });
    const running = world.start();
    if (reject) await assert.rejects(running.done, /unexpected listen failure/);
    else assert.deepEqual(await running.done, { kind: "stopped" });
    assert.equal(observer.closed, 1);
    assert.equal(observer.cleared, 1);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("startup queue and send failures install no observation", async (t) => {
  for (const failure of ["queue", "send"] as const) {
    const world = await fixture(t);
    const observer = observation(t);
    if (failure === "queue") {
      const bytes = fs.readFileSync(world.unit.logPath);
      fs.writeFileSync(world.unit.logPath, bytes.subarray(0, bytes.length - 3));
    } else {
      world.append();
      world.mock.fail("500", { method: "sendMessage" });
    }
    const running = world.start();
    assert.equal((await running.done).kind, failure === "queue" ? "queue-error" : "send-failed");
    assert.equal(observer.attaches, 0);
    assert.equal(observer.cleared, 0);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("failed sends retry on beforePoll, never on unchanged fallback ticks, and restart re-sends pending", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  let beforePoll!: () => Promise<void>;
  const listening = deferred();
  world.releaseOnCleanup(listening.resolve);
  t.mock.method(world.channel, "listen", async (options: TelegramListenOptions) => {
    beforePoll = options.beforePoll!; await listening.promise;
  });
  const running = world.start();
  await until(() => beforePoll !== undefined, "listener ready");
  world.mock.fail("500", { method: "sendMessage" });
  const key = world.append(); observer.hint();
  await until(() => world.errors.some((line) => line.includes("sendMessage")), "failed send warning");
  const attempts = world.mock.requests.filter((entry) => entry.method === "sendMessage").length;
  for (let i = 0; i < 10; i += 1) { observer.tick(); observer.hint(); }
  await delay(10);
  assert.equal(world.mock.requests.filter((entry) => entry.method === "sendMessage").length, attempts);
  world.mock.fail(null);
  await beforePoll();
  assert.equal(cards(world, key), 1, "the retry delivers one armed card");
  running.stop(); listening.resolve(); await running.done;
  const restarted = world.start();
  await until(() => cards(world, key) === 2, "restart re-send");
  restarted.stop(); await restarted.done;
});

test("corrupt and torn real log bytes refuse dispatch, then verified replacement recovers", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  const running = await heldPoll(world);
  const key = world.append();
  const clean = fs.readFileSync(world.unit.logPath);
  // Damage real append output, never fabricate an event line.
  fs.writeFileSync(world.unit.logPath, clean.subarray(0, clean.length - 3));
  observer.hint();
  await until(() => world.errors.some((line) => line.includes("log-torn-tail")), "torn-tail refusal");
  assert.equal(cards(world, key), 0);
  const corrupt = Buffer.from(clean);
  const offset = corrupt.indexOf("watch request");
  assert.ok(offset > 0); corrupt[offset] = "X".charCodeAt(0);
  fs.writeFileSync(world.unit.logPath, corrupt);
  observer.hint();
  await until(() => world.errors.some((line) => line.includes("log-corrupt")), "corrupt-chain refusal");
  assert.equal(cards(world, key), 0);
  fs.writeFileSync(world.unit.logPath, clean); observer.hint();
  await until(() => cards(world, key) === 1, "verified recovery");
  running.stop(); await running.done;
  assertClean(world.unit);
});

test("paced /skip received during dispatch waits for its finite pass; callbacks still reach the gate", async (t) => {
  const world = await fixture(t, "paced");
  const observer = observation(t);
  const first = world.append();
  const running = await heldPoll(world);
  assert.equal(cards(world, first), 1);
  const second = world.append();
  const annotation = deferred();
  world.releaseOnCleanup(annotation.resolve);
  let annotating = false;
  const original = world.channel.annotate.bind(world.channel);
  t.mock.method(world.channel, "annotate", async (...args: Parameters<typeof original>) => {
    annotating = true;
    await annotation.promise;
    return original(...args);
  });
  // A terminal decision releases the first card on the next derivation. Hold
  // its annotation so a real /skip arrives during that dispatch.
  assert.equal(decide(world.unit.logPath, first, "reject", "human:carter", world.unit.options).ok, true);
  observer.hint();
  await until(() => annotating, "held annotation");
  world.mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "/skip" }));
  await until(() => world.mock.requests.filter((entry) => entry.method === "getUpdates").length === 1 &&
    world.mock.pendingUpdateCount() === 0, "skip consumed while dispatch is active");
  assert.equal(world.channel.stats().commands, 0, "commands wait behind active delivery bookkeeping");
  annotation.resolve();
  await until(() => cards(world, second) >= 1, "paced navigation to next request");
  world.mock.queueUpdate(callbackUpdate({ chatId: CHAT, data: world.mock.callbackDataFor(second, "reject") }));
  await until(() => {
    const read = readVerifiedRecords(world.unit.logPath);
    return read.ok && read.records.some((record) => record.event === "approval.rejected" && record.action_key === second);
  }, "callback decision from watch-delivered card");
  running.stop(); await running.done;
  assertClean(world.unit);
});

test("append during watch attachment is picked up without waiting for an OS event", async (t) => {
  const world = await fixture(t);
  const actualWatch = fs.watch;
  let key = "";
  t.mock.method(fs, "watch", (...args: Parameters<typeof actualWatch>) => {
    key = world.append();
    return actualWatch(...args);
  });
  syncBuiltinESMExports();
  const running = await heldPoll(world);
  await until(() => key !== "" && cards(world, key) === 1, "attachment-race card");
  running.stop(); await running.done;
  assertClean(world.unit);
});

test("stop during startup drains its send and never attaches observation or enters listen", async (t) => {
  const send = deferred();
  const world = await fixture(t);
  world.releaseOnCleanup(send.resolve);
  const observer = observation(t);
  world.append();
  let sending = false;
  const original = world.channel.notify.bind(world.channel);
  t.mock.method(world.channel, "notify", async (...args: Parameters<typeof original>) => {
    sending = true; await send.promise; return original(...args);
  });
  const listen = t.mock.method(world.channel, "listen");
  const running = world.start();
  await until(() => sending, "startup send");
  running.stop(); send.resolve();
  assert.deepEqual(await running.done, { kind: "stopped" });
  assert.equal(observer.attaches, 0);
  assert.equal(listen.mock.callCount(), 0);
});

test("unexpected observer dispatch rejection stops polling and releases resources", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  const running = await heldPoll(world);
  t.mock.method(world.channel, "takeReleased", () => { throw new Error("unexpected dispatch failure"); });
  world.append(); observer.hint();
  await assert.rejects(running.done, /unexpected dispatch failure/);
  assert.equal(observer.closed, 1);
  assert.equal(observer.cleared, 1);
});

for (const staleCopy of [true, false]) for (const grouped of [false, true]) {
test(`callback before final send response waits for nonce arming (staleCopy=${staleCopy}, grouped=${grouped})`, async (t) => {
  const response = deferred();
  let holding = false;
  const world = await fixture(t, "burst", {
    staleCopy,
    fetch: async (url, init) => {
      const received = await fetch(url, init);
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url.endsWith("/sendMessage") && body["reply_markup"] !== undefined) {
        holding = true;
        await response.promise;
      }
      return received;
    },
  });
  world.releaseOnCleanup(response.resolve);
  const observer = observation(t);
  const running = await heldPoll(world);
  const key = grouped ? world.appendGrouped()[0]! : world.append();
  observer.hint();
  await until(() => holding && cards(world, key) === 1, "keyboard exposed with response held");
  if (grouped) assert.ok(world.mock.digestAllDataFor("reject"), "held keyboard is a grouped digest");
  world.mock.queueUpdate(callbackUpdate({ chatId: CHAT, data: world.mock.callbackDataFor(key, "reject") }));
  await until(() => world.mock.pendingUpdateCount() === 0, "callback returned by the pending poll");
  await delay(10);
  assert.equal(world.channel.stats().updates, 0, "update intake waits behind the send response");
  assert.equal(world.mock.answerTexts().length, 0);
  response.resolve();
  await until(() => {
    const read = readVerifiedRecords(world.unit.logPath);
    return read.ok && read.records.some((record) => record.event === "approval.rejected" && record.action_key === key);
  }, "callback reaches the ordinary gate after nonce arming");
  assert.equal(world.channel.anomalyCount("stale-copy"), 0);
  const read = readVerifiedRecords(world.unit.logPath);
  assert.ok(read.ok);
  assert.equal(read.records.filter((record) => record.event === "approval.rejected").length, 1);
  assert.equal(read.records.filter((record) => record.event === "audit.decision_refused").length, 0);
  assert.equal(world.mock.answerTexts().some((text) => /stale|not issued|no longer/i.test(text)), false);
  running.stop(); await running.done;
  assertClean(world.unit);
});
}

test("a watch dispatch waits for an awaited command batch to finish", async (t) => {
  const world = await fixture(t, "paced");
  const observer = observation(t);
  const running = await heldPoll(world);
  const answer = deferred();
  world.releaseOnCleanup(answer.resolve);
  let answering = false;
  const original = world.channel.announce.bind(world.channel);
  t.mock.method(world.channel, "announce", async (...args: Parameters<typeof original>) => {
    if (!answering) {
      answering = true;
      await answer.promise;
    }
    return original(...args);
  });
  world.mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "/queue" }));
  await until(() => answering, "awaited command reply");
  const passes = t.mock.method(world.channel, "takeReleased");
  const key = world.append(); observer.hint();
  await delay(10);
  assert.equal(passes.mock.callCount(), 0, "no dispatch while the update batch awaits");
  assert.equal(cards(world, key), 0);
  answer.resolve();
  await until(() => cards(world, key) === 1, "dispatch after command completion");
  running.stop(); await running.done;
  assertClean(world.unit);
});

test("continuous append wakes do not hold beforePoll behind all future dispatches", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  const running = await heldPoll(world);
  const first = deferred();
  const eighth = deferred();
  world.releaseOnCleanup(first.resolve);
  world.releaseOnCleanup(eighth.resolve);
  const original = world.channel.notify.bind(world.channel);
  let sends = 0;
  t.mock.method(world.channel, "notify", async (...args: Parameters<typeof original>) => {
    const delivered = await original(...args);
    sends += 1;
    if (sends <= 8) { world.append(); observer.hint(); }
    if (sends === 1) await first.promise;
    if (sends === 8) await eighth.promise;
    return delivered;
  });
  world.append(); observer.hint();
  await until(() => sends === 1, "first sustained-write send");
  world.mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "not a command" }));
  await until(() => world.mock.pendingUpdateCount() === 0, "first poll returns during dispatch");
  first.resolve();
  await until(() => sends === 8, "eighth pass held with another wake pending");
  assert.ok(world.mock.requests.filter((entry) => entry.method === "getUpdates").length >= 2,
    "the second getUpdates starts while later dispatch wakes are still pending");
  running.stop(); eighth.resolve(); await running.done;
  assertClean(world.unit);
});

test("continuous append wakes after startup still allow the first network poll", async (t) => {
  const world = await fixture(t);
  const observer = observation(t);
  world.append();
  const eighth = deferred();
  world.releaseOnCleanup(eighth.resolve);
  const original = world.channel.notify.bind(world.channel);
  let sends = 0;
  t.mock.method(world.channel, "notify", async (...args: Parameters<typeof original>) => {
    const delivered = await original(...args);
    sends += 1;
    if (sends <= 8) { world.append(); observer.hint(); }
    if (sends === 8) await eighth.promise;
    return delivered;
  });
  const running = world.start();
  await until(() => sends === 8, "startup-derived sustained wakes");
  assert.ok(world.mock.requests.some((entry) => entry.method === "getUpdates"),
    "startup's attachment pass waits for finite work, then allows polling");
  running.stop(); eighth.resolve(); await running.done;
  assertClean(world.unit);
});

test("a malformed getUpdates batch retains poll error backoff and retries", async (t) => {
  let polls = 0;
  const world = await fixture(t, "burst", {
    fetch: async (url, init) => {
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        if (polls === 1) return { ok: true, status: 200, text: async () => '{"ok":true,"result":null}' };
      }
      return fetch(url, init);
    },
  });
  observation(t);
  const running = await heldPoll(world);
  assert.equal(polls, 2);
  assert.equal(world.channel.stats().pollErrors, 1);
  const key = world.append();
  // The rejected batch does not poison the queue: the next successful batch
  // reaches the same unconditional beforePoll dispatch.
  world.mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "not a command" }));
  await until(() => cards(world, key) === 1, "dispatch after malformed-batch recovery");
  running.stop(); await running.done;
  assertClean(world.unit);
});
