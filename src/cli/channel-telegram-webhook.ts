/**
 * `approval channel telegram webhook` — the same channel, the other arrival
 * (SPEC.md §10.3, APRV-424).
 *
 * `approval channel telegram listen` holds a socket open against `getUpdates`
 * for as long as the gate exists. That works, and it costs one always-running
 * process per bot and forbids a second poller on the same token. This verb
 * registers a URL with `setWebhook` instead and serves the callback, which is
 * what makes a sleep-when-idle host able to run a gate, and what lets an
 * operator put the receiver behind a proxy they already own.
 *
 * **Everything below the arrival is unchanged, and deliberately not restated
 * here.** The pending queue is still `dispatchPending`'s, re-derived from the
 * verified log every cycle. The handlers are still {@link wireListener}'s, the
 * same four function objects `listen` registers. A tap still becomes a
 * decision through `channels/telegram.ts`'s `handleUpdate` and
 * `channels/contract.ts`'s `recordChannelDecision`. This file resolves
 * configuration, refuses what it must refuse, binds a port and keeps a cycle
 * running; it decides nothing and it renders nothing.
 *
 * ## The three refusals that are the point of the task
 *
 * 1. **The secret comes from the launch environment, never from the tree.**
 *    `APPROVAL_TG_WEBHOOK_SECRET` (`core/telegram-config.ts` says why the name
 *    is conventional rather than policy-declared), refused when it is unset,
 *    when it is shorter than a value a host would generate, and when it holds
 *    a character Telegram will not accept. SPEC.md §11.1 invariant 7.
 * 2. **A post without the matching header decides nothing.** That check is
 *    `channels/telegram-webhook.ts`'s, before the path, the method or the
 *    body, and its refusal is counted and complained about rather than
 *    appended: an endpoint the internet can reach must not be able to grow the
 *    tenant's log.
 * 3. **One transport per bot.** The preflight asks the Bot API which webhook
 *    holds this bot and refuses a foreign one; `listen` and `approval up` ask
 *    the same question and refuse when any webhook holds it. Within one
 *    process the channel refuses the second claim outright.
 *
 * ## Where TLS is, and why the bind is loopback
 *
 * Telegram will only deliver to an HTTPS URL, and this process terminates no
 * TLS and holds no certificate — exactly as `approval serve` does not
 * (APRV-421, `cli/serve.ts`). The supported deployment is a loopback bind
 * behind a proxy or a tunnel the operator owns, which is what `--url` names
 * and what `docs/cli-reference.md#channel-telegram-webhook` states. A
 * non-loopback bind takes two flags and prints a banner, because the secret
 * arrives in a header and a cleartext hop hands it to whoever is on it.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { TelegramApiError } from "../channels/telegram.js";
import {
  serveTelegramWebhook,
  TELEGRAM_WEBHOOK_DEFAULT_HOST,
  TELEGRAM_WEBHOOK_DEFAULT_PORT,
  TELEGRAM_SECRET_HEADER,
  type TelegramWebhookHandle,
} from "../channels/telegram-webhook.js";
import {
  redactWebhookUrl,
  TELEGRAM_WEBHOOK_SECRET_ENV,
} from "../core/telegram-config.js";
import { loadPolicy, parseDuration } from "../core/policy-load.js";
import { passphraseEnvFor } from "../core/vault.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  claimListenerBot,
  dispatchPending,
  glossWiring,
  prepareListen,
  reportCycle,
  wireListener,
  type ListenRefusalCode,
  type ListenSetup,
} from "./channel-telegram.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import type { GlossRunner } from "./gloss.js";
import { parseGlossOptions } from "./gloss-options.js";
import { TELEGRAM_WEBHOOK_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { isLoopbackHost, parseListen } from "./mcp.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

const WEBHOOK_FLAGS: Record<string, FlagKind> = {
  "--url": "string",
  "--listen": "string",
  "--port": "string",
  "--path": "string",
  "--allow-non-loopback": "boolean",
  /** APRV-424 review finding 6: register over a webhook that already holds this bot. */
  "--reclaim": "boolean",
  "--cycle": "string",
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--as": "string",
  "--payloads": "string",
  "--api-base": "string",
  "--allow-cross-instance": "boolean",
  "--gloss": "boolean",
  "--no-gloss": "boolean",
  "--gloss-provider": "string",
  "--gloss-model": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * The shortest `secret_token` this verb will start with.
 *
 * `serve/credentials.ts`'s floor, for its reason: not a password policy, a
 * floor under the one mistake that makes the check meaningless, which is a
 * memorable value somebody typed. The host generates this; the floor costs it
 * nothing.
 */
export const WEBHOOK_MIN_SECRET_LENGTH = 24;

/** What Telegram accepts in a `secret_token`: 1-256 of these characters. */
const SECRET_CHARSET = /^[A-Za-z0-9_-]+$/u;

/**
 * The ports Telegram will deliver a webhook to.
 *
 * Telegram's own list, and it is the reason `--url` is refused rather than
 * attempted when it names anything else: a `setWebhook` on port 9443 is
 * accepted by this runtime, refused by the Bot API, and the operator reads a
 * network error instead of the sentence below.
 */
const TELEGRAM_WEBHOOK_PORTS = new Set([443, 80, 88, 8443]);

/** How often the dispatch cycle runs when the operator names no period. */
export const WEBHOOK_DEFAULT_CYCLE_MS = 30_000;

/**
 * Why a webhook runner could not be built. A closed union, distinct per
 * repair, per SPEC.md §11.1 invariant 6.
 *
 * It sits BESIDE `LISTEN_REFUSAL_CODES` rather than inside it: every reason a
 * listener cannot start is a reason this cannot either (it needs the same
 * token, chat, identity, log and policy), and these are the reasons peculiar
 * to a transport that binds a port and registers a URL.
 */
export const WEBHOOK_REFUSAL_CODES = [
  /** `APPROVAL_TG_WEBHOOK_SECRET` is unset or empty. */
  "webhook-secret-missing",
  /** It is shorter than {@link WEBHOOK_MIN_SECRET_LENGTH}. */
  "webhook-secret-weak",
  /** It holds a character Telegram will not accept in a `secret_token`. */
  "webhook-secret-charset",
  /** No `--url`: nothing to register, so nothing would ever be delivered. */
  "webhook-url-missing",
  /** `--url` is not a URL, or its scheme is not `https`. */
  "webhook-url-insecure",
  /** `--url` names a port Telegram does not deliver to. */
  "webhook-url-port",
  /**
   * `--url` carries userinfo (`https://user:pw@host/hook`) (review finding 10).
   *
   * Refused rather than stripped. A credential in a url is a credential the
   * operator put on a command line, and a runtime that quietly dropped it
   * would register an endpoint that answers differently from the one they
   * typed; a runtime that kept it would carry it into `setWebhook`, into the
   * start-up banner and into every refusal that names the url.
   */
  "webhook-url-userinfo",
  /**
   * `--path` is not a servable path: it does not start with `/`, or it holds a
   * `..` segment (review finding 3).
   */
  "webhook-path-invalid",
  /**
   * `--path` is a servable path, and not the one `--url` names (review finding
   * 3).
   *
   * The pair used to be free to disagree, described as an override for a proxy
   * that rewrites on the way. What it actually bought was a receiver that
   * registered cleanly, verified the secret on every real delivery, and then
   * answered all of them 404: `telegram/webhook` against a url path of
   * `/telegram/webhook`, or `/hook/` against a url ending `/hook`, both start
   * without a word. A path mismatch is now a startup refusal.
   */
  "webhook-path-mismatch",
  /** `--cycle` was not a duration. */
  "webhook-cycle",
  /**
   * `setWebhook` was refused by the Bot API.
   *
   * Emitted by {@link runWebhook} since the review of this task; before it the
   * code was declared here and the failure was reported as a bare `io`, which
   * made "Telegram will not take this registration" indistinguishable from
   * "the log could not be read". The status and the Bot API's own description
   * are carried, redacted of the token and the secret by the channel.
   */
  "webhook-registration-failed",
] as const;

export type WebhookRefusalCode = (typeof WEBHOOK_REFUSAL_CODES)[number];

export interface WebhookSetup {
  /** Everything a listener has: the channel, the log, the identity, the policy. */
  listen: ListenSetup;
  /** The `secret_token`, as a value. Never printed, never logged, never recorded. */
  secret: string;
  /** The public URL registered with `setWebhook`. */
  url: string;
  /** The path this process answers. Derived from `--url` unless `--path` says otherwise. */
  path: string;
  /** The interface to bind. Loopback unless the operator widened it. */
  host: string;
  /** The port to bind. Distinct from the URL's port, which is the proxy's. */
  port: number;
  /** How often the dispatch cycle runs. */
  cycleMs: number;
  /**
   * `--reclaim`: register over a webhook that already holds this bot (review
   * finding 6).
   *
   * Carried on the setup rather than consulted from the flags again, because
   * the check it overrides is made by {@link claimListenerBot}, which this
   * verb shares with the poller.
   */
  reclaim: boolean;
}

export type WebhookPreparation =
  | { ok: true; setup: WebhookSetup }
  | { ok: false; code: WebhookRefusalCode | ListenRefusalCode; message: string };

/** Everything {@link prepareWebhook} needs, already resolved. */
export interface WebhookRequest {
  logPath: string;
  policy: { dir?: string; file?: string };
  as: string | null;
  payloads: string | null;
  apiBase: string | null;
  json: boolean;
  allowCrossInstance?: boolean;
  /** `--url` as typed, or `null`. */
  url: string | null;
  /** `--path`, or `null` to take the URL's own path. */
  path: string | null;
  /** The bind, already parsed by the verb. */
  host: string;
  port: number;
  /** `--cycle` as typed, or `null` for {@link WEBHOOK_DEFAULT_CYCLE_MS}. */
  cycle: string | null;
  /** `--reclaim` as passed. Defaults to false, which is the refusing side. */
  reclaim?: boolean;
  /** The environment the secret is read from. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  log(message: string): void;
  /** The gloss runner, if the caller wants one. See {@link ListenSetup.gloss}. */
  gloss?: GlossRunner;
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, TELEGRAM_WEBHOOK_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

/**
 * A refusal that has its own code, rather than the transport-shaped `io`.
 *
 * Added for review finding 4: `webhook-registration-failed` was declared in
 * the frozen union above and never emitted, so a `setWebhook` the Bot API
 * turned down reached the operator as `{"error":{"code":"io"}}` — the same
 * code an unreadable log produces, for a completely different repair. The exit
 * code stays {@link EXIT_IO}, because what failed is still a call out of this
 * process; what changes is that the machine-readable half names it.
 */
function refusalError(
  streams: Streams,
  json: boolean,
  code: WebhookRefusalCode,
  message: string,
): number {
  if (json) streams.err(`${JSON.stringify({ error: { code, message } })}\n`);
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

/**
 * Everything that can fail without touching the network, in order.
 *
 * {@link prepareListen} first, because a webhook runner that has no bot token,
 * no chat and no human identity is not a webhook problem: the two verbs refuse
 * those the same way, in the same sentences, for the reason `prepareListen`
 * exists at all. Then the three this transport adds.
 *
 * It PRINTS NOTHING and CHOOSES NO EXIT CODE, exactly as `prepareListen` does.
 */
export function prepareWebhook(request: WebhookRequest): WebhookPreparation {
  const listen = prepareListen({
    logPath: request.logPath,
    policy: request.policy,
    as: request.as,
    payloads: request.payloads,
    apiBase: request.apiBase,
    // No `getUpdates` runs under this transport, so there is no long poll to
    // time out. The channel keeps its default and never issues one.
    pollTimeout: null,
    once: false,
    json: request.json,
    ...(request.allowCrossInstance === undefined
      ? {}
      : { allowCrossInstance: request.allowCrossInstance }),
    log: request.log,
    ...(request.gloss === undefined ? {} : { gloss: request.gloss }),
  });
  if (!listen.ok) return listen;

  const environment = request.env ?? process.env;
  const raw = environment[TELEGRAM_WEBHOOK_SECRET_ENV];
  const secret = raw === undefined ? "" : raw.trim();
  if (secret.length === 0) {
    return {
      ok: false,
      code: "webhook-secret-missing",
      message: `no ${TELEGRAM_WEBHOOK_SECRET_ENV} in the environment. A webhook URL is a public endpoint and its only authentication is Telegram's secret_token, echoed on every delivery in ${TELEGRAM_SECRET_HEADER}; without one, any post that looked like a tap would be one. Generate it (\`openssl rand -hex 32\`) and set it in the environment this process is launched from — never in a file in the tree`,
    };
  }
  if (!SECRET_CHARSET.test(secret) || secret.length > 256) {
    return {
      ok: false,
      code: "webhook-secret-charset",
      message: `${TELEGRAM_WEBHOOK_SECRET_ENV} holds a value Telegram will not accept as a secret_token: 1 to 256 characters of A-Z, a-z, 0-9, underscore and hyphen. Its value is not shown here and is in no message this process writes`,
    };
  }
  if (secret.length < WEBHOOK_MIN_SECRET_LENGTH) {
    return {
      ok: false,
      code: "webhook-secret-weak",
      message: `${TELEGRAM_WEBHOOK_SECRET_ENV} is shorter than ${String(WEBHOOK_MIN_SECRET_LENGTH)} characters. Generate it (\`openssl rand -hex 32\`) rather than choosing it: this value is the whole of what separates a delivery from Telegram from a post by anyone who can reach the URL`,
    };
  }

  if (request.url === null) {
    return {
      ok: false,
      code: "webhook-url-missing",
      message:
        "no --url: this verb registers a public HTTPS URL with setWebhook, and without one Telegram has nowhere to deliver a tap. Name the address your proxy or tunnel serves, not this process's bind",
    };
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {
      ok: false,
      code: "webhook-url-insecure",
      message: `--url ${JSON.stringify(request.url)} is not a URL`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "webhook-url-insecure",
      message: `--url ${JSON.stringify(request.url)} is not https. Telegram delivers to HTTPS only, and the secret travels in a header: terminate TLS in a proxy or a tunnel you own and give this process the loopback bind behind it`,
    };
  }
  const urlPort = url.port === "" ? 443 : Number(url.port);
  if (!TELEGRAM_WEBHOOK_PORTS.has(urlPort)) {
    return {
      ok: false,
      code: "webhook-url-port",
      message: `--url names port ${String(urlPort)}, and Telegram delivers a webhook only to ${[...TELEGRAM_WEBHOOK_PORTS].join(", ")}. That is the PUBLIC port your proxy answers on; this process's own bind is --port / --listen and can be anything`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    // Refused, not stripped. See `webhook-url-userinfo`: the value is a
    // credential on a command line, and this runtime neither carries it into
    // `setWebhook` nor decides on the operator's behalf that they did not mean
    // it. The message quotes the origin alone, so the refusal does not print
    // the thing it is refusing.
    return {
      ok: false,
      code: "webhook-url-userinfo",
      message: `--url carries a username or a password (${url.origin} was given with userinfo in front of the host). Telegram's delivery would not use it, this runtime will not register it, and a credential in a url ends up in shell history, in a process listing and in every line that names the url. Put the authentication in the proxy in front of this process, and give --url the plain https address it answers on`,
    };
  }

  // The path this process SERVES is the url's own, always (review finding 3).
  // `--path` is an explicit restatement of it and nothing more: the two used
  // to be free to disagree, and a disagreement produced a receiver that
  // registered, verified the secret on every real delivery, and 404'd every
  // one of them.
  if (request.path !== null) {
    const declared = request.path;
    if (!declared.startsWith("/") || declared.split("/").includes("..")) {
      return {
        ok: false,
        code: "webhook-path-invalid",
        message: `--path ${JSON.stringify(declared)} is not a path this server can serve: it must begin with "/" and hold no ".." segment. It is the path Telegram will POST to, which is the path in --url (${url.pathname})`,
      };
    }
    if (declared !== url.pathname) {
      return {
        ok: false,
        code: "webhook-path-mismatch",
        message: `--path ${JSON.stringify(declared)} is not the path --url names (${url.pathname}). Telegram posts to the url it was given, so a receiver listening on any other path verifies the secret on every real delivery and then answers it 404. Pass --path only to restate the url's own path, and put any rewriting in the proxy in front of this process`,
      };
    }
  }

  const cycleMs =
    request.cycle === null ? WEBHOOK_DEFAULT_CYCLE_MS : (parseDuration(request.cycle) ?? -1);
  if (cycleMs <= 0) {
    // `parseDuration` is the same parser `--interval` and `--timeout` use
    // everywhere else, so a duration that works on one verb works on this one.
    return {
      ok: false,
      code: "webhook-cycle",
      message: `--cycle expects a duration like 30s, 5m, got ${JSON.stringify(request.cycle)}`,
    };
  }

  return {
    ok: true,
    setup: {
      listen: listen.setup,
      secret,
      url: request.url,
      // The url's own path, checked against `--path` above when one was given.
      // One path, one registration, one route: what Telegram posts to is what
      // this process answers.
      path: url.pathname,
      host: request.host,
      port: request.port,
      cycleMs,
      reclaim: request.reclaim ?? false,
    },
  };
}

/**
 * `--listen` / `--port` -> the interface and port this process binds (review
 * finding 9).
 *
 * Its own function, and exported, because three refusals live in it and each
 * one is a thing an operator can type:
 *
 * - **Port 0 is refused.** The kernel hands out an ephemeral port for it, and
 *   an ephemeral port is the one thing this transport cannot use: the whole
 *   deployment is a proxy forwarding a fixed public url to a fixed local
 *   address, so a receiver that bound 51423 registered a url nothing would
 *   ever reach and said nothing about it. Tests bind 0 by calling the receiver
 *   directly, which is the level where an ephemeral port is the point.
 * - **A port outside 1..65535 is refused**, on either flag. `parseListen`
 *   accepts 0 for `approval serve`'s own reasons, so the floor is applied
 *   here rather than assumed there.
 * - **A routable interface needs `--allow-non-loopback`**, because this
 *   process speaks plain HTTP and the secret arrives in a header.
 */
export type WebhookBind =
  | { ok: true; host: string; port: number }
  | { ok: false; message: string };

export function resolveWebhookBind(
  listenFlag: string | null,
  portFlag: string | null,
  allowNonLoopback: boolean,
): WebhookBind {
  if (listenFlag !== null && portFlag !== null) {
    return {
      ok: false,
      message:
        "--listen and --port name the same thing; pass one. --listen <[host:]port> is the only way to bind a non-loopback interface",
    };
  }
  let host = TELEGRAM_WEBHOOK_DEFAULT_HOST;
  let port = TELEGRAM_WEBHOOK_DEFAULT_PORT;
  if (listenFlag !== null) {
    const bind = parseListen(listenFlag);
    if (!bind.ok) return { ok: false, message: bind.message };
    host = bind.host;
    port = bind.port;
  } else if (portFlag !== null) {
    if (!/^\d+$/u.test(portFlag.trim())) {
      return { ok: false, message: `--port expects a whole number, got ${JSON.stringify(portFlag)}` };
    }
    port = Number(portFlag.trim());
  }
  if (port === 0) {
    return {
      ok: false,
      message: `the bind port may not be 0. Port 0 asks the kernel for an ephemeral port, and this transport is a fixed public url forwarded to a fixed local address: a receiver on a port nobody registered would verify nothing and answer nothing. Name the port your proxy forwards to (the default is ${String(TELEGRAM_WEBHOOK_DEFAULT_PORT)})`,
    };
  }
  if (port < 1 || port > 65535) {
    return { ok: false, message: `the bind port ${String(port)} is outside the TCP port range 1..65535` };
  }
  if (!isLoopbackHost(host) && !allowNonLoopback) {
    return {
      ok: false,
      message: `--listen ${JSON.stringify(host)} is not the loopback interface, and this process speaks plain HTTP: the webhook secret arrives in a header and a cleartext hop hands it to whoever is on it. Add --allow-non-loopback if you meant it and TLS is terminated in front of this process`,
    };
  }
  return { ok: true, host, port };
}

/**
 * The banner a non-loopback bind prints, every time, on stderr.
 *
 * `cli/serve.ts`'s, with the one credential this surface has in place of that
 * one's two. Reached only when the operator passed both `--listen` naming a
 * routable interface and `--allow-non-loopback`, so it is not a warning about
 * something that happened by accident.
 */
export function webhookNonLoopbackBanner(host: string, port: number): string {
  return [
    "",
    "  !! the telegram webhook receiver IS BOUND TO A NON-LOOPBACK INTERFACE !!",
    `  ${host}:${String(port)} is reachable by anyone who can route to it, and this`,
    "  process speaks PLAIN HTTP: it terminates no TLS and holds no certificate.",
    `  The ${TELEGRAM_SECRET_HEADER} header is what separates a delivery from`,
    "  Telegram from a forgery, and a cleartext hop hands it to whoever is on it.",
    "  Terminate TLS in a proxy you control and give this process a loopback bind.",
    "",
    "",
  ].join("\n");
}

/**
 * Run the receiver until a signal stops it.
 *
 * The order is the one `cli/serve.ts` argues for, with one change that is this
 * transport's own: everything that can refuse refuses first, and the LOCAL
 * bind happens before `setWebhook`, so there is no window in which Telegram is
 * posting to a port nothing is listening on.
 */
export async function runWebhook(setup: WebhookSetup, streams: Streams): Promise<number> {
  const { listen } = setup;
  const json = listen.json;
  /** The url as it may be printed: origin plus the path this process serves. */
  const shownUrl = redactWebhookUrl(setup.url, setup.path);

  for (const finding of listen.crossInstance) {
    streams.err(`approval: --allow-cross-instance: starting anyway — ${finding.detail}\n`);
  }

  // Which bot is this, whose is it, and what is already receiving its updates.
  // The same preflight `approval channel telegram listen` runs, told that THIS
  // process is the webhook at this URL: without `--reclaim` any registration
  // refuses, including one at this very url, because two hosts sharing one
  // configuration both read that as their own restart (review finding 6). It
  // also takes this gate's transport lease, which is what makes a poller
  // already running in the same project a refusal rather than a double
  // delivery (review finding 1).
  const claimed = await claimListenerBot(listen, (message) => streams.err(`${message}\n`), {
    webhookUrl: setup.url,
    reclaim: setup.reclaim,
    mode: "webhook",
  });
  if (!claimed.ok) return integrityError(streams, json, claimed.message);

  try {
    const state = wireListener(listen, streams);

    // The startup cycle, before anything is bound: an operator who has just
    // mistyped a token or pointed at an unreadable log should learn it here
    // rather than watch a receiver sit on a port. Same call, same state and
    // same fatal-failure rule as `startListener`'s.
    const startup = await dispatchPending(listen, streams, state, new Date().toISOString());
    if (startup.queueError !== undefined) {
      return startup.queueError.code === "log-unreadable"
        ? ioError(streams, json, startup.queueError.message)
        : integrityError(streams, json, startup.queueError.message);
    }
    const firstFailure = startup.failed[0];
    if (firstFailure !== undefined) {
      return ioError(streams, json, `telegram sendMessage failed: ${firstFailure.message}`);
    }

    const cycle = async (): Promise<void> => {
      reportCycle(await dispatchPending(listen, streams, state, new Date().toISOString()), streams);
    };

    let handle: TelegramWebhookHandle;
    try {
      handle = await serveTelegramWebhook({
        channel: listen.channel,
        secret: setup.secret,
        path: setup.path,
        host: setup.host,
        port: setup.port,
        log: (message) => streams.err(`${message}\n`),
        // The dispatch cycle, run after each update the channel accepted: this
        // is where a paced listener's NEXT question goes out once the shown one
        // is decided, and the poll loop gets the same thing from `beforePoll`.
        afterUpdate: cycle,
      });
    } catch (cause) {
      return ioError(
        streams,
        json,
        `telegram webhook could not bind ${setup.host}:${String(setup.port)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    try {
      await listen.channel.registerWebhook(setup.url, setup.secret);
    } catch (cause) {
      await handle.close();
      // Its own code since the review of this task (finding 4): "Telegram will
      // not take this registration" and "the log could not be read" used to
      // arrive as the same `io`, which is two different repairs under one
      // name. The status and the Bot API's own description come through, both
      // already scrubbed of the token and the secret by the channel.
      const api = cause instanceof TelegramApiError ? cause : null;
      const detail =
        api === null
          ? cause instanceof Error
            ? cause.message
            : String(cause)
          : [
              api.status === null ? null : `HTTP ${String(api.status)}`,
              api.description ?? api.message,
            ]
              .filter((part): part is string => part !== null)
              .join(": ");
      return refusalError(
        streams,
        json,
        "webhook-registration-failed",
        `telegram setWebhook was refused for ${shownUrl} (${detail}); nothing is registered and this process is not listening`,
      );
    }

    if (!isLoopbackHost(handle.host)) {
      streams.err(webhookNonLoopbackBanner(handle.host, handle.port));
    }
    const started = `approval: telegram webhook registered ${shownUrl} and bound http://${handle.host}:${String(handle.port)}${handle.path} as ${listen.actor}. Every post must carry ${TELEGRAM_SECRET_HEADER}; TLS is your proxy's. Press Ctrl-C to stop, which removes the webhook.`;
    if (json) {
      streams.out(
        `${JSON.stringify({
          event: "webhook_started",
          // The origin and the served path, not the url as typed (review
          // finding 10): a tunnel that puts a random token in the path should
          // not have it copied into a log line nobody asked for.
          url: shownUrl,
          host: handle.host,
          port: handle.port,
          path: handle.path,
          cycle_ms: setup.cycleMs,
        })}\n`,
      );
    }
    streams.err(`${started}\n`);

    // The cycle a poller gets from its poll loop. Serialized with delivery, so
    // a dispatch never runs while an update is being handled: the channel's
    // maps and its single ack slot are not reentrant.
    const timer = setInterval(() => {
      void handle.serialize(cycle).catch((cause: unknown) => {
        streams.err(
          `approval: telegram webhook dispatch cycle failed (${
            cause instanceof Error ? cause.message : String(cause)
          }); retrying next cycle\n`,
        );
      });
    }, setup.cycleMs);
    // Nothing about a cycle should hold the process open on its own.
    timer.unref?.();

    return await new Promise<number>((settle) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        clearInterval(timer);
        void (async () => {
          // THE ORDER IS THE POINT (review finding 2). The receiver stops
          // accepting and then drains: an update mid-append keeps its socket,
          // finishes its decision and writes its response. Only then does this
          // process tell Telegram to stop delivering, and only then does it
          // say it has stopped. The first version closed first and resolved in
          // about a millisecond, so `deleteWebhook`, the stopped line and the
          // exit all happened inside somebody's append.
          //
          // SIGINT stays hooked for the whole of it, so a second Ctrl-C is
          // absorbed by the `stopping` guard rather than killing the process
          // through Node's default handler halfway through the drain.
          await handle.close();

          // Best effort, and said out loud when it fails: a webhook left
          // registered is a bot no poller can start against, which is exactly
          // the refusal this task added.
          try {
            await listen.channel.deleteWebhook();
          } catch (cause) {
            streams.err(
              `approval: telegram deleteWebhook failed (${
                cause instanceof Error ? cause.message : String(cause)
              }); the webhook is still registered, so getUpdates will refuse until it is removed\n`,
            );
          }
          if (json) {
            streams.out(
              `${JSON.stringify({
                event: "stopped",
                ...listen.channel.stats(),
                webhook: handle.stats(),
              })}\n`,
            );
          }
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          settle(EXIT_OK);
        })();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } finally {
    // The transport lease goes back however this verb ends: a clean stop, a
    // refused registration, a log that could not be read. The next process to
    // start in this gate finds no lease rather than one it has to reclaim.
    claimed.lease.release();
  }
}

/** `approval channel telegram webhook [flags]`. */
export async function commandTelegramWebhook(
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, WEBHOOK_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${TELEGRAM_WEBHOOK_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const flags = parsed.flags;
  const selectedGloss = parseGlossOptions(flags, true);
  if (!selectedGloss.ok) return usageError(streams, json, selectedGloss.message);

  // The bind, parsed exactly as `approval serve` parses its own: `--port`
  // never reaches a routable interface, `--listen` is the only thing that can,
  // a non-loopback host needs a second flag on top, and since the review of
  // this task port 0 is refused rather than turned into an ephemeral bind
  // nothing has registered.
  const bind = resolveWebhookBind(
    stringFlag(flags, "--listen"),
    stringFlag(flags, "--port"),
    boolFlag(flags, "--allow-non-loopback"),
  );
  if (!bind.ok) return usageError(streams, json, bind.message);

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
  const payloadsFlag = stringFlag(flags, "--payloads");

  const prepared = prepareWebhook({
    logPath: resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd),
    policy,
    as: stringFlag(flags, "--as"),
    payloads: payloadsFlag === null ? null : absolute(payloadsFlag, cwd),
    apiBase: stringFlag(flags, "--api-base"),
    json,
    allowCrossInstance: boolFlag(flags, "--allow-cross-instance"),
    url: stringFlag(flags, "--url"),
    path: stringFlag(flags, "--path"),
    host: bind.host,
    port: bind.port,
    cycle: stringFlag(flags, "--cycle"),
    reclaim: boolFlag(flags, "--reclaim"),
    log: (message: string) => streams.err(`${message}\n`),
    ...glossWiring(flags, passphraseEnvFor(loadPolicy(policy)), {
      diagnostic: (reason) =>
        streams.err(`approval: Codex gloss unavailable (${reason}); continuing without it\n`),
    }),
  });

  if (!prepared.ok) {
    // The mapping `channel telegram listen` uses, extended by this verb's own:
    // a path that could not be read is I/O, and everything else is a command
    // line or an environment the operator can fix in one edit.
    return prepared.code === "log-unreadable" || prepared.code === "payloads-unreadable"
      ? ioError(streams, json, prepared.message)
      : usageError(streams, json, prepared.message);
  }

  return await runWebhook(prepared.setup, streams);
}
