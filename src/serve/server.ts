/**
 * `approval serve` — the agent-facing surface over HTTP, for a harness that
 * has no local log and no local policy (APRV-421).
 *
 * A tenant whose harness runs in a sandbox (Agent Village's Hermes tenants,
 * the Meta Muse connector packet) has nowhere for `approval hook <harness>` to
 * write and nothing for it to read. The hosted daemon runs elsewhere, one
 * process per tenant (design/hosted-daemon-identity.md); what was missing was a
 * way to reach it. This is that door, and it is a DOOR rather than a second
 * gate.
 *
 * ## Transport only, and the file says so by importing rather than repeating
 *
 * Every verdict, every verb and every batch of records here comes from the
 * function the CLI dispatches to:
 *
 * - the verb surface is `mcp/server.ts`'s — {@link publishedVerbs},
 *   {@link toolDefinitions}, {@link buildArgv} and {@link invokeVerb}, so the
 *   catalog MATCHES `approval mcp serve` because it IS `approval mcp serve`'s,
 *   `--as` is absent from every published schema for the same one reason, and
 *   the launch identity is appended last by the same one line;
 * - a hook call is `commandHook` with the request body as its stdin, so the
 *   bytes on the response are the bytes the stdin form prints, for every
 *   adapter in `HARNESS_ADAPTERS`, with no dialect knowledge in this file;
 * - a follow page is `core/log-subscribe.ts`'s verified subscription, drained
 *   once (`serve/follow.ts`).
 *
 * Nothing here classifies a command, resolves a policy, mints a token or
 * verifies a chain. Two implementations of the gate sequence would be two
 * gates, and the second would be the one nobody reviewed.
 *
 * ## Two credentials, two parties
 *
 * `serve/credentials.ts` holds the reasoning. The short form: the agent
 * credential opens the verbs and the hook, the tenant credential opens the
 * log, the export and status, and the agent credential never reads the log it
 * is judged by.
 *
 * ## What it does not do
 *
 * - **No TLS.** There is no certificate handling in this process and there is
 *   not going to be: the supported deployment is a loopback bind behind a
 *   proxy the operator owns, and a non-loopback bind requires an explicit flag
 *   and prints a banner (`cli/serve.ts`).
 * - **No record of its own.** This server appends nothing on its own account.
 *   Every event in the log under it was written by a verb a caller asked for,
 *   under the identity the operator fixed at launch.
 * - **No state a restart loses.** The only thing held between requests is the
 *   serialization queue, which is a property of the process rather than of any
 *   caller. Follow cursors belong to the caller, so a host that sleeps and
 *   wakes serves the same next page it would have served before.
 * - **No `.approval/env`.** SPEC.md §11.1 invariant 7, inherited verbatim from
 *   the MCP server: the environment a gate operation runs under is the one the
 *   host launched this process with.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import { commandHook, HARNESS_ADAPTERS } from "../cli/hook.js";
import type { Streams } from "../cli/main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "../cli/paths.js";
import { verbLabel, type VerbSpec } from "../cli/verb-registry.js";
import { isHarnessKind, type HarnessKind } from "../core/harness-version.js";
import {
  buildArgv,
  invokeVerb,
  lastJsonObject,
  publishedVerbs,
  serializer,
  toolDefinitions,
  toolName,
  type ServerOptions,
} from "../mcp/server.js";
import { buildStoreArchive } from "./archive.js";

/**
 * Identity is resolved by the MCP server's own function, re-exported here so
 * that `cli/serve.ts` reaches it through ITS server exactly as `cli/mcp.ts`
 * reaches it through the MCP one.
 *
 * Two transports fixing an identity by two rules would be two answers to
 * "which identities may this process act as", and the answer has to be one:
 * `agent:<id>` and nothing else, refused at startup, never supplied by a
 * caller.
 */
export { resolveAgentActor, type IdentityCheck } from "../mcp/server.js";
import { bearerOf, type ServeCredentials, type ServeScope } from "./credentials.js";
import {
  clampFollowLimit,
  followFailureExit,
  followPage,
  type FollowCursor,
} from "./follow.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Largest request body accepted. A tool call and a hook envelope are small. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * How much of a hook's stderr rides back on the response header.
 *
 * Hermes's ALLOW is `{}` and carries its reason on stderr and nowhere else
 * (`cli/hook.ts`), so a transport that dropped stderr would drop the only
 * account of why a Hermes session was let through. It is base64 so that a
 * multi-line value is one header, and bounded so that a verbose progress
 * report cannot make a response unsendable.
 */
export const MAX_STDERR_HEADER_BYTES = 4096;

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/**
 * Verbs the AGENT credential may not call, whatever the catalog publishes.
 *
 * The catalog is the registry's (AC3, and `mcp/server.ts` owns it); this is
 * authorization, which is a different question asked one layer later. `status`
 * reports the tenant's gate — the head of their log, their pending queue,
 * their daemon — and that is the tenant's view of the oversight the agent is
 * under, not a fact the party under oversight is owed. It stays PUBLISHED, so
 * the surface is honest about what exists, and it answers to the tenant
 * credential at `GET /status`.
 */
export const TENANT_ONLY_VERBS: ReadonlySet<string> = new Set(["status"]);

/**
 * The frozen refusal vocabulary this server authors itself (SPEC.md §11.1
 * invariant 6).
 *
 * A refusal a VERB produced keeps the verb's own code, unchanged, because it
 * is the CLI's refusal arriving over a different transport; so does a refusal
 * `buildArgv` produced, `mcp-` prefix and all, because that function is the
 * one both transports call and renaming its codes here would make one surface
 * lie about the other. What is listed below is only what this file decides.
 */
export const SERVE_REFUSAL_CODES = [
  "serve-unauthorized",
  "serve-agent-forbidden",
  "serve-tenant-forbidden",
  "serve-unknown-path",
  "serve-unknown-verb",
  "serve-unknown-harness",
  "serve-method-not-allowed",
  "serve-body-too-large",
  "serve-body-unreadable",
  "serve-invalid-cursor",
  "serve-no-structured-output",
  "serve-export-failed",
] as const;

export type ServeRefusalCode = (typeof SERVE_REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// Options and handle
// ---------------------------------------------------------------------------

export interface ServeOptions {
  /** `agent:<id>`, already validated. Every verb call is recorded under it. */
  actor: string;
  /** The store root: the working directory every relative path resolves against. */
  cwd: string;
  /** `--log`, when the operator pinned one. */
  log?: string;
  /** `--policy`, when the operator pinned one. */
  policy?: string;
  /** The two bearer credentials, already resolved from the environment. */
  credentials: ServeCredentials;
  /** The daemon instance id this gate writes under. Reported, never enforced. */
  daemonId: string;
  /** Interface to bind. The CLI owns the widening decision; this defaults to loopback. */
  host?: string;
  /** TCP port. `0` asks the kernel for an ephemeral one, which is what tests use. */
  port: number;
  /** `--timeout` pinned on every hook call, when the operator chose one. */
  hookTimeout?: string;
  /** Request lines. The CLI passes stderr; stdout is never written to. */
  notice?: (text: string) => void;
}

export interface ServeHandle {
  readonly host: string;
  readonly port: number;
  /** How many requests this listener has answered. Diagnostics and tests. */
  requests(): number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

/**
 * A refusal, always as a RESULT BODY.
 *
 * Never a bare HTTP error: the status code is a hint for the plumbing between
 * here and the caller, and the `{"error":{"code","message"}}` object is the
 * answer. A client branches on `error.code` exactly as it would on the CLI's
 * stderr, and every code it can see is either this file's (above), a verb's
 * own, or the subscription's.
 */
function refuse(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  send(res, status, JSON.stringify({ error: { code, message, ...extra } }), {
    "content-type": "application/json",
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { ...headers, "content-length": bytes.length });
  res.end(bytes);
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; status: number; code: ServeRefusalCode; message: string };

/** Read one request body, bounded by {@link MAX_BODY_BYTES}. */
async function readBody(req: IncomingMessage): Promise<BodyRead> {
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
          code: "serve-body-too-large",
          message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
        };
      }
      chunks.push(buffer);
    }
  } catch (cause) {
    return {
      ok: false,
      status: 400,
      code: "serve-body-unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/** A collector shaped like the CLI's stream sink. */
function collector(): { streams: Streams; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  /** Which credential opens this verb. Annotation only; the check is below. */
  scope: ServeScope;
}

/**
 * The published surface: `approval mcp serve`'s tool list, with each entry's
 * scope stated.
 *
 * Derived, not restated. A verb added to the registry tomorrow appears here
 * the same day it appears as an MCP tool, with `--as` already deleted from its
 * schema by the same function, and `grant` is absent for the same reason it is
 * absent there — the registry marks it `human_only` and no transport publishes
 * a human's authority.
 */
export function serveCatalog(): CatalogEntry[] {
  const scopeOf = new Map(
    publishedVerbs().map((spec) => [
      toolName(spec),
      TENANT_ONLY_VERBS.has(verbLabel(spec)) ? ("tenant" as const) : ("agent" as const),
    ]),
  );
  return toolDefinitions().map((tool) => ({
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    scope: scopeOf.get(tool.name) ?? "agent",
  }));
}

/**
 * The flags every hook call is made with.
 *
 * Exported so a test can hand the SAME argv to `commandHook` directly and
 * compare the bytes. That comparison is the acceptance criterion, and it is
 * only honest if both sides are the same invocation of the same verb: a test
 * that built its own flag list would be comparing two spellings.
 *
 * `--as` is appended LAST, as everywhere else on this surface, so the identity
 * the operator fixed when they started the process wins over anything that
 * arrived by another route (`parseFlags` keeps the last occurrence).
 */
export function hookArgv(
  options: Pick<ServeOptions, "actor" | "cwd" | "log" | "policy" | "hookTimeout">,
): string[] {
  return [
    "--dir",
    options.cwd,
    ...(options.log === undefined ? [] : ["--log", options.log]),
    ...(options.policy === undefined ? [] : ["--policy", options.policy]),
    ...(options.hookTimeout === undefined ? [] : ["--timeout", options.hookTimeout]),
    "--as",
    options.actor,
  ];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Route =
  | { kind: "catalog" }
  | { kind: "verb"; name: string }
  | { kind: "hook"; harness: string }
  | { kind: "follow" }
  | { kind: "export" }
  | { kind: "status" };

/** The route a path names, or null. Method is checked by the handler. */
export function routeOf(pathname: string): Route | null {
  if (pathname === "/verbs") return { kind: "catalog" };
  if (pathname === "/log/follow") return { kind: "follow" };
  if (pathname === "/export") return { kind: "export" };
  if (pathname === "/status") return { kind: "status" };
  const verb = /^\/verb\/(?<name>[a-z0-9_-]+)$/u.exec(pathname);
  if (verb?.groups !== undefined) return { kind: "verb", name: verb.groups["name"] as string };
  const hook = /^\/hook\/(?<harness>[a-z0-9-]+)$/u.exec(pathname);
  if (hook?.groups !== undefined) {
    return { kind: "hook", harness: hook.groups["harness"] as string };
  }
  return null;
}

/**
 * Which credential opens a route.
 *
 * `null` means either one does, which is true of the catalog alone: it is the
 * published contract, it reads no log and it appends nothing, and both parties
 * have a reason to ask what this server is.
 */
export function scopeOf(route: Route): ServeScope | null {
  switch (route.kind) {
    case "catalog":
      return null;
    case "follow":
    case "export":
    case "status":
      return "tenant";
    case "hook":
      return "agent";
    default:
      // A verb is the agent's unless it is one of the tenant-only ones, and the
      // check is on the LABEL rather than on membership of the catalog, so a
      // name that is not published still gets the scope answer before the
      // not-found one. A tenant credential naming `consume` learns that this
      // door is not theirs, which is the true and more useful fact.
      return TENANT_ONLY_VERBS.has(route.name.replaceAll("_", " ")) ? "tenant" : "agent";
  }
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/**
 * Start the listener. Resolves once it is bound and its real port is known;
 * rejects when the bind fails, so the CLI can report it and exit.
 */
export async function serveApproval(options: ServeOptions): Promise<ServeHandle> {
  const host = options.host ?? "127.0.0.1";
  const notice = options.notice ?? ((): void => {});
  const paths: ServerOptions = {
    actor: options.actor,
    cwd: options.cwd,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  };

  // ONE queue for everything that runs CLI code, for `mcp/http.ts`'s reason:
  // `wait` blocks the event loop with `Atomics.wait` and `run` spawns
  // synchronously, both of which are facts about this process rather than about
  // a connection. Reads that touch no verb (`log/follow`, `export`) stay off it.
  const serialize = serializer();

  const byName = new Map(publishedVerbs().map((spec) => [toolName(spec), spec]));
  const sockets = new Set<Socket>();
  let requests = 0;
  let closing = false;

  async function handleVerb(
    res: ServerResponse,
    spec: VerbSpec,
    args: unknown,
  ): Promise<void> {
    const built = buildArgv(spec, args, paths);
    if (!built.ok) {
      refuse(res, 400, built.code, built.message);
      return;
    }
    const result = await serialize(() => invokeVerb(spec, built.argv, paths));
    const payload = lastJsonObject(result.stdout) ?? lastJsonObject(result.stderr);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-approval-exit-code": String(result.code),
    };
    if (payload === null) {
      // Every published verb takes `--json` and answers with an object, so this
      // is the honest report of a verb that did not: the exit code and the text,
      // rather than an invented shape.
      const text = `${result.stdout}${result.stderr}`.trim();
      refuse(
        res,
        result.code === 0 ? 200 : 500,
        "serve-no-structured-output",
        `\`approval ${verbLabel(spec)}\` exited ${String(result.code)} without a JSON object on either stream${text.length === 0 ? "" : `: ${text}`}`,
      );
      return;
    }
    // The verb's OWN bytes: a refusal arrives as the `{"error":{...}}` the CLI
    // prints, with the same machine-readable code, and a success as the frozen
    // `--json` shape. Nothing is rewrapped.
    send(res, 200, JSON.stringify(payload), headers);
  }

  function handleHook(res: ServerResponse, harness: HarnessKind, body: string): void {
    const sink = collector();
    // The same function `main()` dispatches to, with the request body as the
    // stdin the verb would have read. The verdict object, its dialect, its
    // reason and its exit code are decided entirely inside it.
    const code = commandHook(
      [harness, ...hookArgv(options)],
      sink.streams,
      options.cwd,
      () => body,
    );
    const stderr = sink.err();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-approval-exit-code": String(code),
      "x-approval-harness": harness,
    };
    if (stderr.length > 0) {
      const clipped = Buffer.from(stderr, "utf8").subarray(0, MAX_STDERR_HEADER_BYTES);
      headers["x-approval-stderr"] = clipped.toString("base64");
      if (clipped.length < Buffer.byteLength(stderr)) {
        headers["x-approval-stderr-truncated"] = "1";
      }
    }
    // BYTE-FOR-BYTE what `approval hook <harness>` printed on stdout. Not
    // re-serialized, not wrapped, not pretty-printed: a caller that pipes this
    // body to its harness has piped the CLI's own answer.
    send(res, 200, sink.out(), headers);
  }

  async function handleFollow(res: ServerResponse, url: URL): Promise<void> {
    const fromText = url.searchParams.get("from");
    const hashText = url.searchParams.get("cursor_hash");
    const limitText = url.searchParams.get("limit");

    if (fromText !== null && !/^\d+$/u.test(fromText)) {
      refuse(res, 400, "serve-invalid-cursor", `from expects a whole number, got ${JSON.stringify(fromText)}`);
      return;
    }
    if (limitText !== null && !/^\d+$/u.test(limitText)) {
      refuse(res, 400, "serve-invalid-cursor", `limit expects a whole number, got ${JSON.stringify(limitText)}`);
      return;
    }
    const from = fromText === null ? 0 : Number(fromText);
    if (hashText !== null && !/^[a-f0-9]{64}$/u.test(hashText)) {
      refuse(
        res,
        400,
        "serve-invalid-cursor",
        "cursor_hash expects a lowercase 64-character SHA-256 digest",
      );
      return;
    }
    if (hashText !== null && from === 0) {
      refuse(res, 400, "serve-invalid-cursor", "cursor_hash requires from greater than zero");
      return;
    }

    const cursor: FollowCursor = { seq: from, hash: hashText };
    const limit = clampFollowLimit(limitText === null ? null : Number(limitText));
    const result = await followPage(options.log ?? logPathOf(options.cwd), cursor, limit);
    if (!result.ok) {
      // The subscription's own terminal failure, with the CLI's own code, the
      // CLI's own message, and NO RECORDS. `reason` carries `cursor-mismatch`
      // where there is one, so the caller need not read English to tell a torn
      // prefix from a cursor that belongs to another log.
      send(
        res,
        result.code === "integrity" ? 409 : 500,
        JSON.stringify({
          error: { code: result.code, message: result.message, reason: result.reason },
          records: [],
        }),
        {
          "content-type": "application/json",
          "x-approval-exit-code": String(followFailureExit(result.code)),
        },
      );
      return;
    }
    send(res, 200, JSON.stringify(result.page), {
      "content-type": "application/json",
      "x-approval-exit-code": "0",
    });
  }

  function handleExport(res: ServerResponse): void {
    let archive;
    try {
      archive = buildStoreArchive(options.cwd);
    } catch (cause) {
      refuse(
        res,
        500,
        "serve-export-failed",
        `the store at ${options.cwd} could not be archived: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    send(res, 200, archive.bytes, {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="approval-export-${options.daemonId}.tar.gz"`,
      "x-approval-export-paths": JSON.stringify(archive.paths),
    });
  }

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      requests += 1;
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

        // Authenticated FIRST, before the path is even looked up: there is no
        // unauthenticated surface on this server, not a health check and not a
        // 404. A caller with no credential learns nothing about what exists.
        const bearer = bearerOf(req.headers.authorization);
        const scope = bearer === null ? null : options.credentials.identify(bearer);
        if (scope === null) {
          refuse(
            res,
            401,
            "serve-unauthorized",
            "no usable Authorization: Bearer <credential>. This server has two credentials, one for the agent surface and one for the tenant surface, and every path requires one of them",
          );
          return;
        }

        const route = routeOf(url.pathname);
        if (route === null) {
          refuse(
            res,
            404,
            "serve-unknown-path",
            `no endpoint at ${url.pathname}; this server answers /verbs, /verb/<name>, /hook/<harness>, /log/follow, /export and /status`,
          );
          return;
        }

        const required = scopeOf(route);
        if (required !== null && required !== scope) {
          const code = scope === "agent" ? "serve-agent-forbidden" : "serve-tenant-forbidden";
          refuse(
            res,
            403,
            code,
            scope === "agent"
              ? `${url.pathname} answers to the TENANT credential. The agent credential reaches the verbs and the hook; it never reaches the log it is judged by, the store export, or the tenant's own status report`
              : `${url.pathname} answers to the AGENT credential. The tenant credential reaches the log, the export and status; it does not act as the agent, because an action taken with it would be recorded under an identity nobody was acting as`,
          );
          return;
        }

        const method = req.method ?? "GET";
        const wants = route.kind === "verb" || route.kind === "hook" ? "POST" : "GET";
        if (method !== wants) {
          refuse(
            res,
            405,
            "serve-method-not-allowed",
            `${url.pathname} answers ${wants}, not ${method}`,
          );
          return;
        }

        if (route.kind === "catalog") {
          send(res, 200, JSON.stringify({ actor: options.actor, verbs: serveCatalog() }), {
            "content-type": "application/json",
          });
          return;
        }
        if (route.kind === "follow") {
          await handleFollow(res, url);
          return;
        }
        if (route.kind === "export") {
          handleExport(res);
          return;
        }
        if (route.kind === "status") {
          const spec = byName.get("status");
          if (spec === undefined) {
            refuse(res, 500, "serve-unknown-verb", "the registry publishes no `status` verb");
            return;
          }
          await handleVerb(res, spec, {});
          return;
        }

        const body = await readBody(req);
        if (!body.ok) {
          refuse(res, body.status, body.code, body.message);
          return;
        }

        if (route.kind === "hook") {
          if (!isHarnessKind(route.harness)) {
            refuse(
              res,
              404,
              "serve-unknown-harness",
              `no hook adapter for ${JSON.stringify(route.harness)}; this runtime speaks ${Object.keys(HARNESS_ADAPTERS).join(", ")}`,
            );
            return;
          }
          // Serialized with the verbs: a hook call registers, requests and
          // WAITS, and the wait blocks this process exactly as `wait` does.
          await serialize(async () => {
            handleHook(res, route.harness as HarnessKind, body.text);
          });
          return;
        }

        const spec = byName.get(route.name);
        if (spec === undefined) {
          refuse(
            res,
            404,
            "serve-unknown-verb",
            `no verb ${JSON.stringify(route.name)} on this surface. GET /verbs lists what is published; a verb that records a human's authority is not among them, and never will be`,
          );
          return;
        }
        let args: unknown = {};
        if (body.text.trim().length > 0) {
          try {
            args = JSON.parse(body.text) as unknown;
          } catch (cause) {
            refuse(
              res,
              400,
              "serve-body-unreadable",
              `request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return;
          }
        }
        await handleVerb(res, spec, args);
      } catch (cause) {
        // A throw out of a handler is still a refusal with a code, because a
        // caller that got a bare 500 would have nothing to branch on.
        if (!res.headersSent) {
          refuse(
            res,
            500,
            "serve-body-unreadable",
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
    http.listen(options.port, host, () => {
      http.off("error", onError);
      settle();
    });
  });

  const address = http.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  const boundHost = typeof address === "object" && address !== null ? address.address : host;
  notice(`approval: serve bound ${boundHost}:${String(boundPort)}\n`);

  return {
    host: boundHost,
    port: boundPort,
    requests: () => requests,
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

/** The default log under a store root, from the CLI's own constant. */
function logPathOf(root: string): string {
  return resolvePath(null, DEFAULT_LOG_PATH, root);
}
