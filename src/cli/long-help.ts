/**
 * `--help --long`: the short help plus the reasoning behind it (APRV-91 #16).
 *
 * APRV-91 split every per-verb help in two. What is left in `src/cli/help.ts`
 * is the SHORT form, capped at 25 lines: usage, one paragraph of intent, the
 * flags, a footer. The prose that used to sit under it — the threat models, the
 * design points that surprise people, the alternatives that were rejected — was
 * MOVED to `docs/cli-reference.md`, and every short help ends with the anchor it
 * was moved to. This module is the other half of that bargain: `--long` follows
 * the anchor and prints the section inline, so the reader who wants the
 * reasoning never has to leave the terminal to find it.
 *
 * WHERE THE LONG FORM COMES FROM, and why it is not a constant.
 *
 * The alternatives were to keep a `*_LONG_HELP` constant beside every short one,
 * to generate an embedded module from the docs at build time, or to read the
 * docs file at runtime. Constants lose immediately: the same prose would exist
 * twice, in the help module and in the reference a `why:` footer points at, and
 * two copies of grandfathered prose drift the first time someone edits one.
 * Build-time embedding fixes the drift but buys a generated file, a codegen
 * step and a staleness guard to protect a file the package already ships.
 *
 * So: read `docs/cli-reference.md` at runtime, and SHIP IT. `package.json`
 * `files` now names it, and the path below resolves the same way in the repo
 * (`dist/src/cli/` to the root) and in an installed package, because the
 * published layout keeps that relationship. There is exactly one copy of the
 * prose and it is the one a reader on GitHub sees.
 *
 * The failure mode is handled rather than thrown: a missing or unreadable
 * reference makes `--long` print the short help and a plain line saying where
 * the prose should have been. `--long` is a documentation flag, and a
 * documentation flag that exits non-zero because a doc file moved would be a
 * worse bug than the missing prose.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as help from "./help.js";
import { style as processStyle, type Style } from "./style.js";
import { verbOf } from "./usage.js";

/** The shipped reference, relative to this module's compiled location. */
const REFERENCE_PATH = fileURLToPath(new URL("../../../docs/cli-reference.md", import.meta.url));

/** Every exported help constant, in declaration order. */
function helpConstants(): Array<[string, string]> {
  return Object.entries(help).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0].endsWith("_HELP"),
  );
}

/**
 * The help text for a command line, by longest matching title line.
 *
 * The mapping is DERIVED rather than declared: every help constant opens with
 * `approval <verb path> — …`, which `verbOf` already parses for the usage-error
 * pointer. Longest match wins, so `log tail` finds TAIL_HELP rather than
 * LOG_HELP. A declared table would be a second list of verbs to forget to
 * update; this one cannot fall out of step with the constants it indexes.
 */
export function helpFor(words: readonly string[]): string | null {
  const line = ["approval", ...words].join(" ");
  let best: string | null = null;
  let bestLength = -1;
  for (const [, text] of helpConstants()) {
    const verb = verbOf(text);
    // The root's own title is the bare word `approval`, which prefix-matches
    // every command line there is. It is the caller's explicit fallback, never
    // a match, or `approval frobnicate --help --long` would answer confidently.
    if (verb === "approval") continue;
    if (verb.length <= bestLength) continue;
    if (line === verb || line.startsWith(`${verb} `)) {
      best = text;
      bestLength = verb.length;
    }
  }
  return best;
}

/** The `why: docs/cli-reference.md#anchor` footer's anchor, when there is one. */
export function anchorOf(helpText: string): string | null {
  const match = /why: docs\/cli-reference\.md#([a-z0-9-]+)/u.exec(helpText);
  return match?.[1] ?? null;
}

/** GitHub's anchor rule: lowercase, drop punctuation, spaces to dashes. */
function anchorize(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/gu, "")
    .replace(/ /gu, "-");
}

/**
 * The body of the section `anchor` names, headings included, trimmed.
 *
 * A section runs to the next heading AT THE SAME LEVEL OR SHALLOWER, so a `##`
 * section keeps its own `###` subsections and a `###` section stops at its
 * sibling. That is what makes one anchor able to carry a whole verb family.
 */
export function referenceSection(anchor: string, markdown: string): string | null {
  const lines = markdown.split("\n");
  let start = -1;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{2,})\s+(.+?)\s*$/u.exec(lines[index] ?? "");
    if (match === null) continue;
    if (start === -1) {
      if (anchorize(match[2] ?? "") !== anchor) continue;
      start = index;
      depth = (match[1] ?? "").length;
      continue;
    }
    if ((match[1] ?? "").length <= depth) {
      return lines.slice(start, index).join("\n").trim();
    }
  }
  return start === -1 ? null : lines.slice(start).join("\n").trim();
}

/** Read the shipped reference, or null when it is not there. */
export function readReference(path: string = REFERENCE_PATH): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export interface LongHelpOptions {
  /** Override the reference text. Tests use it; the CLI never passes it. */
  reference?: string | null;
  style?: Style;
}

/**
 * The whole `--help --long` output: the short help, a rule, and the reasoning.
 *
 * The short form is printed VERBATIM and first. `--long` is additive by
 * definition: an operator who has learned to read the short help must not have
 * to re-find their bearings in a different layout because they asked for more.
 */
export function longHelp(helpText: string, options: LongHelpOptions = {}): string {
  const style = options.style ?? processStyle();
  const anchor = anchorOf(helpText);
  const markdown =
    options.reference === undefined ? readReference() : options.reference;

  if (anchor === null) {
    return `${helpText}\n\n${style.muted("(no extended reference for this command)")}`;
  }
  const where = `docs/cli-reference.md#${anchor}`;
  if (markdown === null) {
    return `${helpText}\n\n${style.muted(`(the reference is not installed; see ${where})`)}`;
  }
  const section = referenceSection(anchor, markdown);
  if (section === null) {
    return `${helpText}\n\n${style.muted(`(no section ${where})`)}`;
  }
  return [helpText, "", style.rule(), style.heading(`Why — ${where}`), "", section].join("\n");
}
