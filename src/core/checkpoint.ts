/**
 * Human-signed log checkpoints (APRV-220).
 *
 * ## The hole this fills
 *
 * The chain in `.approval/log/events.jsonl` is unkeyed, and
 * `docs/proposals/incremental-prefix-proof.md` §3 states the consequence: a
 * process with write access to that file can truncate it and recompute a chain
 * that is self-consistent from genesis. Nothing INSIDE the file contradicts the
 * forgery, so no walk of it ever will. The conformance suite says the same from
 * the other side — `chain-verification/truncation-unanchored` is a boundary
 * vector, and an implementation that claims to catch an unanchored truncation
 * is claiming more than a hash chain can give.
 *
 * §12 of that proposal named three ways out: external anchoring, a keyed chain,
 * and human-signed checkpoints. APRV-219 built the first. This module builds
 * the third.
 *
 * ## How the two witnesses relate
 *
 * They are independent, and neither weakens the other.
 *
 * The ANCHOR (`cli/log-anchor.ts`) asks "does somebody else hold a copy of
 * these bytes?" and answers from git. It is exactly as fresh as the last push,
 * and on a machine with no remote and no records branch it says nothing at all
 * (a skip, never a pass).
 *
 * A CHECKPOINT asks "did a key that no agent process holds sign this head?" and
 * answers from the log itself plus the policy. It works offline, it covers the
 * window since the last push, and it survives being copied to another machine.
 *
 * Against the forger of §3 they fail in different directions, which is the
 * point of having both: the anchor catches a truncation whose records somebody
 * else already holds, and a checkpoint catches a truncation inside the window
 * nobody has pushed yet — because every checkpoint in the rewritten range names
 * a `(seq, hash)` the rewritten chain does not carry, and the forger cannot
 * produce a signature over the hashes they DID recompute.
 *
 * `approval log verify` runs the two independently and reports both. Neither
 * check may be weakened to make the other pass.
 *
 * ## The key
 *
 * A DEDICATED Ed25519 keypair, not the attestation identity. Attestation
 * (`core/attest.ts`) has no keypair to reuse: human identity at v0.1 is
 * config-declared (`--as human:<id>`), and its whole documented claim is that
 * *someone with local control* signed off, not who. A checkpoint has to claim
 * more than that or it claims nothing, because the party it defends against is
 * a process with local control.
 *
 * - The PRIVATE half never appears in the log, in a policy, or in any file an
 *   agent may read: it lives in the credential vault (`core/vault.ts`),
 *   encrypted at rest under a passphrase `core/child-env.ts` strips from every
 *   spawned child, behind a file whose reading classifies `account.credential`
 *   (human-only). This module never reads it from anywhere — the caller passes
 *   the bytes, so the custody decision lives in one place, the CLI verb.
 * - The PUBLIC half is listed in the policy, `audit.checkpoint_keys`. The
 *   policy is the human's own committed, attested artifact: editing it is a
 *   visible diff AND de-attests the policy, so gate operations refuse until a
 *   human re-attests. That is a materially harder thing to do quietly than
 *   rewriting a log line.
 *
 * A list rather than a scalar, so rotation can RETAIN a retired key. A
 * checkpoint signed by a key the policy no longer lists is a refusal here, on
 * purpose (see {@link CHECKPOINT_REFUSAL_CODES}), which makes dropping a key
 * that signed anything a de-verification rather than a cleanup.
 *
 * ## What is signed, and why not more
 *
 * `"approval.md/log-checkpoint/v1\n" + JCS({alg, hash, seq})`. The prefix is
 * domain separation: a signature made here cannot be lifted into any other use
 * of the same key, and a signature made elsewhere cannot be presented as a
 * checkpoint. The head's `hash` is a 256-bit chain digest, so the message is
 * already specific to one chain at one position and needs no further binding.
 *
 * The signature deliberately does NOT cover the rest of the record. It could
 * not: the record's own `hash` covers its payload, which covers the signature.
 * What a checkpoint asserts is exactly "a key holder saw this head" — every
 * other field of the record is covered by the chain, and by the anchor, and by
 * this module refusing a checkpoint whose signed head is not the head the log
 * actually carries.
 *
 * ## Fail closed on a bad signature, fail open on an absent one
 *
 * An invalid signature, an unknown key, or a signed hash the log contradicts is
 * a refusal. A log with no checkpoints at all is not: a human who has been away
 * is not a forger, and a runtime that refused a log for want of a tap would
 * teach its operator to turn the check off. A configured cadence that has
 * lapsed is a WARNING, at every layer, and there is no path in this module from
 * "due" to "refused".
 *
 * A missing PUBLIC KEY is a skip naming why, never a pass — the same rule the
 * anchor check follows for a missing anchor. Nothing has been verified, and
 * reporting silence as a pass is how a check stops being one.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

import { tick, type ClockOptions } from "./clock.js";
import { attemptsOf, withHeadRetry } from "./head-retry.js";
import { canonicalize } from "./jcs.js";
import {
  appendEvent,
  type AppendError,
  type AppendOptions,
  type EventRecord,
  type LogHead,
} from "./log.js";
import { loadPolicy, type LoadPolicyOptions } from "./policy-load.js";
import { readVerifiedRecords } from "./state.js";

/** The one signature scheme at v0.1. Recorded on every checkpoint. */
export const CHECKPOINT_ALG = "ed25519";

/** The event type a checkpoint is written as. */
export const CHECKPOINT_EVENT = "log.checkpoint";

/**
 * Domain separation for the signed message. A constant, and a versioned one:
 * if the signed shape ever changes, the prefix changes with it, so a signature
 * over the old shape can never be read as one over the new.
 */
export const CHECKPOINT_DOMAIN = "approval.md/log-checkpoint/v1";

/** The credential name the CLI reads the private half from. */
export const CHECKPOINT_KEY_CREDENTIAL = "approval.checkpoint.key";

/** Actors permitted to sign a checkpoint, in code as well as in the schema. */
const HUMAN_ACTOR = /^human:.+/u;

// ---------------------------------------------------------------------------
// The refusal union
// ---------------------------------------------------------------------------

/**
 * Every way a checkpoint can refuse a range. A closed union per SPEC.md §11.1
 * invariant 6, frozen the way the others are: callers branch on the string.
 *
 * Five codes, because they are five different facts about how a checkpoint
 * failed and they have five different repairs. Collapsing them would leave the
 * one message a person needs — which record, which key, which seq — inside a
 * free-text blob nothing can branch on.
 *
 * `checkpoint-key-unknown` is a refusal rather than a warning, and that is the
 * load-bearing choice in this union. Softening it would hand a forger the
 * escape hatch: rewrite each checkpoint's `key_sha256` to name a key nobody
 * lists, and every refusal in the range becomes a shrug. The cost is that
 * removing a retired key from `audit.checkpoint_keys` stops the checkpoints it
 * signed from verifying, which is why the policy field is a LIST and why
 * APRV-257's rotation verb refuses to drop a key that signed anything.
 */
export const CHECKPOINT_REFUSAL_CODES = [
  /**
   * The record names a `key_sha256` that no configured public key hashes to.
   * Either a key was retired out of the policy, or somebody wrote a checkpoint
   * with a key of their own — and this runtime cannot tell which, so it refuses.
   */
  "checkpoint-key-unknown",
  /**
   * The signature does not verify under the key the record names. The bytes
   * signed are not the bytes presented; nothing further is inferred, because
   * distinguishing "wrong key" from "tampered payload" would be an oracle and
   * the repair is identical.
   */
  "checkpoint-signature-invalid",
  /**
   * The signature is good and the log disagrees with it: the record at the
   * signed `seq` carries a hash the signature does not name (or the log carries
   * no record at that seq at all). THIS is the forged-chain catch — a chain
   * recomputed after a checkpoint cannot reproduce a signature over the hashes
   * it replaced.
   */
  "checkpoint-hash-mismatch",
  /**
   * The signed `seq` is not below the checkpoint record's own. A checkpoint
   * signs the past; one naming itself or the future is not a checkpoint, and a
   * runtime that accepted one would accept a record vouching for a head that
   * did not exist when it was written.
   */
  "checkpoint-out-of-order",
  /**
   * The payload is not a checkpoint payload: a missing field, a hash that is
   * not 64 hex, an `alg` this build does not implement. The write boundary
   * refuses these, so reaching one means the record came from elsewhere — and a
   * `log.checkpoint` nobody can read is not a checkpoint that passes.
   */
  "checkpoint-malformed",
] as const;

export type CheckpointRefusalCode = (typeof CHECKPOINT_REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** A checkpoint keypair. The public half travels; the private half never does. */
export interface CheckpointKeypair {
  /** Base64 DER SPKI. What goes in `audit.checkpoint_keys`. */
  publicKey: string;
  /** Base64 DER PKCS#8. What goes in the vault, and nowhere else. */
  privateKey: string;
  /** SHA-256 of the DER SPKI bytes, hex. What the record names. */
  fingerprint: string;
}

/** Mint a checkpoint keypair. Ed25519 from `node:crypto`; no dependency added. */
export function mintCheckpointKeypair(): CheckpointKeypair {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  return {
    publicKey: spki.toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    fingerprint: createHash("sha256").update(spki).digest("hex"),
  };
}

/**
 * SHA-256 of a public key's DER SPKI **bytes**, hex.
 *
 * Over the bytes rather than over their base64 spelling, so a key that was
 * re-wrapped, re-encoded, or copied through a text editor still fingerprints to
 * the same value. Returns `null` for anything that is not a public key this
 * build can parse — an unreadable key is not a key, and callers turn that into
 * a skip or a refusal rather than into a match against nothing.
 */
export function checkpointKeyFingerprint(publicKey: string): string | null {
  const spki = derOf(publicKey);
  return spki === null ? null : createHash("sha256").update(spki).digest("hex");
}

/** The DER SPKI bytes of a base64 public key, or `null` when it will not parse. */
function derOf(publicKey: string): Buffer | null {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return key.export({ type: "spki", format: "der" });
  } catch {
    return null;
  }
}

/**
 * The configured public keys, indexed by fingerprint.
 *
 * Keys that do not parse are DROPPED rather than throwing, and the count of
 * what survived is what a caller reports: a policy listing one good key and one
 * typo must still verify the checkpoints the good key signed, and it must not
 * be able to claim the typo verified anything.
 */
export function checkpointKeyIndex(
  publicKeys: readonly string[],
): { keys: Map<string, string>; unreadable: number } {
  const keys = new Map<string, string>();
  let unreadable = 0;
  for (const key of publicKeys) {
    const fingerprint = checkpointKeyFingerprint(key);
    if (fingerprint === null) {
      unreadable += 1;
      continue;
    }
    keys.set(fingerprint, key);
  }
  return { keys, unreadable };
}

// ---------------------------------------------------------------------------
// The signed message
// ---------------------------------------------------------------------------

/** The head a checkpoint signs, exactly as the record records it. */
export interface CheckpointHead {
  seq: number;
  hash: string;
  alg?: string;
}

/**
 * The bytes a checkpoint signature covers.
 *
 * JCS (RFC 8785) over `{alg, hash, seq}`, behind {@link CHECKPOINT_DOMAIN} and
 * a newline. Canonical, so two runtimes that agree on the head agree on the
 * bytes; domain-separated, so the signature means one thing.
 */
export function checkpointMessage(head: CheckpointHead): Buffer {
  const body = canonicalize({
    alg: head.alg ?? CHECKPOINT_ALG,
    hash: head.hash,
    seq: head.seq,
  });
  return Buffer.from(`${CHECKPOINT_DOMAIN}\n${body}`, "utf8");
}

/** Sign a head with a base64 PKCS#8 private key. `null` when the key is unusable. */
export function signCheckpoint(head: CheckpointHead, privateKey: string): string | null {
  try {
    return sign(null, checkpointMessage(head), {
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    }).toString("base64");
  } catch {
    return null;
  }
}

/** Does `signature` verify over `head` under `publicKey`? Never throws. */
export function verifyCheckpointSignature(
  head: CheckpointHead,
  signature: string,
  publicKey: string,
): boolean {
  try {
    return verify(
      null,
      checkpointMessage(head),
      { key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" },
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading a record
// ---------------------------------------------------------------------------

/** A `log.checkpoint` payload, as this runtime reads one back. */
export interface CheckpointPayload {
  seq: number;
  hash: string;
  alg: string;
  keySha256: string;
  signature: string;
}

const HEX64 = /^[a-f0-9]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** Is this record a `log.checkpoint`? Type only; the payload is read separately. */
export function isCheckpointRecord(record: EventRecord): boolean {
  return record.event === CHECKPOINT_EVENT;
}

/**
 * Read a checkpoint record's payload, or `null` when it is not one.
 *
 * Strict, and deliberately so: the write boundary already refuses a malformed
 * checkpoint, so a payload that fails here arrived from somewhere else, and the
 * caller's answer to that is {@link CHECKPOINT_REFUSAL_CODES}'s
 * `checkpoint-malformed` rather than a pass.
 */
export function readCheckpointPayload(record: EventRecord): CheckpointPayload | null {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const seq = payload["seq"];
  const hash = payload["hash"];
  const alg = payload["alg"];
  const keySha256 = payload["key_sha256"];
  const signature = payload["signature"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (typeof hash !== "string" || !HEX64.test(hash)) return null;
  if (alg !== CHECKPOINT_ALG) return null;
  if (typeof keySha256 !== "string" || !HEX64.test(keySha256)) return null;
  if (typeof signature !== "string" || signature.length === 0 || !BASE64.test(signature)) {
    return null;
  }
  return { seq, hash, alg, keySha256, signature };
}

// ---------------------------------------------------------------------------
// Appending one
// ---------------------------------------------------------------------------

/** Why a checkpoint was not appended. Nothing was written in any of these. */
export const CHECKPOINT_APPEND_REFUSAL_CODES = [
  /** The actor is not `human:`-prefixed. Refused here and in the schema. */
  "actor-not-human",
  /** The private key will not parse, or would not sign. */
  "checkpoint-key-unusable",
  /** The log has no records yet: an empty chain has no head to sign. */
  "log-empty",
  /**
   * A caller named a head this log does not carry (APRV-257).
   *
   * Only {@link appendCheckpointAt} can reach it, and only from the tap: the
   * human is shown a `(seq, hash)`, the head moves while the phone is in a
   * pocket, and the record they sign still names the head they SAW. That is
   * allowed — a checkpoint signs any seq below its own — but only while the
   * log actually carries that hash at that seq. When it does not, the thing in
   * front of the human was derived from a different chain than the one being
   * written to, and signing it would mint a checkpoint that
   * `checkpoint-hash-mismatch` refuses forever after.
   */
  "checkpoint-head-unknown",
  /** The log could not be opened. */
  "log-unreadable",
  /** The log's last line is truncated. Nothing may chain onto it. */
  "log-torn-tail",
  /** The chain does not verify, so no head derived from it may be signed. */
  "log-corrupt",
  /** The append itself was refused; `append` carries the writer's own code. */
  "append-failed",
] as const;

export type CheckpointAppendRefusalCode = (typeof CHECKPOINT_APPEND_REFUSAL_CODES)[number];

export interface CheckpointAppendRefusal {
  ok: false;
  code: CheckpointAppendRefusalCode;
  message: string;
  /** The writer's own refusal, present when `code` is `append-failed`. */
  append?: AppendError;
}

export interface CheckpointAppendResult {
  ok: true;
  record: EventRecord;
  /** The head this checkpoint signed. */
  head: LogHead;
  /** The fingerprint of the key that signed it. */
  fingerprint: string;
}

export interface CheckpointAppendOptions extends ClockOptions {
  schemaDir?: string;
  append?: AppendOptions;
  /**
   * The channel the record names (APRV-257). `cli` by default, which is what
   * the terminal verb is; the tap passes the channel the human tapped on.
   *
   * Descriptive and never authoritative: the schema constrains the ACTOR of a
   * `log.checkpoint` and the signature constrains the head, and neither of
   * those reads this field. It is here so a reader of the log can tell a
   * checkpoint taken at a terminal from one taken on a phone.
   */
  channel?: string;
  /**
   * How many whole read-sign-append cycles a moved head may cost (APRV-257).
   *
   * The tap needs it and the terminal verb inherits it: a listener signing on a
   * busy log races the daemon's own appends, and handing `head-moved` back to
   * someone who has just tapped a button on their phone is precisely the party
   * `core/head-retry.ts` exists to stop handing it to. Each attempt re-reads
   * and re-signs; nothing crosses an attempt.
   */
  attempts?: number;
}

/**
 * Append one `log.checkpoint` signing the log's current head.
 *
 * The head is read, then signed, then written with that head as
 * `expectedHead`, so the record cannot land on a chain that moved underneath it
 * (SPEC.md §11.1: every check-then-append passes through compare-and-append).
 * A concurrent append is `head-moved`, and the repair is to run it again — the
 * signature would otherwise vouch for a head that is no longer this record's
 * predecessor, which is a checkpoint that verifies and means less than it looks
 * like it means.
 *
 * `ts` is stamped from the clock at the write boundary and is never a
 * parameter: `log.checkpoint` is gate-typed under amended SPEC.md §8 (A2), and
 * a caller who could choose the moment could backdate the one record whose
 * whole content is a claim about a moment.
 *
 * The private key arrives as a value. This module never reads it from a vault,
 * a file, or an environment variable, so there is exactly one place in the
 * codebase that decides where a checkpoint key may come from, and it is the CLI
 * verb a human runs.
 */
export function appendCheckpoint(
  logPath: string,
  privateKey: string,
  actor: string,
  options: CheckpointAppendOptions = {},
): CheckpointAppendResult | CheckpointAppendRefusal {
  return signAndAppend(logPath, privateKey, actor, null, options);
}

/**
 * Append one `log.checkpoint` signing a head the CALLER names (APRV-257).
 *
 * The tap's entry point, and the reason APRV-220's verify rule asks only that a
 * checkpoint signs a seq BELOW its own rather than its immediate predecessor.
 * A human is shown `(seq, hash)` on a phone; by the time they tap, the daemon
 * has appended three records. The honest thing to sign is the head they SAW,
 * because that is what they looked at, and a runtime that quietly re-read the
 * head and signed something else would be putting a human's key over bytes
 * nobody inspected.
 *
 * The named head is checked against the log before anything is signed: it must
 * be a `(seq, hash)` this chain actually carries ({@link
 * CHECKPOINT_APPEND_REFUSAL_CODES}'s `checkpoint-head-unknown`). So a stale
 * prompt from a chain that has since been rewritten cannot be turned into a
 * signature, and the checkpoint that lands is one `checkLogCheckpoints` will
 * accept rather than one it will refuse forever.
 */
export function appendCheckpointAt(
  logPath: string,
  privateKey: string,
  actor: string,
  head: CheckpointHead,
  options: CheckpointAppendOptions = {},
): CheckpointAppendResult | CheckpointAppendRefusal {
  return signAndAppend(logPath, privateKey, actor, { seq: head.seq, hash: head.hash }, options);
}

/**
 * The one body behind both entry points.
 *
 * `want` is `null` for "whatever the head is when this runs" and a `(seq,
 * hash)` for "the head the human was shown". Everything else — the human-only
 * rule, the verified read, the compare-and-append, the runtime-stamped `ts` —
 * is identical, because the two verbs differ in exactly one decision and
 * writing them twice would be two chances to get the rest of it wrong.
 */
function signAndAppend(
  logPath: string,
  privateKey: string,
  actor: string,
  want: { seq: number; hash: string } | null,
  options: CheckpointAppendOptions,
): CheckpointAppendResult | CheckpointAppendRefusal {
  return withHeadRetry(attemptsOf(options.attempts), () =>
    signAndAppendOnce(logPath, privateKey, actor, want, options),
  );
}

function signAndAppendOnce(
  logPath: string,
  privateKey: string,
  actor: string,
  want: { seq: number; hash: string } | null,
  options: CheckpointAppendOptions,
): CheckpointAppendResult | CheckpointAppendRefusal {
  if (!HUMAN_ACTOR.test(actor)) {
    return {
      ok: false,
      code: "actor-not-human",
      message: `signing a checkpoint requires a human actor matching ^human:.+, got ${JSON.stringify(actor)}; a checkpoint is the one witness an agent process is not supposed to be able to produce, and the log was left unchanged`,
    };
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) {
    return { ok: false, code: read.code, message: read.message };
  }
  if (read.head === null) {
    return {
      ok: false,
      code: "log-empty",
      message: `${logPath} carries no records, and an empty chain has no head to sign; nothing was appended`,
    };
  }

  // The head the record will name: the current one, or the one the human was
  // shown — and in the second case only after this log is asked whether it
  // carries those bytes at that seq. A signature over a head this chain does
  // not have is a checkpoint that refuses for the life of the log.
  let head: CheckpointHead;
  if (want === null) {
    head = { seq: read.head.seq, hash: read.head.hash };
  } else {
    const carried = read.records.find((record) => record.seq === want.seq);
    if (carried === undefined || carried.hash !== want.hash) {
      return {
        ok: false,
        code: "checkpoint-head-unknown",
        message: `this log does not carry ${want.hash} at seq ${String(want.seq)} (${
          carried === undefined
            ? `it has no record at that seq; its head is seq ${String(read.head.seq)}`
            : `it carries ${carried.hash} there`
        }). The head you were shown belongs to a different chain than the one being written to, so nothing was signed and nothing was appended`,
      };
    }
    head = { seq: want.seq, hash: want.hash };
  }

  const signature = signCheckpoint(head, privateKey);
  if (signature === null) {
    return {
      ok: false,
      code: "checkpoint-key-unusable",
      message:
        "the checkpoint signing key could not be read as a base64 PKCS#8 Ed25519 private key; nothing was appended",
    };
  }

  const fingerprint = privateKeyFingerprint(privateKey);
  if (fingerprint === null) {
    return {
      ok: false,
      code: "checkpoint-key-unusable",
      message:
        "the checkpoint signing key signed but its public half could not be derived, so the record could not name which key to verify it against; nothing was appended",
    };
  }

  const appended = appendEvent(
    logPath,
    {
      ts: tick(options),
      event: CHECKPOINT_EVENT,
      actor,
      channel: options.channel ?? "cli",
      payload: {
        seq: head.seq,
        hash: head.hash,
        alg: CHECKPOINT_ALG,
        key_sha256: fingerprint,
        signature,
      },
    },
    {
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      ...options.append,
      expectedHead: read.head,
    },
  );
  if (!appended.ok) {
    return {
      ok: false,
      code: "append-failed",
      message: `the checkpoint was not appended: ${appended.error.code}: ${appended.error.message}`,
      append: appended.error,
    };
  }

  return { ok: true, record: appended.record, head: read.head, fingerprint };
}

/** The fingerprint of the public half of a private key, or `null`. */
export function privateKeyFingerprint(privateKey: string): string | null {
  try {
    const spki = createPublicKey(
      createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }),
    ).export({ type: "spki", format: "der" });
    return createHash("sha256").update(spki).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** One checkpoint that validated, as a caller reports it. */
export interface VerifiedCheckpoint {
  /** The seq of the `log.checkpoint` record itself. */
  at: number;
  /** The head it signed. */
  seq: number;
  hash: string;
  /** When it was signed, from the record's runtime-stamped `ts`. */
  ts: string;
  actor: string;
  keySha256: string;
}

/** How the walked range stands against the checkpoints inside it. */
export type CheckpointCheck =
  | {
      status: "pass";
      /** Every checkpoint that validated, in log order. */
      checkpoints: VerifiedCheckpoint[];
      /** Checkpoints whose signed seq falls below the walked range. */
      unchecked: number;
      /** Configured keys this build could parse. */
      keys: number;
      /** The cadence warning, when one is due. Never a refusal. */
      warning: string | null;
      detail: string;
    }
  | { status: "skip"; reason: string; checkpoints: 0 }
  | {
      status: "refused";
      code: CheckpointRefusalCode;
      /** The seq of the offending `log.checkpoint` record. */
      at: number;
      message: string;
      /** Checkpoints that validated before this one. */
      checkpoints: VerifiedCheckpoint[];
    };

/** What {@link checkLogCheckpoints} is asked. `records` are already VERIFIED. */
export interface CheckpointCheckOptions {
  /**
   * The log's records, already verified by the caller.
   *
   * Required rather than re-derived, for SPEC.md §11.1 invariant 1: this check
   * reads only verified records, and a check that walked the chain itself would
   * be answering a question its caller has already answered, differently.
   */
  records: readonly EventRecord[];
  /** The configured public keys, base64 DER SPKI. From `audit.checkpoint_keys`. */
  publicKeys: readonly string[];
  /**
   * Why there are no keys, when the caller already knows: an unloadable policy,
   * a missing file. Folded into the skip reason so the sentence names the cause
   * rather than only the symptom.
   */
  keysUnavailable?: string | null;
  /** `audit.checkpoint_every` in milliseconds, or `null` when the cadence is off. */
  checkpointEveryMs?: number | null;
  /** Now, for the cadence warning only. No verdict reads it. */
  now?: number;
}

/**
 * Demand every checkpoint inside the walked range.
 *
 * Every `log.checkpoint` record in `records` must carry a readable payload,
 * name a configured key, verify under it, and name the hash the log actually
 * carries at the seq it signed. The FIRST failure refuses, carrying the seq of
 * the offending record and the checkpoints that validated ahead of it: a person
 * reading a divergence needs to know how far the log was still good.
 *
 * Three things are deliberately not refusals.
 *
 * - **No configured key** is a skip naming why, and naming how many checkpoint
 *   records went unchecked. Nothing was verified, and a check that reported
 *   that as a pass would have stopped being a check.
 * - **A signed seq below the walked range** is counted and named, not refused.
 *   A full walk starts at genesis so this cannot arise there; a caller walking
 *   a suffix gets an honest count of what its range could not speak to.
 * - **A lapsed cadence** is a warning. A human who has been away is not a
 *   forger, and a runtime that refused a log for want of a tap is a runtime
 *   whose operator turns the check off.
 */
export function checkLogCheckpoints(options: CheckpointCheckOptions): CheckpointCheck {
  const found = options.records.filter(isCheckpointRecord);
  const { keys, unreadable } = checkpointKeyIndex(options.publicKeys);

  if (keys.size === 0) {
    return {
      status: "skip",
      checkpoints: 0,
      reason:
        options.publicKeys.length === 0
          ? `${options.keysUnavailable ?? "no checkpoint public key is configured (audit.checkpoint_keys)"}, so the ${String(found.length)} checkpoint record(s) in this range could not be verified against anything`
          : `none of the ${String(options.publicKeys.length)} configured checkpoint key(s) could be read as an Ed25519 public key (${String(unreadable)} unreadable), so the ${String(found.length)} checkpoint record(s) in this range could not be verified`,
    };
  }

  // Hash by seq, once, and only when there is something to look up. A range
  // with many checkpoints would otherwise scan the whole record list per
  // checkpoint; a log with none would build an index of every record it holds
  // to answer no questions, and this check runs on a daemon tick over a log
  // that grows without bound.
  const hashAt = new Map<number, string>();
  if (found.length > 0) {
    for (const record of options.records) hashAt.set(record.seq, record.hash);
  }
  const firstSeq = options.records[0]?.seq ?? 0;

  const verified: VerifiedCheckpoint[] = [];
  let unchecked = 0;

  for (const record of found) {
    const payload = readCheckpointPayload(record);
    if (payload === null) {
      return refusedAt(
        record,
        "checkpoint-malformed",
        `the log.checkpoint at seq ${String(record.seq)} does not carry a readable checkpoint payload (seq, hash, alg ${CHECKPOINT_ALG}, key_sha256, signature). The write boundary refuses such a record, so this one was written by something else, and a checkpoint nobody can read is not one that passes`,
        verified,
      );
    }

    if (payload.seq >= record.seq) {
      return refusedAt(
        record,
        "checkpoint-out-of-order",
        `the log.checkpoint at seq ${String(record.seq)} signs seq ${String(payload.seq)}, which is not below its own. A checkpoint signs the past; one naming itself or the future vouches for a head that did not exist when it was written`,
        verified,
      );
    }

    const publicKey = keys.get(payload.keySha256);
    if (publicKey === undefined) {
      return refusedAt(
        record,
        "checkpoint-key-unknown",
        `the log.checkpoint at seq ${String(record.seq)} names key ${payload.keySha256}, which none of the ${String(keys.size)} configured checkpoint key(s) hashes to. Either that key was retired out of audit.checkpoint_keys — in which case put it back, since removing a key that signed a checkpoint de-verifies the range it signed — or this record was signed with a key the policy does not vouch for`,
        verified,
      );
    }

    if (
      !verifyCheckpointSignature(
        { seq: payload.seq, hash: payload.hash, alg: payload.alg },
        payload.signature,
        publicKey,
      )
    ) {
      return refusedAt(
        record,
        "checkpoint-signature-invalid",
        `the signature on the log.checkpoint at seq ${String(record.seq)} does not verify under the key it names (${payload.keySha256}) over seq ${String(payload.seq)} ${payload.hash}. The bytes signed are not the bytes presented`,
        verified,
      );
    }

    if (payload.seq < firstSeq) {
      unchecked += 1;
      continue;
    }

    const actual = hashAt.get(payload.seq);
    if (actual !== payload.hash) {
      return refusedAt(
        record,
        "checkpoint-hash-mismatch",
        `the log.checkpoint at seq ${String(record.seq)} carries a valid signature over seq ${String(payload.seq)} ${payload.hash}, and this log ${
          actual === undefined
            ? "carries no record at that seq"
            : `carries ${actual} there`
        }. A human's key signed a head this chain does not have: the chain was rewritten after the checkpoint was taken, and whoever rewrote it recomputed the hashes but could not recompute the signature`,
        verified,
      );
    }

    verified.push({
      at: record.seq,
      seq: payload.seq,
      hash: payload.hash,
      ts: record.ts,
      actor: record.actor,
      keySha256: payload.keySha256,
    });
  }

  return {
    status: "pass",
    checkpoints: verified,
    unchecked,
    keys: keys.size,
    warning: cadenceWarning(verified, options),
    detail:
      verified.length === 0
        ? `no checkpoint has been signed in this range; ${String(keys.size)} key(s) are configured and nothing contradicts the chain`
        : `${String(verified.length)} checkpoint(s) validate against ${String(keys.size)} configured key(s), the newest signing seq ${String(
            (verified[verified.length - 1] as VerifiedCheckpoint).seq,
          )}`,
  };
}

function refusedAt(
  record: EventRecord,
  code: CheckpointRefusalCode,
  message: string,
  checkpoints: VerifiedCheckpoint[],
): CheckpointCheck {
  return { status: "refused", code, at: record.seq, message, checkpoints };
}

/**
 * The cadence sentence, or `null`.
 *
 * Report-only in every direction, like `audit.skew_tolerance`: it decides what
 * a human is shown about a log that already verified, and no verdict, exit code
 * or authorization reads it. A cadence nobody set says nothing; a cadence set
 * and never met says so from the newest record in the range, since a log whose
 * first checkpoint is still owed is exactly the case an operator most wants
 * named.
 */
function cadenceWarning(
  verified: readonly VerifiedCheckpoint[],
  options: CheckpointCheckOptions,
): string | null {
  const offer = offerFrom(verified, options);
  return offer === null ? null : offer.warning;
}

// ---------------------------------------------------------------------------
// The cadence, as something to ASK rather than only to report (APRV-257)
// ---------------------------------------------------------------------------

/** Milliseconds as a rounded hour count, for every cadence sentence. */
function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * A checkpoint the runtime would like a human to sign, and the head to show
 * them (APRV-257).
 *
 * `head` is the log's CURRENT head at the moment the offer was made, and it is
 * carried through the prompt into {@link appendCheckpointAt} unchanged. What
 * the human is shown is what gets signed, however long the phone stays in the
 * pocket.
 */
export interface CheckpointOffer {
  /** The head a prompt asks the human to sign. */
  head: { seq: number; hash: string };
  /** The seq of the newest checkpoint RECORD, or `null` when there is none. */
  since: number | null;
  /** How long since that checkpoint (or since the log's oldest record), in ms. */
  ageMs: number;
  /** `audit.checkpoint_every`, in ms. */
  everyMs: number;
  /** The sentence every reporting surface prints. Never a refusal. */
  warning: string;
}

/**
 * The due-ness rule, over an already-computed set of verified checkpoints.
 *
 * ONE rule, and that is the point of extracting it: the verify verdict's
 * warning, the daemon's `checkpoint-due`, `approval doctor`'s row and the
 * channel prompt all read this, so there is no arrangement in which the daemon
 * says a checkpoint is due and the listener declines to ask for one, or the
 * other way around.
 *
 * Returns `null` — never due — when the cadence is off, when the log is empty,
 * or when nothing has aged past the interval. Report-only in every direction:
 * the return type carries a sentence and a head, and there is no code path in
 * this runtime from an offer to a refusal.
 */
function offerFrom(
  verified: readonly VerifiedCheckpoint[],
  options: CheckpointCheckOptions,
): CheckpointOffer | null {
  const every = options.checkpointEveryMs;
  if (every === undefined || every === null || every <= 0) return null;
  const now = options.now ?? Date.now();

  const newest = verified[verified.length - 1];
  const since = newest === undefined ? oldestTs(options.records) : Date.parse(newest.ts);
  if (since === null || Number.isNaN(since)) return null;
  const age = now - since;
  if (age <= every) return null;

  // The head to sign is this log's last record. An empty range has none, and a
  // prompt naming nothing is not a prompt.
  const last = options.records[options.records.length - 1];
  if (last === undefined) return null;

  return {
    head: { seq: last.seq, hash: last.hash },
    since: newest?.at ?? null,
    ageMs: age,
    everyMs: every,
    warning:
      newest === undefined
        ? `audit.checkpoint_every is ${hours(every)} and this log has never been checkpointed (its oldest record is ${hours(age)} old). A missing checkpoint is not tampering and nothing is refused; sign one with \`approval log checkpoint\``
        : `audit.checkpoint_every is ${hours(every)} and the newest checkpoint (seq ${String(newest.at)}, signing seq ${String(newest.seq)}) is ${hours(age)} old. A checkpoint that is due is not a checkpoint that is missing on purpose; nothing is refused`,
  };
}

/**
 * Is a checkpoint due, and over which head? `null` when it is not.
 *
 * The whole question in one call, over already-verified records: it runs
 * {@link checkLogCheckpoints} and offers only from a PASS. A refused range is
 * not a range to ask for another signature over — the thing to do with a
 * checkpoint that does not verify is look at it, not sign a new one on top —
 * and a skipped one has no key configured, so there is nothing to sign with and
 * nobody to ask.
 */
export function checkpointDue(options: CheckpointCheckOptions): CheckpointOffer | null {
  const check = checkLogCheckpoints(options);
  if (check.status !== "pass") return null;
  return offerFrom(check.checkpoints, options);
}

// ---------------------------------------------------------------------------
// Reading the policy's half
// ---------------------------------------------------------------------------

/** What the policy says about checkpoints, and why it says nothing when it does. */
export interface CheckpointPolicy {
  /** `audit.checkpoint_keys`, or empty. */
  publicKeys: string[];
  /** `audit.checkpoint_every` in milliseconds, or `null`. */
  checkpointEveryMs: number | null;
  /** Present when the policy could not be loaded at all. */
  unloadable: string | null;
}

/**
 * The checkpoint half of a policy, read the way `skewToleranceMsOf` reads its
 * key — except that this one fails to a SKIP rather than to a default.
 *
 * A policy that cannot be loaded configures no keys, and a caller with no keys
 * skips with a reason. There is no safe default here: falling back to "no keys"
 * and calling it a pass would report an unreadable policy as a verified log,
 * and falling back to a built-in key would be a key nobody chose.
 */
export function checkpointPolicyOf(
  policy: { dir?: string; file?: string },
  schemaDir?: string,
): CheckpointPolicy {
  const where: LoadPolicyOptions =
    policy.file !== undefined ? { file: policy.file } : { dir: policy.dir ?? process.cwd() };
  if (schemaDir !== undefined) where.schemaDir = schemaDir;
  const load = loadPolicy(where);
  if (!load.ok) {
    return {
      publicKeys: [],
      checkpointEveryMs: null,
      unloadable: `the policy could not be loaded (${load.code}: ${load.message}) and configures no checkpoint key`,
    };
  }
  const keys = load.policy.audit?.checkpoint_keys;
  return {
    publicKeys: Array.isArray(keys) ? [...keys] : [],
    checkpointEveryMs: load.durations.checkpointEveryMs,
    unloadable: null,
  };
}

/** Milliseconds of the oldest record's `ts`, or `null` when there is none. */
function oldestTs(records: readonly EventRecord[]): number | null {
  const first = records[0];
  if (first === undefined) return null;
  const parsed = Date.parse(first.ts);
  return Number.isNaN(parsed) ? null : parsed;
}
