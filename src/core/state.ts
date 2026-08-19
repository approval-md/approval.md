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

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { EventRecord, LogHead } from "./log.js";
import { isPayloadHash } from "./payload.js";
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

/**
 * How many distinct logs one process remembers. A process reads one log; a test
 * process reads many, and an unbounded map would hold every record of every
 * scratch log for the life of the run. Eviction is by insertion order and costs
 * only a cold read.
 */
const MAX_CACHED_LOGS = 8;

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
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

  /** Forget everything. Tests use this to force a genuinely cold read. */
  clear(): void {
    this.#entries.clear();
    this.#hits = 0;
    this.#misses = 0;
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
  get stats(): { hits: number; misses: number } {
    return { hits: this.#hits, misses: this.#misses };
  }

  /**
   * Verify `logPath`, reusing a proved-identical prefix when there is one.
   *
   * The whole file is read once, and every decision is made from that single
   * snapshot: nothing is re-`stat`ed and re-read behind its own conclusion.
   */
  read(logPath: string, options: VerifyOptions): VerifiedLog {
    const key = resolve(logPath);

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
    const prefix =
      entry === undefined ? null : reusablePrefix(entry, raw, schemaKey, mtimeMs);
    if (prefix === null) {
      this.#entries.delete(key);
      this.#misses += 1;
    } else {
      this.#hits += 1;
    }

    const text = prefix === null ? raw.toString("utf8") : raw.toString("utf8", prefix.byteLength);
    const verified = verifyText(logPath, text, options, prefix);

    this.#remember(key, raw, schemaKey, mtimeMs, verified);
    return verified;
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

    this.#entries.delete(key);
    if (this.#entries.size >= MAX_CACHED_LOGS) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, {
      schemaKey,
      byteLength: raw.length,
      lines: result.records,
      prefixHash: sha256(raw),
      headLineStart,
      headLine: Buffer.from(raw.subarray(headLineStart, raw.length - 1)),
      head: result.head,
      records,
      mtimeMs,
    });
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

  const { cache: requested, ...verifyOptions } = options;
  const cache = requested === undefined ? processReadCache : requested;
  const verified =
    cache === null ? verifyWithRecords(logPath, verifyOptions) : cache.read(logPath, verifyOptions);

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
  est_cost_usd: number | null;
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
  return {
    class: typeof cls === "string" ? cls : null,
    est_cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    reversible: typeof reversible === "boolean" ? reversible : null,
    summary: typeof summary === "string" ? summary : null,
    payload_hash: isPayloadHash(hash) ? hash : null,
    // Recognized values only. An unrecognized `execution` reads as `null`,
    // which is the ordinary token-minting path: a claim the runtime does not
    // understand must not change what the runtime does.
    execution: execution === "harness" ? "harness" : null,
    wait_until:
      typeof waitUntil === "string" && !Number.isNaN(Date.parse(waitUntil)) ? waitUntil : null,
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
