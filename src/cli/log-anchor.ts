/**
 * The committed log as an external witness (APRV-219).
 *
 * ## Why this exists
 *
 * The chain in `.approval/log/events.jsonl` is unkeyed. `docs/proposals/
 * incremental-prefix-proof.md` §3 states the consequence plainly: a process
 * with write access to that file can truncate it and recompute a chain that is
 * self-consistent from genesis, and no cold walk of the file will ever say
 * otherwise, because nothing INSIDE the file contradicts it. The conformance
 * suite says the same thing from the other side — `chain-verification/
 * truncation-unanchored` is a boundary vector: records dropped off the tail with
 * no external anchor leave a valid chain, and an implementation that reports
 * corruption there is wrong.
 *
 * The word in that vector's name is the whole design of this module. What the
 * same-user process cannot rewrite is the copy of the log that is already
 * COMMITTED: a records branch pushed by the advance cadence (APRV-204), a log
 * sync's fast-forward (APRV-125), the trunk behind a protected branch on
 * GitHub. Those bytes are an anchor. Comparing the working log's prefix against
 * them turns "the chain is self-consistent" into "the chain is self-consistent
 * AND it still carries the records somebody else has a copy of".
 *
 * ## What this module does and does not do
 *
 * It READS git. `git rev-parse <rev>:<path>` for a blob id and `git show` for
 * its bytes, both run from the checkout root, never a fetch and never a write.
 * Fetching is the advance verb's job (APRV-203); a verification path that went
 * to the network would be a verification path that fails when the network does.
 *
 * It writes nothing: not the log, not the anchor, not a cache file. The only
 * state it keeps is a process-local map from a git blob id to the facts about
 * that blob, which is safe precisely because a blob id IS the hash of the bytes:
 * two repositories cannot disagree about what one oid holds.
 *
 * A missing anchor is a SKIP with a reason and never a pass. A repository with
 * no committed copy of the log has not proved the working log is honest; it has
 * failed to say anything about it, and those are different answers.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EventRecord } from "../core/log.js";
import type { LogHead } from "../core/verify.js";
import { verifyText } from "../core/verify.js";
import { git, repoPath, repoRoot, showBlob } from "./git-scope.js";

/**
 * The refusal this check can produce. A closed union, per SPEC.md §11.1
 * invariant 6, frozen the way every other union in this runtime is frozen:
 * callers branch on the string.
 *
 * One code, deliberately. Everything else this check can conclude is a state
 * rather than a refusal: no anchor at all is a skip, a working log that is a
 * strict prefix of the anchor is `behind` (the ordinary state of a checkout
 * that has just pulled), and only a working log whose bytes CONTRADICT the
 * anchored ones is a refusal.
 */
export const ANCHOR_REFUSAL_CODES = ["anchor-diverged"] as const;

export type AnchorRefusalCode = (typeof ANCHOR_REFUSAL_CODES)[number];

/** `YYYY-MM-DD`, the shape the default records branch name carries. */
export function defaultRecordsBranch(today: string): string {
  return `records-log-${today.slice(0, 10)}`;
}

/** Every local anchor a previous advance left behind. Order is irrelevant. */
export function advanceAnchors(root: string): string[] {
  const listed = git(["for-each-ref", "--format=%(refname)", "refs/approval/advance/"], root);
  if (!listed.ok) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Where an anchor may be looked for. */
export interface AnchorWhere {
  remote?: string;
  base?: string | null;
  /** An ISO timestamp; only its date half is read, for the day's records branch. */
  today?: string;
}

/**
 * The revs a committed copy of the log may live at, newest evidence first.
 *
 * This is `cli/log-advance.ts`'s `publishedState` resolution, lifted here so
 * that the anchor check and the "what is not yet published" count read the same
 * list. Two lists would be two chances to disagree about which copies of the log
 * this repository can see, and the doctor prints both answers on adjacent rows.
 *
 * `HEAD` is last and is still a candidate: a checkout whose current commit
 * carries the log HAS a committed copy of it, and a check that ignored that
 * would report "never committed" about a log with thousands of committed
 * records — which is exactly the misread APRV-210 recorded.
 */
export function anchorRevs(root: string, where: AnchorWhere = {}): string[] {
  const remote = where.remote ?? "origin";
  const base = where.base ?? "main";
  const today = where.today ?? new Date().toISOString();
  return [
    ...advanceAnchors(root),
    `refs/remotes/${remote}/${base}`,
    `refs/remotes/${remote}/${defaultRecordsBranch(today)}`,
    "HEAD",
  ];
}

/** One committed copy of the log, and everything a comparison needs from it. */
export interface Anchor {
  /** The rev it was read at, as the check names it in its own messages. */
  rev: string;
  /** Git's object id for the blob. Content-addressed, so it is also the cache key. */
  oid: string;
  /** Byte length of the anchored copy. */
  byteLength: number;
  /** SHA-256 of those bytes, hex. Not a chain hash: a digest of the file. */
  digest: string;
  /** The anchored chain's head. Never null — an empty copy anchors nothing. */
  head: LogHead;
  /** How many records the anchored copy carries. */
  records: number;
}

/** An anchor plus the bytes, kept only inside this module. */
interface AnchoredCopy {
  bytes: Buffer;
  byteLength: number;
  digest: string;
  head: LogHead;
  records: number;
}

/**
 * Blob id → the facts about that blob, or `null` for "not usable as an anchor".
 *
 * Process-local and keyed by content, which is what makes it safe to share
 * across repositories and across every caller in one process: a git blob id is
 * the hash of the bytes, so an entry can never describe the wrong file. The
 * daemon is the reason it exists — under `read_proof: full` the anchor check
 * runs on every tick, and a full chain walk of the committed copy every thirty
 * seconds to re-learn an answer that cannot have changed is work spent on
 * nothing.
 */
const BLOBS = new Map<string, AnchoredCopy | null>();

/** How many blobs the cache keeps before it starts over. Bounded, not clever. */
const BLOB_CACHE_LIMIT = 8;

/** Drop the cache. Exported for tests, which build a new repository per case. */
export function forgetAnchorBlobs(): void {
  BLOBS.clear();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The blob id of `<rev>:<relative>`, or `null` when git has no such blob. */
function blobOid(root: string, rev: string, relative: string): string | null {
  const result = git(["rev-parse", "--verify", "--quiet", `${rev}:${relative}`], root);
  if (!result.ok) return null;
  const oid = result.stdout.trim();
  return oid.length === 0 ? null : oid;
}

/**
 * The anchored copy at one rev, or `null` with the reason it is not an anchor.
 *
 * A committed copy that does not itself verify is NOT an anchor. It is evidence
 * of something else, and this check says so in the skip reason rather than
 * comparing the working log against bytes nobody has proved anything about —
 * SPEC.md §11.1 invariant 1, enforcement paths read only verified records,
 * binds the committed side too.
 */
function anchoredCopy(
  root: string,
  rev: string,
  relative: string,
  options: { schemaDir?: string },
): { ok: true; copy: AnchoredCopy; oid: string } | { ok: false; reason: string | null } {
  const oid = blobOid(root, rev, relative);
  if (oid === null) return { ok: false, reason: null };

  const cached = BLOBS.get(oid);
  if (cached !== undefined) {
    return cached === null
      ? { ok: false, reason: `${rev} carries a copy of the log that does not verify or is empty` }
      : { ok: true, copy: cached, oid };
  }

  const bytes = showBlob(root, rev, relative);
  if (bytes === null) return { ok: false, reason: null };

  const verified = verifyText(
    `${rev}:${relative}`,
    bytes.toString("utf8"),
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
    null,
  );
  const last = verified.records[verified.records.length - 1];
  if (verified.result.status !== "clean" || last === undefined) {
    if (BLOBS.size >= BLOB_CACHE_LIMIT) BLOBS.clear();
    BLOBS.set(oid, null);
    return {
      ok: false,
      reason:
        verified.result.status === "clean"
          ? `${rev} carries an empty copy of the log, which anchors nothing`
          : `${rev} carries a copy of the log that does not verify (${verified.result.status})`,
    };
  }

  const copy: AnchoredCopy = {
    bytes,
    byteLength: bytes.length,
    digest: sha256(bytes),
    head: { seq: last.seq, hash: last.hash },
    records: verified.records.length,
  };
  if (BLOBS.size >= BLOB_CACHE_LIMIT) BLOBS.clear();
  BLOBS.set(oid, copy);
  return { ok: true, copy, oid };
}

/** What {@link resolveAnchor} found. A skip carries the reason, always. */
export type AnchorResolution =
  | { ok: true; anchor: Anchor }
  | { ok: false; reason: string; revs: readonly string[] };

/**
 * The newest committed copy of the log this repository can see.
 *
 * "Newest" is the highest chain head among the candidate revs, not the newest
 * commit: the question is how much of the log somebody else already holds, and
 * a records branch that is one commit older but carries more records is the
 * better witness. Ties keep the first rev in {@link anchorRevs} order, which
 * puts an advance anchor ahead of the trunk ahead of `HEAD`.
 */
export function resolveAnchor(
  root: string,
  logPath: string,
  options: { rev?: string; schemaDir?: string } & AnchorWhere = {},
): AnchorResolution {
  const relative = repoPath(root, logPath);
  const revs = options.rev === undefined ? anchorRevs(root, options) : [options.rev];
  const explicit = options.rev !== undefined;

  let best: Anchor | null = null;
  const notes: string[] = [];
  for (const rev of revs) {
    const found = anchoredCopy(root, rev, relative, options);
    if (!found.ok) {
      if (found.reason !== null) notes.push(found.reason);
      continue;
    }
    if (best !== null && found.copy.head.seq <= best.head.seq) continue;
    best = {
      rev,
      oid: found.oid,
      byteLength: found.copy.byteLength,
      digest: found.copy.digest,
      head: found.copy.head,
      records: found.copy.records,
    };
  }

  if (best !== null) return { ok: true, anchor: best };

  const where = explicit
    ? `${revs[0] ?? "the requested rev"} has no ${relative} blob`
    : `no rev this checkout can see carries a committed copy of ${relative} (tried ${revs.join(", ")})`;
  return {
    ok: false,
    reason:
      notes.length === 0
        ? `${where}, so there is no external witness to compare the working log against`
        : `${where}. ${notes.join("; ")}`,
    revs,
  };
}

/** How the working log stands against the anchor. */
export type AnchorCheck =
  | {
      status: "pass";
      anchor: Anchor;
      /** Working records beyond the anchored head. Zero when the two are equal. */
      ahead: number;
      workingBytes: number;
      detail: string;
    }
  | {
      status: "behind";
      anchor: Anchor;
      /** Anchored records the working log does not carry. Always above zero. */
      behind: number;
      workingBytes: number;
      detail: string;
    }
  | { status: "skip"; reason: string }
  | {
      status: "diverged";
      code: AnchorRefusalCode;
      anchor: Anchor;
      workingBytes: number;
      message: string;
    };

/** What {@link checkLogAnchor} is asked. `records` is the VERIFIED working log. */
export interface AnchorCheckOptions extends AnchorWhere {
  logPath: string;
  /**
   * The working log's records, already verified by the caller.
   *
   * Required rather than re-derived, for SPEC.md §11.1 invariant 1: this check
   * reads only verified records, and a check that walked the chain itself would
   * be a second opinion about a question its caller has already answered.
   */
  records: readonly EventRecord[];
  /** An explicit rev, instead of the default resolution. */
  rev?: string;
  schemaDir?: string;
}

/**
 * Compare the working log's prefix against the newest committed copy of it.
 *
 * Two facts are checked, and they are checked separately on purpose:
 *
 * 1. **The bytes.** The working log's first `anchor.byteLength` bytes must hash
 *    to the anchor's digest. This is a claim about the FILE, stricter than any
 *    claim about the chain: a rewrite that preserves every record hash while
 *    changing the bytes around them (whitespace, key order in a re-serialized
 *    line) still fails here.
 * 2. **The head.** The working log's record at the anchor's head seq must carry
 *    the anchor's hash. Implied by (1) whenever (1) holds, and stated anyway,
 *    because it is the fact a human reads in the message and the one that names
 *    which record the two copies stopped agreeing at.
 */
export function checkLogAnchor(options: AnchorCheckOptions): AnchorCheck {
  const root = repoRoot(dirname(options.logPath));
  if (root === null) {
    return {
      status: "skip",
      reason: `${options.logPath} is not inside a git repository, so there is no committed copy to anchor it against`,
    };
  }

  const resolution = resolveAnchor(root, options.logPath, options);
  if (!resolution.ok) return { status: "skip", reason: resolution.reason };
  const anchor = resolution.anchor;

  const found = anchoredCopy(root, anchor.rev, repoPath(root, options.logPath), options);
  if (!found.ok) {
    return {
      status: "skip",
      reason: `${anchor.rev} stopped being readable while it was being compared; nothing was decided from it`,
    };
  }

  let working: Buffer;
  try {
    working = readFileSync(options.logPath);
  } catch (cause) {
    return {
      status: "skip",
      reason: `${options.logPath} could not be read as bytes (${
        cause instanceof Error ? cause.message : String(cause)
      }), so it could not be compared against ${anchor.rev}`,
    };
  }

  const workingHead = options.records[options.records.length - 1] ?? null;

  // The working log is shorter than the anchored copy. That is either the
  // ordinary state of a checkout that has just pulled (a strict prefix), or the
  // truncation this whole check exists for.
  if (working.length < anchor.byteLength) {
    if (found.copy.bytes.subarray(0, working.length).equals(working)) {
      return {
        status: "behind",
        anchor,
        behind: anchor.head.seq - (workingHead?.seq ?? 0),
        workingBytes: working.length,
        detail: `the working log is a prefix of ${anchor.rev}: the committed copy carries ${String(
          anchor.head.seq - (workingHead?.seq ?? 0),
        )} record(s) this file does not, through seq ${String(anchor.head.seq)}`,
      };
    }
    return {
      status: "diverged",
      code: "anchor-diverged",
      anchor,
      workingBytes: working.length,
      message: `the working log ${options.logPath} is ${String(
        working.length,
      )} bytes and ${anchor.rev} anchors ${String(
        anchor.byteLength,
      )} bytes through seq ${String(anchor.head.seq)}, and the shorter file is not a prefix of the longer one. A committed copy of the log is the one witness a process with write access to this file cannot rewrite; these two are not the same chain.`,
    };
  }

  const prefix = working.subarray(0, anchor.byteLength);
  if (sha256(prefix) !== anchor.digest) {
    return {
      status: "diverged",
      code: "anchor-diverged",
      anchor,
      workingBytes: working.length,
      message: `the first ${String(anchor.byteLength)} bytes of ${
        options.logPath
      } do not hash to the copy committed at ${anchor.rev} (anchored through seq ${String(
        anchor.head.seq,
      )} ${anchor.head.hash}). The anchored prefix has been rewritten in this working file; a chain that re-verifies from genesis proves only that whoever rewrote it recomputed the hashes.`,
    };
  }

  const at = options.records.find((record) => record.seq === anchor.head.seq);
  if (at === undefined || at.hash !== anchor.head.hash) {
    return {
      status: "diverged",
      code: "anchor-diverged",
      anchor,
      workingBytes: working.length,
      message: `${anchor.rev} anchors seq ${String(anchor.head.seq)} at ${
        anchor.head.hash
      } and the working log ${
        at === undefined
          ? "carries no record at that seq"
          : `carries ${at.hash} there`
      }. These are two chains, not one.`,
    };
  }

  const ahead = (workingHead?.seq ?? 0) - anchor.head.seq;
  return {
    status: "pass",
    anchor,
    ahead,
    workingBytes: working.length,
    detail:
      ahead === 0
        ? `the working log is byte-identical to the copy committed at ${anchor.rev} (${describeAnchor(
            anchor,
          )})`
        : `the working log carries the copy committed at ${anchor.rev} (${describeAnchor(
            anchor,
          )}) byte for byte and stands ${String(ahead)} record(s) ahead of it`,
  };
}

/** One anchor, as messages and rows spell one. */
export function describeAnchor(anchor: Anchor): string {
  return `seq ${String(anchor.head.seq)} ${anchor.head.hash}, ${String(anchor.byteLength)} bytes`;
}
