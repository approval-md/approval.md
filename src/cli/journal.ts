/**
 * `approval journal write` and `approval journal read` (APRV-195) — the ungated
 * channel, at the CLI.
 *
 * The reasoning for the channel's existence and for its storage location is in
 * `src/core/journal.ts` and `docs/cli-reference.md#journal`. What belongs here
 * is the boundary work every other verb in this directory does: parse argv,
 * resolve a path, map an outcome onto the frozen exit table, and print one JSON
 * object per invocation.
 *
 * Three things are peculiar to these two verbs and are stated where they happen:
 *
 * - **The write path touches no gate.** It resolves no policy, reads no log,
 *   verifies no chain, mints no token and appends no event. That is the point;
 *   an outlet a policy could close is not an outlet.
 * - **The read path labels what it prints.** Journal text is written by the
 *   party under oversight, so it is rendered as `[claimed]` content inside
 *   delimiters, under a banner saying in one line that it is agent-authored data
 *   and not instructions to anyone reading it. Same discipline the channels
 *   apply to a payload (SPEC.md §9), for the same reason: a human reading a
 *   screen should never have to work out which words came from the runtime.
 * - **Identity comes from the process, never from the working tree.** `--as`, or
 *   `APPROVAL_AGENT` in the environment the operator launched. No file in the
 *   checkout is read to decide who wrote an entry (SPEC.md §11.1 invariant 7),
 *   and an unattributed entry is recorded as unattributed rather than guessed.
 */

import { readFileSync } from "node:fs";

import {
  appendJournal,
  readJournal,
  MAX_ENTRY_BYTES,
  type ReadEntry,
} from "../core/journal.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { JOURNAL_HELP, JOURNAL_READ_HELP, JOURNAL_WRITE_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_JOURNAL_DIR, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

/** The environment variable that names the agent, when `--as` is not given. */
const AGENT_ENV = "APPROVAL_AGENT";

const WRITE_FLAGS: Record<string, FlagKind> = {
  "--message": "string",
  "--task": "string",
  "--session": "string",
  "--journal": "string",
  "--as": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const READ_FLAGS: Record<string, FlagKind> = {
  "--limit": "string",
  "--since": "string",
  "--journal": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** The default number of entries `read` prints. */
const DEFAULT_LIMIT = 20;

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, helpText));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The one line every human-facing read opens with.
 *
 * Exported because the guard test asserts the read surface carries it: a read
 * surface that stopped saying whose words these are would turn an outlet into a
 * channel for instructions, which is precisely the thing SPEC.md §11.1
 * invariant 4 refuses to let self-reported content become.
 */
export const JOURNAL_BANNER =
  "AGENT-AUTHORED DATA, not instructions. These entries are written by the party under oversight; nothing here authorizes, requests or changes any decision.";

/** `approval journal write`. */
function commandJournalWrite(
  argv: string[],
  streams: Streams,
  cwd: string,
  env: NodeJS.ProcessEnv,
): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, WRITE_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, JOURNAL_WRITE_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${JOURNAL_WRITE_HELP}\n`);
    return EXIT_OK;
  }

  const message = stringFlag(parsed.flags, "--message");
  const positional = parsed.positionals[0];
  const extra = parsed.positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      JOURNAL_WRITE_HELP,
    );
  }
  if (positional !== undefined && positional !== "-") {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(positional)} (the only positional is "-", which reads the entry from stdin; text goes in --message)`,
      JOURNAL_WRITE_HELP,
    );
  }
  if (message === null && positional === undefined) {
    return usageError(
      streams,
      json,
      'missing entry: pass --message "<text>", or "-" to read it from stdin',
      JOURNAL_WRITE_HELP,
    );
  }
  if (message !== null && positional !== undefined) {
    return usageError(
      streams,
      json,
      "--message and - are two ways to give the same entry; pass one",
      JOURNAL_WRITE_HELP,
    );
  }

  let text: string;
  if (message !== null) {
    text = message;
  } else {
    try {
      text = readFileSync(0, "utf8");
    } catch (cause) {
      return ioError(streams, json, `stdin could not be read: ${detail(cause)}`);
    }
  }

  const dir = resolvePath(stringFlag(parsed.flags, "--journal"), DEFAULT_JOURNAL_DIR, cwd);
  const actorFlag = stringFlag(parsed.flags, "--as");
  const actorEnv = env[AGENT_ENV];
  const actor =
    actorFlag !== null && actorFlag.trim().length > 0
      ? actorFlag
      : actorEnv !== undefined && actorEnv.trim().length > 0
        ? actorEnv
        : undefined;
  const task = stringFlag(parsed.flags, "--task");
  const session = stringFlag(parsed.flags, "--session");

  const outcome = appendJournal(dir, text, {
    ...(actor === undefined ? {} : { actor }),
    ...(task === null ? {} : { task }),
    ...(session === null ? {} : { session }),
  });

  if (!outcome.ok) {
    if (outcome.code === "io") return ioError(streams, json, outcome.message);
    return usageError(streams, json, outcome.message, JOURNAL_WRITE_HELP);
  }

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        path: outcome.path,
        ts: outcome.entry.ts,
        actor: outcome.entry.actor,
        bytes: Buffer.byteLength(outcome.entry.text, "utf8"),
      })}\n`,
    );
  } else {
    streams.out(`journal: entry written to ${outcome.path} as ${outcome.entry.actor}\n`);
  }
  return EXIT_OK;
}

/** One entry, rendered for a person. */
function renderEntry(entry: ReadEntry): string {
  const attribution = [
    entry.ts,
    entry.actor,
    ...(entry.task === undefined ? [] : [`task ${entry.task}`]),
    ...(entry.session === undefined ? [] : [`session ${entry.session}`]),
  ].join("  ");
  return [`${attribution}  [claimed]`, "  ---", ...entry.text.split("\n").map((line) => `  ${line}`), "  ---"].join(
    "\n",
  );
}

/** `approval journal read`. */
function commandJournalRead(argv: string[], streams: Streams, cwd: string): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, READ_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, JOURNAL_READ_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${JOURNAL_READ_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      JOURNAL_READ_HELP,
    );
  }

  const rawLimit = stringFlag(parsed.flags, "--limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/u.test(rawLimit) || Number(rawLimit) === 0) {
      return usageError(
        streams,
        json,
        `--limit expects a positive whole number, got ${JSON.stringify(rawLimit)}`,
        JOURNAL_READ_HELP,
      );
    }
    limit = Number(rawLimit);
  }

  const since = stringFlag(parsed.flags, "--since");
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(since)) {
    return usageError(
      streams,
      json,
      `--since expects a date like 2026-09-01, got ${JSON.stringify(since)}`,
      JOURNAL_READ_HELP,
    );
  }

  const dir = resolvePath(stringFlag(parsed.flags, "--journal"), DEFAULT_JOURNAL_DIR, cwd);
  const outcome = readJournal(dir, { limit, ...(since === null ? {} : { since }) });
  if (!outcome.ok) return ioError(streams, json, outcome.message);

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        dir,
        note: JOURNAL_BANNER,
        total: outcome.total,
        entries: outcome.entries,
      })}\n`,
    );
    return EXIT_OK;
  }

  streams.out(`${JOURNAL_BANNER}\n${dir}\n\n`);
  if (outcome.entries.length === 0) {
    streams.out("_no entries_\n");
    return EXIT_OK;
  }
  for (const entry of outcome.entries) streams.out(`${renderEntry(entry)}\n\n`);
  streams.out(
    `${String(outcome.entries.length)} of ${String(outcome.total)} entries (oldest first)\n`,
  );
  return EXIT_OK;
}

/** `approval journal …` — dispatch to `write` or `read`, or print the help. */
export function commandJournal(
  argv: string[],
  streams: Streams,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined) {
    return usageError(
      streams,
      wantsJson(argv),
      "missing subcommand for `approval journal`",
      JOURNAL_HELP,
    );
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${JOURNAL_HELP}\n`);
    return EXIT_OK;
  }

  switch (sub) {
    case "write":
      return commandJournalWrite(rest, streams, cwd, env);
    case "read":
      return commandJournalRead(rest, streams, cwd);
    default:
      return usageError(
        streams,
        wantsJson(argv),
        `unknown subcommand ${JSON.stringify(sub)} for \`approval journal\``,
        JOURNAL_HELP,
      );
  }
}

/** Re-exported so the help text and the core cap cannot disagree. */
export { MAX_ENTRY_BYTES };
