/**
 * `approval vault` — the human-only credential verbs (SPEC.md §10.4; APRV-68).
 *
 * Three subcommands, and note which one is missing:
 *
 * - `vault set <name>` stores a credential, creating the vault if absent;
 * - `vault list` prints the NAMES the vault holds, a count, and the file path;
 * - `vault remove <name>` deletes one.
 *
 * **There is no `vault get`, and there will not be one.** A verb that printed a
 * credential would put it in a terminal, a scrollback buffer, a `script`
 * capture, a CI log, and — through the shell that invoked it — quite possibly a
 * history file. The value's only sanctioned journey is from `.approval/vault.enc`
 * into an adapter's request, inside the verified-token window the adapter
 * contract holds open (`src/adapters/vault-provider.ts`). Reading it any other
 * way is a thing an operator can do with their own passphrase and their own
 * code; it is not a thing this CLI will do for them, because the moment it
 * exists it becomes the convenient path.
 *
 * For the same reason `set` takes no `--value`. A secret on a command line is a
 * secret in the shell history, in `ps` output for the length of the call, and in
 * the environment of anything that inspects the process table. The value comes
 * from stdin (a pipe, a heredoc, an interactive paste) or from `--value-env
 * <VAR>`, which names a variable exactly as the policy names the passphrase's.
 *
 * **Human-only, by attest's rules.** `--as human:<id>`, else `APPROVAL_HUMAN`;
 * an `agent:` or `system:` actor is a usage error at exit 2 with the rule
 * quoted. Identity here is declared, not proved (SPEC.md §11: the trust boundary
 * is the local machine), and the check is worth having anyway: it is what stops
 * an agent's tooling from storing or deleting a credential as a side effect of
 * some other task it was asked to do.
 *
 * **Nothing here appends to the log.** Not the set, not the removal, not a
 * "credential rotated" breadcrumb. The log is the record of actions the gate
 * authorized; a credential's existence is configuration, and a log line naming
 * the credentials an operator holds would be a map of the machine's reach
 * published in the one file this project promises never to rewrite.
 *
 * As everywhere else in this CLI, the logic is not here: the cipher, the KDF,
 * the atomic write, and the refusal vocabulary are `core/vault.ts`. This file
 * resolves paths and identity, reads bytes at the edge, and maps a core result
 * onto the frozen exit table.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import {
  listCredentials,
  passphraseEnvFor,
  passphraseFrom,
  removeCredential,
  setCredential,
  vaultExists,
  vaultPathFor,
  type VaultRefusal,
} from "../core/vault.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  VAULT_HELP,
  VAULT_LIST_HELP,
  VAULT_REMOVE_HELP,
  VAULT_SET_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const COMMON_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--vault": "string",
  "--policy": "string",
  "--dir": "string",
  "--as": "string",
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

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/**
 * A vault refusal onto the frozen exit table, by the split every other verb
 * draws: a filesystem fact is 4, and everything the runtime itself decided —
 * a wrong passphrase, an absent name, a header it will not act on — is 1. The
 * command was well-formed; the answer is no.
 */
function refusalExitCode(refusal: VaultRefusal): number {
  switch (refusal.code) {
    case "vault-io":
    case "vault-write-failed":
      return EXIT_IO;
    default:
      return EXIT_INTEGRITY;
  }
}

function emitRefusal(streams: Streams, json: boolean, refusal: VaultRefusal): number {
  if (json) {
    streams.err(
      `${JSON.stringify({ ok: false, error: { code: refusal.code, message: refusal.message, path: refusal.path } })}\n`,
    );
  } else {
    streams.err(`${renderRefusal(style({ json }), refusal.code, refusal.message)}\n`);
  }
  return refusalExitCode(refusal);
}

interface Front {
  flags: Record<string, string | boolean>;
  positionals: string[];
  json: boolean;
  /** The vault file: `--vault`, else derived from the log path. */
  vaultPath: string;
  /** The NAME of the passphrase variable the policy declares. */
  passphraseEnv: string;
}

type FrontOutcome = { kind: "handled"; code: number } | ({ kind: "run" } & Front);

/**
 * Flags, `--help`, the vault path, and the passphrase variable's name.
 *
 * The policy is consulted for one thing only — `vault.passphrase_env` — and an
 * unloadable policy does not stop the verb: the variable's NAME is not a
 * permission, and an operator locked out of their own credentials by an
 * unrelated schema typo would be a fail-closed rule applied where nothing is
 * being authorized. `passphraseEnvFor` returns the default in that case.
 */
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

  const vaultFlag = stringFlag(parsed.flags, "--vault");
  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const vaultPath = vaultFlag === null ? vaultPathFor(logPath) : absolute(vaultFlag, cwd);

  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const passphraseEnv = passphraseEnvFor(
    loadPolicy(
      policyFlag !== null
        ? { file: absolute(policyFlag, cwd) }
        : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
    ),
  );

  return {
    kind: "run",
    flags: parsed.flags,
    positionals: parsed.positionals,
    json,
    vaultPath,
    passphraseEnv,
  };
}

/** The human-only rule, spelled exactly as `policy attest` spells it. */
function requireHuman(
  flags: Record<string, string | boolean>,
  streams: Streams,
  json: boolean,
  helpText: string,
  verb: string,
): { ok: true; actor: string } | { ok: false; code: number } {
  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor !== null) return { ok: true, actor };
  return {
    ok: false,
    code: usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; \`approval vault ${verb}\` is human-only and an agent: or system: actor cannot perform it`,
      helpText,
    ),
  };
}

/** The passphrase, or a usage error naming the variable it should be in. */
function requirePassphrase(
  passphraseEnv: string,
  streams: Streams,
  json: boolean,
  helpText: string,
): { ok: true; passphrase: string } | { ok: false; code: number } {
  const passphrase = passphraseFrom(passphraseEnv);
  if (passphrase !== null) return { ok: true, passphrase };
  return {
    ok: false,
    code: usageError(
      streams,
      json,
      `${passphraseEnv} is unset or empty: the vault passphrase is read from that environment variable and from nowhere else. The policy names the variable (vault.passphrase_env) and never the value, and there is no --passphrase flag, because a passphrase on a command line is a passphrase in the shell history.`,
      helpText,
    ),
  };
}

// ===========================================================================
// approval vault set
// ===========================================================================

/**
 * The credential value: `--value-env <VAR>`, else stdin.
 *
 * One trailing newline is stripped and nothing else is touched. A here-doc, an
 * `echo`, and a password manager's `--raw` output all arrive with exactly one,
 * and an operator who genuinely needs a trailing newline inside a credential can
 * pass it through `--value-env`. Interior whitespace is preserved: some tokens
 * legitimately contain it, and silently trimming a credential produces an
 * authentication failure at the far end with no local evidence of why.
 */
function readValue(
  flags: Record<string, string | boolean>,
  streams: Streams,
  json: boolean,
): { ok: true; value: string } | { ok: false; code: number } {
  const valueEnv = stringFlag(flags, "--value-env");
  if (valueEnv !== null) {
    const value = process.env[valueEnv];
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        code: usageError(
          streams,
          json,
          `--value-env names ${valueEnv}, which is unset or empty in this process; nothing was stored`,
          VAULT_SET_HELP,
        ),
      };
    }
    return { ok: true, value };
  }

  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch (cause) {
    return {
      ok: false,
      code: usageError(
        streams,
        json,
        `the credential value could not be read from stdin (${cause instanceof Error ? cause.message : String(cause)}); pipe it in, or name a variable with --value-env <VAR>`,
        VAULT_SET_HELP,
      ),
    };
  }
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (value.length === 0) {
    return {
      ok: false,
      code: usageError(
        streams,
        json,
        "stdin carried no credential value; pipe the secret in (`… | approval vault set <name>`) or name a variable with --value-env <VAR>. There is deliberately no --value flag: a secret on a command line is a secret in the shell history.",
        VAULT_SET_HELP,
      ),
    };
  }
  return { ok: true, value };
}

/** `approval vault set <name>` — store a credential. HUMAN-ONLY. */
export function commandVaultSet(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, "--value-env": "string" },
    VAULT_SET_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, vaultPath, passphraseEnv } = outcome;

  const name = positionals[0];
  if (name === undefined) {
    return usageError(streams, json, "missing <name> argument", VAULT_SET_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      // The argument is NOT echoed, unlike everywhere else in this CLI. The
      // likeliest thing a second positional here is, is the credential itself,
      // and a runtime that quoted it back would publish the secret into the
      // terminal and the CI log of the very operator who was being told not to
      // put it on a command line.
      "unexpected second argument (not echoed, in case it is the credential) — the VALUE is never a command-line argument; it comes from stdin or --value-env <VAR>, because a secret on a command line is a secret in the shell history",
      VAULT_SET_HELP,
    );
  }

  const human = requireHuman(flags, streams, json, VAULT_SET_HELP, "set");
  if (!human.ok) return human.code;

  const pass = requirePassphrase(passphraseEnv, streams, json, VAULT_SET_HELP);
  if (!pass.ok) return pass.code;

  const value = readValue(flags, streams, json);
  if (!value.ok) return value.code;

  const result = setCredential(vaultPath, pass.passphrase, name, value.value);
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      name: result.name,
      created: result.created,
      count: result.count,
      path: result.path,
    });
  } else {
    streams.out(
      `${result.created ? "stored" : "replaced"} ${result.name} in ${result.path} (${String(result.count)} credential(s); the value is not printed anywhere)\n`,
    );
  }
  return EXIT_OK;
}

// ===========================================================================
// approval vault list
// ===========================================================================

/**
 * `approval vault list` — the NAMES, the count, and the path. HUMAN-ONLY.
 *
 * A vault that does not exist is reported and exits 0. Nobody has created one,
 * which is a state and not a fault: a runtime driven entirely by `approval run`
 * and the CLI channel never needs a credential, exactly as a runtime with no
 * Telegram configuration is healthy without one.
 */
export function commandVaultList(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(argv, COMMON_FLAGS, VAULT_LIST_HELP, streams, cwd);
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, vaultPath, passphraseEnv } = outcome;

  const extra = positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      VAULT_LIST_HELP,
    );
  }

  const human = requireHuman(flags, streams, json, VAULT_LIST_HELP, "list");
  if (!human.ok) return human.code;

  if (!vaultExists(vaultPath)) {
    if (json) {
      emitJson(streams, { ok: true, present: false, path: vaultPath, count: 0, names: [] });
    } else {
      streams.out(
        `no vault at ${vaultPath} — nobody has created one, which is a state and not a fault; \`approval vault set <name>\` creates it\n`,
      );
    }
    return EXIT_OK;
  }

  const pass = requirePassphrase(passphraseEnv, streams, json, VAULT_LIST_HELP);
  if (!pass.ok) return pass.code;

  const result = listCredentials(vaultPath, pass.passphrase);
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      present: true,
      path: result.path,
      count: result.count,
      names: result.names,
    });
  } else {
    streams.out(`${result.path}: ${String(result.count)} credential(s)\n`);
    for (const name of result.names) streams.out(`${name}\n`);
  }
  return EXIT_OK;
}

// ===========================================================================
// approval vault remove
// ===========================================================================

/** `approval vault remove <name>` — delete a credential. HUMAN-ONLY. */
export function commandVaultRemove(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(argv, COMMON_FLAGS, VAULT_REMOVE_HELP, streams, cwd);
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, vaultPath, passphraseEnv } = outcome;

  const name = positionals[0];
  if (name === undefined) {
    return usageError(streams, json, "missing <name> argument", VAULT_REMOVE_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      VAULT_REMOVE_HELP,
    );
  }

  const human = requireHuman(flags, streams, json, VAULT_REMOVE_HELP, "remove");
  if (!human.ok) return human.code;

  const pass = requirePassphrase(passphraseEnv, streams, json, VAULT_REMOVE_HELP);
  if (!pass.ok) return pass.code;

  const result = removeCredential(vaultPath, pass.passphrase, name);
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, { ok: true, name: result.name, count: result.count, path: result.path });
  } else {
    streams.out(
      `removed ${result.name} from ${result.path} (${String(result.count)} credential(s) remain)\n`,
    );
  }
  return EXIT_OK;
}

/** `approval vault <subcommand>` — `set`, `list`, `remove`. */
export function commandVault(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval vault`", VAULT_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${VAULT_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "set") return commandVaultSet(rest, streams, cwd);
  if (sub === "list") return commandVaultList(rest, streams, cwd);
  if (sub === "remove") return commandVaultRemove(rest, streams, cwd);
  if (sub === "get") {
    return usageError(
      streams,
      json,
      "there is no `approval vault get`, and it is not an oversight: a verb that printed a credential would put it in a terminal, a scrollback buffer, a CI log and a shell history. A credential's only sanctioned journey is from the vault into an adapter, inside the verified-token window. Use `approval vault list` to see the names.",
      VAULT_HELP,
    );
  }
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval vault\``,
    VAULT_HELP,
  );
}
