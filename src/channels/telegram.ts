/**
 * The Telegram push channel (SPEC.md §10.3, APRV-26).
 *
 * A Telegram bot is the reference *push* channel: the runtime sends the pending
 * request into a chat the approver already reads, and the approver answers with
 * one tap. Everything the contract says about a channel still holds here and is
 * worth restating, because a network channel is where the temptations live:
 *
 * - **It decides nothing.** A `callback_query` becomes a {@link ChannelDecision}
 *   and is handed to the handler the runtime registered. That handler calls
 *   `recordChannelDecision`, which calls the human-only `decide()`. There is no
 *   second path, so TTL lapse, budget re-check, attestation, idempotency and
 *   compare-and-append all still apply to a button press.
 * - **It never sees a token.** A grant mints a single-use execution token, and
 *   `recordChannelDecision` hands it to *its* caller, not to the channel. See
 *   "The token never goes back into the chat" below.
 * - **It holds no decision state.** The only thing kept in memory is the map
 *   from a callback nonce to the action key it was issued for, which is
 *   delivery bookkeeping, not authorization. It is lost on restart; a restarted
 *   listener re-notifies the pending queue, and the buttons on the old messages
 *   stop resolving (they answer "unknown or expired request"). That is the
 *   documented, deliberate trade: an approval that survives a restart lives in
 *   the log, never in a channel's memory.
 *
 * ## Zero dependencies
 *
 * The Bot API is plain HTTPS with JSON bodies, so this module uses `fetch`
 * (global since Node 18) and nothing else. No SDK, no polling library, no
 * webhook framework. `fetch` is injectable ({@link TelegramConfig.fetch}) and
 * `apiBase` is injectable, which is how the test suite runs the whole channel —
 * notify, long-poll, callbacks, failure modes — against a local mock Bot API
 * server and never touches the real network.
 *
 * ## Config-declared identity — SPEC.md §11
 *
 * > Human identity in v0.1 is config-declared (an environment variable or
 * > flag); the trust boundary is the local machine, and anyone who can set that
 * > configuration and write to the log is inside it.
 *
 * This channel does **not** authenticate the person who tapped the button. It
 * checks that the callback arrived from the configured chat id, and the
 * decision is then recorded against the human actor the *runtime* was
 * configured with (`APPROVAL_HUMAN` / `--as`), not against anything the
 * callback carried. So the guarantee is "someone with access to the configured
 * chat, on a runtime configured by someone with local control, tapped Approve"
 * — not "carter tapped Approve". Anyone in that chat can approve as the
 * configured actor. Use a private chat with the bot, and treat the chat's
 * membership as part of the trust boundary. Cryptographic identity is future
 * work and is not a v0.1 claim.
 *
 * ## Formatting: HTML, not MarkdownV2 — a deliberate choice
 *
 * Messages use `parse_mode: "HTML"`. MarkdownV2 requires escaping eighteen
 * characters (`_*[]()~\`>#+-=|{}.!`) in every text position, with different
 * rules inside code spans, and a single missed one is not a cosmetic bug: it is
 * agent-authored text (a summary, a payload body) changing the *structure* of
 * the message a human is about to approve. HTML mode needs exactly three
 * escapes — `&`, `<`, `>` — applied uniformly to every interpolated value by
 * {@link escapeHtml}, and `<pre>` carries the payload bytes without any
 * character being special inside it beyond those three. A narrower escape rule
 * is a narrower injection surface, and the untrusted input here is precisely
 * the claimed fields and the payload.
 *
 * ## The token never goes back into the chat — flagged for human review
 *
 * `recordChannelDecision` returns the raw execution token to the runtime on a
 * grant. The runtime (`cli/channel.ts`) prints it on the **listener's stdout**
 * and nowhere else. It is never sent as a Telegram message, never put in an
 * `answerCallbackQuery` text, and never logged by this module. A chat
 * transcript is stored on someone else's servers, is backed up to phones, and
 * is readable by anyone who is later added to the chat; a single-use execution
 * token in it would be a credential in a place with none of the properties a
 * credential store has. The consequence is real and is the reason this is
 * flagged: the human who approves on their phone does not get the token on
 * their phone — the agent or operator at the terminal running `approval channel
 * telegram listen` does. For v0.1's local-first, single-operator model that is
 * the right side of the trade; a deployment where the approver and the runtime
 * are different people needs a token-delivery design, not a chat message.
 *
 * ## Reject collects no free-text reason — flagged for human review
 *
 * Telegram inline keyboards have no text input: a button press returns only its
 * `callback_data`. Collecting the approver's reason would require a
 * `ForceReply` round trip (send a prompt, wait for the *next* message in the
 * chat, correlate it), which means holding a second piece of per-request state
 * and deciding what to do when the reply never comes. This task records the
 * rejection immediately with the note `rejected via telegram (callback <id>)`,
 * so the audit trail says how the refusal was collected and which callback it
 * came from, and says nothing about why. A follow-up may add the ForceReply
 * flow; until then, a reason belongs in `approval reject --note`.
 *
 * ## Batching (B7) — deferred, and why
 *
 * SPEC.md §10.3 lets a channel collect one gesture over a set. Telegram binds
 * exactly one inline keyboard to one message, and a message carrying every
 * member's full payload would blow the 4096-character limit long before the
 * keyboard became useful — so "one gesture over the set" would need either a
 * media-group hack or a stateful multi-select keyboard that redraws itself on
 * every tap. That is a design task, not a rendering detail, so it is deferred.
 * {@link TelegramChannel.notify} still accepts a {@link ChannelBatch} and
 * handles it **degenerately**: one message per member, each with its own
 * Approve/Reject keyboard, all sharing one batch delivery id so every resulting
 * event carries it and audit granularity survives. What is missing is the
 * ergonomics (one tap for five requests), never the semantics.
 */

import type {
  ChannelBatch,
  ChannelDecision,
  ChannelHealth,
  ChannelRequest,
  DecisionOutcome,
  DeliveryId,
  RenderedField,
  RenderedRequest,
  TaggedField,
  TestableChannel,
} from "./contract.js";
// Type-only: the resolvers below read a loaded policy's SHAPE and nothing else,
// so this adds no runtime edge from `src/channels/` to `src/core/` and no
// possibility of a channel reaching for configuration on its own.
import type { PolicyLoadResult } from "../core/policy-load.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The environment variable the bot token is read from when the policy declares
 * no `channels.telegram.token_env` (SPEC.md §5.1). A DEFAULT, not a fixed name:
 * see {@link telegramTokenEnvFor}.
 */
export const TELEGRAM_TOKEN_ENV = "APPROVAL_TG_TOKEN";

/**
 * The environment variable the approver chat id is read from when the policy
 * declares no `channels.telegram.chat_id_env` (§5.1). Also a default.
 */
export const TELEGRAM_CHAT_ENV = "APPROVAL_TG_CHAT";

/**
 * The NAME of the environment variable this policy says the bot token lives in
 * (SPEC.md §5.1 `channels.telegram.token_env`, amended §5.2 by APRV-72).
 *
 * The name only, in both directions: a policy that carried the token would be a
 * bot credential in a file agents may read, which is exactly what §5.1's
 * name-indirection exists to prevent. A policy that failed to load names
 * nothing, so the default applies — a variable name is not a permission, and
 * treating it as one would mean an unrelated policy typo locked the operator out
 * of their own channel. This is `passphraseEnvFor`'s argument, verbatim, for the
 * same reason: these are the same kind of key.
 *
 * Returns a NAME and reads no environment. Nothing under `src/channels/` touches
 * `process.env` (see {@link TelegramConfig.token}); the CLI layer takes the name
 * from here and looks the value up.
 */
export function telegramTokenEnvFor(load: PolicyLoadResult): string {
  return declaredEnvName(load, "token_env") ?? TELEGRAM_TOKEN_ENV;
}

/**
 * The NAME of the environment variable this policy says the approver chat id
 * lives in (`channels.telegram.chat_id_env`). Same contract, same fallback, and
 * the same reason as {@link telegramTokenEnvFor}.
 */
export function telegramChatEnvFor(load: PolicyLoadResult): string {
  return declaredEnvName(load, "chat_id_env") ?? TELEGRAM_CHAT_ENV;
}

/** A non-empty string under `channels.telegram.<key>`, or `null`. */
function declaredEnvName(load: PolicyLoadResult, key: string): string | null {
  if (!load.ok) return null;
  const telegram = load.policy.channels?.["telegram"];
  const declared = telegram === undefined ? undefined : telegram[key];
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}

/** The real Bot API. Overridden only by tests, against a local mock. */
export const TELEGRAM_DEFAULT_API_BASE = "https://api.telegram.org";

/** Telegram's hard limit on a message's text. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** Telegram's hard limit on `callback_data`, in bytes. */
export const TELEGRAM_MAX_CALLBACK_BYTES = 64;

/** The note recorded on a rejection collected from a button. */
export const TELEGRAM_REJECT_NOTE = "rejected via telegram";

/** Room left under {@link TELEGRAM_MAX_MESSAGE_CHARS} for our own markup. */
const SEGMENT_BUDGET = 3600;

/** The `getUpdates` long-poll timeout, in seconds, when none is configured. */
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;

/** First backoff step after a failed poll. Doubles, capped. */
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * The slice of `fetch` this module uses, structurally.
 *
 * Declared here rather than imported so the channel depends on a shape, not on
 * a lib: a test can hand over a stub, and the default is the global `fetch`
 * that Node ≥ 20 ships.
 */
export type TelegramFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TelegramConfig {
  /**
   * The bot token. Resolved by the *verb* from the variable
   * {@link telegramTokenEnvFor} names ({@link TELEGRAM_TOKEN_ENV} by default);
   * this constructor takes the value, so nothing in the channel reads the
   * environment and a test cannot accidentally pick up a real token.
   */
  token: string;
  /** The approver chat id, as a string. Callbacks from any other chat are ignored. */
  chatId: string;
  /** Bot API base. Defaults to {@link TELEGRAM_DEFAULT_API_BASE}. */
  apiBase?: string;
  /** Injectable `fetch`, for tests. Defaults to the global. */
  fetch?: TelegramFetch;
  /** `getUpdates` long-poll timeout, in seconds. */
  pollTimeoutSeconds?: number;
  /**
   * Transport timeout for one call, in milliseconds. Defaults to the long-poll
   * timeout plus ten seconds, which is the only sane default: a `getUpdates`
   * that is *supposed* to hang for 25s must not be aborted at 30s of total
   * silence for the wrong reason. Overridable because a server that accepts a
   * request and then says nothing at all is a real failure mode, and both an
   * operator on a flaky link and this repo's test suite want to bound it.
   */
  requestTimeoutMs?: number;
  /** First backoff step after a failed poll, in milliseconds. */
  backoffMs?: number;
  /** Backoff ceiling, in milliseconds. */
  maxBackoffMs?: number;
  /**
   * Where operational complaints go. Defaults to stderr. Every message passes
   * through {@link redact} first, so a token cannot reach it even by accident.
   */
  log?: (message: string) => void;
  /** Injectable nonce source, for deterministic tests. */
  nonce?: () => string;
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

/**
 * Why a callback was ignored.
 *
 * Every one of these is counted and complained about on stderr, and **none of
 * them reaches the decision path or the log**. An ignored callback is not an
 * event: writing "someone we do not answer to pressed a button" into an
 * append-only approval log would let any stranger who guessed the bot's handle
 * grow the record a human is asked to trust.
 */
export const TELEGRAM_ANOMALY_KINDS = [
  /** The callback came from a chat that is not the configured one. */
  "foreign-chat",
  /** `callback_data` did not parse as one of ours. */
  "malformed-callback",
  /** A well-formed nonce this listener never issued (or issued before a restart). */
  "unknown-callback",
  /** The action key carried in `callback_data` disagrees with the issued nonce. */
  "key-mismatch",
] as const;

export type TelegramAnomalyKind = (typeof TELEGRAM_ANOMALY_KINDS)[number];

export interface TelegramStats {
  /** Messages successfully delivered by `notify`. */
  notified: number;
  /** Updates received from `getUpdates`, of any kind. */
  updates: number;
  /** Callbacks handed to the runtime's decision handler. */
  decisions: number;
  /** Failed `getUpdates` attempts the loop recovered from. */
  pollErrors: number;
  /** Ignored callbacks, by reason. Never a decision, never a log event. */
  anomalies: Record<TelegramAnomalyKind, number>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The three characters Telegram's HTML mode treats as markup. */
export function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A field's `source` / `author` label, for the "(log)" / "(agent:x)" suffix. */
function originOf(field: TaggedField<unknown>): string {
  return field.kind === "computed" ? field.source : field.author;
}

function formatTtl(ms: number | null): string {
  if (ms === null) return "no TTL (the policy declares none)";
  if (ms <= 0) return "EXPIRED";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One line of the message, and the request member it came from. */
interface Line {
  field: string;
  kind: "computed" | "claimed";
  label: string;
  text: string;
  origin: string;
}

function line(
  field: string,
  tagged: TaggedField<unknown>,
  label: string,
  text: string,
): Line {
  return { field, kind: tagged.kind, label, text, origin: originOf(tagged) };
}

/**
 * The message body, split into the two regions SPEC.md §9 requires a channel to
 * keep visibly apart.
 *
 * The split is the whole point: computed lines sit under a heading that names
 * the runtime as their author, claimed lines under one that names the agent and
 * says "not verified". The `lastRendered()` report is built from *this* value,
 * not from a parallel description of it, so the conformance suite is checking
 * the thing that was actually sent.
 */
export interface TelegramRendering {
  /** Every line, in the order it appears, tagged as the request tagged it. */
  lines: Line[];
  /** The header segment: heading, computed block, claimed block. */
  header: string;
  /** The payload region, verbatim, or `null` when the request carries none. */
  payloadText: string | null;
}

function budgetSummary(request: ChannelRequest): string {
  const verdicts = request.budgets.value;
  if (verdicts.length === 0) return "no limits apply";
  return verdicts
    .map((verdict) => {
      const state = verdict.pass ? "ok" : "EXCEEDED";
      return `${state} ${verdict.scope}.${verdict.limit} (${verdict.window}) consumed ${verdict.consumed} + this ${verdict.requested}, ${verdict.remaining} left`;
    })
    .join("; ");
}

/**
 * The attestation line.
 *
 * Anything but `attested` is shouted, because an unattested or drifted policy
 * means the rule that produced `autonomy: manual` above is not the rule a human
 * signed off on — which is exactly the thing an approver must not have to infer.
 */
function attestationSummary(request: ChannelRequest): string {
  const status = request.attestation.value;
  switch (status.status) {
    case "attested":
      return `attested (seq ${status.seq})`;
    case "not-attested":
      return "NOT ATTESTED — no human has signed off on this policy file";
    case "hash-mismatch":
      return `HASH MISMATCH — the policy file changed since attestation seq ${status.seq}`;
    default:
      return `UNREADABLE — ${status.message}`;
  }
}

/** Build the two regions and the line list. Pure: no I/O, no clock. */
export function renderTelegram(request: ChannelRequest): TelegramRendering {
  const payload = request.fullPayload.value;

  const computedLines: Line[] = [
    line("class", request.class, "class", request.class.value),
    line("autonomy", request.autonomy, "autonomy", request.autonomy.value),
    line("provenance", request.provenance, "resolved by", request.provenance.value),
    line("payload_hash", request.payload_hash, "payload sha256", request.payload_hash.value),
    line("budgets", request.budgets, "budgets", budgetSummary(request)),
    line("attestation", request.attestation, "policy", attestationSummary(request)),
    line("requested_ts", request.requested_ts, "requested", request.requested_ts.value),
    line(
      "ttl_remaining_ms",
      request.ttl_remaining_ms,
      "ttl",
      formatTtl(request.ttl_remaining_ms.value),
    ),
    line(
      "chain",
      request.chain,
      "chain",
      `seq ${request.chain.value.seq} (head ${request.chain.value.head_seq})`,
    ),
    line("task", request.task, "task", request.task.value ?? "(none)"),
    line("state", request.state, "state", request.state.value),
  ];

  const claimedLines: Line[] = [
    line("summary", request.summary, "summary", request.summary.value ?? "(none given)"),
    line(
      "est_cost_usd",
      request.est_cost_usd,
      "est. cost",
      `$${request.est_cost_usd.value.toFixed(2)}`,
    ),
  ];
  if (request.rationale !== undefined) {
    claimedLines.push(line("rationale", request.rationale, "rationale", request.rationale.value));
  }
  if (request.confidence !== undefined) {
    claimedLines.push(
      line(
        "confidence",
        request.confidence,
        "confidence",
        `${request.confidence.value} (never a gate)`,
      ),
    );
  }

  const author =
    request.summary.kind === "claimed" ? request.summary.author : "the requesting party";

  const render = (entry: Line): string =>
    `• <b>${escapeHtml(entry.label)}:</b> ${escapeHtml(entry.text)} <i>(${escapeHtml(entry.origin)})</i>`;

  const header = [
    "<b>APPROVAL REQUIRED</b>",
    `<code>${escapeHtml(request.action_key.value)}</code>`,
    "",
    "<b>COMPUTED — derived by the runtime from the log, the policy and the payload bytes</b>",
    ...computedLines.map(render),
    "",
    `<b>CLAIMED — authored by ${escapeHtml(author)}, NOT verified by the runtime</b>`,
    ...claimedLines.map(render),
  ].join("\n");

  return {
    lines: [...computedLines, ...claimedLines],
    header,
    payloadText:
      payload === null
        ? null
        : `--- full payload (sha256 ${payload.hash}${payload.truncated ? ", TRUNCATED" : ""}) ---\n${payload.text}`,
  };
}

/**
 * Split `text` so every chunk survives HTML escaping inside the message limit.
 *
 * Splitting is by *escaped* length, because `&` becomes five characters and a
 * payload full of them would otherwise produce a message Telegram rejects. The
 * payload is never truncated to fit: the bytes a human is asked to approve are
 * the bytes the token will execute, so an oversized payload becomes several
 * messages, never a shortened one.
 */
export function chunkForTelegram(text: string, budget: number = SEGMENT_BUDGET): string[] {
  const chunks: string[] = [];
  let current = "";
  let cost = 0;
  for (const character of text) {
    const size = escapeHtml(character).length;
    if (cost + size > budget && current.length > 0) {
      chunks.push(current);
      current = "";
      cost = 0;
    }
    current += character;
    cost += size;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Callback data
// ---------------------------------------------------------------------------

/**
 * `callback_data` for one button: `<g|r>:<nonce>[:<action key>]`.
 *
 * The **nonce is authoritative**, not the action key. Telegram caps
 * `callback_data` at 64 bytes, which many action keys already exceed, and — the
 * larger reason — the bytes come back from the network, so treating a key found
 * in them as the thing to decide would let anything that can reach the bot name
 * the action. The nonce is issued by this process at `notify` and resolves
 * through an in-memory map to the request that was actually delivered. The key
 * rides along when it fits, purely as a cross-check: a mismatch is an anomaly
 * and the callback is dropped.
 */
export function callbackData(verb: "g" | "r", nonce: string, actionKey: string): string {
  const withKey = `${verb}:${nonce}:${actionKey}`;
  return Buffer.byteLength(withKey, "utf8") <= TELEGRAM_MAX_CALLBACK_BYTES
    ? withKey
    : `${verb}:${nonce}`;
}

interface ParsedCallback {
  decision: "grant" | "reject";
  nonce: string;
  actionKey: string | null;
}

export function parseCallbackData(data: unknown): ParsedCallback | null {
  if (typeof data !== "string") return null;
  const first = data.indexOf(":");
  if (first === -1) return null;
  const verb = data.slice(0, first);
  if (verb !== "g" && verb !== "r") return null;
  const rest = data.slice(first + 1);
  const second = rest.indexOf(":");
  const nonce = second === -1 ? rest : rest.slice(0, second);
  if (nonce.length === 0) return null;
  return {
    decision: verb === "g" ? "grant" : "reject",
    nonce,
    actionKey: second === -1 ? null : rest.slice(second + 1),
  };
}

// ---------------------------------------------------------------------------
// Errors and redaction
// ---------------------------------------------------------------------------

/** A Bot API call that did not produce a usable result. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/** What one `pollOnce()` did, for tests and for programmatic drivers. */
export interface TelegramPollResult {
  /** Updates received in this batch. */
  updates: number;
  /** Decisions the runtime recorded from this batch, in order. */
  outcomes: { action_key: string; outcome: DecisionOutcome }[];
  /** Callbacks ignored in this batch, with the reason. */
  ignored: { kind: TelegramAnomalyKind; detail: string }[];
}

export interface TelegramListenOptions {
  /** Process exactly one successful `getUpdates` batch, then return. */
  once?: boolean;
  /**
   * Run before every `getUpdates`, including the first and including the poll
   * that follows a recovered poll error (APRV-55).
   *
   * This is how the runtime gets a dispatch cycle without the channel growing
   * an opinion about what is pending: the callback belongs to
   * `cli/channel-telegram.ts`, which re-derives the pending queue from the
   * verified log and sends what it has not sent yet. The channel neither reads
   * the log nor remembers a queue, so nothing here makes it stateful.
   *
   * It MUST NOT throw. A rejection is treated exactly like a poll failure
   * (counted, complained about, retried after backoff) rather than being
   * allowed to end the loop, because a listener that stops listening is the
   * failure mode this loop exists to rule out.
   */
  beforePoll?: () => Promise<void>;
}

/** One delivered request, as this process remembers it. Never a decision. */
interface Delivery {
  actionKey: string;
  deliveryId: DeliveryId;
  batchDeliveryId?: DeliveryId;
}

export class TelegramChannel implements TestableChannel {
  readonly name = "telegram";

  private readonly token: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly fetchImpl: TelegramFetch;
  private readonly pollTimeoutSeconds: number;
  private readonly requestTimeoutMs: number | null;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly complain: (message: string) => void;
  private readonly makeNonce: () => string;

  private handler: ((decision: ChannelDecision) => DecisionOutcome) | null = null;
  private readonly deliveries = new Map<string, Delivery>();
  private rendered: RenderedRequest[] = [];
  private offset = 0;
  private counter = 0;
  private stopped = false;
  private inFlight: AbortController | null = null;

  private readonly counters: TelegramStats = {
    notified: 0,
    updates: 0,
    decisions: 0,
    pollErrors: 0,
    anomalies: {
      "foreign-chat": 0,
      "malformed-callback": 0,
      "unknown-callback": 0,
      "key-mismatch": 0,
    },
  };

  constructor(config: TelegramConfig) {
    this.token = config.token;
    this.chatId = String(config.chatId);
    this.apiBase = (config.apiBase ?? TELEGRAM_DEFAULT_API_BASE).replace(/\/+$/u, "");
    this.fetchImpl = config.fetch ?? (globalThis.fetch as unknown as TelegramFetch);
    this.pollTimeoutSeconds = config.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? null;
    this.backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.complain =
      config.log ??
      ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
    this.makeNonce =
      config.nonce ??
      (() => {
        this.counter += 1;
        return `${this.counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      });
  }

  // -------------------------------------------------------------------------
  // Channel
  // -------------------------------------------------------------------------

  onDecision(handler: (decision: ChannelDecision) => DecisionOutcome): void {
    this.handler = handler;
  }

  health(): ChannelHealth {
    const missing: string[] = [];
    if (this.token.length === 0) missing.push(TELEGRAM_TOKEN_ENV);
    if (this.chatId.length === 0) missing.push(TELEGRAM_CHAT_ENV);
    if (missing.length > 0) {
      return { ok: false, detail: `unconfigured: ${missing.join(", ")} is empty` };
    }
    const anomalies = Object.values(this.counters.anomalies).reduce((sum, n) => sum + n, 0);
    const detail =
      `chat ${this.chatId} via ${this.apiBase}; ${this.counters.notified} notified, ` +
      `${this.counters.decisions} decision(s), ${this.counters.pollErrors} recovered poll error(s), ` +
      `${anomalies} ignored callback(s)`;
    return { ok: true, detail };
  }

  /** The rendering split of the most recent `notify`, for the conformance suite. */
  lastRendered(): RenderedRequest[] {
    return this.rendered;
  }

  /** Delivery, decision and anomaly counters. Live; read from anywhere. */
  stats(): TelegramStats {
    return { ...this.counters, anomalies: { ...this.counters.anomalies } };
  }

  /** Ignored callbacks so far. Exposed for `health()` and for operators. */
  anomalyCount(kind?: TelegramAnomalyKind): number {
    if (kind !== undefined) return this.counters.anomalies[kind];
    return Object.values(this.counters.anomalies).reduce((sum, n) => sum + n, 0);
  }

  /**
   * Put a request (or, degenerately, a batch) in front of the approver.
   *
   * One message per request; the last message of a request carries the
   * Approve/Reject keyboard and its `message_id` is the delivery id. A batch
   * gets one shared batch delivery id, which is what `notify` returns and what
   * every resulting event will carry.
   */
  async notify(target: ChannelRequest | ChannelBatch): Promise<DeliveryId> {
    const isBatch = "requests" in target;
    const members = isBatch ? target.requests : [target];
    const batchDeliveryId = isBatch ? `tg-batch-${this.makeNonce()}` : undefined;

    const rendered: RenderedRequest[] = [];
    let lastDeliveryId = batchDeliveryId ?? "";

    for (const member of members) {
      const delivered = await this.deliverOne(member, batchDeliveryId);
      rendered.push(delivered.rendered);
      if (batchDeliveryId === undefined) lastDeliveryId = delivered.deliveryId;
    }

    this.rendered = rendered;
    return lastDeliveryId;
  }

  private async deliverOne(
    request: ChannelRequest,
    batchDeliveryId: DeliveryId | undefined,
  ): Promise<{ deliveryId: DeliveryId; rendered: RenderedRequest }> {
    const rendering = renderTelegram(request);
    const actionKey = request.action_key.value;
    const nonce = this.makeNonce();

    const segments: string[] = [rendering.header];
    if (rendering.payloadText !== null) {
      const chunks = chunkForTelegram(rendering.payloadText);
      for (const [index, chunk] of chunks.entries()) {
        const label =
          chunks.length === 1
            ? "<b>FULL PAYLOAD — the exact bytes this approval binds to</b>"
            : `<b>FULL PAYLOAD ${index + 1}/${chunks.length} — the exact bytes this approval binds to</b>`;
        segments.push(`${label}\n<pre>${escapeHtml(chunk)}</pre>`);
      }
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: callbackData("g", nonce, actionKey) },
          { text: "🛑 Reject", callback_data: callbackData("r", nonce, actionKey) },
        ],
      ],
    };

    let deliveryId = "";
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const result = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        text: segment,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(last ? { reply_markup: keyboard } : {}),
      });
      if (last) deliveryId = String(result.message_id);
    }

    this.counters.notified += 1;
    this.deliveries.set(nonce, {
      actionKey,
      deliveryId,
      ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
    });

    const fields: RenderedField[] = rendering.lines.map((entry) => ({
      field: entry.field,
      kind: entry.kind,
      text: entry.text,
    }));

    return {
      deliveryId,
      rendered: {
        action_key: actionKey,
        fields,
        fullPayloadText: rendering.payloadText,
        ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Long polling
  // -------------------------------------------------------------------------

  /**
   * Long-poll `getUpdates` until {@link stop} is called (or one batch, with
   * `once`).
   *
   * **The loop survives the network.** A poll that times out, is refused, drops
   * its socket, returns a 5xx, or answers with something that is not JSON is
   * counted, complained about on stderr, and retried after a doubling backoff.
   * There is no failure mode in which the listener quietly stops listening: the
   * whole value of a push channel is that a human's inbox keeps receiving, and
   * a listener that died at 3am on a transient 502 would fail exactly when the
   * queue was filling up.
   *
   * Each iteration begins with {@link TelegramListenOptions.beforePoll} when
   * one is supplied, which is where the runtime's dispatch cycle runs: the
   * loop is therefore "deliver anything newly pending, then wait for a
   * decision", not "deliver once at startup, then wait forever".
   */
  async listen(options: TelegramListenOptions = {}): Promise<void> {
    this.stopped = false;
    let backoff = this.backoffMs;

    while (!this.stopped) {
      try {
        if (options.beforePoll !== undefined) {
          await options.beforePoll();
          if (this.stopped) return;
        }
        await this.pollOnce();
        backoff = this.backoffMs;
        if (options.once === true) return;
      } catch (cause) {
        if (this.stopped) return;
        this.counters.pollErrors += 1;
        this.complain(
          `approval: telegram getUpdates failed (${this.describe(cause)}); retrying in ${backoff}ms — the listener is still up`,
        );
        await sleep(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }

  /** Stop the loop and abort any in-flight request. */
  stop(): void {
    this.stopped = true;
    this.inFlight?.abort();
  }

  /**
   * One `getUpdates` batch, processed. Throws on a transport failure — which is
   * what {@link listen} catches and retries.
   */
  async pollOnce(): Promise<TelegramPollResult> {
    const updates = await this.call<unknown[]>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ["callback_query"],
      },
      this.requestTimeoutMs ?? (this.pollTimeoutSeconds + 10) * 1000,
    );

    const result: TelegramPollResult = { updates: 0, outcomes: [], ignored: [] };
    for (const raw of updates) {
      const update = (raw ?? {}) as Record<string, unknown>;
      const id = update["update_id"];
      if (typeof id === "number") this.offset = Math.max(this.offset, id + 1);
      this.counters.updates += 1;
      result.updates += 1;
      await this.handleUpdate(update, result);
    }
    return result;
  }

  private async handleUpdate(
    update: Record<string, unknown>,
    result: TelegramPollResult,
  ): Promise<void> {
    const callback = update["callback_query"];
    if (typeof callback !== "object" || callback === null) return;
    const query = callback as Record<string, unknown>;
    const callbackId = typeof query["id"] === "string" ? query["id"] : "";

    const message = (query["message"] ?? {}) as Record<string, unknown>;
    const chat = (message["chat"] ?? {}) as Record<string, unknown>;
    const chatId = chat["id"] === undefined ? "" : String(chat["id"]);

    // (a) Not our chat. Counted, answered, never decided, never logged.
    if (chatId !== this.chatId) {
      await this.ignore(
        result,
        callbackId,
        "foreign-chat",
        `callback from chat ${JSON.stringify(chatId)}, which is not the configured approver chat`,
        "This bot only accepts decisions from its configured approval chat.",
      );
      return;
    }

    const parsed = parseCallbackData(query["data"]);
    if (parsed === null) {
      await this.ignore(
        result,
        callbackId,
        "malformed-callback",
        `callback_data ${JSON.stringify(query["data"])} is not a decision this channel issued`,
        "Unrecognized button.",
      );
      return;
    }

    const delivery = this.deliveries.get(parsed.nonce);
    if (delivery === undefined) {
      await this.ignore(
        result,
        callbackId,
        "unknown-callback",
        `no delivery for nonce ${JSON.stringify(parsed.nonce)} (a restarted listener forgets its buttons; the pending queue is re-sent on start)`,
        "This request is unknown to the running listener — check the newest message.",
      );
      return;
    }

    if (parsed.actionKey !== null && parsed.actionKey !== delivery.actionKey) {
      await this.ignore(
        result,
        callbackId,
        "key-mismatch",
        `callback names ${JSON.stringify(parsed.actionKey)} but the nonce was issued for ${JSON.stringify(delivery.actionKey)}`,
        "That button does not match a delivered request.",
      );
      return;
    }

    const decision: ChannelDecision = {
      action_key: delivery.actionKey,
      decision: parsed.decision,
      deliveryId: delivery.deliveryId,
      ...(delivery.batchDeliveryId === undefined
        ? {}
        : { batchDeliveryId: delivery.batchDeliveryId }),
      ...(parsed.decision === "reject"
        ? { note: `${TELEGRAM_REJECT_NOTE} (callback ${callbackId})` }
        : {}),
    };

    if (this.handler === null) {
      await this.ignore(
        result,
        callbackId,
        "unknown-callback",
        "a callback arrived before the runtime registered a decision handler",
        "The runtime is not ready to record decisions.",
      );
      return;
    }

    const outcome = this.handler(decision);
    this.counters.decisions += 1;
    result.outcomes.push({ action_key: delivery.actionKey, outcome });
    await this.answer(callbackId, this.answerFor(decision, outcome));
  }

  /**
   * What the tapping human sees in the toast.
   *
   * The duplicate case is the one worth naming: a second tap on a request the
   * gate has already decided produces `already-decided`, no second event, and
   * this text. Telegram redelivers callbacks on its own, so this path is
   * ordinary traffic, not an error.
   */
  private answerFor(decision: ChannelDecision, outcome: DecisionOutcome): string {
    if (outcome.ok) {
      return decision.decision === "grant"
        ? "Approved — recorded in the log."
        : "Rejected — recorded in the log.";
    }
    if (outcome.code === "already-decided") {
      return "Already decided — the first answer stands; nothing was recorded.";
    }
    if (outcome.code === "expired") return "Expired — the approval window has closed.";
    return `Refused by the runtime: ${outcome.code}.`;
  }

  private async ignore(
    result: TelegramPollResult,
    callbackId: string,
    kind: TelegramAnomalyKind,
    detail: string,
    reply: string,
  ): Promise<void> {
    this.counters.anomalies[kind] += 1;
    result.ignored.push({ kind, detail });
    this.complain(`approval: telegram ignored a callback (${kind}): ${detail}`);
    // A refusal toast is a courtesy, not part of the decision path: it is best
    // effort and its failure is not the listener's problem.
    if (callbackId.length > 0) {
      try {
        await this.answer(callbackId, reply);
      } catch {
        /* ignored: answering a stranger is best effort */
      }
    }
  }

  private async answer(callbackId: string, text: string): Promise<void> {
    if (callbackId.length === 0) return;
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Replace the token with a placeholder anywhere it appears in `text`. */
  private redact(text: string): string {
    return this.token.length === 0 ? text : text.split(this.token).join("<token redacted>");
  }

  private describe(cause: unknown): string {
    return this.redact(cause instanceof Error ? cause.message : String(cause));
  }

  /**
   * One Bot API call.
   *
   * The token is in the URL, which is how the Bot API works — there is no
   * header form. It is therefore never put in a message body, an error string,
   * or a log line: {@link redact} scrubs everything that leaves this class, and
   * the test suite scans every request body and every log byte for it.
   */
  private async call<T>(
    method: string,
    body: unknown,
    timeoutMs = this.requestTimeoutMs ?? 30_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (method === "getUpdates") this.inFlight = controller;

    let raw: string;
    try {
      const response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TelegramApiError(`${method}: HTTP ${response.status}`, method);
      }
      raw = await response.text();
    } catch (cause) {
      if (cause instanceof TelegramApiError) throw cause;
      throw new TelegramApiError(`${method}: ${this.describe(cause)}`, method);
    } finally {
      clearTimeout(timer);
      if (method === "getUpdates") this.inFlight = null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TelegramApiError(`${method}: response was not JSON`, method);
    }
    const envelope = (parsed ?? {}) as Record<string, unknown>;
    if (envelope["ok"] !== true) {
      throw new TelegramApiError(
        `${method}: the Bot API refused (${this.redact(String(envelope["description"] ?? "no description"))})`,
        method,
      );
    }
    return envelope["result"] as T;
  }
}
