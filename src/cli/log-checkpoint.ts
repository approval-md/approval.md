/**
 * The CLI edge of `approval log checkpoint` (APRV-220).
 *
 * As everywhere else in this CLI, no logic lives here: `core/checkpoint.ts`
 * signs and appends, and this file splits argv, decides WHERE the private key
 * may come from, maps the result onto the frozen exit table, and decides what a
 * terminal sees.
 *
 * ## Where the key may come from, and why that decision is here
 *
 * `core/checkpoint.ts` takes the private key as a value and reads it from
 * nowhere. That is deliberate: custody is a policy question, and answering it in
 * one place means there is one file to read to learn every way a checkpoint key
 * can reach a signature.
 *
 * Two sources, in this order:
 *
 * 1. `--key-file <path>`, for a key an operator keeps outside the vault (an
 *    offline machine, a hardware-backed export, a paper backup being restored).
 *    The path is one a human typed.
 * 2. The credential vault, under `approval.checkpoint.key`. Encrypted at rest
 *    under a passphrase `core/child-env.ts` strips from every spawned child,
 *    behind a file whose reading classifies `account.credential` (human-only).
 *
 * There is no environment variable holding the key itself and no `--key` flag:
 * a key on a command line is a key in the shell history, and a key in the
 * session environment is a key every child the session launches inherits — the
 * exact failure APRV-205 exists to have fixed.
 *
 * This verb reads a credential, which makes it the second sanctioned caller of
 * `getCredential` after `adapters/vault-provider.ts`. It is the same shape as
 * the first: the value travels from the vault file into a signature and is
 * never printed, returned, or logged. There is still no verb that PRINTS a
 * credential, which is the rule `core/vault.ts` is actually keeping.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  appendCheckpoint,
  CHECKPOINT_KEY_CREDENTIAL,
  type CheckpointAppendResult,
} from "../core/checkpoint.js";
import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import { getCredential, passphraseEnvFor, passphraseFrom, vaultPathFor } from "../core/vault.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { LOG_CHECKPOINT_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const CHECKPOINT_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--as": "string",
  "--key-file": "string",
  "--vault": "string",
  "--policy": "string",
  "--dir": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const DEFAULT_LOG_PATH = ".approval/log/events.jsonl";

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, LOG_CHECKPOINT_HELP));
  return EXIT_USAGE;
}

/**
 * The exit code for a refusal.
 *
 * `log-corrupt` and `log-torn-tail` are integrity facts about the chain and go
 * where `log verify` puts them; everything else here is a filesystem, key, or
 * writer fact, which is exit 4. Nothing in this verb reports a missing key as
 * corruption: an operator without a key has not got a broken log.
 */
function refusalExit(code: string): number {
  return code === "log-corrupt" || code === "log-torn-tail" ? EXIT_INTEGRITY : EXIT_IO;
}

/** The private key, or a refusal naming which source failed and how to fix it. */
function resolveSigningKey(
  keyFile: string | null,
  logPath: string,
  vaultFlag: string | null,
  policyWhere: { file?: string; dir?: string },
  cwd: string,
): { ok: true; privateKey: string } | { ok: false; code: string; message: string } {
  if (keyFile !== null) {
    const path = absolute(keyFile, cwd);
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch (cause) {
      return {
        ok: false,
        code: "checkpoint-key-unreadable",
        message: `--key-file ${path} could not be read (${
          cause instanceof Error ? cause.message : String(cause)
        }); nothing was appended`,
      };
    }
    if (text.length === 0) {
      return {
        ok: false,
        code: "checkpoint-key-unreadable",
        message: `--key-file ${path} is empty; a checkpoint key is a base64 PKCS#8 Ed25519 private key on one line. Nothing was appended`,
      };
    }
    return { ok: true, privateKey: text };
  }

  const vaultPath = vaultFlag === null ? vaultPathFor(logPath) : absolute(vaultFlag, cwd);
  const passphraseEnv = passphraseEnvFor(loadPolicy(policyWhere));
  const passphrase = passphraseFrom(passphraseEnv);
  if (passphrase === null) {
    return {
      ok: false,
      code: "checkpoint-key-unreadable",
      message: `${passphraseEnv} is unset or empty, so the vault holding ${CHECKPOINT_KEY_CREDENTIAL} could not be opened. The passphrase is read from that variable and from nowhere else; there is no --passphrase flag. Nothing was appended`,
    };
  }
  const credential = getCredential(vaultPath, passphrase, CHECKPOINT_KEY_CREDENTIAL);
  if (!credential.ok) {
    return {
      ok: false,
      code: "checkpoint-key-unreadable",
      message: `the checkpoint signing key could not be read from ${vaultPath} (${credential.code}: ${credential.message}). Store one with \`approval vault set ${CHECKPOINT_KEY_CREDENTIAL}\`, or pass --key-file. Nothing was appended`,
    };
  }
  return { ok: true, privateKey: credential.value };
}

export function commandLogCheckpoint(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, CHECKPOINT_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${LOG_CHECKPOINT_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  // The human-only rule, spelled the way `policy attest` and `vault set` spell
  // it. Refused here before any key is read, so a wrong identity never reaches
  // the vault: an agent that could open the vault by getting the actor wrong
  // would be an agent that could open the vault.
  const asFlag = stringFlag(parsed.flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; \`approval log checkpoint\` is human-only and an agent: or system: actor cannot perform it`,
    );
  }

  const logFlag = stringFlag(parsed.flags, "--log");
  const logPath = logFlag === null ? absolute(DEFAULT_LOG_PATH, cwd) : absolute(logFlag, cwd);
  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const policyWhere =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  const key = resolveSigningKey(
    stringFlag(parsed.flags, "--key-file"),
    logPath,
    stringFlag(parsed.flags, "--vault"),
    policyWhere,
    cwd,
  );
  if (!key.ok) return reportRefusal(key.code, key.message, streams, json);

  const result = appendCheckpoint(logPath, key.privateKey, actor);
  if (!result.ok) return reportRefusal(result.code, result.message, streams, json);
  return reportSigned(result, streams, json);
}

function reportRefusal(code: string, message: string, streams: Streams, json: boolean): number {
  if (json) {
    streams.err(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  } else {
    streams.err(`${renderRefusal(style({ json }), code, message)}\n`);
  }
  return refusalExit(code);
}

function reportSigned(
  result: CheckpointAppendResult,
  streams: Streams,
  json: boolean,
): number {
  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        seq: result.record.seq,
        signed: { seq: result.head.seq, hash: result.head.hash },
        key_sha256: result.fingerprint,
        actor: result.record.actor,
        ts: result.record.ts,
      })}\n`,
    );
  } else {
    streams.out(
      `checkpoint ${String(result.record.seq)}: signed head seq ${String(result.head.seq)} ${result.head.hash}\n`,
    );
    streams.out(`key ${result.fingerprint}, signed by ${result.record.actor}\n`);
  }
  return EXIT_OK;
}
