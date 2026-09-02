/**
 * The journal — an ungated, local, free-text channel an agent can always reach
 * (APRV-195).
 *
 * Everything else in this runtime exists to make an agent's actions answerable
 * to a person: declared before they happen, classified, resolved against a
 * policy, recorded in a chain nobody can rewrite. That machinery is deliberately
 * hard to route around, and one consequence of building it well is that an agent
 * working behind it has no way to say anything that is not an action. It can
 * comply, it can be refused, and it can report an exit code. It cannot say "I am
 * doing this and I think it is wrong", "this instruction reads as odd to me", or
 * "I am stuck and the next thing I try will be a guess".
 *
 * This module is that sentence, and nothing more. The failure mode it addresses
 * is not refusal — refusals here are legible, coded, and carry escalation paths.
 * It is WORDLESSNESS: an agent that notices something and has no channel for it
 * produces no signal at all, and the absence is invisible to the operator.
 *
 * ## The four properties, and how each is achieved
 *
 * 1. **Ungated.** A journal write is never routed through policy, never
 *    classified, never approvable and never deniable. That is a property of
 *    WHERE the bytes go: `.approval-journal/` is a plain directory in the
 *    workspace, outside the approval home, so `core/command-class.ts` answers a
 *    write there exactly as it answers a write to `src/` — an ordinary
 *    `files.write.workspace`. Nothing was carved out of the gate's own directory
 *    to achieve this, which is the whole reason the directory is a sibling: see
 *    `docs/cli-reference.md#journal`.
 * 2. **Local.** One append to one file. No socket is opened, no vault is read,
 *    no credential is resolved, and this module imports nothing that could do
 *    any of those.
 * 3. **Non-authoritative.** Nothing in the runtime reads these files. No policy
 *    resolution, no gate decision, no budget, no sampler and no channel imports
 *    this module; the only readers are {@link readJournal} (a human-facing CLI
 *    surface) and its tests. SPEC.md §11.1 invariant 4 says a self-reported
 *    field may raise scrutiny and never lower it. The journal is the limiting
 *    case of that rule: it is self-reported content that moves NOTHING, in
 *    either direction, which is exactly what makes it safe to leave ungated.
 * 4. **Out of the log.** `.approval/log/events.jsonl` records decisions with
 *    real-world consequence, under a hash chain, an append lock and a budget.
 *    A journal entry is none of those things, and putting it there would put the
 *    outlet behind the very machinery it exists to speak around.
 *
 * ## Storage
 *
 * One JSONL file per UTC day, `.approval-journal/YYYY-MM-DD.jsonl`, appended
 * with `appendFileSync`. The envelope (timestamp, actor, optional task and
 * session) is structured so a reader can attribute an entry; the entry TEXT is
 * carried as one opaque JSON string and is never parsed, matched, templated or
 * interpreted by anything in this codebase. `JSON.stringify` escapes newlines,
 * so one entry is always one line and a partial write can never merge two
 * entries into one.
 *
 * There is no chain, no lockfile and no compare-and-append here, and that is not
 * an oversight. Those mechanisms defend a record that decides things. Two agents
 * appending to the same journal file at the same instant can, in the worst case,
 * interleave a line; the cost of that is one garbled entry in a file nothing
 * enforces against, and the price of preventing it would be putting the outlet
 * behind a lock the gate holds.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { tick, type ClockOptions } from "./clock.js";

/**
 * The cap on one entry's text, in bytes.
 *
 * Not a censorship budget: it is four times the length of anything a person
 * will read in one sitting, and it exists because the write path is ungated. An
 * agent stuck in a retry loop is the exact caller most likely to reach for this
 * channel, and an ungated unbounded append from a loop fills a disk. Refused as
 * a usage error, so the caller is told rather than truncated silently.
 */
export const MAX_ENTRY_BYTES = 64 * 1024;

/** The actor recorded when nobody said who was writing. */
export const UNATTRIBUTED_ACTOR = "unattributed";

/** One journal entry, as it sits on disk. */
export interface JournalEntry {
  /** RFC 3339, from the runtime clock at the moment of the append. */
  readonly ts: string;
  /** Who wrote it: `agent:<id>`, `human:<id>`, or {@link UNATTRIBUTED_ACTOR}. */
  readonly actor: string;
  /** The task this was written during, when the caller knew one. */
  readonly task?: string;
  /** The session this was written during, when the caller knew one. */
  readonly session?: string;
  /** The entry itself. Opaque. Nothing in this codebase reads it as anything. */
  readonly text: string;
}

/** One entry as read back, with the file it came from. */
export interface ReadEntry extends JournalEntry {
  /** The file's basename, which is the UTC date it was written on. */
  readonly date: string;
}

export type AppendOutcome =
  | { ok: true; entry: JournalEntry; path: string }
  | { ok: false; code: "empty" | "too-large" | "io"; message: string };

/** `YYYY-MM-DD` for an RFC 3339 instant. */
export function journalDate(ts: string): string {
  return ts.slice(0, 10);
}

/** The file one instant's entry belongs in. */
export function journalFile(dir: string, ts: string): string {
  return join(dir, `${journalDate(ts)}.jsonl`);
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface AppendOptions extends ClockOptions {
  readonly actor?: string;
  readonly task?: string;
  readonly session?: string;
}

/**
 * Append one entry. The whole write path, start to finish.
 *
 * The timestamp comes from the runtime clock rather than from the caller, for
 * the ordinary reason the rest of the runtime does it that way — a record whose
 * time its subject authored is a record about a moment of their choosing —
 * though here nothing is judged by it, so it is a convention rather than a
 * defence.
 */
export function appendJournal(
  dir: string,
  text: string,
  options: AppendOptions = {},
): AppendOutcome {
  if (text.trim().length === 0) {
    return { ok: false, code: "empty", message: "there is nothing to write" };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ENTRY_BYTES) {
    return {
      ok: false,
      code: "too-large",
      message: `the entry is ${String(bytes)} bytes; one entry may be at most ${String(
        MAX_ENTRY_BYTES,
      )}. Write it as several entries`,
    };
  }

  const ts = tick(options);
  const entry: JournalEntry = {
    ts,
    actor: options.actor ?? UNATTRIBUTED_ACTOR,
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.session === undefined ? {} : { session: options.session }),
    text,
  };

  const path = journalFile(dir, ts);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (cause) {
    return { ok: false, code: "io", message: `${path} could not be written: ${detail(cause)}` };
  }
  return { ok: true, entry, path };
}

export interface ReadOptions {
  /** How many entries to return, newest last. */
  readonly limit?: number;
  /** Only entries written on or after this `YYYY-MM-DD`. */
  readonly since?: string;
}

export type ReadOutcome =
  | { ok: true; entries: ReadEntry[]; files: string[]; total: number }
  | { ok: false; code: "io"; message: string };

/** Every `YYYY-MM-DD.jsonl` in `dir`, oldest first. */
function journalFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)).sort();
}

/**
 * Read entries back, oldest first.
 *
 * A line that does not parse is SKIPPED rather than refused: this file has no
 * chain and no writer guarantee, so one torn line is one lost entry and not
 * evidence about anything. Refusing the whole read would let a single bad append
 * silence the channel, which is the failure this feature exists to prevent.
 */
export function readJournal(dir: string, options: ReadOptions = {}): ReadOutcome {
  let files: string[];
  try {
    files = journalFiles(dir);
  } catch (cause) {
    return { ok: false, code: "io", message: `${dir} could not be read: ${detail(cause)}` };
  }

  const since = options.since;
  const wanted = since === undefined ? files : files.filter((name) => name.slice(0, 10) >= since);

  const entries: ReadEntry[] = [];
  for (const name of wanted) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch (cause) {
      return {
        ok: false,
        code: "io",
        message: `${join(dir, name)} could not be read: ${detail(cause)}`,
      };
    }
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record["ts"] !== "string" || typeof record["text"] !== "string") continue;
      entries.push({
        ts: record["ts"],
        actor: typeof record["actor"] === "string" ? record["actor"] : UNATTRIBUTED_ACTOR,
        ...(typeof record["task"] === "string" ? { task: record["task"] } : {}),
        ...(typeof record["session"] === "string" ? { session: record["session"] } : {}),
        text: record["text"],
        date: name.slice(0, 10),
      });
    }
  }

  const total = entries.length;
  const limit = options.limit;
  const kept = limit === undefined ? entries : entries.slice(Math.max(0, total - limit));
  return { ok: true, entries: kept, files: wanted, total };
}
