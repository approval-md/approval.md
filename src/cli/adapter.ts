/**
 * `approval adapter <name>` — execute an approved action through the adapter
 * contract (SPEC.md §10.4; APRV-69, generalized in APRV-221).
 *
 * This is the CLI face of the adapters in {@link ADAPTER_CLIS} (`email` at
 * v0.1), and it is deliberately the thinnest one in the repository. The name is
 * a table lookup and the body below it is adapter-agnostic: a second adapter is
 * an entry in the table and nothing else in this file.
 *
 * It resolves paths and identity, reads the
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
  type Adapter,
  type AdapterExecuteResult,
  type JsonValue,
} from "../adapters/contract.js";
import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import { envFilePathFor } from "../core/env-file.js";
import { passphraseEnvFor, vaultPathFor } from "../core/vault.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { executeRefusalExitCode } from "./execute.js";
import { ADAPTER_EMAIL_HELP, ADAPTER_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** One adapter, as `approval adapter <name>` needs to see it. */
export interface AdapterCliEntry {
  /** The verb's own help: printed for --help, and beside every usage error. */
  help: string;
  /**
   * The adapter instance to execute through, built per invocation because
   * `--timeout` is per invocation. Nothing else about the adapter is this
   * verb's business: the contract routes, hashes, spends and appends.
   */
  build(options: { timeoutMs?: number }): Adapter;
}

/**
 * Every adapter this verb can execute, keyed by the `adapter <name>` name.
 *
 * The table IS the dispatch (APRV-221): a second adapter is a second entry
 * here, and no line below this one names an adapter. `cli/setup-adapter.ts`
 * holds the matching table for the credential side and `adapters/registry.ts`
 * the roster the credential scrub reads. An adapter that ships is an entry in
 * all three, which is three small tables rather than one import cycle between
 * the CLI and the adapters.
 */
export const ADAPTER_CLIS: Record<string, AdapterCliEntry> = {
  email: {
    help: ADAPTER_EMAIL_HELP,
    build: (options) => emailAdapter(options),
  },
};

/** The known names, sorted, for a usage error and for the help text. */
export function knownAdapterNames(): string[] {
  return Object.keys(ADAPTER_CLIS).sort();
}

/** Identity accepted here: a person or an agent, never the runtime. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

/**
 * The flags every adapter verb takes. One set and not one per adapter: what the
 * runtime needs in order to execute an approved action (the token, the bytes,
 * the identity, the log, the vault) is the same question whoever answers it,
 * and a per-adapter flag table would be a per-adapter way to drift from
 * `approval run`. An adapter with a flag of its own adds it here, beside these.
 */
const ADAPTER_FLAGS: Record<string, FlagKind> = {
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
  else streams.err(usageErrorText(message, helpText));
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

/**
 * `approval adapter <name> <action-key> --token <t> --payload <file|->`.
 *
 * One implementation for every entry in {@link ADAPTER_CLIS}: the name and the
 * entry are arguments, and everything this function does (the flags, the
 * payload read, the identity check, the vault, the exit table) is the same
 * whichever adapter is on the other end. What differs between adapters is the
 * contract's business, and the contract is not here.
 */
export async function commandAdapterExecute(
  name: string,
  entry: AdapterCliEntry,
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const help = entry.help;
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, ADAPTER_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, help);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${help}\n`);
    return EXIT_OK;
  }
  const { flags, positionals } = parsed;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", help);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      help,
    );
  }

  const token = stringFlag(flags, "--token");
  if (token === null) {
    return usageError(
      streams,
      json,
      "missing --token <t>: an adapter executes only against the single-use token `approval grant` printed",
      help,
    );
  }

  const payloadFlag = stringFlag(flags, "--payload");
  if (payloadFlag === null) {
    return usageError(
      streams,
      json,
      "missing --payload <file|->: the bytes the grant approved. There is no flag that takes the message inline — a body on a command line is a body in the shell history",
      help,
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
      help,
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
        help,
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
    return usageError(streams, json, `${where} is empty; there is no payload`, help);
  }
  let payload: JsonValue;
  try {
    payload = JSON.parse(raw) as JsonValue;
  } catch (cause) {
    return usageError(
      streams,
      json,
      `${where} is not valid JSON: ${detail(cause)}. payload_hash is defined over the RFC 8785 canonical serialization of the payload VALUE, so bytes that do not parse cannot be the bytes a grant bound to`,
      help,
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
    {
      passphraseEnv: passphraseEnvFor(loadPolicy(policyLocation)),
      // APRV-168. This verb executes through the adapter contract, so its
      // credential reads happen inside a window a human's grant opened. That is
      // the one place the environment source map may answer for the vault
      // passphrase when the process was launched without it; see
      // `adapters/env-passphrase.ts`. The provider still prefers the ambient
      // variable, and every other caller of `vaultCredentialProvider` omits
      // this and keeps the old behaviour exactly.
      envFilePath: envFilePathFor(logPath),
    },
  );

  const result = await executeThroughAdapter(
    entry.build(timeoutMs === null ? {} : { timeoutMs }),
    { logPath, actionKey, payload, actor },
    { token, policy: policyLocation, credentials },
  );

  if (!result.ok) {
    if (json) streams.err(`${JSON.stringify(result)}\n`);
    else {
      streams.err(
        // APRV-102: the one refusal shape. The adapter's own code, when it has
        // one, rides in the machine-readable column beside the runtime's, since
        // that pair is what an operator reports and an agent branches on.
        `${renderRefusal(
          style({ json }),
          `${result.code}${result.adapter_code === undefined ? "" : ` (${result.adapter_code})`}`,
          result.message,
        )}\n`,
      );
    }
    return refusalExit(result);
  }

  if (json) streams.out(`${JSON.stringify(result)}\n`);
  else {
    streams.out(
      `sent ${actionKey} through the ${name} adapter: execution.started at seq ${String(result.started_seq)}, execution.completed at seq ${String(result.outcome_seq)}\n`,
    );
  }
  return EXIT_OK;
}

/** `approval adapter <name>` — resolve the name through {@link ADAPTER_CLIS}. */
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
  const entry = ADAPTER_CLIS[sub];
  if (entry !== undefined) return commandAdapterExecute(sub, entry, rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown adapter ${JSON.stringify(sub)} for \`approval adapter\`; known adapters: ${knownAdapterNames().join(", ")}`,
    ADAPTER_HELP,
  );
}
