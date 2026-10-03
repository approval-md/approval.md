/**
 * The authenticated relay channel: its HTTP receiver (SPEC.md §10.3, APRV-455).
 *
 * The sibling of `channels/telegram-webhook.ts`, and deliberately the same
 * shape: one header, one path, one method, one bounded body, a loopback bind by
 * default with the operator's proxy terminating TLS, a refusal carried as a
 * body with a frozen code, and no refusal ever written to the log. What differs
 * is what arrives. A Telegram delivery is an Update the channel parses; a relay
 * post is a gesture whose shape `channels/relay.ts` closes, whose freshness and
 * nonce this file checks, and which `applyRelayGesture` turns into a log event
 * through `recordChannelDecision`, the one place a reported gesture becomes one.
 *
 * ## The secret first
 *
 * `x-approval-relay-secret` is compared before the URL is parsed, the method is
 * read or a byte of the body is consumed. A caller without it learns only that
 * something refused. The comparison is over SHA-256 digests under
 * `timingSafeEqual`, constant-time and length-independent, and a request
 * carrying the header twice is refused rather than resolved, because Node joins
 * repeats and the value compared would not be the value a reader names. These
 * are the webhook's three rules, for the webhook's reasons.
 *
 * ## Why this is its own port and its own secret
 *
 * `approval serve` answers two bearer credentials, the agent's and the
 * tenant's, and NEITHER may reach a decision: grant, reject and attest are
 * human-only verbs that serve does not publish. This receiver answers a third
 * credential held by a third party (the operator's control plane), and it is
 * reachable only from the process `approval channel relay` starts. Nothing in
 * `src/serve/` or `src/mcp/` imports this module, the verb registry marks the
 * verb `human_only` so no wrapper publishes it, and `tests/channel-relay.test.ts`
 * pins both.
 *
 * ## Replay
 *
 * Every gesture carries a nonce and an `issued_at`. The nonce is claimed in a
 * ledger of exclusively linked files under the gate's `daemon/` directory before the
 * gesture is applied, so a replayed post is refused `relay-nonce-replayed`
 * whether it arrives at this process, after its restart, or at a second relay
 * on the same gate; a post older than the window is refused
 * `relay-gesture-stale` after the ledger has forgotten it. The gate is the
 * belt: a decision a replay did reach would be refused `already-decided`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  RELAY_DEFAULT_HOST,
  RELAY_DEFAULT_PORT,
  RELAY_DRAIN_LIMIT_BYTES,
  RELAY_MAX_BODY_BYTES,
  RELAY_PATH,
  RELAY_REFUSAL_CODES,
  RELAY_SECRET_HEADER,
  applyRelayGesture,
  parseRelayGesture,
  relayGestureFresh,
  relayRefusal,
  type ApplyRelayOptions,
  type NonceLedger,
  type RelayRefusalCode,
  type RelayResponse,
} from "./relay.js";

/** How long {@link RelayHandle.close} waits for requests in flight. */
export const RELAY_CLOSE_TIMEOUT_MS = 10_000;

/** What this receiver has done since it bound. Counters, never decisions. */
export interface RelayStats {
  requests: number;
  /** Gestures handed to the gate, accepted or refused there. */
  gestures: number;
  refusals: Record<RelayRefusalCode, number>;
}

export interface RelayServerOptions extends ApplyRelayOptions {
  /** The log every gesture is recorded in. */
  logPath: string;
  /**
   * The shared secret, as a value. Resolved by the VERB from the launch
   * environment (SPEC.md §11.1 invariant 7); nothing under `src/channels/`
   * reads `process.env`.
   */
  secret: string;
  /** Where claimed nonces are remembered. */
  ledger: NonceLedger;
  host?: string;
  /** `0` asks the kernel for an ephemeral port, which is what tests use. */
  port?: number;
  /** The clock freshness is judged against, in epoch ms. Injectable for tests. */
  now?: () => number;
  /** Where operational complaints go. Defaults to stderr. */
  log?: (message: string) => void;
  /** Called after each gesture that reached the gate, with its response. Must not throw. */
  afterGesture?: (response: RelayResponse) => void;
  closeTimeoutMs?: number;
}

export interface RelayHandle {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  stats(): RelayStats;
  inFlight(): number;
  /** Stop accepting, let what is in flight finish, then drop the sockets. Idempotent. */
  close(): Promise<void>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Is `offered` the secret? Constant-time over equal-length digests. */
export function relaySecretMatches(expected: string, offered: string | null): boolean {
  if (offered === null) return false;
  return timingSafeEqual(digest(expected), digest(offered));
}

/** The one secret header offered, `null` for none, `"duplicate"` for more than one. */
export function relaySecretHeaderOf(rawHeaders: readonly string[]): string | null | "duplicate" {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (name !== undefined && name.toLowerCase() === RELAY_SECRET_HEADER) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length === 0) return null;
  if (values.length > 1) return "duplicate";
  return values[0] ?? "";
}

type BodyRead = { ok: true; text: string } | { ok: false; code: RelayRefusalCode; message: string };

async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const tooLarge: BodyRead = {
    ok: false,
    code: "relay-body-too-large",
    message: `request body exceeds ${String(RELAY_MAX_BODY_BYTES)} bytes`,
  };
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > RELAY_MAX_BODY_BYTES) {
        // Drained rather than answered mid-upload, for the webhook's reason: a
        // response written while the client is still writing closes the socket
        // under it, and the caller sees a transport error instead of a code.
        oversized = true;
        chunks.length = 0;
        if (size > RELAY_DRAIN_LIMIT_BYTES) {
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
      code: "relay-body-unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function emptyRefusals(): Record<RelayRefusalCode, number> {
  const counts = {} as Record<RelayRefusalCode, number>;
  for (const code of RELAY_REFUSAL_CODES) counts[code] = 0;
  return counts;
}

/** Start the receiver. Resolves once bound; rejects when the bind fails. */
export async function serveRelay(options: RelayServerOptions): Promise<RelayHandle> {
  const host = options.host ?? RELAY_DEFAULT_HOST;
  const now = options.now ?? ((): number => Date.now());
  const complain =
    options.log ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });
  const stats: RelayStats = { requests: 0, gestures: 0, refusals: emptyRefusals() };
  const sockets = new Set<Socket>();
  let inFlight = 0;
  let closed: Promise<void> | null = null;

  function send(res: ServerResponse, response: RelayResponse): void {
    const bytes = Buffer.from(JSON.stringify(response.body), "utf8");
    res.writeHead(response.status, {
      "content-type": "application/json",
      "content-length": bytes.length,
      "cache-control": "no-store",
    });
    res.end(bytes);
  }

  /** Counted, said on stderr, answered with its code. Never an event. */
  function refuse(res: ServerResponse, status: number, code: RelayRefusalCode, message: string): void {
    stats.refusals[code] += 1;
    complain(`approval: relay refused a post (${code}): ${message}`);
    send(res, relayRefusal(status, code, message));
  }

  const http: Server = createServer((req, res) => {
    void (async () => {
      stats.requests += 1;
      inFlight += 1;
      try {
        const offered = relaySecretHeaderOf(req.rawHeaders);
        if (offered === "duplicate") {
          refuse(
            res,
            401,
            "relay-duplicate-secret-header",
            `this request carries more than one ${RELAY_SECRET_HEADER} header; exactly one is accepted`,
          );
          return;
        }
        if (!relaySecretMatches(options.secret, offered)) {
          refuse(
            res,
            401,
            "relay-secret-mismatch",
            offered === null
              ? `no ${RELAY_SECRET_HEADER} header. A post without the relay's secret decides nothing and is not written to the log`
              : `the ${RELAY_SECRET_HEADER} header is not this relay's secret. Nothing reached the gate and nothing was appended`,
          );
          return;
        }

        let url: URL;
        try {
          url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
        } catch {
          refuse(res, 400, "relay-malformed-request", "the request line and Host header do not form a URL");
          return;
        }
        if (url.pathname !== RELAY_PATH) {
          refuse(res, 404, "relay-unknown-path", `no endpoint at ${url.pathname}; the relay answers ${RELAY_PATH}`);
          return;
        }
        const method = req.method ?? "GET";
        if (method !== "POST") {
          refuse(res, 405, "relay-method-not-allowed", `${RELAY_PATH} answers POST, not ${method}`);
          return;
        }

        const body = await readBody(req);
        if (!body.ok) {
          refuse(res, body.code === "relay-body-too-large" ? 413 : 400, body.code, body.message);
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(body.text);
        } catch (cause) {
          refuse(
            res,
            400,
            "relay-body-unreadable",
            `request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return;
        }
        const parsed = parseRelayGesture(decoded);
        if (!parsed.ok) {
          refuse(res, 400, parsed.code, parsed.message);
          return;
        }
        const gesture = parsed.gesture;

        const nowMs = now();
        if (!relayGestureFresh(gesture.issuedAtMs, nowMs)) {
          refuse(
            res,
            400,
            "relay-gesture-stale",
            `issued_at ${new Date(gesture.issuedAtMs).toISOString()} is more than five minutes from this relay's clock (${new Date(nowMs).toISOString()}); a gesture is carried while the person who made it is still there, and an old one is refused rather than honoured`,
          );
          return;
        }

        // Claimed BEFORE the gesture is applied, so a replay racing the
        // original loses at the file system rather than at the gate. A claim
        // that cannot be recorded fails closed: replay protection that could
        // not be promised is not offered as though it were.
        const claim = options.ledger.claim(gesture.nonce, nowMs);
        if (claim === "replayed") {
          refuse(
            res,
            409,
            "relay-nonce-replayed",
            "this nonce was already used. Each gesture carries its own; a retry is a new post with a new nonce, and the gate answers a repeated decision already-decided",
          );
          return;
        }
        if (claim !== "claimed") {
          refuse(
            res,
            503,
            "relay-nonce-unavailable",
            `the nonce ledger could not record this gesture (${claim.error}), so a replay of it could not be refused later; nothing was decided`,
          );
          return;
        }

        let response: RelayResponse;
        try {
          response = applyRelayGesture(options.logPath, gesture, options);
        } catch (cause) {
          refuse(
            res,
            500,
            "relay-handler-failed",
            `applying the gesture failed (${cause instanceof Error ? cause.message : String(cause)}); read the log for what, if anything, was appended`,
          );
          return;
        }
        stats.gestures += 1;
        if (options.afterGesture !== undefined) {
          try {
            options.afterGesture(response);
          } catch {
            // A reporting hook that throws must not turn an answered gesture
            // into a failed request.
          }
        }
        send(res, response);
      } catch (cause) {
        if (!res.headersSent) {
          refuse(
            res,
            500,
            "relay-handler-failed",
            `the request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } else {
          res.end();
        }
      } finally {
        inFlight -= 1;
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
    http.listen(options.port ?? RELAY_DEFAULT_PORT, host, () => {
      http.off("error", onError);
      settle();
    });
  });

  const address = http.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : (options.port ?? RELAY_DEFAULT_PORT);
  const boundHost = typeof address === "object" && address !== null ? address.address : host;

  async function stop(): Promise<void> {
    const accepted = new Promise<void>((settle) => {
      http.close(() => settle());
    });
    const deadline = Date.now() + (options.closeTimeoutMs ?? RELAY_CLOSE_TIMEOUT_MS);
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise<void>((settle) => {
        setTimeout(settle, 5).unref?.();
      });
    }
    if (inFlight > 0) {
      complain(`approval: relay: ${String(inFlight)} request(s) still in flight at the close deadline; closing anyway`);
    }
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await accepted;
  }

  return {
    host: boundHost,
    port: boundPort,
    path: RELAY_PATH,
    stats: () => ({ ...stats, refusals: { ...stats.refusals } }),
    inFlight: () => inFlight,
    close: () => {
      closed ??= stop();
      return closed;
    },
  };
}
