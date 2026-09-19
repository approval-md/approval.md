/**
 * What the log says when a decision surface refused a gesture that is not a
 * decision (APRV-355, amended SPEC.md §8).
 *
 * ## The fact this module is about
 *
 * Found while landing APRV-324 (PR #427, 2026-09-17). Once the policy maps
 * Telegram senders, a tap on a CHECKPOINT signature or on a REVIEW from an
 * account the attested policy names nobody for is refused before any verb runs
 * — and records nothing. The only refusal record in the system is
 * `audit.decision_refused`, and it requires a record-level `action_key` and a
 * `payload.decision` of grant, reject or revoke. A signature answers for a
 * chain head and a review answers for a sampled record; neither has either
 * field, so writing one of these there would mean manufacturing both. The lane
 * that found it declined to, correctly.
 *
 * The cost of recording nothing is the same cost `core/decision-refusal.ts`
 * exists to end. Somebody's attention was spent — SPEC.md §11 calls human
 * attention the audit budget — and an attempt was made from an account the
 * operator did not map, and the only trace is a line on a terminal and an
 * answer in a chat. An operator deciding whether to map that account has
 * nothing in the log to read.
 *
 * ## What this record is, and what it is not
 *
 * `audit.gesture_refused` is an AUDIT-TIER record on the strict terms
 * `audit.decision_refused` set, and the terms are the whole of its safety:
 *
 * - it grants nothing and mints no token;
 * - `core/state.ts` settles nothing on it, so no verdict moves;
 * - `core/budgets.ts` charges nothing for it, so no budget moves;
 * - `core/audit.ts` does not sample it and no streak counts it;
 * - NO ENFORCEMENT PATH READS IT. `tests/gesture-refusal.test.ts` pins that by
 *   reading the module graph rather than by asserting an intention.
 *
 * The record's own actor is `system:`, for the reason `audit.dark_session`'s
 * and `audit.decision_refused`'s are: this is the runtime's statement about a
 * refusal the runtime made, and a record of a refusal authored by either party
 * to it is a record neither party can be held to. The person, when the runtime
 * can name one, is the SUBJECT and sits in the payload.
 *
 * ## The asymmetry it inherits
 *
 * Refusals handed to AGENTS stay unlogged here too. An agent that is refused
 * reads the code, stops or asks again, and nothing was spent that a record
 * could account for. And a gesture is human by construction: an agent has no
 * checkpoint to sign and no review to give.
 *
 * ## No attestation check, deliberately
 *
 * Nothing here asks whether the policy is attested, for the reason
 * `core/decision-refusal.ts` does not: this write confers no authority.
 * Refusing to record a refusal because a file changed would be the strict
 * direction pointing the wrong way, and the case where it would bite hardest is
 * `policy-not-attested` itself — exactly the refusal an operator most needs the
 * log to remember. The write boundary still validates every record.
 *
 * ## Invariants
 *
 * - **Gate-typed events never accept caller timestamps** (§11.1). `ts` comes
 *   from the injected clock at the write boundary; there is no parameter.
 * - **Every check-then-append passes through compare-and-append** (§11.1(5)).
 *   The write states the head it was derived against and the whole cycle
 *   re-enters from a fresh read on `head-moved` through {@link withHeadRetry}.
 * - **Self-reported fields never reduce scrutiny** (§11.1). Everything here
 *   only ADDS to what a reviewer sees. The sender is the transport's own
 *   attribution, never anything the message claimed about itself.
 * - **Refusals stay machine-readable and distinct** (§11.1). The surface's code
 *   is copied verbatim; nothing here invents, merges or softens one.
 */

import { tick } from "./clock.js";
import { attemptsOf, withHeadRetry } from "./head-retry.js";
import { appendEvent, type AppendError, type EventRecord, type LogHead } from "./log.js";
import { readVerifiedRecords } from "./state.js";
import type { GateOptions } from "./gate.js";
import type { RecordedSender, SenderSource } from "./sender-identity.js";

/** The actor every record here carries: the gate stating what the gate did. */
export const GESTURE_REFUSAL_ACTOR = "system:gate";

/**
 * The gestures this record can be about. **Closed and additive-only** (§11.1
 * invariant 6), and pinned against the event schema's own enum by
 * `tests/gesture-refusal.test.ts`: a kind the sweep can produce and the write
 * boundary refuses is an observation that never reaches a human, which is the
 * failure APRV-358 named a few hours before this task.
 *
 * `review` and `review-note` are two members rather than one because a note is
 * attention spent WRITING rather than attention spent tapping, and an operator
 * reading this record to decide whether to map an account wants to know which
 * they lost.
 */
export const REFUSED_GESTURES = ["checkpoint-signature", "review", "review-note"] as const;

export type RefusedGestureKind = (typeof REFUSED_GESTURES)[number];

/**
 * The refusals a gesture can meet before any verb runs. **Closed**, and exactly
 * what sender resolution can answer: `sender-unmapped`, `sender-ambiguous` and
 * `sender-key-unavailable` from `core/sender-identity.ts`'s own union, and
 * `policy-not-attested` from `core/attest.ts`, which fires when the policy
 * declaring the mapping is not the attested one and is therefore not in force.
 *
 * `attest-requires-terminal` is deliberately absent: it belongs to an
 * attestation tap, which is a decision and is recorded as one.
 */
export const REFUSED_GESTURE_CODES = [
  "sender-unmapped",
  "sender-ambiguous",
  // APRV-370. A keyed mapping this process holds no key for: the runtime could
  // resolve no account at all, which is a different fact from "this account is
  // not mapped" and wants a different repair.
  "sender-key-unavailable",
  "policy-not-attested",
] as const;

export type RefusedGestureCode = (typeof REFUSED_GESTURE_CODES)[number];

/** Is `code` one this record can carry? Used where a code arrives as a string. */
export function isRefusedGestureCode(code: string): code is RefusedGestureCode {
  return (REFUSED_GESTURE_CODES as readonly string[]).includes(code);
}

/** What was attempted, by whom, on which surface. */
export interface RefusedGesture {
  /** Which gesture. */
  gesture: RefusedGestureKind;
  /**
   * The person, `human:<id>`, when the surface could name one.
   *
   * `null` for the refusal where it could not: a transport authenticated an
   * account the attested policy binds to nobody. The record then carries
   * {@link RefusedGesture.sender} and no `actor`, and the event schema requires
   * one or the other.
   */
  actor: string | null;
  /** The surface that collected the gesture: `telegram`, `web`, `cli`. */
  channel: string;
  /**
   * The authenticated sender it arrived from, when the surface observed one,
   * in the form the record carries it (APRV-370: raw, or the keyed digest).
   */
  sender?: RecordedSender;
  /** How the sender became the actor, when one did. */
  senderSource?: SenderSource;
}

/** The refusal being recorded. Only these fields are ever read. */
export interface GestureRefusalFacts {
  /** The surface's code, verbatim. */
  code: string;
  /** The surface's message, verbatim. */
  message: string;
}

/** What the module could not do. Never thrown; the caller carries on regardless. */
export interface GestureRefusalFailure {
  ok: false;
  code: "log-unreadable" | "append-failed";
  message: string;
  append?: AppendError;
}

export type RecordRefusedGestureResult =
  | {
      ok: true;
      /** The record, or `null` when there was nothing to record. */
      audit: EventRecord | null;
    }
  | GestureRefusalFailure;

/** The gestures this module records: a person's, and nobody else's. */
const HUMAN_ACTOR = /^human:.+/u;

/**
 * Record that a human's gesture was refused.
 *
 * Called by the surface that collected the gesture, on the branch where it
 * refused — never from inside the verb the gesture would have reached, which is
 * never called at all on this path.
 *
 * Best-effort by design: a failure here is returned, never thrown, and the
 * caller shows the refusal either way. The gesture was already refused before
 * this ran, and nothing about that outcome depends on this write landing.
 *
 * Two cases append nothing, and both are the honest answer rather than a
 * silence:
 *
 * - a non-human actor, which is the misconfigured-surface case: nobody's
 *   attention was spent, so there is no spend for a record to account for;
 * - a code this record cannot carry, which means a surface refused for a reason
 *   this vocabulary does not name. Minting a member here to fit it would widen
 *   a closed union at the write boundary from inside a best-effort path.
 */
export function recordRefusedGesture(
  logPath: string,
  gesture: RefusedGesture,
  refusal: GestureRefusalFacts,
  options: GateOptions = {},
): RecordRefusedGestureResult {
  if (gesture.actor !== null && !HUMAN_ACTOR.test(gesture.actor)) {
    return { ok: true, audit: null };
  }
  // No person and no account is nothing to say: the record would name neither
  // the subject nor the reason it could not, and the schema refuses it.
  if (gesture.actor === null && gesture.sender === undefined) {
    return { ok: true, audit: null };
  }
  if (!isRefusedGestureCode(refusal.code)) return { ok: true, audit: null };

  const appended = withHeadRetry(attemptsOf(options.retryOnHeadMoved), () =>
    appendAudit(logPath, gesture, refusal, options),
  );
  return appended.ok ? { ok: true, audit: appended.record } : appended;
}

type AppendOutcome = { ok: true; record: EventRecord } | GestureRefusalFailure;

/** The whole cycle: a fresh read for the head, then one append against it. */
function appendAudit(
  logPath: string,
  gesture: RefusedGesture,
  refusal: GestureRefusalFacts,
  options: GateOptions,
): AppendOutcome {
  const ts = tick(options);
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) {
    return { ok: false, code: "log-unreadable", message: read.message };
  }

  const payload: Record<string, unknown> = {
    ...(gesture.actor === null ? {} : { actor: gesture.actor }),
    gesture: gesture.gesture,
    code: refusal.code,
    message: refusal.message,
  };
  if (gesture.sender !== undefined) {
    payload["sender"] = {
      channel: gesture.sender.channel,
      id: gesture.sender.id,
      // APRV-370: only when true, so a raw record does not change shape.
      ...(gesture.sender.hashed === true ? { hashed: true } : {}),
    };
    if (gesture.senderSource !== undefined) payload["sender_source"] = gesture.senderSource;
  }

  return appendOne(
    logPath,
    { ts, actor: GESTURE_REFUSAL_ACTOR, channel: gesture.channel, payload },
    options,
    read.head,
  );
}

function appendOne(
  logPath: string,
  input: { ts: string; actor: string; channel: string; payload: Record<string, unknown> },
  options: GateOptions,
  expectedHead: LogHead | null,
): AppendOutcome {
  const append = { ...options.append };
  if (options.schemaDir !== undefined) append.schemaDir = options.schemaDir;
  const result = appendEvent(
    logPath,
    { ...input, event: "audit.gesture_refused" },
    { ...append, expectedHead },
  );
  if (result.ok) return { ok: true, record: result.record };
  return {
    ok: false,
    code: "append-failed",
    message: `audit.gesture_refused could not be appended: ${result.error.message}`,
    append: result.error,
  };
}
