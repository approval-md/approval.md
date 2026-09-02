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
 * refusal. The same bound and the same reasoning as `core/gate.ts`'s: a moved
 * head says the read was stale, never that the answer is no, and re-deriving
 * from a fresh verified read cannot launder a refusal into an allow.
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
   * closes nothing, and a bypass whose window lapsed mid-append says so rather
   * than recording a bypass nothing authorized.
   */
  "gate-not-open",
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

function attemptsOf(options: GateWindowOptions): number {
  const asked = options.retryOnHeadMoved;
  if (asked === undefined || !Number.isInteger(asked) || asked < 1) return HEAD_MOVED_ATTEMPTS;
  return Math.min(asked, HEAD_MOVED_ATTEMPTS);
}

function isHeadMoved(result: { ok: true } | GateWindowRefusal): boolean {
  return !result.ok && result.code === "append-failed" && result.append?.code === "head-moved";
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
}

/**
 * Record a bypassed tool call, BEFORE its allow is printed.
 *
 * The order is record-then-allow for the same reason `recordUnattended`'s is
 * (§11.1 invariant 8): a bypassed command that ran and left no record is the
 * one state this whole feature must not be able to reach, so an append failure
 * is the caller's deny.
 *
 * The window is re-derived on every attempt. A head that moved says the read
 * was stale, so the next attempt re-reads, re-derives, and appends against the
 * head it saw; a window that lapsed or was closed between attempts refuses
 * `gate-not-open` rather than recording a bypass nothing authorized.
 */
export function recordGateBypass(
  logPath: string,
  input: GateBypassInput,
  actor: string,
  options: GateWindowOptions = {},
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

  const attempts = attemptsOf(options);
  let result = attemptBypass(logPath, input, actor, options);
  for (let n = 1; n < attempts && isHeadMoved(result); n += 1) {
    result = attemptBypass(logPath, input, actor, options);
  }
  return result;
}

function attemptBypass(
  logPath: string,
  input: GateBypassInput,
  actor: string,
  options: GateWindowOptions,
): GateWindowResult | GateWindowRefusal {
  const read = readRecords(logPath, options.schemaDir);
  if (!read.ok) return read;

  const now = tick(options);
  const window = openGateWindow(read.records, millis(now) ?? Date.now());
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
