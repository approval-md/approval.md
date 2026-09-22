/**
 * `approval serve` — the agent-facing surface over HTTP, in the foreground
 * (APRV-421).
 *
 * This file is argv, identity, credentials, a bind and a signal handler. The
 * server itself is `src/serve/server.ts`, and the verbs, the hook verdicts and
 * the follow batches are the CLI's own: there is nothing here that could answer
 * differently from the command line.
 *
 * **Why the import of the server is dynamic.** `main.ts` dispatches to this
 * file, and the server module reaches `cli/hook.ts`, `cli/main.ts` and
 * `mcp/server.ts`, which reach `main` in turn. A static import here would close
 * that circle, and an ESM cycle is not a compile error — it is a binding that
 * is `undefined` in one direction on the day module initialisation order
 * changes. `cli/mcp.ts` states the same rule and `tests/layering.test.ts` pins
 * it.
 *
 * **Everything that can refuse, refuses BEFORE the listener exists.** Identity,
 * both credentials, the bind decision and the daemon id are all settled first,
 * for the reason `cli/mcp.ts` gives about identity: a server that bound first
 * and refused afterwards is a server something had already spoken to.
 */

import { boolFlag, parseFlags, stringFlag } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { SERVE_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { isLoopbackHost, parseListen } from "./mcp.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";
import { resolveDaemonId } from "../core/daemon-host.js";
import { parseDuration } from "../core/policy-load.js";

/** The port this server binds when the operator names none. */
export const SERVE_DEFAULT_PORT = 4682;

/** The interface it binds when `--listen` names none. */
export const SERVE_DEFAULT_HOST = "127.0.0.1";

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, SERVE_HELP));
  return EXIT_USAGE;
}

/**
 * The banner a non-loopback bind prints, every time, on stderr.
 *
 * Reached only when the operator passed BOTH `--listen <host:port>` naming a
 * routable interface and `--allow-non-loopback`, so it is not a warning about
 * something that happened by accident. What it says is what this process does
 * not do: there is no TLS inside it, the credentials are bearer values, and a
 * bearer value on a cleartext connection is a credential anybody on the path
 * has. The supported deployment is a proxy the operator owns.
 */
export function nonLoopbackBanner(host: string, port: number): string {
  return [
    "",
    "  !! approval serve IS BOUND TO A NON-LOOPBACK INTERFACE !!",
    `  ${host}:${String(port)} is reachable by anyone who can route to it, and this`,
    "  server speaks PLAIN HTTP: it terminates no TLS and holds no certificate.",
    "  Both credentials are bearer values, so a cleartext hop hands them to",
    "  whoever is on it. Terminate TLS in a proxy you control and give this",
    "  process a loopback bind behind it.",
    "",
    "",
  ].join("\n");
}

/** `approval serve [flags]`. */
export async function commandServe(
  argv: string[],
  streams: Streams,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, {
    "--as": "string",
    "--dir": "string",
    "--log": "string",
    "--policy": "string",
    "--listen": "string",
    "--port": "string",
    "--allow-non-loopback": "boolean",
    "--hook-timeout": "string",
    "--hook-harness-cap": "string",
    "--json": "boolean",
    "--help": "boolean",
    "-h": "boolean",
  });
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${SERVE_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const listenFlag = stringFlag(parsed.flags, "--listen");
  const portFlag = stringFlag(parsed.flags, "--port");
  if (listenFlag !== null && portFlag !== null) {
    return usageError(
      streams,
      json,
      "--listen and --port name the same thing; pass one. --listen <[host:]port> is the only way to bind a non-loopback interface",
    );
  }

  let bindHost = SERVE_DEFAULT_HOST;
  let bindPort = SERVE_DEFAULT_PORT;
  if (listenFlag !== null) {
    const listen = parseListen(listenFlag);
    if (!listen.ok) return usageError(streams, json, listen.message);
    bindHost = listen.host;
    bindPort = listen.port;
  } else if (portFlag !== null) {
    if (!/^\d+$/u.test(portFlag.trim())) {
      return usageError(streams, json, `--port expects a whole number, got ${JSON.stringify(portFlag)}`);
    }
    bindPort = Number(portFlag.trim());
    if (bindPort > 65535) {
      return usageError(streams, json, `--port ${String(bindPort)} is outside the TCP port range`);
    }
  }

  const allowNonLoopback = boolFlag(parsed.flags, "--allow-non-loopback");
  if (!isLoopbackHost(bindHost) && !allowNonLoopback) {
    return usageError(
      streams,
      json,
      `--listen ${JSON.stringify(bindHost)} is not the loopback interface, and this server speaks plain HTTP with bearer credentials. Add --allow-non-loopback if you meant it and TLS is terminated in front of this process`,
    );
  }

  const hookTimeout = stringFlag(parsed.flags, "--hook-timeout");
  if (hookTimeout !== null && parseDuration(hookTimeout) === null) {
    return usageError(
      streams,
      json,
      `--hook-timeout expects a duration like 30s, 9m, got ${JSON.stringify(hookTimeout)}`,
    );
  }

  // APRV-423, the companion to the flag above and independent of it: one bounds
  // how long a hook call WAITS, this one states the ceiling the harness on the
  // other end of that call runs its own hook process under. A tenant harness
  // that kills the hook while the question is still on a phone is the case
  // APRV-410 describes, and this is how the operator of a shared gate tells the
  // runtime where that ceiling is.
  const hookHarnessCap = stringFlag(parsed.flags, "--hook-harness-cap");
  if (hookHarnessCap !== null && parseDuration(hookHarnessCap) === null) {
    return usageError(
      streams,
      json,
      `--hook-harness-cap expects a duration like 300s, 4m, got ${JSON.stringify(hookHarnessCap)}`,
    );
  }

  const dir = stringFlag(parsed.flags, "--dir");
  const root = dir === null ? cwd : resolvePath(dir, ".", cwd);
  const logFlag = stringFlag(parsed.flags, "--log");
  const policyFlag = stringFlag(parsed.flags, "--policy");
  const logPath = logFlag === null ? resolvePath(null, DEFAULT_LOG_PATH, root) : resolvePath(logFlag, DEFAULT_LOG_PATH, cwd);

  // ONE dynamic import of this verb's own server module, which is where the
  // identity resolver lives too: `cli/mcp.ts` reaches `resolveAgentActor`
  // through the MCP server and this file reaches the same function through
  // this one, so neither CLI module depends on the other's transport.
  const { resolveAgentActor, serveApproval } = await import("../serve/server.js");
  const { resolveServeCredentials } = await import("../serve/credentials.js");

  // Identity is the server's, fixed here, and refused here: `human:` and
  // `system:` are not available on a surface whose whole purpose is to act as
  // the party under oversight.
  const identity = resolveAgentActor(stringFlag(parsed.flags, "--as"), env);
  if (!identity.ok) return usageError(streams, json, identity.message);

  const credentials = resolveServeCredentials(env);
  if (!credentials.ok) return usageError(streams, json, credentials.message);

  // The id every record written under this process will carry. A process whose
  // whole purpose is dispatching verbs that append should not start in order to
  // find out that it cannot, which is the rule `approval up` and `approval
  // daemon run` already follow.
  const daemon = resolveDaemonId(logPath, env);
  if (!daemon.ok) return usageError(streams, json, daemon.message);

  let server;
  try {
    server = await serveApproval({
      actor: identity.actor,
      cwd: root,
      credentials: credentials.credentials,
      daemonId: daemon.id,
      host: bindHost,
      port: bindPort,
      ...(logFlag === null ? {} : { log: logPath }),
      ...(policyFlag === null ? {} : { policy: resolvePath(policyFlag, ".", cwd) }),
      ...(hookTimeout === null ? {} : { hookTimeout }),
      ...(hookHarnessCap === null ? {} : { hookHarnessCap }),
      notice: () => undefined,
    });
  } catch (cause) {
    streams.err(
      `approval: serve could not bind ${bindHost}:${String(bindPort)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    return EXIT_IO;
  }

  if (!isLoopbackHost(server.host)) streams.err(nonLoopbackBanner(server.host, server.port));
  // Never stdout: an operator piping this server's output somewhere should get
  // bytes that mean one thing, and this process has nothing to say on stdout.
  streams.err(
    `approval: serve on http://${server.host}:${String(server.port)}/ as ${identity.actor}, daemon ${daemon.id} (${daemon.source}), store ${root}. Two credentials: the agent surface (/verbs, /verb/<name>, /hook/<harness>) and the tenant surface (/log/follow, /export, /status). TLS is your proxy's; press Ctrl-C to stop.\n`,
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
            `approval: serve did not close cleanly: ${
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
