/**
 * `approval import agents-md <file>` (SPEC.md §12) — read an AGENTS.md-style
 * permissions section and PRINT a draft policy block.
 *
 * As everywhere else in this CLI, the logic is not here: parsing, the class
 * heuristic and the rendering live in `core/agents-md.ts`. What is decided here
 * is argument handling, where the bytes go, and the exit code.
 *
 * ## This verb writes nothing that matters
 *
 * It does not touch `APPROVAL.md`, does not append to the log, does not attest,
 * and does not consult one. It reads one file and prints. `--out` writes the
 * draft to a path the caller names, and refuses to overwrite an existing file —
 * an importer that could clobber a policy file would be the most attractive
 * thing in the repository for an agent to point at `APPROVAL.md`.
 *
 * ## Exit codes
 *
 * 0 for every successful read, including a source with no permissions section:
 * a draft of nothing is a correct answer to "what does this file authorise",
 * and it is reported as a warning, not a failure. 2 for usage, 4 for a path
 * that cannot be read or a `--out` that cannot be written.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import {
  importAgentsMd,
  renderDraftPolicy,
  renderFencedDraft,
  type AgentsMdImport,
} from "../core/agents-md.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { IMPORT_AGENTS_MD_HELP, IMPORT_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--out": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

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

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/** The `--json` shape, frozen and pinned by `tests/agents-md-cli.test.ts`. */
function jsonShape(
  result: AgentsMdImport,
  source: string,
  out: string | null,
): Record<string, unknown> {
  return {
    ok: true,
    source,
    out,
    classes: result.classes.map((entry) => ({
      class: entry.cls,
      autonomy: entry.autonomy,
      from: entry.from.text,
      section: entry.from.section,
    })),
    unmapped: result.unmapped.map((bullet) => ({ text: bullet.text, section: bullet.section })),
    ignored: result.ignored,
    warnings: result.warnings,
  };
}

function commandImportAgentsMd(argv: string[], streams: Streams, cwd: string): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, IMPORT_AGENTS_MD_HELP);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${IMPORT_AGENTS_MD_HELP}\n`);
    return EXIT_OK;
  }

  const source = parsed.positionals[0];
  if (source === undefined) {
    return usageError(streams, json, "missing <file> argument", IMPORT_AGENTS_MD_HELP);
  }
  const extra = parsed.positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      IMPORT_AGENTS_MD_HELP,
    );
  }

  let markdown: string;
  try {
    markdown = readFileSync(absolute(source, cwd), "utf8");
  } catch (cause) {
    return ioError(streams, json, `${source} could not be read: ${detail(cause)}`);
  }

  const result = importAgentsMd(markdown);

  // The source label is the path AS GIVEN, so the draft's provenance line is a
  // property of the invocation rather than of the machine it ran on. No date is
  // stamped: the same file must always produce the same bytes.
  const outFlag = stringFlag(parsed.flags, "--out");
  if (outFlag !== null) {
    const outPath = absolute(outFlag, cwd);
    try {
      writeFileSync(outPath, renderDraftPolicy(result, source), { encoding: "utf8", flag: "wx" });
    } catch (cause) {
      const exists = (cause as NodeJS.ErrnoException).code === "EEXIST";
      return ioError(
        streams,
        json,
        exists
          ? `refusing to overwrite ${outFlag}: this verb never replaces an existing file, because the file it would replace could be a policy. Write to a new path, or delete that one yourself`
          : `${outFlag} could not be written: ${detail(cause)}`,
      );
    }
  }

  if (json) {
    streams.out(`${JSON.stringify(jsonShape(result, source, outFlag))}\n`);
    return EXIT_OK;
  }

  if (outFlag === null) streams.out(renderFencedDraft(result, source));
  else streams.out(`wrote draft policy YAML to ${outFlag}\n`);

  for (const heading of result.ignored) {
    streams.err(
      `approval: ignored heading ${JSON.stringify(heading)}: it is inside the permissions area and is not one of the recognised sections, so nothing under it was read\n`,
    );
  }
  for (const warning of result.warnings) streams.err(`approval: ${warning}\n`);
  streams.err(
    "approval: this is a DRAFT and authorizes nothing. Nothing was written to APPROVAL.md, nothing was logged, nothing was attested. Review it, then paste it into APPROVAL.md and run `approval policy amend`\n",
  );
  return EXIT_OK;
}

/** `approval import …` — dispatch to `agents-md`, or print the help. */
export function commandImport(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined) {
    return usageError(
      streams,
      wantsJson(argv),
      "missing subcommand for `approval import`",
      IMPORT_HELP,
    );
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${IMPORT_HELP}\n`);
    return EXIT_OK;
  }

  switch (sub) {
    case "agents-md":
      return commandImportAgentsMd(rest, streams, cwd);
    default:
      return usageError(
        streams,
        wantsJson(argv),
        `unknown subcommand ${JSON.stringify(sub)} for \`approval import\``,
        IMPORT_HELP,
      );
  }
}
