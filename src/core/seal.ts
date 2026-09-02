/**
 * Sealed token delivery (amended SPEC.md §6.3, §10.4, §11.1 — APRV-105).
 *
 * The problem this closes is a handover, not an authorization. A token is minted
 * at exactly one site — the grant path of `core/gate.ts` — and spent at another,
 * `approval run`. The two are different processes, and until now the only
 * transport between them was a human with a clipboard: `approval grant` (or the
 * Telegram listener) printed the raw token on ITS stdout, and `approval wait`,
 * which reads only the verified log, had nothing to return because the log
 * carries hashes. On one machine that is a paste. Across two — the listener on a
 * laptop, the agent elsewhere, the log synced through git — it is a paste that
 * cannot happen.
 *
 * So the requester publishes an ADDRESS. `approval request` mints an ephemeral
 * X25519 keypair, keeps the private half in a 0600 file beside the log, and puts
 * the public half on `approval.requested` as `token_recipient_key`. On grant the
 * mint site seals the raw token to that key and records the ciphertext beside
 * the digest as `token_sealed`. `approval wait` opens it with the local private
 * key and hands the token back to the process that asked for it.
 *
 * ## The keypair ADDRESSES; it does not AUTHORIZE
 *
 * The obvious objection is that the agent creates both halves of the key, so how
 * does this control the agent? It does not, and it does not need to. The four
 * properties that make an action human-gated are untouched:
 *
 * - a token exists only after a human grant (one mint site);
 * - it binds to the exact payload bytes;
 * - it is single-use, and consumption is an `execution.started` in the log;
 * - credentials answer only to tokens.
 *
 * A keypair cannot mint a token, forge a grant, alter the bound payload, or
 * reuse a spent one. What changes is who can READ a minted token: the requesting
 * process instead of the human's clipboard, which is where the human was
 * carrying it anyway. A malicious agent that substitutes a key substitutes it
 * only in its OWN request, which the approver sees and approves as that agent's
 * request; identity spoofing is exactly as it was in SPEC.md §11, where the
 * trust boundary is the machine.
 *
 * What is lost, stated plainly: the marginal ability to approve on the phone and
 * then withhold delivery.
 *
 * ## Residual risk, stated plainly
 *
 * Someone who steals the private-key file AND reads the log can recover an
 * unspent token inside its TTL. That window equals the terminal-paste window
 * today, and it closes at consume or at TTL, whichever comes first — this module
 * unlinks the key file at both. The ciphertext lives in a public, permanent log,
 * so the seal must be sound and the token short-lived; it already is.
 *
 * ## The construction
 *
 * X25519 ECDH to a fresh ephemeral sender key, HKDF-SHA-256 to a 32-byte AEAD
 * key, AES-256-GCM with a fresh 12-byte nonce. All from `node:crypto`; no
 * dependency is added. The sender's ephemeral public key travels with the
 * ciphertext, so the recipient needs nothing but its own private key and the
 * record. The HKDF `info` binds the ciphertext to this scheme and to the action
 * it was minted for, so a seal lifted from one grant cannot be replayed as
 * another's even by someone holding both key files.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The payload key carrying the requester's public key on `approval.requested`. */
export const RECIPIENT_KEY_FIELD = "token_recipient_key";

/** The payload key carrying the sealed token on `approval.granted`. */
export const SEALED_TOKEN_FIELD = "token_sealed";

/**
 * The payload key on `approval.requested` saying the requester will consume its
 * own grant in its own process (APRV-211), so the raw token is delivered ONLY
 * through the seal and is never returned to the granting surface.
 *
 * A fact about delivery, recorded where every other delivery fact is recorded.
 * It authorizes nothing and relaxes nothing: the token is still minted only by
 * a human's grant, still bound to the payload bytes, still single-use. What it
 * removes is a reader — a terminal that was being handed a live credential it
 * had no use for.
 */
export const SELF_DELIVERY_FIELD = "token_delivery_self";

/** `.approval/keys/`, the sibling of the log directory the private keys live in. */
export const KEY_STORE_DIRNAME = "keys";

/** The scheme identifier recorded inside every seal. One value in v0.1. */
export const SEAL_ALG = "x25519-hkdf-sha256/aes-256-gcm";

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** The key store for a log path, by the same rule the payload store uses. */
export function keyStoreDirFor(logPath: string): string {
  const logDir = dirname(logPath);
  const home = basename(logDir) === "log" ? dirname(logDir) : logDir;
  return join(home, KEY_STORE_DIRNAME);
}

/**
 * The file one action key's private key lives in.
 *
 * The action key is used verbatim wherever it is already a safe file name, and
 * percent-encoded elsewhere. Percent-encoding is injective, so two distinct
 * action keys can never name one file — which matters more than readability,
 * since a collision would hand one action's token to another. The common case
 * (`task-042:chaser:2026-08-04`) survives unchanged, so the directory listing
 * still reads as the action keys it holds.
 */
export function keyPath(keyDir: string, actionKey: string): string {
  const safe = actionKey.replace(
    /[^A-Za-z0-9._:-]/gu,
    (character) =>
      [...character]
        .flatMap((unit) => [...Buffer.from(unit, "utf8")])
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
        .join(""),
  );
  return join(keyDir, `${safe}.key`);
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** A freshly minted recipient keypair: the public half travels, the private stays. */
export interface RecipientKeypair {
  /** Base64 DER SPKI. What rides on `approval.requested`. */
  publicKey: string;
  /** Base64 DER PKCS#8. What is written 0600 and never leaves the machine. */
  privateKey: string;
}

/** Mint an ephemeral X25519 keypair for one request. */
export function mintRecipientKeypair(): RecipientKeypair {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** Is this a value that could be a recipient public key? Shape only. */
export function isRecipientKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]{20,600}={0,2}$/u.test(value);
}

function publicKeyOf(encoded: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "spki",
  });
}

function privateKeyOf(encoded: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

// ---------------------------------------------------------------------------
// The key store
// ---------------------------------------------------------------------------

export type KeyWriteResult = { ok: true; path: string } | { ok: false; message: string };

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Distinguishes concurrent writers' temp files within one process. */
let tempCounter = 0;

/**
 * Write one private key, atomically and 0600.
 *
 * The mode is set by `openSync`'s mode argument on a file created `wx`, so the
 * key never exists at a wider mode even for an instant — a `chmod` after the
 * fact would leave a window in which any process on the machine could read it.
 * The rename is atomic, so a reader either sees the whole key or no file.
 */
export function writePrivateKey(
  keyDir: string,
  actionKey: string,
  privateKey: string,
): KeyWriteResult {
  const path = keyPath(keyDir, actionKey);
  tempCounter += 1;
  const temp = join(
    keyDir,
    `.${basename(path)}.tmp-${String(process.pid)}-${String(tempCounter)}`,
  );
  try {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const handle = openSync(temp, "wx", 0o600);
    try {
      writeSync(handle, privateKey, 0, "utf8");
    } finally {
      closeSync(handle);
    }
    renameSync(temp, path);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return { ok: false, message: detail(cause) };
  }
  return { ok: true, path };
}

/** The private key for an action, or `null` when this machine holds none. */
export function readPrivateKey(keyDir: string, actionKey: string): string | null {
  try {
    const text = readFileSync(keyPath(keyDir, actionKey), "utf8").trim();
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/**
 * Remove one action's private key. Idempotent and never throws.
 *
 * Called at every death of the authorization it addresses: consumption, expiry,
 * revocation. A key that outlived its grant would be a decryption capability for
 * a ciphertext that is in the log forever, kept for no reason at all.
 */
export function forgetPrivateKey(keyDir: string, actionKey: string): boolean {
  try {
    unlinkSync(keyPath(keyDir, actionKey));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Seal and open
// ---------------------------------------------------------------------------

/** What `approval.granted` carries beside `token_sha256`. */
export interface SealedToken {
  /** The scheme. One value in v0.1; present so a reader never has to guess. */
  alg: string;
  /** The sender's ephemeral X25519 public key, base64 DER SPKI. */
  epk: string;
  /** The AES-GCM nonce, base64. Fresh for every seal. */
  nonce: string;
  /** Ciphertext, base64. */
  ct: string;
  /** The GCM authentication tag, base64. */
  tag: string;
}

/** Binds a seal to this scheme and to the action it was minted for. */
function infoFor(actionKey: string): Buffer {
  return Buffer.from(`approval.md/${SEAL_ALG}/${actionKey}`, "utf8");
}

function aeadKey(shared: Buffer, actionKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), infoFor(actionKey), KEY_BYTES),
  );
}

/**
 * Seal a raw token to a recipient public key.
 *
 * Returns `null` for a recipient key that cannot be parsed. A grant is not
 * refused over an unusable recipient key: the authorization is the human's
 * decision and stands, the digest still binds it, and the raw token is still
 * printed once on the granting surface. What fails is the convenience, and a
 * convenience must never be able to void a human's yes.
 */
export function sealToken(
  token: string,
  recipientPublicKey: string,
  actionKey: string,
): SealedToken | null {
  let recipient: KeyObject;
  try {
    recipient = publicKeyOf(recipientPublicKey);
  } catch {
    return null;
  }
  try {
    const ephemeral = generateKeyPairSync("x25519");
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", aeadKey(shared, actionKey), nonce);
    const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
      alg: SEAL_ALG,
      epk: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      nonce: nonce.toString("base64"),
      ct: ct.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } catch {
    return null;
  }
}

/** Read a `token_sealed` payload value as a {@link SealedToken}, or `null`. */
export function asSealedToken(value: unknown): SealedToken | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const fields = ["alg", "epk", "nonce", "ct", "tag"] as const;
  for (const field of fields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) return null;
  }
  if (record["alg"] !== SEAL_ALG) return null;
  return {
    alg: record["alg"] as string,
    epk: record["epk"] as string,
    nonce: record["nonce"] as string,
    ct: record["ct"] as string,
    tag: record["tag"] as string,
  };
}

/**
 * Open a sealed token with a recipient private key.
 *
 * Returns `null` for anything that does not authenticate: a wrong key, a
 * tampered ciphertext, a seal minted for a different action key. There is one
 * failure, deliberately: distinguishing "wrong key" from "wrong ciphertext"
 * would be an oracle, and the caller's response to either is identical — fall
 * back to the raw token the granting surface printed.
 */
export function openSealedToken(
  sealed: SealedToken,
  recipientPrivateKey: string,
  actionKey: string,
): string | null {
  try {
    const shared = diffieHellman({
      privateKey: privateKeyOf(recipientPrivateKey),
      publicKey: publicKeyOf(sealed.epk),
    });
    const decipher = createDecipheriv(
      "aes-256-gcm",
      aeadKey(shared, actionKey),
      Buffer.from(sealed.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, "base64")),
      decipher.final(),
    ]);
    const token = plain.toString("utf8");
    return token.length === 0 ? null : token;
  } catch {
    return null;
  }
}
