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
import { compareChains, describeDrift, describeHead } from "../core/log-reconcile.js";
import { readVerifiedRecords } from "../core/state.js";
import { git, readBlob, repoPath, repoRoot } from "./git-scope.js";

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

/**
 * What one candidate rev's lookup did, in the words a skip reason quotes.
 *
 * `git rev-parse --verify --quiet <rev>:<path>` exiting 1 with nothing on
 * stderr is the ordinary "this rev does not carry that file" and reads as such;
 * anything else is the lookup itself failing and has to read differently.
 */
interface GitAttempt {
  command: string;
  detail: string;
}

/** One attempt, folded onto one line. Skip reasons are single-line by contract. */
function describeAttempt(attempt: GitAttempt): string {
  return `\`${attempt.command}\` ${attempt.detail}`;
}

/** The blob id of `<rev>:<relative>`, or the attempt that failed to name one. */
function blobOid(
  root: string,
  rev: string,
  relative: string,
): { oid: string } | { oid: null; attempt: GitAttempt } {
  const spec = `${rev}:${relative}`;
  const command = `git rev-parse --verify --quiet ${spec}`;
  const result = git(["rev-parse", "--verify", "--quiet", spec], root);
  const said = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
  if (!result.ok) {
    return {
      oid: null,
      attempt: {
        command,
        detail: `${
          result.status === null ? "did not complete" : `exited ${String(result.status)}`
        }${said.length === 0 ? " and printed nothing" : `: ${said}`}`,
      },
    };
  }
  const oid = result.stdout.trim();
  if (oid.length === 0) {
    return { oid: null, attempt: { command, detail: "exited 0 and named no blob" } };
  }
  return { oid };
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
):
  | { ok: true; copy: AnchoredCopy; oid: string }
  | { ok: false; reason: string | null; attempt: GitAttempt | null } {
  const found = blobOid(root, rev, relative);
  if (found.oid === null) return { ok: false, reason: null, attempt: found.attempt };
  const oid = found.oid;

  const cached = BLOBS.get(oid);
  if (cached !== undefined) {
    return cached === null
      ? {
          ok: false,
          reason: `${rev} carries a copy of the log that does not verify or is empty`,
          attempt: null,
        }
      : { ok: true, copy: cached, oid };
  }

  const read = readBlob(root, rev, relative);
  if (!read.ok) {
    // `git rev-parse` named a blob and `git show` could not hand it over. That
    // is never "this rev has no committed copy" — the object store says it
    // does — so it must not be reported as a rev with nothing to say.
    return {
      ok: false,
      reason: `${rev} names a blob for ${relative} that could not be read`,
      attempt: { command: read.command, detail: read.detail },
    };
  }
  const bytes = read.bytes;

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
      attempt: null,
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
  const attempts: string[] = [];
  for (const rev of revs) {
    const found = anchoredCopy(root, rev, relative, options);
    if (!found.ok) {
      if (found.reason !== null) notes.push(found.reason);
      if (found.attempt !== null) attempts.push(describeAttempt(found.attempt));
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
  /**
   * What git was actually asked, and what it answered, for every rev.
   *
   * Printed only when NOTHING resolved, which is the one state where a reader
   * has to distinguish "this repository has never committed the log" from "the
   * lookup is broken". Those two produced the same sentence until this was
   * added, and the second one shipped: `approval log verify --anchor` named
   * four revs and no reason in a checkout where `git show refs/remotes/origin/
   * main:.approval/log/events.jsonl` printed the log, because the read was
   * outrunning the runner's output buffer and the failure had nowhere to go.
   * A skip that lists revs without saying how each lookup failed is a skip a
   * person cannot act on.
   */
  const said = [...notes, ...attempts];
  return {
    ok: false,
    reason:
      said.length === 0
        ? `${where}, so there is no external witness to compare the working log against`
        : `${where}. ${said.join("; ")}`,
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
      reread?: AnchorReread;
    }
  | {
      status: "behind";
      anchor: Anchor;
      /** Anchored records the working log does not carry. Always above zero. */
      behind: number;
      workingBytes: number;
      detail: string;
      reread?: AnchorReread;
    }
  | { status: "skip"; reason: string; reread?: AnchorReread }
  | {
      status: "diverged";
      code: AnchorRefusalCode;
      anchor: Anchor;
      workingBytes: number;
      message: string;
      reread?: AnchorReread;
    };

/**
 * The working file moved underneath this check, so the check read it again
 * (APRV-389).
 *
 * Carried by exactly the verdicts reached from that SECOND read. The caller's
 * `records` are a view of the log taken at some earlier instant; the bytes this
 * module reads are the file as it stands now. A `log sync`, a records pull, or
 * any other writer rewriting `events.jsonl` under a running daemon makes the two
 * disagree, and the disagreement is a fact about READS rather than about chains:
 * it is reported, and nothing is ever decided from it.
 */
export interface AnchorReread {
  /** Where the view the caller handed in ended. */
  viewHead: LogHead | null;
  /** Where the file ended when this check read it for itself. */
  fileHead: LogHead | null;
  /** The one line a daemon logs for it. */
  detail: string;
}

/** What {@link checkLogAnchor} is asked. `records` is the VERIFIED working log. */
export interface AnchorCheckOptions extends AnchorWhere {
  logPath: string;
  /**
   * The working log's records, already verified by the caller.
   *
   * Required rather than re-derived, for SPEC.md §11.1 invariant 1: this check
   * reads only verified records, and a check that walked the chain itself would
   * be a second opinion about a question its caller has already answered.
   *
   * It is a VIEW, and APRV-389 is what a view costs: the caller read it at some
   * earlier instant and this module reads the file's bytes now. Where the two
   * could disagree, the bytes decide and the view is re-derived from the file
   * through the same sanctioned verified read the caller made, rather than being
   * trusted or contradicted. See {@link AnchorReread}.
   */
  records: readonly EventRecord[];
  /** An explicit rev, instead of the default resolution. */
  rev?: string;
  schemaDir?: string;
}

/**
 * What one comparison of (anchored copy, working bytes, a view of them) says.
 *
 * Internal, and one answer wider than {@link AnchorCheck}: `moved` is the two
 * pieces of evidence contradicting EACH OTHER, which is never a verdict about
 * the log.
 */
type AnchorComparison =
  | { kind: "pass"; ahead: number }
  | { kind: "behind"; behind: number }
  | { kind: "diverged"; message: string }
  /**
   * The bytes and the view cannot both describe one file (APRV-389).
   *
   * Two shapes, one meaning. The bytes carry the anchored prefix, so the
   * anchored head record is inside them by construction, while the view has no
   * record at that seq, or carries a different hash there; or the bytes are
   * shorter than the anchored copy while the view claims the anchored head. Both
   * say the file changed between the caller's read and this one, and the answer
   * is to read it again, never to report a fork.
   */
  | { kind: "moved"; detail: string };

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
 *
 * ## Which read each fact comes from (APRV-389)
 *
 * Fact 1 is read from the file here. Fact 2 was read from the caller's `records`,
 * and on 2026-09-19 the primary checkout's daemon stopped `anchor-diverged` on
 * the gap between them: `approval log sync` rewrote `events.jsonl` (baseline,
 * fast-forward, restore) after the tick's opening read and before this module's
 * `readFileSync`, so fact 1 passed on the new bytes while fact 2 failed on the
 * old view. The message then said both "carries no record at that seq" and
 * "ahead by 171: the committed chain is a prefix of the working chain", and the
 * record the anchor named was sitting in the file all along.
 *
 * Two rules come out of that, and they hold for every caller:
 *
 *  - **The bytes decide, the view does not.** Once the anchored prefix is
 *    present byte for byte, the anchored head record is INSIDE those bytes; a
 *    view that disagrees is stale, which is a fact about reads. So a disagreement
 *    between the two is `moved`, never `diverged`, and it is answered by reading
 *    the file again, once, through {@link readVerifiedRecords}, the same
 *    sanctioned verified read the caller used. Fail-closed is unaffected: every
 *    `diverged` verdict is reached from the BYTES and confirmed by that second
 *    read, so a real fork still stops a daemon.
 *  - **A message never asserts two contradictory facts.** The chain comparison
 *    is quoted only where it agrees that the chains parted, and there it names
 *    the seq and both heads. Where the chains agree and the bytes do not, the
 *    message says that, which is the honest description of a re-serialized log.
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
  const anchored = found.copy;

  /** The working log's bytes, or the skip that says why they could not be read. */
  const readWorking = (): { ok: true; bytes: Buffer } | { ok: false; skip: AnchorCheck } => {
    try {
      return { ok: true, bytes: readFileSync(options.logPath) };
    } catch (cause) {
      return {
        ok: false,
        skip: {
          status: "skip",
          reason: `${options.logPath} could not be read as bytes (${
            cause instanceof Error ? cause.message : String(cause)
          }), so it could not be compared against ${anchor.rev}`,
        },
      };
    }
  };

  /**
   * Where the two chains stop agreeing, in `core/log-reconcile.ts`'s words.
   *
   * Computed only on the refusal path, and through the SHARED comparison rather
   * than a second one written here: a divergence ends with a person deciding
   * which of two chains is the log, and the sentence they read has to name the
   * seq. Re-walking the committed copy costs a chain walk, which is the right
   * price on a path that is about to stop a daemon.
   *
   * It is quoted only when it AGREES that the chains parted (APRV-389). When the
   * records match as far as both copies go while the bytes do not, "ahead by n"
   * would assert the committed copy is a prefix of this file, which is exactly
   * what the digest just disproved; the same sentence would then carry a claim
   * and its contradiction, which is how the 2026-09-19 stop read.
   */
  const divergence = (working: Buffer): string => {
    const compared = compareChains(
      { label: `the working log ${options.logPath}`, text: working.toString("utf8") },
      { label: anchor.rev, text: anchored.bytes.toString("utf8") },
      options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
    );
    if (!compared.ok) return "";
    if (compared.drift.relation === "diverged") return ` ${describeDrift(compared.drift)}.`;
    return ` The records themselves agree as far as both copies go (working ${describeHead(
      compared.drift.workingHead,
    )}, committed ${describeHead(
      compared.drift.committedHead,
    )}), so the anchored records are all here with different bytes around them: this file has been re-serialized, not re-chained.`;
  };

  /**
   * One comparison, from one set of bytes and one view of them.
   *
   * Pure apart from the chain walk a divergence message pays for. Every branch
   * that could be the two reads disagreeing rather than the two COPIES
   * disagreeing answers `moved`.
   */
  const compare = (working: Buffer, records: readonly EventRecord[]): AnchorComparison => {
    const workingHead = records[records.length - 1] ?? null;
    const at = records.find((record) => record.seq === anchor.head.seq);
    const viewCarriesAnchor = at !== undefined && at.hash === anchor.head.hash;

    // The working log is shorter than the anchored copy. That is either the
    // ordinary state of a checkout that has just pulled (a strict prefix), or the
    // truncation this whole check exists for.
    if (working.length < anchor.byteLength) {
      if (anchored.bytes.subarray(0, working.length).equals(working)) {
        return { kind: "behind", behind: anchor.head.seq - (workingHead?.seq ?? 0) };
      }
      if (viewCarriesAnchor) {
        return {
          kind: "moved",
          detail: `the view carries the anchored record at seq ${String(
            anchor.head.seq,
          )} while the file on disk is ${String(working.length)} bytes, shorter than the ${String(
            anchor.byteLength,
          )} bytes ${anchor.rev} anchors`,
        };
      }
      return {
        kind: "diverged",
        message: `the working log ${options.logPath} is ${String(
          working.length,
        )} bytes and ${anchor.rev} anchors ${String(
          anchor.byteLength,
        )} bytes through seq ${String(anchor.head.seq)}, and the shorter file is not a prefix of the longer one. A committed copy of the log is the one witness a process with write access to this file cannot rewrite; these two are not the same chain.${divergence(
          working,
        )}`,
      };
    }

    const prefix = working.subarray(0, anchor.byteLength);
    if (sha256(prefix) !== anchor.digest) {
      // A claim about bytes, which no view can excuse and none is consulted for:
      // a view agreeing with the anchor's head says nothing about the bytes
      // around the records, and those bytes are what this branch is about.
      return {
        kind: "diverged",
        message: `the first ${String(anchor.byteLength)} bytes of ${
          options.logPath
        } do not hash to the copy committed at ${anchor.rev} (anchored through seq ${String(
          anchor.head.seq,
        )} ${anchor.head.hash}). The anchored prefix has been rewritten in this working file; a chain that re-verifies from genesis proves only that whoever rewrote it recomputed the hashes.${divergence(
          working,
        )}`,
      };
    }

    // The anchored prefix is present byte for byte, so the file carries the
    // anchored head record: it is one of the records inside those bytes. A view
    // that says otherwise is older (or newer) than the bytes, never a fork.
    if (!viewCarriesAnchor) {
      return {
        kind: "moved",
        detail: `the file carries the copy committed at ${anchor.rev} byte for byte through seq ${String(
          anchor.head.seq,
        )}, and the view handed in ${
          at === undefined
            ? `has no record at that seq (it ends at ${describeHead(workingHead)})`
            : `carries ${at.hash} there`
        }`,
      };
    }

    return { kind: "pass", ahead: (workingHead?.seq ?? 0) - anchor.head.seq };
  };

  /** A comparison, dressed as the verdict callers branch on. */
  const verdict = (
    comparison: AnchorComparison,
    working: Buffer,
    reread: AnchorReread | null,
  ): AnchorCheck => {
    const carry = reread === null ? {} : { reread };
    switch (comparison.kind) {
      case "pass":
        return {
          status: "pass",
          anchor,
          ahead: comparison.ahead,
          workingBytes: working.length,
          detail:
            comparison.ahead === 0
              ? `the working log is byte-identical to the copy committed at ${
                  anchor.rev
                } (${describeAnchor(anchor)})`
              : `the working log carries the copy committed at ${anchor.rev} (${describeAnchor(
                  anchor,
                )}) byte for byte and is ahead by ${String(comparison.ahead)} record(s)`,
          ...carry,
        };
      case "behind":
        return {
          status: "behind",
          anchor,
          behind: comparison.behind,
          workingBytes: working.length,
          detail: `the working log is a prefix of ${anchor.rev}: the committed copy carries ${String(
            comparison.behind,
          )} record(s) this file does not, through seq ${String(anchor.head.seq)}`,
          ...carry,
        };
      case "diverged":
        return {
          status: "diverged",
          code: "anchor-diverged",
          anchor,
          workingBytes: working.length,
          message: comparison.message,
          ...carry,
        };
      case "moved":
        // Two reads in a row could not agree with each other. A check that could
        // not look must not report a pass, and it must not report a fork either:
        // nothing here has contradicted the anchor, so there is nothing to
        // refuse, and the next tick asks again over bytes that have settled.
        return {
          status: "skip",
          reason: `${options.logPath} changed underneath this check twice (${comparison.detail}), so nothing was decided from it. A writer is rewriting the log; \`approval log verify --anchor\` once it is quiet says whether the committed copy is still carried.`,
          ...carry,
        };
    }
  };

  const first = readWorking();
  if (!first.ok) return first.skip;
  const opening = compare(first.bytes, options.records);
  if (opening.kind === "pass" || opening.kind === "behind") {
    return verdict(opening, first.bytes, null);
  }

  /**
   * The second read (APRV-389), on the two paths that would otherwise end a run.
   *
   * `moved` means the view and the bytes disagreed; `diverged` means this check
   * is about to stop a daemon or fail a verify. Both re-read the file, and the
   * records come from {@link readVerifiedRecords} with the cache off: a cold walk
   * from genesis, independent of whatever any process in this program has cached,
   * which is the right price where the alternative is a false stop or a missed
   * fork. The bytes are re-read too, so the pair belongs to one instant of the
   * file as closely as two system calls can.
   */
  const again = readWorking();
  if (!again.ok) return again.skip;
  const fresh = readVerifiedRecords(options.logPath, {
    ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
    cache: null,
  });
  if (!fresh.ok) {
    return {
      status: "skip",
      reason: `${options.logPath} did not verify when this check read it again (${fresh.code}): ${fresh.message} Nothing was decided from it, and the anchor comparison is not the verdict to reach for a log that does not verify.`,
    };
  }
  const last = options.records[options.records.length - 1];
  const viewHead: LogHead | null = last === undefined ? null : { seq: last.seq, hash: last.hash };
  const fileHead = fresh.head;
  /**
   * Whether the re-read is worth reporting, which is not the same question as
   * whether it happened.
   *
   * A confirmed divergence over bytes nobody touched re-read for confidence and
   * has nothing to say about reads; the marker is for the case where the view and
   * the file were genuinely two different things, because that is the fact an
   * operator acts on (something is rewriting the log) and the one this check used
   * to report as a fork.
   */
  const shifted =
    opening.kind === "moved" ||
    viewHead?.seq !== fileHead?.seq ||
    viewHead?.hash !== fileHead?.hash;
  const reread: AnchorReread = {
    viewHead,
    fileHead,
    detail: `the working log moved underneath the anchor check: the view it was handed ends at ${describeHead(
      viewHead,
    )} and the file itself ends at ${describeHead(
      fileHead,
    )}; the comparison was made again from the file. A \`log sync\` or a records pull rewriting \`events.jsonl\` under a running daemon is the ordinary cause.`,
  };
  return verdict(compare(again.bytes, fresh.records), again.bytes, shifted ? reread : null);
}

/** One anchor, as messages and rows spell one. */
export function describeAnchor(anchor: Anchor): string {
  return `seq ${String(anchor.head.seq)} ${anchor.head.hash}, ${String(anchor.byteLength)} bytes`;
}
