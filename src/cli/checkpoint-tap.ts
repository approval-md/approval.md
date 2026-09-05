/**
 * The checkpoint tap: custody, the offer, the prompt text, the signature
 * (APRV-257, the delivery half of APRV-220).
 *
 * APRV-220 built the record and gave a human exactly one way to sign one:
 * `approval log checkpoint` at a terminal, remembered. This file is what makes
 * it happen without the remembering, and it is deliberately the ONLY file
 * between a channel and a signature.
 *
 * ## Why custody lives here now
 *
 * `core/checkpoint.ts` takes the private key as a value and reads it from
 * nowhere, so that one file decides where a checkpoint key may come from. Until
 * this task that file was `cli/log-checkpoint.ts`, because the terminal verb was
 * the only caller. It is not any more: the Telegram listener and the CLI channel
 * both sign now. So the decision moved here rather than being copied, and
 * `cli/log-checkpoint.ts` calls {@link resolveCheckpointKey} like everyone else.
 * There is still exactly one place to read to learn every way a key can reach a
 * signature, which was the whole property.
 *
 * Two sources, in this order, unchanged from APRV-220:
 *
 * 1. `--key-file <path>`, for a key an operator keeps outside the vault.
 * 2. The credential vault, under `approval.checkpoint.key`. Encrypted at rest
 *    under the passphrase `vault.passphrase_env` names, which
 *    `core/child-env.ts` strips from every child this runtime spawns
 *    (APRV-205), behind a file whose reading classifies `account.credential`.
 *
 * There is no `--key` flag and no environment variable holding the key.
 *
 * ## Why an agent-launched process cannot reach any of this
 *
 * Three independent locks, and the tap adds none of its own — it inherits all
 * three, which is why the tap can be built at all:
 *
 * 1. **Classification.** `approval log checkpoint` and `approval setup
 *    checkpoint` classify `policy.core` in `core/command-class.ts`, which the
 *    reference policy holds `human-only`, so the Claude Code hook denies both
 *    with `hook-class-human-only` before a process starts.
 * 2. **The passphrase.** `core/child-env.ts` strips `vault.passphrase_env` from
 *    every child this runtime spawns, so a process an agent launched cannot
 *    open the vault even if it ran this code.
 * 3. **The launch.** The listener holds the passphrase because a HUMAN
 *    exported it into the shell they started `approval up` in. Nothing an agent
 *    can do puts it into a process the agent controls.
 *
 * `tests/checkpoint-tap.test.ts` proves the first two and proves the third
 * structurally: the hook's module graph never reaches this file.
 *
 * ## What the human is shown is what gets signed
 *
 * The offer carries a `(seq, hash)`; the prompt prints it; the signature covers
 * it. The head may have moved several times over between the prompt and the tap
 * — a phone is in a pocket and a daemon is not — and
 * {@link ../core/checkpoint.js appendCheckpointAt} signs the head that was on
 * the screen, checking first that this chain still carries those bytes at that
 * seq. APRV-220's verify rule (a checkpoint signs any seq below its own) exists
 * precisely so this is a legal record rather than a clever one.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  appendCheckpointAt,
  checkpointDue,
  checkpointPolicyOf,
  CHECKPOINT_KEY_CREDENTIAL,
  type CheckpointOffer,
} from "../core/checkpoint.js";
import { readVerifiedRecords } from "../core/state.js";
import { loadPolicy } from "../core/policy-load.js";
import { getCredential, passphraseEnvFor, passphraseFrom, vaultPathFor } from "../core/vault.js";

/** Where a policy is, spelled the way every CLI verb spells it. */
export interface PolicyWhere {
  file?: string;
  dir?: string;
}

/** Everything a surface needs to offer and take a checkpoint. */
export interface CheckpointTap {
  logPath: string;
  policy: PolicyWhere;
  /** `--key-file`, absolute, or `null` for the vault. */
  keyFile: string | null;
  /** An explicit vault path, or `null` for the one beside the log. */
  vault: string | null;
  schemaDir?: string;
}

/** Why no key could be had. One code: the repair is the message, not a branch. */
export const CHECKPOINT_KEY_REFUSAL = "checkpoint-key-unreadable";

export type KeyResolution =
  | { ok: true; privateKey: string }
  | { ok: false; code: string; message: string };

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * The private key, or a refusal naming which source failed and how to fix it.
 *
 * Moved verbatim from `cli/log-checkpoint.ts` (APRV-257) so that the terminal
 * verb, the Telegram listener and the CLI channel share one answer to "where
 * may a checkpoint key come from". The sentences are unchanged: an operator who
 * has seen this refusal once should not meet it in new words on another
 * surface.
 */
export function resolveCheckpointKey(
  keyFile: string | null,
  logPath: string,
  vaultFlag: string | null,
  policyWhere: PolicyWhere,
  cwd: string,
  /**
   * Where the passphrase is read from. `process.env` in production.
   *
   * A seam and not a back door, and the same one `setup adapter` carries: it
   * goes through {@link passphraseFrom}, which is the function `approval vault
   * set` uses, and it never resolves `.approval/env` (SPEC.md §11.1 invariant
   * 7). Injectable so a suite can prove the vault path without mutating an
   * environment every other test in the process shares.
   */
  env?: NodeJS.ProcessEnv,
): KeyResolution {
  if (keyFile !== null) {
    const path = absolute(keyFile, cwd);
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch (cause) {
      return {
        ok: false,
        code: CHECKPOINT_KEY_REFUSAL,
        message: `--key-file ${path} could not be read (${
          cause instanceof Error ? cause.message : String(cause)
        }); nothing was appended`,
      };
    }
    if (text.length === 0) {
      return {
        ok: false,
        code: CHECKPOINT_KEY_REFUSAL,
        message: `--key-file ${path} is empty; a checkpoint key is a base64 PKCS#8 Ed25519 private key on one line. Nothing was appended`,
      };
    }
    return { ok: true, privateKey: text };
  }

  const vaultPath = vaultFlag === null ? vaultPathFor(logPath) : absolute(vaultFlag, cwd);
  const passphraseEnv = passphraseEnvFor(loadPolicy(policyWhere));
  const passphrase = passphraseFrom(passphraseEnv, env ?? process.env);
  if (passphrase === null) {
    return {
      ok: false,
      code: CHECKPOINT_KEY_REFUSAL,
      message: `${passphraseEnv} is unset or empty, so the vault holding ${CHECKPOINT_KEY_CREDENTIAL} could not be opened. The passphrase is read from that variable and from nowhere else; there is no --passphrase flag. Nothing was appended`,
    };
  }
  const credential = getCredential(vaultPath, passphrase, CHECKPOINT_KEY_CREDENTIAL);
  if (!credential.ok) {
    return {
      ok: false,
      code: CHECKPOINT_KEY_REFUSAL,
      message: `the checkpoint signing key could not be read from ${vaultPath} (${credential.code}: ${credential.message}). Mint one with \`approval setup checkpoint\`, or pass --key-file. Nothing was appended`,
    };
  }
  return { ok: true, privateKey: credential.value };
}

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

/**
 * The checkpoint this log is owed, or `null`.
 *
 * Reads the policy first and gives up the moment it names no cadence, so a
 * dispatch cycle on a gate that has never turned checkpoints on pays one policy
 * load and no log walk. Everything after that is
 * {@link ../core/checkpoint.js checkpointDue} over verified records, which is
 * the same call the daemon's warning and doctor's row make: three surfaces,
 * one rule, no arrangement in which they disagree.
 *
 * A log that does not verify produces no offer and no complaint. A chain that
 * is not fit to be read is not fit to be signed either, and the surfaces that
 * exist to shout about a bad chain — `approval log verify`, the daemon's
 * re-proof, doctor's `log` row — are already shouting.
 */
export function checkpointOfferFor(tap: CheckpointTap, now?: number): CheckpointOffer | null {
  const configured = checkpointPolicyOf(tap.policy, tap.schemaDir);
  if (configured.checkpointEveryMs === null || configured.publicKeys.length === 0) return null;

  const read = readVerifiedRecords(
    tap.logPath,
    tap.schemaDir === undefined ? {} : { schemaDir: tap.schemaDir },
  );
  if (!read.ok) return null;

  return checkpointDue({
    records: read.records,
    publicKeys: configured.publicKeys,
    checkpointEveryMs: configured.checkpointEveryMs,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * What a human reads before they tap, on every channel.
 *
 * One text for every surface, because the thing being consented to is identical
 * and a phone that phrased it differently from a terminal would be two claims
 * about one gesture. The `(seq, hash)` is first and whole: it is the entire
 * content of the signature, and an approver who cannot see what they are
 * signing is not approving anything.
 *
 * The last line is the one that keeps this honest. Declining costs nothing —
 * there is no path in this runtime from a checkpoint that is due to a refusal
 * of anything — and a prompt that implied otherwise would be manufacturing
 * pressure for a signature.
 */
export function checkpointPromptLines(offer: CheckpointOffer): string[] {
  return [
    `CHECKPOINT DUE — sign the log head at seq ${String(offer.head.seq)}?`,
    `head  seq ${String(offer.head.seq)}  ${offer.head.hash}`,
    offer.since === null
      ? "This log has never been checkpointed."
      : `The newest checkpoint is at seq ${String(offer.since)}.`,
    offer.warning,
    "Signing appends one log.checkpoint saying that a key no agent process holds saw this head. It authorizes nothing, spends nothing, and decides no request.",
    "The head may move before you tap. What is signed is the head named above, which is the one you are looking at.",
    "Not signing is not a refusal of anything: a checkpoint that is owed is a warning at every layer and never a reason to hold up an action.",
  ];
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

export type CheckpointTapResult =
  | { ok: true; seq: number; signed: { seq: number; hash: string }; fingerprint: string }
  | { ok: false; code: string; message: string };

/**
 * Sign one head and append the record, on the machine the channel runs on.
 *
 * `head` is the `(seq, hash)` that was on the screen, handed back by the
 * channel unchanged. It is a head rather than the whole offer on purpose: by
 * tap time the offer's cadence arithmetic is hours stale and nothing should be
 * tempted to read it, while the head is the one part that must survive
 * verbatim.
 *
 * The key is resolved at TAP time and not at offer time, and that ordering is
 * the point: a prompt sitting on a phone for an hour holds no key material
 * anywhere, and a listener whose vault the operator has since re-keyed refuses
 * the tap with a sentence rather than signing with something stale.
 */
export function signCheckpointOffer(
  tap: CheckpointTap,
  head: { seq: number; hash: string },
  actor: string,
  channel: string,
  cwd: string,
): CheckpointTapResult {
  const key = resolveCheckpointKey(tap.keyFile, tap.logPath, tap.vault, tap.policy, cwd);
  if (!key.ok) return key;

  const appended = appendCheckpointAt(tap.logPath, key.privateKey, actor, head, {
    channel,
    ...(tap.schemaDir === undefined ? {} : { schemaDir: tap.schemaDir }),
  });
  if (!appended.ok) return { ok: false, code: appended.code, message: appended.message };
  return {
    ok: true,
    seq: appended.record.seq,
    signed: { seq: appended.head.seq, hash: appended.head.hash },
    fingerprint: appended.fingerprint,
  };
}

/** What a channel says on the message it just edited, once a tap has landed. */
export function checkpointSignedLines(result: CheckpointTapResult): string[] {
  if (!result.ok) {
    return [
      "NOT CHECKPOINTED",
      `${result.code}: ${result.message}`,
      "Nothing was appended. The log is unchanged and no verdict anywhere depends on this.",
    ];
  }
  return [
    "CHECKPOINTED",
    `log.checkpoint at seq ${String(result.seq)}, signing head seq ${String(result.signed.seq)} ${result.signed.hash}`,
    `key ${result.fingerprint}`,
  ];
}
