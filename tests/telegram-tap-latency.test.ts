/**
 * What one tap costs, at 1k records and at 10k (APRV-206).
 *
 * The complaint this suite pins: the grant/reject buttons used to stop spinning
 * at once and grew to 1-3 s as this repository's own log went from ~5,200
 * records to ~8,400 in a day. The cause was structural rather than accidental —
 * since APRV-196 the single `answerCallbackQuery` was sent AFTER the decision
 * branch finished, so everything the gate does (read the verified log, re-check
 * the budgets, append under the lock) sat in front of the human's spinner, and
 * the parts of it that scale with the log therefore scaled the spinner.
 *
 * Two kinds of claim are asserted here and they are deliberately labelled,
 * because a timing test that does not say which is which is a flake waiting to
 * happen:
 *
 * - a **BOUND** is an absolute ceiling with an order of magnitude of headroom
 *   over the measured value, so a loaded CI box does not fail it;
 * - a **RATIO** compares the same operation at 1k and 10k records. Its only
 *   claim is that the cost is not linear in log length. Ten times the records
 *   would be a ratio of 10 for a linear path; the ceiling here is well under
 *   that and well over what is measured.
 *
 * Everything structural is asserted structurally instead: that the ack REACHES
 * the Bot API before the decision is appended (checked by counting the log's
 * lines from inside the stubbed call), that it claims no decision, that there is
 * exactly one per callback, and that the tap re-verifies no record it has
 * already verified (the verified-read cache's own hit/miss counters).
 *
 * No network: the Bot API is a stub function, and `assertLocal` still guards the
 * base URL the channel is given.
 *
 * Nothing here hand-writes a log line. The pending requests come from the real
 * gate and the filler records go through `core/log.ts`'s `appendEvent`, which is
 * the only sanctioned writer.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import { recordChannelDecision, type ChannelRequest } from "../src/channels/contract.js";
import {
  callbackData,
  TelegramChannel,
  TELEGRAM_ACK_HEARD,
  type TelegramConfig,
  type TelegramFetch,
} from "../src/channels/telegram.js";
import { appendEvent } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { processReadCache } from "../src/core/state.js";
import { register, request } from "./clock-adapters.js";
import { assertLocal } from "./telegram-mock.js";
import { assertClean, at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("telegram-tap-latency");

const ACTOR = "agent:drafter";
const HUMAN = "human:carter";
const TASK = "task-latency";
const CHAT = "9911";
const CLASS = "communicate.email.external";

/** A plausible-looking but entirely fake bot token, as in the main suite. */
const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";

/**
 * The policy the fixtures run under: a long TTL so a 10k-record fixture is still
 * decidable at `at(2)`, and budget headroom so nothing is refused for money.
 */
const POLICY = [
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
 * case below takes the next unused key rather than sharing one: a second tap on
 * a decided request is a different subject (`already-decided`, tested in
 * `tests/channels-telegram.test.ts`).
 */
const TAPS = 16;

interface Fixture {
  unit: Scenario;
  keys: string[];
  tagOptions: TagOptions;
  records: number;
  /** How many of `keys` have been decided by the cases so far. */
  used: number;
}

/** The next request nobody has tapped yet. */
function nextKey(unit: Fixture): string {
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

function lineCount(logPath: string): number {
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
function fixture(label: string, size: number): Fixture {
  const unit = newScenario(scratch.root, POLICY);
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
interface Call {
  method: string;
  body: Record<string, unknown>;
  at: number;
  /** Records in the log at the instant this call was made. */
  logRecords: number;
}

interface Tap {
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
async function tap(unit: Fixture, key: string, nonce: string): Promise<Tap> {
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

// The two fixtures, built once and shared: building them is the expensive part
// of this file, and every case below reads them without writing anything but
// its own decision.
const small = fixture("small", 1_000);
const large = fixture("large", 10_000);

test("the fixtures are the sizes the claims are about", () => {
  assert.ok(small.records >= 1_000, `small fixture is ${String(small.records)} records`);
  assert.ok(large.records >= 10_000, `large fixture is ${String(large.records)} records`);
  assert.ok(
    large.records >= small.records * 9,
    "the two fixtures must differ by about an order of magnitude for the ratio to mean anything",
  );
});

test("a tap is acked before the decision is appended, and the ack claims none (APRV-206)", async () => {
  const before = lineCount(large.unit.logPath);
  const measured = await tap(large, nextKey(large), "n-order");

  // Structural, not timed: the log had not grown when the ack was sent, and it
  // had by the time the poll returned. The ack is therefore in front of the
  // append rather than merely fast.
  assert.equal(measured.recordsAtAck, before, "the ack was sent after the decision was appended");
  assert.equal(measured.recordsAfter, before + 1, "the tap appended no decision");

  const acks = measured.calls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(acks.length, 1, "APRV-196: exactly one answerCallbackQuery per callback");
  const text = String(acks[0]?.body["text"] ?? "");
  assert.equal(text, TELEGRAM_ACK_HEARD);
  assert.doesNotMatch(
    text,
    /approved|granted|rejected|recorded in the log/iu,
    "the ack must not claim a decision that had not been appended when it was sent",
  );

  // And the outcome still follows, on the message, from the appended record.
  const edit = measured.calls.filter((call) => call.method === "editMessageText").at(-1);
  assert.match(String(edit?.body["text"] ?? ""), /APPROVED/u);
  assertClean(large.unit);
});

test("BOUND: the ack lands within 300 ms on a 10k-record log (APRV-206)", async () => {
  // Best of three: the claim is about the path, and one scheduling hiccup on a
  // loaded box is not the path.
  const runs: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    runs.push((await tap(large, nextKey(large), `n-bound-${String(index)}`)).ackMs);
  }
  const best = Math.min(...runs);
  assert.ok(
    best < 300,
    `ack took ${best.toFixed(1)} ms on a ${String(large.records)}-record log (runs: ${runs
      .map((value) => value.toFixed(1))
      .join(", ")})`,
  );
  assertClean(large.unit);
});

test("RATIO: the decision path is not linear in log length (APRV-206)", async () => {
  // Ten times the records. This is a RATIO, not a bound: it says the decision
  // path does not re-verify the log per tap, and says nothing about how many
  // milliseconds either end takes on any particular machine.
  //
  // What the ceiling of 8 is measuring against, honestly stated. The tap no
  // longer re-walks the chain (no parse, no schema check, no digest per record);
  // what remains that touches log length is the verified-read cache's proof that
  // the prefix on disk is the prefix this process verified — one SHA-256 over
  // the file, ~3 ms at 10k records — plus the gate's own in-memory passes over
  // the record list (budgets, request derivation), ~2 ms. Measured on this
  // machine that is about 2.7 ms at 1k against 16-18 ms at 10k, a ratio near 6
  // under load, against the 10 a linear path would show. Making it flat needs an
  // incremental projection of gate state, which is a task of its own; removing
  // the prefix hash instead would defeat the cache's soundness argument
  // (`core/state.ts`, APRV-43) and is deliberately not done.
  //
  // Best of five per side: a min discards a scheduling spike without pretending
  // the spike did not happen.
  const times = async (unit: Fixture, label: string): Promise<number> => {
    const runs: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      runs.push((await tap(unit, nextKey(unit), `n-ratio-${label}-${String(index)}`)).decisionMs);
    }
    return Math.min(...runs);
  };

  const one = await times(small, "small");
  const ten = await times(large, "large");
  assert.ok(
    ten < one * 8,
    `the decision path scaled with the log: ${one.toFixed(1)} ms at ${String(
      small.records,
    )} records, ${ten.toFixed(1)} ms at ${String(large.records)}`,
  );
  assertClean(small.unit);
  assertClean(large.unit);
});

test("a tap re-verifies nothing it has already verified (APRV-206)", async () => {
  // The other half of the ratio, stated structurally: after the first read of a
  // log, a tap's verified read is a cache HIT — the verified head is reused and
  // only the tail appended since is walked. A miss here would mean the whole
  // chain was re-verified, which is the cost the ratio is about.
  const first = processReadCache.stats;
  await tap(large, nextKey(large), "n-cache-warm");
  const warmed = processReadCache.stats;

  await tap(large, nextKey(large), "n-cache-hit");
  const after = processReadCache.stats;

  assert.ok(warmed.hits >= first.hits, "the cache went backwards");
  assert.equal(
    after.misses,
    warmed.misses,
    "a tap on an already-verified log re-verified it from genesis",
  );
  assert.ok(after.hits > warmed.hits, "a tap made no verified read at all");
  assertClean(large.unit);
});

// The invalidation side of that cache — a head that moved, a prefix tampered
// with, a shrunken or substituted file, a different schema directory — is
// enumerated case by case in `tests/state-cache.test.ts`, which asserts that
// each one discards the entry and re-verifies from genesis, and that a resumed
// read is identical to a cold read of the same bytes. It is not repeated here:
// the tap has no cache of its own, and this file's claim is that it uses that
// one rather than that that one is sound.
