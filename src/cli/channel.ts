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
 * ## Payload material — why `--payloads` exists
 *
 * SPEC.md §6.2 records a `payload_hash` in the log and never the bytes, and
 * §10.4 requires a channel to present the full payload for a manual action. So
 * the bytes must come from somewhere the runtime can reach: `--payloads` names
 * a JSON file mapping action key to that action's payload value. The tagger
 * (`channels/tagging.ts`) re-hashes whatever it is given and refuses anything
 * that does not match the recorded binding, so a wrong or stale file cannot put
 * different bytes in front of an approver than the token will execute — it
 * produces a visible skip instead. Requests whose material is missing are
 * reported on stderr and NOT delivered: a manual request rendered without its
 * payload would be exactly the §10.4 violation the contract refuses.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import type { DecideOptions } from "../core/gate.js";
import {
  recordChannelDecision,
  type ChannelDecision,
  type DecisionOutcome,
} from "../channels/contract.js";
import { buildPendingQueue, type TagOptions } from "../channels/tagging.js";
import {
  TelegramChannel,
  TELEGRAM_CHAT_ENV,
  TELEGRAM_TOKEN_ENV,
  type TelegramConfig,
} from "../channels/telegram.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  CHANNEL_HELP,
  TELEGRAM_HEALTH_HELP,
  TELEGRAM_HELP,
  TELEGRAM_LISTEN_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";

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
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
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

interface ListenSetup {
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

  // Configuration is environment-only: policy names the variables, never the
  // values (SPEC.md §5.1), and there is no flag that would put a bot token in
  // a shell history or a process listing.
  const token = env(TELEGRAM_TOKEN_ENV);
  const chatId = env(TELEGRAM_CHAT_ENV);
  if (token === null || chatId === null) {
    const missing = [
      token === null ? TELEGRAM_TOKEN_ENV : null,
      chatId === null ? TELEGRAM_CHAT_ENV : null,
    ].filter((name): name is string => name !== null);
    return {
      kind: "handled",
      code: usageError(
        streams,
        json,
        `telegram is not configured: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset or empty (both ${TELEGRAM_TOKEN_ENV} and ${TELEGRAM_CHAT_ENV} are required; APPROVAL.md carries only their names)`,
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
          ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>. Every decision this listener records is recorded against it (SPEC.md §11: identity is config-declared)`
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

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

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
      streams.out(`execution token for ${decision.action_key}: ${result.token}\n`);
      streams.out(
        "approval: that token is single-use, stored nowhere, and was NOT sent to Telegram — copy it now\n",
      );
    }

    return result.outcome;
  };
}

async function runListener(setup: ListenSetup, streams: Streams): Promise<number> {
  const { channel } = setup;
  channel.onDecision(handlerFor(setup, streams));

  const queue = buildPendingQueue(setup.logPath, setup.tagOptions, new Date().toISOString());
  if (!queue.ok) {
    return queue.code === "log-unreadable"
      ? ioError(streams, setup.json, queue.message)
      : integrityError(streams, setup.json, queue.message);
  }

  for (const skipped of queue.skipped) {
    streams.err(
      `approval: telegram cannot deliver ${skipped.action_key} (${skipped.code}): ${skipped.message}\n`,
    );
  }

  // Delivery bookkeeping is in memory only — channels hold no state (SPEC.md
  // §10.3). A restarted listener therefore re-sends everything still pending,
  // and the buttons on the messages it sent before the restart stop resolving.
  // Duplicated messages are the acceptable failure; a decision that depends on
  // a channel's memory surviving a crash is not.
  for (const request of queue.requests) {
    try {
      const deliveryId = await channel.notify(request);
      if (setup.json) {
        streams.out(
          `${JSON.stringify({
            event: "notified",
            action_key: request.action_key.value,
            delivery_id: deliveryId,
          })}\n`,
        );
      } else {
        streams.out(`notified ${request.action_key.value} (message ${deliveryId})\n`);
      }
    } catch (cause) {
      return ioError(
        streams,
        setup.json,
        `telegram sendMessage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  const stop = (): void => channel.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await channel.listen(setup.once ? { once: true } : {});
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
export function commandTelegramHealth(argv: string[], streams: Streams): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, { "--json": "boolean", "--help": "boolean", "-h": "boolean" });
  if (!parsed.ok) return usageError(streams, json, parsed.message, TELEGRAM_HEALTH_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${TELEGRAM_HEALTH_HELP}\n`);
    return EXIT_OK;
  }

  const token = env(TELEGRAM_TOKEN_ENV);
  const chatId = env(TELEGRAM_CHAT_ENV);
  const ok = token !== null && chatId !== null;

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok,
        channel: "telegram",
        // Presence only. The token's value never appears in any output.
        token_env: TELEGRAM_TOKEN_ENV,
        token_set: token !== null,
        chat_env: TELEGRAM_CHAT_ENV,
        chat_id: chatId,
      })}\n`,
    );
  } else if (ok) {
    streams.out(`telegram: configured (${TELEGRAM_TOKEN_ENV} set, chat ${String(chatId)})\n`);
  } else {
    streams.err(
      `approval: telegram is not configured: ${[
        token === null ? TELEGRAM_TOKEN_ENV : null,
        chatId === null ? TELEGRAM_CHAT_ENV : null,
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

function commandTelegram(
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
      return commandTelegramHealth(rest, streams);
    default:
      return usageError(
        streams,
        json,
        `unknown subcommand ${JSON.stringify(sub)} for \`approval channel telegram\``,
        TELEGRAM_HELP,
      );
  }
}

export function commandChannel(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval channel`", CHANNEL_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${CHANNEL_HELP}\n`);
    return EXIT_OK;
  }
  switch (sub) {
    case "telegram":
      return commandTelegram(rest, streams, cwd);
    default:
      return usageError(
        streams,
        json,
        `unknown channel ${JSON.stringify(sub)}; v0.1 ships telegram here`,
        CHANNEL_HELP,
      );
  }
}
