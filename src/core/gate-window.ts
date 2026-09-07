/**
 * The open window (amended SPEC.md §5.2, APRV-214): a human-only, time-boxed
 * suspension of the harness gate's POLICY, so the gate can be debugged from
 * inside a session it would otherwise refuse everything to.
 *
 * ## Why this exists
 *
 * `cli/hook.ts` fails closed on every axis, which is right, and which means the
 * moment the gate itself is broken (an unattested policy, a drifted
 * attestation, a hung daemon, a dark channel) every command a session issues
 * dies, including the ones a person would use to repair it. The only escape
 * before this was hand-editing the hook out of `.claude/settings.json`: an
 * ungated session nobody records, which is the exact failure this project
 * exists to prevent.
 *
 * ## Where the state lives, and why it lives there
 *
 * In the log, as `gate.opened` / `gate.closed`, and NOWHERE else. The
 * `.approval/env` precedent (`cli/init.ts`) states the rule this follows: a
 * file the runtime reads on its own authority lets anything able to write that
 * file act as the human. A window flag in a dotfile would be exactly that, and
 * an agent that can write files is the party the window is a bypass for.
 *
 * The consequence is deliberate and is the property that keeps this safe: a log
 * the hook cannot read, or cannot verify, yields NO window and the hook denies
 * as it always did. The window suspends the policy; it never suspends the log.
 *
 * ## What is derived rather than written
 *
 * Nothing is appended when a window lapses. A reader derives the window from
 * the latest `gate.opened`: it is open when no `gate.closed` names its seq and
 * the moment of asking is before its expiry. Expiry is `ts` plus `duration`,
 * both of which are on the record, and the runtime authored the `ts` at the
 * write boundary (`core/clock.ts`), so an opener cannot author the length of
 * their own window. `expires_at` rides along for a human reading the log; a
 * record claiming one BEYOND `ts + duration` reads as the shorter of the two,
 * and a duration over {@link MAX_WINDOW_MS} is clamped at read time as well as
 * refused at write time. Every path through this file resolves an ambiguity by
 * shortening the window, never by lengthening it.
 *
 * ## What this module does not do
 *
 * It does not decide anything about a command. The hook classifies inside an
 * open window exactly as it does outside one, still denies `log.mutate`, still
 * denies every class the policy reserves to human hands, and still denies a
 * command the classifier cannot read. All this module offers is the derived
 * window and the three appends, each through `core/log.ts`'s `appendEvent` with
 * a compare-and-append precondition (§11.1 invariant 5).
 *
 * `core/gate.ts`'s `startHarnessExecution` is deliberately NOT reused for the
 * bypass record: it refuses on an unattested policy, on manual, on the loop
 * floor and on budget, which are the very things being bypassed. What is reused
 * is the mechanism, `appendEvent` with `expectedHead` under a head-moved retry.
 */

import { tick, type ClockOptions } from "./clock.js";
import { type HarnessProvenance } from "./harness-version.js";
import { attemptsOf, withHeadRetry } from "./head-retry.js";
import {
  appendEvent,
  type AppendError,
  type AppendOptions,
  type EventRecord,
} from "./log.js";
import { parseDuration } from "./policy-load.js";
import { readVerifiedRecords } from "./state.js";

/** What an open window suspends. One value at v0.1, matching the schema enum. */
export const GATE_WINDOW_SCOPE = "hook";

/** The duration `approval gate open` uses when none is asked for. */
export const DEFAULT_WINDOW = "30m";

/**
 * The longest window anyone may open, enforced at BOTH ends: `openWindow`
 * refuses a longer one, and {@link openGateWindow} clamps a record claiming one
 * so that a hand-written `gate.opened` buys no more time than the ceremony
 * would have granted.
 *
 * A day, because the window's purpose is one debugging session and because a
 * bypass that outlives the person's attention is a bypass nobody is watching.
 */
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * How many times a bypass append re-derives its window after a `head-moved`
 * refusal. The same reasoning as `core/head-retry.ts`'s, whose helper performs
 * the loop: a moved head says the read was stale, never that the answer is no,
 * and re-deriving from a fresh verified read cannot launder a refusal into an
 * allow.
 *
 * One attempt more than the gate writers' three, and deliberately so: a bypass
 * record is what lets a session run a command at all while the gate is being
 * repaired, and the log it is contending with is the busy one that made the
 * repair necessary.
 */
const HEAD_MOVED_ATTEMPTS = 4;

/** Actors permitted to open or close a window. Narrower than the event schema. */
const HUMAN_ACTOR = /^human:.+/u;

/** Actors a bypass record may name: whoever the harness was running as. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

/**
 * The verb-level refusal codes of the open window. **Frozen union**, in the
 * same sense as `GATE_REFUSAL_CODES`, `EXECUTION_REFUSAL_CODES`,
 * `AUDIT_REFUSAL_CODES`, `DARK_SESSION_CODES` and `HOOK_DENY_CODES`: a caller
 * branches on these, so members are added and never repurposed (SPEC.md §11.1
 * invariant 6, which this makes the sixth such union).
 *
 * Every one of them appends nothing.
 */
export const GATE_WINDOW_REFUSAL_CODES = [
  /**
   * The actor is not `human:`-prefixed. Opening a window is the one act that
   * suspends the policy, so an agent able to perform it could authorize its own
   * next command. Refused here in code, and again in `event.schema.json`.
   */
  "actor-not-human",
  /** No reason was given. A bypass nobody stated a reason for cannot be reviewed. */
  "gate-reason-required",
  /**
   * The duration is over {@link MAX_WINDOW_MS}, zero, negative, or unreadable.
   * One code for the family because the repair is one sentence: ask for a
   * shorter window, spelled the way SPEC.md §5.2 spells durations.
   */
  "gate-duration-too-long",
  /** A window is already open. Close it, or wait for it to lapse. */
  "gate-already-open",
  /**
   * No window is open. `close` says so rather than appending a record that
   * closes nothing, and a bypass asked for with no window behind it at all says
   * so rather than recording a bypass nothing authorized.
   */
  "gate-not-open",
  /**
   * The window a caller DECIDED under is gone by the time the bypass is
   * recorded (APRV-294).
   *
   * Distinct from `gate-not-open`, and the difference is the fact each states.
   * That one says there was no window to begin with, which is the ordinary
   * closed gate. This one says a window stood when the verdict was formed and
   * does not stand at the append: a human closed it, it lapsed, or a later
   * `gate.opened` superseded the one the caller named. The refusal names the
   * `gate.closed` seq that ended it, or the expiry it ran past, so a reviewer
   * holding the log alone can place the boundary.
   *
   * The repair is a retry, and it is a retry of an ordinary gated tool call:
   * nothing is appended here, nothing ran, and the next invocation derives the
   * window from its own read and is answered by the policy where there is none.
   * A refusal on this path is therefore not a failed execution and accrues no
   * loop-safety streak (SPEC.md §10.2), because no execution was started for it.
   */
  "gate-window-closed",
  /**
   * Stdin is not a terminal (or `--json` was asked for). The ceremony is a
   * person typing a word, and a prompt a pipe could answer is a ceremony a
   * harness shell tool can perform.
   */
  "gate-stdin-not-tty",
  /** The typed confirmation was not exactly `understood`. Includes EOF. */
  "gate-confirmation-mismatch",
  /** The log could not be opened. */
  "log-unreadable",
  /** The log's last line is truncated: a crashed write, repaired by a human. */
  "log-torn-tail",
  /** The chain does not verify, so no window may be derived from it. */
  "log-corrupt",
  /** The append itself was refused; `append` carries the writer's own code. */
  "append-failed",
] as const;

export type GateWindowRefusalCode = (typeof GATE_WINDOW_REFUSAL_CODES)[number];

/** A refusal from this module. Nothing was appended. */
export interface GateWindowRefusal {
  ok: false;
  code: GateWindowRefusalCode;
  message: string;
  /** The underlying writer error, when `code` is `append-failed`. */
  append?: AppendError;
}

/** An open window, as derived from the log. */
export interface OpenWindow {
  /** The `seq` of the `gate.opened` record. Every bypass names it. */
  seq: number;
  /** The runtime-stamped instant the window opened. */
  openedAt: string;
  /** The human who opened it. */
  openedBy: string;
  /** Why, in their words. */
  reason: string;
  /** The effective length, after the {@link MAX_WINDOW_MS} clamp. */
  durationMs: number;
  /** The effective expiry: the earlier of `ts + duration` and the claim. */
  expiresAt: string;
  /** How many `gate.bypassed` records name this window so far. */
  bypassCount: number;
}

/** A successful append, with the window the caller may now report. */
export interface GateWindowResult {
  ok: true;
  record: EventRecord;
  window: OpenWindow;
}

/** A successful close: the record, and the window it ended. */
export interface GateCloseResult {
  ok: true;
  record: EventRecord;
  closed: OpenWindow;
}

/** Options every write here accepts: the injected clock, plus append tuning. */
export interface GateWindowOptions extends ClockOptions {
  schemaDir?: string;
  append?: AppendOptions;
  /** Lowers the head-moved attempt bound; never raises it. */
  retryOnHeadMoved?: number;
}

// ---------------------------------------------------------------------------
// Derivation (pure)
// ---------------------------------------------------------------------------

function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = (record as { payload?: unknown }).payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function seqField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Milliseconds of an RFC 3339 instant, or `null` when it does not parse. */
function millis(text: string): number | null {
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The window open at `now`, or `null`.
 *
 * Pure over the records it is given, so every caller (the hook, the CLI verb,
 * `approval status`) derives the same fact from the same log and none of them
 * reads a clock of its own.
 *
 * Only the LATEST `gate.opened` is considered. An older one that was never
 * closed is not a second window: the ceremony refuses to open a second while
 * one stands, so an unclosed older record is either lapsed or superseded, and
 * treating it as live would let a stale record outlive the window a human
 * actually opened.
 *
 * Every ambiguity resolves closed. An unreadable duration, a missing reason, a
 * `ts` that does not parse: each yields `null` rather than a window nobody can
 * state the bounds of.
 */
export function openGateWindow(
  records: readonly EventRecord[],
  now: Date | number = Date.now(),
): OpenWindow | null {
  const nowMs = typeof now === "number" ? now : now.getTime();

  let opened: EventRecord | null = null;
  for (const record of records) {
    if (record.event === "gate.opened") opened = record;
  }
  if (opened === null) return null;

  // A close naming this opening ends it, wherever in the log it sits.
  for (const record of records) {
    if (record.event !== "gate.closed") continue;
    if (seqField(payloadOf(record), "opened_seq") === opened.seq) return null;
  }

  const payload = payloadOf(opened);
  const reason = stringField(payload, "reason");
  const durationText = stringField(payload, "duration");
  if (reason === null || durationText === null) return null;
  if (stringField(payload, "scope") !== GATE_WINDOW_SCOPE) return null;

  const asked = parseDuration(durationText);
  if (asked === null || asked <= 0) return null;
  // The clamp at READ time, not only at write time: a `gate.opened` that
  // reached the log by some other route may claim a week, and it buys a day.
  const durationMs = Math.min(asked, MAX_WINDOW_MS);

  const openedMs = millis(opened.ts);
  if (openedMs === null) return null;

  // The shorter of the two, always. `ts + duration` is what the runtime
  // authored; `expires_at` is a claim, and a claim may only shorten.
  const derived = openedMs + durationMs;
  const claimedText = stringField(payload, "expires_at");
  const claimed = claimedText === null ? null : millis(claimedText);
  const expiresMs = claimed === null ? derived : Math.min(derived, claimed);
  if (nowMs >= expiresMs) return null;

  let bypassCount = 0;
  for (const record of records) {
    if (record.event !== "gate.bypassed") continue;
    if (seqField(payloadOf(record), "opened_seq") === opened.seq) bypassCount += 1;
  }

  return {
    seq: opened.seq,
    openedAt: opened.ts,
    openedBy: opened.actor,
    reason,
    durationMs,
    expiresAt: new Date(expiresMs).toISOString(),
    bypassCount,
  };
}

/** Milliseconds left on a window at `now`, floored at zero. */
export function remainingMs(window: OpenWindow, now: Date | number = Date.now()): number {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const expiry = millis(window.expiresAt);
  if (expiry === null) return 0;
  return Math.max(0, expiry - nowMs);
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function refuse(
  code: GateWindowRefusalCode,
  message: string,
  append?: AppendError,
): GateWindowRefusal {
  return append === undefined ? { ok: false, code, message } : { ok: false, code, message, append };
}

/** The verified read every operation here starts from, as a refusal or records. */
type WindowRead =
  | { ok: true; records: EventRecord[]; head: { seq: number; hash: string } | null }
  | GateWindowRefusal;

function readRecords(logPath: string, schemaDir: string | undefined): WindowRead {
  const read = readVerifiedRecords(
    logPath,
    schemaDir === undefined ? {} : { schemaDir },
  );
  if (read.ok) return { ok: true, records: read.records, head: read.head };
  // The reader's three codes are this union's three codes, spelled identically:
  // a caller that knows one vocabulary knows both, and nothing is flattened.
  return refuse(read.code, read.message);
}

function appendOptionsOf(
  options: GateWindowOptions,
  head: { seq: number; hash: string } | null,
): AppendOptions {
  return {
    ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
    ...options.append,
    expectedHead: head,
  };
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/** What `approval gate open` asks for, already parsed by its caller. */
export interface OpenWindowInput {
  /** The duration as typed (`30m`), recorded verbatim on the event. */
  durationText: string;
  /** The same duration in milliseconds, as the caller parsed it. */
  durationMs: number;
  /** Why the window is being opened. */
  reason: string;
}

/**
 * Append `gate.opened`, after establishing that the actor is a human, the
 * duration is inside the cap, and no window is already open.
 *
 * One `tick()` supplies BOTH the record's `ts` and its `expires_at`, so the two
 * cannot disagree by a scheduling delay and the derived expiry is exactly the
 * claimed one on a record this runtime wrote.
 */
export function openWindow(
  logPath: string,
  input: OpenWindowInput,
  actor: string,
  options: GateWindowOptions = {},
): GateWindowResult | GateWindowRefusal {
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `opening the gate requires a human actor matching ^human:.+, got ${JSON.stringify(actor)}; this is the one act that suspends the policy, so an agent must not perform it, and the log was left unchanged`,
    );
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return refuse(
      "gate-reason-required",
      "a window needs a reason (--reason): a bypass nobody stated a reason for is a bypass nobody can review, and the log was left unchanged",
    );
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    return refuse(
      "gate-duration-too-long",
      `--for ${JSON.stringify(input.durationText)} is not a positive duration; use a SPEC.md §5.2 duration such as 5m, 30m or 2h`,
    );
  }
  if (input.durationMs > MAX_WINDOW_MS) {
    return refuse(
      "gate-duration-too-long",
      `--for ${JSON.stringify(input.durationText)} is longer than the 24h cap: a bypass that outlives the attention of the person who opened it is a bypass nobody is watching. Ask for a shorter window`,
    );
  }

  const read = readRecords(logPath, options.schemaDir);
  if (!read.ok) return read;

  const now = tick(options);
  const nowMs = millis(now) ?? Date.now();
  const standing = openGateWindow(read.records, nowMs);
  if (standing !== null) {
    return refuse(
      "gate-already-open",
      `a window opened by ${standing.openedBy} at seq ${String(standing.seq)} is already open until ${standing.expiresAt}; close it with \`approval gate close\` or wait for it to lapse. Nothing was appended`,
    );
  }

  const expiresAt = new Date(nowMs + input.durationMs).toISOString();
  const appended = appendEvent(
    logPath,
    {
      ts: now,
      event: "gate.opened",
      actor,
      channel: "cli",
      payload: {
        expires_at: expiresAt,
        duration: input.durationText,
        reason,
        scope: GATE_WINDOW_SCOPE,
      },
    },
    appendOptionsOf(options, read.head),
  );
  if (!appended.ok) {
    return refuse(
      "append-failed",
      `the window was not opened: ${appended.error.code}: ${appended.error.message}`,
      appended.error,
    );
  }

  return {
    ok: true,
    record: appended.record,
    window: {
      seq: appended.record.seq,
      openedAt: appended.record.ts,
      openedBy: actor,
      reason,
      durationMs: input.durationMs,
      expiresAt,
      bypassCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

/**
 * Append `gate.closed` for whatever window stands.
 *
 * No confirmation anywhere on this path: closing only ever TIGHTENS, and a
 * ceremony guarding the safe direction is a ceremony people learn to type past.
 */
export function closeWindow(
  logPath: string,
  actor: string,
  options: GateWindowOptions & { note?: string } = {},
): GateCloseResult | GateWindowRefusal {
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `closing the gate requires a human actor matching ^human:.+, got ${JSON.stringify(actor)}; the pair is one ceremony and both halves are the human's. The log was left unchanged`,
    );
  }

  const read = readRecords(logPath, options.schemaDir);
  if (!read.ok) return read;

  const now = tick(options);
  const standing = openGateWindow(read.records, millis(now) ?? Date.now());
  if (standing === null) {
    return refuse(
      "gate-not-open",
      "no window is open, so there is nothing to close; a lapsed window appends nothing when it lapses and needs no closing record. The log was left unchanged",
    );
  }

  const note = options.note?.trim();
  const appended = appendEvent(
    logPath,
    {
      ts: now,
      event: "gate.closed",
      actor,
      channel: "cli",
      payload: {
        opened_seq: standing.seq,
        ...(note === undefined || note.length === 0 ? {} : { note }),
      },
    },
    appendOptionsOf(options, read.head),
  );
  if (!appended.ok) {
    return refuse(
      "append-failed",
      `the window was not closed and is still open until ${standing.expiresAt}: ${appended.error.code}: ${appended.error.message}`,
      appended.error,
    );
  }

  return { ok: true, record: appended.record, closed: standing };
}

// ---------------------------------------------------------------------------
// bypass
// ---------------------------------------------------------------------------

/** One gated tool call the hook is about to allow because a window is open. */
export interface GateBypassInput {
  /** The harness tool the call came through. */
  tool: string;
  /** The one-line headline, already truncated to the hook's `SUMMARY_LIMIT`. */
  summary: string;
  /** The classes the command resolved to. At least one. */
  classes: readonly string[];
  /** The `payload_hash` of the binding bytes. */
  payloadHash: string;
  sessionId?: string;
  toolUseId?: string;
  cwd?: string;
  /**
   * Which harness binary is printing the allow, and at what version (APRV-227).
   *
   * Derived by the hook process from its own event and its own PATH and handed
   * in here; copied into the payload verbatim when present, omitted entirely
   * when absent. Nothing reads it back — the window was authorized by a human's
   * `gate.opened` and this pair moves no part of that (SPEC.md §11.1 invariant
   * 4, and `core/harness-version.ts`'s header). What it does is let a reviewer
   * of a bypass see which binary was standing in front of the gate at the time,
   * which on this path is the record a human actually goes back and reads.
   */
  harness?: HarnessProvenance;
}

/**
 * The window verdict a caller already reached, handed to the append that
 * records it (APRV-294).
 *
 * ## Why the append takes the caller's read
 *
 * On 2026-09-07 two hook invocations disagreed about one window inside a
 * minute: the first decided "open" from its own verified read and took the
 * bypass path, and the append re-read, derived no window from the fresher
 * bytes, and refused `gate-not-open`. Both reads were honest and the pair was
 * not: the verdict was formed on one view of the log and acted on another, and
 * the refusal named a state ("no window is open") that had never been true for
 * the invocation being refused.
 *
 * So the decision travels with the write. `read` is the verified read the
 * caller derived its window from, used by the FIRST append attempt, which makes
 * the decision and the record one read rather than two. `openedSeq` is the
 * window that decision named, and it outlives the seed: a `head-moved` retry
 * re-reads (it must — the head it would chain onto has moved), and the window
 * it then derives is compared against this seq, so a window that ended in
 * between refuses {@link GATE_WINDOW_REFUSAL_CODES}'s `gate-window-closed`
 * naming what ended it rather than the bare `gate-not-open`.
 *
 * Nothing here reads unverified bytes as verified: `read` is the caller's own
 * verified read, and every retry past the first performs its own (§11.1
 * invariant 1).
 */
export interface GateBypassDecision {
  /** The `seq` of the `gate.opened` the caller's verdict was decided under. */
  openedSeq: number;
  /** The verified read that verdict was formed on. The first attempt uses it. */
  read?: { records: readonly EventRecord[]; head: { seq: number; hash: string } | null };
}

/**
 * Record a bypassed tool call, BEFORE its allow is printed.
 *
 * The order is record-then-allow for the same reason `recordUnattended`'s is
 * (§11.1 invariant 8): a bypassed command that ran and left no record is the
 * one state this whole feature must not be able to reach, so an append failure
 * is the caller's deny.
 *
 * The window is re-derived on every attempt past the first. A head that moved
 * says the read was stale, so the next attempt re-reads, re-derives, and appends
 * against the head it saw; a window that lapsed or was closed refuses rather
 * than recording a bypass nothing authorized. Which refusal depends on what the
 * caller stated: with a {@link GateBypassDecision} in hand the refusal is
 * `gate-window-closed` and names the record or the expiry that ended the window,
 * and with none it is the historical `gate-not-open`.
 */
export function recordGateBypass(
  logPath: string,
  input: GateBypassInput,
  actor: string,
  options: GateWindowOptions = {},
  decided?: GateBypassDecision,
): GateWindowResult | GateWindowRefusal {
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `a bypass record must name the principal the harness ran as, matching ^(human|agent):.+, got ${JSON.stringify(actor)}; the log was left unchanged`,
    );
  }
  if (input.classes.length === 0) {
    return refuse(
      "gate-not-open",
      "a bypass record must name at least one class: a call with no class is the gate's own CLI, which the window has nothing to say about",
    );
  }

  // The one implementation, shared with `core/gate.ts` and `core/execute.ts`
  // since APRV-236. The ceiling stays this module's own — a bypass append is
  // the record that lets a debugging session run at all, so it is worth one
  // more attempt than the gate's writers get — and the mechanism is no longer
  // a second copy of the loop.
  //
  // APRV-294: the caller's read seeds the FIRST attempt and no other. A
  // `head-moved` retry exists precisely because the head it was going to chain
  // onto has moved, so re-using the stale read would be appending against a
  // precondition already known to be wrong.
  let seed = decided?.read;
  return withHeadRetry(attemptsOf(options.retryOnHeadMoved, HEAD_MOVED_ATTEMPTS), () => {
    const use = seed;
    seed = undefined;
    return attemptBypass(logPath, input, actor, options, decided?.openedSeq ?? null, use);
  });
}

/**
 * The window a caller decided under is not the window the log now shows
 * (APRV-294): say which of the three ways it ended, naming the record or the
 * instant that ended it.
 *
 * Every branch appends nothing and every branch is the same verdict for the
 * caller (deny, and retry through the ordinary gated path). What differs is the
 * fact stated, and the fact is what a reviewer holding the log needs: a close is
 * a person's act with a seq, a lapse is arithmetic over the opening record, and
 * a supersession is a second window somebody opened.
 */
function windowEnded(
  records: readonly EventRecord[],
  openedSeq: number,
  standing: OpenWindow | null,
): GateWindowRefusal {
  const retry =
    "Nothing was appended and nothing ran, so this refusal is not a failed execution and accrues no loop-safety streak (SPEC.md §10.2); run the command again and it is answered by the policy, or by whatever window stands then.";

  for (const record of records) {
    if (record.event !== "gate.closed") continue;
    if (seqField(payloadOf(record), "opened_seq") !== openedSeq) continue;
    return refuse(
      "gate-window-closed",
      `the window opened at seq ${String(openedSeq)} was closed by ${record.actor} at gate.closed seq ${String(record.seq)}, between the read this call's verdict was decided on and the record that would have authorized it. ${retry}`,
    );
  }

  if (standing !== null) {
    return refuse(
      "gate-window-closed",
      `the window opened at seq ${String(openedSeq)} is no longer the standing one: a later window (seq ${String(standing.seq)}, opened by ${standing.openedBy}) supersedes it, and a bypass records the window it was decided under or none at all. ${retry}`,
    );
  }

  for (const record of records) {
    if (record.seq !== openedSeq) continue;
    const claimed = stringField(payloadOf(record), "expires_at");
    return refuse(
      "gate-window-closed",
      `the window opened at seq ${String(openedSeq)} lapsed${claimed === null ? "" : ` (expiry ${claimed})`} between the read this call's verdict was decided on and the record that would have authorized it; a lapse appends nothing when it arrives, which is why the log names no closing record. ${retry}`,
    );
  }

  return refuse(
    "gate-window-closed",
    `the verified log carries no gate.opened at seq ${String(openedSeq)}, so the window this call's verdict was decided under cannot be established from the records the append read. ${retry}`,
  );
}

function attemptBypass(
  logPath: string,
  input: GateBypassInput,
  actor: string,
  options: GateWindowOptions,
  /** The window the caller decided under, or `null` when it stated none. */
  openedSeq: number | null,
  /** That decision's own verified read, on the first attempt only. */
  seed: GateBypassDecision["read"],
): GateWindowResult | GateWindowRefusal {
  const read =
    seed === undefined
      ? readRecords(logPath, options.schemaDir)
      : ({ ok: true, records: [...seed.records], head: seed.head } as WindowRead);
  if (!read.ok) return read;

  const now = tick(options);
  const window = openGateWindow(read.records, millis(now) ?? Date.now());
  if (openedSeq !== null && (window === null || window.seq !== openedSeq)) {
    // APRV-294. The caller reached a verdict under a named window, and these
    // records do not carry it: say which window ended and how, rather than
    // reporting the absence of any window at all.
    return windowEnded(read.records, openedSeq, window);
  }
  if (window === null) {
    return refuse(
      "gate-not-open",
      "no window is open, so nothing may be bypassed; the hook denies as it does with no window at all. The log was left unchanged",
    );
  }

  const appended = appendEvent(
    logPath,
    {
      ts: now,
      event: "gate.bypassed",
      actor,
      payload: {
        opened_seq: window.seq,
        tool: input.tool,
        summary: input.summary,
        classes: [...input.classes],
        payload_hash: input.payloadHash,
        ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
        ...(input.toolUseId === undefined ? {} : { tool_use_id: input.toolUseId }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        // APRV-227: both halves or neither.
        ...(input.harness === undefined
          ? {}
          : {
              harness: input.harness.harness,
              harness_version: input.harness.harness_version,
            }),
      },
    },
    appendOptionsOf(options, read.head),
  );
  if (!appended.ok) {
    return refuse(
      "append-failed",
      `the bypass was not recorded, so nothing may run: ${appended.error.code}: ${appended.error.message}`,
      appended.error,
    );
  }

  return {
    ok: true,
    record: appended.record,
    window: { ...window, bypassCount: window.bypassCount + 1 },
  };
}
