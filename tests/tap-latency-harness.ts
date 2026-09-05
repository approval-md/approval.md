/**
 * The fixtures and the single-tap driver shared by the two halves of APRV-206's
 * evidence (extracted, APRV-248).
 *
 * Two files import this and they make different KINDS of claim:
 *
 * - `tests/telegram-tap-latency.test.ts` runs under `npm test` and asserts only
 *   what is true on any machine at any load — the ORDER of the Bot API calls a
 *   tap makes, and how much verification work it does, counted rather than
 *   timed;
 * - `tests/telegram-tap-latency.bench.ts` asserts the wall-clock bounds. It is
 *   opt-in (`APPROVAL_BENCH=1`) and the runner never discovers it, because a
 *   millisecond ceiling measured on a box running sixteen other things is not
 *   evidence about the code — it is evidence about the box, and a suite that
 *   goes red for the box teaches people to ignore red.
 *
 * Nothing here hand-writes a log line. The pending requests come from the real
 * gate and the filler records go through `core/log.ts`'s `appendEvent`, which is
 * the only sanctioned writer.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import { recordChannelDecision, type ChannelRequest } from "../src/channels/contract.js";
import {
  callbackData,
  TelegramChannel,
  type TelegramConfig,
  type TelegramFetch,
} from "../src/channels/telegram.js";
import { appendEvent } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { register, request } from "./clock-adapters.js";
import { assertLocal } from "./telegram-mock.js";
import { at, attest, fixedClock, newScenario, T0, type Scenario } from "./scenario.js";

export const ACTOR = "agent:drafter";
export const HUMAN = "human:carter";
export const TASK = "task-latency";
export const CHAT = "9911";
export const CLASS = "communicate.email.external";

/** A plausible-looking but entirely fake bot token, as in the main suite. */
const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";

/**
 * The policy the fixtures run under: a long TTL so a 10k-record fixture is still
 * decidable at `at(2)`, and budget headroom so nothing is refused for money.
 */
export const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "240h"',
  "  on_expiry: reject",
  "classes:",
  `  ${CLASS}:`,
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "      daily_actions: 1000",
  "```",
  "",
].join("\n");

/**
 * How many taps each fixture must serve. One tap decides one request, so every
 * case takes the next unused key rather than sharing one: a second tap on a
 * decided request is a different subject (`already-decided`, tested in
 * `tests/channels-telegram.test.ts`).
 */
export const TAPS = 16;

export interface Fixture {
  unit: Scenario;
  keys: string[];
  tagOptions: TagOptions;
  records: number;
  /** How many of `keys` have been decided by the cases so far. */
  used: number;
}

/** The next request nobody has tapped yet. */
export function nextKey(unit: Fixture): string {
  const key = unit.keys[unit.used];
  assert.ok(key !== undefined, `the fixture ran out of live requests after ${String(unit.used)}`);
  unit.used += 1;
  return key;
}

function payloadFor(index: number): Record<string, unknown> {
  return {
    from: "ap@approval.example",
    to: [`ap-${String(index)}@vendor.example`],
    subject: `Invoice ${String(41 + index)} chaser`,
    body: `Following up on invoice ${String(41 + index)}.`,
  };
}

export function lineCount(logPath: string): number {
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0).length;
}

/**
 * A log of about `size` records holding {@link TAPS} live manual requests.
 *
 * The requests are made by the real gate. The bulk is `task.registered` records
 * appended through `core/log.ts`'s `appendEvent` — the real writer, stamping
 * every chain field and validating at the write boundary — because building ten
 * thousand records through the full gate would spend minutes of CI time to
 * exercise a path this file is not testing.
 */
export function fixture(root: string, label: string, size: number): Fixture {
  const unit = newScenario(root, POLICY);
  attest(unit, T0);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < TAPS; index += 1) {
    const key = `${TASK}:${label}-${String(index)}`;
    const payload = payloadFor(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: CLASS,
      idempotency_key: key,
      summary: `chase invoice ${String(41 + index)}`,
      reversible: false,
      est_cost_usd: "0.02",
      payload_hash: payloadHash(payload),
    });
  }

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: { origin: { app: "manual", created_by: ACTOR }, state: "awaiting", actions },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  // The bulk, appended before the requests so that every tap's derivation walks
  // the whole log rather than a short tail of it.
  const filler = Math.max(0, size - TAPS - lineCount(unit.logPath));
  for (let index = 0; index < filler; index += 1) {
    const appended = appendEvent(unit.logPath, {
      ts: "2026-08-05T10:00:00.000Z",
      event: "task.registered",
      actor: "agent:planner",
      task: `filler-${label}-${String(index).padStart(6, "0")}`,
      channel: "cli",
      payload: { title: `filler ${String(index)}` },
    });
    assert.ok(appended.ok, `filler append failed: ${JSON.stringify(appended)}`);
  }

  for (const [index, key] of keys.entries()) {
    const requested = request(
      unit.logPath,
      {
        task: TASK,
        actionKey: key,
        cls: CLASS,
        est_cost_usd: "0.02",
        reversible: false,
        summary: `chase invoice ${String(41 + index)}`,
      },
      at(1),
      ACTOR,
      unit.options,
    );
    assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);
  }

  return {
    unit,
    keys,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
    records: lineCount(unit.logPath),
    used: 0,
  };
}

/** One Bot API call the stub saw, with when it saw it and what the log held. */
export interface Call {
  method: string;
  body: Record<string, unknown>;
  at: number;
  /** Records in the log at the instant this call was made. */
  logRecords: number;
}

export interface Tap {
  calls: Call[];
  /** Receipt of the callback to the ack reaching the Bot API. */
  ackMs: number;
  /** The decision path: the gate call the ack no longer waits for. */
  decisionMs: number;
  /** What the log held when the ack was sent, and after the poll. */
  recordsAtAck: number;
  recordsAfter: number;
}

/**
 * Feed one callback to a channel over a stubbed Bot API and time it.
 *
 * The stub is a plain function: no socket is opened, so the measurement is the
 * channel's own work rather than loopback scheduling. `assertLocal` still checks
 * the base URL, so a future edit cannot quietly point this at Telegram.
 */
export async function tap(unit: Fixture, key: string, nonce: string): Promise<Tap> {
  const logPath = unit.unit.logPath;
  const calls: Call[] = [];
  let updates: Record<string, unknown>[] = [];

  const fetchImpl: TelegramFetch = (url, init) => {
    const method = String(url).split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body, at: performance.now(), logRecords: lineCount(logPath) });
    const result: unknown = method === "getUpdates" ? updates : { message_id: 4242 };
    updates = [];
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true, result })),
    } as Awaited<ReturnType<TelegramFetch>>);
  };

  const config: TelegramConfig = {
    token: TOKEN,
    chatId: CHAT,
    apiBase: assertLocal("http://127.0.0.1:9"),
    fetch: fetchImpl,
    pollTimeoutSeconds: 0,
    nonce: () => nonce,
    log: () => {},
  };
  const channel = new TelegramChannel(config);

  let decisionMs = 0;
  channel.onDecision((decision) => {
    const started = performance.now();
    const result = recordChannelDecision(
      logPath,
      decision,
      { actor: HUMAN, channel: "telegram" },
      { ...unit.unit.options, clock: fixedClock(at(2)) },
    );
    decisionMs = performance.now() - started;
    return result.outcome;
  });

  const queue = buildPendingQueue(unit.unit.logPath, unit.tagOptions, at(2));
  assert.equal(queue.ok, true, JSON.stringify(queue));
  const pending = queue.ok
    ? (queue.requests.find((entry) => entry.action_key.value === key) as ChannelRequest | undefined)
    : undefined;
  assert.ok(pending !== undefined, `no pending request for ${key}`);
  await channel.notify(pending);

  updates = [
    {
      update_id: 1,
      callback_query: {
        id: `cb-${nonce}`,
        data: callbackData("g", nonce, key),
        message: { message_id: "4242", chat: { id: Number(CHAT) } },
      },
    },
  ];

  const delivered = calls.length;
  const started = performance.now();
  await channel.pollOnce();
  const acked = calls.slice(delivered).find((call) => call.method === "answerCallbackQuery");
  assert.ok(acked !== undefined, "the tap was never answered");

  return {
    calls: calls.slice(delivered),
    ackMs: acked.at - started,
    decisionMs,
    recordsAtAck: acked.logRecords,
    recordsAfter: lineCount(logPath),
  };
}
