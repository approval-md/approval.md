/**
 * A local mock AgentMail API (APRV-222).
 *
 * The AgentMail adapter is exercised end to end — the inbox read, the direct
 * send, the draft read, the drift check and the draft send, plus every failure
 * mapping it claims — against this `node:http` server on 127.0.0.1. **No test in
 * this repository contacts the real AgentMail API**, and {@link assertLocal} is
 * called on every `apiBase` the suite hands to an adapter so that stays true by
 * assertion and not by good intentions.
 *
 * The mock is deliberately literal about two things the suite asserts on:
 *
 * - **Every request is recorded**, method and path included, so a test can
 *   prove a refusal sent NOTHING by finding no POST in the log. "It refused" and
 *   "it refused before acting" are different claims, and only the second one is
 *   worth having.
 * - **A planted secret is served verbatim.** {@link MockAgentmail.fail} takes a
 *   whole body, so a test can put the API key inside an error the far side
 *   returns and then assert the adapter's own message does not carry it
 *   (SPEC.md §11.1 invariant 3). A mock that sanitized its own error bodies
 *   would be testing the mock.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The routes the adapter uses, named so a test can fail exactly one.
 *
 * `messages-list` is APRV-245's read: `GET /v0/inboxes/{id}/messages`, which
 * `observeAgentmail` uses to ask what the inbox actually sent. It is a GET and
 * it is served here so that a test can prove the coverage read never POSTs.
 */
export type MockRoute = "inbox" | "message-send" | "messages-list" | "draft" | "draft-send";

/** One request the mock received, recorded verbatim. */
export interface MockAgentmailRequest {
  method: string;
  /** The full path, undecoded. */
  path: string;
  /** Which route it matched, or `null` for a path the mock does not serve. */
  route: MockRoute | null;
  /** The `authorization` header exactly as it arrived. */
  authorization: string;
  /** The raw body, exactly as it arrived. */
  raw: string;
  /** The parsed body, or `{}` when it did not parse. */
  body: Record<string, unknown>;
}

/** A canned answer: a status, and a body served byte for byte. */
export interface MockAnswer {
  status: number;
  body?: string;
}

export interface MockAgentmail {
  /** `http://127.0.0.1:<port>` — what to pass as `apiBase`. */
  readonly url: string;
  readonly port: number;
  /** Every request received, in order. */
  readonly requests: MockAgentmailRequest[];
  /** Every direct-send body accepted, in order. */
  sentMessages(): Record<string, unknown>[];
  /** Every draft id whose send was accepted, in order. */
  sentDrafts(): string[];
  /** Requests that matched `route`. */
  requestsFor(route: MockRoute): MockAgentmailRequest[];
  /** Every POST the mock saw, whatever it matched. The "nothing was sent" check. */
  posts(): MockAgentmailRequest[];
  /** What `GET /v0/inboxes/{id}` answers with. */
  setInbox(inbox: Record<string, unknown>): void;
  /**
   * What `GET /v0/inboxes/{id}/messages` answers with (APRV-245).
   *
   * The list is served VERBATIM, labels included and with no filtering by the
   * `after`/`before` query: the sent-only filter is the adapter's, so a mock
   * that applied it would be testing the mock. A test that wants a received
   * message in the answer puts one in with a label that is not `sent`.
   */
  setMessages(messages: Record<string, unknown>[]): void;
  /** Put a draft in the inbox, or replace one. */
  setDraft(draftId: string, draft: Record<string, unknown>): void;
  /** Remove a draft, so the next read 404s. */
  deleteDraft(draftId: string): void;
  /** Answer `answer` for every subsequent request on `route` (or all of them). */
  fail(answer: MockAnswer | null, route?: MockRoute): void;
  close(): Promise<void>;
}

/** A test's `apiBase` points at loopback. Called before every adapter is built. */
export function assertLocal(apiBase: string): string {
  assert.match(
    apiBase,
    /^http:\/\/(127\.0\.0\.1|localhost):\d+$/u,
    `tests must never contact the real AgentMail API; apiBase was ${JSON.stringify(apiBase)}`,
  );
  return apiBase;
}

/** Split a path into decoded segments, dropping the empties. */
function segmentsOf(path: string): string[] {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

/**
 * Which route a request is on, by shape:
 * `/v0/inboxes/{id}`, `/v0/inboxes/{id}/messages/send`,
 * `/v0/inboxes/{id}/drafts/{draft}`, `/v0/inboxes/{id}/drafts/{draft}/send`.
 */
function routeOf(
  method: string,
  segments: string[],
): { route: MockRoute; inboxId: string; draftId?: string } | null {
  if (segments[0] !== "v0" || segments[1] !== "inboxes") return null;
  const inboxId = segments[2];
  if (inboxId === undefined) return null;
  if (segments.length === 3 && method === "GET") return { route: "inbox", inboxId };
  if (segments.length === 5 && segments[3] === "messages" && segments[4] === "send" && method === "POST") {
    return { route: "message-send", inboxId };
  }
  // `segmentsOf` has already dropped the query string, so the listing route
  // matches whatever `after`/`before`/`limit`/`page_token` the caller sent; the
  // recorded `request.path` keeps the query so a test can assert on it.
  if (segments.length === 4 && segments[3] === "messages" && method === "GET") {
    return { route: "messages-list", inboxId };
  }
  if (segments.length === 5 && segments[3] === "drafts" && method === "GET") {
    return { route: "draft", inboxId, draftId: segments[4] as string };
  }
  if (segments.length === 6 && segments[3] === "drafts" && segments[5] === "send" && method === "POST") {
    return { route: "draft-send", inboxId, draftId: segments[4] as string };
  }
  return null;
}

export async function startMockAgentmail(options: {
  /** The bearer token the mock accepts. Anything else is a 401. */
  apiKey: string;
  /** The inbox id it serves. Anything else is a 404. */
  inboxId: string;
  /** The address the inbox reports sending as. Defaults to the inbox id. */
  address?: string;
}): Promise<MockAgentmail> {
  const requests: MockAgentmailRequest[] = [];
  const messages: Record<string, unknown>[] = [];
  const draftSends: string[] = [];
  const drafts = new Map<string, Record<string, unknown>>();
  let listed: Record<string, unknown>[] = [];
  const failures = new Map<MockRoute | "any", MockAnswer>();
  let inbox: Record<string, unknown> = {
    inbox_id: options.inboxId,
    address: options.address ?? options.inboxId,
    display_name: "approval.md test inbox",
  };
  let messageId = 0;

  function json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    const path = request.url ?? "";
    const method = request.method ?? "GET";
    const segments = segmentsOf(path);
    const matched = routeOf(method, segments);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      /* recorded raw either way */
    }
    requests.push({
      method,
      path,
      route: matched?.route ?? null,
      authorization: String(request.headers["authorization"] ?? ""),
      raw,
      body,
    });

    // An injected answer wins over everything, including auth: the point of the
    // mode is to test what the adapter does with a status, not to reach it.
    const injected = failures.get(matched?.route ?? "any") ?? failures.get("any");
    if (injected !== undefined) {
      response.writeHead(injected.status, { "content-type": "application/json" });
      response.end(injected.body ?? "{}");
      return;
    }

    if (request.headers["authorization"] !== `Bearer ${options.apiKey}`) {
      json(response, 401, { message: "invalid api key" });
      return;
    }
    if (matched === null) {
      json(response, 404, { message: `no route for ${method} ${path}` });
      return;
    }
    if (matched.inboxId !== options.inboxId) {
      json(response, 404, { message: "no such inbox" });
      return;
    }

    if (matched.route === "inbox") {
      json(response, 200, inbox);
      return;
    }

    if (matched.route === "messages-list") {
      json(response, 200, { messages: listed });
      return;
    }

    if (matched.route === "message-send") {
      messages.push(body);
      messageId += 1;
      json(response, 200, {
        message_id: `msg_${String(messageId)}`,
        thread_id: `thr_${String(messageId)}`,
      });
      return;
    }

    const draftId = matched.draftId ?? "";
    const draft = drafts.get(draftId);
    if (draft === undefined) {
      json(response, 404, { message: "no such draft" });
      return;
    }
    if (matched.route === "draft") {
      json(response, 200, { draft_id: draftId, ...draft });
      return;
    }
    draftSends.push(draftId);
    messageId += 1;
    json(response, 200, {
      message_id: `msg_${String(messageId)}`,
      thread_id: `thr_${String(messageId)}`,
    });
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"message":"mock failed"}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    sentMessages: () => messages,
    sentDrafts: () => draftSends,
    requestsFor: (route: MockRoute) => requests.filter((entry) => entry.route === route),
    posts: () => requests.filter((entry) => entry.method === "POST"),
    setInbox(next: Record<string, unknown>): void {
      inbox = next;
    },
    setMessages(next: Record<string, unknown>[]): void {
      listed = next;
    },
    setDraft(draftId: string, draft: Record<string, unknown>): void {
      drafts.set(draftId, draft);
    },
    deleteDraft(draftId: string): void {
      drafts.delete(draftId);
    },
    fail(answer: MockAnswer | null, route: MockRoute | "any" = "any"): void {
      if (answer === null) failures.delete(route);
      else failures.set(route, answer);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
