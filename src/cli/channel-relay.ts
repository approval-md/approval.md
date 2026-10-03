/**
 * `approval channel relay` — gestures an operator's authenticated relay
 * carries (SPEC.md §10.3, APRV-455).
 *
 * The third arrival of a human gesture, beside a Telegram tap and a terminal.
 * An operator's control plane holds an EdgeOS session for the person, shows
 * them a request or their policy, and posts what they did here: the gesture,
 * the EdgeOS `/humans/me` id of the session that made it, the hash or the key
 * it answers, and a nonce. `channels/relay-server.ts` authenticates the post
 * and `channels/relay.ts` turns it into a log event through the one function a
 * Telegram tap goes through. This file resolves configuration, refuses what it
 * must refuse, binds a port and reports; it decides nothing.
 *
 * ## The refusals that are the point
 *
 * 1. **The secret comes from the launch environment, never from the tree.**
 *    `APPROVAL_RELAY_SECRET`, refused when unset, when shorter than a value a
 *    host would generate, and when it holds a character a header cannot carry
 *    unambiguously (SPEC.md §11.1 invariant 7). It is a conventional name,
 *    beside `APPROVAL_TG_WEBHOOK_SECRET`, for that variable's reason: the
 *    policy decides WHETHER a channel exists, never the value that
 *    authenticates it, and a second declaration would be a second place for
 *    one fact to be wrong. Under the `APPROVAL_` prefix it is withheld from
 *    every child an agent's session spawns (`core/child-env.ts`).
 * 2. **No human identity.** This verb takes no `--as` and reads no
 *    `APPROVAL_HUMAN`. Every gesture is attributed to the account the attested
 *    policy maps, or refused `sender-unmapped`.
 * 3. **A post without the secret decides nothing and appends nothing.**
 *
 * ## Why there is no transport lease
 *
 * A Telegram bot admits one receiver, so its transports take a lease. A relay
 * has no such constraint: two relays on one gate would each record through
 * compare-and-append, the gate would answer a duplicate decision
 * `already-decided`, and the nonce ledger is a directory of exclusively linked files that
 * refuses a replay whichever relay it reaches. A second relay on the SAME port
 * fails to bind and says so.
 *
 * ## Where TLS is
 *
 * Not here, exactly as for `approval serve` and the webhook. Loopback by
 * default, behind whatever the operator puts in front of it; a routable bind
 * takes two flags and prints a banner, because the secret travels in a header.
 */

import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import {
  RELAY_DEFAULT_HOST,
  RELAY_DEFAULT_PORT,
  RELAY_DEFAULT_PROPOSER,
  RELAY_PATH,
  RELAY_SECRET_HEADER,
  fileNonceLedger,
} from "../channels/relay.js";
import { serveRelay, type RelayHandle } from "../channels/relay-server.js";
import { channelLeaseDirFor } from "../core/channel-lease.js";
import { readGatePolicy } from "../core/gate.js";
import { mapsSendersFor } from "../core/sender-identity.js";
import { readVerifiedRecords } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_TORN_TAIL, EXIT_USAGE } from "./exit-codes.js";
import { CHANNEL_RELAY_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { isLoopbackHost, parseListen } from "./mcp.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

/** The environment variable the shared secret is read from. */
export const RELAY_SECRET_ENV = "APPROVAL_RELAY_SECRET";

/** The shortest secret this verb starts with: `serve`'s floor, for its reason. */
export const RELAY_MIN_SECRET_LENGTH = 24;

/** What a header carries unambiguously, and what `openssl rand -hex` produces. */
const SECRET_CHARSET = /^[A-Za-z0-9_-]{1,256}$/u;

/**
 * A proposer is an `agent:` id. The relay is a machine carrying a proposal the
 * control plane rendered, and recording it under a `human:` id would say a
 * person proposed something nobody typed (APRV-455 refuter L1).
 */
const PROPOSER_PATTERN = /^agent:[^\s]+$/u;

const RELAY_FLAGS: Record<string, FlagKind> = {
  "--listen": "string",
  "--port": "string",
  "--allow-non-loopback": "boolean",
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--proposer": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * Why the relay could not start. A closed union, distinct per repair (SPEC.md
 * §11.1 invariant 6). Its per-request refusals are `RELAY_REFUSAL_CODES`.
 */
export const RELAY_START_REFUSAL_CODES = [
  /** `APPROVAL_RELAY_SECRET` is unset or empty. */
  "relay-secret-missing",
  /** It is shorter than {@link RELAY_MIN_SECRET_LENGTH}. */
  "relay-secret-weak",
  /** It holds a character outside A-Z a-z 0-9 _ -, or is longer than 256. */
  "relay-secret-charset",
  /** `--proposer` is not an `agent:` id. */
  "relay-proposer-invalid",
  /** The bind flags do not name a usable loopback (or explicitly widened) address. */
  "relay-bind-invalid",
] as const;

export type RelayStartRefusalCode = (typeof RELAY_START_REFUSAL_CODES)[number];

export interface RelaySetup {
  logPath: string;
  policy: { dir?: string; file?: string };
  secret: string;
  host: string;
  port: number;
  proposer: string;
  json: boolean;
}

export type RelayPreparation =
  | { ok: true; setup: RelaySetup }
  | { ok: false; code: RelayStartRefusalCode; message: string };

export interface RelayRequest {
  logPath: string;
  policy: { dir?: string; file?: string };
  listen: string | null;
  port: string | null;
  allowNonLoopback: boolean;
  proposer: string | null;
  json: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Everything that can fail without binding a port. Prints nothing. */
export function prepareRelay(request: RelayRequest): RelayPreparation {
  const environment = request.env ?? process.env;
  const raw = environment[RELAY_SECRET_ENV];
  const secret = raw === undefined ? "" : raw.trim();
  if (secret.length === 0) {
    return {
      ok: false,
      code: "relay-secret-missing",
      message: `no ${RELAY_SECRET_ENV} in the environment. The relay's only authentication is this shared secret, carried in ${RELAY_SECRET_HEADER}; without one, any post that looked like a gesture would be one. Generate it (\`openssl rand -hex 32\`), give the same value to the control plane, and set it in the environment this process is launched from, never in a file in the tree`,
    };
  }
  if (!SECRET_CHARSET.test(secret)) {
    return {
      ok: false,
      code: "relay-secret-charset",
      message: `${RELAY_SECRET_ENV} holds a value outside 1 to 256 characters of A-Z, a-z, 0-9, underscore and hyphen, which a header cannot be relied on to carry byte for byte. Its value is not shown here and is in no message this process writes`,
    };
  }
  if (secret.length < RELAY_MIN_SECRET_LENGTH) {
    return {
      ok: false,
      code: "relay-secret-weak",
      message: `${RELAY_SECRET_ENV} is shorter than ${String(RELAY_MIN_SECRET_LENGTH)} characters. Generate it (\`openssl rand -hex 32\`) rather than choosing it: it is the whole of what separates the operator's relay from anyone who can reach this port`,
    };
  }

  const proposer = request.proposer ?? RELAY_DEFAULT_PROPOSER;
  if (!PROPOSER_PATTERN.test(proposer)) {
    return {
      ok: false,
      code: "relay-proposer-invalid",
      message: `--proposer ${JSON.stringify(proposer)} is not an agent:<id> actor. A proposal is recorded under it, and the relay is a machine carrying what the control plane rendered: a human: id would say a person proposed something nobody typed`,
    };
  }

  if (request.listen !== null && request.port !== null) {
    return {
      ok: false,
      code: "relay-bind-invalid",
      message: "--listen and --port name the same thing; pass one. --listen <[host:]port> is the only way to bind a non-loopback interface",
    };
  }
  let host = RELAY_DEFAULT_HOST;
  let port = RELAY_DEFAULT_PORT;
  if (request.listen !== null) {
    const bind = parseListen(request.listen);
    if (!bind.ok) return { ok: false, code: "relay-bind-invalid", message: bind.message };
    host = bind.host;
    port = bind.port;
  } else if (request.port !== null) {
    if (!/^\d+$/u.test(request.port.trim())) {
      return {
        ok: false,
        code: "relay-bind-invalid",
        message: `--port expects a whole number, got ${JSON.stringify(request.port)}`,
      };
    }
    port = Number(request.port.trim());
  }
  if (port < 1 || port > 65535) {
    return {
      ok: false,
      code: "relay-bind-invalid",
      message: `the bind port ${String(port)} is outside 1..65535. Port 0 is refused too: the control plane posts to a fixed address, and an ephemeral port is one nobody would find`,
    };
  }
  if (!isLoopbackHost(host) && !request.allowNonLoopback) {
    return {
      ok: false,
      code: "relay-bind-invalid",
      message: `--listen ${JSON.stringify(host)} is not the loopback interface, and this process speaks plain HTTP: the relay secret arrives in a header and a cleartext hop hands it to whoever is on it. Add --allow-non-loopback if you meant it and TLS is terminated in front of this process`,
    };
  }

  return {
    ok: true,
    setup: {
      logPath: request.logPath,
      policy: request.policy,
      secret,
      host,
      port,
      proposer,
      json: request.json,
    },
  };
}

function usageError(streams: Streams, json: boolean, code: string, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code, message } })}\n`);
  else streams.err(usageErrorText(message, CHANNEL_RELAY_HELP));
  return EXIT_USAGE;
}

function failure(streams: Streams, json: boolean, code: string, message: string, exit: number): number {
  if (json) streams.err(`${JSON.stringify({ error: { code, message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return exit;
}

/** The banner a routable bind prints, every time, on stderr. */
export function relayNonLoopbackBanner(host: string, port: number): string {
  return [
    "",
    "  !! the approval relay IS BOUND TO A NON-LOOPBACK INTERFACE !!",
    `  ${host}:${String(port)} is reachable by anyone who can route to it, and this`,
    "  process speaks PLAIN HTTP. The relay secret travels in a header, and a",
    "  cleartext hop hands it to whoever is on it. Terminate TLS in front of this",
    "  process, or give it a loopback bind.",
    "",
    "",
  ].join("\n");
}

/** Run the relay until a signal stops it. */
export async function runRelay(setup: RelaySetup, streams: Streams): Promise<number> {
  const json = setup.json;

  // The log must be readable before anything binds: an operator who pointed
  // at the wrong store learns it here, not from the first refused gesture.
  const read = readVerifiedRecords(setup.logPath);
  if (!read.ok) {
    const exit = read.code === "log-torn-tail" ? EXIT_TORN_TAIL : read.code === "log-unreadable" ? EXIT_IO : EXIT_INTEGRITY;
    return failure(streams, json, read.code, read.message, exit);
  }

  // Not a refusal: a policy that maps no EdgeOS account is a legitimate state
  // (the operator has not mapped the resident yet), and the relay refuses
  // every gesture `sender-unmapped` until it does. Said once, at start.
  const load = readGatePolicy({ policy: setup.policy });
  if (!load.ok || !mapsSendersFor(load.policy.approvers, "edgeos")) {
    streams.err(
      `approval: relay: the policy ${load.ok ? "maps no edgeos sender" : `does not load (${load.code})`}, so every attest, decline, grant and reject will be refused sender-unmapped until an attested policy maps the person's EdgeOS id under approvers.<id>.senders.edgeos\n`,
    );
  }

  const report = (line: Record<string, unknown>, text: string): void => {
    if (json) streams.out(`${JSON.stringify(line)}\n`);
    else streams.out(`${text}\n`);
  };

  let handle: RelayHandle;
  try {
    handle = await serveRelay({
      logPath: setup.logPath,
      secret: setup.secret,
      ledger: fileNonceLedger(join(channelLeaseDirFor(setup.logPath), "relay-nonces")),
      host: setup.host,
      port: setup.port,
      gateOptions: { policy: setup.policy },
      proposer: setup.proposer,
      log: (message) => streams.err(`${message}\n`),
      // What reached the gate, by code: never the body, the sender id or the
      // secret. The record in the log is where the attribution lives.
      afterGesture: (response) => {
        const body = response.body;
        const gesture = String(body["gesture"] ?? "?");
        if (body["ok"] === true) {
          report(
            {
              event: "relay_gesture",
              gesture,
              ok: true,
              ...(body["seq"] === undefined ? {} : { seq: body["seq"] }),
              ...(body["event"] === undefined ? {} : { record: body["event"] }),
              ...(body["actor"] === undefined ? {} : { actor: body["actor"] }),
            },
            `relay ${gesture}: recorded seq ${String(body["seq"])}${body["actor"] === undefined ? "" : ` by ${String(body["actor"])}`}`,
          );
        } else {
          const refusal = body["refusal"] as { code?: unknown } | undefined;
          const code = String(refusal?.code ?? "?");
          report(
            { event: "relay_gesture", gesture, ok: false, code },
            `relay ${gesture}: refused (${code})`,
          );
        }
      },
    });
  } catch (cause) {
    return failure(
      streams,
      json,
      "io",
      `the relay could not bind ${setup.host}:${String(setup.port)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      EXIT_IO,
    );
  }

  if (!isLoopbackHost(handle.host)) streams.err(relayNonLoopbackBanner(handle.host, handle.port));
  if (json) {
    streams.out(
      `${JSON.stringify({ event: "relay_started", host: handle.host, port: handle.port, path: RELAY_PATH, proposer: setup.proposer })}\n`,
    );
  }
  streams.err(
    `approval: relay bound http://${handle.host}:${String(handle.port)}${RELAY_PATH}. Every post must carry ${RELAY_SECRET_HEADER}; gestures are attributed to the EdgeOS account the attested policy maps, never to this process. TLS is your proxy's. Press Ctrl-C to stop.\n`,
  );

  return await new Promise<number>((settle) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        await handle.close();
        if (json) streams.out(`${JSON.stringify({ event: "stopped", relay: handle.stats() })}\n`);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        settle(EXIT_OK);
      })();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/** `approval channel relay [flags]`. */
export async function commandChannelRelay(argv: string[], streams: Streams, cwd: string): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, RELAY_FLAGS);
  if (!parsed.ok) return usageError(streams, json, "usage", parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${CHANNEL_RELAY_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) return usageError(streams, json, "usage", `unexpected argument ${JSON.stringify(extra)}`);

  const flags = parsed.flags;
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  const prepared = prepareRelay({
    logPath: resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd),
    policy,
    listen: stringFlag(flags, "--listen"),
    port: stringFlag(flags, "--port"),
    allowNonLoopback: boolFlag(flags, "--allow-non-loopback"),
    proposer: stringFlag(flags, "--proposer"),
    json,
  });
  if (!prepared.ok) return usageError(streams, json, prepared.code, prepared.message);
  return await runRelay(prepared.setup, streams);
}
