/**
 * `approval channel web` — the runtime half of the local web queue channel
 * (SPEC.md §5.1 `channels.web.port`, §9, §10.3, §10.4, §11 — APRV-25).
 *
 * As everywhere else in this CLI, **no logic lives here**. Rendering and the
 * HTTP server are `channels/web.ts`; turning a submitted form into an event is
 * `channels/contract.ts`'s `recordChannelDecision` and `channels/batch.ts`'s
 * `recordBatchDecisions`, both of which call the human-only `decide()` in
 * `core/gate.ts`. This file resolves configuration, supplies the live pending
 * queue, wires the two together, and chooses an exit code.
 *
 * Three things it does that the channel deliberately cannot:
 *
 * 1. **It reads the log.** {@link buildPendingQueue} runs here, once per page
 *    view, and the channel is handed the resulting {@link ChannelRequest}s. A
 *    channel that read the log would be deriving the facts it is meant to be
 *    transporting. Because that read happens per *request* rather than per
 *    process, this channel needs no dispatch of its own (APRV-55): a request
 *    appended while the server is running appears on the next page load, and a
 *    decided or TTL-lapsed one disappears the same way. Pull channels get for
 *    free what the Telegram listener has to arrange with a per-cycle send.
 * 2. **It declares who is approving.** `--as` / `APPROVAL_HUMAN`, never
 *    anything the browser sent — there is nothing in an unauthenticated form
 *    post that could name a person. SPEC.md §11: identity is config-declared,
 *    the trust boundary is the local machine, and the page says so in a banner
 *    because the page is where the human is looking.
 * 3. **It holds the token.** `recordChannelDecision` returns the raw execution
 *    token to *this* handler, which hands it back to the channel as one-shot
 *    *notice text* at render time and keeps no copy. See `channels/web.ts`'s
 *    header for why this channel shows the token on the page while the Telegram
 *    channel refuses to put it in a chat — that asymmetry is flagged there.
 *
 * ## Port precedence
 *
 * `--port` > `channels.web.port` in the attested policy > 4680. Nothing else:
 * no environment variable, because a port that moves when an unrelated variable
 * is exported is a port an operator will eventually fail to find, and no
 * `--host` at any precedence at all (`channels/web.ts` explains).
 *
 * ## Identity is required at startup
 *
 * Unlike `approval channel cli`, which may merely *list* a queue, this verb
 * exists to collect decisions: its only output is a page with Grant and Reject
 * buttons on it. Starting a server whose buttons cannot record anything would
 * spend a human's attention and then refuse their answer, so a missing or
 * non-human identity is a usage error (2) before the socket is bound.
 */

import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import { recordBatchDecisions } from "../channels/batch.js";
import {
  recordChannelDecision,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
} from "../channels/contract.js";
import { buildPendingQueue, type PayloadSource, type TagOptions } from "../channels/tagging.js";
import {
  WebChannel,
  WEB_DEFAULT_PORT,
  type WebBatchOutcome,
} from "../channels/web.js";
import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import type { DecideOptions } from "../core/gate.js";
import { loadPolicy, type PolicyLoadResult } from "../core/policy-load.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { WEB_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";

const FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--payload-dir": "string",
  "--port": "string",
  "--as": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${WEB_HELP}\n`);
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

// ---------------------------------------------------------------------------
// Port resolution
// ---------------------------------------------------------------------------

/**
 * `channels.web.port` from a loaded policy, or `null`.
 *
 * A policy that does not load, does not declare `channels`, or declares a port
 * that is not a usable TCP port yields `null` — which means the default, not a
 * crash: an operator whose policy has a typo in an optional cosmetic field
 * should still get a queue page.
 */
export function policyWebPort(load: PolicyLoadResult): number | null {
  if (!load.ok) return null;
  const web = load.policy.channels?.["web"];
  const port = web === undefined ? undefined : web["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    return null;
  }
  return port;
}

export type PortResolution = { ok: true; port: number } | { ok: false; message: string };

/** `--port` > policy `channels.web.port` > {@link WEB_DEFAULT_PORT}. */
export function resolveWebPort(portFlag: string | null, fromPolicy: number | null): PortResolution {
  if (portFlag !== null) {
    if (!/^\d+$/u.test(portFlag)) {
      return {
        ok: false,
        message: `--port expects a whole number, got ${JSON.stringify(portFlag)}`,
      };
    }
    const port = Number.parseInt(portFlag, 10);
    if (port > 65_535) {
      return { ok: false, message: `--port ${port} is outside the TCP port range` };
    }
    return { ok: true, port };
  }
  return { ok: true, port: fromPolicy ?? WEB_DEFAULT_PORT };
}

// ---------------------------------------------------------------------------
// Payload material
// ---------------------------------------------------------------------------

/**
 * Payload material for one action key, from `--payload-dir` — the same shape
 * `approval channel cli` uses, deliberately, so an operator's payload directory
 * works with either channel.
 *
 * An override since APRV-28: with no flag the bytes come from the payload store
 * beside the log, so the ordinary path needs no directory at all. This answers
 * first for the keys it covers, and the store answers for the rest.
 *
 * The tagger re-hashes whatever this returns and refuses anything that does not
 * match the recorded binding, so a wrong file produces a visible skip rather
 * than a rendering of bytes the token would refuse to execute.
 */
export function payloadSource(dir: string, complain: (message: string) => void): PayloadSource {
  return (actionKey) => {
    for (const name of [`${encodeURIComponent(actionKey)}.json`, `${actionKey}.json`]) {
      if (name.includes("/") || name.includes("\\")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch (cause) {
        complain(
          `approval: payload material for ${actionKey} (${join(dir, name)}) is not valid JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }; the request will be skipped rather than rendered from bytes nobody could bind`,
        );
        return undefined;
      }
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// startWebChannel
// ---------------------------------------------------------------------------

export interface StartWebChannelOptions {
  /** The log to read the queue from, and to append decisions to. */
  logPath: string;
  /** The approver every decision is recorded against. Must be `human:<id>`. */
  actor: string;
  /** Where `APPROVAL.md` lives; passed to the tagger and to the gate. */
  policy?: { dir?: string; file?: string };
  /** Port to bind. `0` asks the OS for an ephemeral one (tests). */
  port?: number;
  /** Payload material for manual requests (SPEC.md §10.4). */
  payload?: PayloadSource;
  /** Where operational complaints go. Defaults to stderr. */
  log?: (message: string) => void;
  /** The display instant for each queue build. Injectable for tests. */
  now?: () => string;
  /** Extra gate options (an injected clock, a schema dir). */
  gateOptions?: DecideOptions;
}

/** A running web channel. `close()` releases the socket. */
export interface RunningWebChannel {
  server: Server;
  channel: WebChannel;
  port: number;
  close(): Promise<void>;
}

/**
 * Start the server and wire it to the gate.
 *
 * Exported for the tests and for the M5 daemon: the verb below is a thin shell
 * around this, and a caller that wants a queue page inside its own process
 * should not have to spawn a CLI to get one.
 */
export async function startWebChannel(
  options: StartWebChannelOptions,
): Promise<RunningWebChannel> {
  const complain =
    options.log ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
  const now = options.now ?? (() => new Date().toISOString());
  const policy = options.policy ?? {};
  const gateOptions: DecideOptions = { policy, ...options.gateOptions };
  const tagOptions: TagOptions = {
    policy,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  };

  /**
   * The live queue, rebuilt on every page view.
   *
   * A refusal (an unreadable or corrupt log) is complained about and rendered
   * as an empty queue rather than thrown: a page that showed stale requests
   * from a log that no longer verifies would be the one failure this project
   * exists to prevent. Skipped requests are reported too — a manual request
   * whose payload material is missing is a request nobody will approve, and
   * silence about it would look identical to an empty queue.
   */
  const refresh = (): ChannelRequest[] => {
    const queue = buildPendingQueue(options.logPath, tagOptions, now());
    if (!queue.ok) {
      complain(`approval: web channel cannot build the queue (${queue.code}): ${queue.message}`);
      return [];
    }
    for (const skipped of queue.skipped) {
      complain(
        `approval: web channel cannot render ${skipped.action_key} (${skipped.code}): ${skipped.message}`,
      );
    }
    return queue.requests;
  };

  // The one-shot token, held for exactly as long as it takes to render the
  // response that shows it. Never written anywhere else.
  let lastToken: { action_key: string; token: string } | null = null;

  const channel = new WebChannel({
    ...(options.port === undefined ? {} : { port: options.port }),
    refresh,
    actorLabel: options.actor,
    log: complain,
    decisionNotice: (decision, outcome) => {
      if (!outcome.ok || lastToken === null || lastToken.action_key !== decision.action_key) {
        return null;
      }
      const text = `execution token for ${decision.action_key}: ${lastToken.token}`;
      lastToken = null;
      return text;
    },
  });

  channel.onDecision((decision: ChannelDecision): DecisionOutcome => {
    const result = recordChannelDecision(
      options.logPath,
      decision,
      { actor: options.actor, channel: channel.name },
      gateOptions,
    );
    lastToken =
      result.token === undefined
        ? null
        : { action_key: decision.action_key, token: result.token };
    return result.outcome;
  });

  // The log never batches (SPEC.md §10.3): this is one `decide()` per member,
  // each carrying the batch delivery id, with partial success a real outcome.
  channel.onBatchDecision((decisions, batchDeliveryId): WebBatchOutcome[] => {
    const recorded = recordBatchDecisions(
      options.logPath,
      decisions,
      batchDeliveryId,
      { actor: options.actor, channel: channel.name },
      gateOptions,
    );
    return recorded.results.map((entry) => ({
      action_key: entry.action_key,
      outcome: entry.outcome,
      ...(entry.token === undefined
        ? {}
        : { notice: `execution token for ${entry.action_key}: ${entry.token}` }),
    }));
  });

  const address = await channel.start();
  const server = channel.server;
  if (server === null) throw new Error("the web channel started without a server");
  return {
    server,
    channel,
    port: address.port,
    close: () => channel.close(),
  };
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * `approval channel web` — serve the queue until interrupted.
 *
 * Long-lived, like `approval channel telegram listen`: it returns a promise
 * that settles on SIGINT/SIGTERM, which is why `main` treats `channel`
 * specially. There is no `--once`: a page is fetched by a human whenever they
 * choose to look, so "handle exactly one request and exit" would be a shape
 * nobody wants. Tests drive {@link startWebChannel} directly instead.
 */
export function commandWeb(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${WEB_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const flags = parsed.flags;

  // Identity first: a server whose buttons cannot record anything is worse
  // than no server, because it costs a human their attention before refusing.
  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>. Every decision this page collects is recorded against it (SPEC.md §11: identity is config-declared)`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; approvals are human-only`,
    );
  }

  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  const port = resolveWebPort(
    stringFlag(flags, "--port"),
    policyWebPort(loadPolicy(policy.file === undefined ? { dir: policy.dir as string } : { file: policy.file })),
  );
  if (!port.ok) return usageError(streams, json, port.message);

  const payloadDir = stringFlag(flags, "--payload-dir");
  return serve(
    {
      logPath,
      actor,
      policy,
      port: port.port,
      ...(payloadDir === null
        ? {}
        : {
            payload: payloadSource(absolute(payloadDir, cwd), (message) =>
              streams.err(`${message}\n`),
            ),
          }),
      log: (message: string) => streams.err(`${message}\n`),
    },
    streams,
    json,
  );
}

async function serve(
  options: StartWebChannelOptions,
  streams: Streams,
  json: boolean,
): Promise<number> {
  let running: RunningWebChannel;
  try {
    running = await startWebChannel(options);
  } catch (cause) {
    return ioError(
      streams,
      json,
      `the web channel could not bind 127.0.0.1:${options.port ?? WEB_DEFAULT_PORT}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const url = `http://127.0.0.1:${running.port}/`;
  if (json) {
    streams.out(
      `${JSON.stringify({
        event: "listening",
        channel: "web",
        url,
        host: "127.0.0.1",
        port: running.port,
        actor: options.actor,
      })}\n`,
    );
  } else {
    streams.out(`approval: the pending queue is at ${url} (loopback only; ctrl-c to stop)\n`);
    streams.out(
      `approval: this page has NO authentication — anyone with access to this machine can decide as ${options.actor} (SPEC.md §11)\n`,
    );
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void running.close().then(() => resolve());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

  if (json) streams.out(`${JSON.stringify({ event: "stopped", ...running.channel.stats() })}\n`);
  return EXIT_OK;
}
