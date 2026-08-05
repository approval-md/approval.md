/**
 * YAML frontmatter extraction for Backlog.md-style task files (SPEC.md §6).
 *
 * A task file is "ordinary Backlog.md-style markdown" whose frontmatter carries
 * one added key, `approval:`, holding the entire envelope. This module reads
 * that frontmatter. It is **read-only in the strongest sense**: nothing here
 * writes, rewrites, or reserializes a task file. Round-trip rewriting with
 * unknown-key preservation is M6 (APRV-6x), and doing it early — badly — is
 * exactly how a board tool's metadata gets silently dropped.
 *
 * ## Delimiters
 *
 * The document MUST begin with a line that is exactly `---`, and the block ends
 * at the next line that is exactly `---`. No leading blank lines, no BOM
 * tolerance, no `...` terminator, no indented fences. A file whose first bytes
 * are not the opening delimiter simply has no frontmatter — which SPEC.md §6
 * says implementations MUST tolerate ("a task with no envelope … simply cannot
 * request side-effecting execution"), so that is a distinct, non-alarming code
 * rather than a parse error.
 *
 * ## YAML stance — literally the same hardening as the policy loader
 *
 * `core/policy-load.ts` documents at length why a permission document must be
 * parsed under YAML 1.2 core with tags rejected, warnings fatal, duplicate keys
 * fatal, and alias expansion bounded. A task envelope is the *other* half of the
 * same permission surface — it declares the class, cost, and reversibility that
 * policy is matched against — so it is parsed under exactly the same settings.
 *
 * Those settings used to be **replicated** here. APRV-20 (finding S5) removed
 * the replica: `policy-load.ts` now exports {@link parseHardenedYaml} and this
 * module calls it. There is one hardened parser in the codebase, and a task file
 * and a policy block are hardened by the same lines of code — no `parseDocument`
 * call survives in this file, so the two can no longer drift.
 *
 * Determinism: a pure function of the input text. No clock, no network, no
 * caching. Never throws — every failure is a structured result.
 */

import { readFileSync } from "node:fs";

import { parseHardenedYaml } from "./policy-load.js";

/** The line that opens and closes a frontmatter block. */
export const FRONTMATTER_DELIMITER = "---";

/** Why frontmatter could not be read. */
export type FrontmatterErrorCode =
  /** The file does not begin with a `---` line: it has no frontmatter at all. */
  | "no-frontmatter"
  /** An opening `---` with no closing `---` before end of file. */
  | "unterminated"
  /** The block is not parseable YAML under the hardened settings. */
  | "yaml-error"
  /** The block parsed, but not to a mapping (a list or scalar at the root). */
  | "not-a-map";

export type FrontmatterResult =
  | { ok: true; data: Record<string, unknown>; body: string }
  | { ok: false; code: FrontmatterErrorCode; message: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failure(code: FrontmatterErrorCode, message: string): FrontmatterResult {
  return { ok: false, code, message };
}

/**
 * Extract and parse the YAML frontmatter of `text`.
 *
 * Returns the mapping and the remaining markdown body. Line endings are handled
 * for CRLF and CR as well as LF, because a task file edited on Windows is still
 * a task file; the body is rejoined with `\n`, and callers must not treat the
 * returned body as byte-faithful (nothing in v0.1 writes it back).
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return failure(
      "no-frontmatter",
      `the file does not begin with a ${FRONTMATTER_DELIMITER} line, so it carries no frontmatter (SPEC.md §6: a task with no envelope is valid markdown and simply cannot request side-effecting execution)`,
    );
  }

  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === FRONTMATTER_DELIMITER) {
      close = index;
      break;
    }
  }
  if (close === -1) {
    return failure(
      "unterminated",
      `frontmatter opened with ${FRONTMATTER_DELIMITER} but no closing ${FRONTMATTER_DELIMITER} line was found; a truncated frontmatter block is indistinguishable from a complete one and is refused`,
    );
  }

  const source = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");

  const parsed = parseHardenedYaml(source, {
    subject: "frontmatter YAML",
    tagContext: "a task envelope",
  });
  if (!parsed.ok) return failure("yaml-error", parsed.message);
  const value = parsed.value;

  if (value === null || value === undefined) {
    // An empty frontmatter block is a mapping with no keys, not an error.
    return { ok: true, data: {}, body };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return failure(
      "not-a-map",
      `frontmatter must be a YAML mapping, got ${Array.isArray(value) ? "a sequence" : typeof value}`,
    );
  }

  return { ok: true, data: value as Record<string, unknown>, body };
}

export type TaskFileResult =
  | { ok: true; data: Record<string, unknown>; body: string }
  | { ok: false; code: FrontmatterErrorCode | "io"; message: string };

/** {@link parseFrontmatter} over a file, with read failures as their own code. */
export function readTaskFile(path: string): TaskFileResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    return { ok: false, code: "io", message: `task file ${path} could not be read: ${errorMessage(cause)}` };
  }
  return parseFrontmatter(text);
}
