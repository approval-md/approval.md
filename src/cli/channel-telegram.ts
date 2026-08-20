/**
 * `approval channel telegram listen | health` — the runtime half of the
 * Telegram channel (SPEC.md §10.3, APRV-26).
 *
 * As everywhere else in this CLI, **no logic lives here**. The rendering and
 * the Bot API are `channels/telegram.ts`; turning a button press into an event
 * is `channels/contract.ts`'s `recordChannelDecision`, which calls the
 * human-only `decide()` in `core/gate.ts`. This file resolves configuration,
 * builds the pending queue, wires the two together, and chooses an exit code.
 *
 * Three things it does that the channel deliberately cannot:
 *
 * 1. **It reads the environment.** `APPROVAL_TG_TOKEN` and `APPROVAL_TG_CHAT`
 *    are read here and passed to the channel as values (SPEC.md §5.1: policy
 *    carries the env-var *names*, never the secrets). Nothing in `channels/`
 *    touches `process.env`.
 * 2. **It declares who is approving.** The decision is recorded against the
 *    human actor from `--as` / `APPROVAL_HUMAN`, never against anything the
 *    callback carried. SPEC.md §11: identity in v0.1 is config-declared, the
 *    trust boundary is the local machine, and everyone who can reach the
 *    configured chat can approve as that actor. This is stated in `--help`
 *    because an operator has to be able to see it without reading the source.
 * 3. **It holds the token.** A grant mints a single-use execution token;
 *    `recordChannelDecision` returns it to *this* handler, which prints it on
 *    **stdout** and never hands it back to the channel. It is never sent to
 *    Telegram — see the module doc of `channels/telegram.ts` for why a chat
 *    transcript is not a credential store, and for the flag on that decision.
 *
 * ## Payload material — the store, and why `--payloads` still exists
 *
 * SPEC.md §6.2 records a `payload_hash` in the log and never the bytes, and
 * §10.4 requires a channel to present the full payload for a manual action. So
 * the bytes must come from somewhere the runtime can reach. Since APRV-28 that
 * somewhere is the payload store beside the log (`.approval/payloads/`, written
 * by `approval request --payload`), and a listener ordinarily needs no payload
 * flag at all. `--payloads` remains an override for bytes an operator holds
 * elsewhere: a JSON file mapping action key to that action's payload value,
 * consulted before the store. The tagger
 * (`channels/tagging.ts`) re-hashes whatever it is given and refuses anything
 * that does not match the recorded binding, so a wrong or stale file cannot put
 * different bytes in front of an approver than the token will execute — it
 * produces a visible skip instead. Requests whose material is missing are
 * reported on stderr and NOT delivered: a manual request rendered without its
 * payload would be exactly the §10.4 violation the contract refuses.
 *
 * ## Dispatch: where it lives, and why it lives here (APRV-55) — flagged
 *
 * SPEC.md §10.2 lists "dispatches channel notifications" among the daemon's
 * jobs. At v0.1 the reference runtime performs that dispatch **in this
 * listener**, on every poll cycle, and the placement is deliberate:
 *
 * 1. The listener already holds the channel connection (the bot token, the
 *    chat id) and the approver identity. The daemon holds neither, and giving
 *    it either would put a credential and a human identity into a process
 *    whose job is to read files and append events.
 * 2. The daemon is the sole writer of the log; dispatch appends nothing. Moving
 *    a read-and-send out of the daemon costs the single-writer stance nothing,
 *    because dispatch was never a write.
 * 3. A network round-trip inside the daemon's tick couples the projection loop
 *    to Telegram's availability. A slow Bot API would delay TTL expiry and
 *    write-back, which are the daemon's actual obligations.
 *
 * So this is an implementation placement, not a change to the daemon's stated
 * role: a later build MAY move dispatch into the daemon (or a supervisor) with
 * no change to the log or to any event shape. SPEC.md §10.3 records the same.
 *
 * ### The cycle
 *
 * {@link dispatchPending} runs before every `getUpdates` — the startup send and
 * every later cycle are the same call with the same state, the startup one
 * merely finding an empty delivered set. Each call **re-derives** the pending
 * queue from the verified log ({@link buildPendingQueue}), so which requests
 * are pending is always the log's answer and never this process's memory. A
 * request appended while the listener is running is therefore delivered on the
 * next cycle, without a restart; a request that was decided or whose TTL lapsed
 * simply stops appearing in the derivation and is never sent.
 *
 * What *is* remembered, and only in {@link DispatchState} for this process's
 * lifetime, is which action keys this listener has already put on the phone.
 * Losing that memory (a restart, a crash) re-sends everything still pending:
 * a duplicate on the phone, never silence. That direction is the whole design
 * (SPEC.md §10.3: channels hold no state that is a source of truth).
 *
 * ### Send failures
 *
 * A key that fails to send stays undelivered, so the next cycle retries it.
 * There is **no attempt limit**: giving up would turn a transient outage into a
 * pending request no human ever sees, which is the one failure this project
 * exists to prevent. The retry rate is bounded by the poll cycle itself (the
 * long-poll timeout, or the channel's doubling backoff after a poll error), and
 * the stderr warnings are throttled after {@link DISPATCH_LOUD_ATTEMPTS}
 * consecutive failures for one key so a long outage cannot bury the terminal.
 * The one exception is the **startup** dispatch, which still exits non-zero on
 * a send failure: an operator who has just mistyped a chat id or a token should
 * learn it immediately rather than watch a listener retry forever.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import type { DecideOptions } from "../core/gate.js";
import {
  recordChannelDecision,
  type ChannelDecision,
  type DecisionOutcome,
  type DeliveryId,
} from "../channels/contract.js";
import {
  buildPendingQueue,
  type ChannelTagRefusalCode,
  type TagOptions,
} from "../channels/tagging.js";
import {
  decidedLine,
  isTelegramTerminalState,
  TelegramChannel,
  telegramChatEnvFor,
  telegramTokenEnvFor,
  TELEGRAM_TERMINAL_HEADLINES,
  utcClock,
  type TelegramConfig,
  type TelegramTerminalState,
} from "../channels/telegram.js";
import { loadPolicy } from "../core/policy-load.js";
import { payloadOf, readVerifiedRecords, requestState } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  TELEGRAM_HEALTH_HELP,
  TELEGRAM_HELP,
  TELEGRAM_LISTEN_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { style, tokenPanel, TOKEN_NOTICE_TELEGRAM } from "./style.js";
import { usageErrorText } from "./usage.js";

const LISTEN_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--as": "string",
  "--payloads": "string",
  "--api-base": "string",
  "--poll-timeout": "string",
  "--once": "boolean",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, helpText));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function integrityError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "integrity", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_INTEGRITY;
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/** A non-empty environment value, or `null`. Whitespace-only counts as unset. */
function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

// ---------------------------------------------------------------------------
// approval channel telegram listen
// ---------------------------------------------------------------------------

export interface ListenSetup {
  channel: TelegramChannel;
  logPath: string;
  actor: string;
  json: boolean;
  once: boolean;
  gateOptions: DecideOptions;
  tagOptions: TagOptions;
}

function payloadSource(
  path: string | null,
  cwd: string,
): { ok: true; source: TagOptions["payload"] } | { ok: false; message: string } {
  if (path === null) return { ok: true, source: undefined };
  const resolved = absolute(path, cwd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (cause) {
    return {
      ok: false,
      message: `--payloads ${resolved} could not be read as JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      message: `--payloads ${resolved} must hold a JSON object mapping action key to that action's payload value`,
    };
  }
  const table = parsed as Record<string, unknown>;
  return { ok: true, source: (actionKey: string) => table[actionKey] };
}

/**
 * Everything that can fail without touching the network, in order.
 *
 * Deliberately sequential and deliberately synchronous: an operator who typed
 * the wrong thing learns it before a bot message is sent, and the async half
 * below can then assume its configuration is whole.
 */
function setUp(
  argv: string[],
  streams: Streams,
  cwd: string,
): { kind: "handled"; code: number } | { kind: "run"; setup: ListenSetup } {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, LISTEN_FLAGS);
  if (!parsed.ok) {
    return { kind: "handled", code: usageError(streams, json, parsed.message, TELEGRAM_LISTEN_HELP) };
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${TELEGRAM_LISTEN_HELP}\n`);
    return { kind: "handled", code: EXIT_OK };
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return {
      kind: "handled",
      code: usageError(
        streams,
        json,
        `unexpected argument ${JSON.stringify(extra)}`,
        TELEGRAM_LISTEN_HELP,
      ),
    };
  }

  const flags = parsed.flags;

  // Resolved here rather than after the log preflight because the policy is
  // what NAMES the credential variables (below), and a message about a missing
  // variable must name the one this policy actually asked for.
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  // Configuration is environment-only: policy names the variables, never the
  // values (SPEC.md §5.1), and there is no flag that would put a bot token in
  // a shell history or a process listing. A policy that fails to load names
  // nothing and the reference defaults apply — the load is fail-closed for
  // autonomy and budgets, and a variable name is not a permission.
  const policyLoad = loadPolicy(policy);
  const tokenEnv = telegramTokenEnvFor(policyLoad);
  const chatEnv = telegramChatEnvFor(policyLoad);
  const token = env(tokenEnv);
  const chatId = env(chatEnv);
  if (token === null || chatId === null) {
    const missing = [
      token === null ? tokenEnv : null,
      chatId === null ? chatEnv : null,
    ].filter((name): name is string => name !== null);
    return {
      kind: "handled",
      code: usageError(
        streams,
        json,
        `telegram is not configured: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset or empty (both ${tokenEnv} and ${chatEnv} are required; APPROVAL.md carries only their names)`,
        TELEGRAM_LISTEN_HELP,
      ),
    };
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return {
      kind: "handled",
      code: usageError(
        streams,
        json,
        asFlag === null
          ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>. Every decision this listener records is recorded against it, and nothing here authenticates it`
          : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; approvals are human-only`,
        TELEGRAM_LISTEN_HELP,
      ),
    };
  }

  const pollFlag = stringFlag(flags, "--poll-timeout");
  if (pollFlag !== null && !/^\d+$/u.test(pollFlag)) {
    return {
      kind: "handled",
      code: usageError(
        streams,
        json,
        `--poll-timeout expects a whole number of seconds, got ${JSON.stringify(pollFlag)}`,
        TELEGRAM_LISTEN_HELP,
      ),
    };
  }

  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const check = preflightLog(logPath);
  if (!check.ok) return { kind: "handled", code: ioError(streams, json, check.message) };

  const payloads = payloadSource(stringFlag(flags, "--payloads"), cwd);
  if (!payloads.ok) {
    return { kind: "handled", code: ioError(streams, json, payloads.message) };
  }

  const config: TelegramConfig = {
    token,
    chatId,
    ...(stringFlag(flags, "--api-base") === null
      ? {}
      : { apiBase: stringFlag(flags, "--api-base") as string }),
    ...(pollFlag === null ? {} : { pollTimeoutSeconds: Number.parseInt(pollFlag, 10) }),
    log: (message: string) => streams.err(`${message}\n`),
  };

  return {
    kind: "run",
    setup: {
      channel: new TelegramChannel(config),
      logPath,
      actor,
      json,
      once: boolFlag(flags, "--once"),
      gateOptions: { policy },
      tagOptions: {
        policy,
        ...(payloads.source === undefined ? {} : { payload: payloads.source }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch (APRV-55) — one cycle's worth of "put pending requests on the phone"
// ---------------------------------------------------------------------------

/**
 * Consecutive failures for one action key after which stderr warnings thin out.
 *
 * Not an attempt limit: the send is retried on every cycle forever (see the
 * module doc). Only the complaining is throttled, to every tenth attempt.
 */
export const DISPATCH_LOUD_ATTEMPTS = 3;

/**
 * What one listener process remembers between cycles. **In memory only.**
 *
 * SPEC.md §10.3: channels hold no state that is a source of truth. Nothing here
 * is truth — the pending set is re-derived from the verified log every cycle,
 * and this only prevents a second copy of a message this process already sent.
 * Its loss (restart, crash) degrades to a re-send, never to a request that is
 * pending in the log and absent from the approver's phone.
 */
export interface DispatchState {
  /** action key -> the delivery id this process sent it under. Never pruned. */
  readonly delivered: Map<string, DeliveryId>;
  /** action key -> consecutive failed send attempts. Cleared on success. */
  readonly attempts: Map<string, number>;
  /** `<action key>:<code>` skips already reported, so cycles do not repeat them. */
  readonly warned: Set<string>;
  /**
   * Keys this process has already annotated on the approver's phone (APRV-106
   * for withdrawal, APRV-113 for every other terminal state). In memory, like
   * `delivered`, and for the same reason: it stops a second edit of the same
   * message, and its loss costs a duplicate edit at worst.
   *
   * The memory that matters here is `delivered`, and losing it degrades to
   * un-annotated messages, NEVER to wrong annotations: a process that does not
   * remember sending a message cannot edit it, and one that does re-reads the
   * outcome from the verified log every cycle. A fresh listener also never
   * sends a settled request in the first place — `buildPendingQueue` re-derives
   * from the verified log and only `requested` is pending — so a restart leaves
   * stale text on old messages whose buttons the gate refuses anyway, and
   * nothing worse.
   */
  readonly annotated: Set<string>;
}

export function newDispatchState(): DispatchState {
  return {
    delivered: new Map(),
    attempts: new Map(),
    warned: new Set(),
    annotated: new Set(),
  };
}

/** What one {@link dispatchPending} call did. Total: it never throws. */
export interface DispatchResult {
  /** Requests put in front of the approver by this cycle. */
  delivered: { action_key: string; delivery_id: DeliveryId }[];
  /** Sends that failed and will be retried on the next cycle. */
  failed: { action_key: string; attempts: number; message: string }[];
  /**
   * The queue could not be derived at all: the log is unreadable or does not
   * verify. Nothing was sent. Fatal at startup, retried on later cycles.
   */
  queueError?: { code: ChannelTagRefusalCode; message: string };
  /**
   * Deliveries annotated with their terminal outcome and disarmed this cycle
   * (APRV-106 for `withdrawn`, APRV-113 for the rest).
   */
  annotated: { action_key: string; delivery_id: DeliveryId; outcome: TelegramTerminalState }[];
}

/** A delivery whose request the log now says is settled (APRV-106, APRV-113). */
interface TerminalDelivery {
  actionKey: string;
  deliveryId: DeliveryId;
  /** Which terminal state the verified log derived. Chooses the headline. */
  outcome: TelegramTerminalState;
  /** The lines the approver reads under the headline on the edited message. */
  detail: string[];
}

/** The event that records each terminal state, for finding the settling record. */
const TERMINAL_EVENT: Record<TelegramTerminalState, string> = {
  granted: "approval.granted",
  rejected: "approval.rejected",
  revoked: "approval.revoked",
  expired: "approval.expired",
  withdrawn: "approval.withdrawn",
};

/**
 * Which of this process's deliveries the log says are settled (APRV-113,
 * generalizing APRV-106's withdrawal-only pass).
 *
 * This is the cross-surface half of the feature. A request answered at the CLI
 * or on the web queue, revoked afterwards, or expired by the daemon, leaves a
 * chat prompt that this process delivered and that nothing else will ever
 * correct — so every cycle asks the verified log what became of each message it
 * sent, and annotates the ones that are over.
 *
 * Reads only VERIFIED records (SPEC.md §11.1(1)). A channel edit is not an
 * enforcement decision, but it is a statement to a human about what the log
 * says, and reading the log unverified to make one would be the same defect in
 * a smaller hat.
 *
 * Never throws: an unreadable or unverifiable log yields an empty list, and the
 * cycle's own `queueError` path already reports that failure. Annotating from a
 * log this process could not verify would be worse than leaving the message.
 */
function terminalDeliveries(
  setup: ListenSetup,
  state: DispatchState,
  now: string,
): TerminalDelivery[] {
  if (state.delivered.size === 0) return [];
  const read = readVerifiedRecords(setup.logPath);
  if (!read.ok) return [];

  const settled: TerminalDelivery[] = [];
  for (const [actionKey, deliveryId] of state.delivered) {
    // `ttlMs: null` is correct here rather than lazy, and it is the reason this
    // pass annotates the daemon's `approval.expired` but not a TTL that has
    // merely lapsed by arithmetic: an annotation states what the LOG says, and
    // a lazily-expired request has no record saying anything yet. Loading the
    // policy to compute a deadline would also make a cosmetic edit depend on a
    // file read that can fail. The armed message left behind is refused at the
    // gate, and gets its annotation on the cycle after the daemon writes.
    const derivation = requestState(read.records, actionKey, now, null);
    if (!isTelegramTerminalState(derivation.state)) continue;
    const outcome = derivation.state;
    const record = read.records.find(
      (entry) =>
        entry.seq === derivation.decisionSeq && entry.event === TERMINAL_EVENT[outcome],
    );
    const payload = record === undefined ? {} : payloadOf(record);
    const at = record === undefined ? now : record.ts;
    const seq = record?.seq ?? derivation.decisionSeq;

    if (outcome === "withdrawn") {
      const why = typeof payload["reason"] === "string" ? payload["reason"] : "withdrawn";
      const note = typeof payload["note"] === "string" ? `\n${payload["note"]}` : "";
      settled.push({
        actionKey,
        deliveryId,
        outcome,
        // APRV-106's exact line, unchanged: it is what the approver reads.
        detail: [`withdrawn by the requester at ${utcClock(at)} (${why}) · nothing to do${note}`],
      });
      continue;
    }

    if (outcome === "expired") {
      settled.push({
        actionKey,
        deliveryId,
        outcome,
        detail: [
          `no answer arrived before the deadline · recorded at ${utcClock(at)}${
            seq === null ? "" : ` (seq ${seq})`
          }`,
        ],
      });
      continue;
    }

    // granted / rejected / revoked: a human answered, somewhere. The actor is
    // the log's, never this listener's configured identity — the answer may
    // have come from another surface entirely.
    settled.push({
      actionKey,
      deliveryId,
      outcome,
      detail:
        record === undefined
          ? [`recorded at ${utcClock(at)}`]
          : [decidedLine(record.actor, record.ts, record.seq)],
    });
  }
  return settled;
}

/**
 * One dispatch cycle: re-derive the pending queue from the verified log, send
 * whatever this process has not already sent.
 *
 * `now` is a parameter, not a clock read: TTL judgment inside
 * {@link buildPendingQueue} is deterministic and the tests drive it at chosen
 * instants. Requests that are decided, expired, or not yet requested are absent
 * from the derivation and so are never sent.
 */
export async function dispatchPending(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  now: string,
): Promise<DispatchResult> {
  const result: DispatchResult = { delivered: [], failed: [], annotated: [] };

  const queue = buildPendingQueue(setup.logPath, setup.tagOptions, now);
  if (!queue.ok) {
    result.queueError = { code: queue.code, message: queue.message };
    return result;
  }

  // APRV-106 (withdrawal) generalized by APRV-113 (every terminal state),
  // before the sends. A request this process delivered and that the log now
  // says is settled — granted or rejected at any surface, revoked, expired by
  // the daemon, or withdrawn by its requester — gets its message annotated with
  // that outcome and its buttons taken away, so the approver's phone stops
  // showing a decided question as a live one. What became of it is derived from
  // the VERIFIED log by `terminalDeliveries`, never remembered here; this state
  // only prevents a second edit of the same message.
  for (const settled of terminalDeliveries(setup, state, now)) {
    if (state.annotated.has(settled.actionKey)) continue;
    state.annotated.add(settled.actionKey);
    try {
      await setup.channel.annotate(
        settled.deliveryId,
        TELEGRAM_TERMINAL_HEADLINES[settled.outcome],
        settled.detail,
      );
      result.annotated.push({
        action_key: settled.actionKey,
        delivery_id: settled.deliveryId,
        outcome: settled.outcome,
      });
      if (setup.json) {
        streams.out(
          `${JSON.stringify({
            event: "annotated",
            action_key: settled.actionKey,
            delivery_id: settled.deliveryId,
            outcome: settled.outcome,
          })}\n`,
        );
      } else {
        streams.out(
          `annotated ${settled.actionKey} (message ${settled.deliveryId}): ${settled.outcome}\n`,
        );
      }
    } catch (cause) {
      // Cosmetic, and said so on stderr. The gate refuses a tap on the stale
      // buttons anyway (`already-decided`, `request-withdrawn`, `expired`), so
      // nothing can be decided by one.
      streams.err(
        `approval: telegram could not annotate the ${settled.outcome} ${settled.actionKey} (message ${settled.deliveryId}): ${
          cause instanceof Error ? cause.message : String(cause)
        } — the buttons are stale but the gate refuses a tap on them\n`,
      );
    }
  }

  for (const skipped of queue.skipped) {
    const token = `${skipped.action_key}:${skipped.code}`;
    if (state.warned.has(token)) continue;
    state.warned.add(token);
    streams.err(
      `approval: telegram cannot deliver ${skipped.action_key} (${skipped.code}): ${skipped.message}\n`,
    );
  }

  for (const request of queue.requests) {
    const actionKey = request.action_key.value;
    if (state.delivered.has(actionKey)) continue;
    try {
      const deliveryId = await setup.channel.notify(request);
      state.delivered.set(actionKey, deliveryId);
      state.attempts.delete(actionKey);
      result.delivered.push({ action_key: actionKey, delivery_id: deliveryId });
      if (setup.json) {
        streams.out(
          `${JSON.stringify({
            event: "notified",
            action_key: actionKey,
            delivery_id: deliveryId,
          })}\n`,
        );
      } else {
        streams.out(`notified ${actionKey} (message ${deliveryId})\n`);
      }
    } catch (cause) {
      // The key stays out of `delivered`, so the next cycle tries again.
      const attempts = (state.attempts.get(actionKey) ?? 0) + 1;
      state.attempts.set(actionKey, attempts);
      const message = cause instanceof Error ? cause.message : String(cause);
      result.failed.push({ action_key: actionKey, attempts, message });
    }
  }

  return result;
}

/**
 * Report a steady-state cycle's problems on stderr. Startup reports its own,
 * as exit codes, in {@link runListener}.
 */
function reportCycle(result: DispatchResult, streams: Streams): void {
  if (result.queueError !== undefined) {
    streams.err(
      `approval: telegram cannot read the pending queue (${result.queueError.code}): ${result.queueError.message} — retrying next cycle\n`,
    );
  }
  for (const failure of result.failed) {
    // Loud for the first few, then every tenth: an outage must stay visible
    // without turning the operator's terminal into a log of one message.
    if (failure.attempts > DISPATCH_LOUD_ATTEMPTS && failure.attempts % 10 !== 0) continue;
    streams.err(
      `approval: telegram sendMessage failed for ${failure.action_key} (attempt ${failure.attempts}): ${failure.message} — still pending, retrying next cycle\n`,
    );
  }
}

/** The decision handler: the only thing this process does with a button press. */
function handlerFor(setup: ListenSetup, streams: Streams): (d: ChannelDecision) => DecisionOutcome {
  return (decision) => {
    const result = recordChannelDecision(
      setup.logPath,
      decision,
      { actor: setup.actor, channel: "telegram" },
      setup.gateOptions,
    );

    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "decision",
          action_key: decision.action_key,
          decision: decision.decision,
          ok: result.outcome.ok,
          ...(result.outcome.ok
            ? { seq: result.outcome.record.seq, state: result.outcome.state }
            : { code: result.outcome.code }),
          // The token is NEVER in the JSON stream either: --json output is the
          // thing most likely to be piped into a file or a log aggregator.
          token_issued: result.token !== undefined,
        })}\n`,
      );
    } else if (result.outcome.ok) {
      streams.out(
        `${decision.decision === "grant" ? "granted" : "rejected"} ${decision.action_key} (seq ${result.outcome.record.seq}) by ${setup.actor} via telegram\n`,
      );
    } else {
      streams.err(
        `approval: telegram decision refused (${result.outcome.code}): ${result.outcome.message}\n`,
      );
    }

    // APRV-17: the raw token is printed exactly once, here, on this terminal's
    // stdout. It is not sent to Telegram (a chat transcript is not a secrets
    // channel), not written to the log (which holds only its sha256), and not
    // handed back to the channel. Once this line scrolls away it is gone.
    if (result.token !== undefined) {
      // APRV-102: the shared rule-boxed panel, with the Telegram clause of the
      // notice — the one surface where "not sent to Telegram" is a fact the
      // reader might otherwise doubt, having just decided in a chat window.
      streams.out(
        `${tokenPanel(style(), decision.action_key, result.token, TOKEN_NOTICE_TELEGRAM)}\n`,
      );
    }

    return result.outcome;
  };
}

async function runListener(setup: ListenSetup, streams: Streams): Promise<number> {
  const { channel } = setup;
  channel.onDecision(handlerFor(setup, streams));

  // Delivery bookkeeping is in memory only — channels hold no state (SPEC.md
  // §10.3). A restarted listener therefore re-sends everything still pending,
  // and the buttons on the messages it sent before the restart stop resolving.
  // Duplicated messages are the acceptable failure; a decision that depends on
  // a channel's memory surviving a crash is not.
  const state = newDispatchState();

  // The startup cycle. Same call as every later one; only its *failures* are
  // treated differently, because an operator who has just mistyped a token or
  // pointed at an unreadable log should get an exit code, not a retry loop.
  const startup = await dispatchPending(setup, streams, state, new Date().toISOString());
  if (startup.queueError !== undefined) {
    return startup.queueError.code === "log-unreadable"
      ? ioError(streams, setup.json, startup.queueError.message)
      : integrityError(streams, setup.json, startup.queueError.message);
  }
  const firstFailure = startup.failed[0];
  if (firstFailure !== undefined) {
    return ioError(streams, setup.json, `telegram sendMessage failed: ${firstFailure.message}`);
  }

  // Every subsequent cycle: re-derive, send what is new, complain and carry on.
  // Runs before each `getUpdates`, including the poll after a recovered poll
  // error, so a request appended mid-run is delivered without a restart.
  const beforePoll = async (): Promise<void> => {
    reportCycle(await dispatchPending(setup, streams, state, new Date().toISOString()), streams);
  };

  const stop = (): void => channel.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await channel.listen(setup.once ? { once: true, beforePoll } : { beforePoll });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  if (setup.json) {
    streams.out(`${JSON.stringify({ event: "stopped", ...channel.stats() })}\n`);
  }
  return EXIT_OK;
}

/**
 * The listener verb. Returns a promise, which is why `main` treats `channel`
 * specially: it is the only long-lived command in the CLI.
 */
export function commandTelegramListen(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const prepared = setUp(argv, streams, cwd);
  if (prepared.kind === "handled") return prepared.code;
  return runListener(prepared.setup, streams);
}

// ---------------------------------------------------------------------------
// approval channel telegram health
// ---------------------------------------------------------------------------

/**
 * Configuration health, offline.
 *
 * It answers one question — "is this runtime configured to talk to Telegram?"
 * — and deliberately makes no network call: a health check that contacted the
 * Bot API would leak the existence of the bot from any shell, and would fail
 * for reasons (a captive portal, a rate limit) that say nothing about whether
 * the operator's configuration is right. The *live* counters (deliveries,
 * decisions, ignored callbacks, recovered poll errors) belong to a running
 * listener and are surfaced by `TelegramChannel.health()` / `stats()` in
 * process, and on the listener's stderr as they happen.
 */
export function commandTelegramHealth(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, {
    "--policy": "string",
    "--dir": "string",
    "--json": "boolean",
    "--help": "boolean",
    "-h": "boolean",
  });
  if (!parsed.ok) return usageError(streams, json, parsed.message, TELEGRAM_HEALTH_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${TELEGRAM_HEALTH_HELP}\n`);
    return EXIT_OK;
  }

  // Which variables to look at is a policy question (§5.1), so this offline
  // check reads the policy for the NAMES — and only the names. It still makes
  // no network call, and an unloadable policy leaves the defaults in force
  // rather than reporting a channel that cannot be configured at all.
  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const policyLoad = loadPolicy(
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
  );
  const tokenEnv = telegramTokenEnvFor(policyLoad);
  const chatEnv = telegramChatEnvFor(policyLoad);

  const token = env(tokenEnv);
  const chatId = env(chatEnv);
  const ok = token !== null && chatId !== null;

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok,
        channel: "telegram",
        // Presence only. The token's value never appears in any output.
        token_env: tokenEnv,
        token_set: token !== null,
        chat_env: chatEnv,
        chat_id: chatId,
      })}\n`,
    );
  } else if (ok) {
    streams.out(`telegram: configured (${tokenEnv} set, chat ${String(chatId)})\n`);
  } else {
    streams.err(
      `approval: telegram is not configured: ${[
        token === null ? tokenEnv : null,
        chatId === null ? chatEnv : null,
      ]
        .filter((name) => name !== null)
        .join(" and ")} unset or empty\n`,
    );
  }
  return ok ? EXIT_OK : EXIT_INTEGRITY;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function commandTelegram(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval channel telegram`", TELEGRAM_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${TELEGRAM_HELP}\n`);
    return EXIT_OK;
  }
  switch (sub) {
    case "listen":
      return commandTelegramListen(rest, streams, cwd);
    case "health":
      return commandTelegramHealth(rest, streams, cwd);
    default:
      return usageError(
        streams,
        json,
        `unknown subcommand ${JSON.stringify(sub)} for \`approval channel telegram\``,
        TELEGRAM_HELP,
      );
  }
}

