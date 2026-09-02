/**
 * Derived state: the one place the runtime turns the log into answers
 * (SPEC.md §6.3, §7, §8).
 *
 * Everything the gate, the token module, and the executor believe about an
 * action comes from here. The module exists for two reasons, both structural,
 * both from the APRV-20 review:
 *
 * 1. **Verified reads (finding S1).** {@link readVerifiedRecords} is the only
 *    sanctioned way for a decision-making module to read the log. It runs the
 *    *full* chain verification — hash recompute, schema validation, `prev`/`seq`
 *    walk — by calling `core/verify.ts`'s {@link verifyWithRecords}, and refuses
 *    a corrupt log outright. Before this, the gate parsed lines as JSON and
 *    trusted them: a forged or spliced record could authorize an action, and the
 *    corruption would surface only when someone ran `approval log verify`. A
 *    permission system that reads its own evidence without checking it is not a
 *    permission system.
 *
 *    APRV-43 lifted the linear cost that S1 accepted; see "The verified-read
 *    cache" below. What it did not lift is the rule: a decision is still made
 *    only from records this process verified in full, against bytes it proved
 *    unchanged.
 *
 * 2. **One derivation, no cycle (finding S4).** {@link requestState} used to
 *    live in `core/gate.ts`, which `core/token.ts` imported — while
 *    `core/gate.ts` imported `core/token.ts` to mint at grant. That import cycle
 *    made "which module owns approval state?" unanswerable. The derivation lives
 *    here now; `gate.ts`, `token.ts`, and `execute.ts` all import it, and the
 *    only remaining edge between them is the intended one, gate → token, at the
 *    mint seam. `gate.ts` re-exports the moved names so existing importers (the
 *    CLI, the tests) are unaffected.
 *
 * ## The verified-read cache (APRV-43), and why it is not a bypass
 *
 * A daemon re-reads the log on every watch event. Re-verifying from genesis
 * every time makes a session quadratic in the log it is watching, so
 * {@link readVerifiedRecords} keeps a process-lifetime, memory-only cache of the
 * last log it verified clean: the prefix bytes' length, a SHA-256 over those
 * bytes, the head line's bytes at their offset, the chain head, and the records
 * the walk produced. On the next read of the same path, a prefix proved
 * byte-identical is not re-walked; only the appended suffix is verified, chained
 * onto the cached head.
 *
 * **Global invariant 1 ("enforcement paths read only verified records") is what
 * this touches, so the argument is written out rather than assumed.**
 *
 * The tempting design is the cheap one: remember the head line and its offset,
 * and on a re-read accept the prefix if the head line is byte-identical where it
 * was. That design is unsound, and the specific attack says why. Append-only
 * growth is a convention the *writer* honors; it is not a property of the file.
 * An attacker with write access can mutate a record strictly before the head
 * without changing its length — swap two characters of a `summary`, flip a digit
 * of `est_cost_usd` — leaving the file size, the head line, and the head line's
 * offset all identical. Nothing in the suffix walk touches those bytes. The
 * forged record would be handed to the gate as verified, and a hash chain would
 * have been defeated by a cache. "Byte-identical head at the same offset" does
 * not imply "unchanged prefix", and no amount of `stat` makes it imply that.
 *
 * So the cache pays for what it claims: it stores a SHA-256 over the entire
 * verified prefix and **re-hashes those bytes on every cached read**. A match
 * proves the prefix on disk is bit-for-bit the prefix this process verified in
 * full, in this process lifetime. Verification is a pure function of (bytes,
 * schema files, options) — `core/verify.ts` says so and holds no state — so
 * identical bytes verify identically, and replaying the walk over them could
 * only reproduce the records already held. The cache therefore never *admits* a
 * record: it declines to recompute a conclusion it has already computed from
 * bytes it has just re-proved. Every record the caller receives was walked
 * through the full check ladder (parse, `alg`, schema, hash recompute, `seq`
 * succession, `prev` link) by this process, over exactly these bytes.
 *
 * **APRV-217 makes the last sentence conditional, and only under a policy that
 * says so.** Under the default proof (`full`) the paragraph above is exactly
 * what happens on every cached read. Under `incremental`, an operator's policy
 * trades "re-hash the whole prefix on every read" for "hash the appended bytes,
 * and re-hash the whole prefix on a cadence" — same guards, same walk, same
 * verdicts, a bounded window in which an in-place rewrite of the prefix would be
 * served from cache. The argument for that trade, and what it costs, is in the
 * "incremental prefix proof" section below and in
 * `docs/proposals/incremental-prefix-proof.md`.
 *
 * That is still a large win, because the two costs are not comparable: hashing
 * bytes is a single linear pass at memory bandwidth, while the walk it replaces
 * is a JSON parse, an Ajv schema validation, a JCS canonicalization, and a
 * SHA-256 *per record*. The cache trades a full re-verification for a hash of
 * the same bytes and a real verification of the new tail.
 *
 * Everything else the cache records is a discard trigger and never a licence:
 *
 * - **Size** shrinking below the cached prefix discards the entry. A shorter
 *   file cannot contain the prefix, and a truncated log must be re-read cold so
 *   that the head reported is the file's head, never the remembered one.
 * - **mtime** is a staleness hint with no evidentiary weight. It can only cause
 *   a discard (a same-size file whose mtime moved is suspicious), never skip a
 *   check. Correctness does not depend on its granularity, on the clock being
 *   monotonic, or on the filesystem storing it at all: delete the mtime
 *   comparison and the cache is exactly as sound.
 * - **The head line's bytes at their recorded offset** are compared before the
 *   prefix hash. This is a fast rejection of the ordinary tamper, not the proof;
 *   the prefix hash covers those same bytes and is what the soundness argument
 *   rests on.
 * - **The schema directory** is part of the key. Records verified against one
 *   schema set are not evidence under another.
 *
 * Only a `clean` verdict populates the cache. A torn tail or a corrupt log
 * leaves the previous entry in place unused (it is discarded on the mismatch
 * that revealed the damage), so nothing derived from a broken read can ever be
 * resumed from. And the cache is memory-only and process-lifetime: no file, no
 * shared state between processes, nothing an attacker can pre-seed. A CLI
 * invocation is a fresh process with an empty cache and behaves exactly as it
 * did before this existed.
 *
 * Records handed out from the cache are deep-frozen, because a caller that
 * mutated a returned record would otherwise corrupt the next reader's evidence.
 * Freezing makes the aliasing safe instead of merely unlikely.
 *
 * Determinism: `requestState` and everything downstream of it read no clock, no
 * network, and no cache; `ts` is a parameter everywhere, so a derivation can be
 * replayed from the log exactly as it was made. The cache sits strictly above
 * that line, in the read path, and is observationally invisible: for the same
 * bytes it returns the same records and the same verdict as a cold read, which
 * `tests/state-cache.test.ts` asserts scenario by scenario.
 */

import { createHash, type Hash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { isPolicySha256, POLICY_HASH_FIELD } from "./attest.js";
import { onLogAppended, type EventRecord, type LogHead } from "./log.js";
import { normalizeUsd } from "./money.js";
import { isPayloadHash } from "./payload.js";
import { publishVerifiedPrefix, snapshotPrefix } from "./verified-snapshot.js";
import {
  verifyText,
  verifyWithRecords,
  type VerifiedLog,
  type VerifiedPrefix,
  type VerifyOptions,
} from "./verify.js";

// ---------------------------------------------------------------------------
// Verified log reads
// ---------------------------------------------------------------------------

/**
 * Why a verified read refused. These names are shared verbatim by the gate, the
 * token module, and the executor, so the CLI maps all three onto the frozen exit
 * table with one function.
 */
export type LogReadRefusalCode =
  /** The log could not be opened (permissions, a directory, a broken path). */
  | "log-unreadable"
  /** The log's final line is unterminated: the signature of a crashed write. */
  | "log-torn-tail"
  /**
   * The chain does not verify: a mutated, spliced, reordered, or schema-invalid
   * record. Distinct from `log-unreadable` because the facts are different — one
   * is a filesystem problem, the other is evidence of tampering — and the
   * repairs are different. `approval log verify` owns the detailed vocabulary
   * (`hash-mismatch`, `seq-gap`, …); this code says only "the log is not
   * trustworthy, so nothing may be authorized from it".
   */
  | "log-corrupt";

/** A refused read. Structurally a subset of every consumer's refusal shape. */
export interface LogReadRefusal {
  ok: false;
  code: LogReadRefusalCode;
  message: string;
}

/** A successful verified read: the records and the head they end at. */
export interface VerifiedRecords {
  ok: true;
  records: EventRecord[];
  /**
   * The chain head — `(seq, hash)` of the last record, or `null` for an empty
   * log. This is what a caller passes as `appendEvent`'s `expectedHead`, so that
   * a decision made from these records cannot be appended onto a log that moved
   * underneath it (APRV-20 finding B1).
   */
  head: LogHead | null;
}

export type ReadRecordsResult = VerifiedRecords | LogReadRefusal;

/** Options accepted by {@link readVerifiedRecords}. */
export interface ReadVerifiedOptions extends VerifyOptions {
  /**
   * Verified-read cache to use.
   *
   * Defaults to {@link processReadCache}, so a repeat reader (the daemon's watch
   * loop) is accelerated with no wiring and a one-shot CLI process cannot tell
   * the difference. Pass an own {@link VerifiedReadCache} to keep a private one,
   * or `null` to force a cold verification from genesis — which is what an
   * explicit audit wants, and what the equivalence tests compare against.
   */
  cache?: VerifiedReadCache | null;
  /**
   * Publish a verified-head snapshot beside the log after a clean read
   * (APRV-188).
   *
   * Off by default, and set by exactly one caller: the daemon, whose warm cache
   * makes it the process that has already done the walk every hook process
   * would otherwise repeat. It is set on the READ rather than done afterwards
   * so the bytes endorsed are the bytes verified — a publisher that re-read the
   * file to hash it could endorse a digest of bytes nobody walked.
   */
  publishSnapshot?: boolean;
  /**
   * Which prefix proof a cached read runs (APRV-217).
   *
   * Absent means {@link FULL_READ_PROOF}: today's behaviour, byte for byte, for
   * every caller that does not ask otherwise. It is set by exactly one kind of
   * caller — a long-lived process (the daemon) that was handed a policy or a
   * flag naming `incremental`. One-shot processes, the hook included, never set
   * it, and a `cache: null` read ignores it entirely.
   */
  readProof?: ReadProof;
}

/**
 * Whether this process may resume a read behind a published snapshot
 * (APRV-188).
 *
 * Off by default, so the daemon, every CLI verb, the channels and
 * `approval log verify` read exactly as they did before this existed. It is
 * turned on by one caller, `approval hook`, which is the short-lived process
 * whose empty cache pays for the walk.
 *
 * A process-wide switch rather than a per-call option on purpose. A hook's
 * first verified read is followed by several more from inside `core/gate.ts`,
 * which threads no options of its own; if the switch were an option only the
 * first read could carry it, and the value is in the FIRST read of a process,
 * with the rest served from the cache the first one seeded.
 */
let snapshotReads = false;

/**
 * The proof this process's cached reads run when a call names none (APRV-217).
 *
 * `null` means {@link FULL_READ_PROOF}, and that is what every process starts
 * with: a CLI verb, a hook, a test, and a daemon before its own startup line.
 *
 * It is a process-wide switch for the reason `snapshotReads` above is one. The
 * daemon's tick reads are only some of the reads its process makes: the queue
 * renderer and the pending-queue builder read the same log through call paths
 * that thread no options of their own, and a per-call option could not reach
 * them. What sets this is `approval daemon run` / `approval up`, once, from the
 * mode they printed on the `started` line. Nothing an agent runs sets it.
 */
let processReadProof: ReadProof | null = null;

/**
 * Set (or clear, with `null`) the default proof for this process's reads.
 *
 * Called by exactly one kind of caller: the two long-lived operator verbs, at
 * startup, after they have resolved the flag against the policy.
 */
export function useReadProof(proof: ReadProof | null): void {
  processReadProof = proof;
}

/** The default proof in force here. Diagnostics and tests. */
export function readProofInForce(): ReadProof {
  return processReadProof ?? FULL_READ_PROOF;
}

/** Opt this process into (or out of) snapshot-resumed reads. */
export function useVerifiedSnapshots(enabled: boolean): void {
  snapshotReads = enabled;
}

/** Whether snapshot-resumed reads are enabled here. Diagnostics and tests. */
export function verifiedSnapshotsEnabled(): boolean {
  return snapshotReads;
}

function refuseRead(code: LogReadRefusalCode, message: string): LogReadRefusal {
  return { ok: false, code, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The head of a record list: the last record's `(seq, hash)`, or `null`. */
export function headOf(records: EventRecord[]): LogHead | null {
  const last = records[records.length - 1];
  return last === undefined ? null : { seq: last.seq, hash: last.hash };
}

// ---------------------------------------------------------------------------
// The verified-read cache
//
// The soundness argument lives in the module header. The code below is the
// mechanical part: what is remembered, what discards it, and what a surviving
// entry is allowed to save.
// ---------------------------------------------------------------------------

const NEWLINE = 0x0a;

// ---------------------------------------------------------------------------
// The incremental prefix proof (APRV-217)
//
// `docs/proposals/incremental-prefix-proof.md` is the design; the part that
// binds here is what the two modes claim.
//
// Under `full` (the default, and what every reader gets unless an operator's
// policy says otherwise) nothing below changes: every cached read re-hashes the
// whole proved prefix and compares the digest, which is the APRV-43 proof
// written out in the module header.
//
// Under `incremental` a repeat read carries the UN-FINALISED SHA-256 state at
// `byteLength` from the last full pass, feeds it the appended bytes, and keeps
// the copy. The cheap guards (schema key, not shrunk, same-size-implies-same-
// mtime, head line byte-identical at its offset) run exactly as they do today
// and can still only reject. What the read no longer re-proves on EVERY pass is
// that the bytes strictly inside the prefix, other than the head line, are
// unchanged; that is re-proved on a cadence (`everyReads` / `afterMs`), on the
// first read of a log in a process, after this process's own `appendEvent`, and
// on any guard failure, which is a cold walk and stronger still.
//
// The verdicts are the same verdicts. The incremental path walks the appended
// tail with `verifyText` from the cached head exactly as the full path does, so
// `clean` / `torn-tail` / `corrupt` come out of the same walk with the same
// codes and the same messages, and a guard failure falls back to a whole-file
// read and a walk from genesis.
// ---------------------------------------------------------------------------

/** Which prefix proof a read runs. `full` is today's, byte for byte. */
export type ReadProofMode = "full" | "incremental";

/** Reads between full re-proofs under `incremental` (SPEC-signed default). */
export const DEFAULT_FULL_REPROOF_EVERY = 50;

/** Milliseconds between full re-proofs under `incremental`. */
export const DEFAULT_FULL_REPROOF_AFTER_MS = 60_000;

/** The proof a read runs, with the cadence that bounds `incremental`. */
export interface ReadProof {
  mode: ReadProofMode;
  /** A full re-proof runs at least this often, counted in reads. */
  everyReads: number;
  /** …and at least this often in wall-clock milliseconds. */
  afterMs: number;
}

/**
 * What a reader gets when it asks for nothing: today's proof on every read.
 *
 * The default is `full` because it is the behaviour this repository has today
 * and the one an operator has attested to. `incremental` is reached only by a
 * caller that was handed a policy (or a flag) saying so.
 */
export const FULL_READ_PROOF: ReadProof = Object.freeze({
  mode: "full",
  everyReads: DEFAULT_FULL_REPROOF_EVERY,
  afterMs: DEFAULT_FULL_REPROOF_AFTER_MS,
});

/**
 * Bytes fed to SHA-256 by this module since the last reset.
 *
 * The one seam the APRV-217 tests need: "the incremental path hashes only the
 * appended bytes" is a claim about work, and work is invisible in a result by
 * design. A wall-clock assertion would measure the machine instead of the code,
 * so the tests count bytes here. Nothing in the runtime reads it.
 */
let hashedBytes = 0;

/** Bytes hashed by the verified-read cache so far. Diagnostics and tests. */
export function hashedByteCount(): number {
  return hashedBytes;
}

/** Reset {@link hashedByteCount}. Tests only. */
export function resetHashedByteCount(): void {
  hashedBytes = 0;
}

/**
 * How many distinct logs one process remembers. A process reads one log; a test
 * process reads many, and an unbounded map would hold every record of every
 * scratch log for the life of the run. Eviction is by insertion order and costs
 * only a cold read.
 */
const MAX_CACHED_LOGS = 8;

/**
 * What one read may do with the published snapshot beside the log (APRV-188).
 *
 * Both halves default to off. `consume` is set from the process-wide switch
 * `useVerifiedSnapshots` (the hook turns it on); `publish` is set per call by
 * the daemon.
 */
export interface SnapshotUse {
  consume?: boolean;
  publish?: boolean;
}

/**
 * One remembered log. Populated only from a `clean` verdict, so the remembered
 * prefix is the whole file as it stood: `byteLength` is both the prefix length
 * and the file size at that moment, and the file ended with a newline.
 */
interface CacheEntry {
  /** Resolved schema directory the records were verified against ("" = default). */
  schemaKey: string;
  /** Length of the verified prefix in bytes; ends immediately after a newline. */
  byteLength: number;
  /** Complete lines in the prefix, so resumed line numbers stay file-absolute. */
  lines: number;
  /** SHA-256 (hex) of the prefix bytes. The proof; everything else is a hint. */
  prefixHash: string;
  /** Byte offset of the head record's line. */
  headLineStart: number;
  /** The head record's line, newline excluded. A fast rejection, not the proof. */
  headLine: Buffer;
  /** Chain head a resumed walk links onto. */
  head: LogHead;
  /** The verified records, deep-frozen, in log order. */
  records: readonly EventRecord[];
  /** Staleness hint only: it may discard an entry, never validate one. */
  mtimeMs: number;
  /**
   * The un-finalised SHA-256 state at `byteLength` (APRV-217), or `null` when
   * this entry was remembered under `full` and carries none. `null` reads as
   * "a full re-proof is due": an incremental read has nothing to anchor to.
   */
  hashState: Hash | null;
  /** Epoch ms of the last pass that hashed the whole prefix. */
  lastFullReproofAt: number;
  /** Reads served incrementally since that pass. */
  readsSinceFullReproof: number;
  /**
   * Set by {@link VerifiedReadCache.requireFullReproof} after this process
   * appended to the log. Belt and braces: an append moves the head line, so the
   * incremental path would re-prove only the tail anyway, and the writer is the
   * party whose bytes matter most.
   */
  forceFullReproof: boolean;
}

function sha256(bytes: Uint8Array): string {
  hashedBytes += bytes.length;
  return createHash("sha256").update(bytes).digest("hex");
}

/** A SHA-256 state over `bytes`, counted for {@link hashedByteCount}. */
function hashState(bytes: Uint8Array): Hash {
  hashedBytes += bytes.length;
  return createHash("sha256").update(bytes);
}

/** Feed `bytes` to `state`, counted. Mutates and returns the state given. */
function feedHash(state: Hash, bytes: Uint8Array): Hash {
  hashedBytes += bytes.length;
  state.update(bytes);
  return state;
}

/**
 * Is a full re-proof owed for `entry`?
 *
 * Every answer here is "prove more", never "prove less": the `true` branches
 * send the read down the whole-file path, which is today's behaviour exactly.
 */
function fullReproofDue(entry: CacheEntry, proof: ReadProof, now: number): boolean {
  if (entry.forceFullReproof) return true;
  if (entry.hashState === null) return true;
  // `everyReads` counts the reads a single full pass may cover, the anchoring
  // read included: at 1 every read re-proves in full, at 50 one pass anchors
  // itself and the 49 reads that follow it.
  if (entry.readsSinceFullReproof + 1 >= proof.everyReads) return true;
  return now - entry.lastFullReproofAt >= proof.afterMs;
}

/**
 * Read exactly `into.length` bytes at `position`. Returns false for a short
 * read, which is a file that changed under us and therefore a guard failure.
 */
function readExactly(fd: number, into: Buffer, position: number): boolean {
  let done = 0;
  while (done < into.length) {
    let got: number;
    try {
      got = readSync(fd, into, done, into.length - done, position + done);
    } catch {
      return false;
    }
    if (got <= 0) return false;
    done += got;
  }
  return true;
}

/**
 * Freeze a record and everything reachable from it.
 *
 * Cached records are handed to every subsequent reader. A caller that mutated
 * one would be rewriting another reader's evidence in place, which is the one
 * way a memory cache could forge a record that no log ever contained. Freezing
 * turns that from a convention into a `TypeError`.
 */
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
}

/**
 * Process-lifetime, memory-only store of last-verified log state.
 *
 * Nothing here is written to disk and nothing is shared between processes. An
 * instance is safe to construct per caller (the daemon may want its own); the
 * default is {@link processReadCache}, which is why a repeat reader gets the
 * acceleration without asking for it and a one-shot CLI process cannot notice
 * it exists.
 */
export class VerifiedReadCache {
  readonly #entries = new Map<string, CacheEntry>();
  #hits = 0;
  #misses = 0;
  /**
   * Misses that were served from a published snapshot instead of a cold walk
   * (APRV-188). Counted alongside the miss it followed rather than instead of
   * it: the process cache genuinely had nothing, and the walk was skipped only
   * because another process's verification was re-proved over these bytes.
   */
  #resumed = 0;
  /**
   * Reads that hashed the whole prefix — a full digest compare, or a cold walk
   * (APRV-217). Equal to `hits + misses` under `full`, which is the point: it
   * is how a tick line says which path its reads took.
   */
  #fullReproofs = 0;

  /** Forget everything. Tests use this to force a genuinely cold read. */
  clear(): void {
    this.#entries.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#resumed = 0;
    this.#fullReproofs = 0;
  }

  /** How many logs are remembered. Diagnostics and tests only. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Reads that reused a proved prefix, and reads that verified from genesis.
   *
   * Diagnostics, and the one way a test can tell the two paths apart: reusing a
   * prefix is *designed* to be invisible in the result, so a test that wants to
   * assert "this tamper discarded the cache" has nothing else to look at.
   */
  get stats(): { hits: number; misses: number; resumed: number; fullReproofs: number } {
    return {
      hits: this.#hits,
      misses: this.#misses,
      resumed: this.#resumed,
      fullReproofs: this.#fullReproofs,
    };
  }

  /**
   * Require a full re-proof of `logPath` on this cache's next read (APRV-217).
   *
   * Called by `core/log.ts` after a successful append, through the listener it
   * registers below. Can only add work: the next read hashes the whole prefix
   * exactly as a `full` read does.
   */
  requireFullReproof(logPath: string): void {
    const entry = this.#entries.get(resolve(logPath));
    if (entry !== undefined) entry.forceFullReproof = true;
  }

  /**
   * Verify `logPath`, reusing a proved-identical prefix when there is one.
   *
   * The whole file is read once, and every decision is made from that single
   * snapshot: nothing is re-`stat`ed and re-read behind its own conclusion.
   */
  read(
    logPath: string,
    options: VerifyOptions,
    snapshot: SnapshotUse = {},
    proof: ReadProof = FULL_READ_PROOF,
  ): VerifiedLog {
    const key = resolve(logPath);
    const entry = this.#entries.get(key);

    // The incremental path (APRV-217), taken only when every precondition holds
    // and the cadence has not come due. It reads the head line and the appended
    // bytes and nothing else; on ANY guard failure it returns `null` and this
    // read falls back to the whole-file path below, which is a cold walk.
    if (
      proof.mode === "incremental" &&
      entry !== undefined &&
      entry.schemaKey === (options.schemaDir === undefined ? "" : resolve(options.schemaDir)) &&
      !fullReproofDue(entry, proof, Date.now())
    ) {
      const incremental = this.#readTail(logPath, key, entry, options, snapshot);
      if (incremental !== null) return incremental;
    }

    return this.#readWhole(logPath, key, options, snapshot, proof.mode);
  }

  /**
   * Today's read, unchanged: the whole file, the whole prefix hash, the walk.
   *
   * Every `full` read lands here, and so does every `incremental` read whose
   * cadence came due or whose guards rejected. The only APRV-217 addition is
   * the hash state handed to {@link VerifiedReadCache.#remember}, which is
   * built from the same single pass over the bytes rather than a second one.
   */
  #readWhole(
    logPath: string,
    key: string,
    options: VerifyOptions,
    snapshot: SnapshotUse,
    mode: ReadProofMode,
  ): VerifiedLog {
    this.#fullReproofs += 1;

    let raw: Buffer;
    try {
      raw = readFileSync(logPath);
    } catch {
      // An absent or unreadable log is not this module's vocabulary: hand it to
      // the cold path, which owns the ENOENT-is-an-empty-log rule and the exact
      // failure messages. A log we cannot read is also a log we must forget.
      this.#entries.delete(key);
      this.#misses += 1;
      return verifyWithRecords(logPath, options);
    }

    let mtimeMs = Number.NaN;
    try {
      mtimeMs = statSync(logPath).mtimeMs;
    } catch {
      // No mtime is simply no hint; an entry that wanted one is discarded below.
    }

    const schemaKey = options.schemaDir === undefined ? "" : resolve(options.schemaDir);
    const entry = this.#entries.get(key);
    const cached = entry === undefined ? null : reusablePrefix(entry, raw, schemaKey, mtimeMs);

    // A published snapshot is consulted only where this process has nothing:
    // the in-process proof always wins, because it is the stronger one (these
    // records were walked here). See `core/verified-snapshot.ts` for what the
    // weaker one costs and what it is allowed to skip.
    let prefix = cached;
    /** The digest of the endorsed prefix, already re-proved. */
    let provedDigest: string | null = null;
    if (cached === null) {
      this.#entries.delete(key);
      this.#misses += 1;
      if (snapshot.consume === true) {
        const admitted = snapshotPrefix(logPath, raw, options.schemaDir);
        if (admitted.ok) {
          prefix = admitted.prefix;
          this.#resumed += 1;
          // `admitSnapshot` hashed exactly these bytes a moment ago, so when the
          // file has not grown past the endorsed prefix the entry below may
          // carry that digest instead of hashing the same megabytes twice —
          // the APRV-206 argument, with the proof coming from the admission.
          if (raw.length === admitted.prefix.byteLength) provedDigest = admitted.digest;
        }
      }
    } else {
      this.#hits += 1;
    }

    const text = prefix === null ? raw.toString("utf8") : raw.toString("utf8", prefix.byteLength);
    const verified = verifyText(logPath, text, options, prefix);

    // APRV-206. When the file has not grown since the entry that was just
    // re-proved, the digest of these bytes is the digest that entry holds: the
    // prefix hash covered the whole file, and `reusablePrefix` has just shown
    // the file is those same bytes. Re-deriving it would hash the same megabytes
    // a second time in one read, which on a repeat reader (the listener between
    // taps) is the larger half of the read. Nothing is admitted on trust: this
    // is only reached when the hash comparison above passed.
    const known =
      entry !== undefined && cached !== null && raw.length === entry.byteLength
        ? entry.prefixHash
        : provedDigest;

    // The digest of these bytes, computed at most ONCE per read and shared by
    // everything that wants it (APRV-211). Only a clean read has anything to
    // remember or to publish, so a torn or corrupt log is never hashed here at
    // all, and `#remember` still owns the rule about which reads qualify.
    const result = verified.result;
    if (result.status === "clean" && result.head !== null) {
      // Under `full` this is today's line, unchanged. Under `incremental` the
      // entry must also carry the un-finalised state at these bytes, so the
      // digest is taken FROM that state: still one pass over the file, never
      // two, and the state is reused outright when the file has not grown.
      let carried: Hash | null;
      let digest: string;
      if (entry !== undefined && cached !== null && raw.length === entry.byteLength) {
        // The file has not grown since an entry whose bytes were just re-proved:
        // its digest stands, and so does the state it carries. A `full` read
        // carries that state forward untouched rather than dropping it, so a
        // reader that mixes modes (the daemon's tick reads and the queue
        // renderer's, in one process) does not thrash the anchor.
        digest = entry.prefixHash;
        carried =
          entry.hashState ?? (mode === "incremental" ? hashState(raw) : null);
      } else if (known !== null) {
        // A snapshot admission proved these bytes and hashed them elsewhere.
        // There is no state to carry without a second pass, so none is kept;
        // the next read anchors one.
        digest = known;
        carried = null;
      } else {
        // The one hash of these bytes this read pays, in both modes: `full`
        // spent exactly this before APRV-217, through `sha256(raw)`.
        carried = hashState(raw);
        digest = carried.copy().digest("hex");
      }
      this.#remember(key, raw, schemaKey, mtimeMs, verified, digest, carried);
      // The publisher is handed the digest rather than left to recompute it: it
      // endorses exactly the bytes this read proved, and a second hash of the
      // same megabytes was the larger half of a daemon tick.
      if (snapshot.publish === true) {
        publishVerifiedPrefix(
          logPath,
          raw.length,
          raw.length > 0 && raw[raw.length - 1] === NEWLINE,
          digest,
          result.records,
          result.head,
          options.schemaDir,
        );
      }
    } else {
      this.#remember(key, raw, schemaKey, mtimeMs, verified, known, null);
    }
    return verified;
  }

  /**
   * The incremental read (APRV-217): the head line and the appended bytes.
   *
   * Returns `null` for every guard failure, which sends the caller to the
   * whole-file path — a cold walk, the same fallback a mismatched prefix hash
   * has always taken. Nothing here can produce a verdict the cold walk would
   * not: the tail is handed to the same `verifyText`, chained onto the same
   * cached head, with the same schema options.
   */
  #readTail(
    logPath: string,
    key: string,
    entry: CacheEntry,
    options: VerifyOptions,
    snapshot: SnapshotUse,
  ): VerifiedLog | null {
    let fd: number;
    try {
      fd = openSync(logPath, "r");
    } catch {
      return null;
    }
    try {
      let size: number;
      let mtimeMs: number;
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) return null;
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch {
        return null;
      }

      // Guards 2 to 4 of the design's ladder, in the order `reusablePrefix`
      // runs them, over the same facts. Guard 1 (the schema key) was answered
      // by the caller; guard 5 (the full digest) is what the cadence decides,
      // and this path is reached only when it is not due.
      if (size < entry.byteLength) return null;
      if (size === entry.byteLength && mtimeMs !== entry.mtimeMs) return null;

      const headLineEnd = entry.headLineStart + entry.headLine.length;
      if (headLineEnd + 1 !== entry.byteLength) return null;
      const headBytes = Buffer.allocUnsafe(entry.headLine.length + 1);
      if (!readExactly(fd, headBytes, entry.headLineStart)) return null;
      if (headBytes[headBytes.length - 1] !== NEWLINE) return null;
      if (!headBytes.subarray(0, entry.headLine.length).equals(entry.headLine)) return null;

      const tail = Buffer.allocUnsafe(size - entry.byteLength);
      if (tail.length > 0 && !readExactly(fd, tail, entry.byteLength)) return null;

      // Step 6: the appended bytes go to a COPY of the state, and the copy
      // becomes the state of the entry this read leaves behind. The digest of
      // the whole file falls out of it, so the snapshot publisher and the entry
      // below are served without hashing a byte twice.
      const state = entry.hashState === null ? null : entry.hashState.copy();
      if (state === null) return null;
      if (tail.length > 0) feedHash(state, tail);
      const digest = state.copy().digest("hex");

      this.#hits += 1;
      const prefix: VerifiedPrefix = {
        byteLength: entry.byteLength,
        lines: entry.lines,
        head: entry.head,
        records: entry.records,
      };
      const verified = verifyText(logPath, tail.toString("utf8"), options, prefix);
      const result = verified.result;
      if (result.status !== "clean" || result.head === null) {
        // The same rule the whole-file path applies: nothing is resumed from a
        // read that found damage, and the entry that led here is dropped.
        this.#entries.delete(key);
        return verified;
      }

      // The head line of the file as it now stands. With no appended bytes it
      // is the one the entry already holds; otherwise it is the last line of
      // the tail, whose first byte follows the newline before it.
      let headLineStart = entry.headLineStart;
      let headLine = entry.headLine;
      if (tail.length > 0) {
        const relative = tail.lastIndexOf(NEWLINE, tail.length - 2) + 1;
        headLineStart = entry.byteLength + relative;
        headLine = Buffer.from(tail.subarray(relative, tail.length - 1));
      }

      const records = [...verified.records];
      for (const record of records) deepFreeze(record);
      this.#store(key, {
        schemaKey: entry.schemaKey,
        byteLength: size,
        lines: result.records,
        prefixHash: digest,
        headLineStart,
        headLine,
        head: result.head,
        records,
        mtimeMs,
        hashState: state,
        // The cadence carries forward: this read did not re-prove the prefix,
        // so it does not re-anchor the clock or the count.
        lastFullReproofAt: entry.lastFullReproofAt,
        readsSinceFullReproof: entry.readsSinceFullReproof + 1,
        forceFullReproof: false,
      });

      if (snapshot.publish === true) {
        publishVerifiedPrefix(
          logPath,
          size,
          true,
          digest,
          result.records,
          result.head,
          options.schemaDir,
        );
      }
      return verified;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Nothing actionable: the read is done and the descriptor is the OS's.
      }
    }
  }

  /**
   * Record a clean read. Only `clean` qualifies: a torn or corrupt log has no
   * prefix this module is willing to resume from, and any entry it had was
   * already dropped by the mismatch that exposed the damage.
   */
  #remember(
    key: string,
    raw: Buffer,
    schemaKey: string,
    mtimeMs: number,
    verified: VerifiedLog,
    /**
     * The digest of exactly these bytes, when the caller already re-proved them
     * against a stored one (APRV-206). `null` means "hash them".
     */
    knownDigest: string | null,
    /**
     * The un-finalised SHA-256 state at these bytes (APRV-217), or `null` under
     * `full`, where no state is kept and nothing is spent building one.
     */
    state: Hash | null,
  ): void {
    const result = verified.result;
    if (result.status !== "clean" || result.head === null) {
      this.#entries.delete(key);
      return;
    }

    // A clean, non-empty log ends with a newline, so the head line runs from
    // just after the previous newline to the last byte.
    const headLineStart = raw.lastIndexOf(NEWLINE, raw.length - 2) + 1;
    const records = [...verified.records];
    for (const record of records) deepFreeze(record);

    this.#store(key, {
      schemaKey,
      byteLength: raw.length,
      lines: result.records,
      prefixHash: knownDigest ?? sha256(raw),
      headLineStart,
      headLine: Buffer.from(raw.subarray(headLineStart, raw.length - 1)),
      head: result.head,
      records,
      mtimeMs,
      hashState: state,
      // This read hashed the whole prefix, so it IS the anchor: the cadence
      // starts again here, and any pending force is discharged.
      lastFullReproofAt: Date.now(),
      readsSinceFullReproof: 0,
      forceFullReproof: false,
    });
  }

  /** Put `entry` in, evicting by insertion order. The one writer of the map. */
  #store(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    if (this.#entries.size >= MAX_CACHED_LOGS) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, entry);
  }
}

/**
 * Decide whether `entry` may stand for the first `entry.byteLength` bytes of
 * `raw`, and return the resume point when it may.
 *
 * The checks run cheapest-first, but only the last one is load-bearing: the
 * prefix hash. Everything above it exists to reject an obviously changed file
 * without hashing it, and every check can only *reject*.
 */
function reusablePrefix(
  entry: CacheEntry,
  raw: Buffer,
  schemaKey: string,
  mtimeMs: number,
): VerifiedPrefix | null {
  // Records verified against one schema set are not evidence under another.
  if (entry.schemaKey !== schemaKey) return null;

  // The file shrank: it cannot contain the prefix, and a truncated log must be
  // re-read cold so the head reported is the file's, not the one remembered.
  if (raw.length < entry.byteLength) return null;

  // Same size, moved mtime: an in-place rewrite. The prefix hash would catch it
  // anyway; this rejects it a pass earlier. mtime never admits anything.
  if (raw.length === entry.byteLength && mtimeMs !== entry.mtimeMs) return null;

  // The head line, byte for byte, where it was recorded — and still terminated,
  // and still the end of the prefix.
  const headLineEnd = entry.headLineStart + entry.headLine.length;
  if (headLineEnd + 1 !== entry.byteLength) return null;
  if (raw[headLineEnd] !== NEWLINE) return null;
  if (!raw.subarray(entry.headLineStart, headLineEnd).equals(entry.headLine)) return null;

  // The proof: these are the bytes this process verified in full.
  if (sha256(raw.subarray(0, entry.byteLength)) !== entry.prefixHash) return null;

  return {
    byteLength: entry.byteLength,
    lines: entry.lines,
    head: entry.head,
    records: entry.records,
  };
}

/**
 * The cache {@link readVerifiedRecords} uses when a caller names none.
 *
 * Shared per process, which is what makes a watch loop fast without any wiring:
 * the daemon calls `readVerifiedRecords` exactly as every other consumer does.
 */
export const processReadCache = new VerifiedReadCache();

/**
 * Tell the process cache when this process appends (APRV-217).
 *
 * Registered here rather than called from `core/log.ts` because the dependency
 * runs this way: `core/state.ts` already knows about the log, and a value
 * import in the other direction would close a cycle through `core/verify.ts`.
 * The listener can only ADD work — the named log's next read hashes its whole
 * prefix — so a process that never loads this module simply reads as it always
 * did.
 */
onLogAppended((logPath) => {
  processReadCache.requireFullReproof(logPath);
});

/**
 * Read the log and refuse unless the whole chain verifies.
 *
 * An absent log is an empty log (nothing has happened yet), exactly as
 * `appendEvent` and `approval log verify` treat it.
 *
 * The file is opened once as a readability probe *before* verification so that
 * "I could not open this file" stays an I/O fact (`log-unreadable`) and never
 * arrives dressed as corruption — the same split the CLI's exit table draws, and
 * the one thing `verify()` alone cannot express, since from inside the chain
 * walker an unreadable log is indistinguishable from a broken one.
 *
 * Torn-tail behavior is unchanged from the pre-APRV-20 reader: the tear is
 * reported as `log-torn-tail` and nothing is repaired, because truncating a torn
 * line is a human decision.
 *
 * Reads go through the verified-read cache by default (see the module header):
 * a prefix re-proved byte-identical is not re-walked, the appended suffix is
 * verified in full, and any mismatch falls back to genesis. The result is the
 * result of a cold read on the same bytes, always. `cache: null` opts out.
 */
export function readVerifiedRecords(
  logPath: string,
  options: ReadVerifiedOptions = {},
): ReadRecordsResult {
  try {
    closeSync(openSync(logPath, "r"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, records: [], head: null };
    }
    return refuseRead(
      "log-unreadable",
      `log ${logPath} could not be read: ${errorMessage(cause)}`,
    );
  }

  const { cache: requested, publishSnapshot: publish, readProof, ...verifyOptions } = options;
  const cache = requested === undefined ? processReadCache : requested;
  // `cache: null` is the explicit cold read an audit asks for, and it stays
  // cold: a caller that opted out of this process's own proved prefix has not
  // opted into another process's.
  const verified =
    cache === null
      ? verifyWithRecords(logPath, verifyOptions)
      : cache.read(
          logPath,
          verifyOptions,
          {
            consume: snapshotReads,
            ...(publish === undefined ? {} : { publish }),
          },
          readProof ?? processReadProof ?? FULL_READ_PROOF,
        );

  switch (verified.result.status) {
    case "clean":
      return { ok: true, records: verified.records, head: verified.result.head };
    case "torn-tail":
      return refuseRead(
        "log-torn-tail",
        `log ${logPath} ends without a newline: the final record is truncated, the signature of a crashed write. Nothing is repaired here; run \`approval log verify\`.`,
      );
    case "corrupt":
      return refuseRead(
        "log-corrupt",
        `log ${logPath} does not verify (${verified.result.reason}${
          verified.result.firstBadSeq === null ? "" : ` at seq ${verified.result.firstBadSeq}`
        }): ${verified.result.message}. Nothing may be authorized from a log that does not verify; run \`approval log verify\`.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Approval state derivation
// ---------------------------------------------------------------------------

/**
 * One action's approval state, derived from the log.
 *
 * These are the gate's names for the approval lifecycle of SPEC.md §6.3. The
 * envelope's `state:` enum is the projection of the same thing over a whole
 * task (`proposed`/`awaiting`/`approved`/…); the mapping is one-to-one for the
 * action-scoped states and is applied by the projection layer, not here.
 */
export type RequestState =
  /** No `approval.requested` for this key. */
  | "none"
  /** Requested and undecided — the envelope's `awaiting`. */
  | "requested"
  /** A human granted it — the envelope's `approved`. */
  | "granted"
  | "rejected"
  | "revoked"
  /** TTL lapsed, by event or by arithmetic. */
  | "expired"
  /**
   * The requester took the question back while it was still pending (APRV-106,
   * amended SPEC.md §6.3).
   *
   * Terminal, and terminal in the same sense `rejected` is: the gate refuses a
   * grant, a rejection, a revocation or a second withdrawal afterwards. It is
   * NOT a decision — nobody answered — which is why the projection layer reads
   * it as "back to proposed" rather than as a refusal, and why no authorization
   * is implied in either direction.
   */
  | "withdrawn";

/** The three terminal decisions a human can record, plus runtime expiry. */
export type Decision = "grant" | "reject" | "revoke";

/**
 * Why a requester retracted a pending request (amended SPEC.md §6.3, APRV-106).
 *
 * Closed, and mirrored by `event.schema.json`: a withdrawal that does not say
 * why is a fact audit cannot use. `timeout` is the one the hook writes — the
 * requester stopped waiting, so a decision on this request can no longer be
 * consumed by anyone.
 */
export const WITHDRAW_REASONS = ["timeout", "cancelled", "superseded"] as const;

export type WithdrawReason = (typeof WITHDRAW_REASONS)[number];

/** Is `value` one of the closed withdrawal reasons? */
export function isWithdrawReason(value: unknown): value is WithdrawReason {
  return typeof value === "string" && (WITHDRAW_REASONS as readonly string[]).includes(value);
}

/**
 * What the request declared, copied out of the `approval.requested` payload.
 *
 * ## The scrutiny ratchet (amended SPEC.md §11), stated where it binds
 *
 * `summary` and `est_cost_usd` are **claimed** fields: the party under
 * oversight authored them. So is `route.confidence`, which this derivation
 * deliberately does not carry at all — nothing in the resolution, sampling, or
 * refusal paths reads it, and `tests/ratchet.test.ts` scans the source to keep
 * it that way. Claimed fields MAY raise scrutiny, inform display, or feed
 * retrospective analysis; they MUST NOT reduce sampling probability, downgrade
 * a resolved autonomy level, or shortcut any refusal path. `est_cost_usd: 0`
 * therefore still consumes one action of every action-count budget, and a
 * confident summary buys nothing. Scrutiny only ratchets upward on self-report.
 *
 * `class` and `payload_hash` sit on the other side of that line: `class` is
 * matched against policy the human attested, and `payload_hash` is *checked*
 * against the bytes an executor presents (`core/payload.ts`), so a false one
 * refuses rather than relaxes.
 */
export interface DeclaredAction {
  class: string | null;
  /**
   * The declared cost as a canonical decimal USD string (APRV-121), or `null`
   * when the request declared none. A record written before that change carries
   * a JSON number and is normalized to the same string here, so every reader
   * downstream sees one representation regardless of when its record was
   * written.
   */
  est_cost_usd: string | null;
  reversible: boolean | null;
  summary: string | null;
  /**
   * The content binding of amended SPEC.md §6.2, copied from the registered
   * declaration onto `approval.requested` so the grant can copy it in turn.
   * `null` for a request that declared none — which the gate admits only off
   * the manual path.
   */
  payload_hash: string | null;
  /**
   * `"harness"` when the requester declared that it will never run this action
   * through `approval run` (APRV-106, the Claude Code hook): the harness
   * executes the command itself and the gate's answer is a permission decision,
   * not a key. A grant on such a request mints no execution token.
   *
   * On the ratchet's safe side (SPEC.md §11.1), and deliberately so. It is a
   * self-reported field, and every effect it has REMOVES capability from the
   * party that reported it: no token is minted, so `approval run` and
   * `approval consume` refuse the key outright. There is no reading of a false
   * `harness` claim that authorizes anything the truthful claim would not.
   */
  execution: "harness" | null;
  /**
   * The deadline the requester says it will wait until, ISO-8601, or `null`.
   *
   * Display only, and claimed: channels render it so an approver can see that
   * an answer after this instant reaches nobody (APRV-106). Nothing in the
   * gate, the token module, the budgets or the TTL reads it — the TTL is the
   * policy's and is the only deadline that governs anything — so a requester
   * that lies about it can only make its own request look MORE urgent than it
   * is, never less.
   */
  wait_until: string | null;
  /**
   * The SHA-256 of the attested policy in force when the runtime evaluated the
   * request (APRV-118, amended SPEC.md §5.2), or `null` for a record written
   * before the field existed.
   *
   * Computed, never claimed: the requester has no parameter that reaches it, and
   * the gate assigns it at the write boundary from its own read of the attested
   * file, exactly as it assigns `ts`. The grant path compares it against the hash
   * in force at decision time and refuses `policy-drift` on a difference, so a
   * value that disagrees with the runtime's can only refuse a grant, never
   * produce one.
   */
  policy_sha256: string | null;
}

/** Execution facts for the action key: the seq of each event, or `null`. */
export interface ExecutionFacts {
  started: number | null;
  completed: number | null;
  failed: number | null;
}

/** The full derivation, so a caller never re-walks the log to explain itself. */
export interface RequestDerivation {
  actionKey: string;
  state: RequestState;
  task: string | null;
  requestSeq: number | null;
  requestTs: string | null;
  /**
   * The actor of the `approval.requested` record that opened the current cycle
   * (APRV-106). The gate compares a withdrawal's actor against it: only the
   * party that asked may take the question back.
   */
  requestActor: string | null;
  decision: "granted" | "rejected" | "revoked" | "expired" | "withdrawn" | null;
  decisionSeq: number | null;
  decisionTs: string | null;
  /** An `approval.expired` record exists for the current request. */
  expiredByEvent: boolean;
  /** The TTL lapsed by arithmetic, with no `approval.expired` record. */
  expiredLazily: boolean;
  declared: DeclaredAction;
  execution: ExecutionFacts;
}

/** A record's payload as a map, or `{}` when it has none. */
export function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

function declaredFrom(record: EventRecord): DeclaredAction {
  const payload = payloadOf(record);
  const cls = payload["class"];
  const cost = payload["est_cost_usd"];
  const reversible = payload["reversible"];
  const summary = payload["summary"];
  const hash = payload["payload_hash"];
  const execution = payload["execution"];
  const waitUntil = payload["wait_until"];
  const policySha256 = payload[POLICY_HASH_FIELD];
  return {
    class: typeof cls === "string" ? cls : null,
    est_cost_usd: normalizeUsd(cost),
    reversible: typeof reversible === "boolean" ? reversible : null,
    summary: typeof summary === "string" ? summary : null,
    payload_hash: isPayloadHash(hash) ? hash : null,
    // Recognized values only. An unrecognized `execution` reads as `null`,
    // which is the ordinary token-minting path: a claim the runtime does not
    // understand must not change what the runtime does.
    execution: execution === "harness" ? "harness" : null,
    wait_until:
      typeof waitUntil === "string" && !Number.isNaN(Date.parse(waitUntil)) ? waitUntil : null,
    // A malformed hash reads as `null`, which is the pre-APRV-118 shape: the
    // grant path then has nothing to compare and proceeds under the current
    // policy. Treating an unreadable value as a mismatch would let a corrupt
    // byte void a pending request, and treating it as a match would let a
    // crafted one claim agreement it cannot prove.
    policy_sha256: isPolicySha256(policySha256) ? policySha256 : null,
  };
}

/**
 * Derive `actionKey`'s approval state from `records`.
 *
 * Pure: no I/O, no clock. `ts` is the moment the question is being asked and is
 * **required** — lazy expiry is arithmetic on it, and a state function that read
 * the clock could not be replayed.
 *
 * Sequencing rules, all of them deliberate:
 *
 * - An `approval.requested` **resets** the derivation. A key that was rejected
 *   or expired may be requested again; the new request starts a fresh cycle and
 *   the old decision no longer governs. (An action that has *executed* is a
 *   different matter — `core/gate.ts`'s `request` refuses that on idempotency
 *   grounds.)
 * - The **first** decision after a request wins. The gate refuses to append a
 *   second one, so a log carrying two is a log written by something else; the
 *   fail-closed reading is that the earliest human decision stands rather than
 *   that a later append can overwrite it.
 * - Execution facts accumulate across the whole log for the key, independent of
 *   the request cycle: an action that has executed has executed, and no
 *   subsequent request un-executes it.
 * - Withdrawal (APRV-106): an `approval.withdrawn` settles the request like any
 *   other terminal event, and is the only one of them that records no decision.
 *   It participates in the "first settlement wins" rule above, so a withdrawal
 *   appended after a human's answer does not erase the answer; the gate refuses
 *   to append one at all in that case.
 * - Expiry: an `approval.expired` record sets `expiredByEvent`. With no such
 *   record, `ttlMs !== null` and `ts > requestTs + ttlMs` sets `expiredLazily`.
 *   Both yield `state: "expired"`. An unparseable `requestTs` or `ts` also
 *   yields `expired`: liveness that cannot be demonstrated is not assumed. (The
 *   event schema's `date-time` format makes that unreachable through the real
 *   append path; it is a backstop, not a live branch.)
 */
export function requestState(
  records: EventRecord[],
  actionKey: string,
  ts: string,
  ttlMs: number | null,
): RequestDerivation {
  let task: string | null = null;
  let requestSeq: number | null = null;
  let requestTs: string | null = null;
  let requestActor: string | null = null;
  let decision: RequestDerivation["decision"] = null;
  let decisionSeq: number | null = null;
  let decisionTs: string | null = null;
  let expiredByEvent = false;
  let declared: DeclaredAction = {
    class: null,
    est_cost_usd: null,
    reversible: null,
    summary: null,
    payload_hash: null,
    execution: null,
    wait_until: null,
    policy_sha256: null,
  };
  const execution: ExecutionFacts = { started: null, completed: null, failed: null };

  const settle = (
    record: EventRecord,
    value: NonNullable<RequestDerivation["decision"]>,
  ): void => {
    if (requestSeq === null) return;
    // Revocation is the one decision that legitimately follows another: a
    // human withdraws a grant they already made, so `approval.revoked`
    // supersedes. Every other decision settles only an undecided request —
    // the gate refuses to append a second one, and a log carrying two was
    // written by something else, where the fail-closed reading is that the
    // earliest human answer stands rather than that a later append overwrites it.
    if (decision !== null && value !== "revoked") return;
    decision = value;
    decisionSeq = record.seq;
    decisionTs = record.ts;
    if (value === "expired") expiredByEvent = true;
  };

  for (const record of records) {
    if (record.action_key !== actionKey) continue;
    switch (record.event) {
      case "approval.requested":
        task = record.task ?? task;
        requestSeq = record.seq;
        requestTs = record.ts;
        requestActor = record.actor;
        decision = null;
        decisionSeq = null;
        decisionTs = null;
        expiredByEvent = false;
        declared = declaredFrom(record);
        break;
      case "approval.granted":
        settle(record, "granted");
        break;
      case "approval.rejected":
        settle(record, "rejected");
        break;
      case "approval.revoked":
        settle(record, "revoked");
        break;
      case "approval.expired":
        settle(record, "expired");
        break;
      case "approval.withdrawn":
        settle(record, "withdrawn");
        break;
      case "execution.started":
        execution.started = record.seq;
        task = record.task ?? task;
        break;
      case "execution.completed":
        execution.completed = record.seq;
        break;
      case "execution.failed":
        execution.failed = record.seq;
        break;
      default:
        break;
    }
  }

  let state: RequestState;
  let expiredLazily = false;
  if (requestSeq === null) {
    state = "none";
  } else if (decision !== null) {
    state = decision;
  } else if (ttlMs === null) {
    // No `defaults.approval_ttl` means the policy declares no lapse. A request
    // stays live until a human decides it; inventing a default TTL here would
    // silently reject approvals a policy author never asked to expire.
    state = "requested";
  } else {
    const requestedAt = Date.parse(requestTs ?? "");
    const now = Date.parse(ts);
    if (Number.isNaN(requestedAt) || Number.isNaN(now)) {
      state = "expired";
      expiredLazily = true;
    } else if (now > requestedAt + ttlMs) {
      state = "expired";
      expiredLazily = true;
    } else {
      state = "requested";
    }
  }

  return {
    actionKey,
    state,
    task,
    requestSeq,
    requestTs,
    requestActor,
    decision,
    decisionSeq,
    decisionTs,
    expiredByEvent,
    expiredLazily,
    declared,
    execution,
  };
}
