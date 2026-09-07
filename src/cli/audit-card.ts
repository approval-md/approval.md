/**
 * The retrospective review card, built from the log (SPEC.md §5.2, §9.1, §10.3;
 * APRV-299).
 *
 * The daemon draws `audit.sampled` records and, until this task, the only place
 * to answer one was `approval audit list` / `approval audit review` in a
 * terminal. The supervised bargain is "execute now, a fraction is reviewed
 * after", and a review nobody is shown is a review that does not happen: on
 * 2026-09-07 sixty of them were sitting in `QUEUE.md` while the approver's
 * phone showed nothing.
 *
 * This module turns each open sample into a {@link ReviewCard} the Telegram
 * channel renders. Three properties are the whole of its contract:
 *
 * - **Everything is derived, nothing is self-reported.** The class comes from
 *   the `task.registered` declaration the log already holds, the command
 *   breakdown is recomputed by the classifier's own tokenizer over the bytes
 *   the payload store holds under the hash the `execution.started` recorded,
 *   the rate is the one the `audit.sampled` record states, and the claimed
 *   summary carries the actor that registered the action. No payload key an
 *   authoring party wrote chooses a row (SPEC.md §11.1 invariant 4).
 * - **It reads only verified records** (invariant 1). A log that does not
 *   verify produces a refusal and no cards: a card is a statement to a human
 *   about what the log says, and one derived from a log the runtime disowns
 *   would be worse than no card at all.
 * - **It decides nothing and appends nothing.** No policy is resolved, no
 *   reaction is read, and no enforcement path consults anything here
 *   (invariant 10). The card is a rendering; the human's answer goes back
 *   through the human-only `reviewSample`.
 */

import { claimed, computed } from "../channels/contract.js";
import type { ReviewCard, ReviewCardFields } from "../channels/telegram.js";
import { openSamples, type SampledSubject } from "../core/audit.js";
import { indexDeclarations } from "../core/execute.js";
import type { EventRecord } from "../core/log.js";
import { loadPayload, payloadStoreDirFor } from "../core/payload-store.js";
import { payloadOf, readVerifiedRecords } from "../core/state.js";
import { commandBreakdown, commandPayloadView } from "../core/wysiwys.js";

/** Why a build of the review backlog produced nothing. */
export type ReviewCardRefusalCode = "log-unreadable" | "log-torn-tail" | "log-corrupt";

export type ReviewCardsResult =
  | { ok: true; cards: ReviewCard[] }
  | { ok: false; code: ReviewCardRefusalCode; message: string };

/** Where the payload bytes may be found, for the command breakdown. */
export interface ReviewCardOptions {
  /**
   * A caller's override for the payload store, with `TagOptions.payload`'s
   * semantics: action key and bound hash in, the value or `undefined` out.
   * Consulted before the store, exactly as the pending queue consults it, so a
   * test and an operator holding bytes elsewhere reach the same rendering.
   */
  payload?: (actionKey: string, payloadHash: string) => unknown;
  /** The payload store, or `null` for none. Defaults to the one beside the log. */
  payloadStoreDir?: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The actor that declared an action, per key: the `task.registered` record's
 * own, and failing that the `execution.started` that ran it.
 *
 * The author of a card's CLAIMED region, and it is read off who APPENDED a
 * record rather than out of a payload field, for the reason `humanFeedback`
 * gives about the same question: an actor is a property of the writer, and a
 * self-reported one would let the party under oversight choose whose claim the
 * approver is reading (SPEC.md §11.1 invariant 4).
 */
function authorsByKey(records: readonly EventRecord[]): Map<string, string> {
  const registered = new Map<string, string>();
  const executed = new Map<string, string>();
  for (const record of records) {
    const actor = typeof record.actor === "string" && record.actor.length > 0 ? record.actor : null;
    if (actor === null) continue;
    if (record.event === "task.registered") {
      const actions = payloadOf(record)["actions"];
      if (!Array.isArray(actions)) continue;
      for (const entry of actions) {
        if (typeof entry !== "object" || entry === null) continue;
        const key = (entry as Record<string, unknown>)["idempotency_key"];
        if (typeof key === "string" && key.length > 0) registered.set(key, actor);
      }
      continue;
    }
    if (record.event !== "execution.started") continue;
    const key = record.action_key;
    if (typeof key === "string" && key.length > 0 && !executed.has(key)) executed.set(key, actor);
  }
  for (const [key, actor] of executed) {
    if (!registered.has(key)) registered.set(key, actor);
  }
  return registered;
}

/**
 * The bytes the sampled execution bound to, when anybody holds them.
 *
 * `null` whenever they cannot be produced honestly: no recorded hash, no
 * override and no store, a store with no file, or a stored file that does not
 * hash to what the log recorded. The last case is the one worth naming — a
 * tampered `<hash>.json` yields NO breakdown rather than a breakdown of bytes
 * that are not the ones that ran, because a line describing the wrong command
 * is worse on a review card than an absent line.
 */
function materialFor(
  options: ReviewCardOptions,
  logPath: string,
  actionKey: string,
  boundHash: string | null,
): unknown {
  if (boundHash === null) return null;
  const supplied = options.payload?.(actionKey, boundHash);
  if (supplied !== undefined) return supplied;
  const storeDir =
    options.payloadStoreDir === undefined ? payloadStoreDirFor(logPath) : options.payloadStoreDir;
  if (storeDir === null) return null;
  const loaded = loadPayload(storeDir, boundHash);
  return loaded.ok ? loaded.value : null;
}

/**
 * What the runtime did at the time, in one computed line.
 *
 * The three facts a reviewer needs before they can say whether it should have
 * happened: that NOBODY was asked, which autonomy said so, and the rate the
 * draw was made at — all three read off the `audit.sampled` record the daemon
 * wrote, which states the number the verdict was compared against (APRV-183).
 * The outcome is appended when the log carries one; "not recorded" is the
 * honest answer for an execution whose end nothing wrote, and it is never
 * guessed at from the absence.
 */
function verdictLine(sample: Record<string, unknown>, outcome: string): string {
  const autonomy = stringOrNull(sample["autonomy"]) ?? "supervised";
  const rate = sample["rate"];
  const drawn =
    typeof rate === "number" ? `, drawn for review at rate ${String(rate)}` : ", drawn for review";
  return `allowed without asking (autonomy ${autonomy})${drawn} · outcome ${outcome}`;
}

/** How the log says the sampled execution ended, or that it does not say. */
function outcomeOf(records: readonly EventRecord[], actionKey: string, startSeq: number): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as EventRecord;
    if (record.seq <= startSeq || record.action_key !== actionKey) continue;
    if (record.event === "execution.completed") return "completed";
    if (record.event === "execution.failed") return "failed";
  }
  return "not recorded";
}

/**
 * One card for one open sample, or `null` when the log cannot describe it.
 *
 * A sample naming no action key, or an action key no `task.registered` record
 * declares, produces no card. That is the same refusal to guess `core/audit.ts`
 * makes when it selects candidates: a class nobody declared is a class the card
 * would have to invent, and a review card asserting an invented class is a
 * statement to a human that nothing in the log supports. Such a sample stays in
 * the backlog and is still answerable with `approval audit review`.
 */
function cardFor(
  records: readonly EventRecord[],
  subject: SampledSubject,
  authors: Map<string, string>,
  declarations: ReturnType<typeof indexDeclarations>["declarations"],
  logPath: string,
  options: ReviewCardOptions,
): ReviewCard | null {
  const actionKey = subject.actionKey;
  if (actionKey === null) return null;
  const declared = declarations.get(actionKey);
  if (declared === undefined) return null;

  const sampleRecord = records.find((record) => record.seq === subject.seq);
  const sample = sampleRecord === undefined ? {} : payloadOf(sampleRecord);
  const start =
    subject.subjectSeq === null
      ? undefined
      : records.find(
          (record) => record.seq === subject.subjectSeq && record.event === "execution.started",
        );
  const startPayload = start === undefined ? {} : payloadOf(start);
  const ranAt = start?.ts ?? stringOrNull(sample["subject_ts"]) ?? subject.ts;

  const material = materialFor(
    options,
    logPath,
    actionKey,
    stringOrNull(startPayload["payload_hash"]) ?? declared.payload_hash,
  );
  const command = material === null ? null : commandPayloadView(material);
  const breakdown = command === null ? null : commandBreakdown(command.command);

  const author = authors.get(actionKey) ?? "the requesting party";
  const fields: ReviewCardFields = {
    action_key: computed(actionKey, "log"),
    class: computed(declared.class, "log"),
    task: computed<string | null>(subject.task ?? declared.task, "log"),
    summary: claimed<string | null>(declared.summary, author),
    ...(breakdown === null ? {} : { command_breakdown: computed(breakdown, "classifier") }),
  };

  return {
    sampleSeq: subject.seq,
    fields,
    ranAtTs: ranAt,
    ranAt: computed(
      start === undefined
        ? `${ranAt} (the sample's record of when it started)`
        : `${ranAt} (execution.started at seq ${String(start.seq)})`,
      "log",
    ),
    verdict: computed(
      verdictLine(
        sample,
        start === undefined ? "not recorded" : outcomeOf(records, actionKey, start.seq),
      ),
      "log",
    ),
  };
}

/**
 * Every `audit.sampled` with no later `audit.reviewed`, as review cards, oldest
 * first.
 *
 * The same projection `approval audit list` and `.approval/QUEUE.md` read
 * (`openSamples`), so the phone, the file and the terminal cannot disagree
 * about what is outstanding. Reads a verified log and writes nothing anywhere.
 */
export function openReviewCards(
  logPath: string,
  options: ReviewCardOptions = {},
): ReviewCardsResult {
  const read = readVerifiedRecords(logPath);
  if (!read.ok) return { ok: false, code: read.code, message: read.message };

  const index = indexDeclarations(read.records);
  const authors = authorsByKey(read.records);
  const cards: ReviewCard[] = [];
  for (const subject of openSamples(read.records)) {
    const card = cardFor(
      read.records,
      subject,
      authors,
      index.declarations,
      logPath,
      options,
    );
    if (card !== null) cards.push(card);
  }
  return { ok: true, cards };
}
