/**
 * `approval setup checkpoint` — mint the key a human signs the log with
 * (APRV-257, the ceremony half of APRV-220).
 *
 * APRV-220 built the record, the signature and the verify rule, and left the
 * key to an operator with a Node REPL. This is the ceremony that replaces the
 * REPL, and it is shaped like every other `approval setup` subcommand for the
 * reason that family exists: establishing a secret is an act of the human at
 * the machine, so the verb refuses a non-terminal stdin and prints the scripted
 * alternative instead of accepting a pipe.
 *
 * ## The two halves go to two different places, and that is the whole design
 *
 * The PRIVATE half goes into the vault, under the reserved name
 * `approval.checkpoint.key`. Encrypted at rest under the passphrase
 * `vault.passphrase_env` names, which `core/child-env.ts` strips from every
 * child this runtime spawns (APRV-205), behind a file whose reading classifies
 * `account.credential`. `core/vault.ts`'s header records why it belongs there
 * and not in the OS keystore.
 *
 * The PUBLIC half is PRINTED, with the exact `audit.checkpoint_keys` line to
 * paste, and this verb goes no further. **Nothing an agent runs writes that
 * line**, and nothing this verb runs writes it either: `APPROVAL.md` is
 * attested, an edit de-attests it until a human re-attests, and a setup wizard
 * that silently edited an attested policy would be forging the sign-off. The
 * same rule `setup sampling` already keeps for `audit.sampling_secret_env`.
 *
 * So the key is INERT when this verb finishes, and the verb says so: a
 * checkpoint signed by a key the policy does not list is
 * `checkpoint-key-unknown`, which is a refusal. The ceremony is two steps and
 * the second one is the human's.
 *
 * ## Rotation appends; it never drops
 *
 * `--rotate` mints a second key and prints the list with BOTH in it. Retiring
 * is a separate, deliberate act (`--retire <fingerprint>`), and it is REFUSED
 * for any key that signed a checkpoint in the log, naming the seqs that would
 * stop verifying. That is not caution: removing such a key turns every
 * checkpoint it signed into `checkpoint-key-unknown` for the life of the log,
 * which is the cost APRV-220 accepted knowingly when it made an unlisted key a
 * refusal rather than a shrug. A key that has signed nothing may be dropped,
 * and this verb prints the line that does it.
 *
 * ## Human-only, three times over
 *
 * The terminal check (this family's own rule), the `--as human:<id>` gate
 * (`requireHuman`), and — since APRV-257 — the classification: `approval setup
 * checkpoint` classifies `policy.core` in `core/command-class.ts`, which the
 * reference policy holds human-only, so the Claude Code hook denies an agent
 * running it with `hook-class-human-only` before a process starts. It mints no
 * new class (SPEC.md §11.1 invariant 9): `policy.core` already exists and
 * already covers `gate open`, `gate close` and `log checkpoint`.
 */

import {
  checkpointKeyFingerprint,
  checkpointPolicyOf,
  CHECKPOINT_KEY_CREDENTIAL,
  checkpointSignersIn,
  mintCheckpointKeypair,
} from "../core/checkpoint.js";
import { envFilePathFor, readEnvFile } from "../core/env-file.js";
import type { PolicyLoadResult } from "../core/policy-load.js";
import { readVerifiedRecords } from "../core/state.js";
import {
  passphraseEnvFor,
  passphraseFrom,
  setCredential,
  vaultExists,
  vaultPathFor,
} from "../core/vault.js";
import { boolFlag, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK } from "./exit-codes.js";
import { SETUP_CHECKPOINT_HELP } from "./help.js";
import type { Streams } from "./main.js";
import {
  absolute,
  front,
  requireHuman,
  usageError,
  type HintContext,
  type SetupDeps,
} from "./setup-common.js";
import { refusal as renderRefusal, style } from "./style.js";

/** Flags this subcommand adds to the family's shared table. */
const EXTRA_FLAGS: Record<string, FlagKind> = {
  "--rotate": "boolean",
  "--retire": "string",
};

const CHECKPOINT_HINT = (where: HintContext): string =>
  `  # there is no non-interactive form of this ceremony, and that is the point:\n  # a checkpoint key exists to be a key no agent-launched process can mint.\n  # What a script CAN do is establish the passphrase and then leave the key to\n  # a human at a terminal:\n\n  approval setup vault --as human:<id>\n  eval "$(approval env)"        # puts ${where.passphraseEnv} in this shell\n  approval setup checkpoint --as human:<id>\n\n  # then paste the printed public key into APPROVAL.md and attest it:\n  approval policy amend`;

/** The `audit.checkpoint_keys` block to paste, with every key that must stay. */
function policyBlock(keys: readonly string[]): string {
  return ["  audit:", "    checkpoint_keys:", ...keys.map((key) => `      - ${key}`)].join("\n");
}

/** Short form of a fingerprint, for prose. The full value is always printed too. */
function short(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

/**
 * The refusal for an unset passphrase, in `setup adapter`'s two shapes.
 *
 * Same diagnosis and the same two repairs, because it is the same fact: the
 * vault passphrase is read from the environment under the policy's name and
 * from nowhere else, and an operator meeting this on a second verb should meet
 * the sentence they already know.
 */
function passphraseHint(variable: string, logPath: string): string {
  const envPath = envFilePathFor(logPath);
  const file = readEnvFile(envPath);
  const hasLine = file.ok && file.entries.some((entry) => entry.key === variable);
  return hasLine || vaultExists(vaultPathFor(logPath))
    ? `The passphrase is recorded but not in this shell. Establish it with:\n\n  eval "$(approval env)"`
    : `Nobody has established a vault passphrase here. Do that first, then evaluate it:\n\n  approval setup vault --as human:<id>\n  eval "$(approval env)"`;
}

/**
 * `--retire <fingerprint>`: print the line that drops a key, or refuse.
 *
 * Answered from the LOG and never from a memory of what was rotated when: the
 * question is "would removing this name change a verdict", and only the records
 * can answer it. A log that does not verify refuses the retirement too — a
 * chain nobody can walk cannot be asked which keys signed inside it, and
 * guessing here would be guessing about the one thing this whole mechanism
 * exists to make unguessable.
 */
function retireKey(
  streams: Streams,
  fingerprint: string,
  configured: readonly string[],
  logPath: string,
  schemaDir: string | undefined,
): number {
  const wanted = fingerprint.trim().toLowerCase();
  const matches = configured.filter((key) => {
    const seen = checkpointKeyFingerprint(key);
    return seen !== null && (seen === wanted || seen.startsWith(wanted));
  });
  if (matches.length === 0) {
    return usageError(
      streams,
      false,
      `no configured checkpoint key hashes to ${JSON.stringify(fingerprint)}. audit.checkpoint_keys lists ${String(configured.length)} key(s); \`approval doctor\` names their fingerprints. Nothing was changed`,
      SETUP_CHECKPOINT_HELP,
    );
  }
  if (matches.length > 1) {
    return usageError(
      streams,
      false,
      `${JSON.stringify(fingerprint)} is a prefix of ${String(matches.length)} configured keys; give more of the fingerprint. Nothing was changed`,
      SETUP_CHECKPOINT_HELP,
    );
  }

  const read = readVerifiedRecords(logPath, schemaDir === undefined ? {} : { schemaDir });
  if (!read.ok) {
    streams.err(
      `${renderRefusal(
        style(),
        read.code,
        `${read.message}. A log that does not verify cannot be asked which keys signed inside it, and retiring a key on a guess is how a checkpoint range stops verifying. Nothing was changed`,
      )}\n`,
    );
    return EXIT_INTEGRITY;
  }

  const target = matches[0] as string;
  const targetFingerprint = checkpointKeyFingerprint(target) as string;
  const signed = checkpointSignersIn(read.records).get(targetFingerprint) ?? [];
  if (signed.length > 0) {
    streams.err(
      `${renderRefusal(
        style(),
        "checkpoint-key-in-use",
        `key ${targetFingerprint} signed ${String(signed.length)} checkpoint(s) in ${logPath}, at seq ${signed.join(", ")}. Removing it from audit.checkpoint_keys would turn every one of them into checkpoint-key-unknown, which is a REFUSAL and not a warning: \`approval log verify --checkpoints\` would stop passing on a log nobody has touched. Retired keys stay listed forever, which is why the field is a list. Nothing was changed`,
      )}\n`,
    );
    return EXIT_INTEGRITY;
  }

  streams.out(
    `key ${targetFingerprint} has signed no checkpoint in ${logPath}, so removing it changes no\nverdict. This verb does not edit an attested policy; here is the block to leave\nbehind, through the ceremony that attests it:\n\n${policyBlock(
      configured.filter((key) => key !== target),
    )}\n\n  approval policy amend\n`,
  );
  return EXIT_OK;
}

/** `approval setup checkpoint` — mint the checkpoint keypair. HUMAN-ONLY. */
export function commandSetupCheckpoint(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): number {
  const outcome = front(
    "checkpoint",
    argv,
    streams,
    cwd,
    deps,
    SETUP_CHECKPOINT_HELP,
    CHECKPOINT_HINT,
    EXTRA_FLAGS,
  );
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const extra = context.positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      false,
      `unexpected argument ${JSON.stringify(extra)}`,
      SETUP_CHECKPOINT_HELP,
    );
  }

  const human = requireHuman(context.flags, streams, SETUP_CHECKPOINT_HELP, "checkpoint");
  if (!human.ok) return human.code;

  const policyFlag = stringFlag(context.flags, "--policy");
  const dirFlag = stringFlag(context.flags, "--dir");
  // Resolved against the verb's `cwd` and not the process's, the way every
  // other path in this family is: a relative `--policy` that landed on a
  // different file than `front()` loaded would answer questions about a policy
  // nobody chose.
  const policyWhere =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
  const configured = checkpointPolicyOf(policyWhere);

  const retire = stringFlag(context.flags, "--retire");
  if (retire !== null) {
    return retireKey(streams, retire, configured.publicKeys, context.logPath, undefined);
  }

  streams.out(
    `approval setup checkpoint — mints the Ed25519 key you sign the log's head with.\n\nA checkpoint is the one witness an agent process is not supposed to be able to\nproduce: it says a key nobody's runtime holds saw this chain at this head. The\nPRIVATE half goes into ${vaultPathFor(context.logPath)}\nunder ${CHECKPOINT_KEY_CREDENTIAL} and is never printed. The PUBLIC half is\nprinted below for you to put in APPROVAL.md yourself.\n\n`,
  );

  const rotating = boolFlag(context.flags, "--rotate");
  if (configured.publicKeys.length > 0 && !rotating) {
    streams.out(
      `Your policy already lists ${String(configured.publicKeys.length)} checkpoint key(s). Minting a second one and\nstoring it under ${CHECKPOINT_KEY_CREDENTIAL} REPLACES the private half in the\nvault: checkpoints already signed keep verifying (their key stays listed), but\nthe old private half is gone and nothing in this runtime can print it back.\n\nRe-run with --rotate if that is what you mean.\n`,
    );
    return EXIT_OK;
  }
  if (rotating) {
    streams.out(
      `ROTATING. The new key is ADDED to audit.checkpoint_keys and no key is removed:\nretiring one that has signed a checkpoint would de-verify the range it signed,\nwhich is why this verb refuses it (--retire tells you which seqs). The private\nhalf under ${CHECKPOINT_KEY_CREDENTIAL} is replaced, so signatures from here on\nuse the new key.\n\n`,
    );
    if (!context.prompter.confirm("mint a new checkpoint key and replace the stored private half?")) {
      streams.out("aborted: nothing was minted, stored, or printed\n");
      return EXIT_OK;
    }
  }

  // The passphrase, from the SHELL environment under the policy's name. Never
  // from `.approval/env` directly: SPEC.md §11.1 invariant 7.
  const variable = passphraseEnvFor(context.load as PolicyLoadResult);
  const passphrase = passphraseFrom(variable, deps.env ?? process.env);
  if (passphrase === null) {
    return usageError(
      streams,
      false,
      `${variable} is unset or empty: the vault passphrase is read from that environment variable and from nowhere else, and this verb mints nothing without it. No key was generated and no vault was created.\n\n${passphraseHint(variable, context.logPath)}`,
      SETUP_CHECKPOINT_HELP,
    );
  }

  const pair = mintCheckpointKeypair();
  const vaultPath = vaultPathFor(context.logPath);
  const stored = setCredential(vaultPath, passphrase, CHECKPOINT_KEY_CREDENTIAL, pair.privateKey);
  if (!stored.ok) {
    streams.err(`${renderRefusal(style(), stored.code, stored.message)}\n`);
    return stored.code === "vault-io" || stored.code === "vault-write-failed"
      ? EXIT_IO
      : EXIT_INTEGRITY;
  }

  const keys = [...configured.publicKeys, pair.publicKey];
  streams.out(
    `stored the private half in ${vaultPath} under ${CHECKPOINT_KEY_CREDENTIAL}\n  fingerprint ${pair.fingerprint}\n  it was not printed, and there is no verb in this CLI that prints it\n\n`,
  );
  streams.out(
    `THE KEY IS INERT UNTIL THE POLICY LISTS IT. A checkpoint signed by a key\naudit.checkpoint_keys does not carry is checkpoint-key-unknown, which is a\nrefusal. This verb does not edit an attested policy — an edited policy is\ninoperative until it is re-attested, and a wizard that edited one would be\nforging the sign-off. Add this block yourself, through the ceremony that\nattests it:\n\n${policyBlock(keys)}\n\n  approval policy amend\n\n`,
  );
  streams.out(
    `Then set the cadence, if you want to be asked rather than to remember:\n\n  audit:\n    checkpoint_every: 24h\n\nWith a cadence set, the listener puts one \`CHECKPOINT DUE\` prompt in front of\nyou when one is owed — at most one outstanding, never a nag — and \`approval\ndoctor\`'s checkpoint row says how old the newest one is. A checkpoint that is\ndue is a warning at every layer and never a refusal.\n\n`,
  );
  streams.out(
    `IF YOU LOSE THIS KEY: mint another one with --rotate and add it to the list.\nLEAVE THE OLD PUBLIC KEY WHERE IT IS — every checkpoint it signed verifies\nagainst it and only against it, and removing it would refuse a range of a log\nnobody has touched. A lost key costs you future signatures, never past ones.\n`,
  );
  if (rotating) {
    streams.out(
      `\nRotated: key ${short(pair.fingerprint)}… is new, and the ${String(configured.publicKeys.length)} key(s) already listed stay.\n`,
    );
  }
  return EXIT_OK;
}
