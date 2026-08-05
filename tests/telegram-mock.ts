/**
 * A local mock Bot API server (APRV-26).
 *
 * The Telegram channel is exercised end to end — sendMessage, long-polled
 * getUpdates, answerCallbackQuery, and every failure mode the listener claims
 * to survive — against this `node:http` server on 127.0.0.1. **No test in this
 * repository contacts the real network**, and `assertLocal()` is called by the
 * suite on every `apiBase` it hands to a channel so that stays true by
 * assertion and not by good intentions.
 *
 * Where it deliberately differs from the real Bot API: an update is *consumed*
 * when it is delivered, rather than being retained until a later `offset`
 * acknowledges it. Real Telegram's retention exists so a crashed client can
 * re-fetch; here it would only mean one test's queued callback leaking into the
 * next test's freshly-constructed channel (which starts at offset 0). The
 * offset is still honoured for filtering, so the channel's own offset
 * arithmetic is still exercised.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

/** The failure modes the mock can inject. */
export type MockFailure =
  /** Accept the request and never answer it. The client's own timeout fires. */
  | "timeout"
  /** Destroy the socket mid-request. */
  | "drop"
  /** Answer 500. */
  | "500"
  /** Answer 200 with something that is not JSON. */
  | "malformed";

/** One request the mock received, recorded verbatim. */
export interface MockRequest {
  /** The full path, which for the Bot API is where the token lives. */
  path: string;
  /** The Bot API method name (`sendMessage`, `getUpdates`, …). */
  method: string;
  /** The raw request body, exactly as it arrived. */
  raw: string;
  /** The parsed body, or `{}` when it did not parse. */
  body: Record<string, unknown>;
}

interface Waiter {
  resolve(): void;
  timer: NodeJS.Timeout;
}

export interface MockBotApi {
  /** `http://127.0.0.1:<port>` — what to pass as `apiBase`. */
  readonly url: string;
  readonly port: number;
  /** Every request received, in order, across restarts. */
  readonly requests: MockRequest[];
  /** Queue an update for the next `getUpdates`. */
  queueUpdate(update: Record<string, unknown>): void;
  /** Inject a failure mode for every subsequent call, or `null` to behave. */
  fail(mode: MockFailure | null): void;
  /** The `callback_data` of the Approve/Reject button delivered for `actionKey`. */
  callbackDataFor(actionKey: string, decision: "grant" | "reject"): string;
  /** Every `text` the bot has sent, in order. */
  sentTexts(): string[];
  /** Every `answerCallbackQuery` text, in order. */
  answerTexts(): string[];
  /** Kill the server mid-flight: destroy every socket, then close. */
  kill(): Promise<void>;
  /** Listen again on the same port. */
  restart(): Promise<void>;
  /** Shut down for good. */
  close(): Promise<void>;
}

/** A test's `apiBase` points at loopback. Called before every channel is built. */
export function assertLocal(apiBase: string): string {
  assert.match(
    apiBase,
    /^http:\/\/(127\.0\.0\.1|localhost):\d+$/u,
    `tests must never contact the real Bot API; apiBase was ${JSON.stringify(apiBase)}`,
  );
  return apiBase;
}

export async function startMockBotApi(token: string): Promise<MockBotApi> {
  const requests: MockRequest[] = [];
  const queued: { update_id: number; update: Record<string, unknown> }[] = [];
  const waiters = new Set<Waiter>();
  const sockets = new Set<Socket>();
  const held = new Set<ServerResponse>();
  let updateId = 1000;
  let messageId = 500;
  let failure: MockFailure | null = null;
  let server: Server;
  let port = 0;

  function wake(): void {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    waiters.clear();
  }

  function send(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    const path = request.url ?? "";
    const method = path.slice(path.lastIndexOf("/") + 1);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      /* recorded raw either way */
    }
    requests.push({ path, method, raw, body });

    if (failure === "drop") {
      request.socket.destroy();
      return;
    }
    if (failure === "500") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("mock: internal server error");
      return;
    }
    if (failure === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"result":[  <- not JSON');
      return;
    }
    if (failure === "timeout") {
      // Accepted and never answered: the client's own transport timeout is the
      // only thing that ends this, which is the point of the mode.
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }

    if (!path.startsWith(`/bot${token}/`)) {
      send(response, { ok: false, description: "Unauthorized: bad token" });
      return;
    }

    if (method === "sendMessage") {
      messageId += 1;
      send(response, {
        ok: true,
        result: {
          message_id: messageId,
          chat: { id: Number(body["chat_id"]) },
          text: body["text"],
        },
      });
      return;
    }

    if (method === "answerCallbackQuery") {
      send(response, { ok: true, result: true });
      return;
    }

    if (method === "getUpdates") {
      const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
      const timeoutSeconds = typeof body["timeout"] === "number" ? body["timeout"] : 0;

      const take = (): { update_id: number }[] => {
        const ready = queued.filter((entry) => entry.update_id >= offset);
        for (const entry of ready) queued.splice(queued.indexOf(entry), 1);
        return ready.map((entry) => ({ update_id: entry.update_id, ...entry.update }));
      };

      const first = take();
      if (first.length > 0) {
        send(response, { ok: true, result: first });
        return;
      }

      // The long poll: hold until an update is queued or the timeout elapses.
      await new Promise<void>((resolve) => {
        const waiter: Waiter = {
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            resolve();
          }, Math.max(10, timeoutSeconds * 1000)),
        };
        waiters.add(waiter);
        response.on("close", () => {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          resolve();
        });
      });
      if (response.writableEnded || response.destroyed) return;
      send(response, { ok: true, result: take() });
      return;
    }

    send(response, { ok: false, description: `mock: unknown method ${method}` });
  }

  function build(): Server {
    const created = createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("mock: handler threw");
        }
      });
    });
    created.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    return created;
  }

  async function listen(desired: number): Promise<void> {
    server = build();
    await new Promise<void>((resolve) => {
      server.listen(desired, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  }

  await listen(0);

  const api: MockBotApi = {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    requests,
    queueUpdate(update) {
      updateId += 1;
      queued.push({ update_id: updateId, update });
      wake();
    },
    fail(mode) {
      failure = mode;
      if (mode === null) {
        for (const response of held) response.destroy();
        held.clear();
      }
    },
    callbackDataFor(actionKey, decision) {
      // Messages are sent in order: the header naming the action key, then the
      // payload chunks, and the LAST message of a request carries the keyboard.
      // So walk forward, remember whose header we last saw, and take the
      // keyboard that follows it.
      let current: string | null = null;
      let found: string | null = null;
      for (const entry of requests) {
        if (entry.method !== "sendMessage") continue;
        const text = typeof entry.body["text"] === "string" ? entry.body["text"] : "";
        const match = /<code>([^<]+)<\/code>/u.exec(text);
        if (text.includes("APPROVAL REQUIRED") && match !== null) current = match[1] ?? null;
        const markup = entry.body["reply_markup"] as
          | { inline_keyboard?: { text: string; callback_data: string }[][] }
          | undefined;
        if (markup === undefined || current !== actionKey) continue;
        const row = markup.inline_keyboard?.[0] ?? [];
        const button = decision === "grant" ? row[0] : row[1];
        if (button !== undefined) found = button.callback_data;
      }
      assert.ok(
        found !== null,
        `the mock received no keyboard for ${JSON.stringify(actionKey)}`,
      );
      return found;
    },
    sentTexts() {
      return requests
        .filter((entry) => entry.method === "sendMessage")
        .map((entry) => String(entry.body["text"] ?? ""));
    },
    answerTexts() {
      return requests
        .filter((entry) => entry.method === "answerCallbackQuery")
        .map((entry) => String(entry.body["text"] ?? ""));
    },
    async kill() {
      wake();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    async restart() {
      await listen(port);
    },
    async close() {
      failure = null;
      for (const response of held) response.destroy();
      held.clear();
      wake();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };

  return api;
}

/** A `callback_query` update, as Telegram would deliver one. */
export function callbackUpdate(options: {
  data: string;
  chatId: string | number;
  id?: string;
  from?: string;
}): Record<string, unknown> {
  return {
    callback_query: {
      id: options.id ?? `cb-${Math.random().toString(36).slice(2, 10)}`,
      from: { id: 42, username: options.from ?? "approver" },
      message: { message_id: 1, chat: { id: options.chatId } },
      data: options.data,
    },
  };
}
