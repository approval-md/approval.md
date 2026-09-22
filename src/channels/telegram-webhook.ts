/**
 * The Telegram webhook receiver (SPEC.md §10.3, APRV-424).
 *
 * §10.3 has always written the channel interface as `notify(request) ->
 * delivery_id`, `poll()/webhook() -> decision`. Until this task only the first
 * half of the second clause existed: the Telegram channel long-polled
 * `getUpdates`, which needs one always-running process per bot and forbids a
 * second poller on the same token. This is the other half. Telegram posts each
 * update to a URL the runtime registered, and a host that sleeps between
 * requests can therefore serve a gate.
 *
 * ## It decides nothing, and it barely reads
 *
 * This file checks one header, one path, one method and one body size, parses
 * JSON, and hands the object to {@link TelegramChannel.deliverUpdate}. Which
 * account the Bot API attributed the tap to, which approver the attested
 * policy maps that account to, whether the gate will take the answer, and what
 * the message is edited to say afterwards are all decided exactly where they
 * were decided before this task existed — in `channels/telegram.ts`'s
 * `handleUpdate` and in `channels/contract.ts`'s `recordChannelDecision`,
 * reached by the same call the poll loop makes. An update that arrives here is
 * an update; it is not evidence about itself.
 *
 * ## The secret is the whole of the authentication
 *
 * A webhook URL is a public endpoint. Anyone who can route to it can POST a
 * JSON object that LOOKS like a tap from the approver's chat, and nothing in
 * the body could tell the difference: SPEC.md §11.1 invariant 4 — a
 * self-reported field never reduces scrutiny — is exactly the rule that makes
 * a body-only check worthless here. So Telegram's own `secret_token` is
 * REQUIRED rather than optional. It is set on `setWebhook`, echoed on every
 * delivery in `X-Telegram-Bot-Api-Secret-Token`, compared here in constant
 * time, and a post without the matching value is refused before its path, its
 * method or its body is looked at.
 *
 * Three consequences, each deliberate:
 *
 * - **The comparison is over SHA-256 digests under `timingSafeEqual`**, which
 *   is constant-time AND length-independent (`timingSafeEqual` throws on a
 *   length mismatch, which would itself be an oracle for the secret's length).
 *   `serve/credentials.ts` states the same argument for the same reason.
 * - **Duplicate headers are refused rather than resolved.** Node joins
 *   repeated headers, so two of them would make the value this server compares
 *   differ from the one a reader of the request would name. There is no
 *   correct choice; the request is malformed.
 * - **A refusal appends NOTHING to the log.** It is counted, complained about
 *   on the runner's stderr and answered with its own machine-readable code,
 *   and it never reaches the decision path. This is `TELEGRAM_ANOMALY_KINDS`'s
 *   rule, and it matters more here than it does there: writing "somebody
 *   posted a forgery" into an append-only approval log would let anyone who
 *   can reach this URL grow the record a human is asked to trust. A refusal is
 *   a fact about this transport, and this transport reports it where facts
 *   about transports belong.
 *
 * ## What is reused from `approval serve`, and what could not be
 *
 * The shape is APRV-421's, deliberately: loopback bind by default with the
 * operator's proxy terminating TLS, the credential checked before the URL is
 * parsed, a refusal carried as a body with a frozen code rather than as a bare
 * status, an oversized body drained before the refusal is written (a response
 * written while the client is still uploading closes the socket under it), and
 * no state a restart loses.
 *
 * Its CODE could not be reused, and the reason is structural rather than
 * stylistic. `src/serve/` imports `src/cli/`, which imports `src/channels/`;
 * an import from here back into `src/serve/` would close an ESM cycle, which
 * is not a compile error but a binding that is `undefined` in one direction on
 * the day module initialisation order changes. `tests/layering.test.ts` pins
 * that direction. The two servers are also different surfaces: that one
 * answers two bearer credentials for two parties across six routes, this one
 * answers Telegram's echoed secret on one.
 *
 * ## One update at a time
 *
 * Deliveries are serialized through a promise chain. `handleUpdate` keeps a
 * single callback-query ack slot and the delivery maps are plain `Map`s, so
 * two updates handled concurrently would interleave in ways nobody ordered.
 * The poll loop gets this for free by awaiting each update in turn; an HTTP
 * server has to say it.
 *
 * ## Redelivery is safe because the gate is
 *
 * Telegram retries a delivery it did not get a 2xx for, so the same tap can
 * arrive twice. Nothing here deduplicates, and nothing needs to: the second
 * one reaches `decide()` through the same path as the first and is refused
 * `already-decided` with the first human answer standing. That is the same
 * property a button pressed twice has had since APRV-26.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { TelegramChannel, TelegramPollResult } from "./telegram.js";

/**
 * The header Telegram echoes the `secret_token` in, lowercased as Node
 * presents it.
 */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** The path this server answers when the operator names none. */
export const TELEGRAM_WEBHOOK_DEFAULT_PATH = "/telegram/webhook";

/** The interface it binds when the operator names none. Loopback, always. */
export const TELEGRAM_WEBHOOK_DEFAULT_HOST = "127.0.0.1";

/** The port it binds when the operator names none. */
export const TELEGRAM_WEBHOOK_DEFAULT_PORT = 4683;

/**
 * Largest body accepted. A Telegram update is a small JSON object; the
 * largest thing one can carry is a message's 4096-character text.
 */
export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * How much of an oversized body is read and thrown away before the socket is
 * dropped. `serve/server.ts` carries the argument: the refusal cannot be
 * written until the client stops writing, or the response closes the socket
 * under it and the caller sees a transport error instead of a refusal.
 */
export const TELEGRAM_WEBHOOK_DRAIN_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Everything this receiver refuses, and nothing else. Frozen, per SPEC.md
 * §11.1 invariant 6: a refusal is machine-readable and distinct.
 *
 * Distinct because the repairs are distinct. A secret mismatch is a forgery or
 * a rotation the registration did not follow; an unknown path is a URL that
 * does not match the one registered; a body too large is a caller that is not
 * Telegram. None of them is a decision, and none of them is the same fact.
 */
export const TELEGRAM_WEBHOOK_REFUSAL_CODES = [
  /** No `X-Telegram-Bot-Api-Secret-Token`, or one that is not the registered value. */
  "webhook-secret-mismatch",
  /** More than one secret header. Malformed, and not resolvable by choosing. */
  "webhook-duplicate-secret-header",
  /** A path this server does not serve. */
  "webhook-unknown-path",
  /** The right path, the wrong method. Telegram POSTs. */
  "webhook-method-not-allowed",
  /** Larger than {@link TELEGRAM_WEBHOOK_MAX_BODY_BYTES}. */
  "webhook-body-too-large",
  /** The body could not be read off the socket, or is not JSON. */
  "webhook-body-unreadable",
  /** JSON that is not an Update object. */
  "webhook-not-an-update",
  /** The channel is already receiving updates by the other transport. */
  "webhook-transport-conflict",
  /** The channel threw while handling the update. Nothing is claimed about the log. */
  "webhook-handler-failed",
] as const;

export type TelegramWebhookRefusalCode = (typeof TELEGRAM_WEBHOOK_REFUSAL_CODES)[number];

/** What this receiver has done since it bound. Counters, never decisions. */
export interface TelegramWebhookStats {
  /** Requests answered, of any kind. */
  requests: number;
  /** Updates handed to the channel. */
  updates: number;
  /** Refusals, by code. Never a decision, never a log event. */
  refusals: Record<TelegramWebhookRefusalCode, number>;
}

export interface TelegramWebhookOptions {
  /** The channel every accepted update is handed to. */
  channel: TelegramChannel;
  /**
   * The registered `secret_token`, as a value.
   *
   * Resolved by the VERB from the launch environment (SPEC.md §11.1 invariant
   * 7: configuration is never loaded implicitly from the working tree).
   * Nothing under `src/channels/` reads `process.env`, here as everywhere.
   */
  secret: string;
  /** The path to answer. Defaults to {@link TELEGRAM_WEBHOOK_DEFAULT_PATH}. */
  path?: string;
  /** Interface to bind. Defaults to loopback; the CLI owns any widening. */
  host?: string;
  /** TCP port. `0` asks the kernel for an ephemeral one, which is what tests use. */
  port?: number;
  /** Where operational complaints go. Defaults to stderr. */
  log?: (message: string) => void;
  /**
   * Run after each update the channel accepted (APRV-424).
   *
   * This is where the runtime's dispatch cycle goes, and it is the webhook's
   * equivalent of the listener's `beforePoll`: the channel holds
   * no queue and reads no log, so putting the next pending request on the
   * phone after a tap is the caller's job. It MUST NOT throw; a rejection is
   * complained about and swallowed, because a dispatch that failed must not
   * turn an answered tap into an unanswered request.
   */
  afterUpdate?: (result: TelegramPollResult) => Promise<void> | void;
}

export interface TelegramWebhookHandle {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  stats(): TelegramWebhookStats;
  /** Run `work` behind the same queue update delivery uses. */
  serialize<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function emptyRefusals(): Record<TelegramWebhookRefusalCode, number> {
  return {
    "webhook-secret-mismatch": 0,
    "webhook-duplicate-secret-header": 0,
    "webhook-unknown-path": 0,
    "webhook-method-not-allowed": 0,
    "webhook-body-too-large": 0,
    "webhook-body-unreadable": 0,
    "webhook-not-an-update": 0,
    "webhook-transport-conflict": 0,
    "webhook-handler-failed": 0,
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Is `offered` the registered secret?
 *
 * Both sides are hashed first, so the comparison is over two equal-length
 * buffers and `timingSafeEqual` can never throw — which is what keeps the
 * length of the real secret out of the answer.
 */
export function secretMatches(expected: string, offered: string | null): boolean {
  if (offered === null) return false;
  return timingSafeEqual(digest(expected), digest(offered));
}

/**
 * The one secret header a request offered, `null` for none, and `"duplicate"`
 * for more than one.
 *
 * Read off `rawHeaders` rather than `headers`, because Node joins repeats of a
 * non-special header into one comma-separated value and the join is exactly
 * what hides the second one.
 */
export function secretHeaderOf(rawHeaders: readonly string[]): string | null | "duplicate" {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (name !== undefined && name.toLowerCase() === TELEGRAM_SECRET_HEADER) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length === 0) return null;
  if (values.length > 1) return "duplicate";
  return values[0] ?? "";
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; code: TelegramWebhookRefusalCode; message: string };

/** Read one request body, bounded, draining an oversized one before refusing. */
async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const tooLarge: BodyRead = {
    ok: false,
    code: "webhook-body-too-large",
    message: `request body exceeds ${String(TELEGRAM_WEBHOOK_MAX_BODY_BYTES)} bytes`,
  };
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
        // Discarded as it arrives rather than returned here: a response
        // written while the client is still uploading closes the socket under
        // it, and a caller that got a transport error has no refusal to read.
        // Bounded twice over — past the drain limit the socket is simply
        // dropped, because a caller that streams forever is not owed a polite
        // answer.
        oversized = true;
        chunks.length = 0;
        if (size > TELEGRAM_WEBHOOK_DRAIN_LIMIT_BYTES) {
          req.destroy();
          break;
        }
        continue;
      }
      chunks.push(buffer);
    }
    if (oversized) return tooLarge;
  } catch (cause) {
    if (oversized) return tooLarge;
    return {
      ok: false,
      code: "webhook-body-unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Start the receiver. Resolves once it is bound and its real port is known;
 * rejects when the bind fails, so the verb can report it and exit.
 *
 * The channel's transport is claimed BEFORE the listener exists, for the
 * reason `approval serve` settles its credentials first: a server that bound
 * and then discovered it could not receive would be a server Telegram had
 * already posted to.
 */
export async function serveTelegramWebhook(
  options: TelegramWebhookOptions,
): Promise<TelegramWebhookHandle> {
  const claim = options.channel.claimTransport("webhook");
  if (!claim.ok) throw new Error(claim.message);

  const path = options.path ?? TELEGRAM_WEBHOOK_DEFAULT_PATH;
  const host = options.host ?? TELEGRAM_WEBHOOK_DEFAULT_HOST;
  const complain =
    options.log ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });

  const stats: TelegramWebhookStats = { requests: 0, updates: 0, refusals: emptyRefusals() };
  const sockets = new Set<Socket>();
  let closing = false;

  // One update at a time, for the reason the module doc gives: `handleUpdate`
  // holds a single ack slot and the delivery maps are not reentrant. A plain
  // promise chain, because the ordering wanted is arrival order and nothing
  // cleverer.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
    res.end(bytes);
  }

  /**
   * A refusal: counted, said on stderr, and answered with its code.
   *
   * Never an event. See the module doc: an unauthenticated endpoint that could
   * append would be an endpoint anybody could use to pad the log.
   */
  function refuse(
    res: ServerResponse,
    status: number,
    code: TelegramWebhookRefusalCode,
    message: string,
  ): void {
    stats.refusals[code] += 1;
    complain(`approval: telegram webhook refused a post (${code}): ${message}`);
    send(res, status, { error: { code, message } });
  }

  const http: Server = createServer((req, res) => {
    void (async () => {
      stats.requests += 1;
      try {
        // THE SECRET FIRST, before the path, the method or the body. A caller
        // without it learns only that something refused: no path is confirmed
        // to exist, no method is named, and no body is read off the socket.
        const offered = secretHeaderOf(req.rawHeaders);
        if (offered === "duplicate") {
          refuse(
            res,
            401,
            "webhook-duplicate-secret-header",
            `this request carries more than one ${TELEGRAM_SECRET_HEADER} header. Exactly one is accepted: where there are several, the one this server would check is not the one a reader of the request would name`,
          );
          return;
        }
        if (!secretMatches(options.secret, offered)) {
          refuse(
            res,
            401,
            "webhook-secret-mismatch",
            offered === null
              ? `no ${TELEGRAM_SECRET_HEADER} header. Every delivery Telegram makes to this URL carries the secret_token the runtime registered; a post without it decides nothing, and is counted and reported here as a refusal rather than written to the log`
              : `the ${TELEGRAM_SECRET_HEADER} header is not the registered secret_token. No decision reached the gate, and nothing was appended`,
          );
          return;
        }

        let url: URL;
        try {
          url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
        } catch {
          refuse(
            res,
            400,
            "webhook-unknown-path",
            "the request line and Host header do not form a URL this server can parse",
          );
          return;
        }
        if (url.pathname !== path) {
          refuse(res, 404, "webhook-unknown-path", `no endpoint at ${url.pathname}`);
          return;
        }
        const method = req.method ?? "GET";
        if (method !== "POST") {
          refuse(
            res,
            405,
            "webhook-method-not-allowed",
            `${path} answers POST, not ${method}`,
          );
          return;
        }

        const body = await readBody(req);
        if (!body.ok) {
          refuse(res, body.code === "webhook-body-too-large" ? 413 : 400, body.code, body.message);
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body.text);
        } catch (cause) {
          refuse(
            res,
            400,
            "webhook-body-unreadable",
            `request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          refuse(
            res,
            400,
            "webhook-not-an-update",
            "request body is not a Telegram Update object",
          );
          return;
        }

        // Handled BEFORE the response, deliberately. Telegram retries a
        // delivery it got no 2xx for, and answering first would mean the retry
        // raced the gate rather than finding a decided request; the redelivery
        // that does happen is refused `already-decided` with the first human
        // answer standing.
        let result: TelegramPollResult;
        try {
          result = await serialize(async () => {
            const handled = await options.channel.deliverUpdate(parsed);
            stats.updates += handled.updates;
            if (options.afterUpdate !== undefined) {
              try {
                await options.afterUpdate(handled);
              } catch (cause) {
                complain(
                  `approval: telegram webhook: the dispatch cycle after an update failed (${
                    cause instanceof Error ? cause.message : String(cause)
                  }); the update was handled and the listener is still up`,
                );
              }
            }
            return handled;
          });
        } catch (cause) {
          // The channel threw. Whatever the gate appended has already
          // happened, so this says where to look rather than what happened —
          // the wording `TELEGRAM_HANDLER_FAILED` uses, for the same reason.
          const message = cause instanceof Error ? cause.message : String(cause);
          // `in` rather than a property read, so a thrown null or a thrown
          // string cannot turn this diagnostic into a second failure.
          const conflict =
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            (cause as { code: unknown }).code === "transport-conflict";
          refuse(
            res,
            conflict ? 409 : 500,
            conflict ? "webhook-transport-conflict" : "webhook-handler-failed",
            message,
          );
          return;
        }

        send(res, 200, {
          ok: true,
          updates: result.updates,
          decisions: result.outcomes.length,
          ignored: result.ignored.length,
        });
      } catch (cause) {
        if (!res.headersSent) {
          refuse(
            res,
            500,
            "webhook-handler-failed",
            `the request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } else {
          res.end();
        }
      }
    })();
  });

  http.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((settle, fail) => {
    const onError = (cause: Error): void => fail(cause);
    http.once("error", onError);
    http.listen(options.port ?? TELEGRAM_WEBHOOK_DEFAULT_PORT, host, () => {
      http.off("error", onError);
      settle();
    });
  });

  const address = http.address();
  const boundPort =
    typeof address === "object" && address !== null
      ? address.port
      : (options.port ?? TELEGRAM_WEBHOOK_DEFAULT_PORT);
  const boundHost = typeof address === "object" && address !== null ? address.address : host;

  return {
    host: boundHost,
    port: boundPort,
    path,
    stats: () => ({ ...stats, refusals: { ...stats.refusals } }),
    serialize,
    close: async () => {
      if (closing) return;
      closing = true;
      await new Promise<void>((settle) => {
        http.close(() => settle());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
  };
}
