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

  const { resolveAgentActor, serveApprovalMcp } = await import("../mcp/server.js");

  // Identity is settled BEFORE the transport exists. A server that connected
  // first and refused later would be a server a client had already spoken to.
  const identity = resolveAgentActor(stringFlag(parsed.flags, "--as"));
  if (!identity.ok) return usageError(streams, json, identity.message);

  const dir = stringFlag(parsed.flags, "--dir");
  const root = dir === null ? cwd : resolvePath(dir, ".", cwd);
  const logFlag = stringFlag(parsed.flags, "--log");
  const policyFlag = stringFlag(parsed.flags, "--policy");

  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );

  const server = await serveApprovalMcp(
    {
      actor: identity.actor,
      cwd: root,
      ...(logFlag === null ? {} : { log: resolvePath(logFlag, DEFAULT_LOG_PATH, cwd) }),
      ...(policyFlag === null ? {} : { policy: resolvePath(policyFlag, ".", cwd) }),
    },
    new StdioServerTransport(),
  );

  // Never stdout: stdout is the JSON-RPC stream from here on.
  streams.err(
    `approval: MCP server on stdio as ${identity.actor}, working directory ${root}. Human-only verbs are not published; press Ctrl-C to stop.\n`,
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
