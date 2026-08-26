/**
 * Chain drift: how two copies of one log relate to each other (APRV-125).
 *
 * Two verbs and one doctor check ask the same question in three places. `approval
 * log sync` asks it after a fast-forward pull ("is the committed baseline a
 * prefix of the chain I was holding, or did the two fork?"), `approval doctor`
 * asks it standing still ("is my working log ahead of what is committed, and by
 * how much?"), and a future ambient runtime will ask it before offering to
 * advance. Three implementations of one comparison would be three chances to
 * disagree about whether a repository has forked, so there is one, and it lives
 * here.
 *
 * ## What a comparison is allowed to read
 *
 * Only verified records. Both sides go through `core/verify.ts` before a single
 * `seq` is compared, and a side that does not verify clean is a refusal rather
 * than an answer: a torn or broken chain has no head worth naming, and
 * "diverged" would be the wrong word for "unreadable". This is SPEC §11.1's
 * "enforcement paths read only verified records" applied to the one path that
 * decides whether a working log may be put back after a pull.
 *
 * ## The four relations, and why `behind` is not a fork
 *
 * The chains are compared record by record on their hashes, which is the whole
 * comparison: a hash equality at position i means every byte of records 1..i is
 * shared, because each hash covers its own record and its predecessor's.
 *
 * - `equal` — the same chain. Nothing to do.
 * - `ahead` — the committed chain is a strict PREFIX of the working one. The
 *   working file carries appends that are not committed yet; this is the normal
 *   state of a machine that has been granting approvals.
 * - `behind` — the working chain is a strict prefix of the committed one. The
 *   pull brought records this machine did not have. Adopting the longer chain
 *   extends the working log and rewinds nothing, so it is not a fork either.
 * - `diverged` — the chains agree up to some point and then do not. Two
 *   appenders built different records on the same predecessor. Hash chains do
 *   not merge and nothing in this codebase may try to merge them; the only
 *   honest answer is the seq where they parted and a refusal.
 */

import type { EventRecord, LogHead } from "./log.js";
import type { ValidateOptions } from "./validate.js";
import { verifyText } from "./verify.js";

/** How the working chain stands relative to the committed one. */
export type LogRelation = "equal" | "ahead" | "behind" | "diverged";

/** The comparison's answer. Every field is present in every relation. */
export interface LogDrift {
  relation: LogRelation;
  /** Records the working chain holds beyond the committed one. */
  ahead: number;
  /** Records the committed chain holds beyond the working one. */
  behind: number;
  workingHead: LogHead | null;
  committedHead: LogHead | null;
  /**
   * The first `seq` at which the two chains carry different records. `null`
   * unless `relation` is `diverged`; a prefix relationship has no such point.
   */
  firstDivergentSeq: number | null;
}

/** Why a comparison could not be made. Distinct from any relation. */
export type ReconcileRefusalCode = "working-unverified" | "committed-unverified";

export type ReconcileResult =
  | { ok: true; drift: LogDrift }
  | { ok: false; code: ReconcileRefusalCode; message: string };

/** One side of the comparison, named so a refusal can say which side failed. */
export interface ChainSide {
  /** How this side is named in messages ("the working log", "HEAD:<path>"). */
  label: string;
  /** The whole file, as text. An absent file is the empty string. */
  text: string;
}

function headOf(records: readonly EventRecord[]): LogHead | null {
  const last = records[records.length - 1];
  return last === undefined ? null : { seq: last.seq, hash: last.hash };
}

/**
 * Verify one side and hand back its records, or say why it cannot be compared.
 *
 * A torn tail is refused rather than truncated to its intact prefix. Comparing
 * against a prefix would quietly answer a question nobody asked: "how does my
 * chain relate to the part of yours that survived?" is not "how do our chains
 * relate", and the difference is the one that decides whether a snapshot is
 * restored.
 */
function verifiedRecords(
  side: ChainSide,
  which: ReconcileRefusalCode,
  options: ValidateOptions,
): { ok: true; records: readonly EventRecord[] } | { ok: false; code: ReconcileRefusalCode; message: string } {
  const verified = verifyText(side.label, side.text, options, null);
  switch (verified.result.status) {
    case "clean":
      return { ok: true, records: verified.records };
    case "torn-tail":
      return {
        ok: false,
        code: which,
        message: `${side.label} ends without a newline: the final record is truncated, so its chain has no head to compare. Run \`approval log verify\`.`,
      };
    case "corrupt":
      return {
        ok: false,
        code: which,
        message: `${side.label} does not verify (${verified.result.reason}${
          verified.result.firstBadSeq === null ? "" : ` at seq ${verified.result.firstBadSeq}`
        }): ${verified.result.message}. Nothing may be decided from a log that does not verify.`,
      };
  }
}

/**
 * Compare a working chain against a committed one.
 *
 * `working` is the chain a machine is holding (the file on disk, or a snapshot
 * of it); `committed` is the chain in version control. The relation is stated
 * from the working chain's point of view, which is the direction both callers
 * report in: doctor says "ahead by 3", sync says "the committed baseline is a
 * prefix, so the snapshot goes back".
 */
export function compareChains(
  working: ChainSide,
  committed: ChainSide,
  options: ValidateOptions = {},
): ReconcileResult {
  const left = verifiedRecords(working, "working-unverified", options);
  if (!left.ok) return left;
  const right = verifiedRecords(committed, "committed-unverified", options);
  if (!right.ok) return right;

  const workingHead = headOf(left.records);
  const committedHead = headOf(right.records);
  const shared = Math.min(left.records.length, right.records.length);

  for (let index = 0; index < shared; index += 1) {
    const mine = left.records[index] as EventRecord;
    const theirs = right.records[index] as EventRecord;
    if (mine.hash === theirs.hash && mine.seq === theirs.seq) continue;
    return {
      ok: true,
      drift: {
        relation: "diverged",
        ahead: left.records.length - index,
        behind: right.records.length - index,
        workingHead,
        committedHead,
        // The seq of the first record the two chains do not share. Both sides
        // number from 1 in lockstep up to here, so either record names it.
        firstDivergentSeq: mine.seq,
      },
    };
  }

  const ahead = left.records.length - shared;
  const behind = right.records.length - shared;
  const relation: LogRelation = ahead > 0 ? "ahead" : behind > 0 ? "behind" : "equal";
  return {
    ok: true,
    drift: { relation, ahead, behind, workingHead, committedHead, firstDivergentSeq: null },
  };
}

/** A head, as messages and runbooks spell one. */
export function describeHead(head: LogHead | null): string {
  return head === null ? "empty" : `seq ${String(head.seq)} ${head.hash}`;
}

/** One sentence naming the relation, shared by sync's report and doctor's detail. */
export function describeDrift(drift: LogDrift): string {
  switch (drift.relation) {
    case "equal":
      return `equal: working and committed are the same chain (${describeHead(drift.workingHead)})`;
    case "ahead":
      return `ahead by ${String(drift.ahead)}: the committed chain (${describeHead(
        drift.committedHead,
      )}) is a prefix of the working chain (${describeHead(drift.workingHead)})`;
    case "behind":
      return `behind by ${String(drift.behind)}: the working chain (${describeHead(
        drift.workingHead,
      )}) is a prefix of the committed chain (${describeHead(drift.committedHead)})`;
    case "diverged":
      return `DIVERGED at seq ${String(drift.firstDivergentSeq)}: working ${describeHead(
        drift.workingHead,
      )}, committed ${describeHead(drift.committedHead)}`;
  }
}
