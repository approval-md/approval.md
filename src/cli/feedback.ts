/**
 * `approval feedback` (APRV-239) — what the operator thought, read back.
 *
 * The HUMAN-TO-AGENT direction of the log, at the CLI. Two records can carry a
 * human's own words about an action: `approval.granted`, where a person answered
 * the gate, and `audit.reviewed`, where a person looked at a sampled action
 * afterwards. Both may carry a graded `reaction` and both may carry a `note`.
 * This verb collects them, joins each to the class, the task, the action key and
 * the AGENT whose work it was, and prints them behind a banner.
 *
 * Three properties are the whole design, and each is enforced somewhere in this
 * file rather than asserted in prose:
 *
 * - **It is guidance, and it says so on every output form.** {@link FEEDBACK_BANNER}
 *   leads the human rendering and rides in the `note` field of the JSON. A
 *   surface that printed reactions without labelling them would be handing an
 *   agent free-text human prose in the shape of a rule (SPEC.md §11.1
 *   invariant 10 requires the label; the invariant's substance is that nothing
 *   in the runtime reads any of this).
 * - **It is symmetric with `journal`, deliberately.** `journal read` is the
 *   operator reading what the agents said; this is the agents reading what the
 *   operator said. Same shape of entry, same delimiters, same `--since` and
 *   `--limit`. The one difference is that no entry here is marked `[claimed]`:
 *   these are the overseer's words, appended under a `human:` actor to a
 *   hash-chained log, which is precisely the thing `[claimed]` exists to
 *   distinguish journal text FROM.
 * - **It reads verified records and nothing else.** No policy is resolved, no
 *   clock is read, nothing is appended. A log that does not verify refuses with
 *   the log-* exit codes rather than showing a partial list, because a reaction
 *   read out of an unverifiable log is a sentence attributed to a person who may
 *   not have written it.
 *
 * `--actor` filters on the AGENT the feedback is about, not on the human who
 * wrote it. That is the question an agent reading this actually has ("what has
 * the operator said about my work"), and the human side is a small closed set
 * that a `--source` filter already separates usefully.
 */

import { humanFeedback, REACTIONS, isReaction, type FeedbackEntry } from "../core/audit.js";
import { readVerifiedRecords } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { FEEDBACK_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--task": "string",
  "--actor": "string",
  "--reaction": "string",
  "--source": "string",
  "--since": "string",
  "--limit": "string",
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** The default number of entries printed, matching `journal read`. */
const DEFAULT_LIMIT = 20;

/** The two sources a reaction or a note can come from. */
const SOURCES = ["review", "decision"] as const;

/**
 * The one line every output form carries.
 *
 * Exported because the guard tests assert it is on both renderings. A surface
 * that stopped saying what these words are would be offering an agent a
 * human's after-the-fact opinion in the same register as a policy rule, and the
 * agent's correct reading of a policy rule is "this binds me". Nothing here
 * binds anything: SPEC.md §11.1 invariant 10 says no enforcement path reads a
 * reaction, and this sentence is how a reader learns that without going to the
 * spec.
 */
export const FEEDBACK_BANNER =
  "HUMAN-AUTHORED GUIDANCE, not policy. A reaction records what the operator thought of an action after the fact; it grants nothing, forbids nothing, and changes no verdict, sampling probability or budget.";

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, FEEDBACK_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

/** One entry, rendered for a person, in the shape `journal read` uses. */
function renderEntry(entry: FeedbackEntry): string {
  const attribution = [
    entry.ts,
    entry.actor,
    entry.reaction ?? "-",
    `task ${entry.task ?? "-"}`,
    `action ${entry.actionKey ?? "-"}`,
    `class ${entry.class ?? "-"}`,
    `agent ${entry.agentActor ?? "-"}`,
  ].join("  ");
  if (entry.note === null) return attribution;
  return [attribution, "  ---", ...entry.note.split("\n").map((line) => `  ${line}`), "  ---"].join(
    "\n",
  );
}

/**
 * `approval feedback [filters] [--log <path>] [--json]`.
 *
 * Reads and prints. There is no write half and there will not be one: the two
 * verbs that record a reaction are `approval grant` and `approval audit review`,
 * both human-only, and a third path into the same field that was not one of
 * those would be a way for the party under oversight to author the operator's
 * opinion of it.
 */
export function commandFeedback(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  const { flags, positionals } = parsed;

  if (boolFlag(flags, "--help") || boolFlag(flags, "-h")) {
    streams.out(`${FEEDBACK_HELP}\n`);
    return EXIT_OK;
  }
  const extra = positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const reactionFlag = stringFlag(flags, "--reaction");
  if (reactionFlag !== null && !isReaction(reactionFlag)) {
    return usageError(
      streams,
      json,
      `--reaction expects one of ${REACTIONS.join(" | ")}, got ${JSON.stringify(reactionFlag)}`,
    );
  }

  const sourceFlag = stringFlag(flags, "--source");
  if (sourceFlag !== null && !(SOURCES as readonly string[]).includes(sourceFlag)) {
    return usageError(
      streams,
      json,
      `--source expects one of ${SOURCES.join(" | ")}, got ${JSON.stringify(sourceFlag)}`,
    );
  }

  const rawLimit = stringFlag(flags, "--limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/u.test(rawLimit) || Number(rawLimit) === 0) {
      return usageError(
        streams,
        json,
        `--limit expects a positive whole number, got ${JSON.stringify(rawLimit)}`,
      );
    }
    limit = Number(rawLimit);
  }

  const since = stringFlag(flags, "--since");
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(since)) {
    return usageError(
      streams,
      json,
      `--since expects a date like 2026-09-01, got ${JSON.stringify(since)}`,
    );
  }

  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    if (json) {
      streams.err(`${JSON.stringify({ error: { code: read.code, message: read.message } })}\n`);
    } else {
      streams.err(`approval: ${read.message}\n`);
    }
    if (read.code === "log-torn-tail") return EXIT_TORN_TAIL;
    if (read.code === "log-corrupt") return EXIT_INTEGRITY;
    return EXIT_IO;
  }

  const task = stringFlag(flags, "--task");
  const actor = stringFlag(flags, "--actor");
  const matched = humanFeedback(read.records).filter((entry) => {
    if (task !== null && entry.task !== task) return false;
    if (actor !== null && entry.agentActor !== actor) return false;
    if (reactionFlag !== null && entry.reaction !== reactionFlag) return false;
    if (sourceFlag !== null && entry.source !== sourceFlag) return false;
    // `--since` is a UTC date compared against the record's own timestamp
    // prefix, exactly as `journal read` compares it: a string comparison on
    // ISO-8601 is the ordering, and no timezone is invented for the caller.
    if (since !== null && entry.ts.slice(0, 10) < since) return false;
    return true;
  });

  // Oldest first, and the LAST `limit` of them: the same reading `journal read`
  // gives the flag, because the interesting end of a growing list is the recent
  // end and a reader still wants it in the order it happened.
  const entries = matched.slice(-limit);

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        log: logPath,
        note: FEEDBACK_BANNER,
        total: matched.length,
        entries,
      })}\n`,
    );
    return EXIT_OK;
  }

  streams.out(`${FEEDBACK_BANNER}\n${logPath}\n\n`);
  if (entries.length === 0) {
    streams.out("_no feedback_\n");
    return EXIT_OK;
  }
  for (const entry of entries) streams.out(`${renderEntry(entry)}\n\n`);
  streams.out(
    `${String(entries.length)} of ${String(matched.length)} entries (oldest first)\n`,
  );
  return EXIT_OK;
}
