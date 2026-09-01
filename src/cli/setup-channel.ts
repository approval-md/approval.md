/**
 * `approval setup channel <name>` — configure one channel (APRV-79).
 *
 * SPEC.md §4 draws a line this verb's NAME now carries: a **channel** surfaces
 * requests and collects decisions and holds no state; an **adapter** executes
 * side effects and holds credentials. `approval setup adapter <name>` (APRV-78)
 * fills the VAULT from an adapter's manifest. This verb fills the OS keystore
 * and `.approval/env` from a channel's, because what a channel needs is not a
 * credential an action spends inside a token window: it is the transport
 * credential that lets the runtime ask a human anything at all.
 *
 * An older build spelled the Telegram one without the `channel` noun. That form
 * is gone rather than aliased — the dispatch in `cli/setup.ts` answers it at
 * exit 2 with the new one, in {@link RENAMED_NOTICE} — because two spellings of
 * a distinction the SPEC draws on purpose is exactly how the distinction stops
 * being drawn.
 *
 * ## What Telegram's flow keeps, unchanged
 *
 * The conversation is now `cli/setup-flow.ts`'s, the same one `setup adapter`
 * runs, over the manifest `core/telegram-config.ts` declares. Everything that
 * was a decision rather than a phrasing survives it, and each of these is
 * asserted in `tests/cli-setup.test.ts`:
 *
 * - **`getMe` happens before anything is written.** It runs at the END of the
 *   token's collection (step five of the flow), not after the write (step
 *   seven), so a token the Bot API refuses costs the operator one line of
 *   output and leaves `.approval/env` untouched. The chat discovery below it
 *   also needs the bot's username, and asking `getMe` for it is the same call.
 * - **No `getUpdates` from this verb carries an offset, ever.** An offset is an
 *   ACKNOWLEDGEMENT: it tells the Bot API that everything below it may be
 *   discarded, and a decision tap consumed here would never reach the listener
 *   that was waiting for it. `allowed_updates` is `["message"]`, so a pending
 *   `callback_query` is not even delivered to this process.
 * - **The token is never typed into this process** on a machine with a
 *   keystore: the helper's own no-echo prompt collects it and this runtime
 *   learns it by reading the item back on stdout.
 * - **The chat id is a literal.** A chat id is not a secret; the token is.
 * - "send the bot a message", the 409 hint, the manual-curl refusal when nothing
 *   arrives, and the optional send-a-test-message proof that defaults to NO.
 *   What changed in APRV-96 is only WHEN the read happens: the verb long-polls
 *   continuously until a message arrives or {@link DISCOVERY_DEADLINE_MS}
 *   passes, instead of asking the operator to press Enter between reads.
 *
 * ## Where the two hooks sit, and why
 *
 * The flow asks its questions in one fixed order, and Telegram's shape falls
 * out of it: the token is `collect`, because a human supplies it; the chat id is
 * `discover`, because the SERVICE supplies it and the human's only part is
 * sending a message and picking from what arrived. That is the hook APRV-78
 * reserved and did not call. The proof is `verify`, which runs after the write —
 * later than the old hand-rolled flow ran it, and correct in the same way the
 * adapter's SMTP probe is: what is being proved is the stored configuration.
 */

import type { CredentialSpec } from "../core/credential-spec.js";
import { LEGACY_SERVICE_TELEGRAM_TOKEN, instanceHomeFor, instanceIdFor } from "../core/instance.js";
import type { PolicyLoadResult } from "../core/policy-load.js";
import {
  telegramChatEnvFor,
  telegramCredentialSpecs,
  telegramTokenEnvFor,
} from "../core/telegram-config.js";
import type { TelegramFetch } from "../channels/telegram.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK } from "./exit-codes.js";
import { SETUP_CHANNEL_HELP, SETUP_CHANNEL_TELEGRAM_HELP } from "./help.js";
import type { Streams } from "./main.js";
import {
  PROBE_TIMEOUT_MS,
  detail,
  front,
  offerLiteral,
  requireHuman,
  retrievalCommand,
  schemeFor,
  storageCommand,
  usageError,
  type Context,
  type HintContext,
  type SetupDeps,
} from "./setup-common.js";
import {
  envFileDestination,
  pickOne,
  runCredentialFlow,
  type FlowHooks,
  type FlowResult,
  type HookOutcome,
  type VerifyOutcome,
} from "./setup-flow.js";

/**
 * How long the verb waits for a message before it gives up (APRV-96).
 *
 * It replaces the three "send one and press Enter" attempts, which made the
 * operator's TIMING part of whether the verb worked: a message sent while the
 * 10s long poll was not running was simply not seen, and the verb had no way to
 * say so. Ninety seconds is long enough to unlock a phone and find the chat,
 * and short enough that a run left in a forgotten terminal ends by itself.
 */
const DISCOVERY_DEADLINE_MS = 90_000;

/** A deadline in whole seconds, for the two lines that state it. Never "0s". */
function statedSeconds(ms: number): string {
  return `${String(Math.max(1, Math.round(ms / 1000)))}s`;
}

/**
 * The Telegram-only dependency, kept local to this file ON PURPOSE.
 *
 * `SetupDeps` is `setup-common.ts`'s, shared by every subcommand, and a
 * discovery deadline is not something `setup vault` or `setup adapter email`
 * has any meaning for. Tests inject a short one so the deadline path costs the
 * suite milliseconds rather than a minute and a half; no operator has a reason
 * to change it, so it is not a flag either.
 */
export interface ChannelSetupDeps extends SetupDeps {
  /** The chat-discovery deadline in ms. {@link DISCOVERY_DEADLINE_MS} default. */
  discoveryDeadlineMs?: number;
}

/**
 * The refusal for the OLD spelling, as one constant on one line.
 *
 * One line and one identifier, because `tests/setup-rename.test.ts` sweeps
 * `src/`, `docs/`, `examples/`, `README.md` and `SPEC.md` for the bare phrase
 * and exempts exactly the lines that also name `RENAMED_NOTICE`. That is the
 * whole exemption mechanism: a future line that reintroduces the old spelling
 * cannot claim the exemption without saying this constant's name out loud.
 */
export const RENAMED_NOTICE = `\`approval setup telegram\` is now \`approval setup channel telegram\`, and there is no alias. A channel surfaces requests and collects decisions and holds no state; an adapter executes side effects and holds credentials. The two setup verbs fill different stores, so a channel's name belongs under \`channel\` (the OS keystore and .approval/env) and an adapter's under \`adapter\` (the vault)`;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** One channel, as this verb needs to see it. Symmetric with ADAPTER_SETUPS. */
export interface ChannelSetupEntry {
  /** The manifest, declared by the channel itself, resolved against the policy. */
  specs(load: PolicyLoadResult): readonly CredentialSpec[];
  /** One line of what this channel is, for the title. */
  summary: string;
  /** The prerequisite paragraph, printed under the title. */
  prereq: string;
  /** The non-interactive path: the exact commands, generated. */
  hint(context: HintContext): string;
  /** The channel-specific conversation, as the flow's hooks. */
  hooks(context: Context, deps: SetupDeps, streams: Streams, helpText: string): FlowHooks;
  /** What to tell the operator to do next. */
  nextSteps: readonly string[];
  /** The per-channel help, for `--help` and for every refusal. */
  help: string;
}

// ---------------------------------------------------------------------------
// Telegram: the Bot API calls
// ---------------------------------------------------------------------------

/** Replace the token wherever it appears. Nothing leaves this file with it. */
function redact(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("<token redacted>");
}

interface BotCall {
  ok: boolean;
  status: number;
  envelope: Record<string, unknown>;
}

/** One Bot API call, with doctor's probe shape: the token is in the URL only. */
async function call(
  fetchImpl: TelegramFetch,
  apiBase: string,
  token: string,
  method: string,
  body: unknown,
  timeoutMs: number,
): Promise<BotCall | { failed: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let envelope: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) envelope = parsed as Record<string, unknown>;
    } catch {
      /* a non-JSON body is not an ok envelope; handled by the caller */
    }
    return { ok: response.ok, status: response.status, envelope };
  } catch (cause) {
    return { failed: redact(detail(cause), token) };
  } finally {
    clearTimeout(timer);
  }
}

/** One chat the bot has heard from. */
interface Candidate {
  id: string;
  type: string;
  name: string;
}

/**
 * The chats in a `getUpdates` result, newest first and deduplicated by id.
 *
 * `title ?? username ?? first_name` is Telegram's own precedence for what to
 * call a chat: groups and channels carry a title, a private chat carries the
 * user's username or, for a user who has set none, their first name.
 */
function candidatesFrom(updates: unknown): Candidate[] {
  const found = new Map<string, Candidate>();
  const list = Array.isArray(updates) ? [...updates].reverse() : [];
  for (const update of list) {
    if (typeof update !== "object" || update === null) continue;
    const message = (update as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) continue;
    const chat = (message as Record<string, unknown>)["chat"];
    if (typeof chat !== "object" || chat === null) continue;
    const record = chat as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "number" && typeof id !== "string") continue;
    const key = String(id);
    if (found.has(key)) continue;
    const name =
      typeof record["title"] === "string"
        ? record["title"]
        : typeof record["username"] === "string"
          ? `@${record["username"]}`
          : typeof record["first_name"] === "string"
            ? record["first_name"]
            : "unnamed";
    found.set(key, {
      id: key,
      type: typeof record["type"] === "string" ? record["type"] : "unknown",
      name,
    });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Telegram: the hooks
// ---------------------------------------------------------------------------

const TELEGRAM_HINT = (where: HintContext): string =>
  `  # 1. store the bot token (the helper prompts for it with NO ECHO; the token is\n  #    never an argument, so it never reaches your shell history or \`ps\`):\n  ${storageCommand(where.kind === "none" ? "keychain" : where.kind, where.services.telegramToken)}\n\n  # 2. find the chat id — send your bot a message first, then:\n  curl -s "https://api.telegram.org/bot<token>/getUpdates" \\\n    | grep -o '"chat":{"id":[-0-9]*' | head -1\n\n  # 3. record both (a chat id is not a secret; the item name carries THIS\n  #    instance's id, so a second gate on this machine gets its own token):\n  printf '%s\\n' '${where.tokenEnv}=${schemeFor(where.kind === "none" ? "keychain" : where.kind, where.services.telegramToken) ?? ""}' '${where.chatEnv}=<id>' >> ${where.envPath}\n  chmod 600 ${where.envPath}`;

/**
 * The Telegram conversation, as three hooks over one run.
 *
 * The mutable state is the token and the bot's username, both learned in
 * `collect` and both needed by `discover` and `verify`. It is a closure and not
 * a field on the entry, so two runs in one process (which is what the test
 * suite is) cannot see each other's token.
 */
function telegramHooks(
  context: Context,
  deps: SetupDeps,
  streams: Streams,
  helpText: string,
): FlowHooks {
  const tokenEnv = telegramTokenEnvFor(context.load);
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as TelegramFetch);
  const apiBase = context.apiBase.replace(/\/+$/u, "");

  /** The operator's token. Held for the length of one run and printed nowhere. */
  let token: string | null = null;
  /** `@botname`, from getMe. Also the proof that the token works. */
  let username: string | null = null;
  /** The chat the operator picked, for the proof's report line. */
  let chosen: Candidate | null = null;
  /** The keystore item this run reads and writes. Decided once, by {@link chooseService}. */
  let service: string | null = null;

  /**
   * Which keystore item this instance's token lives in (APRV-178).
   *
   * The name it WANTS is the scoped one, `approval-tg-token-<instance id>`, and
   * on a machine with one gate and a clean keystore that is the end of it. Two
   * other situations exist, and the difference between them is the whole task:
   *
   * - **The scoped item is already there.** This instance provisioned itself
   *   before. Nothing to ask: the item is this instance's by construction, and
   *   storing over it replaces this gate's own token, which is what a re-run is
   *   for.
   * - **The scoped item is absent and the UNSCOPED legacy item exists.** That
   *   item is the pre-APRV-178 name every gate on this machine resolves to the
   *   same value, so it may be this instance's token from before the rename, or
   *   it may be another instance's production bot — which is the incident. This
   *   runtime cannot tell those apart, and guessing is what consumed a human's
   *   approval tap in the wrong listener, so it ASKS, naming the item and this
   *   instance's directory, and adopts the legacy name only on a typed `yes`.
   *
   * The reads here can, on a locked keychain, put the OS's own unlock prompt in
   * front of the operator. That is acceptable HERE and nowhere else: this is an
   * interactive verb with a human at the machine who is about to be asked for a
   * password by `security` anyway. `approval doctor` answers the same question
   * from names alone, precisely so that a diagnostic never blocks on a dialog.
   */
  function chooseService(): string {
    if (service !== null) return service;
    const mine = context.services.telegramToken;
    if (context.backend === "none") {
      service = mine;
      return service;
    }
    // The legacy item is probed FIRST and the scoped one only if it is there,
    // so the ordinary machine — the one with no legacy item at all — costs one
    // extra keystore lookup rather than two, and asks nothing.
    if (!context.keystore.read(LEGACY_SERVICE_TELEGRAM_TOKEN).ok) {
      service = mine;
      return service;
    }
    if (context.keystore.read(mine).ok) {
      service = mine;
      return service;
    }

    streams.out(
      `\nA bot token is already stored under ${LEGACY_SERVICE_TELEGRAM_TOKEN}, which is the name this\n` +
        `runtime used before item names were scoped to an instance. EVERY gate on this machine\n` +
        `resolves that one name to that one item, so it belongs to whichever instance stored it\n` +
        `last — and nothing here can tell whether that was this one.\n\n` +
        `This instance is ${instanceHomeFor(context.logPath)} (id ${instanceIdFor(context.logPath)}).\n` +
        `Its own item name is ${mine}.\n\n` +
        `Answer NO unless you are certain that stored token is this instance's bot. Sharing one\n` +
        `token between two gates makes both of them long-poll the same bot, and a human's\n` +
        `approval tap is then delivered to whichever listener asked for updates first.\n\n`,
    );
    const answer = context.prompter.readLine(
      `does ${LEGACY_SERVICE_TELEGRAM_TOKEN} belong to THIS instance? type \`yes\` in full to reuse it: `,
    );
    if ((answer ?? "").trim() === "yes") {
      service = LEGACY_SERVICE_TELEGRAM_TOKEN;
      streams.out(
        `reusing ${LEGACY_SERVICE_TELEGRAM_TOKEN} for this instance; nothing else on this machine may name it\n`,
      );
      return service;
    }
    service = mine;
    streams.out(
      `not reused: this instance will store its own token as ${mine}, and ${LEGACY_SERVICE_TELEGRAM_TOKEN} is left untouched\n`,
    );
    return service;
  }

  /**
   * getMe — doctor's probe, verbatim in shape: it mutates nothing, sends
   * nothing, and acknowledges nothing. Runs once per run, and always BEFORE the
   * flow reaches its write step.
   */
  async function probeIdentity(): Promise<{ ok: true } | { ok: false; code: number }> {
    if (username !== null) return { ok: true };
    const held = token ?? "";
    const identity = await call(fetchImpl, apiBase, held, "getMe", {}, PROBE_TIMEOUT_MS);
    if ("failed" in identity) {
      streams.err(`approval: getMe on ${apiBase} failed: ${identity.failed}\n`);
      streams.err(`  check network reachability of ${apiBase}\n`);
      return { ok: false, code: EXIT_IO };
    }
    if (!identity.ok || identity.envelope["ok"] !== true) {
      const description = redact(String(identity.envelope["description"] ?? "no description"), held);
      streams.err(
        `approval: getMe on ${apiBase} was refused: HTTP ${String(identity.status)} (${description})\n`,
      );
      streams.err(
        identity.status === 401 || /unauthorized/iu.test(description)
          ? `  the bot token is not valid: re-copy it from @BotFather into ${tokenEnv}\n`
          : `  check the token and that ${apiBase} is the right Bot API base\n`,
      );
      streams.err(`  nothing was written to ${context.envPath}\n`);
      return { ok: false, code: EXIT_INTEGRITY };
    }
    const result = (identity.envelope["result"] ?? {}) as Record<string, unknown>;
    username = typeof result["username"] === "string" ? `@${result["username"]}` : "the bot";
    streams.out(`\ntoken valid: ${username} via ${apiBase}\n`);
    return { ok: true };
  }

  /**
   * The token, and then the identity probe.
   *
   * On a machine with a keystore the HELPER's prompt collects it and this
   * process learns it only by reading the item back on stdout; the value that
   * lands in `.approval/env` is the SOURCE and never the token. With no
   * keystore it is read with no echo and — after a typed `yes` — written as a
   * plaintext literal, which is the one path on which the file holds the token.
   */
  async function collectToken(): Promise<HookOutcome> {
    if (context.backend === "none") {
      const read = context.prompter.readSecret(`bot token from @BotFather (not echoed): `);
      if (!read.ok) {
        return {
          kind: "refused",
          code: usageError(
            streams,
            false,
            "the token entry was aborted; nothing was stored and nothing was written",
            helpText,
          ),
        };
      }
      token = read.value.trim();
      if (token.length === 0) {
        return {
          kind: "refused",
          code: usageError(streams, false, "no token was entered; nothing was written", helpText),
        };
      }
      if (!offerLiteral(streams, context.prompter, context.envPath, "bot token")) {
        return { kind: "refused", code: EXIT_OK };
      }
      const probed = await probeIdentity();
      if (!probed.ok) return { kind: "refused", code: probed.code };
      return { kind: "value", value: token };
    }

    const helper = context.backend === "keychain" ? "macOS `security`" : "`secret-tool`";
    const helperPrompt =
      context.backend === "keychain"
        ? '"password data for new item:" and then "retype password for new item:"'
        : '"Password:"';
    const item = chooseService();
    streams.out(
      `Next: paste the BOT TOKEN from @BotFather (Telegram: /mybots, pick the bot, "API Token"; it looks like 123456789:AAH...).\n` +
        `${helper} asks for it with its own prompt, ${helperPrompt}. Nothing is echoed as\n` +
        `you paste, and the value goes straight into the keystore as ${item};\n` +
        `this process never sees you type it. There is nothing to look up first: this creates the item.\n` +
        `Already saved it under that name from an earlier run? Pasting the same value updates the item in\n` +
        `place; print it in another window with: ${retrievalCommand(context.backend, item)}\n\n`,
    );
    const stored = context.keystore.storePrompted(item);
    if (!stored.ok) {
      streams.err(
        `approval: the token could not be stored (${stored.message}); nothing was written to ${context.envPath}\n`,
      );
      return { kind: "refused", code: EXIT_IO };
    }
    const read = context.keystore.read(item);
    if (!read.ok) {
      streams.err(
        `approval: the token was stored but could not be read back (${read.message}); nothing was written to ${context.envPath}\n`,
      );
      return { kind: "refused", code: EXIT_IO };
    }
    token = read.value.trim();
    const scheme = schemeFor(context.backend, item) as string;
    streams.out(`stored the token as ${scheme}\n`);
    streams.out(`  read it back with: ${retrievalCommand(context.backend, item)}\n`);

    const probed = await probeIdentity();
    if (!probed.ok) return { kind: "refused", code: probed.code };
    return { kind: "value", value: scheme };
  }

  /**
   * The token this run needs, when the token LINE was left alone.
   *
   * A re-run that replaces only the chat id still has to talk to the Bot API,
   * and the token it should use is the one already stored — so it is read back
   * out of the keystore, with no prompt and no write. `.approval/env` is not
   * consulted for it on any path: reading a value out of that file is the
   * resolution §11.1 invariant 7 forbids, which is also why the no-keystore
   * machine (whose token IS the file's literal) cannot take this path.
   *
   * The scoped item is tried first and the unscoped legacy one second (APRV-178),
   * because an instance provisioned before the rename has its token only under
   * the old name and a re-run that replaced just the chat id must not start
   * demanding a token the operator already stored. The fallback is announced on
   * stderr every time it is taken: adopting a machine-global item silently is
   * the behaviour that put a demo gate on the production bot.
   */
  function recoverToken(): { ok: true } | { ok: false; code: number } {
    if (token !== null) return { ok: true };
    if (context.backend === "none") {
      streams.err(
        `approval: the ${tokenEnv} line was left alone, and this machine has no keystore to read the token back from — the only copy is the literal in ${context.envPath}, and no verb resolves that file on its own. Re-run and replace both lines. Nothing was written\n`,
      );
      return { ok: false, code: EXIT_IO };
    }
    const mine = context.services.telegramToken;
    let read = context.keystore.read(mine);
    if (!read.ok) {
      const legacy = context.keystore.read(LEGACY_SERVICE_TELEGRAM_TOKEN);
      if (legacy.ok) {
        streams.err(
          `approval: no ${mine} item for this instance, so the token was read from ${LEGACY_SERVICE_TELEGRAM_TOKEN} — the unscoped name every gate on this machine shares. Re-run \`approval setup channel telegram\` and replace the ${tokenEnv} line to give this instance its own item\n`,
        );
      }
      read = legacy;
    }
    if (!read.ok) {
      streams.err(
        `approval: the ${tokenEnv} line was left alone, so the stored token is what this run would ask the Bot API with, and it could not be read (${read.message}); nothing was written to ${context.envPath}\n`,
      );
      return { ok: false, code: EXIT_IO };
    }
    token = read.value.trim();
    return { ok: true };
  }

  /**
   * What Telegram itself says about this bot's update stream (APRV-96).
   *
   * Read ONLY on the give-up path, and read for one reason: when no message
   * arrives, the three explanations an operator cannot tell apart are "you
   * messaged a different bot", "a webhook is set, so getUpdates returns nothing
   * ever", and "another poller acknowledged it with an offset". `getWebhookInfo`
   * answers the last two directly and `getMe`'s username answers the first, so
   * the refusal prints all three rather than "no message seen yet".
   *
   * It mutates nothing and acknowledges nothing, exactly like `getMe`.
   */
  async function webhookReport(held: string): Promise<string[]> {
    const info = await call(fetchImpl, apiBase, held, "getWebhookInfo", {}, PROBE_TIMEOUT_MS);
    if ("failed" in info) {
      return [`  getWebhookInfo could not be reached (${info.failed}), so Telegram's own view of this bot is unknown\n`];
    }
    if (!info.ok || info.envelope["ok"] !== true) {
      const description = redact(String(info.envelope["description"] ?? "no description"), held);
      return [`  getWebhookInfo was refused: HTTP ${String(info.status)} (${description})\n`];
    }
    const result = (info.envelope["result"] ?? {}) as Record<string, unknown>;
    const pending = typeof result["pending_update_count"] === "number" ? result["pending_update_count"] : 0;
    const hook = typeof result["url"] === "string" ? redact(result["url"], held) : "";
    const lines: string[] = [];
    lines.push(
      pending > 0
        ? `  Telegram holds ${String(pending)} update(s) for this bot that no poller has consumed; another\n  process may be long-polling with an offset — stop \`approval channel telegram listen\`\n  (here and on any other machine) and retry.\n`
        : `  Telegram holds no pending updates for this bot. If you did send one, something else\n  acknowledged it with an offset (a listener or daemon, possibly on another machine); that\n  process will also fight \`approval channel telegram listen\` with 409s.\n`,
    );
    lines.push(
      hook.length > 0
        ? `  a webhook is registered at ${hook}; getUpdates returns nothing while a webhook is set —\n  remove it with deleteWebhook, or read the chat id off the webhook instead.\n`
        : `  no webhook is registered, so getUpdates is the right way to read this bot.\n`,
    );
    return lines;
  }

  /**
   * The chat, discovered from the bot's own updates.
   *
   * THE getUpdates BELOW CARRIES NO OFFSET, EVER. See this file's module doc.
   *
   * ## Waiting, rather than asking (APRV-96)
   *
   * The loop re-issues the same offset-less read back to back until a message
   * turns up or the deadline passes, and asks the operator for nothing while it
   * does. The old shape asked for Enter between reads, which made the OPERATOR
   * responsible for overlapping their message with a 10s window: a message sent
   * a second late was consumed by nothing, seen by nothing, and reported as "no
   * message seen yet" (observed 2026-08-18 running `examples/email-demo.md`).
   *
   * **Ctrl-C is the abort, and it is the terminal's own.** Nothing here reads
   * the keyboard, so stdin is not in raw mode and this process installs no
   * SIGINT handler: the signal reaches Node's default disposition and the
   * process dies between two HTTP calls. That is safe precisely because of
   * where this hook sits — `.approval/env` is written by the flow only after
   * every hook has returned, so an interrupted wait leaves the file exactly as
   * it found it. (The keystore item the token step created stays, as it does on
   * the give-up path below; it is a stored credential, not a half-written
   * record.) A handler would add a way to be wrong about that and no capability.
   */
  async function discoverChat(): Promise<HookOutcome> {
    const recovered = recoverToken();
    if (!recovered.ok) return { kind: "refused", code: recovered.code };
    const probed = await probeIdentity();
    if (!probed.ok) return { kind: "refused", code: probed.code };
    const bot = username ?? "the bot";
    const held = token ?? "";

    const deadlineMs = (deps as ChannelSetupDeps).discoveryDeadlineMs ?? DISCOVERY_DEADLINE_MS;
    const giveUpAt = Date.now() + deadlineMs;
    streams.out(
      `\nwaiting for a message to ${bot} (up to ${statedSeconds(deadlineMs)}, Ctrl-C to stop):\nopen Telegram and send it anything. No Enter is needed here — this keeps reading\nuntil your message lands, so it does not matter when you send it.\n`,
    );

    let candidates: Candidate[] = [];
    for (;;) {
      // NO OFFSET, EVER. An `offset` is an ACKNOWLEDGEMENT: it tells the Bot API
      // that everything below it may be discarded. A running
      // `approval channel telegram listen` owns that acknowledgement, and a
      // decision tap consumed here would never reach the listener that was
      // waiting for it — which is exactly why `approval doctor` refuses to call
      // getUpdates at all. Reading WITHOUT an offset confirms nothing: the
      // pending callback_query updates a listener is waiting for are still
      // pending when this returns. `allowed_updates: ["message"]` narrows the
      // read to the only kind this verb has any use for, so a callback is not
      // even delivered here.
      const updates = await call(
        fetchImpl,
        apiBase,
        held,
        "getUpdates",
        { timeout: context.pollTimeoutSeconds, allowed_updates: ["message"] },
        context.pollTimeoutSeconds * 1000 + PROBE_TIMEOUT_MS,
      );
      if ("failed" in updates) {
        streams.err(`approval: getUpdates on ${apiBase} failed: ${updates.failed}\n`);
        streams.err(`  nothing was written to ${context.envPath}\n`);
        return { kind: "refused", code: EXIT_IO };
      }
      if (!updates.ok || updates.envelope["ok"] !== true) {
        const description = redact(String(updates.envelope["description"] ?? "no description"), held);
        streams.err(
          `approval: getUpdates on ${apiBase} was refused: HTTP ${String(updates.status)} (${description})\n`,
        );
        streams.err(
          `  a 409 here means another process is long-polling this bot: stop \`approval channel telegram listen\` and re-run\n`,
        );
        return { kind: "refused", code: EXIT_INTEGRITY };
      }
      candidates = candidatesFrom(updates.envelope["result"]);
      if (candidates.length > 0) break;
      if (Date.now() >= giveUpAt) break;
    }

    if (candidates.length === 0) {
      const said = await webhookReport(held);
      streams.err(
        `approval: no message reached ${bot} in ${statedSeconds(deadlineMs)}, so there is no chat id to record.\n\nWhat to check first, and what Telegram says about this bot right now:\n\n  did you message ${bot}? That is the bot getMe answered for, and the chat header on\n  your phone must read exactly that — a message to a different bot lands nowhere here.\n${said.join("")}\nThe token is stored; only the two ${context.envPath} lines are missing. Find the id\nby hand — send the bot a message, then:\n\n  curl -s "${apiBase}/bot<token>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'\n\n(the <token> is yours to substitute; it is deliberately not printed here). Then:\n\n  printf '%s\\n' '${telegramChatEnvFor(context.load)}=<id>' >> ${context.envPath}\n\nIf the bot is in a GROUP, check that privacy mode is off in @BotFather, or the\nbot never sees plain group messages at all.\n`,
      );
      return { kind: "refused", code: EXIT_INTEGRITY };
    }

    if (candidates.length === 1) {
      const only = candidates[0] as Candidate;
      if (!context.prompter.confirm(`use chat ${only.id} (${only.type}, ${only.name})?`)) {
        streams.out("aborted: nothing was written\n");
        return { kind: "refused", code: EXIT_OK };
      }
      chosen = only;
    } else {
      const picked = pickOne(streams, context.prompter, {
        heading: `\n${String(candidates.length)} chats have messaged ${bot}, newest first:\n`,
        items: candidates,
        label: (candidate) => `${candidate.id} (${candidate.type}, ${candidate.name})`,
        prompt: `which one? [1-${String(candidates.length)}]: `,
        defaultIndex: null,
      });
      if (!picked.ok) {
        return {
          kind: "refused",
          code: usageError(streams, false, `${picked.message}; nothing was written`, helpText),
        };
      }
      chosen = picked.item;
    }
    return { kind: "value", value: chosen.id };
  }

  /**
   * The optional proof. Default NO: a configuration verb that buzzes a phone by
   * default is one an operator runs once and then avoids, which is doctor's
   * argument for calling getMe and nothing else.
   *
   * A send that fails is reported as DECLINED rather than as a failure, because
   * the configuration it would have proved is stored and correct as far as
   * anything here knows: a chat the bot may not post into is a Telegram-side
   * fact the operator fixes in Telegram, and exiting 1 over it would make the
   * verb look like it had refused to write the lines it had just written.
   */
  async function verifyChat(values: Record<string, string>): Promise<VerifyOutcome> {
    const chatId = values[telegramChatEnvFor(context.load)];
    if (chatId === undefined) return { ok: true, declined: true, detail: "" };
    if (!context.prompter.confirm(`send a test message to ${chatId} to prove it?`)) {
      return { ok: true, declined: true, detail: "" };
    }
    const held = token ?? "";
    const sent = await call(
      fetchImpl,
      apiBase,
      held,
      "sendMessage",
      { chat_id: chatId, text: "approval.md: setup test message. Nothing is pending." },
      PROBE_TIMEOUT_MS,
    );
    if ("failed" in sent || !sent.ok || sent.envelope["ok"] !== true) {
      const why =
        "failed" in sent
          ? sent.failed
          : redact(String(sent.envelope["description"] ?? "no description"), held);
      return {
        ok: true,
        declined: true,
        detail: `  the test message did not send (${why}); the chat id is recorded either way\n`,
      };
    }
    return { ok: true, detail: `  sent — check ${chosen?.name ?? chatId}\n` };
  }

  return {
    collect: async (spec) =>
      spec.name === tokenEnv ? await collectToken() : { kind: "skip" as const },
    discover: async (spec) =>
      spec.name === telegramChatEnvFor(context.load)
        ? await discoverChat()
        : { kind: "skip" as const },
    verify: async (values) => verifyChat(values),
  };
}

/** Every channel this verb can configure. Keyed by the `channel <name>` name. */
export const CHANNEL_SETUPS: Record<string, ChannelSetupEntry> = {
  telegram: {
    specs: (load) => telegramCredentialSpecs(load),
    summary: "the bot token and the approver chat, recorded where each of them lives",
    prereq: `IF \`approval channel telegram listen\` IS RUNNING, STOP IT FIRST. Two processes\nlong-polling one bot is a 409 from the Bot API, and the loser is whichever asked\nsecond. This verb is a configuration verb; it is not meant to run beside the\nlistener.\n\nThe token goes into the OS KEYSTORE and the chat id into .approval/env as a\nliteral: a channel holds no state, and what this file records is where the\ntransport credential lives. Nothing here appends to the log or\nattests anything.`,
    hint: TELEGRAM_HINT,
    hooks: telegramHooks,
    nextSteps: [
      `No update was acknowledged by this verb: every getUpdates above carried no`,
      `offset, so a running listener's pending callbacks are exactly where they were.`,
      ``,
      `Establish the variables and check the channel:`,
      ``,
      `  eval "$(approval env)"`,
      `  approval channel telegram health`,
    ],
    help: SETUP_CHANNEL_TELEGRAM_HELP,
  },
};

/** The known names, sorted, for a usage error and for the help text. */
export function knownChannelNames(): string[] {
  return Object.keys(CHANNEL_SETUPS).sort();
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * `approval setup channel <name>` — the interactive writer for one channel's
 * transport credentials. HUMAN-ONLY.
 *
 * The human-only gate is NEW in APRV-79. The Telegram help text had said
 * HUMAN-ONLY since APRV-74 and nothing enforced it: the verb stores a bot
 * credential and writes `.approval/env`, which is exactly what `vault` and
 * `sampling` are gated for, and a help text that claims a control the code does
 * not apply is worse than no claim at all.
 *
 * `argv` starts at the channel's name: `commandSetup` has already eaten
 * `channel`.
 */
export async function commandSetupChannel(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): Promise<number> {
  const json = argv.includes("--json");
  const name = argv[0];

  // The name is resolved BEFORE the terminal check, so that a typo is answered
  // with "here are the channels" rather than with a lecture about pipes.
  if (name === "--help" || name === "-h" || name === "help") {
    streams.out(`${SETUP_CHANNEL_HELP}\n`);
    return EXIT_OK;
  }
  if (name === undefined || name.startsWith("-")) {
    return usageError(
      streams,
      json,
      `missing <name> for \`approval setup channel\`; known channels: ${knownChannelNames().join(", ")}`,
      SETUP_CHANNEL_HELP,
    );
  }
  const entry = CHANNEL_SETUPS[name];
  if (entry === undefined) {
    return usageError(
      streams,
      json,
      `unknown channel ${JSON.stringify(name)}; known channels: ${knownChannelNames().join(", ")}`,
      SETUP_CHANNEL_HELP,
    );
  }
  const helpText = entry.help;

  const outcome = front(
    `channel ${name}`,
    argv.slice(1),
    streams,
    cwd,
    deps,
    helpText,
    (context: HintContext) => entry.hint(context),
  );
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const extra = context.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, false, `unexpected argument ${JSON.stringify(extra)}`, helpText);
  }

  const human = requireHuman(context.flags, streams, helpText, `channel ${name}`);
  if (!human.ok) return human.code;

  const result: FlowResult = await runCredentialFlow({
    streams,
    prompter: context.prompter,
    specs: entry.specs(context.load),
    destination: envFileDestination(context.envPath),
    labels: {
      title: `approval setup channel ${name} — ${entry.summary}.`,
      prereq: entry.prereq,
      nextSteps: entry.nextSteps,
    },
    hooks: entry.hooks(context, deps, streams, helpText),
  });

  // The flow decided the code; this verb adds nothing to it.
  return result.code;
}
