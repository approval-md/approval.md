/**
 * `approval mcp serve` — the optional MCP wrapper of SPEC.md §10.5, in the
 * foreground, over stdio (APRV-87).
 *
 * This file is argv, identity, paths and a signal handler. The server itself is
 * `src/mcp/server.ts`, and the verbs are the CLI's own: a tool call reaches the
 * same function `main()` dispatches to, so there is nothing here that could
 * answer differently from the command line.
 *
 * **Why the import of the server is dynamic.** `main.ts` dispatches to this
 * file, and the server module imports `main`. A static import here would close
 * that circle, and an ESM cycle is not a compile error — it is a binding that is
 * `undefined` in one direction on the day module initialisation order changes.
 * The verb is asynchronous anyway, so the import happens when the server is
 * actually wanted, and `tests/layering.test.ts` pins the rule.
 */

import { boolFlag, parseFlags, stringFlag } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { MCP_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  // APRV-102: the pointer convention every other verb adopted in APRV-91. The
  // whole help page used to follow the message, which put this verb's SPEC
  // citations on an error screen — the exact thing the rule forbids.
  else streams.err(usageErrorText(message, MCP_HELP));
  return EXIT_USAGE;
}

/** The port `--http` binds when the operator names none (SPEC.md §10.5, APRV-174). */
export const MCP_HTTP_DEFAULT_PORT = 4681;

/** The interface `--http` binds when `--listen` names none. */
export const MCP_HTTP_DEFAULT_HOST = "127.0.0.1";

/** Hosts that are the local machine and nothing else. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/** Is `host` the loopback interface? */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export type ListenParse =
  | { ok: true; host: string; port: number }
  | { ok: false; message: string };

/**
 * `--listen <[host:]port>` -> a host and a port.
 *
 * The host half is what makes a non-loopback bind EXPLICIT: `--port` cannot
 * reach one, and a bare `--listen 4681` cannot either. An operator who wants
 * this server on an interface the network can reach has to write that interface
 * out, and gets told about it loudly when they do.
 */
export function parseListen(value: string): ListenParse {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, message: "--listen expects <[host:]port>" };

  let host = MCP_HTTP_DEFAULT_HOST;
  let portText = trimmed;

  // `[::1]:4681` first: an IPv6 literal has colons of its own.
  const bracketed = /^\[(?<addr>[^\]]+)\]:(?<port>\d+)$/u.exec(trimmed);
  if (bracketed?.groups !== undefined) {
    host = bracketed.groups["addr"] as string;
    portText = bracketed.groups["port"] as string;
  } else {
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon >= 0) {
      const left = trimmed.slice(0, lastColon);
      portText = trimmed.slice(lastColon + 1);
      if (left.includes(":")) {
        return {
          ok: false,
          message: `--listen ${JSON.stringify(value)}: write an IPv6 address in brackets, as [::1]:${portText}`,
        };
      }
      if (left.length > 0) host = left;
    }
  }

  if (!/^\d+$/u.test(portText)) {
    return {
      ok: false,
      message: `--listen expects <[host:]port>, got ${JSON.stringify(value)}`,
    };
  }
  const port = Number(portText);
  if (port < 0 || port > 65535) {
    return { ok: false, message: `--listen port ${port} is outside the TCP port range` };
  }
  return { ok: true, host, port };
}

/**
 * The banner a non-loopback bind prints, every time, on stderr.
 *
 * This server has no authentication of any kind (`channels/web.ts` states the
 * same boundary at more length). On loopback that is the §11 trust boundary as
 * written. On any other interface it means everyone who can route to this port
 * may open a session, so the operator is told in the imperative rather than in a
 * footnote.
 */
export function nonLoopbackBanner(host: string, port: number, guest: boolean): string {
  return [
    "",
    "  !! THIS MCP SERVER IS BOUND TO A NON-LOOPBACK INTERFACE !!",
    `  ${host}:${port} is reachable by anyone who can route to it, and this`,
    "  server authenticates NOBODY. There is no password, no token and no TLS.",
    guest
      ? "  Guest mode restricts what a session may call; it does not authenticate one."
      : "  EVERY session acts as the single agent identity you started this server with.",
    "  The supported deployment is --listen 127.0.0.1 behind a tunnel you control.",
    "",
    "",
  ].join("\n");
}

/** What `--http` needs, already resolved and validated by the verb. */
interface HttpRun {
  actor: string | null;
  guest: boolean;
  host: string;
  port: number;
  cwd: string;
  log?: string;
  policy?: string;
}

/**
 * Run the HTTP listener until a signal stops it.
 *
 * Identical in shape to the stdio arm: bind, say what was bound on STDERR, then
 * wait for SIGINT/SIGTERM. Stdout stays empty here too, because an operator
 * piping this server's output somewhere should get bytes that mean one thing.
 */
async function serveHttp(run: HttpRun, streams: Streams): Promise<number> {
  const { serveApprovalMcpHttp, MAX_CONCURRENT_SESSIONS, MAX_LIFETIME_SESSIONS } =
    await import("../mcp/http.js");

  let server;
  try {
    server = await serveApprovalMcpHttp({
      actor: run.actor,
      guest: run.guest,
      host: run.host,
      port: run.port,
      cwd: run.cwd,
      ...(run.log === undefined ? {} : { log: run.log }),
      ...(run.policy === undefined ? {} : { policy: run.policy }),
      notice: (text) => streams.err(text),
    });
  } catch (cause) {
    streams.err(
      `approval: the MCP server could not bind ${run.host}:${run.port}: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    return EXIT_IO;
  }

  if (!isLoopbackHost(server.host)) {
    streams.err(nonLoopbackBanner(server.host, server.port, run.guest));
  }
  streams.err(
    `approval: MCP server on http://${server.host}:${server.port}/ (streamable HTTP), working directory ${run.cwd}. ${
      run.guest
        ? "GUEST mode: each session mints its own agent:guest-<id>"
        : `every session acts as ${run.actor ?? "the operator's identity"}`
    }. Up to ${MAX_CONCURRENT_SESSIONS} concurrent sessions and ${MAX_LIFETIME_SESSIONS} for the life of this process; press Ctrl-C to stop.\n`,
  );

  return await new Promise<number>((settle) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.close().then(
        () => settle(EXIT_OK),
        (cause: unknown) => {
          streams.err(
            `approval: MCP server did not close cleanly: ${
              cause instanceof Error ? cause.message : String(cause)
            }\n`,
          );
          settle(EXIT_IO);
        },
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** `approval mcp serve [--as agent:<id>] [--dir <path>] [--log <path>] [--policy <path>]`. */
async function commandMcpServe(
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, {
    "--as": "string",
    "--dir": "string",
    "--log": "string",
    "--policy": "string",
    "--http": "boolean",
    "--listen": "string",
    "--port": "string",
    "--guest": "boolean",
    "--json": "boolean",
    "--help": "boolean",
    "-h": "boolean",
  });
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${MCP_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const http = boolFlag(parsed.flags, "--http");
  const guest = boolFlag(parsed.flags, "--guest");
  const listenFlag = stringFlag(parsed.flags, "--listen");
  const portFlag = stringFlag(parsed.flags, "--port");

  if (!http) {
    for (const flag of ["--listen", "--port", "--guest"]) {
      const given = flag === "--guest" ? guest : parsed.flags[flag] !== undefined;
      if (!given) continue;
      return usageError(
        streams,
        json,
        `${flag} applies to the HTTP transport only; add --http (stdio serves one client through the pipe it was handed)`,
      );
    }
  }
  if (listenFlag !== null && portFlag !== null) {
    return usageError(
      streams,
      json,
      "--listen and --port name the same thing; pass one. --listen <[host:]port> is the only way to bind a non-loopback interface",
    );
  }

  let bindHost = MCP_HTTP_DEFAULT_HOST;
  let bindPort = MCP_HTTP_DEFAULT_PORT;
  if (listenFlag !== null) {
    const listen = parseListen(listenFlag);
    if (!listen.ok) return usageError(streams, json, listen.message);
    bindHost = listen.host;
    bindPort = listen.port;
  } else if (portFlag !== null) {
    if (!/^\d+$/u.test(portFlag.trim())) {
      return usageError(
        streams,
        json,
        `--port expects a whole number, got ${JSON.stringify(portFlag)}`,
      );
    }
    bindPort = Number(portFlag.trim());
    if (bindPort > 65535) {
      return usageError(streams, json, `--port ${bindPort} is outside the TCP port range`);
    }
  }

  const { resolveAgentActor, serveApprovalMcp } = await import("../mcp/server.js");

  // Identity is settled BEFORE the transport exists. A server that connected
  // first and refused later would be a server a client had already spoken to.
  // Under --guest the same rule holds one level down: each session's actor is
  // minted before its transport pair is built (`mcp/http.ts`), and the operator
  // supplies no identity at all, because a guest's is not theirs to choose.
  let actor: string | null = null;
  if (!guest) {
    const identity = resolveAgentActor(stringFlag(parsed.flags, "--as"));
    if (!identity.ok) return usageError(streams, json, identity.message);
    actor = identity.actor;
  } else if (stringFlag(parsed.flags, "--as") !== null) {
    return usageError(
      streams,
      json,
      "--as and --guest are exclusive: a guest session mints its own agent:guest-<id>, so there is no one identity for this server to act as",
    );
  }

  const dir = stringFlag(parsed.flags, "--dir");
  const root = dir === null ? cwd : resolvePath(dir, ".", cwd);
  const logFlag = stringFlag(parsed.flags, "--log");
  const policyFlag = stringFlag(parsed.flags, "--policy");

  if (http) {
    return await serveHttp(
      {
        actor,
        guest,
        host: bindHost,
        port: bindPort,
        cwd: root,
        ...(logFlag === null ? {} : { log: resolvePath(logFlag, DEFAULT_LOG_PATH, cwd) }),
        ...(policyFlag === null ? {} : { policy: resolvePath(policyFlag, ".", cwd) }),
      },
      streams,
    );
  }

  // Unreachable: --guest is refused above without --http, and every other path
  // through `resolveAgentActor` either set an actor or returned. Stated rather
  // than asserted, because a null identity is the one thing this file may not
  // hand to a transport.
  if (actor === null) {
    return usageError(
      streams,
      json,
      `no agent identity: pass --as agent:<id> or set APPROVAL_AGENT=agent:<id>`,
    );
  }

  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );

  const server = await serveApprovalMcp(
    {
      actor,
      cwd: root,
      ...(logFlag === null ? {} : { log: resolvePath(logFlag, DEFAULT_LOG_PATH, cwd) }),
      ...(policyFlag === null ? {} : { policy: resolvePath(policyFlag, ".", cwd) }),
    },
    new StdioServerTransport(),
  );

  // Never stdout: stdout is the JSON-RPC stream from here on.
  streams.err(
    `approval: MCP server on stdio as ${actor}, working directory ${root}. Human-only verbs are not published; press Ctrl-C to stop.\n`,
  );

  return await new Promise<number>((settle) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.close().then(
        () => settle(EXIT_OK),
        (cause: unknown) => {
          streams.err(
            `approval: MCP server did not close cleanly: ${
              cause instanceof Error ? cause.message : String(cause)
            }\n`,
          );
          settle(EXIT_IO);
        },
      );
    };
    server.onclose = stop;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** `approval mcp <subcommand>` — `serve`, and nothing else. */
export function commandMcp(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval mcp`");
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${MCP_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "serve") return commandMcpServe(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval mcp\``,
  );
}
