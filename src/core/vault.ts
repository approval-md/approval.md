/**
 * The reference credential vault (SPEC.md §10.4, §11; APRV-68).
 *
 * SPEC.md §10.4 states the hard boundary in one sentence: adapters "hold the
 * actual credentials in an encrypted vault and MUST require a valid, unexpired,
 * single-use execution token bound to the action's `idempotency_key` … an agent
 * that bypasses the CLI still cannot send, spend, or delete, because the
 * credentials only answer to tokens." APRV-67 built the token half of that
 * sentence (`adapters/contract.ts`: a credential provider that is live only
 * inside the verified-token window). This module is the other half: the place
 * the values actually sit when nobody is executing.
 *
 * ## What it is
 *
 * One file, `.approval/vault.enc`, beside the log's home in the same way
 * `.approval/payloads/` is. It holds a JSON map from credential NAME to
 * credential string, encrypted with AES-256-GCM under a key derived by scrypt
 * from an operator passphrase. The passphrase is read from an environment
 * variable whose NAME the policy declares (`vault.passphrase_env`, default
 * {@link DEFAULT_PASSPHRASE_ENV}), which is the convention SPEC.md §5.1 already
 * uses for `channels.telegram.token_env` and §5.2 for
 * `audit.sampling_secret_env`: the policy file an agent may read carries a
 * variable name, never a value.
 *
 * ## Threat model, stated plainly (SPEC.md §11)
 *
 * **What the vault defends.** Credentials at rest: a repository, a backup, or a
 * synced folder that ends up somewhere it should not be carries ciphertext and
 * a KDF header, not an SMTP password. And casual reads by an agent with file
 * access: an agent that can `cat` every file in the working tree learns the
 * NAMES of nothing and the values of nothing, because the names live inside the
 * ciphertext too.
 *
 * **What it does not defend.** A compromised host. An agent that can read the
 * passphrase environment variable — such an agent can decrypt the file at
 * leisure, and no arrangement of this module changes that, which is why the
 * passphrase belongs in an operator-held environment (a keychain-populated
 * shell, a systemd credential) and outside every agent-readable path. Nor does
 * it defend against an operator who exports the passphrase into the same
 * process an agent drives. This is the same boundary SPEC.md §11 already draws
 * for the sampling secret and for human identity: the trust boundary is the
 * local machine, and anyone who can set that configuration is inside it. The
 * vault raises the cost of a credential leak from "read a file" to "own the
 * session"; it is not a claim of secrecy against the session's owner.
 *
 * ## Invariant 3 is the whole module
 *
 * SPEC.md §11.1 invariant 3 — raw secrets never appear in the log — is extended
 * here to every surface this module touches. No credential VALUE appears in a
 * return value except {@link getCredential}'s, in no message, no error, no
 * refusal, and nothing here writes to the log at all. {@link listCredentials}
 * returns names and a count. `set` and `remove` return counts. That asymmetry is
 * deliberate and is pinned by a test: the module has exactly one function that
 * can hand back a credential, and the adapter contract is what decides when it
 * may be called.
 *
 * ## Determinism, and the one place it stops
 *
 * Reads are pure functions of the file bytes and the passphrase. Writes are not:
 * every write draws a fresh 96-bit nonce and (on creation) a fresh 128-bit salt,
 * so two writes of the same map produce different files. That is required, not
 * incidental — GCM is catastrophically broken by nonce reuse under one key, and
 * a deterministic file would also leak "nothing changed" to an observer who only
 * sees the ciphertext.
 *
 * Nothing here throws. Every failure is a `{ ok: false, code, message }` from
 * the frozen union {@link VAULT_REFUSAL_CODES}.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { basename, dirname, join } from "node:path";

import { canonicalize } from "./jcs.js";
import type { PolicyLoadResult } from "./policy-load.js";

// ---------------------------------------------------------------------------
// Locations and names
// ---------------------------------------------------------------------------

/** The vault's filename, beside the log's home: `.approval/vault.enc`. */
export const VAULT_FILENAME = "vault.enc";

/**
 * The environment variable the passphrase is read from when the policy declares
 * no `vault.passphrase_env`.
 *
 * A default rather than a hard requirement, because a runtime with no policy at
 * all (or with an unparseable one) must still be able to open a vault an
 * operator created: the variable name is not a permission, and treating it as
 * one would mean an unrelated policy typo locked the credentials.
 */
export const DEFAULT_PASSPHRASE_ENV = "APPROVAL_VAULT_PASSPHRASE";

/**
 * The vault file for a given log path — the convention every caller uses.
 *
 * Derived exactly as `payloadStoreDirFor` derives the payload store, so the
 * vault, the store, and the log stay together under one home: SPEC.md §9 fixes
 * the log at `<home>/log/events.jsonl`, so the vault is `<home>/vault.enc`, a
 * sibling of the log DIRECTORY and never inside it. Pointing `--log` at some
 * other layout puts the vault beside that file instead.
 */
export function vaultPathFor(logPath: string): string {
  const logDir = dirname(logPath);
  const home = basename(logDir) === "log" ? dirname(logDir) : logDir;
  return join(home, VAULT_FILENAME);
}

/**
 * The NAME of the environment variable this policy says the passphrase lives in.
 *
 * The name only, in both directions: a policy that carried a passphrase would be
 * a passphrase in a file agents may read, which is the thing the vault exists to
 * avoid. A policy that failed to load names nothing, so the default applies.
 */
export function passphraseEnvFor(load: PolicyLoadResult): string {
  if (!load.ok) return DEFAULT_PASSPHRASE_ENV;
  const declared = load.policy.vault?.passphrase_env;
  return typeof declared === "string" && declared.length > 0
    ? declared
    : DEFAULT_PASSPHRASE_ENV;
}

/** Is there a vault file at this path? Says nothing about whether it opens. */
export function vaultExists(vaultPath: string): boolean {
  try {
    return statSync(vaultPath).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Everything this module can refuse. Frozen public API, per SPEC.md §11.1(6).
 *
 * Each code names a different repair, which is the test of whether a code earns
 * its place. Note the one deliberate *conflation*: {@link "vault-unreadable"}
 * covers both a wrong passphrase and an altered file, and the message says so
 * rather than choosing. Distinguishing them would publish an oracle — a caller
 * who could tell "your passphrase is wrong" from "these bytes were tampered
 * with" could confirm a guessed passphrase against a file they had modified, and
 * GCM's authentication tag cannot tell the two apart anyway without first
 * trusting one of them.
 */
export const VAULT_REFUSAL_CODES = [
  /** No vault file exists. The repair is `approval vault set <name>`. */
  "vault-absent",
  /** The named environment variable is unset or empty in this process. */
  "passphrase-unset",
  /** The file could not be read or written. A filesystem fact, not a secret. */
  "vault-io",
  /** The file is not the JSON envelope this module writes, or its header lies. */
  "vault-malformed",
  /** The file declares a format version this build does not implement. */
  "vault-version-unsupported",
  /**
   * The ciphertext did not authenticate: the passphrase is wrong OR the file
   * was altered. Deliberately not distinguished — see the union's own doc.
   */
  "vault-unreadable",
  /** The vault opened and holds no credential under that name. */
  "credential-absent",
  /** The credential name is empty or not a usable name. */
  "invalid-name",
  /** The credential value is empty. An empty secret is a configuration error. */
  "empty-value",
  /** The re-encrypted file could not be put in place. Nothing was changed. */
  "vault-write-failed",
] as const;

export type VaultRefusalCode = (typeof VAULT_REFUSAL_CODES)[number];

/** Every failure of this module. Nothing here throws. */
export interface VaultRefusal {
  ok: false;
  code: VaultRefusalCode;
  message: string;
  /** The file the refusal is about, so a caller need not reconstruct it. */
  path: string;
}

function refuse(code: VaultRefusalCode, path: string, message: string): VaultRefusal {
  return { ok: false, code, message, path };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

/**
 * The only format version this build writes or reads.
 *
 * Versioned from the first byte so that a future scheme (a different AEAD, an
 * Argon2 KDF, a hardware-backed key) is a migration with two readers rather than
 * a silent reinterpretation of old bytes. A file declaring anything else is
 * refused {@link "vault-version-unsupported"} and left untouched: guessing at an
 * unknown layout is how a decryption bug becomes a corrupted vault.
 */
export const VAULT_FORMAT_VERSION = 1;

/**
 * scrypt cost parameters, written into every file and read back from it.
 *
 * `N = 16384, r = 8, p = 1` is the classic interactive tuning: about 16 MiB of
 * memory (128·N·r) and something on the order of 100 ms on a laptop, which is a
 * meaningful brute-force cost against a human-typed passphrase while staying
 * fast enough for a CLI verb a human runs interactively. `keylen` is 32 bytes,
 * because AES-256-GCM takes a 256-bit key.
 *
 * The parameters live in the FILE rather than only in this constant so that a
 * vault written under one tuning still opens after the tuning changes. They are
 * bounded on read ({@link readKdf}) rather than trusted: a header claiming
 * `N = 2^40` would otherwise be a denial-of-service delivered as a config file.
 */
export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;

/** Bounds on the KDF parameters this build will honour from a file's header. */
const KDF_LIMITS = { minN: 1 << 12, maxN: 1 << 20, maxR: 32, maxP: 16 } as const;

/** 96 bits: the nonce size GCM is specified and optimised for. */
const NONCE_BYTES = 12;
/** 128 bits of salt. Per-vault, so two vaults never share a derived key. */
const SALT_BYTES = 16;
/** The full GCM tag. Truncating it would weaken the only integrity check here. */
const TAG_BYTES = 16;

interface KdfHeader {
  alg: "scrypt";
  N: number;
  r: number;
  p: number;
  salt_b64: string;
}

interface VaultFile {
  version: number;
  kdf: KdfHeader;
  nonce_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
}

/**
 * The additional authenticated data for the AEAD: the header, canonically
 * serialized.
 *
 * Binding the header to the ciphertext is what stops a header-only edit. Without
 * it an attacker could swap the salt or drop `N` to 4096 and hand the file back;
 * the decryption would simply fail, but it would fail *after* the runtime had
 * spent the attacker's chosen work factor, and a future format that recovered
 * partial state would fail worse. RFC 8785 canonicalization is used so the AAD
 * bytes are a function of the header's VALUES and not of how a writer happened
 * to order or space them.
 */
function headerAad(version: number, kdf: KdfHeader, nonceB64: string): Buffer {
  return Buffer.from(canonicalize({ version, kdf, nonce_b64: nonceB64 }), "utf8");
}

function deriveKey(passphrase: string, salt: Buffer, kdf: KdfHeader): Buffer {
  // maxmem is set from the file's own parameters (with headroom) rather than
  // left at Node's 32 MiB default, so a legitimately expensive vault opens
  // instead of throwing an opaque "memory limit exceeded".
  const maxmem = 256 * kdf.N * kdf.r + 1024 * 1024;
  return scryptSync(passphrase, salt, SCRYPT_PARAMS.keylen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem,
  });
}

/** Base64 that round-trips to exactly `bytes` bytes, or `null`. */
function decodeExact(text: unknown, bytes: number): Buffer | null {
  if (typeof text !== "string") return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(text, "base64");
  } catch {
    return null;
  }
  return buffer.length === bytes ? buffer : null;
}

function readKdf(value: unknown): KdfHeader | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw["alg"] !== "scrypt") return null;
  const N = raw["N"];
  const r = raw["r"];
  const p = raw["p"];
  const salt = raw["salt_b64"];
  if (typeof N !== "number" || !Number.isInteger(N) || N < KDF_LIMITS.minN || N > KDF_LIMITS.maxN) {
    return null;
  }
  // scrypt requires N to be a power of two; an N that is not one would throw
  // out of `scryptSync`, and this module does not throw.
  if ((N & (N - 1)) !== 0) return null;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 1 || r > KDF_LIMITS.maxR) return null;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > KDF_LIMITS.maxP) return null;
  if (typeof salt !== "string" || decodeExact(salt, SALT_BYTES) === null) return null;
  return { alg: "scrypt", N, r, p, salt_b64: salt };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The decrypted map. Never returned to a caller outside this module. */
type Entries = Record<string, string>;

interface Opened {
  ok: true;
  entries: Entries;
  /** The KDF header the file carried, reused when the same file is rewritten. */
  kdf: KdfHeader;
}

/**
 * Decrypt the vault at `vaultPath`.
 *
 * **Not exported.** The plaintext map is the one thing this module must not hand
 * out wholesale: an exported `openVault` would be a single call that returns
 * every credential, and a caller who could make it would have no reason to go
 * through the adapter contract's token window. Everything public here is built
 * on top of this and returns names, counts, or exactly one requested value.
 */
function open(vaultPath: string, passphrase: string): Opened | VaultRefusal {
  let raw: string;
  try {
    raw = readFileSync(vaultPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return refuse(
        "vault-absent",
        vaultPath,
        `no vault at ${vaultPath}; credentials are stored there by \`approval vault set <name>\` and nothing else creates it`,
      );
    }
    return refuse("vault-io", vaultPath, `vault ${vaultPath} could not be read: ${detail(cause)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    return refuse(
      "vault-malformed",
      vaultPath,
      `vault ${vaultPath} is not the JSON envelope this runtime writes: ${detail(cause)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("vault-malformed", vaultPath, `vault ${vaultPath} is not a JSON object`);
  }

  const file = parsed as Partial<VaultFile>;
  if (file.version !== VAULT_FORMAT_VERSION) {
    return refuse(
      "vault-version-unsupported",
      vaultPath,
      `vault ${vaultPath} declares format version ${JSON.stringify(file.version)}; this build reads version ${String(VAULT_FORMAT_VERSION)} only, and guessing at an unknown layout is how a vault gets destroyed rather than opened`,
    );
  }

  const kdf = readKdf(file.kdf);
  const nonce = decodeExact(file.nonce_b64, NONCE_BYTES);
  const tag = decodeExact(file.tag_b64, TAG_BYTES);
  if (kdf === null || nonce === null || tag === null) {
    return refuse(
      "vault-malformed",
      vaultPath,
      `vault ${vaultPath} has a header this runtime will not act on (expected kdf {alg:"scrypt", N (a power of two in [${String(KDF_LIMITS.minN)}, ${String(KDF_LIMITS.maxN)}]), r, p, salt_b64}, a ${String(NONCE_BYTES)}-byte nonce_b64 and a ${String(TAG_BYTES)}-byte tag_b64)`,
    );
  }
  if (typeof file.ciphertext_b64 !== "string") {
    return refuse("vault-malformed", vaultPath, `vault ${vaultPath} carries no ciphertext_b64`);
  }

  const salt = decodeExact(kdf.salt_b64, SALT_BYTES);
  if (salt === null) {
    return refuse("vault-malformed", vaultPath, `vault ${vaultPath} has an unusable kdf.salt_b64`);
  }

  let plaintext: Buffer;
  try {
    const key = deriveKey(passphrase, salt, kdf);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(headerAad(VAULT_FORMAT_VERSION, kdf, file.nonce_b64 as string));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext_b64, "base64")),
      decipher.final(),
    ]);
  } catch {
    // The cause is deliberately dropped rather than reported. Node's message
    // here is always the same string, but a future one that distinguished the
    // failure modes would turn this refusal into the oracle the union's doc
    // explains we will not publish.
    return refuse(
      "vault-unreadable",
      vaultPath,
      `passphrase wrong or file altered (${vaultPath}). These two are not distinguished on purpose: a runtime that told you which would let someone confirm a guessed passphrase against a file they had modified. Check the passphrase first, then the file's provenance.`,
    );
  }

  let entries: unknown;
  try {
    entries = JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch (cause) {
    return refuse(
      "vault-malformed",
      vaultPath,
      `vault ${vaultPath} decrypted to something that is not JSON: ${detail(cause)}`,
    );
  }
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    return refuse(
      "vault-malformed",
      vaultPath,
      `vault ${vaultPath} decrypted to a ${Array.isArray(entries) ? "list" : typeof entries}, not the name -> credential map this runtime stores`,
    );
  }
  const map: Entries = {};
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    // A non-string member is dropped rather than reported with its value: the
    // report would be the leak. The count tells the operator something is off.
    if (typeof value === "string") map[name] = value;
  }

  return { ok: true, entries: map, kdf };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Distinguishes concurrent writers' temp files within one process. */
let tempCounter = 0;

/**
 * Encrypt `entries` under a fresh nonce and put the file in place atomically.
 *
 * Fresh nonce on EVERY write, without exception: GCM under a repeated (key,
 * nonce) pair leaks the XOR of the plaintexts and, worse, the authentication
 * subkey, which turns an encrypted vault into a forgeable one. The salt is
 * reused when a vault is being rewritten (so an unchanged passphrase still
 * opens it) and drawn fresh when one is being created.
 *
 * temp + rename in the destination directory, and mode 0600 on the temp file
 * before any bytes are written, so the ciphertext is never briefly world
 * readable and an interrupted write leaves the previous vault intact.
 */
function writeVault(
  vaultPath: string,
  passphrase: string,
  entries: Entries,
  existingKdf: KdfHeader | null,
): { ok: true } | VaultRefusal {
  const kdf: KdfHeader = existingKdf ?? {
    alg: "scrypt",
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    salt_b64: randomBytes(SALT_BYTES).toString("base64"),
  };
  const salt = decodeExact(kdf.salt_b64, SALT_BYTES);
  if (salt === null) {
    return refuse("vault-write-failed", vaultPath, `the vault's salt is unusable; nothing was written`);
  }

  let file: VaultFile;
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const nonceB64 = nonce.toString("base64");
    const key = deriveKey(passphrase, salt, kdf);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(headerAad(VAULT_FORMAT_VERSION, kdf, nonceB64));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(entries), "utf8")),
      cipher.final(),
    ]);
    file = {
      version: VAULT_FORMAT_VERSION,
      kdf,
      nonce_b64: nonceB64,
      tag_b64: cipher.getAuthTag().toString("base64"),
      ciphertext_b64: ciphertext.toString("base64"),
    };
  } catch (cause) {
    return refuse(
      "vault-write-failed",
      vaultPath,
      `the vault could not be encrypted: ${detail(cause)}. Nothing was written.`,
    );
  }

  const directory = dirname(vaultPath);
  tempCounter += 1;
  const temp = join(
    directory,
    `.${basename(vaultPath)}.tmp-${String(process.pid)}-${String(tempCounter)}`,
  );
  try {
    mkdirSync(directory, { recursive: true });
    const handle = openSync(temp, "wx", 0o600);
    try {
      writeSync(handle, `${JSON.stringify(file, null, 2)}\n`, 0, "utf8");
    } finally {
      closeSync(handle);
    }
    // Explicit chmod as well as the open mode: a permissive umask does not
    // affect `openSync`'s mode argument, but a pre-existing file replaced by
    // rename should not inherit anything looser either.
    chmodSync(temp, 0o600);
    renameSync(temp, vaultPath);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return refuse(
      "vault-write-failed",
      vaultPath,
      `vault ${vaultPath} could not be written: ${detail(cause)}. The previous vault, if any, is unchanged.`,
    );
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The public operations
// ---------------------------------------------------------------------------

/** A credential name: non-empty, no whitespace, no control characters. */
const NAME_PATTERN = /^[\x21-\x7e]+$/u;

function checkName(name: string, vaultPath: string): VaultRefusal | null {
  if (typeof name !== "string" || name.length === 0 || !NAME_PATTERN.test(name)) {
    return refuse(
      "invalid-name",
      vaultPath,
      `${JSON.stringify(name)} is not a usable credential name: names are non-empty printable ASCII without spaces, so that an adapter can ask for one by name from a configuration file`,
    );
  }
  return null;
}

/** What every mutating operation reports. Counts and names, never values. */
export interface VaultWriteResult {
  ok: true;
  path: string;
  name: string;
  /** How many credentials the vault holds after the operation. */
  count: number;
  /** True when this call added a name the vault did not already hold. */
  created: boolean;
}

/**
 * Store `value` under `name`, creating the vault when it does not exist.
 *
 * The whole map is decrypted, amended, and re-encrypted under a fresh nonce:
 * there is no partial update, because an AEAD over the whole document is what
 * makes a partial edit detectable in the first place.
 *
 * `value` is a parameter and nothing else — never logged, never echoed, never
 * placed in a message, including in the refusals this can return.
 */
export function setCredential(
  vaultPath: string,
  passphrase: string,
  name: string,
  value: string,
): VaultWriteResult | VaultRefusal {
  const badName = checkName(name, vaultPath);
  if (badName !== null) return badName;
  if (typeof value !== "string" || value.length === 0) {
    return refuse(
      "empty-value",
      vaultPath,
      `the value for ${JSON.stringify(name)} is empty; an empty credential is a configuration mistake that would surface as an authentication failure at the far end, so it is refused here instead`,
    );
  }
  if (passphrase.length === 0) {
    return refuse(
      "passphrase-unset",
      vaultPath,
      `the vault passphrase is empty; nothing was written`,
    );
  }

  let entries: Entries = {};
  let kdf: KdfHeader | null = null;
  if (vaultExists(vaultPath)) {
    const opened = open(vaultPath, passphrase);
    if (!opened.ok) return opened;
    entries = opened.entries;
    kdf = opened.kdf;
  }

  const created = !Object.prototype.hasOwnProperty.call(entries, name);
  entries[name] = value;

  const written = writeVault(vaultPath, passphrase, entries, kdf);
  if (!written.ok) return written;
  return { ok: true, path: vaultPath, name, count: Object.keys(entries).length, created };
}

/**
 * Delete `name`. A name the vault does not hold refuses `credential-absent`
 * rather than reporting success: an operator removing a credential wants to know
 * whether they removed the one they meant.
 */
export function removeCredential(
  vaultPath: string,
  passphrase: string,
  name: string,
): VaultWriteResult | VaultRefusal {
  const badName = checkName(name, vaultPath);
  if (badName !== null) return badName;

  const opened = open(vaultPath, passphrase);
  if (!opened.ok) return opened;

  if (!Object.prototype.hasOwnProperty.call(opened.entries, name)) {
    return refuse(
      "credential-absent",
      vaultPath,
      `the vault holds no credential named ${JSON.stringify(name)}; nothing was removed and the file is unchanged`,
    );
  }
  const entries = opened.entries;
  // Overwrite before deleting: the string itself is immutable and this does not
  // scrub the heap, but it does keep the doomed value out of the map that is
  // about to be re-serialized even if a later edit here reordered the two steps.
  entries[name] = "";
  delete entries[name];

  const written = writeVault(vaultPath, passphrase, entries, opened.kdf);
  if (!written.ok) return written;
  return { ok: true, path: vaultPath, name, count: Object.keys(entries).length, created: false };
}

/** What the vault holds, by name. There is no shape here that carries a value. */
export interface VaultListing {
  ok: true;
  path: string;
  /** Sorted credential names. */
  names: string[];
  count: number;
}

/**
 * The names in the vault, sorted, and how many there are.
 *
 * Names and nothing else, on every path including the error ones. Sorted so two
 * listings of the same vault are byte-identical, which is what lets a test and
 * an operator compare them.
 */
export function listCredentials(
  vaultPath: string,
  passphrase: string,
): VaultListing | VaultRefusal {
  const opened = open(vaultPath, passphrase);
  if (!opened.ok) return opened;
  const names = Object.keys(opened.entries).sort();
  return { ok: true, path: vaultPath, names, count: names.length };
}

/** The one shape in this module that carries a credential value. */
export interface VaultCredential {
  ok: true;
  path: string;
  name: string;
  value: string;
}

/**
 * The value stored under `name`.
 *
 * **The only function here that returns a credential**, which is the module's
 * structural rule and is pinned by `tests/vault.test.ts`. There is no
 * `approval vault get`, because a verb that printed a credential would put it
 * in a terminal, a scrollback buffer, a CI log, and a shell history, and would
 * do so on a machine where the whole point is that the value only ever travels
 * from this file into the use it was stored for.
 *
 * **Two sanctioned callers** (flagged by APRV-220, decided by APRV-257):
 *
 * 1. `adapters/vault-provider.ts`, whose provider `executeThroughAdapter`
 *    scopes to the verified-token window.
 * 2. `cli/checkpoint-tap.ts`, which reads `approval.checkpoint.key` and hands
 *    it to `core/checkpoint.ts`'s signer — the one custody decision for every
 *    surface that can take a checkpoint.
 *
 * The rule this list keeps is not "one caller". It is that a credential's value
 * goes from this file into a USE and never onto a SURFACE, and both callers
 * obey it: the second takes a private key into an Ed25519 signature and hands
 * back a signature and a fingerprint of the PUBLIC half.
 *
 * The alternative — move the checkpoint key somewhere else and keep this list
 * at one name — was considered and rejected, because it would have made the key
 * weaker rather than the module cleaner. The OS keystore has no equivalent of
 * the passphrase variable `core/child-env.ts` strips from every child
 * (APRV-205), and a file beside the log has no encryption at all. A checkpoint
 * key is the one secret whose entire value is that a process an agent launched
 * cannot reach it, so it belongs in the strictest store this runtime has. What
 * that costs is a second name in this comment.
 */
export function getCredential(
  vaultPath: string,
  passphrase: string,
  name: string,
): VaultCredential | VaultRefusal {
  const badName = checkName(name, vaultPath);
  if (badName !== null) return badName;

  const opened = open(vaultPath, passphrase);
  if (!opened.ok) return opened;

  const value = opened.entries[name];
  if (typeof value !== "string") {
    return refuse(
      "credential-absent",
      vaultPath,
      `the vault holds no credential named ${JSON.stringify(name)}; store one with \`approval vault set ${name}\``,
    );
  }
  return { ok: true, path: vaultPath, name, value };
}

/**
 * Does this passphrase open the vault, and how many credentials does it hold?
 *
 * The diagnostic form, for `approval doctor`: a yes/no plus a count, with no
 * name and no value in either the success or the failure. Distinct from
 * {@link listCredentials} because a health check has no business learning which
 * credentials an operator keeps.
 */
export function checkVault(
  vaultPath: string,
  passphrase: string,
): { ok: true; path: string; count: number } | VaultRefusal {
  const opened = open(vaultPath, passphrase);
  if (!opened.ok) return opened;
  return { ok: true, path: vaultPath, count: Object.keys(opened.entries).length };
}

/**
 * Read the passphrase from the environment variable named by `envName`.
 *
 * Returns the value, or `null` when it is unset or empty. A separate function
 * so that every caller reads the passphrase the same way and so that no caller
 * is tempted to accept one as a flag: a passphrase on a command line is a
 * passphrase in the shell history, in `ps`, and in the parent process's
 * environment.
 */
export function passphraseFrom(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[envName];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Constant-time equality for two secrets, exported for callers that must
 * compare one without leaking its length-prefix through timing.
 *
 * Not used by the vault's own paths (nothing here compares credentials), but the
 * alternative — a caller writing `a === b` over a secret — is the kind of thing
 * that gets written once and copied five times.
 */
export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
