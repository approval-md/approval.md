/**
 * Hash-chain verification for `.approval/log/events.jsonl` (SPEC.md §8:
 * "`approval log verify` MUST detect any mutation or truncation").
 *
 * This module is the read side of the append-only log. It re-derives every
 * record's digest from its canonical serialization and walks the `prev` chain
 * and the `seq` succession end to end, reporting the *first* place the log
 * stops being self-consistent.
 *
 * **Read-only, by definition.** Verification opens the log for reading and
 * nothing else: it never truncates, never rewrites, never repairs, and never
 * creates a lockfile. A torn tail is *reported*, never auto-truncated — a log
 * that heals itself is a log that can be made to forget. Repair is a human
 * decision, made explicitly: a later CLI task may offer it behind an explicit
 * flag, but the core provides detection only.
 *
 * **What verification detects.** Any mutation of a record without a full
 * recompute of every descendant; truncation of the tail (with an external
 * anchor); deletion, insertion, reorder, or splice anywhere in the chain;
 * `alg` tampering; a malformed or schema-invalid line; a duplicated or skipped
 * `seq`; a non-genesis first record; and — given an anchor — a fully
 * recomputed forged suffix.
 *
 * **The detection boundary — state it plainly.** A hash chain is
 * tamper-*evident*, not tamper-*proof*. A forger who rewrites record N and then
 * recomputes every descendant (new hash, fixed `prev`) produces a file that is
 * internally self-consistent in every respect, and `verify(logPath)` on that
 * file alone CANNOT distinguish it from an honest log. The same is true of
 * dropping records off the tail: the surviving prefix is a valid chain. Closing
 * that gap requires something the forger does not control:
 *
 * - an externally anchored head — pass {@link VerifyOptions.expectedHead} with
 *   a `(seq, hash)` pair recorded elsewhere (a channel message, another host, a
 *   human's notes); a mismatch is reported as `head-mismatch`;
 * - a retained copy of the log held outside the writer's reach;
 * - the optional per-event git commits of SPEC.md §8, where the daemon commits
 *   each record under its own identity, giving signed, distributed evidence.
 *
 * Three questions that keep arriving separately have one answer (APRV-141, F7):
 * the digest covers each record's CANONICAL CONTENT, its RFC 8785
 * serialization, and never the bytes of the line it was read from, so a
 * re-serialization that changes only byte format verifies clean, a line
 * carrying a duplicate key is settled by the JSON parse that precedes
 * canonicalization rather than by the chain, and an unanchored tail truncation
 * leaves a valid prefix that nothing inside the file can contradict.
 *
 * **Anomalies, which are reported and never enforced (APRV-40).** SPEC.md §8
 * requires that "verification treats gate-type events with implausible skew
 * relative to their neighbors as a reportable anomaly, never silently accepted".
 * Every non-corrupt result therefore carries {@link VerifyResult.anomalies}, a
 * list that says nothing about integrity: a clean log with anomalies is clean,
 * exits 0, and authorizes exactly what it authorized before. The separation is
 * the point. Chain integrity is a proof, skew is a judgment, and folding a
 * judgment into a proof would turn `log verify` into a check people learn to
 * pass a flag to silence. See {@link chainAnomalies}.
 *
 * Determinism: the result is a pure function of (log bytes, schema files,
 * options). No clock, no network, no cross-call state — the anomaly pass reads
 * the records' own timestamps and never the current time.
 */

import { readFileSync } from "node:fs";

import { ALG, computeRecordHash, type EventRecord, type LogHead } from "./log.js";
import { loadPolicy, type LoadPolicyOptions } from "./policy-load.js";
import { validate, type ValidateOptions } from "./validate.js";

/**
 * A chain head: the last record's position and digest.
 *
 * Defined in `core/log.ts` (the writer needs it for its compare-and-append
 * precondition and cannot import this module) and re-exported here, where
 * readers expect to find it. One definition, one meaning.
 */
export type { LogHead };

// ---------------------------------------------------------------------------
// Anomalies (SPEC.md §8, timestamp rules) — reportable, never a verdict
// ---------------------------------------------------------------------------

/**
 * SPEC.md §8: "Events written through the gate (`approval.*`, `execution.*`,
 * `budget.*`, `audit.*`, `policy.updated`) have `ts` assigned by the runtime at
 * the write boundary."
 *
 * These are the types whose timestamps the runtime authored, so these are the
 * only types whose timestamps the runtime may be held to. Every other type is
 * writable directly by callers who legitimately supply their own `ts` (an
 * importer replaying a historical log is the obvious case), so comparing them
 * would manufacture anomalies out of correct behavior.
 */
function isGateTyped(event: string): boolean {
  return (
    event.startsWith("approval.") ||
    event.startsWith("execution.") ||
    event.startsWith("budget.") ||
    event.startsWith("audit.") ||
    event === "policy.updated"
  );
}

/**
 * The skew allowance, in milliseconds, before a backwards step between two
 * gate-typed records is reported.
 *
 * ### Why 2 seconds, and why any number at all
 *
 * Gate-typed timestamps are stamped by `core/clock.ts` at the write boundary. In
 * one process they come from one `Date.now()` and never go backwards. Across
 * processes and hosts — the daemon on one machine, a CLI verb on another, both
 * appending to a shared log — they come from separate wall clocks, and two
 * healthy NTP-disciplined clocks routinely disagree by tens of milliseconds and
 * occasionally by a few hundred during a step correction. A tolerance of zero
 * would therefore report ordinary distributed operation as an anomaly, which is
 * the fastest way to make an anomaly channel ignored.
 *
 * 2000 ms is chosen as roughly an order of magnitude above the disagreement a
 * synchronized fleet actually exhibits, and two to three orders of magnitude
 * below the skew that a *useful* lie requires. The thing this check exists to
 * catch is a timestamp placed to change a judgment: a `ts` inside a lapsed TTL
 * (minutes to hours), or one moved outside a rolling budget window (hours). No
 * attack is bought by 1.9 seconds, and no healthy fleet needs 2.1.
 *
 * It is the DEFAULT rather than the only value since APRV-58: an operator
 * running a single host may tighten it to 250 ms, one running across a WAN with
 * poor time discipline may loosen it to 5 s, and `audit.skew_tolerance` in the
 * policy is where they say so. A policy that declares nothing (or that fails to
 * load at all) leaves this number in force, so the reference runtime still has
 * exactly one value that every reader can see.
 *
 * Widening the tolerance permits nothing: the threshold is report-only in both
 * directions, so a loosened value hides evidence from a human and cannot make
 * any action allowed that was refused before.
 */
export const GATE_TS_SKEW_TOLERANCE_MS = 2_000;

/**
 * `audit.skew_tolerance` in milliseconds, or the default when it says nothing.
 *
 * Fails closed to the default exactly as `daemon/prune.ts`'s retention read
 * does: a policy that cannot be loaded configures nothing, and for THIS key the
 * safe fallback is the shipped number rather than zero — a zero allowance would
 * report every ordinary clock disagreement as an anomaly, and an anomaly channel
 * that cries wolf is one operators stop reading. An unparseable duration never
 * reaches here: the schema's duration pattern rejects it and `loadPolicy` fails
 * the whole policy, precisely as a bad `defaults.approval_ttl` does.
 */
export function skewToleranceMsOf(
  policy: { dir?: string; file?: string },
  schemaDir?: string,
): number {
  const where: LoadPolicyOptions =
    policy.file !== undefined ? { file: policy.file } : { dir: policy.dir ?? process.cwd() };
  if (schemaDir !== undefined) where.schemaDir = schemaDir;
  const load = loadPolicy(where);
  if (!load.ok) return GATE_TS_SKEW_TOLERANCE_MS;
  return load.durations.skewToleranceMs ?? GATE_TS_SKEW_TOLERANCE_MS;
}

/**
 * Machine-readable anomaly kinds. Closed union, additive-only, each pinned by a
 * test — the same contract every other frozen union in this codebase carries.
 */
export const CHAIN_ANOMALY_KINDS = [
  /**
   * A gate-typed record's `ts` is earlier than the previous gate-typed record's
   * `ts` by more than {@link GATE_TS_SKEW_TOLERANCE_MS}.
   *
   * One kind covers both directions SPEC.md §8 describes. "Earlier than its
   * predecessor" and "later than its successor" are the same disagreement seen
   * from the two ends of one adjacent pair, and reporting it twice would double
   * every entry without adding a fact.
   */
  "gate-ts-regression",
] as const;

export type ChainAnomalyKind = (typeof CHAIN_ANOMALY_KINDS)[number];

/** One reportable oddity in a log that verifies. Never a verdict. */
export interface ChainAnomaly {
  kind: ChainAnomalyKind;
  /** The record the anomaly is reported against. */
  seq: number;
  ts: string;
  event: string;
  /** The gate-typed record it was compared with. */
  previousSeq: number;
  previousTs: string;
  /** How far back the step is, in milliseconds. Always positive. */
  skewMs: number;
  message: string;
}

/**
 * Timestamp anomalies among the gate-typed records of a verified chain.
 *
 * Pure: a function of the records alone, with no clock and no I/O. Comparison is
 * between each gate-typed record and the previous **gate-typed** record, not the
 * previous record of any kind, for the reason {@link isGateTyped} states.
 *
 * This changes no verdict. A log full of anomalies is still `clean` if its chain
 * verifies, still exits 0, and still authorizes exactly what it authorized
 * before. Skew is evidence for a human to weigh, and a verifier that refused on
 * it would be refusing on a heuristic — which is how a tamper-evidence tool
 * starts being run with a flag that turns it off.
 */
export function chainAnomalies(
  records: readonly EventRecord[],
  toleranceMs: number = GATE_TS_SKEW_TOLERANCE_MS,
): ChainAnomaly[] {
  const anomalies: ChainAnomaly[] = [];
  let previous: { seq: number; ts: string; millis: number } | null = null;

  for (const record of records) {
    if (!isGateTyped(record.event)) continue;
    const millis = Date.parse(record.ts);
    if (Number.isNaN(millis)) continue; // the schema's date-time format precedes this

    if (previous !== null) {
      const skewMs = previous.millis - millis;
      if (skewMs > toleranceMs) {
        anomalies.push({
          kind: "gate-ts-regression",
          seq: record.seq,
          ts: record.ts,
          event: record.event,
          previousSeq: previous.seq,
          previousTs: previous.ts,
          skewMs,
          message: `record ${record.seq} (${record.event}) is timestamped ${record.ts}, ${String(
            skewMs,
          )}ms BEFORE the previous gate-typed record ${previous.seq} at ${previous.ts}. Gate-typed timestamps are stamped by the runtime at the write boundary (SPEC.md §8), so a backwards step larger than ${String(
            toleranceMs,
          )}ms means either a clock that stepped backwards or a timestamp that was authored rather than stamped. The chain still verifies and nothing is refused: this is reported for a human to weigh, because TTL judgment and budget windows read ts.`,
        });
      }
    }
    previous = { seq: record.seq, ts: record.ts, millis };
  }
  return anomalies;
}

/** Machine-readable reason a log failed verification. Closed set. */
export type VerifyFailureReason =
  | "malformed-line"
  | "schema-invalid"
  | "bad-alg"
  | "hash-mismatch"
  | "prev-mismatch"
  | "seq-gap"
  | "seq-duplicate"
  | "not-genesis"
  | "head-mismatch";

/**
 * Outcome of a verification run. A discriminated union on `status`:
 *
 * - `clean` — every complete line verified; `head` is `null` for an empty or
 *   absent log.
 * - `torn-tail` — the file's final line is torn (it is not newline-terminated,
 *   i.e. a writer died mid-line) while every complete line before it verifies.
 *   This is the crashed-write signature and is deliberately distinct from
 *   corruption: it is an incomplete write, not evidence of tampering.
 * - `corrupt` — everything else, reported at the first offending record.
 */
export type VerifyResult =
  | { status: "clean"; records: number; head: LogHead | null; anomalies: ChainAnomaly[] }
  | {
      status: "torn-tail";
      records: number;
      intactThroughSeq: number;
      message: string;
      anomalies: ChainAnomaly[];
    }
  | {
      status: "corrupt";
      firstBadSeq: number | null;
      reason: VerifyFailureReason;
      message: string;
      anomalies: ChainAnomaly[];
    };

/** Options accepted by {@link verify}. */
export interface VerifyOptions extends ValidateOptions {
  /**
   * Externally anchored head. When supplied, a log that verifies internally is
   * additionally required to end at exactly this `(seq, hash)`. This is the
   * only defence against tail truncation and against a fully recomputed forged
   * suffix; see the detection boundary in the module header.
   */
  expectedHead?: LogHead;
  /**
   * Where the policy carrying `audit.skew_tolerance` lives (APRV-58), with
   * `loadPolicy`'s semantics. Supplied by a caller that has a policy to hand;
   * absent means {@link GATE_TS_SKEW_TOLERANCE_MS}.
   *
   * It reaches exactly one thing, the anomaly threshold, and anomalies change no
   * verdict. Verification's answer to "does this chain hold" is a function of
   * the log bytes and the schemas, and no policy — loadable, absent, hostile, or
   * edited — can move it.
   */
  policy?: { dir?: string; file?: string };
  /**
   * The tolerance, already resolved, in milliseconds. Overrides
   * {@link VerifyOptions.policy} when both are given, and exists so the pure
   * paths and the tests can state a threshold without a file on disk.
   */
  skewToleranceMs?: number;
}

/** The tolerance a verification run should apply, from its options alone. */
function toleranceOf(options: VerifyOptions): number {
  if (options.skewToleranceMs !== undefined) return options.skewToleranceMs;
  if (options.policy === undefined) return GATE_TS_SKEW_TOLERANCE_MS;
  return skewToleranceMsOf(options.policy, options.schemaDir);
}

function corrupt(
  reason: VerifyFailureReason,
  firstBadSeq: number | null,
  message: string,
): VerifyResult {
  // A chain that does not verify gets no anomaly report. Anomalies are a
  // secondary reading of records the walk vouched for, and reading timestamps
  // off a log whose integrity is in question would dress up untrusted bytes as
  // findings. The corruption is the finding.
  return { status: "corrupt", firstBadSeq, reason, message, anomalies: [] };
}

/** `seq` as reported by a raw parsed line, or `null` when unusable. */
function readSeq(record: Record<string, unknown>): number | null {
  const seq = record["seq"];
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 1 ? seq : null;
}

interface Split {
  /** Complete, newline-terminated lines, in file order. */
  complete: string[];
  /** The unterminated final segment, when the file does not end in a newline. */
  torn: string | null;
}

/**
 * Split the raw file into complete lines plus an optional torn tail.
 *
 * A torn tail is *only* an unterminated final segment. {@link appendEvent}
 * writes `line + "\n"` in a single `write(2)` on an `O_APPEND` handle, so a
 * crashed writer can leave a partial line but cannot leave a complete,
 * newline-terminated line that is malformed. A malformed line that *is*
 * newline-terminated is therefore corruption, not a torn write, and is reported
 * as such wherever it appears — final line included.
 */
function splitLines(raw: string): Split {
  const segments = raw.split("\n");
  const last = segments[segments.length - 1] ?? "";
  if (last.length === 0) {
    segments.pop(); // the empty segment after the final newline
    return { complete: segments, torn: null };
  }
  segments.pop();
  return { complete: segments, torn: last };
}

/**
 * Where a chain walk starts.
 *
 * The genesis start is `{ prevSeq: 0, prevHash: null, lineNumberBase: 0 }`, and
 * a walk from there is the only thing {@link verify} ever does. A non-genesis
 * start exists for one caller — the verified-read cache of `core/state.ts` — and
 * is sound only when that caller has *proved* the prefix bytes are byte-identical
 * to bytes this process already verified in full. See {@link VerifiedPrefix}.
 */
interface WalkStart {
  /** `seq` of the last record before the walk (0 at genesis). */
  prevSeq: number;
  /** `hash` of the last record before the walk (`null` at genesis). */
  prevHash: string | null;
  /** Lines preceding the walk, so reported line numbers stay file-absolute. */
  lineNumberBase: number;
}

const GENESIS_START: WalkStart = { prevSeq: 0, prevHash: null, lineNumberBase: 0 };

/**
 * Walk `lines` as a hash chain. Returns `null` when the whole prefix verifies,
 * otherwise the first failure.
 *
 * Check order per record — earlier checks report the more specific reason:
 *
 * 1. the line parses as a JSON object (`malformed-line`);
 * 2. `alg` is exactly `sha256/jcs` (`bad-alg`). Checked *before* the schema so
 *    a missing or unrecognized scheme identifier — which SPEC.md §8 requires
 *    verifiers to reject by name — reports `bad-alg` rather than generic
 *    schema noise;
 * 3. the record validates against the `event` schema (`schema-invalid`);
 * 4. the recomputed digest equals `hash` (`hash-mismatch`);
 * 5. `seq` is exactly the predecessor's `seq` + 1, and 1 for the first record
 *    (`seq-duplicate` when it repeats the predecessor, else `seq-gap`);
 * 6. `prev` is the predecessor's `hash`, and `null` for the first record
 *    (`prev-mismatch`, or `not-genesis` for a first record with a non-null
 *    `prev`).
 *
 * Fails closed throughout: anything that cannot be shown to be sound is a
 * failure, never a pass.
 */
function walk(
  lines: string[],
  validateOptions: ValidateOptions,
  start: WalkStart,
): { failure: VerifyResult | null; head: LogHead | null; records: EventRecord[] } {
  let prevSeq = start.prevSeq;
  let prevHash: string | null = start.prevHash;
  const verified: EventRecord[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = start.lineNumberBase + index + 1;

    if (line.trim().length === 0) {
      return {
        failure: corrupt("malformed-line", null, `line ${lineNumber} is blank`),
        head: null,
        records: verified,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        failure: corrupt(
          "malformed-line",
          null,
          `line ${lineNumber} is not valid JSON: ${detail}`,
        ),
        head: null,
        records: verified,
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        failure: corrupt(
          "malformed-line",
          null,
          `line ${lineNumber} is not a JSON object`,
        ),
        head: null,
        records: verified,
      };
    }

    const raw = parsed as Record<string, unknown>;
    const seq = readSeq(raw);

    if (raw["alg"] !== ALG) {
      const found = raw["alg"] === undefined ? "missing" : JSON.stringify(raw["alg"]);
      return {
        failure: corrupt(
          "bad-alg",
          seq,
          `line ${lineNumber}: hash-scheme identifier "alg" is ${found}, expected "${ALG}"`,
        ),
        head: null,
        records: verified,
      };
    }

    const validation = validate("event", raw, validateOptions);
    if (!validation.ok) {
      const detail = validation.errors
        .map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`)
        .join("; ");
      return {
        failure: corrupt(
          "schema-invalid",
          seq,
          `line ${lineNumber} does not validate against the event schema: ${detail}`,
        ),
        head: null,
        records: verified,
      };
    }

    // Schema-valid: the chain fields are now known to have their declared shapes.
    const record = raw as unknown as EventRecord;

    let recomputed: string;
    try {
      recomputed = computeRecordHash(record);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        failure: corrupt(
          "hash-mismatch",
          record.seq,
          `record ${record.seq} could not be canonicalized for hashing: ${detail}`,
        ),
        head: null,
        records: verified,
      };
    }
    if (recomputed !== record.hash) {
      return {
        failure: corrupt(
          "hash-mismatch",
          record.seq,
          `record ${record.seq} hash ${record.hash} does not match its contents (recomputed ${recomputed})`,
        ),
        head: null,
        records: verified,
      };
    }

    if (record.seq !== prevSeq + 1) {
      const duplicate = prevSeq > 0 && record.seq === prevSeq;
      return {
        failure: corrupt(
          duplicate ? "seq-duplicate" : "seq-gap",
          record.seq,
          duplicate
            ? `line ${lineNumber} repeats seq ${record.seq}`
            : `line ${lineNumber} has seq ${record.seq}, expected ${prevSeq + 1}`,
        ),
        head: null,
        records: verified,
      };
    }

    if (prevHash === null) {
      if (record.prev !== null) {
        return {
          failure: corrupt(
            "not-genesis",
            record.seq,
            `record ${record.seq} is the first record but its prev is ${JSON.stringify(record.prev)}, expected null`,
          ),
          head: null,
          records: verified,
        };
      }
    } else if (record.prev !== prevHash) {
      return {
        failure: corrupt(
          "prev-mismatch",
          record.seq,
          `record ${record.seq} prev ${JSON.stringify(record.prev)} does not link to record ${prevSeq} hash ${prevHash}`,
        ),
        head: null,
        records: verified,
      };
    }

    prevSeq = record.seq;
    prevHash = record.hash;
    verified.push(record);
  }

  return {
    failure: null,
    head: prevHash === null ? null : { seq: prevSeq, hash: prevHash },
    records: verified,
  };
}

/**
 * A verification run plus the records it verified.
 *
 * `records` holds every record the walk accepted, in log order: the whole log
 * when `result.status` is `clean`, the intact prefix when it is `torn-tail`, and
 * the prefix before the first failure when it is `corrupt` (where it carries no
 * authority and callers must ignore it).
 */
export interface VerifiedLog {
  result: VerifyResult;
  records: EventRecord[];
}

/**
 * {@link verify}, returning the verified records alongside the verdict.
 *
 * This exists so that a reader which needs *both* — the gate, the token module,
 * the executor, via `core/state.ts` — can have one walk produce both, rather
 * than verifying with this module and then parsing the same bytes a second time
 * with a private walk that could disagree with it (APRV-20 finding S1).
 */
export function verifyWithRecords(logPath: string, options: VerifyOptions = {}): VerifiedLog {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        result: corrupt("malformed-line", null, `log ${logPath} could not be read: ${detail}`),
        records: [],
      };
    }
    // An absent file is an empty log — but it still has to satisfy an anchor,
    // so it falls through to the same walk rather than short-circuiting here.
    raw = "";
  }

  return verifyText(logPath, raw, options, null);
}

/**
 * A prefix of a log that *this process* has already verified in full, together
 * with the evidence needed to resume behind it.
 *
 * Handing one of these to {@link verifyText} skips re-verification of the prefix
 * entirely, which is sound only under the caller's obligation stated on
 * {@link records}: the bytes now on disk in `[0, byteLength)` must be proved
 * byte-identical to the bytes that produced these records. `core/state.ts` is
 * the only caller, and it discharges that obligation by re-hashing the prefix
 * bytes on every use. Verification is a pure function of (bytes, schemas,
 * options), so identical bytes re-verify identically by construction; nothing
 * weaker (a matching size, a matching mtime, a matching head line) implies it.
 */
export interface VerifiedPrefix {
  /** Byte length of the prefix. Always immediately after a newline. */
  byteLength: number;
  /** Number of complete lines in the prefix, for file-absolute line numbers. */
  lines: number;
  /** The prefix's chain head, which the resumed walk chains onto. */
  head: LogHead;
  /** The records the prefix verified to, in log order. */
  records: readonly EventRecord[];
}

/**
 * {@link verifyWithRecords} over text already in hand, optionally resuming
 * behind a {@link VerifiedPrefix}.
 *
 * With `prefix === null`, `text` is the whole log and the walk starts at
 * genesis: this is exactly what {@link verifyWithRecords} does, and the two
 * share every check, message, and line number as a result. With a `prefix`,
 * `text` is the *remainder* of the file (the bytes from `prefix.byteLength` on)
 * and the walk chains onto `prefix.head` with line numbers offset by
 * `prefix.lines`, so a resumed verdict is textually identical to the cold one.
 *
 * Exported for `core/state.ts`'s verified-read cache and for nothing else. Every
 * schema check, hash recompute, `seq` succession check, and `prev` link check
 * still runs on every record the walk covers; resuming changes only *which*
 * records are covered, never how.
 */
export function verifyText(
  logPath: string,
  text: string,
  options: VerifyOptions = {},
  prefix: VerifiedPrefix | null = null,
): VerifiedLog {
  // The read boundary, explicitly (APRV-121). A record that was valid when it
  // was appended stays valid forever: the log is append-only, so a verifier
  // that refused the monetary representation of its own history would declare
  // every log written before the change corrupt. The write boundary is
  // unaffected and stays strict — see `ValidationMode` in `core/validate.ts`.
  const validateOptions: ValidateOptions =
    options.schemaDir === undefined
      ? { mode: "historical" }
      : { schemaDir: options.schemaDir, mode: "historical" };

  const start: WalkStart =
    prefix === null
      ? GENESIS_START
      : { prevSeq: prefix.head.seq, prevHash: prefix.head.hash, lineNumberBase: prefix.lines };
  const priorRecords = prefix === null ? [] : prefix.records;
  const priorLines = prefix === null ? 0 : prefix.lines;

  const { complete, torn } = text.length === 0 ? { complete: [], torn: null } : splitLines(text);
  const walked = walk(complete, validateOptions, start);
  const { failure, head } = walked;
  const records =
    priorRecords.length === 0 ? walked.records : [...priorRecords, ...walked.records];
  const lineCount = priorLines + complete.length;

  // A corrupt prefix outranks a torn tail: the tear is the least of the log's
  // problems, and reporting it would understate the damage.
  if (failure !== null) return { result: failure, records };

  // Computed once over the records the walk vouched for, and attached to every
  // non-corrupt verdict. Additive: it changes no status, no exit code, and no
  // authorization. Clean with anomalies is clean.
  const anomalies = chainAnomalies(records, toleranceOf(options));

  if (torn !== null) {
    return {
      result: {
        status: "torn-tail",
        anomalies,
        records: lineCount,
        intactThroughSeq: head === null ? 0 : head.seq,
        message: `log ${logPath} ends with an unterminated line of ${torn.length} byte(s); records 1..${
          head === null ? 0 : head.seq
        } verify clean. This is the signature of a crashed write. The log is NOT repaired here: truncating the torn line is a human decision.`,
      },
      records,
    };
  }

  const expected = options.expectedHead;
  if (expected !== undefined) {
    if (head === null) {
      return {
        result: corrupt(
          "head-mismatch",
          null,
          `log ${logPath} is empty but the anchored head is seq ${expected.seq} ${expected.hash}: records have been removed`,
        ),
        records,
      };
    }
    if (head.seq !== expected.seq || head.hash !== expected.hash) {
      return {
        result: corrupt(
          "head-mismatch",
          head.seq,
          `log ${logPath} ends at seq ${head.seq} ${head.hash}, but the anchored head is seq ${expected.seq} ${expected.hash}: the log is internally consistent, so this is truncation or a fully recomputed forged suffix`,
        ),
        records,
      };
    }
  }

  return { result: { status: "clean", records: lineCount, head, anomalies }, records };
}

/**
 * Verify the hash chain of the log at `logPath`.
 *
 * An absent file is an empty log, which is clean with zero records and a `null`
 * head — an audit trail that has recorded nothing is not evidence of tampering.
 *
 * The file is opened for reading only; see the module header for the recovery
 * stance and the detection boundary. This is {@link verifyWithRecords} with the
 * records dropped — one walk, one implementation.
 */
export function verify(logPath: string, options: VerifyOptions = {}): VerifyResult {
  return verifyWithRecords(logPath, options).result;
}
