/**
 * The token verbs: `approval token` (status) and `approval consume` (plumbing).
 *
 * As everywhere else in this CLI, **no logic lives here.** Minting, verification,
 * the death conditions, and the append are all `core/token.ts`; this file
 * resolves paths and identity, chooses an exit code, and formats output.
 *
 * ## `approval token` reports status; it does not print the token
 *
 * SPEC.md §10.1 lists `approval token <action-key>  # print single-use execution
 * token if granted`. Under the settled hash-only design (2026-08-06) the log
 * carries `sha256(token)` and the raw token is returned by the grant call and
 * kept nowhere else — so there is nothing for this verb to fetch. It would have
 * to *store* the secret to print it, which is precisely the property the design
 * exists to avoid.
 *
 * The honest reading, and the one implemented here: the token is printed **by
 * `approval grant`**, once; `approval token` answers "is a live, unspent token
 * outstanding for this action, and what is its digest?". That interpretation is
 * flagged in the task notes for human review — it is a reading of the spec, not
 * a silent amendment of it, and §10.4's normative sentence (adapters MUST
 * require a valid, unexpired, single-use token bound to the idempotency key) is
 * unaffected either way.
 *
 * ## `approval consume` is internal
 *
 * It is the seam APRV-18's `approval run` will wrap: verify, append
 * `execution.started`, hand control to the command. It ships now so the token
 * boundary is testable end to end and so an adapter integration can be driven by
 * hand, and its help text says INTERNAL in the first line.
 *
 * Exit codes are the frozen table, mapped exactly as the gate verbs map them: a
 * refusal ("that token will not execute") is 1, because the command was
 * well-formed and the answer is no; only filesystem facts are 4 and only a
 * crashed write is 3.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { readVerifiedRecords } from "../core/state.js";
import {
  consumeToken,
  tokenStatus,
  tokenTtlMs,
  type TokenOptions,
  type TokenRefusal,
} from "../core/token.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { CONSUME_HELP, TOKEN_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";

/** Identity accepted by `consume`: a person or an agent, never the runtime. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

const COMMON_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
  "--policy": "string",
  "--dir": "string",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

/** The same split the gate verbs draw: integrity unless the filesystem spoke. */
function refusalExitCode(refusal: TokenRefusal): number {
  switch (refusal.code) {
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    case "append-failed":
      switch (refusal.append?.code) {
        case "corrupt-tail":
          return EXIT_TORN_TAIL;
        case "io":
        case "lock-timeout":
          return EXIT_IO;
        default:
          return EXIT_INTEGRITY;
      }
    default:
      return EXIT_INTEGRITY;
  }
}

function emitRefusal(streams: Streams, json: boolean, refusal: TokenRefusal): number {
  if (json) {
    const error: Record<string, unknown> = { code: refusal.code, message: refusal.message };
    if (refusal.state !== undefined) error["state"] = refusal.state;
    if (refusal.seq !== undefined) error["seq"] = refusal.seq;
    streams.err(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    streams.err(`approval: ${refusal.code}: ${refusal.message}\n`);
  }
  return refusalExitCode(refusal);
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/** Where policy lives, from `--policy` / `--dir`, with the CLI's cwd default. */
function tokenOptions(flags: Record<string, string | boolean>, cwd: string): TokenOptions {
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  if (policyFlag !== null) return { policyFile: absolute(policyFlag, cwd) };
  return { policyDir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
}

/** The clock is read here, at the edge, and handed to core. */
function now(): string {
  return new Date().toISOString();
}

interface Front {
  flags: Record<string, string | boolean>;
  positionals: string[];
  json: boolean;
  logPath: string;
}

type FrontOutcome = { kind: "handled"; code: number } | ({ kind: "run" } & Front);

function front(
  argv: string[],
  spec: Record<string, FlagKind>,
  helpText: string,
  streams: Streams,
  cwd: string,
): FrontOutcome {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) {
    return { kind: "handled", code: usageError(streams, json, parsed.message, helpText) };
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${helpText}\n`);
    return { kind: "handled", code: EXIT_OK };
  }
  return {
    kind: "run",
    flags: parsed.flags,
    positionals: parsed.positionals,
    json,
    logPath: resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd),
  };
}

/** `<action-key>` and nothing else. */
function actionKeyOf(
  positionals: string[],
  streams: Streams,
  json: boolean,
  helpText: string,
): { ok: true; actionKey: string } | { ok: false; code: number } {
  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return { ok: false, code: usageError(streams, json, "missing <action-key> argument", helpText) };
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return {
      ok: false,
      code: usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, helpText),
    };
  }
  return { ok: true, actionKey };
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

export function commandToken(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(argv, COMMON_FLAGS, TOKEN_HELP, streams, cwd);
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const key = actionKeyOf(positionals, streams, json, TOKEN_HELP);
  if (!key.ok) return key.code;

  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    return emitRefusal(streams, json, {
      ok: false,
      // The read refusal's code is already one of this command's codes
      // (`log-unreadable`, `log-torn-tail`, `log-corrupt`); it is surfaced
      // unchanged so a corrupt log is reported as corruption, not as I/O.
      code: read.code,
      message: read.message,
    });
  }

  const options = tokenOptions(flags, cwd);
  const status = tokenStatus(read.records, key.actionKey, now(), tokenTtlMs(options));
  if (!status.ok) return emitRefusal(streams, json, status);

  if (json) {
    emitJson(streams, {
      ok: true,
      action_key: status.actionKey,
      state: "granted",
      live: true,
      token_sha256: status.tokenSha256,
      grant_seq: status.grantSeq,
      class: status.class,
      est_cost_usd: status.est_cost_usd,
      task: status.task,
    });
  } else {
    streams.out(
      `${status.actionKey}: granted at seq ${status.grantSeq}, token live and unspent\n` +
        `token_sha256: ${status.tokenSha256}\n` +
        `The raw token was printed once by \`approval grant\` and is stored nowhere — ` +
        `if it was lost, revoke the grant and request the action again.\n`,
    );
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

export function commandConsume(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, "--token": "string", "--as": "string" },
    CONSUME_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const key = actionKeyOf(positionals, streams, json, CONSUME_HELP);
  if (!key.ok) return key.code;

  const token = stringFlag(flags, "--token");
  if (token === null) {
    return usageError(streams, json, "missing --token <t>", CONSUME_HELP);
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = asFlag === null ? resolveHumanActor() : asFlag;
  if (actor === null || !PRINCIPAL_ACTOR.test(actor)) {
    if (asFlag !== null) {
      return usageError(
        streams,
        json,
        `--as expects human:<id> or agent:<id>, got ${JSON.stringify(asFlag)}`,
        CONSUME_HELP,
      );
    }
    return usageError(
      streams,
      json,
      `no identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id> | agent:<id>`,
      CONSUME_HELP,
    );
  }

  const result = consumeToken(
    logPath,
    key.actionKey,
    token,
    now(),
    actor,
    tokenOptions(flags, cwd),
  );
  if (!result.ok) return emitRefusal(streams, json, result);

  const payload = (result.record.payload ?? {}) as Record<string, unknown>;
  if (json) {
    emitJson(streams, {
      ok: true,
      action_key: key.actionKey,
      event: "execution.started",
      seq: result.record.seq,
      token_sha256: result.tokenSha256,
      grant_seq: result.grantSeq,
      class: payload["class"] ?? null,
      est_cost_usd: payload["est_cost_usd"] ?? null,
    });
  } else {
    streams.out(
      `consumed ${key.actionKey}: execution.started at seq ${result.record.seq} by ${actor} (token minted at seq ${result.grantSeq})\n`,
    );
  }
  return EXIT_OK;
}
