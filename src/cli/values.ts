/**
 * `approval values` (APRV-238) — the operator's stated preferences, at the CLI.
 *
 * The reasoning for the block's existence, and for the three decisions its
 * reader is built on, is in `src/core/values.ts` and
 * `docs/cli-reference.md#values`. What belongs here is the boundary work every
 * other verb in this directory does: parse argv, resolve a path, map an outcome
 * onto the frozen exit table, and print one JSON object per invocation.
 *
 * Three things are peculiar to this verb and are stated where they happen:
 *
 * - **Every output form carries the banner.** This is the mirror of `journal
 *   read`, which labels what it prints as agent-authored data. Here the words
 *   came from the human rather than from the agent, and the label is needed for
 *   the same reason running the other way: an agent reading a screen must never
 *   have to work out whether what it is reading grants anything. It does not.
 * - **Absence is printed, in fixed words.** SPEC.md §5.3 fixes the sentence, so
 *   a session can tell "the operator declared no values" from "I did not look".
 * - **A broken block exits 1 and says so.** Not 0 with an empty answer, which
 *   would be indistinguishable from absence, and not a claim that anything is
 *   refused: the message says to treat it as absent, because it grants nothing
 *   either way. Nothing else in the runtime changes because of it, which is why
 *   this verb and `approval doctor` are the surfaces that report it and
 *   `approval policy check` is not — that command's answer is the enforcement
 *   trace, and guidance has no place in it.
 */

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import { POLICY_FILENAMES } from "../core/policy-load.js";
import { loadValues, type Values, type ValuesLoadResult } from "../core/values.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { VALUES_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * The one line every output form opens with.
 *
 * Exported because `tests/cli-values.test.ts` asserts it is on all of them. A
 * surface that stopped saying what these words are would be handing an agent
 * human-authored prose with no statement of its standing, and the standing is
 * the whole of what SPEC.md §11.1 invariant 10 is about.
 */
export const VALUES_BANNER =
  "HUMAN-AUTHORED GUIDANCE, not policy. These are the operator's stated preferences: they grant nothing, forbid nothing, and change no verdict. What you may do is APPROVAL.md's policy block; read it with `approval policy check`.";

/** The sentence SPEC.md §5.3 fixes for a file that declares no values. */
export const NO_VALUES_SENTENCE = "the operator has declared no values here.";

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, VALUES_HELP));
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

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/**
 * Readability preflight, exactly as `policy check` performs it and for exactly
 * the same reason: an absent file is an answer this verb can give, and a file
 * that exists but cannot be read is a fact about the filesystem. Reporting the
 * second as the first would tell an operator their file is missing when it is
 * merely locked.
 */
function preflight(path: string): { ok: true } | { ok: false; message: string } {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, message: `policy ${path} could not be opened: ${detail(cause)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, message: `policy ${path} is a directory, not a policy file` };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch (cause) {
    return { ok: false, message: `policy ${path} is not readable: ${detail(cause)}` };
  }
  return { ok: true };
}

/** One standing list, rendered as bullets. An empty list is stated as empty. */
function renderList(label: string, entries: string[] | undefined): string[] {
  if (entries === undefined) return [];
  if (entries.length === 0) return [`${label}:`, "  (nothing declared under this grade)"];
  return [`${label}:`, ...entries.map((entry) => `  - ${entry}`)];
}

/** The block, for a person: four bulleted lists and one paragraph. */
function renderValues(values: Values): string {
  const lines = [
    ...renderList("loves", values.love),
    ...renderList("likes", values.like),
    ...renderList("dislikes", values.dislike),
    ...renderList("wants from you", values.wants),
  ];
  if (values.responds !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push("responds:", `  ${values.responds}`);
  }
  if (lines.length === 0) {
    // A block carrying nothing but `version`. It is present and it says
    // nothing, which is a different fact from absence and is printed as one.
    return "the values block is present and declares nothing under any key.\n";
  }
  return `${lines.join("\n")}\n`;
}

/** `approval values`. */
export function commandValues(argv: string[], streams: Streams, cwd: string): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${VALUES_HELP}\n`);
    return EXIT_OK;
  }

  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);

  // `--policy` wins over discovery, exactly as `loadValues` treats `file` vs
  // `dir` and exactly as `policy check` resolves the same two flags.
  const file = policyFlag === null ? null : absolute(policyFlag, cwd);
  const probes = file === null ? POLICY_FILENAMES.map((name) => join(dir, name)) : [file];
  for (const probe of probes) {
    const check = preflight(probe);
    if (!check.ok) return ioError(streams, json, check.message);
  }

  const result: ValuesLoadResult = loadValues(file === null ? { dir } : { file });

  if (!result.ok) {
    const path = result.source?.path ?? (file ?? dir);
    if (result.code === "file-missing") return ioError(streams, json, result.message);
    if (json) {
      streams.err(
        `${JSON.stringify({
          ok: false,
          error: { code: result.code, message: result.message },
        })}\n`,
      );
    } else {
      streams.err(`${VALUES_BANNER}\n${path}\n\n`);
      streams.err(
        `values block present but unreadable (${result.code}); treat it as absent, it grants nothing either way\n${result.message}\n`,
      );
    }
    return EXIT_INTEGRITY;
  }

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        path: result.source.path,
        present: result.present,
        note: VALUES_BANNER,
        values: result.present ? result.values : null,
      })}\n`,
    );
    return EXIT_OK;
  }

  streams.out(`${VALUES_BANNER}\n${result.source.path}\n\n`);
  streams.out(result.present ? renderValues(result.values) : `${NO_VALUES_SENTENCE}\n`);
  return EXIT_OK;
}
