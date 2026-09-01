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
 *   delivery bookkeeping, not authorization. It is lost on restart, and a
 *   restarted listener re-notifies the pending queue. Since APRV-196 a button
 *   also carries a digest of its action key, so a tap on a pre-restart copy
 *   resolves to the request the new process is holding open and decides it;
 *   what a lost map costs is a duplicate message, not a dead button. The trade
 *   is unchanged and is the reason that works at all: an approval that survives
 *   a restart lives in the log, never in a channel's memory, so the thing a
 *   stale button resolves against is a request the LOG still calls pending.
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
 * — not "alice tapped Approve". Anyone in that chat can approve as the
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
 * ## Batching (B7): the digest (APRV-115)
 *
 * SPEC.md §10.3 lets a channel collect one gesture over a set, and until
 * APRV-115 this channel took that option **degenerately**: one message per
 * member, each with its own keyboard, all sharing one batch delivery id. The
 * semantics were right and the ergonomics were the incident. A research session
 * once produced forty near-identical `network.call` prompts in twenty minutes,
 * one message each, and a channel that behaves like a notification hose is a
 * channel a human learns to swipe away.
 *
 * A group of similar pending requests (the grouping key is
 * {@link digestKeyOf}, applied by the listener) is now delivered as a
 * **digest**: every member's full prompt and full payload first, in its own
 * messages and with no buttons, then ONE trailing message carrying the
 * headline, one summary line per member, and the keyboard — a per-member
 * Approve/Reject row for each, plus an "all" row.
 *
 * Four properties hold it together:
 *
 * - **The payloads come first.** The buttons are on the LAST message, and
 *   every member's `<pre>` payload region has already been sent above it. An
 *   approver cannot reach an "Approve all" without the bytes it covers having
 *   been put in front of them (SPEC.md §10.4).
 * - **It fails toward more messages.** A group whose digest text would not fit
 *   inside {@link TELEGRAM_MAX_MESSAGE_CHARS}, or that has fewer than two
 *   members, falls back to the old one-message-per-member delivery, and so
 *   does a group `assembleBatch` refuses. The listener caps a digest at
 *   {@link TELEGRAM_DIGEST_MAX_MEMBERS} and splits a larger burst into
 *   several. Never a grant covering an unseen payload.
 * - **"All" is N decisions, not one.** An all-button hands the runtime's
 *   handler one {@link ChannelDecision} per still-armed member, in order, and
 *   the handler records each through the gate's compare-and-append on its own.
 *   The log never learns the word "batch": it gets N `approval.granted` or
 *   `approval.rejected` events, each bound to its own action and payload hash,
 *   each carrying the shared batch delivery id (SPEC.md §10.3).
 * - **Annotation is per member.** A decided, expired or withdrawn member marks
 *   its own line on the digest and loses its own buttons; the others stay
 *   armed. A partially decided digest therefore shows mixed state, which is
 *   what {@link TelegramChannel.annotate} redraws it to.
 *
 * The digest bookkeeping is delivery state of exactly the kind the nonce map
 * already was: what was sent where, never what was decided. Every outcome word
 * on it comes from the verified log or from the record the gate appended, and
 * losing the map to a restart degrades to a stale message whose buttons the
 * gate refuses, never to a wrong one.
 *
 * ## Every terminal state edits its message (APRV-113)
 *
 * A decided prompt used to look exactly like a pending one: the tap toasted,
 * and the message kept its text and its live buttons. So did a request answered
 * at the CLI or the web queue while the chat prompt was up, and so did one the
 * daemon expired. The chat transcript — the thing the approver actually scrolls
 * — said "APPROVAL REQUIRED" about a question that had been settled hours ago.
 *
 * Every terminal state this process observes for a message it delivered now
 * edits that message: {@link TelegramChannel.annotate} replaces the text with
 * the outcome and clears the keyboard in ONE `editMessageText`, and forgets the
 * delivery so a tap on a button the edit did not remove refuses rather than
 * decides. {@link TelegramChannel.retract} is the withdrawal case of it.
 *
 * Two properties this keeps, deliberately:
 *
 * - **It is not state.** The map this consults is delivery bookkeeping, and
 *   annotating removes from it rather than adding. Losing it (a restart)
 *   degrades to a message that is never annotated — stale text in front of a
 *   human whose gate still refuses every tap on it — and never to a message
 *   annotated with the wrong outcome, because every outcome word comes from the
 *   verified log at the moment it is written.
 * - **The token is never in an edit.** An annotation carries the outcome word,
 *   the action key, who decided, when, and the record's seq. It never carries
 *   the execution token, for the reason spelled out above.
 *
 * ## The bookkeeping is swept (APRV-135)
 *
 * Both maps used to be released only by process exit. Annotating a delivery
 * removes its nonces, but nothing removes a delivery that is never annotated
 * (a request that simply lapsed) or a digest whose members were each settled
 * individually, so a listener left running for weeks held memory proportional
 * to every prompt it had ever sent — and APRV-110's ambient runtime makes
 * week-long listeners the normal case rather than the exception.
 *
 * {@link TelegramChannel.sweep} drops an entry when every member of it is
 * terminal AND the entry is older than the policy's approval TTL. Both halves
 * matter and the pair is what makes the drop safe: past the TTL the gate
 * refuses every decision on the request, so a button referencing a dropped
 * entry could not have been honoured anyway, and it is answered by the
 * stale-callback path that a restarted listener's buttons already take. It is
 * process memory and nothing else: no event is appended, no message is edited,
 * and the log is not opened.
 */

import { createHash } from "node:crypto";

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
import { commandPayloadView, payloadRegionText } from "./payload-view.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The variable NAMES and their resolvers live in `core/telegram-config.ts`
// (APRV-72, moved in APRV-73 so `approval env` can read them without a
// core -> channels import). Re-exported here so channel callers keep one
// import path. Still true: nothing under `src/channels/` reads `process.env`.
import { TELEGRAM_CHAT_ENV, TELEGRAM_TOKEN_ENV } from "../core/telegram-config.js";
export {
  TELEGRAM_CHAT_ENV,
  TELEGRAM_TOKEN_ENV,
  telegramChatEnvFor,
  telegramTokenEnvFor,
} from "../core/telegram-config.js";

/** The real Bot API. Overridden only by tests, against a local mock. */
export const TELEGRAM_DEFAULT_API_BASE = "https://api.telegram.org";

/** Telegram's hard limit on a message's text. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** Telegram's hard limit on `callback_data`, in bytes. */
export const TELEGRAM_MAX_CALLBACK_BYTES = 64;

/** The note recorded on a rejection collected from a button. */
export const TELEGRAM_REJECT_NOTE = "rejected via telegram";

/**
 * The toast a tap gets when no branch produced one of its own (APRV-196).
 *
 * It is deliberately about the tap and not about the request: this text is only
 * ever reached when the handler threw or forgot, which are exactly the states
 * in which this process does not know what became of the request. Saying so is
 * the honest answer, and it is still infinitely better than a button that spins.
 */
export const TELEGRAM_ACK_FALLBACK =
  "Received — this listener could not finish reading your tap. Nothing was recorded by it; check the message above for the outcome.";

/** Prefixed to the toast when the tap arrived on a pre-restart copy (APRV-196). */
export const TELEGRAM_STALE_COPY_PREFIX = "Earlier copy of this request — ";

/**
 * The toast for a tap on a copy of an action this process is not holding open,
 * when no verified-log probe is configured to say more (APRV-196).
 */
export const TELEGRAM_STALE_UNKNOWN =
  "This request is not open here — it was already decided, it lapsed, or another listener holds it. Nothing was recorded.";

/**
 * The headline of an ordinary single-request prompt.
 *
 * Exported because the mock Bot API and several tests key on it, and because a
 * digest member's header deliberately does NOT use it: a member prompt carries
 * no buttons, so calling it "APPROVAL REQUIRED" would point a reader at a
 * message that cannot take their answer.
 */
export const TELEGRAM_PROMPT_HEADING = "APPROVAL REQUIRED";

/**
 * What the label over the payload chunks names (APRV-162).
 *
 * The chunks carry the canonical rendering, which is a deterministic function
 * of the bytes and not the bytes themselves; calling it "the exact bytes" told
 * the reader that a diff view and a JSON file were the same object. The
 * rendering names its own `display_hash`, and the store path inside it is the
 * route back to the bytes.
 */
export const PAYLOAD_CHUNK_LABEL_TAIL =
  "the canonical rendering this approval's display_hash names; raw bytes at the store path inside";
export const PAYLOAD_CHUNK_LABEL = `PAYLOAD — ${PAYLOAD_CHUNK_LABEL_TAIL}`;

/**
 * What the claimed block is headed, and what a second claimed message is headed
 * when a rationale overflows one (APRV-165).
 *
 * Both say CLAIMED and both say NOT verified, because a continuation is a
 * message a reader may see first, and a claimed line that arrives under no
 * heading at all reads as the runtime's own.
 */
export const TELEGRAM_CLAIMED_HEADING_PREFIX = "WHAT THIS DOES — CLAIMED by";
export const TELEGRAM_CLAIMED_HEADING_SUFFIX = "NOT verified by the runtime";
export const TELEGRAM_CLAIMED_CONTINUED_HEADING = `WHAT THIS DOES (continued) — CLAIMED, ${TELEGRAM_CLAIMED_HEADING_SUFFIX}`;

/**
 * The most members one digest may carry (APRV-115).
 *
 * Not a rendering limit — {@link renderDigest} checks the real one against
 * {@link TELEGRAM_MAX_MESSAGE_CHARS} — but a *reading* one: a keyboard of
 * twenty rows is a wall, and the failure this feature exists to fix is a human
 * who stops reading. A burst larger than this becomes several digests, which is
 * the direction this whole design fails in.
 */
export const TELEGRAM_DIGEST_MAX_MEMBERS = 8;

/**
 * The headline each terminal state puts on the message it settles (APRV-113).
 *
 * Keyed by `core/state.ts`'s `RequestState` names for the terminal states, so
 * the caller that derived the state from the verified log picks a word by
 * indexing rather than by re-deciding what happened.
 *
 * Glyphs, not emoji: `✓`/`✗` are the vocabulary `cli/style.ts` uses for the
 * same ok/fail distinction, and every line of *message text* this channel
 * writes ("APPROVAL REQUIRED", "PAYLOAD", "WITHDRAWN") is emoji-free. The
 * emoji live on the button labels, which are a different surface and stay as
 * they are. `withdrawn` keeps the exact wording APRV-106 shipped.
 */
export const TELEGRAM_TERMINAL_HEADLINES = {
  granted: "✓ APPROVED",
  rejected: "✗ REJECTED",
  revoked: "✗ REVOKED — the grant was taken back",
  expired: "✗ EXPIRED — the approval window closed",
  withdrawn: "WITHDRAWN — no decision is needed",
} as const;

/** A state {@link TELEGRAM_TERMINAL_HEADLINES} has a word for. */
export type TelegramTerminalState = keyof typeof TELEGRAM_TERMINAL_HEADLINES;

/** Whether a derived request state is one an annotation can settle a message on. */
export function isTelegramTerminalState(state: string): state is TelegramTerminalState {
  return Object.prototype.hasOwnProperty.call(TELEGRAM_TERMINAL_HEADLINES, state);
}

/**
 * `HH:MM UTC`, or the raw instant when it does not parse.
 *
 * UTC and not a local zone: the listener, the approver's phone and the log can
 * all be in different places, and the log's own timestamps are UTC. A clock a
 * reader can line up against `approval log` beats one that matches their wrist.
 */
export function utcClock(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  const at = new Date(ms);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The "who decided, when, and which record says so" line of an annotation. */
export function decidedLine(actor: string, ts: string, seq: number): string {
  return `by ${actor} at ${utcClock(ts)} (seq ${seq})`;
}

/** Room left under {@link TELEGRAM_MAX_MESSAGE_CHARS} for our own markup. */
const SEGMENT_BUDGET = 3600;

/** The `getUpdates` long-poll timeout, in seconds, when none is configured. */
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;

/** First backoff step after a failed poll. Doubles, capped. */
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * How long a settled delivery is remembered when the policy declares no
 * `defaults.approval_ttl` (APRV-135).
 *
 * A policy with no TTL bounds nothing, so "past the approval TTL" can never
 * become true and a sweep keyed on it alone would never fire — which is the
 * unbounded map this task exists to remove. The retention floor takes over
 * there, and it applies only to entries whose every member this process has
 * seen settled: with no TTL an undecided request stays answerable forever, and
 * forgetting its button would take a live decision away from an approver.
 *
 * A day, because the point of remembering a settled delivery at all is that an
 * approver may still tap a button on a message already scrolled past, and the
 * answer they should get is the stale-callback reply either way.
 */
export const TELEGRAM_DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Least time between two sweeps. A sweep is O(map); once a minute is plenty. */
export const TELEGRAM_SWEEP_INTERVAL_MS = 60_000;

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
  /**
   * The policy's `defaults.approval_ttl` in milliseconds, or `null` when it
   * declares none (APRV-135).
   *
   * Passed in by the verb, which has already loaded the policy; the channel
   * neither reads a policy file nor holds an opinion about what the TTL should
   * be. It is used for one thing: deciding when a delivery this process
   * remembers can no longer be the subject of a decision, and can therefore be
   * forgotten. See {@link TelegramChannel.sweep}.
   */
  approvalTtlMs?: number | null;
  /**
   * Injectable monotonic-ish clock, in milliseconds, for the sweep.
   *
   * Defaults to `Date.now`. It exists so a test can run a week of deliveries in
   * a millisecond; nothing else in this class reads a clock, and nothing that
   * reaches a human or the log reads this one.
   */
  now?: () => number;
  /**
   * What to tell a human who tapped a button for an action this process is not
   * holding open (APRV-196). One sentence, or `null` for "nothing is known".
   *
   * Supplied by the listener, which reads the VERIFIED log and can therefore
   * say whether the request was granted, rejected, revoked, expired or
   * withdrawn. The channel asks the question and repeats the answer; it does
   * not derive one, does not cache one, and could not, because the only thing
   * that knows is the log.
   *
   * The argument is an {@link actionRefOf} digest rather than an action key,
   * for the same reason the button carries one: the string came off the
   * network, and the probe's job is to look for a record whose key hashes to
   * it, never to trust a name it was handed. Optional, and absent by default —
   * a channel with no probe falls back to a toast that names no outcome.
   */
  describeAction?: (actionRef: string) => string | null;
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
  /**
   * A tap on a copy of a request this process is no longer holding open
   * (APRV-196): the nonce is not one of ours, and the action it names is not
   * pending here either — it was decided, it lapsed, or another process owns
   * it. Distinct from `unknown-callback` because the operator's question is
   * different: nothing is wrong with the button, the question behind it is
   * over. Always answered with a toast that names the state.
   */
  "stale-copy",
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
  /**
   * Taps that arrived on a copy whose nonce this process never issued and were
   * carried to the gate anyway, because the action they reference is one this
   * process is holding open (APRV-196). Not an anomaly: it is the duplicate-copy
   * trap being defused, and it is counted so an operator can see how often a
   * restart is costing the approver a wrong tap.
   */
  staleCopyDecisions: number;
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

/**
 * The suffix the model-authored line carries, on the line itself (APRV-144).
 *
 * Belt and braces with the `(author)` parenthetical: a reader skimming a wall
 * of bullets sees the word "model" inside the sentence they are about to
 * believe, not only in the small italic at the end of it.
 */
export const TELEGRAM_GLOSS_SUFFIX = "(model, unverified)";

/**
 * The prefix a health row carries when it is the reason to look (APRV-163).
 *
 * Only the abnormal state of `autonomy`, `budgets` and the attestation renders
 * at all, so the mark is never routine: a row bearing it is a row the reader
 * has not seen on the last twenty prompts.
 */
export const TELEGRAM_ANOMALY_MARK = "⚠ ";

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
  /** The header segment: heading, action key, computed block. */
  header: string;
  /** The payload region, verbatim, or `null` when the request carries none. */
  payloadText: string | null;
  /**
   * The claimed segment, sent LAST so it sits beside the buttons (APRV-165).
   *
   * The claimed lines are what the act means to a human — what this sends, to
   * whom, why — and the approver decides on that, so it is the thing the thumb
   * should be next to rather than the metadata above it. SPEC §10.3 permits
   * claimed material around the canonical block on the condition this keeps:
   * visibly separated, and headed by a label that names the claiming party and
   * says the runtime did not check them.
   *
   * Never empty. A request with no gloss, no summary and no rationale still
   * gets this message, because an absent description of the act is itself
   * something the approver has to see, and because the keyboard needs one
   * message that is always there to ride on.
   */
  claimedText: string;
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

/**
 * Build the two regions and the line list. Pure: no I/O, no clock.
 *
 * `heading` is the message's first line. It is a parameter for exactly one
 * reason (APRV-115): a digest member's prompt carries no buttons, and telling
 * a reader "APPROVAL REQUIRED" above a message they cannot answer on is the
 * kind of small lie that costs a channel its legibility. Everything below the
 * first line is identical either way, computed/claimed split included.
 */
export function renderTelegram(
  request: ChannelRequest,
  heading: string = TELEGRAM_PROMPT_HEADING,
): TelegramRendering {
  const payload = request.fullPayload.value;

  const computedLines: Line[] = [
    line("class", request.class, "class", request.class.value),
    // APRV-144, then APRV-143: what the command actually does, and which
    // protected path earned the class. Both sit immediately under the class
    // they explain, because `class: policy.edit` over a truncated path prefix
    // is the state this pair of tasks exists to end. Both are derived from the
    // bound bytes by the same classifier the hook decided with.
    ...(request.command_breakdown === undefined
      ? []
      : [
          line(
            "command_breakdown",
            request.command_breakdown,
            "commands",
            request.command_breakdown.value,
          ),
        ]),
    ...(request.protected_path === undefined
      ? []
      : [
          line(
            "protected_path",
            request.protected_path,
            "protected path",
            request.protected_path.value,
          ),
        ]),
    // APRV-109. On an attestation prompt these two are the decision: a hash
    // alone would ask a human to sign for sixty-four characters. They sit above
    // the health rows because they are what the approver reads, and they are
    // absent on every ordinary request rather than rendered empty.
    ...(request.policy_diff === undefined
      ? []
      : [line("policy_diff", request.policy_diff, "policy diff", request.policy_diff.value)]),
    ...(request.policy_load === undefined
      ? []
      : [line("policy_load", request.policy_load, "policy loads", request.policy_load.value)]),
    // APRV-163. Three health rows, rendered only when they are abnormal and
    // shouted when they are. A row that says "everything is fine" on every
    // ordinary request is a row a reader learns to skip, and the skipping does
    // not stop on the one request where it says something else; the mark is the
    // whole reason the line is worth spending at all.
    ...(request.autonomy.value === "manual"
      ? []
      : [
          line(
            "autonomy",
            request.autonomy,
            `${TELEGRAM_ANOMALY_MARK}autonomy`,
            request.autonomy.value,
          ),
        ]),
    ...(request.budgets.value.every((verdict) => verdict.pass)
      ? []
      : [
          line(
            "budgets",
            request.budgets,
            `${TELEGRAM_ANOMALY_MARK}budgets`,
            budgetSummary(request),
          ),
        ]),
    ...(request.attestation.value.status === "attested"
      ? []
      : [
          line(
            "attestation",
            request.attestation,
            `${TELEGRAM_ANOMALY_MARK}policy`,
            attestationSummary(request),
          ),
        ]),
    // APRV-106. The one time row: the human-readable form of the request
    // instant, plus the one thing the raw timestamp does not say, whether an
    // answer now still reaches anyone.
    line("waiting", request.waiting, "waiting", request.waiting.value),
    // No `ttl` line (APRV-143). `expires 13:09 UTC` on the line above IS the
    // TTL, stated as the instant a reader acts on rather than as a duration
    // they would have to add to a timestamp; two renderings of one fact cost a
    // metadata row on a phone screen and buy nothing. `ttl_remaining_ms` stays
    // on the request, so `--json` and every other channel still carry it.
    //
    // No `resolved by`, `payload sha256`, `requested`, `chain`, `task` or
    // `state` line either (APRV-163). Six bookkeeping rows on a phone screen
    // push the class, the command and the deadline off it, and none of them
    // changes an answer: `provenance`, `requested_ts`, `chain`, `task` and
    // `state` all stay on the ChannelRequest, so `--json`, `approval queue` and
    // the web page still show every one, and `payload_hash` is stated where it
    // binds, on the `payload sha256:` line inside the canonical block below.
  ];

  const claimedLines: Line[] = [
    // APRV-144. Under the CLAIMED heading, because a model's sentence is not
    // something the runtime derived, and labelled on the line as well: the
    // `(author)` parenthetical every claimed line already carries is small,
    // uniform and easy to stop seeing, and this is the one line in the message
    // that NO party — not the runtime, not even the requesting agent — stands
    // behind. Nothing here or anywhere else branches on what it says.
    ...(request.gloss === undefined
      ? []
      : [line("gloss", request.gloss, "gloss", `${request.gloss.value} ${TELEGRAM_GLOSS_SUFFIX}`)]),
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
    `<b>${escapeHtml(heading)}</b>`,
    `<code>${escapeHtml(request.action_key.value)}</code>`,
    "",
    "<b>COMPUTED — derived by the runtime from the log, the policy and the payload bytes</b>",
    ...computedLines.map(render),
  ].join("\n");

  const claimedText = [
    `<b>${TELEGRAM_CLAIMED_HEADING_PREFIX} ${escapeHtml(author)}, ${TELEGRAM_CLAIMED_HEADING_SUFFIX}</b>`,
    ...claimedLines.map(render),
  ].join("\n");

  return {
    // Computed first, then claimed, whatever order the messages go out in:
    // `lines` is the conformance suite's view of what was rendered, and the
    // two-kind split it checks is a property of the fields, not of the layout.
    lines: [...computedLines, ...claimedLines],
    header,
    claimedText,
    // A whole payload needs no prefix: the canonical block states its own
    // renderer, class, kind and `payload sha256` in its first lines, and a
    // second sha256 above it is one more line between the reader and the
    // action. A TRUNCATED rendering has no canonical block to say any of that,
    // so it gets a prefix worded as what it is: a refusal.
    payloadText:
      payload === null
        ? null
        : `${payload.truncated ? `--- payload TRUNCATED at render (sha256 ${payload.hash}) — no canonical rendering exists; do not grant on this ---\n` : ""}${payloadRegionText(payload, request.class.value)}`,
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

/**
 * Split an already-marked-up segment so every chunk is valid HTML on its own.
 *
 * {@link chunkForTelegram} may cut anywhere because its caller escapes each
 * chunk and wraps it in `<pre>`; the claimed segment carries markup, so a cut
 * inside `<b>` or inside `&amp;` would reach Telegram as a parse error, and a
 * cut between an opening tag and its close would reach it as unbalanced HTML.
 * Tags and entities are therefore atomic here, and the break is taken at the
 * last line boundary in the chunk when there is one, which keeps each bullet
 * whole and balanced. A bullet longer than the budget on its own (a rationale
 * is unbounded agent text) splits inside its text, between tags, never within
 * one — and it splits rather than being shortened, for the same reason a
 * payload does.
 */
export function chunkClaimedForTelegram(text: string, budget: number = SEGMENT_BUDGET): string[] {
  /** One line, as pieces no longer than the budget, cut between atoms only. */
  const pieces = (input: string): string[] => {
    if (input.length <= budget) return [input];
    const out: string[] = [];
    let piece = "";
    for (const atom of input.match(/<[^>]*>|&[^;\s]*;|[\s\S]/gu) ?? []) {
      if (piece.length + atom.length > budget && piece.length > 0) {
        out.push(piece);
        piece = "";
      }
      piece += atom;
    }
    if (piece.length > 0) out.push(piece);
    return out;
  };

  const chunks: string[] = [];
  let current = "";
  for (const linePieces of text.split("\n").map(pieces)) {
    for (const piece of linePieces) {
      const candidate = current.length === 0 ? piece : `${current}\n${piece}`;
      if (candidate.length > budget) {
        if (current.length > 0) chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Digests (APRV-115)
// ---------------------------------------------------------------------------

/**
 * The shape token of a payload, for grouping.
 *
 * A shell command groups by its `argv[0]`, because that is what makes forty
 * `network.call` prompts "the same question forty times" to the human reading
 * them: forty `curl`s are one decision with forty URLs in it, and a `curl` next
 * to an `rm` is not. Everything else groups by its top-level key set, which is
 * the structural sense in which two payloads are the same shape.
 *
 * Structural, never self-declared: nothing here reads a `kind` or `type` field,
 * for the reason `payload-view.ts` spells out — a field authored by the party
 * under oversight must not choose how the party's requests are presented.
 */
export function payloadShapeKey(value: unknown): string {
  const command = commandPayloadView(value);
  if (command !== null) {
    const argv0 = command.command.trim().split(/\s+/u)[0] ?? "";
    return `argv0:${argv0}`;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return `scalar:${typeof value}`;
  return `keys:${Object.keys(value as Record<string, unknown>).sort().join(",")}`;
}

/**
 * The grouping key: requests that share it are the same question asked twice.
 *
 * Signed off 2026-08-25 as (class, origin session/task, argv[0] or payload
 * shape). The requesting actor rides along too, which can only ever SPLIT a
 * group — two agents working the same task get two digests — and splitting is
 * the safe direction: it costs a message and never merges two things a human
 * would have wanted to weigh separately.
 *
 * `"\0"` as the separator because every component is agent-influenced text
 * and a separator that can appear inside one would let a crafted task name
 * collide two classes into one group. Written as the escape, never the raw
 * byte: a literal NUL in the source turns this file into "binary" for grep,
 * diff tooling, and editors, and the escape compiles to the same string.
 */
export function digestKeyOf(request: ChannelRequest): string {
  return [
    request.class.value,
    request.task.value ?? "",
    request.autonomy.value,
    originOf(request.summary),
    payloadShapeKey(request.fullPayload.value?.value),
  ].join("\0");
}

/**
 * Split `requests` into digest groups, preserving queue order.
 *
 * One poll window is the whole window: this is called on the requests one
 * dispatch cycle found undelivered, and nothing here waits for more. A group of
 * one is returned as a group of one, and the caller sends it as an ordinary
 * prompt.
 */
export function groupForDigest(
  requests: ChannelRequest[],
  max: number = TELEGRAM_DIGEST_MAX_MEMBERS,
): ChannelRequest[][] {
  const groups: ChannelRequest[][] = [];
  const byKey = new Map<string, ChannelRequest[]>();

  for (const request of requests) {
    const key = digestKeyOf(request);
    let group = byKey.get(key);
    // A group that has reached the cap is closed and a fresh one opened under
    // the same key: a burst of twenty becomes three digests, never one wall.
    if (group === undefined || group.length >= max) {
      group = [];
      byKey.set(key, group);
      groups.push(group);
    }
    group.push(request);
  }

  return groups;
}

/** One button on a digest keyboard. */
interface InlineButton {
  text: string;
  callback_data: string;
}

/** A digest member, as the delivering process remembers it. Never a decision. */
export interface DigestMemberState {
  actionKey: string;
  /** The nonce this member's own two buttons were issued under. */
  nonce: string;
  /** The agent's one-line description of the effect. Claimed. */
  summary: string;
  /** The agent's cost estimate, formatted. Claimed. */
  cost: string;
  /**
   * The terminal outcome, once one has been observed for this member. Written
   * only from a gate record or the verified log, never inferred here.
   */
  settled: { headline: string; detail: string[] } | null;
}

/** One digest message, as the delivering process remembers it. */
export interface DigestState {
  /** The digest message's own id: what every member's annotation edits. */
  deliveryId: DeliveryId;
  /** Shared by every member's decision event (SPEC.md §10.3). */
  batchDeliveryId: DeliveryId;
  /** The nonce the "all" buttons were issued under. */
  allNonce: string;
  /** The computed facts every member shares, already rendered as text. */
  facts: { label: string; text: string; origin: string }[];
  /** Who authored the claimed lines below. */
  author: string;
  members: DigestMemberState[];
  /**
   * When this process delivered the digest, on {@link TelegramConfig.now}'s
   * clock (APRV-135). Read by the sweep and by nothing else: it is never
   * displayed, never compared against a log timestamp, and never a deadline —
   * the request's own `ts` remains the only instant a TTL is measured from.
   */
  deliveredAtMs: number;
}

/**
 * The computed facts a digest's members share, as the digest states them.
 *
 * Every one is read off the first member, which is sound precisely because the
 * grouping key made them equal across the set: a digest whose members disagreed
 * about their class or their task is a digest the listener would not have
 * built. The last line is the one an approver needs most — it says how many
 * payloads are above and that each request has its own.
 */
export function digestFacts(
  members: ChannelRequest[],
): { label: string; text: string; origin: string }[] {
  const first = members[0];
  if (first === undefined) return [];
  return [
    { label: "class", text: first.class.value, origin: originOf(first.class) },
    { label: "autonomy", text: first.autonomy.value, origin: originOf(first.autonomy) },
    { label: "task", text: first.task.value ?? "(none)", origin: originOf(first.task) },
    {
      label: "grouped by",
      text: `one class, one task, one payload shape (${payloadShapeKey(first.fullPayload.value?.value)})`,
      origin: "grouping",
    },
    {
      label: "payloads",
      text: `${members.length} full payloads, one per request, in the ${members.length} prompts above this message`,
      origin: originOf(first.fullPayload),
    },
  ];
}

/** The digest's headline, given how much of it is still open. */
function digestHeadline(open: number, total: number): string {
  if (open === 0) return `ALL ${total} REQUESTS DECIDED`;
  if (open === total) return `${total} REQUESTS AWAITING APPROVAL`;
  return `${open} OF ${total} REQUESTS STILL AWAITING APPROVAL`;
}

/**
 * The digest message: text plus the keyboard for whatever is still open.
 *
 * Pure. The computed/claimed split of an ordinary prompt is kept — the shared
 * facts are computed and sit under a heading that says so, the per-member lines
 * are the agent's own words and sit under one that says they are not verified —
 * because a digest is a prompt, and SPEC.md §9 does not stop applying because
 * there are five of them.
 *
 * A settled member keeps its line, gains its outcome underneath, and loses its
 * buttons. The "all" row appears only while two or more members are open: with
 * one left, "all" is the same tap as its own Approve and a second way to do one
 * thing is a way to do the wrong one.
 */
export function renderDigest(digest: DigestState): {
  text: string;
  keyboard: { inline_keyboard: InlineButton[][] } | null;
} {
  const open = digest.members.filter((member) => member.settled === null);
  const total = digest.members.length;

  const lines: string[] = [
    `<b>${escapeHtml(digestHeadline(open.length, total))}</b>`,
    "",
    "<b>COMPUTED — derived by the runtime from the log and the policy</b>",
    ...digest.facts.map(
      (fact) =>
        `• <b>${escapeHtml(fact.label)}:</b> ${escapeHtml(fact.text)} <i>(${escapeHtml(fact.origin)})</i>`,
    ),
    "",
    `<b>CLAIMED — authored by ${escapeHtml(digest.author)}, NOT verified by the runtime</b>`,
  ];

  for (const [index, member] of digest.members.entries()) {
    lines.push(
      `${index + 1}. <code>${escapeHtml(member.actionKey)}</code> — ${escapeHtml(member.summary)} · ${escapeHtml(member.cost)}`,
    );
    if (member.settled !== null) {
      lines.push(`   <b>${escapeHtml(member.settled.headline)}</b>`);
      for (const detail of member.settled.detail) lines.push(`   ${escapeHtml(detail)}`);
    }
  }

  lines.push(
    "",
    escapeHtml(
      `Each button decides ONE request, numbered as above. "all" is ${open.length} separate decisions, one log event each; the full payload of every request is in the messages above this one.`,
    ),
  );

  const rows: InlineButton[][] = [];
  for (const [index, member] of digest.members.entries()) {
    if (member.settled !== null) continue;
    rows.push([
      {
        text: `✅ Approve ${index + 1}`,
        callback_data: callbackData("g", member.nonce, member.actionKey),
      },
      {
        text: `🛑 Reject ${index + 1}`,
        callback_data: callbackData("r", member.nonce, member.actionKey),
      },
    ]);
  }
  if (open.length > 1) {
    rows.push([
      {
        text: `✅ Approve all (${open.length})`,
        callback_data: digestCallbackData("G", digest.allNonce),
      },
      {
        text: `🛑 Reject all (${open.length})`,
        callback_data: digestCallbackData("R", digest.allNonce),
      },
    ]);
  }

  return {
    text: lines.join("\n"),
    keyboard: rows.length === 0 ? null : { inline_keyboard: rows },
  };
}

// ---------------------------------------------------------------------------
// Callback data
// ---------------------------------------------------------------------------

/**
 * The stable short reference to an action key that a button carries (APRV-196).
 *
 * The first {@link ACTION_REF_HEX} hex characters of the key's sha256. Two
 * properties earn it its place, and they are the two the old scheme lacked:
 *
 * 1. **It always fits.** `<verb>:<nonce>:<ref>` is well inside Telegram's
 *    64-byte cap for any nonce this class issues, so the cross-check that used
 *    to be dropped for a long action key is now always present.
 * 2. **It survives a restart.** The nonce is per-process and per-copy; the ref
 *    is a function of the action key alone, so two copies of the same request
 *    delivered by two different listener processes carry the same ref. That is
 *    what lets a tap on a pre-restart copy resolve to the request the current
 *    process is holding, instead of dying as an unknown nonce.
 *
 * It is a REFERENCE and never an authorization. The bytes come back from the
 * network, so a ref is only ever matched against deliveries THIS process made
 * (and only from the configured chat); it can select among what the listener
 * has itself put in front of the approver, and it can name nothing else.
 */
export const ACTION_REF_HEX = 16;

export function actionRefOf(actionKey: string): string {
  return createHash("sha256").update(actionKey, "utf8").digest("hex").slice(0, ACTION_REF_HEX);
}

/**
 * `callback_data` for one button: `<g|r>:<nonce>:<action ref>`.
 *
 * The **nonce is authoritative** where it resolves: it is issued by this process
 * at `notify` and maps to the request that was actually delivered, so an
 * ordinary tap never consults the ref for anything but a cross-check (a
 * mismatch is an anomaly and the callback is dropped). The ref is the fallback
 * for the copy whose nonce this process never issued, and {@link actionRefOf}
 * states the bound on what that fallback may reach.
 */
export function callbackData(verb: "g" | "r", nonce: string, actionKey: string): string {
  const withRef = `${verb}:${nonce}:${actionRefOf(actionKey)}`;
  // Unreachable with the nonces this class issues, and kept because the failure
  // it guards is the worst one available here: `callback_data` over the cap is
  // refused by `sendMessage`, so an over-long nonce would stop DELIVERY rather
  // than degrade a lookup. Dropping the reference costs a stale copy's tap its
  // rescue and leaves every other property intact.
  return Buffer.byteLength(withRef, "utf8") <= TELEGRAM_MAX_CALLBACK_BYTES
    ? withRef
    : `${verb}:${nonce}`;
}

/**
 * `callback_data` for a digest's "all" button: `<G|R>:<nonce>` (APRV-115).
 *
 * Upper case, and no action key: an "all" button names a *delivery*, and the
 * set it decides is whichever members of that delivery are still open at the
 * moment of the tap — which the delivering process knows and the network does
 * not. Naming keys in the bytes would let something that can reach the bot
 * choose the set, and there is no length at which that becomes acceptable.
 */
export function digestCallbackData(verb: "G" | "R", nonce: string): string {
  return `${verb}:${nonce}`;
}

interface ParsedCallback {
  decision: "grant" | "reject";
  /** `all` for a digest's "all" button; `one` for every per-request button. */
  scope: "one" | "all";
  nonce: string;
  /** {@link actionRefOf} of the action this button was drawn for, when present. */
  actionRef: string | null;
}

const CALLBACK_VERBS: Record<string, { decision: "grant" | "reject"; scope: "one" | "all" }> = {
  g: { decision: "grant", scope: "one" },
  r: { decision: "reject", scope: "one" },
  G: { decision: "grant", scope: "all" },
  R: { decision: "reject", scope: "all" },
};

export function parseCallbackData(data: unknown): ParsedCallback | null {
  if (typeof data !== "string") return null;
  const first = data.indexOf(":");
  if (first === -1) return null;
  const verb = CALLBACK_VERBS[data.slice(0, first)];
  if (verb === undefined) return null;
  const rest = data.slice(first + 1);
  const second = rest.indexOf(":");
  const nonce = second === -1 ? rest : rest.slice(0, second);
  if (nonce.length === 0) return null;
  return {
    decision: verb.decision,
    scope: verb.scope,
    nonce,
    actionRef: second === -1 ? null : rest.slice(second + 1),
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
  /** {@link actionRefOf} of `actionKey`, precomputed for the APRV-196 lookup. */
  actionRef: string;
  deliveryId: DeliveryId;
  batchDeliveryId?: DeliveryId;
  /** When this process sent it, on {@link TelegramConfig.now}'s clock (APRV-135). */
  deliveredAtMs: number;
}

/**
 * What {@link TelegramChannel.notifyBatch} did with a set (APRV-115).
 *
 * `digestId` is `null` when the set was delivered the old way, one message per
 * member — the fallback every "cannot render this whole" path takes. `members`
 * carries the message id each member's annotation must edit, which for a digest
 * is the one digest message and for the fallback is the member's own.
 */
export interface TelegramBatchDelivery {
  batchDeliveryId: DeliveryId;
  digestId: DeliveryId | null;
  members: { action_key: string; delivery_id: DeliveryId }[];
  rendered: RenderedRequest[];
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
  /** The policy's approval TTL, or `null` when it declares none (APRV-135). */
  private readonly approvalTtlMs: number | null;
  private readonly now: () => number;
  /** The listener's verified-log probe for a stale tap (APRV-196), or null. */
  private readonly describeAction: ((actionRef: string) => string | null) | null;
  /** When {@link sweep} last ran, so the poll loop can call it every cycle. */
  private lastSweepMs = Number.NEGATIVE_INFINITY;

  /**
   * The callback query being handled, and whether an ack has been attempted for
   * it (APRV-196). Set and cleared by {@link handleUpdate}, which processes
   * updates one at a time and awaits each.
   */
  private ack: { id: string; answered: boolean } | null = null;

  private handler: ((decision: ChannelDecision) => DecisionOutcome) | null = null;
  private readonly deliveries = new Map<string, Delivery>();
  /** Digest message id -> what is on it. Delivery bookkeeping, never truth. */
  private readonly digests = new Map<DeliveryId, DigestState>();
  /** "All" nonce -> the digest message it was issued for. */
  private readonly allNonces = new Map<string, DeliveryId>();
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
      "stale-copy": 0,
    },
    staleCopyDecisions: 0,
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
    this.approvalTtlMs = config.approvalTtlMs ?? null;
    this.now = config.now ?? (() => Date.now());
    this.describeAction = config.describeAction ?? null;
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
   * Put a request, or a set of them, in front of the approver.
   *
   * One request is one prompt: its header, its payload chunks, and the
   * Approve/Reject keyboard on the last message, whose `message_id` is the
   * delivery id. A {@link ChannelBatch} goes through {@link notifyBatch} and
   * comes back as a digest when it can be one; either way it gets one shared
   * batch delivery id, which is what this returns and what every resulting
   * event will carry.
   */
  async notify(target: ChannelRequest | ChannelBatch): Promise<DeliveryId> {
    if ("requests" in target) return (await this.notifyBatch(target)).batchDeliveryId;
    const delivered = await this.deliverOne(target, undefined);
    this.rendered = [delivered.rendered];
    return delivered.deliveryId;
  }

  /**
   * Deliver a set as one digest, or as one message per member when it cannot
   * be one (APRV-115).
   *
   * The fallback is taken for a set of fewer than two, and for one whose digest
   * text would not fit inside {@link TELEGRAM_MAX_MESSAGE_CHARS}. Both are the
   * same rule: the approver sees every member before any button that decides
   * more than one appears, and when that cannot be arranged the channel sends
   * MORE messages rather than fewer.
   *
   * Not atomic, and it cannot be: a `sendMessage` that fails part way leaves
   * the messages already sent in the chat, and this throws. Nothing is armed —
   * the member nonces are registered only once the digest message carrying
   * their buttons exists — so the caller's retry re-sends the set and the
   * approver gets a duplicate prompt, never a live button on a half-sent one.
   */
  async notifyBatch(batch: ChannelBatch): Promise<TelegramBatchDelivery> {
    const members = batch.requests;
    const batchDeliveryId = batch.deliveryId ?? `tg-batch-${this.makeNonce()}`;

    const digest = members.length < 2 ? null : await this.deliverDigest(members, batchDeliveryId);
    if (digest !== null) {
      this.rendered = digest.rendered;
      return digest;
    }

    const rendered: RenderedRequest[] = [];
    const delivered: { action_key: string; delivery_id: DeliveryId }[] = [];
    for (const member of members) {
      const one = await this.deliverOne(member, batchDeliveryId);
      rendered.push(one.rendered);
      delivered.push({ action_key: member.action_key.value, delivery_id: one.deliveryId });
    }
    this.rendered = rendered;
    return { batchDeliveryId, digestId: null, members: delivered, rendered };
  }

  /**
   * The digest itself: every member's prompt and payload, then the one message
   * that carries the buttons.
   *
   * Returns `null` when the digest message would not fit, so the caller falls
   * back — and it decides that BEFORE sending anything, because a fallback
   * discovered after four member prompts had gone out would double them.
   */
  private async deliverDigest(
    members: ChannelRequest[],
    batchDeliveryId: DeliveryId,
  ): Promise<TelegramBatchDelivery | null> {
    const allNonce = this.makeNonce();
    const deliveredAtMs = this.now();
    const state: DigestState = {
      deliveredAtMs,
      // Assigned once the message exists; nothing consults it before then.
      deliveryId: "",
      batchDeliveryId,
      allNonce,
      facts: digestFacts(members),
      author: originOf((members[0] as ChannelRequest).summary),
      members: members.map((member) => ({
        actionKey: member.action_key.value,
        nonce: this.makeNonce(),
        summary: member.summary.value ?? "(none given)",
        cost: `$${member.est_cost_usd.value.toFixed(2)}`,
        settled: null,
      })),
    };

    const drawn = renderDigest(state);
    if (drawn.text.length > TELEGRAM_MAX_MESSAGE_CHARS) return null;

    const rendered: RenderedRequest[] = [];
    for (const [index, member] of members.entries()) {
      const one = await this.sendPrompt(
        member,
        `REQUEST ${index + 1} OF ${members.length} — decide it on the digest below`,
        null,
      );
      rendered.push({ ...one.rendered, batchDeliveryId });
    }

    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.chatId,
      text: drawn.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(drawn.keyboard === null ? {} : { reply_markup: drawn.keyboard }),
    });
    const deliveryId = String(result.message_id);
    state.deliveryId = deliveryId;

    // Armed only now, and all at once: until the message with the buttons on it
    // exists there is nothing a callback could legitimately answer.
    for (const member of state.members) {
      this.deliveries.set(member.nonce, {
        actionKey: member.actionKey,
        actionRef: actionRefOf(member.actionKey),
        deliveryId,
        batchDeliveryId,
        deliveredAtMs,
      });
    }
    this.digests.set(deliveryId, state);
    this.allNonces.set(allNonce, deliveryId);
    this.counters.notified += members.length;

    return {
      batchDeliveryId,
      digestId: deliveryId,
      members: state.members.map((member) => ({
        action_key: member.actionKey,
        delivery_id: deliveryId,
      })),
      rendered,
    };
  }

  /**
   * Send one request's messages: the computed header, the payload chunks, then
   * the claimed block, with `keyboard` (when there is one) on the last.
   *
   * The claimed block goes last because it is the human-meaningful description
   * of the act, and the message a reader answers on should be the one that says
   * what they are answering about; bookkeeping above it is context, not the
   * question. SPEC §10.3 allows claimed material to sit around the canonical
   * block while it stays visibly separated and labelled, which the heading on
   * every claimed message keeps. It is always sent, so a missing summary is a
   * visible "(none given)" rather than an absent message, and so the keyboard
   * has one message it can always ride on.
   *
   * Shared by the ordinary prompt and by a digest member, which differ in
   * exactly two things: the heading, and whether anything is armed.
   */
  private async sendPrompt(
    request: ChannelRequest,
    heading: string,
    keyboard: { inline_keyboard: InlineButton[][] } | null,
  ): Promise<{ deliveryId: DeliveryId; rendered: RenderedRequest }> {
    const rendering = renderTelegram(request, heading);

    const segments: string[] = [rendering.header];
    if (rendering.payloadText !== null) {
      const chunks = chunkForTelegram(rendering.payloadText);
      for (const [index, chunk] of chunks.entries()) {
        const label =
          chunks.length === 1
            ? `<b>${PAYLOAD_CHUNK_LABEL}</b>`
            : `<b>PAYLOAD ${index + 1}/${chunks.length} — ${PAYLOAD_CHUNK_LABEL_TAIL}</b>`;
        segments.push(`${label}\n<pre>${escapeHtml(chunk)}</pre>`);
      }
    }
    for (const [index, chunk] of chunkClaimedForTelegram(rendering.claimedText).entries()) {
      segments.push(
        index === 0 ? chunk : `<b>${TELEGRAM_CLAIMED_CONTINUED_HEADING}</b>\n${chunk}`,
      );
    }

    let deliveryId = "";
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const result = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        text: segment,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(last && keyboard !== null ? { reply_markup: keyboard } : {}),
      });
      if (last) deliveryId = String(result.message_id);
    }

    const fields: RenderedField[] = rendering.lines.map((entry) => ({
      field: entry.field,
      kind: entry.kind,
      text: entry.text,
    }));

    return {
      deliveryId,
      rendered: {
        action_key: request.action_key.value,
        fields,
        fullPayloadText: rendering.payloadText,
      },
    };
  }

  private async deliverOne(
    request: ChannelRequest,
    batchDeliveryId: DeliveryId | undefined,
  ): Promise<{ deliveryId: DeliveryId; rendered: RenderedRequest }> {
    const actionKey = request.action_key.value;
    const nonce = this.makeNonce();
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: callbackData("g", nonce, actionKey) },
          { text: "🛑 Reject", callback_data: callbackData("r", nonce, actionKey) },
        ],
      ],
    };

    const sent = await this.sendPrompt(request, TELEGRAM_PROMPT_HEADING, keyboard);

    this.counters.notified += 1;
    this.deliveries.set(nonce, {
      actionKey,
      actionRef: actionRefOf(actionKey),
      deliveryId: sent.deliveryId,
      deliveredAtMs: this.now(),
      ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
    });

    return {
      deliveryId: sent.deliveryId,
      rendered: {
        ...sent.rendered,
        ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
      },
    };
  }

  /**
   * Forget every nonce issued for `deliveryId`, and report the action key it
   * was issued for.
   *
   * Called by {@link annotate} before the edit goes out, so a tap on a button
   * the edit does not manage to remove resolves to nothing and is answered as
   * a `stale-copy` rather than carried to the gate as a decision attempt.
   * Forgetting is never the channel growing state, and forgetting a SETTLED
   * request is what stops APRV-196's action-reference fallback from finding it:
   * the ladder rescues a tap on an old copy of a request still open here, and
   * a decided one is not that.
   */
  private disarm(deliveryId: DeliveryId): string {
    let actionKey = "";
    // Deleting the current entry mid-iteration is defined behaviour for a Map,
    // and every nonce for this message id goes — a re-notify of the same
    // message would otherwise leave an older nonce still resolving.
    for (const [nonce, delivery] of this.deliveries) {
      if (delivery.deliveryId !== deliveryId) continue;
      actionKey = delivery.actionKey;
      this.deliveries.delete(nonce);
    }
    const digest = this.digests.get(deliveryId);
    if (digest !== undefined) {
      this.allNonces.delete(digest.allNonce);
      this.digests.delete(deliveryId);
    }
    return actionKey;
  }

  /**
   * Drop the delivery bookkeeping no callback can still be honoured against
   * (APRV-135).
   *
   * The condition is both halves of the sentence, evaluated per entry:
   *
   * 1. **Every member is terminal.** For a digest that means every member
   *    carries a `settled` outcome; for a unit delivery it is automatic in the
   *    other direction, since annotating a decided, expired or withdrawn
   *    request already forgets its nonces ({@link disarm}), so a delivery still
   *    in the map is one this process has not seen settled. A request past its
   *    approval TTL is terminal too — the gate refuses every decision on it —
   *    which is what lets an unannotated delivery be swept at all.
   * 2. **Older than the retention window**, which is the policy's approval TTL
   *    when it declares one and {@link TELEGRAM_DEFAULT_RETENTION_MS} when it
   *    does not. Measured from the moment THIS process delivered the message,
   *    which is at or after the `approval.requested` the TTL actually runs
   *    from, so the window this sweep waits out is never shorter than the one
   *    the gate enforces.
   *
   * Both together are what makes forgetting safe: a live button can never
   * reference a dropped entry, because the state in which no callback can still
   * be honoured is exactly the state in which the entry is dropped. A tap that
   * arrives anyway is answered by the stale-callback path a restarted
   * listener's buttons already take: `stale-copy` since APRV-196, counted,
   * toasted with what the log says became of the request, never carried to the
   * gate.
   *
   * Process memory only. No event, no message edit, no log read. `nowMs`
   * defaults to the configured clock and is a parameter so a test can run a
   * simulated week without one.
   */
  sweep(nowMs: number = this.now()): { deliveries: number; digests: number } {
    this.lastSweepMs = nowMs;
    const retention = this.approvalTtlMs ?? TELEGRAM_DEFAULT_RETENTION_MS;
    const expired = (deliveredAtMs: number): boolean => nowMs - deliveredAtMs >= retention;
    // Past the approval TTL the gate refuses every decision, so the request is
    // terminal whether or not this process saw it settle. With no TTL declared
    // nothing expires, and only an observed settlement makes an entry droppable.
    const lapsed = (deliveredAtMs: number): boolean =>
      this.approvalTtlMs !== null && nowMs - deliveredAtMs >= this.approvalTtlMs;

    let digests = 0;
    for (const [deliveryId, digest] of this.digests) {
      const terminal = digest.members.every((member) => member.settled !== null);
      if (!(terminal || lapsed(digest.deliveredAtMs)) || !expired(digest.deliveredAtMs)) continue;
      this.digests.delete(deliveryId);
      this.allNonces.delete(digest.allNonce);
      digests += 1;
    }

    let deliveries = 0;
    for (const [nonce, delivery] of this.deliveries) {
      // A nonce whose digest is still remembered is still armed on a message
      // with buttons, whatever its own age says; the digest is the entry that
      // decides, and it was just judged above.
      if (this.digests.has(delivery.deliveryId)) continue;
      if (!lapsed(delivery.deliveredAtMs) || !expired(delivery.deliveredAtMs)) continue;
      this.deliveries.delete(nonce);
      deliveries += 1;
    }

    return { deliveries, digests };
  }

  /** How many entries the bookkeeping holds. For tests and for operators. */
  bookkeepingSize(): { deliveries: number; digests: number; allNonces: number } {
    return {
      deliveries: this.deliveries.size,
      digests: this.digests.size,
      allNonces: this.allNonces.size,
    };
  }

  /**
   * Mark one digest member settled and redraw the digest (APRV-115).
   *
   * The member's own nonce is forgotten first, so a tap on a button the redraw
   * does not manage to remove resolves to nothing rather than reaching the
   * gate. The other members keep theirs: a partially decided digest is a real
   * state and the rest of it is still answerable.
   */
  private async settleMember(
    digest: DigestState,
    actionKey: string,
    outcome: string,
    detail: string[],
  ): Promise<void> {
    const member = digest.members.find((entry) => entry.actionKey === actionKey);
    if (member === undefined || member.settled !== null) return;
    member.settled = { headline: outcome, detail };
    this.deliveries.delete(member.nonce);
    if (digest.members.every((entry) => entry.settled !== null)) {
      this.allNonces.delete(digest.allNonce);
    }
    await this.redraw(digest);
  }

  /** One `editMessageText` that replaces a digest's text and its keyboard. */
  private async redraw(digest: DigestState): Promise<void> {
    const drawn = renderDigest(digest);
    await this.call("editMessageText", {
      chat_id: this.chatId,
      message_id: Number(digest.deliveryId),
      text: drawn.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(drawn.keyboard === null ? {} : { reply_markup: drawn.keyboard }),
    });
  }

  /**
   * Edit a delivered message to say what became of its question, and remove the
   * buttons (APRV-106 for withdrawal, generalized in APRV-113 to every terminal
   * state).
   *
   * ONE `editMessageText` call, not two. Telegram's `editMessageText` replaces
   * the reply markup along with the text, and omitting `reply_markup` clears
   * it — so the annotation and the disarming land together, and there is no
   * window in which the message reads "approved" and still offers a tap.
   *
   * The text is REPLACED rather than appended to, because this class does not
   * remember what it sent (it remembers a nonce and a message id) and refetching
   * a message to append to it would be the channel reconstructing state it is
   * not supposed to hold. What the approver keeps is the outcome, the action key
   * and the detail lines, which is what a chat transcript needs to stay readable.
   *
   * `outcome` is a headline word (see {@link TELEGRAM_TERMINAL_HEADLINES}) and
   * `detail` the lines under it; both are HTML-escaped here, and neither may
   * carry an execution token — no caller in this repository has one to give,
   * since {@link DecisionOutcome} deliberately does not carry it.
   *
   * Best effort: {@link TelegramApiError} propagates to the caller, which logs
   * it and carries on. A message that could not be edited is a cosmetic
   * problem — the log has already settled the request, so a tap on the stale
   * buttons is refused by the gate and answered with the refusal toast.
   */
  async annotate(
    deliveryId: DeliveryId,
    outcome: string,
    detail: string[],
    /**
     * Which request this settles, when `deliveryId` names a digest (APRV-115).
     * A digest holds several, so an annotation without one can only mean the
     * whole delivery is over — which is handled by falling through to the
     * message-replacing path below, buttons and all.
     */
    actionKey?: string,
  ): Promise<void> {
    const digest = this.digests.get(deliveryId);
    if (digest !== undefined && actionKey !== undefined) {
      await this.settleMember(digest, actionKey, outcome, detail);
      return;
    }
    const settledKey = this.disarm(deliveryId);
    const text = [
      `<b>${escapeHtml(outcome)}</b>`,
      `<code>${escapeHtml(actionKey ?? settledKey)}</code>`,
      "",
      ...detail.map((entry) => escapeHtml(entry)),
    ].join("\n");
    await this.call("editMessageText", {
      chat_id: this.chatId,
      message_id: Number(deliveryId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  /**
   * The withdrawal case of {@link annotate} (APRV-106), and the one the
   * {@link Channel} interface names. Its wording is unchanged.
   */
  async retract(deliveryId: DeliveryId, reason: string, actionKey?: string): Promise<void> {
    await this.annotate(deliveryId, TELEGRAM_TERMINAL_HEADLINES.withdrawn, [reason], actionKey);
  }

  /**
   * Send one plain message that carries no question (APRV-196).
   *
   * Used for the re-delivery banner the listener puts in front of a startup
   * batch. It arms nothing, remembers nothing, and names no action key: a
   * banner is a sentence about the messages that follow, and a reader who
   * mistook it for a request would be a reader the banner had made worse off.
   * `lines` are escaped here, exactly as everything else interpolated into an
   * HTML-mode message is.
   */
  async announce(lines: string[]): Promise<DeliveryId> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.chatId,
      text: lines
        .map((entry, index) =>
          index === 0 ? `<b>${escapeHtml(entry)}</b>` : escapeHtml(entry),
        )
        .join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return String(result.message_id);
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
    // APRV-135. Before the long poll, not after: this is where the loop is
    // about to block for up to `pollTimeoutSeconds`, and a sweep that ran after
    // the block would be a sweep that never runs on a quiet chat. Rate-limited
    // so a driver calling `pollOnce` in a tight loop does not spend its time
    // walking two maps.
    const nowMs = this.now();
    if (nowMs - this.lastSweepMs >= TELEGRAM_SWEEP_INTERVAL_MS) this.sweep(nowMs);

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

  /**
   * Exactly one `answerCallbackQuery` per callback query, on every path
   * (APRV-196).
   *
   * The incident this closes: a tap that reached no branch with a toast on it
   * spun on the approver's phone until Telegram gave up, and the human — with
   * no way to tell a swallowed tap from a slow one — tapped again. So the ack
   * is a property of the WRAPPER rather than of each branch: every route below
   * still writes its own, better sentence, and anything that fails to (a throw
   * halfway through, a branch a later change forgets) is caught here and
   * answered with {@link TELEGRAM_ACK_FALLBACK}.
   *
   * A thrown handler is answered and swallowed rather than propagated, and that
   * is deliberate: `pollOnce` throwing puts `listen` into its backoff, so one
   * malformed update would cost the whole batch and the poll after it. Nothing
   * is lost by continuing — the gate has already appended whatever it appended,
   * and the log is what says so.
   */
  private async handleUpdate(
    update: Record<string, unknown>,
    result: TelegramPollResult,
  ): Promise<void> {
    const callback = update["callback_query"];
    if (typeof callback !== "object" || callback === null) return;
    const query = callback as Record<string, unknown>;
    const callbackId = typeof query["id"] === "string" ? query["id"] : "";

    this.ack = { id: callbackId, answered: false };
    try {
      await this.routeCallback(query, callbackId, result);
    } catch (cause) {
      this.complain(
        `approval: telegram failed while handling a callback: ${this.describe(cause)} — the tap is answered; whatever the gate appended stands`,
      );
      await this.safeAnswer(callbackId, TELEGRAM_ACK_FALLBACK);
    } finally {
      const pending = this.ack;
      this.ack = null;
      if (pending !== null && !pending.answered) {
        await this.safeAnswer(callbackId, TELEGRAM_ACK_FALLBACK);
      }
    }
  }

  private async routeCallback(
    query: Record<string, unknown>,
    callbackId: string,
    result: TelegramPollResult,
  ): Promise<void> {
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

    // APRV-115. An "all" button names a digest, not a request: the set it
    // decides is whatever is still open on that delivery right now, which this
    // process knows and the callback bytes deliberately do not say.
    if (parsed.scope === "all") {
      await this.handleDigestAll(parsed.decision, parsed.nonce, callbackId, result);
      return;
    }

    // The resolution ladder (APRV-196). A tap is answered by the nonce when
    // this process issued it, by the action reference when it did not, and by
    // the log when neither is holding the action open.
    let delivery = this.deliveries.get(parsed.nonce);
    let viaStaleCopy = false;

    if (delivery === undefined && parsed.actionRef !== null) {
      // The pre-restart copy. Its nonce died with the process that issued it,
      // but the request it names is one THIS process has since re-delivered, so
      // the tap decides that request — on the live copy's message, which is
      // where the annotation belongs. The bytes select among what this listener
      // has itself put in this chat and can name nothing else; the gate then
      // does everything it does for any other tap.
      delivery = this.liveDeliveryFor(parsed.actionRef);
      viaStaleCopy = delivery !== undefined;
    }

    if (delivery === undefined) {
      if (parsed.actionRef !== null) {
        // Nothing open here for that action. Say what the log says, which is
        // the only thing that knows: decided, lapsed, withdrawn, or unknown.
        const described = this.describeAction?.(parsed.actionRef) ?? null;
        await this.ignore(
          result,
          callbackId,
          "stale-copy",
          `no open delivery for action ref ${JSON.stringify(parsed.actionRef)} (an earlier copy of a request this listener is not holding open)`,
          described ?? TELEGRAM_STALE_UNKNOWN,
        );
        return;
      }
      await this.ignore(
        result,
        callbackId,
        "unknown-callback",
        `no delivery for nonce ${JSON.stringify(parsed.nonce)} (a restarted listener forgets its buttons; the pending queue is re-sent on start)`,
        // Two ways to get here, and the reply has to serve both: a button this
        // process never issued (a restart forgot it), and a button on a message
        // this process has already annotated (APRV-113 forgets the nonce with
        // the edit). Either way the message text is the thing to read.
        "This button is no longer live — read the message for the outcome, or the newest message for the request.",
      );
      return;
    }

    if (!viaStaleCopy && parsed.actionRef !== null && parsed.actionRef !== delivery.actionRef) {
      await this.ignore(
        result,
        callbackId,
        "key-mismatch",
        `callback references ${JSON.stringify(parsed.actionRef)} but the nonce was issued for ${JSON.stringify(delivery.actionKey)}`,
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
    if (viaStaleCopy) {
      this.counters.staleCopyDecisions += 1;
      this.complain(
        `approval: telegram resolved a tap on an earlier copy of ${delivery.actionKey} to the live delivery (message ${delivery.deliveryId})`,
      );
    }
    result.outcomes.push({ action_key: delivery.actionKey, outcome });
    // Best effort, and before the edit: the toast is what the tapping human is
    // waiting on, and a Bot API that refuses it (a callback older than
    // Telegram's own window, most often) must not cost them the annotation the
    // message is about to get.
    await this.safeAnswer(
      callbackId,
      `${viaStaleCopy ? TELEGRAM_STALE_COPY_PREFIX : ""}${this.answerFor(decision, outcome)}`,
    );

    // APRV-113. The tap is now visible in the transcript, not only in a toast
    // that vanishes. The outcome word comes from the record the gate actually
    // appended, so a refused tap (already decided, withdrawn, expired) edits
    // nothing and the message keeps whatever the poll cycle later gives it.
    //
    // AFTER the toast, and never before it: the toast is the thing the tapping
    // human is waiting on, and a slow edit must not delay it. Best effort in
    // the same sense `retract` is — a failed edit is complained about and
    // dropped, because the decision is already in the log and nothing about it
    // depends on a chat message being redrawn.
    if (!outcome.ok) return;
    const record = outcome.record;
    const headline =
      outcome.decision === "grant"
        ? TELEGRAM_TERMINAL_HEADLINES.granted
        : TELEGRAM_TERMINAL_HEADLINES.rejected;
    try {
      await this.annotate(
        delivery.deliveryId,
        headline,
        [decidedLine(record.actor, record.ts, record.seq)],
        delivery.actionKey,
      );
    } catch (cause) {
      this.complain(
        `approval: telegram could not annotate the decided ${delivery.actionKey} (message ${delivery.deliveryId}): ${this.describe(cause)} — the decision is recorded; only the message is stale`,
      );
    }
  }

  /**
   * One tap over every still-open member of a digest (APRV-115).
   *
   * **N decisions, never one.** Each member is turned into its own
   * {@link ChannelDecision} — its own action key, its own payload binding — and
   * handed to the runtime's handler on its own, which records it through the
   * gate's compare-and-append on its own. There is no code path here that could
   * produce a single event covering two actions, because there is no call here
   * that writes anything at all.
   *
   * A member that refuses (already decided elsewhere, expired, withdrawn) does
   * not stop the rest, for the reason `channels/batch.ts` sets out: abandoning
   * four answers because the fifth had lapsed would discard a human's decision,
   * and un-appending the ones already written is not a thing the log permits.
   * The toast says how many landed and how many did not.
   *
   * The digest is redrawn ONCE at the end rather than per member: N edits of
   * the same message would show the approver their own decisions arriving one
   * at a time, and would spend N Bot API calls to end in the same place.
   */
  private async handleDigestAll(
    decision: "grant" | "reject",
    nonce: string,
    callbackId: string,
    result: TelegramPollResult,
  ): Promise<void> {
    const deliveryId = this.allNonces.get(nonce);
    const digest = deliveryId === undefined ? undefined : this.digests.get(deliveryId);
    if (digest === undefined) {
      await this.ignore(
        result,
        callbackId,
        "unknown-callback",
        `no digest for nonce ${JSON.stringify(nonce)} (a restarted listener forgets its buttons; the pending queue is re-sent on start)`,
        "This button is no longer live — read the message for the outcome, or the newest message for the requests.",
      );
      return;
    }

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

    const open = digest.members.filter((member) => member.settled === null);
    let landed = 0;
    const refusals: string[] = [];

    for (const member of open) {
      const one: ChannelDecision = {
        action_key: member.actionKey,
        decision,
        deliveryId: digest.deliveryId,
        batchDeliveryId: digest.batchDeliveryId,
        ...(decision === "reject"
          ? { note: `${TELEGRAM_REJECT_NOTE} (callback ${callbackId}, all)` }
          : {}),
      };
      const outcome = this.handler(one);
      this.counters.decisions += 1;
      result.outcomes.push({ action_key: member.actionKey, outcome });

      if (!outcome.ok) {
        refusals.push(outcome.code);
        continue;
      }
      landed += 1;
      // Bookkeeping only: the words come from the record the gate appended.
      member.settled = {
        headline:
          outcome.decision === "grant"
            ? TELEGRAM_TERMINAL_HEADLINES.granted
            : TELEGRAM_TERMINAL_HEADLINES.rejected,
        detail: [decidedLine(outcome.record.actor, outcome.record.ts, outcome.record.seq)],
      };
      this.deliveries.delete(member.nonce);
    }

    if (digest.members.every((member) => member.settled !== null)) {
      this.allNonces.delete(digest.allNonce);
    }

    const word = decision === "grant" ? "Approved" : "Rejected";
    const summary =
      refusals.length === 0
        ? `${word} ${landed} — one log event each.`
        : `${word} ${landed}; ${refusals.length} refused (${[...new Set(refusals)].join(", ")}). Nothing was recorded for those.`;
    await this.safeAnswer(callbackId, summary);

    try {
      await this.redraw(digest);
    } catch (cause) {
      this.complain(
        `approval: telegram could not redraw the digest (message ${digest.deliveryId}): ${this.describe(cause)} — the decisions are recorded; only the message is stale`,
      );
    }
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
    // APRV-106. The tap that races the withdrawal, or lands on a message whose
    // edit did not go through. Nothing is appended and the human is told why
    // in the terms that matter to them: the asker is gone, so there is nothing
    // their answer could do.
    if (outcome.code === "request-withdrawn") {
      return "Withdrawn — the requester took this back and is no longer waiting; nothing was recorded.";
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
    // effort and its failure is not the listener's problem. Through
    // {@link safeAnswer} since APRV-196, so that this counts as THE ack for the
    // query and `handleUpdate`'s guarantee does not add a second, vaguer one on
    // top of the sentence this path already chose.
    await this.safeAnswer(callbackId, reply);
  }

  private async answer(callbackId: string, text: string): Promise<void> {
    if (callbackId.length === 0) return;
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  /**
   * Answer, and never throw (APRV-196).
   *
   * A toast is a courtesy on every path, including the successful one: the
   * decision is already in the log by the time the ack is attempted, and an
   * `answerCallbackQuery` that fails (Telegram drops a query after its own
   * window, and a phone on a train produces plenty of late taps) must not
   * abandon the annotation or push the poll loop into backoff.
   *
   * The attempt is recorded either way, so {@link handleUpdate}'s guarantee
   * does not turn one failed ack into a second doomed call.
   */
  private async safeAnswer(callbackId: string, text: string): Promise<void> {
    if (this.ack !== null && this.ack.id === callbackId) this.ack.answered = true;
    if (callbackId.length === 0) return;
    try {
      await this.answer(callbackId, text);
    } catch (cause) {
      this.complain(
        `approval: telegram could not answer a callback (${this.describe(cause)}) — the tap has no toast; the log is unaffected`,
      );
    }
  }

  /**
   * The delivery this process is holding open for an action reference, if any
   * (APRV-196).
   *
   * A linear walk of the delivery map rather than a second index: the map is
   * bounded by the pending queue and swept (APRV-135), this runs only on the
   * uncommon path where a nonce did not resolve, and a second map would be a
   * second thing to keep in step with `disarm`, `settleMember` and `sweep` —
   * three places where forgetting is the safety property.
   *
   * Digest members are eligible: a member's nonce is deleted the moment it is
   * settled, so a member still in the map is one still armed on a live message.
   */
  private liveDeliveryFor(actionRef: string): Delivery | undefined {
    for (const delivery of this.deliveries.values()) {
      if (delivery.actionRef === actionRef) return delivery;
    }
    return undefined;
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
