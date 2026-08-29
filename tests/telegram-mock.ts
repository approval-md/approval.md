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
 * `allowed_updates` IS honoured, and it earns its place (APRV-74): an update
 * whose type is not in the list is neither returned nor consumed, exactly as
 * the real API behaves. `approval setup channel telegram` reads with
 * `allowed_updates: ["message"]` and no offset precisely so that a running
 * listener's pending `callback_query` is untouched, and consume-on-delivery
 * means this mock can PROVE that — the callback is still in the queue after
 * setup has run, and a later poll still receives it. Without the filter the
 * mock would hand setup a callback it never asked for and swallow it, which
 * would be the mock inventing the bug the test is there to rule out.
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
  /**
   * How many queued updates are still undelivered.
   *
   * Consume-on-delivery makes this a direct assertion about what a later poll
   * will receive: a `callback_query` still counted here after
   * `approval setup channel telegram` has run is a callback the listener will still
   * get (APRV-74).
   */
  pendingUpdateCount(): number;
  /** Inject a failure mode for every subsequent call, or `null` to behave. */
  fail(mode: MockFailure | null): void;
  /**
   * What `getWebhookInfo` answers (APRV-96).
   *
   * `approval setup channel telegram` asks for it on ONE path only: when no
   * message arrived before its deadline, so that the refusal can say whether a
   * webhook is swallowing the updates and how many Telegram is still holding.
   * Both fields are settable because the two facts the operator needs are
   * exactly the two an unconfigured mock cannot invent: `url` defaults to `""`
   * (no webhook, which is the real default for a bot) and `pendingUpdateCount`
   * defaults to whatever is still queued here.
   */
  setWebhookInfo(info: { url?: string; pendingUpdateCount?: number }): void;
  /** The `callback_data` of the Approve/Reject button delivered for `actionKey`. */
  callbackDataFor(actionKey: string, decision: "grant" | "reject"): string;
  /**
   * The `callback_data` of the most recent digest's "all" button (APRV-115).
   *
   * A digest keyboard is one row per open member plus a trailing all-row, and
   * the all-row is the one whose labels say "all". Nothing here decodes a
   * nonce: the mock reads the buttons exactly as a phone would.
   */
  digestAllDataFor(decision: "grant" | "reject"): string;
  /** Every `text` the bot has sent, in order. */
  sentTexts(): string[];
  /** Every `answerCallbackQuery` text, in order. */
  answerTexts(): string[];
  /**
   * Every `editMessageText` the bot has issued, in order (APRV-106).
   *
   * `replyMarkup` is what a test asserts on to prove the buttons went away:
   * the real Bot API replaces the markup with whatever the edit carries, so
   * `undefined` here means the message no longer offers a decision.
   */
  edits(): { messageId: number; text: string; replyMarkup: unknown }[];
  /** Kill the server mid-flight: destroy every socket, then close. */
  kill(): Promise<void>;
  /** Listen again on the same port. */
  restart(): Promise<void>;
  /** Shut down for good. */
  close(): Promise<void>;
}

/**
 * The member number a digest gives `actionKey`, or `null` when `text` is not a
 * digest that lists it (APRV-115).
 *
 * A digest lists its members as `<n>. <code>key</code> — …`. Matched by string
 * search rather than by a built regular expression, because an action key
 * carries `:` and whatever else a task id contains.
 */
function digestNumberOf(text: string, actionKey: string): number | null {
  for (const line of text.split("\n")) {
    const marker = line.indexOf(`. <code>${actionKey}</code>`);
    if (marker <= 0) continue;
    const number = Number.parseInt(line.slice(0, marker), 10);
    if (Number.isInteger(number)) return number;
  }
  return null;
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
  let webhook: { url?: string; pendingUpdateCount?: number } = {};
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

    // The identity read `approval doctor` uses (APRV-31). Added to the mock
    // rather than to any production file: nothing in the channel calls it, and
    // doctor's probe must be exercised against loopback like everything else.
    if (method === "getMe") {
      send(response, {
        ok: true,
        result: { id: 424_242, is_bot: true, username: "approval_md_test_bot" },
      });
      return;
    }

    // The give-up diagnosis `approval setup channel telegram` prints (APRV-96).
    // A real getWebhookInfo answers whether a webhook is set and how many
    // updates are waiting; both are facts the mock has or can be told.
    if (method === "getWebhookInfo") {
      send(response, {
        ok: true,
        result: {
          url: webhook.url ?? "",
          has_custom_certificate: false,
          pending_update_count: webhook.pendingUpdateCount ?? queued.length,
        },
      });
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

    // APRV-106: the withdrawal edit. The real Bot API replaces the reply markup
    // along with the text, so a request that carries no `reply_markup` clears
    // the buttons — which is exactly the property the channel relies on to
    // annotate and disarm in one call. The mock answers with the edited message
    // and CARRIES NO reply_markup back, so a test can assert the buttons are
    // gone rather than assuming they are.
    if (method === "editMessageText") {
      send(response, {
        ok: true,
        result: {
          message_id: Number(body["message_id"]),
          chat: { id: Number(body["chat_id"]) },
          text: body["text"],
        },
      });
      return;
    }

    if (method === "getUpdates") {
      const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
      const timeoutSeconds = typeof body["timeout"] === "number" ? body["timeout"] : 0;
      const allowed = Array.isArray(body["allowed_updates"])
        ? new Set((body["allowed_updates"] as unknown[]).map((entry) => String(entry)))
        : null;

      /** An update's TYPE is its one key besides `update_id`. */
      const typeOf = (update: Record<string, unknown>): string =>
        Object.keys(update).find((key) => key !== "update_id") ?? "unknown";

      const take = (): { update_id: number }[] => {
        const ready = queued.filter(
          (entry) =>
            entry.update_id >= offset &&
            (allowed === null || allowed.has(typeOf(entry.update))),
        );
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
    // Node's default 5s keep-alive idle close races undici's socket reuse:
    // when a test pauses longer than the window between two calls (a GC pause
    // in the APRV-135 long-run test on a slow runner is enough), the server
    // closes the socket as fetch reuses it and the call dies with
    // "fetch failed" (#142). The mock holds sockets open for its whole life;
    // close() destroys every tracked socket, so nothing leaks.
    created.keepAliveTimeout = 0;
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
    pendingUpdateCount() {
      return queued.length;
    },
    setWebhookInfo(info) {
      webhook = { ...info };
    },
    fail(mode) {
      failure = mode;
      if (mode === null) {
        for (const response of held) response.destroy();
        held.clear();
      }
    },
    callbackDataFor(actionKey, decision) {
      // Two shapes reach a phone, and this reads both the way a phone would.
      //
      // A single prompt: the header naming the action key, then the payload
      // chunks, and the LAST message carries the keyboard. So walk forward,
      // remember whose header was seen last, and take the keyboard that
      // follows it.
      //
      // A digest (APRV-115): the buttons are on a message that names every
      // member itself, as numbered lines, and the buttons are labelled with
      // the same numbers. So a keyboard message that lists the action key
      // answers for itself, and the row is found by that label.
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
        if (markup === undefined) continue;
        const rows = markup.inline_keyboard ?? [];

        const numbered = digestNumberOf(text, actionKey);
        if (numbered !== null) {
          const label = decision === "grant" ? `✅ Approve ${numbered}` : `🛑 Reject ${numbered}`;
          for (const row of rows) {
            const button = row.find((candidate) => candidate.text === label);
            if (button !== undefined) found = button.callback_data;
          }
          continue;
        }

        if (current !== actionKey) continue;
        const row = rows[0] ?? [];
        const button = decision === "grant" ? row[0] : row[1];
        if (button !== undefined) found = button.callback_data;
      }
      assert.ok(
        found !== null,
        `the mock received no keyboard for ${JSON.stringify(actionKey)}`,
      );
      return found;
    },
    digestAllDataFor(decision) {
      const prefix = decision === "grant" ? "✅ Approve all" : "🛑 Reject all";
      let found: string | null = null;
      for (const entry of requests) {
        if (entry.method !== "sendMessage" && entry.method !== "editMessageText") continue;
        const markup = entry.body["reply_markup"] as
          | { inline_keyboard?: { text: string; callback_data: string }[][] }
          | undefined;
        for (const row of markup?.inline_keyboard ?? []) {
          const button = row.find((candidate) => candidate.text.startsWith(prefix));
          if (button !== undefined) found = button.callback_data;
        }
      }
      assert.ok(found !== null, "the mock received no digest all-button");
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
    edits() {
      return requests
        .filter((entry) => entry.method === "editMessageText")
        .map((entry) => ({
          messageId: Number(entry.body["message_id"]),
          text: String(entry.body["text"] ?? ""),
          replyMarkup: entry.body["reply_markup"],
        }));
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

/**
 * A `message` update, as Telegram would deliver one (APRV-74).
 *
 * `approval setup channel telegram` discovers the approver chat by reading the `chat`
 * of a message the human just sent, so the shape that matters here is
 * `message.chat`: an id, a type, and whichever of title / username / first_name
 * the chat carries. Groups have a title; a private chat has a username, or only
 * a first name for a user who set none.
 */
export function messageUpdate(options: {
  chatId: string | number;
  type?: string;
  text?: string;
  username?: string;
  firstName?: string;
  title?: string;
}): Record<string, unknown> {
  const chat: Record<string, unknown> = {
    id: options.chatId,
    type: options.type ?? "private",
  };
  if (options.title !== undefined) chat["title"] = options.title;
  if (options.username !== undefined) chat["username"] = options.username;
  if (options.firstName !== undefined) chat["first_name"] = options.firstName;
  return {
    message: {
      message_id: 1,
      from: { id: 42, is_bot: false, username: options.username ?? "approver" },
      chat,
      date: 1_700_000_000,
      text: options.text ?? "hello",
    },
  };
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
