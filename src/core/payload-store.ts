/**
 * The payload store: one source of bytes for the gate, the render, and every
 * channel (SPEC.md §6.2, §9, §10.4; APRV-28).
 *
 * SPEC.md §6.2 already asks for this in one clause — "The payload itself is
 * stored or referenced by the request so channels can display it; the hash is
 * what approval binds to" — and until now nothing implemented it. The bytes a
 * human had to see before deciding were carried around the runtime by hand:
 * `--payload-dir` for the CLI and web channels, `--payloads` for Telegram, and
 * nothing at all for `approval render`, which is why QUEUE.md's pending count
 * disagreed with the queue every channel showed (the APRV-27 friction case).
 *
 * ## What this is
 *
 * A content-addressed directory, `.approval/payloads/` beside the log, holding
 * one file per bound payload: `<payload_hash>.json`, whose contents are the
 * exact material whose RFC 8785 canonical serialization hashes to the filename.
 * The name *is* the checksum, so the store needs no index, no manifest and no
 * lock: two writers writing the same payload write the same bytes to the same
 * path, and a file either verifies or it is refused.
 *
 * ## Verified on every read, without exception
 *
 * {@link loadPayload} re-canonicalizes and re-hashes what it read and compares
 * that against the filename before returning anything. A file whose contents
 * were edited after it was written refuses `hash-mismatch` and its value is
 * **never returned**, so tampering with the store cannot put different bytes in
 * front of an approver than the ones the request bound to. The recorded binding
 * on `approval.requested` stays authoritative in both directions: the store is a
 * cache of bytes that the log already committed to, and when the two disagree
 * the log is right and the store is refused.
 *
 * This is the same rule the rest of the codebase keeps — files are the
 * interface, the log is the truth, the database (and now the store) is a cache.
 *
 * ## External references
 *
 * A request may name material this runtime cannot hold: a message body in a
 * vault, an object in a bucket. The store records that as `{"$ref": "<uri>"}` in
 * the same `<hash>.json` file, and {@link loadPayload} reports it as a
 * `reference` — deliberately **not** resolved. Resolving a URI would mean
 * fetching bytes at render time from a source this module cannot verify, and a
 * channel that displayed them would be showing an approver something no hash
 * ever bound. So a reference renders as a reference: the channel says where the
 * payload lives and refuses to pretend it has seen it.
 *
 * ## Writes never touch the log
 *
 * Nothing here opens `events.jsonl`. {@link storePayload} writes exactly one
 * file, atomically (temp + rename in the destination directory), and the store
 * directory is a sibling of the log directory rather than a child, so no
 * conceivable store path collides with the log's.
 */

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

import { canonicalize } from "./jcs.js";
import { isPayloadHash, payloadHash } from "./payload.js";

/** The directory name, beside the log's home: `.approval/payloads/`. */
export const PAYLOAD_STORE_DIRNAME = "payloads";

/**
 * The store directory for a given log path — the convention every caller uses
 * when no explicit directory is supplied.
 *
 * SPEC.md §9 fixes the log at `<home>/log/events.jsonl`, so the store is
 * `<home>/payloads/`: a sibling of the log directory, never inside it. When a
 * caller points `--log` at some other layout the store lands beside that file
 * instead, which keeps the two together for the ad-hoc case without ever
 * placing payload files in the directory the log is walked from.
 */
export function payloadStoreDirFor(logPath: string): string {
  const logDir = dirname(logPath);
  const home = basename(logDir) === "log" ? dirname(logDir) : logDir;
  return join(home, PAYLOAD_STORE_DIRNAME);
}

/** The file one payload hash addresses. */
export function payloadPath(storeDir: string, hash: string): string {
  return join(storeDir, `${hash}.json`);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type StorePayloadResult =
  | { ok: true; hash: string; path: string }
  | { ok: false; code: "unserializable" | "write-failed"; message: string };

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Distinguishes concurrent writers' temp files within one process. */
let tempCounter = 0;

function writeAtomic(path: string, bytes: string): { ok: true } | { ok: false; message: string } {
  const directory = dirname(path);
  tempCounter += 1;
  const temp = join(
    directory,
    `.${basename(path)}.tmp-${String(process.pid)}-${String(tempCounter)}`,
  );
  try {
    mkdirSync(directory, { recursive: true });
    const handle = openSync(temp, "wx");
    try {
      writeSync(handle, bytes, 0, "utf8");
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
  return { ok: true };
}

/**
 * Store payload material and return the hash it is addressed by.
 *
 * The bytes written are the RFC 8785 canonical serialization itself — not
 * `JSON.stringify` of the value — so the file's own bytes hash to its own name
 * and the store is verifiable byte for byte as well as semantically.
 *
 * **Idempotent.** Writing the same value twice writes the same bytes to the same
 * path and reports the same hash. The write is unconditional rather than
 * skipped-if-present, which also means a corrupted file is repaired by the next
 * store of the same payload: content addressing makes "overwrite" and "leave
 * alone" the same operation for anything that was ever valid.
 *
 * Refuses `unserializable` for material RFC 8785 cannot serialize (a cycle, a
 * NaN, a function). A payload that cannot be canonicalized cannot be bound to,
 * so it must not be stored under a hash that would then name something else.
 */
export function storePayload(storeDir: string, value: unknown): StorePayloadResult {
  let hash: string;
  let bytes: string;
  try {
    bytes = canonicalize(value);
    hash = payloadHash(value);
  } catch (cause) {
    return {
      ok: false,
      code: "unserializable",
      message: `the payload material could not be canonicalized: ${detail(
        cause,
      )}. A payload that cannot be serialized cannot be bound to, so nothing was stored.`,
    };
  }

  const path = payloadPath(storeDir, hash);
  const written = writeAtomic(path, bytes);
  if (!written.ok) {
    return {
      ok: false,
      code: "write-failed",
      message: `payload ${hash} could not be written to ${path}: ${written.message}. Nothing was stored and the log was not touched.`,
    };
  }
  return { ok: true, hash, path };
}

/**
 * Record an external reference for a payload this runtime does not hold.
 *
 * The hash is supplied by the caller because a reference does not determine one:
 * the binding is a fact about the *payload*, which lives elsewhere, and the
 * reference is only a pointer to it. {@link loadPayload} reports the pointer and
 * resolves nothing — see the module header.
 */
export function storeReference(
  storeDir: string,
  hash: string,
  reference: string,
): StorePayloadResult {
  if (!isPayloadHash(hash)) {
    return {
      ok: false,
      code: "unserializable",
      message: `${JSON.stringify(hash)} is not a payload hash (SHA-256, lowercase hex); a reference must be filed under the hash the request bound to`,
    };
  }
  const path = payloadPath(storeDir, hash);
  const written = writeAtomic(path, canonicalize({ $ref: reference }));
  if (!written.ok) {
    return {
      ok: false,
      code: "write-failed",
      message: `reference for ${hash} could not be written to ${path}: ${written.message}`,
    };
  }
  return { ok: true, hash, path };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Why a read did not produce material. */
export type LoadPayloadRefusalCode =
  /** No file is stored under this hash. */
  | "absent"
  /** A file exists but its contents do not hash to its name. */
  | "hash-mismatch"
  /** The file could not be read, or is not JSON. */
  | "unreadable"
  /** The file holds a `{"$ref": …}` pointer, which is not resolved here. */
  | "reference";

export type LoadPayloadResult =
  | { ok: true; value: unknown; path: string }
  | {
      ok: false;
      code: LoadPayloadRefusalCode;
      message: string;
      path: string;
      /** The pointer, when `code` is `reference`. */
      reference?: string;
    };

/** Is this the `{"$ref": "<uri>"}` form, and nothing else? */
function referenceOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "$ref") return null;
  const ref = (value as { $ref: unknown }).$ref;
  return typeof ref === "string" ? ref : null;
}

/**
 * Load the material stored under `hash`, verifying it against `hash`.
 *
 * The verification is unconditional and the value is withheld when it fails:
 * `hash-mismatch` says the file on disk is not the payload the request bound to,
 * and returning it "so the caller can decide" would hand a channel exactly the
 * bytes the binding exists to keep away from an approver.
 */
export function loadPayload(storeDir: string, hash: string): LoadPayloadResult {
  const path = payloadPath(storeDir, hash);
  if (!isPayloadHash(hash)) {
    return {
      ok: false,
      code: "unreadable",
      message: `${JSON.stringify(hash)} is not a payload hash (SHA-256, lowercase hex); the store is addressed by hash and nothing else`,
      path,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, code: "absent", message: `no payload is stored at ${path}`, path };
    }
    return {
      ok: false,
      code: "unreadable",
      message: `payload ${path} could not be read: ${detail(cause)}`,
      path,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    return {
      ok: false,
      code: "unreadable",
      message: `payload ${path} is not valid JSON: ${detail(cause)}`,
      path,
    };
  }

  const reference = referenceOf(value);
  if (reference !== null) {
    return {
      ok: false,
      code: "reference",
      message: `payload ${hash} is stored as an external reference (${reference}) and is not resolved here; a channel may show the reference but must not present bytes no hash bound`,
      path,
      reference,
    };
  }

  let actual: string;
  try {
    actual = payloadHash(value);
  } catch (cause) {
    return {
      ok: false,
      code: "unreadable",
      message: `payload ${path} could not be canonicalized for verification: ${detail(cause)}`,
      path,
    };
  }

  if (actual !== hash) {
    return {
      ok: false,
      code: "hash-mismatch",
      message: `payload ${path} hashes to ${actual}, not to the ${hash} it is filed under; the stored bytes are not the bytes the request bound to and will not be rendered`,
      path,
    };
  }

  return { ok: true, value, path };
}
