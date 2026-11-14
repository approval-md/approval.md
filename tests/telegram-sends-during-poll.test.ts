/**
 * APRV-535: the polling listener says `sends_during_poll` in its getUpdates
 * body, because since APRV-534 it sends a new request's card while that poll
 * is held. Only from that listener, never to Telegram's own API base, and
 * `--no-sends-during-poll` withdraws the claim without touching the watch.
 *
 * Every Bot API call here goes to a stub `fetch` that records it and never
 * opens a socket, which is how a body addressed to Telegram's own base can be
 * inspected without contacting Telegram. The token is made up.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import {
  actionRefOf,
  isTelegramOwnApiBase,
  TELEGRAM_DEFAULT_API_BASE,
  TELEGRAM_SENDS_DURING_POLL_FIELD,
  TelegramChannel,
  type TelegramFetch,
} from "../src/channels/telegram.js";
import {
  prepareListen,
  startListener,
  type ListenSetup,
  type RunningListener,
} from "../src/cli/channel-telegram.js";
import { main } from "../src/cli/main.js";
import { appendAttestation, HUMAN_ACTOR_ENV } from "../src/core/attest.js";
import { register, request } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { TELEGRAM_CHAT_ENV, TELEGRAM_TOKEN_ENV } from "../src/core/telegram-config.js";
import { assertClean, newScenario, scratchRoot } from "./scenario.js";

const TOKEN = "1357913:AA-fake-sends-during-poll-tests-DO-NOT-USE";
const CHAT = "8822";
const POLICY = '# Policy\n```yaml approval-policy\nversion: "0.1"\ndefaults:\n  autonomy: manual\n```\n';
/** A loopback base nothing listens on: the stub fetch answers in its place. */
const RELAY_BASE = "http://127.0.0.1:9";
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The getUpdates bodies as main (d7478af3) sends them with a 25 s poll at
 * offset 0: three fields, in this order. Pinned as bytes, so "byte-equal to
 * today's" is a comparison against a literal and not against whatever this
 * change happens to produce. The listener registers command handlers, so it
 * also reads `message`; a bare channel reads callbacks only.
 */
const TODAY = '{"offset":0,"timeout":25,"allowed_updates":["callback_query","message"]}';
const WITH_CLAIM = '{"offset":0,"timeout":25,"allowed_updates":["callback_query","message"],"sends_during_poll":true}';
const TODAY_CHANNEL = '{"offset":0,"timeout":25,"allowed_updates":["callback_query"]}';

interface Call { url: string; method: string; raw: string }

/**
 * A Bot API that records every call. `getUpdates` is held until the caller
 * aborts it, unless `answerPolls` says how many polls to answer empty first.
 */
function stubBotApi(options: { answerPolls?: number } = {}) {
  const calls: Call[] = [];
  let answered = 0;
  let messageId = 700;
  const ok = (result: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) });
  const fetch: TelegramFetch = async (url, init) => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    calls.push({ url, method, raw: init.body });
    if (method === "getUpdates") {
      if (answered < (options.answerPolls ?? 0)) {
        answered += 1;
        return ok([]);
      }
      return await new Promise((_resolve, reject) => {
        const abort = (): void => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    }
    messageId += 1;
    return ok({ message_id: messageId, date: 0, chat: { id: Number(CHAT) }, text: "" });
  };
  return {
    fetch,
    calls,
    polls: () => calls.filter((call) => call.method === "getUpdates"),
    /** The request cards sent for `key`: a sendMessage whose buttons name its reference. */
    cards: (key: string) => calls.filter((call) => call.method === "sendMessage" && call.raw.includes(`:${actionRefOf(key)}"`)),
  };
}

async function until(condition: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out: ${why}`);
    await delay(5);
  }
}

/** A real log and gate, a channel on the stub, and `startListener` over both. */
function listenerWorld(
  t: TestContext,
  options: { apiBase?: string; once?: boolean; noSendsDuringPoll?: boolean; answerPolls?: number } = {},
) {
  const scratch = scratchRoot("telegram-sends-during-poll");
  const unit = newScenario(scratch.root, POLICY);
  const api = stubBotApi({ answerPolls: options.answerPolls ?? 0 });
  const channel = new TelegramChannel({
    token: TOKEN, chatId: CHAT, fetch: api.fetch,
    ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
    pollTimeoutSeconds: 25, requestTimeoutMs: 65000, backoffMs: 5, maxBackoffMs: 20, log: () => {},
  });
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:approver").ok, true);
  const payloads = new Map<string, unknown>();
  const setup: ListenSetup = {
    channel, logPath: unit.logPath, actor: "human:approver", json: false, once: options.once === true,
    crossInstance: [], allowCrossInstance: false, apiBase: options.apiBase ?? TELEGRAM_DEFAULT_API_BASE,
    delivery: "burst",
    gateOptions: unit.options,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
    checkpoint: { logPath: unit.logPath, policy: { file: unit.policyPath }, keyFile: null, vault: null },
    ...(options.noSendsDuringPoll === undefined ? {} : { noSendsDuringPoll: options.noSendsDuringPoll }),
  };
  let running: RunningListener | undefined;
  const errors: string[] = [];
  t.after(async () => {
    running?.stop();
    await running?.done.catch(() => {});
    scratch.cleanup();
  });
  let ordinal = 0;
  const append = (): string => {
    ordinal += 1;
    const key = `task-${ordinal}:claim`;
    const payload = { ordinal };
    payloads.set(key, payload);
    assert.equal(register(unit.logPath, {
      task: `task-${ordinal}`,
      envelope: { origin: { app: "manual", created_by: "agent:test" }, state: "awaiting", actions: [{
        class: "communicate.email.external", idempotency_key: key,
        summary: `claim request ${ordinal}`, reversible: false, payload_hash: payloadHash(payload),
      }] },
    }, "agent:test", unit.options).ok, true);
    assert.equal(request(unit.logPath, {
      task: `task-${ordinal}`, actionKey: key, cls: "communicate.email.external",
      summary: `claim request ${ordinal}`, reversible: false,
    }, "agent:test", unit.options).ok, true);
    return key;
  };
  return {
    unit, api, channel, append, errors,
    start(): RunningListener {
      running = startListener(setup, { out: () => {}, err: (text) => { errors.push(text); } });
      return running;
    },
  };
}

/** The one key a body has that today's does not, and none missing. */
function extraKeys(raw: string): string[] {
  const today = Object.keys(JSON.parse(TODAY) as object);
  const keys = Object.keys(JSON.parse(raw) as object);
  for (const key of today) assert.ok(keys.includes(key), `body lost ${key}: ${raw}`);
  return keys.filter((key) => !today.includes(key));
}

test("the field's name is one exported constant", () => {
  assert.equal(TELEGRAM_SENDS_DURING_POLL_FIELD, "sends_during_poll");
  assert.equal(WITH_CLAIM, `${TODAY.slice(0, -1)},${JSON.stringify(TELEGRAM_SENDS_DURING_POLL_FIELD)}:true}`);
});

test("Telegram's own API base is recognised by host, whatever the case, port, path or slash", () => {
  for (const base of [
    TELEGRAM_DEFAULT_API_BASE, `${TELEGRAM_DEFAULT_API_BASE}/`, "https://API.Telegram.org",
    "https://api.telegram.org:443", "https://api.telegram.org/some/path", "http://api.telegram.org",
    "not a url",
  ]) {
    assert.equal(isTelegramOwnApiBase(base), true, base);
  }
  for (const base of [
    RELAY_BASE, "http://localhost:8080", "https://control.example/approval-relay",
    "https://api.telegram.org.example", "https://telegram.org",
  ]) {
    assert.equal(isTelegramOwnApiBase(base), false, base);
  }
});

test("A5a: to Telegram's own API base the listener's getUpdates body is byte-equal to today's", async (t) => {
  const world = listenerWorld(t);
  const running = world.start();
  await until(() => world.api.polls().length === 1, "held getUpdates");
  const [poll] = world.api.polls();
  assert.ok(poll?.url.startsWith(`${TELEGRAM_DEFAULT_API_BASE}/bot`), String(poll?.url));
  assert.equal(poll?.raw, TODAY);
  running.stop();
  assert.deepEqual(await running.done, { kind: "stopped" });
  assertClean(world.unit);
});

test("A5a: a caller that asks for the claim still sends today's bytes to Telegram's own base", async () => {
  for (const apiBase of [undefined, `${TELEGRAM_DEFAULT_API_BASE}/`, "https://API.telegram.org:443"]) {
    const api = stubBotApi({ answerPolls: 1 });
    const channel = new TelegramChannel({
      token: TOKEN, chatId: CHAT, fetch: api.fetch, pollTimeoutSeconds: 25, log: () => {},
      ...(apiBase === undefined ? {} : { apiBase }),
    });
    await channel.pollOnce({ sendsDuringPoll: true });
    assert.equal(api.polls()[0]?.raw, TODAY_CHANNEL, String(apiBase));
  }
});

test("A5b: to another base the watch-and-dispatch listener's body is today's plus exactly sends_during_poll", async (t) => {
  // One poll answered empty, so the claim is shown on a later cycle too.
  const world = listenerWorld(t, { apiBase: RELAY_BASE, answerPolls: 1 });
  const running = world.start();
  await until(() => world.api.polls().length === 2, "second, held getUpdates");
  for (const poll of world.api.polls()) {
    assert.ok(poll.url.startsWith(`${RELAY_BASE}/bot`), poll.url);
    assert.equal(poll.raw, WITH_CLAIM);
    assert.deepEqual(extraKeys(poll.raw), [TELEGRAM_SENDS_DURING_POLL_FIELD]);
  }
  // And the claim is true: a request appended now is sent while that poll is held.
  const key = world.append();
  await until(() => world.api.cards(key).length === 1, "card sent during the held poll");
  assert.equal(world.api.polls().length, 2);
  assert.deepEqual(world.errors, []);
  running.stop();
  assert.deepEqual(await running.done, { kind: "stopped" });
  assertClean(world.unit);
});

test("A5b: no other getUpdates caller sends the field: pollOnce, listen, --once", async (t) => {
  // pollOnce called directly, against a relay base.
  {
    const api = stubBotApi({ answerPolls: 1 });
    const channel = new TelegramChannel({ token: TOKEN, chatId: CHAT, apiBase: RELAY_BASE, fetch: api.fetch, pollTimeoutSeconds: 25, log: () => {} });
    await channel.pollOnce();
    assert.equal(api.polls()[0]?.raw, TODAY_CHANNEL);
  }
  // listen without the option, with and without a beforePoll and processUpdates.
  for (const options of [{ once: true }, { once: true, beforePoll: async () => {}, processUpdates: (run: () => Promise<void>) => run() }]) {
    const api = stubBotApi({ answerPolls: 1 });
    const channel = new TelegramChannel({ token: TOKEN, chatId: CHAT, apiBase: RELAY_BASE, fetch: api.fetch, pollTimeoutSeconds: 25, log: () => {} });
    await channel.listen(options);
    assert.equal(api.polls()[0]?.raw, TODAY_CHANNEL);
  }
  // startListener's one-batch --once run, which does not stay to send during a poll.
  const world = listenerWorld(t, { apiBase: RELAY_BASE, once: true, answerPolls: 1 });
  assert.deepEqual(await world.start().done, { kind: "stopped" });
  assert.deepEqual(world.api.polls().map((poll) => poll.raw), [TODAY]);
  assertClean(world.unit);
});

test("A5b: the claim is wired from startListener alone and the channel defaults it off", () => {
  const source = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");
  const files = ["src/channels/telegram.ts", "src/cli/channel-telegram.ts", "src/cli/channel-telegram-webhook.ts",
    "src/cli/up.ts", "src/cli/setup-channel.ts", "src/cli/doctor.ts"];
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  let wired = 0;
  let written = 0;
  for (const file of files) {
    const text = source(file);
    wired += count(text, "sendsDuringPoll: true");
    written += count(text, "[TELEGRAM_SENDS_DURING_POLL_FIELD]");
    if (file !== "src/channels/telegram.ts") {
      assert.equal(count(text, '"sends_during_poll"'), 0, `${file} spells the field instead of importing it`);
    }
  }
  // One place asks for the claim (startListener's listen call) and one writes it (pollOnce).
  assert.equal(wired, 1);
  assert.equal(written, 1);
  const listener = source("src/cli/channel-telegram.ts");
  const start = listener.indexOf("export function startListener(");
  const end = listener.indexOf("\nasync function runListener(");
  assert.ok(start > 0 && end > start);
  assert.ok(listener.slice(start, end).includes("sendsDuringPoll: true"), "the claim is not made inside startListener");
});

test("A6: --no-sends-during-poll leaves the field out and the watch still sends during the held poll", async (t) => {
  const world = listenerWorld(t, { apiBase: RELAY_BASE, noSendsDuringPoll: true });
  const running = world.start();
  await until(() => world.api.polls().length === 1, "held getUpdates");
  assert.equal(world.api.polls()[0]?.raw, TODAY);
  const key = world.append();
  await until(() => world.api.cards(key).length === 1, "card sent during the held poll");
  assert.equal(world.api.polls().length, 1);
  assert.deepEqual(world.errors, []);
  running.stop();
  assert.deepEqual(await running.done, { kind: "stopped" });
  assertClean(world.unit);
});

test("A6: both verbs take --no-sends-during-poll and prepareListen carries it", async (t) => {
  const scratch = scratchRoot("telegram-sends-during-poll-flag");
  t.after(() => scratch.cleanup());
  for (const argv of [["channel", "telegram", "listen"], ["up"]]) {
    let out = "";
    const code = await main([...argv, "--no-sends-during-poll", "--help"], {
      cwd: scratch.root, streams: { out: (text) => { out += text; }, err: () => {} },
    });
    assert.equal(code, 0, argv.join(" "));
    assert.match(out, /--no-sends-during-poll/u, argv.join(" "));
  }

  const unit = newScenario(scratch.root, POLICY);
  const prepare = (noSendsDuringPoll?: boolean): ListenSetup => {
    process.env[TELEGRAM_TOKEN_ENV] = TOKEN;
    process.env[TELEGRAM_CHAT_ENV] = CHAT;
    process.env[HUMAN_ACTOR_ENV] = "human:approver";
    try {
      const prepared = prepareListen({
        logPath: unit.logPath, policy: { file: unit.policyPath }, as: null, payloads: null,
        apiBase: RELAY_BASE, pollTimeout: null, once: false, json: false, allowCrossInstance: true,
        ...(noSendsDuringPoll === undefined ? {} : { noSendsDuringPoll }),
        log: () => {},
      });
      if (!prepared.ok) assert.fail(`prepareListen refused: ${JSON.stringify(prepared)}`);
      return prepared.setup;
    } finally {
      delete process.env[TELEGRAM_TOKEN_ENV];
      delete process.env[TELEGRAM_CHAT_ENV];
      delete process.env[HUMAN_ACTOR_ENV];
    }
  };
  assert.equal(prepare().noSendsDuringPoll, undefined);
  assert.equal(prepare(false).noSendsDuringPoll, undefined);
  assert.equal(prepare(true).noSendsDuringPoll, true);
});
