/**
 * `approval adapter email` — execute an approved email through the adapter
 * contract (SPEC.md §10.4; APRV-69).
 *
 * This is the CLI face of `src/adapters/email.ts`, and it is deliberately the
 * thinnest one in the repository. It resolves paths and identity, reads the
 * payload bytes at the edge, builds the vault-backed credential provider, calls
 * {@link executeThroughAdapter} once, and maps the result onto the frozen exit
 * table. It does not verify a token, hash a payload, append an event, or open a
 * socket: every one of those belongs to a layer that already owns it, and a verb
 * that reimplemented any of them would be a second implementation of the rule.
 *
 * **Why the payload is a file (or stdin) and never a flag.** The bytes are the
 * thing the grant approved, they routinely contain newlines, quotes and a
 * £-sign, and a message body on a command line is a message body in the shell
 * history and in `ps` output. `approval payload hash <file|->` and
 * `approval request --payload <file>` take the same argument in the same form,
 * so the same file travels from declaration to request to execution.
 *
 * **What `--json` prints is the contract's own result shape**, unmodified:
 * `AdapterExecuteSuccess` on stdout for a completed send,
 * `AdapterRefusal` on stderr for anything else. There is no CLI-flavoured
 * summary, because a caller parsing this is a caller who wants to know
 * `started_seq`, `outcome_seq` and `adapter_code` — and inventing a second
 * vocabulary for them here would be a second thing to keep in step with
 * `contract.ts`.
 *
 * ## Exit codes
 *
 * The `approval run` table, unchanged and shared with it through
 * {@link executeRefusalExitCode}:
 *
 * | Situation | Code |
 * |---|---|
 * | the message was accepted by the far side | 0 |
 * | usage: a missing flag, a bad identity, an unparseable payload | 2 |
 * | I/O: the payload file or the log could not be read | 4 |
 * | `token-required` — no token was presented | 5 |
 * | `log-torn-tail`, or an append that hit a torn tail | 3 |
 * | anything else the runtime decided: `token-mismatch`, `token-consumed`, `payload-mismatch`, `adapter-class-mismatch`, `adapter-failed` (an SMTP refusal), `adapter-act-threw` | 1 |
 *
 * A refused SEND is exit 1 and not 5: the command was well-formed, the token was
 * good, and the answer from the world was no. Only the absence of a valid token
 * earns 5, which is the distinction `run` already draws and the one an agent's
 * retry logic keys on.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { emailAdapter } from "../adapters/email.js";
import { vaultCredentialProvider } from "../adapters/vault-provider.js";
import {
  executeThroughAdapter,
  type AdapterExecuteResult,
  type JsonValue,
} from "../adapters/contract.js";
import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import { passphraseEnvFor, vaultPathFor } from "../core/vault.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { executeRefusalExitCode } from "./execute.js";
import { ADAPTER_EMAIL_HELP, ADAPTER_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";

/** Identity accepted here: a person or an agent, never the runtime. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

const EMAIL_FLAGS: Record<string, FlagKind> = {
  "--token": "string",
  "--payload": "string",
  "--as": "string",
  "--vault": "string",
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--timeout": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A refusal from the adapter path onto the exit table.
 *
 * Core refusals carry their own `execute` record and are mapped exactly as
 * `approval run` maps them, through the shared function. The adapter path's own
 * additions — a misroute, an unhashable payload, a failed or throwing `act` —
 * are all exit 1: the command was well-formed and the answer is no.
 */
function refusalExit(result: AdapterExecuteResult & { ok: false }): number {
  return result.execute === undefined ? EXIT_INTEGRITY : executeRefusalExitCode(result.execute);
}

/** `approval adapter email <action-key> --token <t> --payload <file|->`. */
export async function commandAdapterEmail(
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, EMAIL_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, ADAPTER_EMAIL_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${ADAPTER_EMAIL_HELP}\n`);
    return EXIT_OK;
  }
  const { flags, positionals } = parsed;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", ADAPTER_EMAIL_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      ADAPTER_EMAIL_HELP,
    );
  }

  const token = stringFlag(flags, "--token");
  if (token === null) {
    return usageError(
      streams,
      json,
      "missing --token <t>: an adapter executes only against the single-use token `approval grant` printed (SPEC.md §10.4)",
      ADAPTER_EMAIL_HELP,
    );
  }

  const payloadFlag = stringFlag(flags, "--payload");
  if (payloadFlag === null) {
    return usageError(
      streams,
      json,
      "missing --payload <file|->: the bytes the grant approved. There is no flag that takes the message inline — a body on a command line is a body in the shell history",
      ADAPTER_EMAIL_HELP,
    );
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = asFlag === null ? resolveHumanActor() : asFlag;
  if (actor === null || !PRINCIPAL_ACTOR.test(actor)) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id> | agent:<id>`
        : `--as expects human:<id> or agent:<id>, got ${JSON.stringify(asFlag)}`,
      ADAPTER_EMAIL_HELP,
    );
  }

  const timeoutFlag = stringFlag(flags, "--timeout");
  let timeoutMs: number | null = null;
  if (timeoutFlag !== null) {
    const parsedTimeout = Number(timeoutFlag);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
      return usageError(
        streams,
        json,
        `--timeout expects a whole number of milliseconds, got ${JSON.stringify(timeoutFlag)}`,
        ADAPTER_EMAIL_HELP,
      );
    }
    timeoutMs = parsedTimeout;
  }

  // The payload bytes. Read at the edge, parsed here, and handed to the
  // contract as a value — the contract hashes it, and nobody states a hash.
  const where = payloadFlag === "-" ? "stdin" : absolute(payloadFlag, cwd);
  let raw: string;
  try {
    raw = readFileSync(payloadFlag === "-" ? 0 : where, "utf8");
  } catch (cause) {
    return ioError(streams, json, `${where} could not be read: ${detail(cause)}`);
  }
  if (raw.trim().length === 0) {
    return usageError(streams, json, `${where} is empty; there is no payload`, ADAPTER_EMAIL_HELP);
  }
  let payload: JsonValue;
  try {
    payload = JSON.parse(raw) as JsonValue;
  } catch (cause) {
    return usageError(
      streams,
      json,
      `${where} is not valid JSON: ${detail(cause)}. payload_hash is defined over the RFC 8785 canonical serialization of the payload VALUE (SPEC.md §6.2), so bytes that do not parse cannot be the bytes a grant bound to`,
      ADAPTER_EMAIL_HELP,
    );
  }

  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policyLocation =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  const vaultFlag = stringFlag(flags, "--vault");
  const vaultPath = vaultFlag === null ? vaultPathFor(logPath) : absolute(vaultFlag, cwd);
  const credentials = vaultCredentialProvider(
    { vaultPath },
    { passphraseEnv: passphraseEnvFor(loadPolicy(policyLocation)) },
  );

  const result = await executeThroughAdapter(
    emailAdapter(timeoutMs === null ? {} : { timeoutMs }),
    { logPath, actionKey, payload, actor },
    { token, policy: policyLocation, credentials },
  );

  if (!result.ok) {
    if (json) streams.err(`${JSON.stringify(result)}\n`);
    else {
      streams.err(
        `approval: ${result.code}${result.adapter_code === undefined ? "" : ` (${result.adapter_code})`}: ${result.message}\n`,
      );
    }
    return refusalExit(result);
  }

  if (json) streams.out(`${JSON.stringify(result)}\n`);
  else {
    streams.out(
      `sent ${actionKey} through the email adapter: execution.started at seq ${String(result.started_seq)}, execution.completed at seq ${String(result.outcome_seq)}\n`,
    );
  }
  return EXIT_OK;
}

/** `approval adapter <name>` — one adapter at v0.1: `email`. */
export async function commandAdapter(
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing adapter name for `approval adapter`", ADAPTER_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${ADAPTER_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "email") return commandAdapterEmail(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown adapter ${JSON.stringify(sub)} for \`approval adapter\``,
    ADAPTER_HELP,
  );
}
