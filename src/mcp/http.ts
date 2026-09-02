/**
 * `approval mcp serve --http` — the §10.5 wrapper over the MCP streamable-HTTP
 * transport, one session per connection (APRV-174).
 *
 * The stdio server of `./server.ts` serves ONE client through the pipe the
 * operator handed it: one process, one connection, one identity. This module
 * changes exactly one thing about that picture, the transport, and it changes it
 * so that several clients can be served at once. Everything else is the same
 * code: the tool list is still {@link createApprovalMcpServer}'s, a tool call
 * still builds an argv and calls the function the CLI dispatches to, and a
 * refusal is still the CLI's refusal.
 *
 * ## One `Server` + one transport per session
 *
 * The SDK's `StreamableHTTPServerTransport` is stateful per session: it mints an
 * `mcp-session-id` at `initialize`, stamps it on every response, and expects the
 * client to send it back. This module owns one `node:http` listener and a map
 * from that id to the `{ Server, transport, actor }` triple it belongs to. An
 * initialize POST with no session header opens a triple; every later request is
 * routed by the header; the triple is dropped when its transport closes (a
 * DELETE, or the socket going away).
 *
 * ## Identity is minted BEFORE the transport exists, per session
 *
 * `cli/mcp.ts` settles identity before it constructs the stdio transport,
 * because "a server that connected first and refused later would be a server a
 * client had already spoken to". That property is preserved verbatim here, once
 * per session: {@link mintSessionActor} runs before the `Server`/transport pair
 * is built, and its result is the `actor` that pair closes over for its whole
 * life.
 *
 * **Nothing a client sends reaches that actor.** There is no code path from a
 * header, a URL, an `initialize` payload's `clientInfo`, or a tool argument into
 * the identity a session runs as. `clientInfo.name` is a label a client chose
 * for itself, and SPEC.md §11 says a self-reported field never reduces scrutiny;
 * an identity a caller could name would be an identity a caller could escalate,
 * so the server names it:
 *
 * - plain `--http`: every session runs as the operator's own `--as` /
 *   `APPROVAL_AGENT` actor, which is the stdio behavior with more connections;
 * - `--guest`: every session mints its own `agent:guest-<6 hex>`, so the log,
 *   the budgets and the refusals see one stranger per connection rather than one
 *   crowd. That is the whole reason this scheme exists — an actor a limit can be
 *   keyed on.
 *
 * ## Loopback, caps, and no authentication whatsoever
 *
 * This listener authenticates nobody, exactly like `channels/web.ts`. It binds
 * `127.0.0.1` unless the operator writes another host out in full, and the CLI
 * prints a loud banner when they do; the deployment this was built for
 * (SPEC.md §10.5, the crowd demo) is a tunnel in front of a loopback bind, where
 * the tunnel is the thing that faces the network.
 *
 * Two caps bound what a stranger can spend: {@link MAX_CONCURRENT_SESSIONS} live
 * at once and {@link MAX_LIFETIME_SESSIONS} over the process's life. Over either
 * one, an initialize is refused with a plain HTTP 503 naming the reason, before
 * a session exists.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createApprovalMcpServer, serializer, type ServerPaths } from "./server.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Live sessions this listener will hold at once. */
export const MAX_CONCURRENT_SESSIONS = 20;

/** Sessions this listener will open over the life of the process. */
export const MAX_LIFETIME_SESSIONS = 200;

/** Largest request body accepted, in bytes. A tool call is small. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Paths that speak MCP. Everything else is a 404. */
const MCP_PATHS: ReadonlySet<string> = new Set(["/", "/mcp"]);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The prefix every guest session's actor carries. */
export const GUEST_ACTOR_PREFIX = "agent:guest-";

/**
 * Mint one session's actor.
 *
 * `used` is the set of actors this listener has already handed out, for the life
 * of the process rather than of the live map: two sessions that shared an actor
 * would share a budget and a refusal history, which is the one thing this scheme
 * exists to keep apart. Six hex digits is short enough to read out loud in a
 * demo, so the collision check is not decoration.
 */
export function mintSessionActor(used: ReadonlySet<string>): string {
  for (let width = 3; width <= 8; width += 1) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const actor = `${GUEST_ACTOR_PREFIX}${randomBytes(width).toString("hex")}`;
      if (!used.has(actor)) return actor;
    }
  }
  // Unreachable in practice: 2^64 candidates against at most a few hundred
  // sessions. Throwing beats returning a duplicate identity.
  throw new Error("could not mint a unique guest actor");
}

// ---------------------------------------------------------------------------
// Options and handle
// ---------------------------------------------------------------------------

export interface HttpServeOptions extends ServerPaths {
  /**
   * The actor every session runs as, or `null` under {@link guest}, where each
   * session mints its own. Already validated by `resolveAgentActor`.
   */
  actor: string | null;
  /** Guest mode: per-session identity (APRV-174) and, since APRV-175, a narrowed tool list. */
  guest: boolean;
  /** Interface to bind. Defaults to `127.0.0.1`; the CLI owns the widening decision. */
  host?: string;
  /** TCP port. `0` asks the kernel for an ephemeral one, which is what tests use. */
  port: number;
  /** Session lifecycle lines. The CLI passes stderr; stdout is never written to. */
  notice?: (text: string) => void;
}

export interface McpHttpServer {
  /** The interface actually bound. */
  readonly host: string;
  /** The port actually bound, resolved after an ephemeral request. */
  readonly port: number;
  /** Actors of the live sessions, in open order. Diagnostics and tests. */
  sessionActors(): string[];
  /** How many sessions this listener has opened, ever. */
  lifetimeSessions(): number;
  /** Close every session and the listener. Idempotent. */
  close(): Promise<void>;
}

interface Session {
  id: string;
  actor: string;
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

/** A refusal this module authors itself, in the CLI's `{"error":{...}}` shape. */
function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** The `mcp-session-id` header, or null. Case is normalised by node. */
function sessionHeader(req: IncomingMessage): string | null {
  const raw = req.headers["mcp-session-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.length === 0 ? null : value;
}

type BodyRead =
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; message: string };

/** Read and parse one JSON body, bounded by {@link MAX_BODY_BYTES}. */
async function readJsonBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          code: "mcp-body-too-large",
          message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        };
      }
      chunks.push(buffer);
    }
  } catch (cause) {
    return {
      ok: false,
      status: 400,
      code: "mcp-body-unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return {
      ok: false,
      status: 400,
      code: "mcp-invalid-json",
      message: `request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/**
 * Start the HTTP MCP listener. Resolves once it is bound and its real port is
 * known; rejects when the bind fails, so the CLI can report it and exit.
 */
export async function serveApprovalMcpHttp(
  options: HttpServeOptions,
): Promise<McpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const notice = options.notice ?? ((): void => {});
  const paths: ServerPaths = {
    cwd: options.cwd,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  };

  // ONE queue for every session: `wait` blocks the event loop and `run` spawns
  // synchronously, both of which are facts about this process.
  const serialize = serializer();

  const sessions = new Map<string, Session>();
  const mintedActors = new Set<string>();
  let opening = 0;
  let lifetime = 0;
  let closing = false;

  const closeAll = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const live = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(live.map((entry) => entry.close()));
    await new Promise<void>((settle) => {
      http.close(() => settle());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });
  };

  async function openSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    if (lifetime + opening >= MAX_LIFETIME_SESSIONS) {
      refuse(
        res,
        503,
        "mcp-session-lifetime-cap",
        `this server has opened its lifetime limit of ${MAX_LIFETIME_SESSIONS} MCP sessions and accepts no more; restart it to serve again`,
      );
      return;
    }
    if (sessions.size + opening >= MAX_CONCURRENT_SESSIONS) {
      refuse(
        res,
        503,
        "mcp-session-cap",
        `this server holds its limit of ${MAX_CONCURRENT_SESSIONS} concurrent MCP sessions; try again when one ends`,
      );
      return;
    }

    // Identity BEFORE the transport, exactly as on stdio. Nothing read from
    // `req` or `body` contributes to it.
    const actor =
      options.actor === null ? mintSessionActor(mintedActors) : options.actor;
    mintedActors.add(actor);

    opening += 1;
    let registered = false;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => {
        registered = true;
        opening -= 1;
        lifetime += 1;
        sessions.set(id, session(id));
        notice(
          `approval: MCP session ${id} opened as ${actor} (${sessions.size} live, ${lifetime} this process)\n`,
        );
      },
    });

    const server = createApprovalMcpServer({ ...paths, actor, serialize });

    const session = (id: string): Session => ({
      id,
      actor,
      transport,
      close: async () => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && sessions.delete(id)) {
        notice(
          `approval: MCP session ${id} closed (${actor}); ${sessions.size} live\n`,
        );
      }
      void server.close().catch(() => undefined);
    };

    try {
      // The SDK declares `onclose` as an accessor pair whose getter includes
      // `undefined`, which this repo's `exactOptionalPropertyTypes` reads as a
      // mismatch with `Transport`. The object IS a Transport; the assertion
      // buys nothing but silence on a d.ts detail.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
    } finally {
      // An initialize the transport refused never reaches `onsessioninitialized`,
      // so the reservation has to be released here or the cap leaks.
      if (!registered) {
        opening -= 1;
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    }
  }

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
        if (!MCP_PATHS.has(url.pathname)) {
          refuse(
            res,
            404,
            "mcp-unknown-path",
            `no MCP endpoint at ${url.pathname}; this server speaks MCP at / and /mcp`,
          );
          return;
        }

        const id = sessionHeader(req);

        if (req.method === "GET" || req.method === "DELETE") {
          if (id === null) {
            refuse(
              res,
              400,
              "mcp-session-required",
              "no mcp-session-id header; open a session with an initialize POST first",
            );
            return;
          }
          const existing = sessions.get(id);
          if (existing === undefined) {
            refuse(res, 404, "mcp-unknown-session", `no MCP session ${JSON.stringify(id)}`);
            return;
          }
          await existing.transport.handleRequest(req, res);
          return;
        }

        if (req.method !== "POST") {
          refuse(
            res,
            405,
            "mcp-method-not-allowed",
            `${req.method ?? "?"} is not a method this endpoint answers`,
          );
          return;
        }

        const body = await readJsonBody(req);
        if (!body.ok) {
          refuse(res, body.status, body.code, body.message);
          return;
        }

        if (id !== null) {
          const existing = sessions.get(id);
          if (existing === undefined) {
            refuse(res, 404, "mcp-unknown-session", `no MCP session ${JSON.stringify(id)}`);
            return;
          }
          await existing.transport.handleRequest(req, res, body.value);
          return;
        }

        if (!isInitializeRequest(body.value)) {
          refuse(
            res,
            400,
            "mcp-session-required",
            "no mcp-session-id header and this is not an initialize request; every other request belongs to a session",
          );
          return;
        }

        await openSession(req, res, body.value);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        notice(`approval: MCP request failed: ${message}\n`);
        if (!res.headersSent) refuse(res, 500, "mcp-request-failed", message);
        else res.end();
      }
    })();
  });

  const sockets = new Set<Socket>();
  http.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((settle, fail) => {
    const onError = (cause: Error): void => fail(cause);
    http.once("error", onError);
    http.listen(options.port, host, () => {
      http.off("error", onError);
      settle();
    });
  });

  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host,
    port,
    sessionActors: () => [...sessions.values()].map((entry) => entry.actor),
    lifetimeSessions: () => lifetime,
    close: closeAll,
  };
}
