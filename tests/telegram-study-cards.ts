/**
 * The flag-off card flows the study-mode golden files pin (G2-1/G2-2, APRV-528).
 *
 * Every Bot API call a channel makes for a fixed set of cards and taps, with the
 * study flag OFF, canonicalised (RFC 8785, `core/jcs.ts`) one call per line.
 * The golden files under `tests/fixtures/telegram-study/` were written by this
 * module against the build at origin/main ab83fab1, BEFORE study mode existed,
 * and `tests/telegram-study.test.ts` requires the current build to produce the
 * same bytes. The module deliberately uses only what that base already had, so
 * the capture and the comparison run the same code.
 *
 * If a golden fails for a reason unrelated to study mode, stop and report it.
 * Never re-capture quietly (spec §9, last bullet).
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import {
  claimed,
  computed,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
} from "../src/channels/contract.js";
import { actionRefOf, TelegramChannel, type TelegramConfig } from "../src/channels/telegram.js";
import { canonicalize } from "../src/core/jcs.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import type { PromptSay } from "../src/core/prompt-layout.js";

const AGENT = "agent:hermes";

/** One Bot API call, as the channel issued it: the method and the parsed body. */
export interface StudyCall {
  method: string;
  body: Record<string, unknown>;
}

/** The say block the minimal card is drawn under (the resident template's shape). */
export const STUDY_SAY: PromptSay = {
  "intent.publish.inferred.index": {
    does: "post a wish to Index, the village matching service, in your name",
    quote: { text: "" },
    note: "none",
  },
};

/** A fixed request, as the tagger would hand it to a channel. No clock, no log. */
export function studyRequest(cls: string, key: string, value: unknown, summary: string | null): ChannelRequest {
  const text = JSON.stringify(value, null, 2);
  return {
    action_key: computed(key, "log"),
    task: computed(null, "log"),
    class: computed(cls, "log"),
    autonomy: computed("manual", "policy-match"),
    provenance: computed("rule", "policy-match"),
    est_cost_usd: claimed(0, AGENT),
    summary: claimed(summary, AGENT),
    payload_hash: computed(payloadHash(value), "log"),
    fullPayload: computed(
      { value, text, hash: payloadHash(value), truncated: false },
      "payload-binding",
    ),
    budgets: computed([], "budgets"),
    attestation: computed({ status: "attested", seq: 3, sha256: "cd".repeat(32) }, "attestation"),
    requested_ts: computed("2026-10-05T10:00:00.000Z", "log"),
    ttl_remaining_ms: computed(72 * 3_600_000 - 60_000, "clock"),
    waiting: computed("requested 1 min ago · expires 09:59 UTC", "clock"),
    chain: computed({ seq: 12, hash: "ab".repeat(32), head_seq: 12 }, "log"),
    state: computed("requested", "log"),
  };
}

/** A channel whose Bot API is a recorder: deterministic message ids and nonces. */
export function studyRecordingChannel(extra: Record<string, unknown> = {}): {
  channel: TelegramChannel;
  calls: StudyCall[];
  complaints: string[];
} {
  const calls: StudyCall[] = [];
  const complaints: string[] = [];
  let id = 500;
  let nonce = 0;
  const config = {
    token: "1:fake-token-for-tests",
    chatId: "9911",
    apiBase: "http://127.0.0.1:9",
    fetch: async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ method: url.split("/").pop() ?? "", body });
      id += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: id } }),
      };
    },
    nonce: () => {
      nonce += 1;
      return `n${String(nonce)}`;
    },
    log: (message: string) => complaints.push(message),
    ...extra,
  } as unknown as TelegramConfig;
  return { channel: new TelegramChannel(config), calls, complaints };
}

/** A runtime stand-in that records every decision handed to it and answers a fixed record. */
export function studyStubHandler(decisions: ChannelDecision[]): (decision: ChannelDecision) => DecisionOutcome {
  let seq = 20;
  return (decision) => {
    decisions.push(decision);
    seq += 1;
    const record = {
      seq,
      ts: "2026-10-05T10:03:00.000Z",
      event: decision.decision === "grant" ? "approval.granted" : "approval.rejected",
      actor: "human:carter",
      task: "task-g2",
      action_key: decision.action_key,
      alg: "sha256/jcs",
      prev: "0".repeat(64),
      hash: "1".repeat(64),
    } as unknown as EventRecord;
    return {
      ok: true,
      action_key: decision.action_key,
      decision: decision.decision,
      state: decision.decision === "grant" ? "granted" : "rejected",
      record,
      tokenIssued: false,
    };
  };
}

/** The `callback_data` of the button whose data starts with `prefix` and names `key`. */
export function buttonData(calls: StudyCall[], prefix: string, key: string): string | null {
  const suffix = `:${actionRefOf(key)}`;
  let found: string | null = null;
  for (const call of calls) {
    if (call.method !== "sendMessage") continue;
    const markup = call.body["reply_markup"] as
      | { inline_keyboard?: { text: string; callback_data: string }[][] }
      | undefined;
    for (const row of markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data.startsWith(prefix) && button.callback_data.endsWith(suffix)) {
          found = button.callback_data;
        }
      }
    }
  }
  return found;
}

/** One callback update, as Telegram would deliver it to the configured chat. */
export function studyTap(update: number, data: string, fromId: number | string = 42): Record<string, unknown> {
  return {
    update_id: update,
    callback_query: {
      id: `cb-${String(update)}`,
      from: { id: fromId },
      message: { message_id: 1, chat: { id: 9911 } },
      data,
    },
  };
}

export const TECH_KEY = "hook:s1:tc1:network.call";
export const MINI_KEY = "intent:g2-mini";
export const DIGEST_KEYS = ["task-g2:digest-1", "task-g2:digest-2"] as const;

/**
 * The fixed flows, run with `extra` merged into every channel's config.
 *
 * - `technical`: a technical card, then its Reject tap.
 * - `minimal`: a minimal card, then its Deny tap.
 * - `digest`: a two-request digest (no tap).
 * - `w-callback`: a technical card, then a `w:` callback carrying that card's
 *   nonce and reference (malformed while the flag is off).
 *
 * Each flow's value is its calls canonicalised one per line, then the decisions
 * the runtime was handed, one per line, after a `decisions` separator.
 */
export async function studyFlows(extra: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  const tech = studyRequest(
    "network.call",
    TECH_KEY,
    { command: "curl https://example.org", cwd: "/home/hermes" },
    "Terminal: curl example.org",
  );
  const mini = studyRequest("intent.publish.inferred.index", MINI_KEY, { text: "Badminton on Sunday?" }, "inferred from chat");
  const digestRequests = DIGEST_KEYS.map((key, index) =>
    studyRequest("communicate.email.external", key, { to: [`v${String(index)}@vendor.example`], subject: "chaser" }, `chase ${String(index)}`),
  );

  {
    const decisions: ChannelDecision[] = [];
    const { channel, calls } = studyRecordingChannel(extra);
    channel.onDecision(studyStubHandler(decisions));
    await channel.notify(tech);
    await channel.deliverUpdate(studyTap(1, buttonData(calls, "r:", TECH_KEY) ?? "missing"));
    out["technical"] = serialise(calls, decisions);
  }
  {
    const decisions: ChannelDecision[] = [];
    const { channel, calls } = studyRecordingChannel({ promptStyle: "minimal", say: STUDY_SAY, ...extra });
    channel.onDecision(studyStubHandler(decisions));
    await channel.notify(mini);
    await channel.deliverUpdate(studyTap(2, buttonData(calls, "r:", MINI_KEY) ?? "missing"));
    out["minimal"] = serialise(calls, decisions);
  }
  {
    const decisions: ChannelDecision[] = [];
    const { channel, calls } = studyRecordingChannel(extra);
    channel.onDecision(studyStubHandler(decisions));
    await channel.notifyBatch({ requests: digestRequests });
    out["digest"] = serialise(calls, decisions);
  }
  {
    const decisions: ChannelDecision[] = [];
    const { channel, calls } = studyRecordingChannel(extra);
    channel.onDecision(studyStubHandler(decisions));
    await channel.notify(tech);
    const reject = buttonData(calls, "r:", TECH_KEY) ?? "missing";
    await channel.deliverUpdate(studyTap(3, `w${reject.slice(1)}`));
    out["w-callback"] = serialise(calls, decisions);
  }
  return out;
}

function serialise(calls: StudyCall[], decisions: ChannelDecision[]): string {
  return [
    ...calls.map((call) => canonicalize(call)),
    "decisions",
    ...decisions.map((decision) => canonicalize(decision)),
    "",
  ].join("\n");
}
