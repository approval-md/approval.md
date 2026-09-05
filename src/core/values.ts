/**
 * The values block of `APPROVAL.md` (SPEC.md §5.3), read.
 *
 * Everything else in this directory is control: what an agent may do, who
 * decides, what is sampled. This module reads the other half of the file — the
 * optional ` ```yaml approval-values ` block in which the operator says what
 * they value in the work, what they want from the agent, and how they read and
 * answer. It is the mirror of the journal (SPEC.md §10.1): the journal is the
 * agent's outlet the gate does not stand in front of, and the values block is
 * the human's, with the same rule running in both directions, that nothing said
 * there moves a verdict.
 *
 * Three decisions are worth stating here rather than leaving to be inferred.
 *
 * **Absence is a declaration, never a default.** A file with no values block is
 * an operator who has declared no values, which is information. It is not a
 * missing thing to be repaired, and it is not an invitation to invent a neutral
 * middle. So the result has three states rather than two: present, absent, and
 * unreadable, and `ok: true, present: false` is the absent one. Surfaces render
 * it in the words SPEC.md §5.3 fixes, so a session can tell "nothing was
 * declared" from "I did not look".
 *
 * **Two blocks fail.** One file, at most one values block, exactly as the policy
 * block is exactly one. Two blocks are two answers to one question, and a reader
 * that silently took the first would be choosing between two things a human
 * wrote, on the strength of document order.
 *
 * **A values failure never fails the policy.** Enforcement fails closed on the
 * policy block because an unparseable permission document is one whose author
 * believes constraints are in force that are not. Nothing about that argument
 * carries here, because this block is not enforcement: no routing, class match,
 * sampling draw, budget, token or execution decision reads it (SPEC.md §11.1
 * invariant 10, pinned by `tests/values-inert.test.ts`). Failing closed on a
 * malformed values block would convert a typo into an all-manual repository, and
 * would buy no safety at all in exchange. The two blocks are therefore parsed
 * and judged independently, on paths that share only the fence splitter, and
 * this module never calls the policy loader's parse path.
 *
 * ## Determinism
 *
 * {@link loadValues} is a pure function of the file bytes on disk plus the
 * schema directory. No clock, no network, no randomness, no cross-call caching,
 * and no throw: every failure is a result.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { scanFences } from "./md-fence.js";
// `POLICY_FILENAMES` is the SPEC.md §5 filename precedence and `parseHardenedYaml`
// is the ONE hardened YAML parse in this codebase (see its own doc comment). The
// values block lives inside the same file and deserves the same parser stance,
// so both are borrowed rather than replicated. Nothing else is: the policy
// loader's own parse path is untouched from here, in either direction.
import { POLICY_FILENAMES, parseHardenedYaml } from "./policy-load.js";
import { validate, type ValidationError } from "./validate.js";

/** Info string that marks the OPTIONAL values block (SPEC.md §5.3). */
export const VALUES_INFO_STRING = "yaml approval-values";

/**
 * The parsed values block, as `values.schema.json` admits it.
 *
 * The key set is closed and small on purpose, and the schema is the authority
 * on why each key is here and which were rejected. This interface restates the
 * shape for TypeScript and adds nothing.
 */
export interface Values {
  /** Format version. The only required key; the integer `1` and nothing else. */
  version: 1;
  /** What the operator loves, in their own words. */
  love?: string[];
  /** What the operator likes. */
  like?: string[];
  /** What the operator dislikes. NOT a prohibition: a prohibition is policy. */
  dislike?: string[];
  /** What the operator wants FROM the agent, as behaviour rather than taste. */
  wants?: string[];
  /** How the operator reads and answers. One sentence or two. */
  responds?: string;
}

/**
 * Why a values block could not be read.
 *
 * Deliberately NOT {@link import("./policy-load.js").PolicyLoadErrorCode}: the
 * two are different questions with different consequences, and a shared union
 * would invite a caller to handle one with the other's rules. There is no
 * `no-block` here, because a file with no values block is not a failure at all.
 */
export type ValuesLoadFailureCode =
  | "file-missing"
  | "multiple-blocks"
  | "unterminated-fence"
  | "yaml-error"
  | "schema-invalid";

/** Where the values block was read from. */
export interface ValuesSource {
  /** Absolute or caller-relative path actually read. */
  path: string;
  /** Basename of that path, e.g. `APPROVAL.md`. */
  filename: string;
}

/**
 * Result of {@link loadValues}: present, absent, or unreadable.
 *
 * A not-ok result places no obligation on any enforcement path, because no
 * enforcement path may be looking. It obligates exactly one thing, of the
 * surfaces that print it: say the block is there and could not be read, and say
 * that it grants nothing either way.
 */
export type ValuesLoadResult =
  | { ok: true; present: true; values: Values; source: ValuesSource }
  | { ok: true; present: false; source: ValuesSource }
  | {
      ok: false;
      code: ValuesLoadFailureCode;
      message: string;
      errors?: ValidationError[];
      source?: ValuesSource;
    };

/** Options accepted by {@link loadValues}. */
export interface LoadValuesOptions {
  /** Directory to search for `APPROVAL.md` / `APPROVALS.md`. Default: cwd. */
  dir?: string;
  /** Explicit policy file path. Overrides discovery entirely. */
  file?: string;
  /** Schema directory passed through to {@link validate}. Injectable for tests. */
  schemaDir?: string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sourceOf(path: string): ValuesSource {
  return { path, filename: basename(path) };
}

function failure(
  code: ValuesLoadFailureCode,
  message: string,
  source?: ValuesSource,
  errors?: ValidationError[],
): ValuesLoadResult {
  const base = { ok: false as const, code, message };
  const withSource = source === undefined ? base : { ...base, source };
  return errors === undefined ? withSource : { ...withSource, errors };
}

/**
 * Find the file the values block would live in.
 *
 * The SAME discovery `loadPolicy` performs, and the same precedence
 * ({@link POLICY_FILENAMES}: `APPROVAL.md`, then `APPROVALS.md`), because it is
 * the same file. It is written out here rather than imported because the policy
 * loader's is private to it, and a values reader that reached into the policy
 * loader for anything but a shared constant is the coupling this module exists
 * without.
 */
function resolveFile(
  options: LoadValuesOptions,
): ValuesLoadResult | { path: string; text: string } {
  if (options.file !== undefined) {
    try {
      return { path: options.file, text: readFileSync(options.file, "utf8") };
    } catch (cause) {
      return failure(
        "file-missing",
        `policy file ${options.file} could not be read: ${errorMessage(cause)}`,
        sourceOf(options.file),
      );
    }
  }

  const dir = options.dir ?? process.cwd();
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    try {
      return { path: candidate, text: readFileSync(candidate, "utf8") };
    } catch {
      continue;
    }
  }
  return failure(
    "file-missing",
    `no policy file found in ${dir} (looked for ${POLICY_FILENAMES.join(", ")})`,
  );
}

/**
 * Extract, parse, and validate the values block of an already-read file.
 *
 * The bytes-in form of {@link loadValues}, for the caller that has the file in
 * hand (a doctor run reading it once for several questions) and for the tests
 * that build a file variant without touching a disk. Nothing here touches the
 * filesystem, nothing throws, and `path` is used only for messages and for
 * {@link ValuesSource}.
 */
export function loadValuesText(
  path: string,
  text: string,
  options: { schemaDir?: string } = {},
): ValuesLoadResult {
  const source = sourceOf(path);
  const scan = scanFences(text, VALUES_INFO_STRING);

  if (scan.unterminated) {
    // CommonMark would close an unterminated fence at EOF. This does not, for
    // the reason the policy loader does not: the truncated tail of a block is
    // indistinguishable from a complete one, and a values block that says half
    // of what a human wrote is worse than one that says it could not be read.
    return failure(
      "unterminated-fence",
      `${path}: unterminated \`\`\`${VALUES_INFO_STRING} fence (no closing fence before end of file)`,
      source,
    );
  }
  if (scan.blocks.length === 0) {
    // The declaration of absence. Not a failure, and not a default.
    return { ok: true, present: false, source };
  }
  if (scan.blocks.length > 1) {
    return failure(
      "multiple-blocks",
      `${path}: found ${String(scan.blocks.length)} \`\`\`${VALUES_INFO_STRING} fenced blocks; SPEC.md §5.3 allows at most one`,
      source,
    );
  }

  const parsed = parseHardenedYaml(scan.blocks[0] ?? "", {
    subject: "values YAML",
    tagContext: "a values block",
  });
  if (!parsed.ok) return failure("yaml-error", `${path}: ${parsed.message}`, source);

  // `exactOptionalPropertyTypes` is on, so the key is omitted rather than
  // passed as `undefined`: the validator's own default is not the same thing as
  // an explicit `undefined` schema directory.
  const validated = validate(
    "values",
    parsed.value,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!validated.ok) {
    return failure(
      "schema-invalid",
      `${path}: the values block does not match values.schema.json`,
      source,
      validated.errors,
    );
  }

  return { ok: true, present: true, values: parsed.value as Values, source };
}

/**
 * Find `APPROVAL.md`, and read its values block if it has one.
 *
 * Discovery plus {@link loadValuesText}. A file that cannot be read at all is
 * `file-missing`, which is the only failure code here that says nothing about
 * the block: there was no file to hold one.
 */
export function loadValues(options: LoadValuesOptions = {}): ValuesLoadResult {
  const resolved = resolveFile(options);
  if ("ok" in resolved) return resolved;
  return loadValuesText(
    resolved.path,
    resolved.text,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
}
