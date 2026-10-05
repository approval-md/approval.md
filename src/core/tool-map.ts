/**
 * Policy-declared tool-name mapping (APRV-499, amended SPEC.md §5.2 proposed).
 *
 * A harness hook classifies a tool call through the adapter's own tables: its
 * shell tool, its file and read tools, its pass-through tools, and (Hermes) a
 * hard-coded rule table over the harness's side-effecting tools. A call none of
 * those claims used to be answered "not a gated tool" and allowed with no
 * record, which put every MCP tool (`mcp__<server>__<tool>` on Claude Code)
 * outside the gate and made a new app a core release.
 *
 * This module is the policy's half of the answer, and it is pure: no I/O, no
 * clock. Two keys:
 *
 * - `tools`: an ORDERED list of `{match, class}`. `match` is a glob over the
 *   whole tool name whose only wildcard is `*` (any run of characters,
 *   including none); `class` is a concrete class the policy declares. The first
 *   entry that matches decides, and later entries are not read.
 * - `defaults.unmapped_tool`: `record` or `ask`, for a call no entry matches.
 *   Such a call is judged under {@link UNMAPPED_TOOL_CLASS}, whose default
 *   autonomy the key supplies (see `core/policy-match.ts`'s `fromDefaults`).
 *   Absent, the call stays outside the gate exactly as before.
 *
 * The adapter's own tables keep precedence over every entry, and that ordering
 * lives in the hook, not here: those tables read the call's ARGUMENTS
 * (`cronjob_manage list` is a read, `create` is not), while an entry reads only
 * the NAME, so letting an entry override them would let a name-only line
 * loosen a call the runtime classified from what it does.
 */

import type { Policy } from "./policy-load.js";
import type { ValidationError } from "./validate.js";

/**
 * The class a harness tool call is judged under when no `tools` entry claims it
 * and the policy declares `defaults.unmapped_tool` (APRV-499).
 *
 * Fixed rather than derived from the tool name, so one `classes` line prices
 * every unmapped call and a policy cannot be surprised by a class it never
 * wrote. The tool's NAME rides on the record instead (`harness_tool` on the
 * `execution.started` payload, and the whole call in a gated request's
 * payload).
 */
export const UNMAPPED_TOOL_CLASS = "harness.tool.unmapped";

/**
 * Can this tool name be recorded? (APRV-499, refutation S4.)
 *
 * The shape the event schema admits for `harness_tool` on an
 * `execution.started` (letters, digits, `_`, `.`, `:`, `-`, at most 256),
 * which is also every literal a `tools` match may spell. The hook asks this
 * BEFORE it classifies a call under a mapped or unmapped class, so a name
 * outside it is refused by name rather than at the write boundary as an opaque
 * `append-failed`. Model APIs already cap tool names well inside this set, so
 * the refusal is a corner; what it buys is a message that says what is wrong.
 */
export function isRecordableToolName(name: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,256}$/u.test(name);
}

/** What `defaults.unmapped_tool` may say. */
export type UnmappedToolMode = "record" | "ask";

/** One `tools` entry, as the schema admits it. */
export interface ToolMapEntry {
  match: string;
  class: string;
}

/**
 * The policy's answer for one tool name.
 *
 * - `mapped`: an entry claimed it; `index` is the entry's position, so a
 *   decision can say which line decided.
 * - `unmapped`: no entry claimed it and `defaults.unmapped_tool` says what to
 *   do; the class is always {@link UNMAPPED_TOOL_CLASS}.
 * - `not-gated`: no entry claimed it and the policy declares no unmapped-tool
 *   default, so the call is not a gate question (the pre-APRV-499 answer).
 */
export type ToolMapVerdict =
  | { kind: "mapped"; cls: string; match: string; index: number }
  | { kind: "unmapped"; cls: typeof UNMAPPED_TOOL_CLASS; mode: UnmappedToolMode }
  | { kind: "not-gated" };

/**
 * Does the glob `pattern` match the whole of `name`?
 *
 * `*` matches any run of characters, including none; every other character is
 * literal and compared case-sensitively. Linear in the name for a fixed
 * pattern: the literal runs between wildcards are found leftmost-first, which
 * is exact for a language whose only wildcard is `*` (taking an earlier
 * occurrence of a run never rules out a match a later one would allow).
 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === name;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (name.length < first.length + last.length) return false;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  let position = first.length;
  const end = name.length - last.length;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index] ?? "";
    if (part === "") continue;
    const at = name.indexOf(part, position);
    if (at === -1 || at + part.length > end) return false;
    position = at + part.length;
  }
  return true;
}

/**
 * The policy's verdict for `toolName`: the first matching entry, else the
 * unmapped-tool default, else not gated.
 */
export function toolMapVerdict(policy: Policy, toolName: string): ToolMapVerdict {
  const entries = policy.tools ?? [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (matchesToolPattern(entry.match, toolName)) {
      return { kind: "mapped", cls: entry.class, match: entry.match, index };
    }
  }
  const mode = policy.defaults?.unmapped_tool;
  if (mode === "record" || mode === "ask") {
    return { kind: "unmapped", cls: UNMAPPED_TOOL_CLASS, mode };
  }
  return { kind: "not-gated" };
}

/**
 * Is `cls` declared by `classes`: an exact key, or under a trailing family key
 * `<prefix>.*` whose literal prefix it extends?
 *
 * The family half is the reading `agent_may_request` gives a family (APRV-445):
 * interior wildcards and the bare `*` are not families, because a pattern that
 * could match across branches would declare classes nobody looked at.
 */
export function classDeclared(classes: Record<string, unknown>, cls: string): boolean {
  if (Object.prototype.hasOwnProperty.call(classes, cls)) return true;
  const segments = cls.split(".");
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const family = `${segments.slice(0, length).join(".")}.*`;
    if (Object.prototype.hasOwnProperty.call(classes, family)) return true;
  }
  return false;
}

/**
 * The load-time checks on `tools` that no JSON Schema can state, because each
 * relates an entry to another part of the file (APRV-499).
 *
 * Any error fails the WHOLE policy closed (`schema-invalid`), exactly as a
 * malformed glob does at the schema: a mapping its author believes is in force
 * and the runtime does not apply is the failure this project exists to
 * prevent, and the strict answer to it is every class `manual`.
 *
 * - An entry's `class` must be declared by `classes`. A class nothing prices
 *   would resolve by `defaults.autonomy`, which reads in the log as a decision
 *   the operator made about this app when they made none.
 * - An entry may not name {@link UNMAPPED_TOOL_CLASS}: that class asserts that
 *   no entry claimed the call, and a record saying so about a call an entry did
 *   claim would be false.
 * - Two entries may not share a `match`. The second can never decide, so its
 *   author would be reading a line that is not in force.
 */
export function toolMapErrors(policy: Policy): ValidationError[] {
  const errors: ValidationError[] = [];
  const entries = policy.tools ?? [];
  const classes = policy.classes ?? {};
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const at = `/tools/${String(index)}`;
    const earlier = seen.get(entry.match);
    if (earlier !== undefined) {
      errors.push({
        path: `${at}/match`,
        keyword: "tool-match-duplicate",
        message: `match ${JSON.stringify(entry.match)} repeats entry ${String(earlier)}; the first matching entry decides, so this one could never be read`,
      });
    } else {
      seen.set(entry.match, index);
    }
    if (entry.class === UNMAPPED_TOOL_CLASS) {
      errors.push({
        path: `${at}/class`,
        keyword: "tool-class-reserved",
        message: `${UNMAPPED_TOOL_CLASS} names the calls no tools entry claims, so an entry may not map to it; price unmapped calls with defaults.unmapped_tool or a classes line for ${UNMAPPED_TOOL_CLASS}`,
      });
      return;
    }
    if (!classDeclared(classes, entry.class)) {
      errors.push({
        path: `${at}/class`,
        keyword: "tool-class-undeclared",
        message: `class ${JSON.stringify(entry.class)} is not declared by classes (as an exact key or under a trailing <prefix>.* family key); declare it so the mapping resolves under a line the policy wrote rather than defaults.autonomy`,
      });
    }
  });
  return errors;
}
