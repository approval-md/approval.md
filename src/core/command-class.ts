/**
 * Shell command classification: a pure, deterministic map from a command line
 * to the SPEC.md §7 side-effect classes it would produce (APRV-82).
 *
 * This is the input half of the Claude Code PreToolUse hook. The harness hands
 * us a command string it is about to run; policy speaks in classes; something
 * has to translate. That translation is the reviewable artifact of this task, so
 * it lives in one file, is data-driven, and is exhaustively fixture-tested.
 *
 * Three properties are load-bearing.
 *
 * **Pure.** No filesystem, no clock, no environment, no network. The same string
 * always yields the same answer, which is what makes the fixture table a real
 * specification rather than a sample of observed behaviour.
 *
 * **Fail closed, in three named ways.** A construct whose effect cannot be read
 * off the text is `opaque` (`bash -c`, `eval`, backticks, a tainting command
 * substitution). A binary the table does not know is `unclassified`. A string
 * the tokenizer cannot even split is `unparseable`. All three are refusals, and
 * the hook denies on each: the alternative, guessing a class for a command we do
 * not understand, would let the least legible command lines through the widest
 * gap. Ambiguity inside a construct we DO understand resolves to the stricter
 * class (`git push` with no refspec is `vcs.push.main`, an `rm` path holding an
 * unexpanded `$VAR` is `files.delete.out_of_scope`).
 *
 * **Best effort, and honest about it.** This is a classifier over shell text,
 * not a shell. It is a speed bump against an agent doing the wrong thing by
 * mistake, in the SPEC.md §11 sense; it is not scheming-robust, and nothing here
 * claims otherwise. The hard boundary stays where SPEC.md §10.4 puts it: the
 * credentials in the vault and the token an adapter demands.
 *
 * Self-reported text is never read. The hook passes the command only; the
 * harness's `description` field is authored by the very agent being gated
 * (SPEC.md §11.1: self-reported fields never reduce scrutiny).
 *
 * Two imports, and both are pure in exactly the same way this file is: no disk,
 * no clock, no environment, no dependencies.
 *
 * `core/read-scope.ts` (APRV-347) holds the read-side path arithmetic, so the
 * hook and the policy explainer can ask the same questions this file asks, of
 * the same table, rather than each growing a copy of it.
 *
 * `core/policy-match.ts` (APRV-354) is imported for ONE name, the
 * `harness.launch.` prefix. The classifier emits the family and two enforcement
 * paths refuse a member of it that no policy rule names, so the three have to
 * agree on what the family is; a second spelling of the prefix would close one
 * of those doors and leave the other open. The import is type-safe in the
 * dependency sense as well: `policy-match.ts` itself imports only types.
 */

import { isDateDisplay, isZoneValue } from "./date-argv.js";
import { isUnreadablePushWord, parseGitPushArgv, splitGitPush } from "./git-push-argv.js";
import {
  isBareInfo,
  isDfDisplay,
  isFreeDisplay,
  isHostnameDisplay,
  isPasteRead,
  isSeqDisplay,
} from "./sysinfo-argv.js";
import { HARNESS_LAUNCH_PREFIX } from "./policy-match.js";
import {
  READ_OUT_OF_SCOPE_CLASS,
  isUnreadableTarget,
  readTargetVerdict,
  readTargetsOf,
} from "./read-scope.js";
import {
  eachNameReading,
  foldFileName,
  foldNameExact,
  foldNameLower,
  nameListIncludes,
  SUBSTITUTION_SENTINEL,
  takeAmongEqual,
  withNamesAsSpelled,
} from "./name-fold.js";

// ===========================================================================
// Result shape
// ===========================================================================

/** Why a command could not be classified. Each denies; none is a soft failure. */
export type ClassifierFailureCode = "unclassified" | "opaque" | "unparseable";

/** One command in a pipeline or list, with the class it resolved to. */
export interface ClassifiedSegment {
  /** The segment's source text, as written. */
  text: string;
  /** The dotted side-effect class (SPEC.md §7). */
  class: string;
  /** Which rule decided it, for `hook classify` output and for tests. */
  rule: string;
  /**
   * The protected path that selected the class, present only when one did
   * (APRV-143).
   *
   * The protected classes (`policy.edit`, `policy.core`, `log.mutate`) are the
   * classes a segment can take because of a *value* in it rather than because
   * of its binary, and until this field the value was discarded the moment the
   * rule fired: an approver was told the class and left to guess which of six
   * arguments earned it. It is the word the classifier matched, verbatim, so a
   * channel can name it without a second search of its own.
   */
  path?: string;
  /**
   * The sandbox wrapper this segment runs inside, when the classifier unwrapped
   * one (APRV-193). Absent means "not wrapped, as far as this classifier can
   * tell", which is the direction every caller must fail in: the marker is only
   * ever read to RELAX a requirement, so an early return that omits it costs a
   * refusal and never an authorization.
   *
   * `runtime` is `approval sandbox -- …`, whose profile this runtime writes.
   * `external` is a hand-written `sandbox-exec -f <profile> …`, which is
   * classified honestly (by its inner argv) and trusted for nothing: the
   * profile is the caller's, and a profile a caller wrote can allow anything.
   */
  sandbox?: SandboxWrapper;
  /**
   * The program an `exec.code` segment runs, present only on such a segment
   * (APRV-510). Text only, like everything this file returns: the hook hashes
   * the inline source, or reads and hashes the file, and binds the hash and the
   * length, never the text (SPEC.md §11.1 invariant 3).
   */
  execCode?: ExecCodeSource;
  /**
   * The no-rule detail of a segment no built-in rule covers, present only on
   * the {@link NO_RULE_CLASS} stand-in a {@link ClassifierContext.noRuleSegments}
   * caller asked for.
   */
  noRule?: string;
}

/**
 * The class a segment no built-in rule covers takes under
 * {@link ClassifierContext.noRuleSegments}. Undotted, so no policy pattern
 * names it; the hook answers it before any class is resolved.
 */
export const NO_RULE_CLASS = "unclassified";

/**
 * What an `exec.code` segment runs, as the classifier read it (APRV-510).
 *
 * `source` is the inline program (`python3 -c <source>`, `node -e <source>`,
 * `deno eval <source>`) or the file path as written (`python3 <source>`,
 * `bun <source>`). `argv` is the segment's argv from the binary on, verbatim,
 * and `sourceIndex` names the word of `argv` that carries `source`, so a
 * caller can bind the argv with that one word replaced by its hash.
 */
export interface ExecCodeSource {
  interpreter: string;
  mode: ExecCodeMode;
  source: string;
  argv: string[];
  sourceIndex: number;
}

/** How an `exec.code` segment carries its program (APRV-510). */
export type ExecCodeMode = "inline" | "file";

/**
 * Who wrote the profile a wrapped command runs under (APRV-193).
 *
 * The distinction is the whole reason this is not a boolean. Classification
 * treats the two identically — both are unwrapped to the inner argv, because a
 * wrapper is a room and the class belongs to what runs in it. Enforcement does
 * not: `APPROVAL_HOOK_REQUIRE_SANDBOX` is satisfied only by `runtime`, because
 * `sandbox-exec -f /tmp/anything.sb` with a profile whose only line is
 * `(allow default)` denies nothing at all, and a requirement a caller can meet
 * by writing their own permission is not a requirement.
 */
export type SandboxWrapper = "runtime" | "external";

export type CommandClassification =
  | { ok: true; segments: ClassifiedSegment[]; classes: string[] }
  | {
      ok: false;
      code: ClassifierFailureCode;
      /** The segment (or whole command) that could not be read. */
      segment: string;
      detail: string;
    };

/**
 * The pass-through pseudo-class for the gate's own CLI.
 *
 * `approval …` is already the enforcement path — gating it with itself would
 * either deadlock (the hook waiting on a decision that `approval grant` cannot
 * deliver) or recurse. The hook allows this class without touching the log; it
 * is never written to any envelope and no policy rule should name it.
 */
export const GATE_SELF_CLASS = "gate.self";

// ===========================================================================
// Protected paths (policy.edit, policy.core, log.mutate)
// ===========================================================================

/**
 * The three classes a protected path can select (APRV-198).
 *
 * One class used to cover the whole protected surface, so a policy could not
 * say "an agent may edit the prose that describes the gate, under sampling,
 * and may never touch the gate itself". These are that sentence, in the order
 * of decreasing consequence:
 *
 * - `log.mutate` — anything aimed at `.approval/log/`. The log is the truth;
 *   a write to it is not an edit of the rules, it is an edit of the record of
 *   what happened.
 * - `policy.core` — the policy file itself and the rest of the gate's own
 *   directory (env, payload store, vault, keys, `QUEUE.md`), plus the harness
 *   files that install the hook. An agent that can write these can write
 *   itself out of the gate without the gate ever seeing it.
 * - `policy.edit` — the prose and configuration ABOUT the gate: the agent
 *   instructions, CI and release configuration, and whatever paths the policy
 *   itself protects. Reviewable after the fact, and the only one of the three
 *   a policy can sensibly sample.
 */
export type ProtectedPathClass = "log.mutate" | "policy.core" | "policy.edit";

/**
 * The class a write under `$HERMES_HOME/scripts/` takes (APRV-445): scheduling
 * code that Hermes's cron runs later with no hook in front of it. Returned by
 * {@link protectedPathClass} beside the organs, ranked with `policy.edit`, and
 * deliberately not a {@link ProtectedPathClass}: it is a side effect an
 * operator prices, not a surface of the gate itself.
 */
export const HERMES_SCHEDULED_SCRIPT_CLASS = "cron.manage";

/**
 * The `policy.edit` sub-class namespace a `protected_paths` entry may route to
 * (APRV-266).
 *
 * One protected surface with one autonomy was the shape until now, so a policy
 * that wanted its specification sampled at one tenth and its release workflows
 * gated every time had to choose one of those numbers for both. A routed entry
 * says which sub-class a path family takes, and the sub-class is an ordinary
 * §7 class with an ordinary policy line, so each family gets its own autonomy
 * and its own live rate without any new grammar in `classes`.
 *
 * The namespace is closed to ONE extra segment under `policy.edit` and nothing
 * else. A policy may not route a path to `policy.core`, to `log.mutate`, or to
 * any class outside this namespace: those are the gate's own organs and the
 * record of what happened, and §11.1 invariant 9 reserves them — a policy
 * widening its own protected surface is naming prose and configuration, and
 * mints no authority over anything else. `policy.schema.json` enforces the
 * shape; this pattern is the same rule where the matcher can see it.
 */
export const POLICY_EDIT_SUBCLASS = /^policy\.edit\.[a-z][a-z0-9-]*$/u;

/**
 * Sub-class names this spec reserves, with the meaning an implementation must
 * give them (APRV-266).
 *
 * Reserved so that two policies written by two people mean the same thing by
 * `policy.edit.ci`, and so a reader of somebody else's policy does not have to
 * infer it. An author is free to mint their own word beside these — the pattern
 * above admits any lowercase word — and a minted name carries only the meaning
 * its own policy line gives it.
 */
export const RESERVED_POLICY_EDIT_SUBCLASSES: Readonly<Record<string, string>> = {
  "policy.edit.spec": "the project's governing specification and its amendments",
  "policy.edit.harness": "agent instruction files and harness configuration that is not the hook itself",
  "policy.edit.ci": "continuous-integration and release configuration",
  "policy.edit.design": "design documents and decision records",
};

/**
 * One `protected_paths` entry: a bare path, or a path routed to a sub-class.
 *
 * The bare string is the APRV-107 spelling and keeps its meaning exactly —
 * `policy.edit`, as though the object form did not exist. Nothing about a
 * string-only policy changes by a byte, which is the compatibility rule this
 * type exists to state: `approval hook classify` over such a policy answers
 * today's class with today's rule name.
 */
export type ProtectedPathEntry = string | { path: string; class: string };

/**
 * Files whose edit is `policy.core` wherever they sit: the policy itself,
 * under either spelling.
 */
const CORE_FILENAMES: readonly string[] = ["APPROVAL.md", "APPROVALS.md"];

/**
 * Files whose edit is `policy.edit` wherever they sit: the agent instructions
 * that carry the policy's authority in prose, and the release configuration.
 */
const PROTECTED_FILENAMES: readonly string[] = ["CLAUDE.md", "AGENTS.md", ".npmrc"];

// {@link CORE_FILENAMES} and {@link PROTECTED_FILENAMES} are compared through
// {@link nameListIncludes}: folded (APFS opens `approval.md` and `Claude.MD` as
// the policy file and the instructions) in the folded reading, exactly as
// written in the as-spelled one (see `name-fold.ts`).

/** Split a path into segments, dropping `./` noise. Never touches the disk. */
function pathSegments(candidate: string): string[] {
  return candidate
    .split(/[/\\]+/u)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * One entry of `policy.protected_paths`, pre-split (APRV-107).
 *
 * `directory` records the trailing `/` that distinguishes `design/` (a subtree)
 * from `design` (a file named `design`).
 */
interface ProtectedEntry {
  segments: string[];
  directory: boolean;
  /**
   * The class this entry routes to (APRV-266). `null` for a bare string entry,
   * which means `policy.edit` and is matched in the built-in `policy.edit`
   * tier exactly where it always was.
   */
  routed: string | null;
}

/**
 * Read one `policy.protected_paths` entry, or `null` when it names nothing.
 *
 * The schema already rejects globs, absolute paths and `..` segments; this
 * repeats the structural half of that check so a caller that skipped
 * validation gets an entry that matches nothing rather than an entry that
 * matches surprisingly. Pure, like everything else here: no resolution against
 * a checkout, no disk.
 *
 * The same defensiveness covers the routed form (APRV-266): an object whose
 * `class` is not a well-formed `policy.edit` sub-class matches NOTHING at all
 * rather than falling back to `policy.edit`. A silent fallback would be the
 * worst of the three available answers — the author would read their file and
 * see a rate that is not the rate in force — and the loader refuses such a
 * policy outright, so this branch is only ever reached by a caller that
 * skipped validation.
 */
export function parseProtectedEntry(entry: ProtectedPathEntry): ProtectedEntry | null {
  const raw = typeof entry === "string" ? entry : entry.path;
  const routed = typeof entry === "string" ? null : entry.class;
  if (typeof raw !== "string") return null;
  if (routed !== null && (typeof routed !== "string" || !POLICY_EDIT_SUBCLASS.test(routed))) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const directory = /[/\\]$/u.test(trimmed);
  const segments = pathSegments(trimmed);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  return { segments, directory, routed };
}

/**
 * Does `segments` match one parsed entry? Both sides are compared folded
 * ({@link foldNameExact}), as the built-in names are: a policy that protects
 * `design/` protects `Design/` on a volume that opens it as the same folder.
 * `segments` must arrive through the same helper, as
 * {@link protectedPathClassOfWord}, the only caller, passes them. In the
 * as-spelled reading both sides are exact, as they were before names folded;
 * the caller reports both readings, so a fold that makes a second entry match
 * (`SPEC/` beside `spec/`) adds its class and never replaces the old one.
 */
function matchesEntry(segments: readonly string[], entry: ProtectedEntry): boolean {
  const want = entry.segments.map(foldNameExact);
  const have = segments;
  if (want.length > have.length) return false;
  if (entry.directory) {
    // A directory prefix matches wherever its segments appear as a contiguous
    // run, exactly as the built-in `.approval/` and `.github/workflows/` do.
    for (let start = 0; start + want.length <= have.length; start += 1) {
      if (want.every((segment, offset) => segment === have[start + offset])) return true;
    }
    return false;
  }
  // An exact path matches when the candidate ENDS with it: `docs/x.md` matches
  // `/repo/docs/x.md` and `./docs/x.md`, and a bare filename (a one-segment
  // entry) matches that filename in any directory, which is how the built-in
  // filenames have always behaved.
  const offset = have.length - want.length;
  return want.every((segment, index) => segment === have[offset + index]);
}

/** The most words one brace-expanded path may stand for before it is judged unknown. */
const BRACE_EXPANSION_CAP = 256;

/**
 * The most group expansions one word may take before it is judged unknown
 * (APRV-511 refuter recheck S(new)). Each step rescans the word once, so this
 * bounds the work a crafted word can cost, including a long run of groups that
 * each collapse to one word (`{s..s}{s..s}…`), which the word cap alone would
 * never stop.
 */
const BRACE_EXPANSION_STEPS = 1024;

/**
 * The words bash's brace expansion makes of `word`, or `null` when there would
 * be more than {@link BRACE_EXPANSION_CAP}, or making them would take more than
 * {@link BRACE_EXPANSION_STEPS} expansions (APRV-511 refuter M2, recheck S(new)).
 *
 * A group is `{` … `}` holding a top-level comma (`{a,b}`, `{,s}`) or a
 * sequence (`{1..3}`, `{a..c}`, `{1..9..2}`); a `{` right after `$` opens a
 * parameter expansion and is never a group, and anything else stays literal,
 * as it does in bash. Groups nest and multiply. The lexer has already removed
 * quoting, so a quoted brace pair reads as a group too, which can only make an
 * answer stricter.
 *
 * The expansion is iterative, never recursive: a work list holds the words
 * still carrying a group, and both bounds are tested BEFORE a word is
 * expanded further, so no input reaches the stack limit or runs unbounded.
 * Every caller reads `null` as the stricter class.
 */
export function braceExpansions(word: string): string[] | null {
  const results: string[] = [];
  const pending: string[] = [word];
  let steps = 0;
  while (pending.length > 0) {
    const text = pending.pop() as string;
    const group = firstBraceGroup(text);
    if (group === null) {
      results.push(text);
      if (results.length > BRACE_EXPANSION_CAP) return null;
      continue;
    }
    steps += 1;
    if (steps > BRACE_EXPANSION_STEPS) return null;
    if (results.length + pending.length + group.alternatives.length > BRACE_EXPANSION_CAP) return null;
    // Pushed in reverse so the words come out in bash's left-to-right order.
    for (let index = group.alternatives.length - 1; index >= 0; index -= 1) {
      const next = text.slice(0, group.open) + (group.alternatives[index] as string) + text.slice(group.close + 1);
      // Only an expansion that changed the word is expanded again; one that
      // did not (which a well-formed group never makes) is a literal word.
      if (next === text) results.push(next);
      else pending.push(next);
    }
  }
  return results;
}

/**
 * The words a path word may stand for once bash has expanded its brace groups,
 * plus, for any word that still carries a stray `{` or `}` outside a parameter
 * expansion, the same word with the stray braces removed (APRV-511 review).
 * Bash keeps a stray brace literally (`{~/.hermes/.op.env` names a directory
 * called `{~`), but a word whose only distance from an organ or a credential is
 * a stray brace is judged as that organ: the stricter of the two readings.
 * `null` when the expansion exceeds {@link BRACE_EXPANSION_CAP}, unless every
 * group is a sequence or list of plain numbers ({@link numericRepresentative}).
 */
export function braceCandidates(word: string): string[] | null {
  const expanded = braceExpansions(word) ?? numericRepresentative(word);
  if (expanded === null) return null;
  const out = [...expanded];
  for (const each of expanded) {
    const outsideParameters = each.replace(/\$\{[^{}]*\}/gu, "");
    if (/[{}]/u.test(outsideParameters)) {
      const stripped = each.replace(/\$\{[^{}]*\}|[{}]/gu, (match) => (match.length > 1 ? match : ""));
      if (!out.includes(stripped)) out.push(stripped);
    }
  }
  return out;
}

/**
 * A word over the brace cap whose every group yields plain numbers only
 * (`{1..300}`, `notes{1..500}.md`, `d{1..9}{0..99}`), as its FIRST expansion
 * (APRV-511 fix round 3, N-a). Its words differ from one another only in runs
 * of digits, and no organ or credential name turns on a digit, so the first
 * answers for all of them; `echo {1..300}` stays `read.shell` instead of
 * refusing as a credential read. `null` when any group yields anything else
 * (`{a..z}{a..z}` can spell a name), which stays the stricter class.
 */
function numericRepresentative(word: string): string[] | null {
  let text = word;
  for (let steps = 0; steps < BRACE_EXPANSION_STEPS; steps += 1) {
    const group = firstBraceGroup(text);
    if (group === null) return [text];
    const first = group.alternatives[0];
    if (first === undefined || !group.alternatives.every((each) => /^-?\d+$/u.test(each))) return null;
    text = text.slice(0, group.open) + first + text.slice(group.close + 1);
  }
  return null;
}

/** The longest text between a sequence's braces (`-2147483648..2147483647..1` fits). */
const BRACE_SEQUENCE_MAX = 64;

/**
 * The first brace group in `text`, with its alternatives, or `null`.
 *
 * One left-to-right pass pairs every brace (a `${` opener pairs too, so its
 * `}` never closes a group, but it never opens one); an unmatched `{` is
 * literal to bash, which keeps scanning for a later group (APRV-511 review:
 * `.op.en{v,v}{` still expands its group). The first group is the valid pair
 * with the leftmost opener. Linear in `text` (APRV-511 recheck S(new)).
 */
function firstBraceGroup(text: string): { open: number; close: number; alternatives: string[] } | null {
  const stack: { open: number; parameter: boolean; commas: number[] }[] = [];
  let best: { open: number; close: number; commas: number[] } | null = null;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at];
    if (ch === "{") stack.push({ open: at, parameter: at > 0 && text[at - 1] === "$", commas: [] });
    else if (ch === "}") {
      const pair = stack.pop();
      if (pair === undefined || pair.parameter) continue;
      if (best !== null && best.open < pair.open) continue;
      if (pair.commas.length > 0) best = { open: pair.open, close: at, commas: pair.commas };
      else if (at - pair.open - 1 <= BRACE_SEQUENCE_MAX && braceSequence(text.slice(pair.open + 1, at)) !== null) {
        best = { open: pair.open, close: at, commas: [] };
      }
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.commas.push(at);
    }
  }
  if (best === null) return null;
  if (best.commas.length === 0) {
    return { open: best.open, close: best.close, alternatives: braceSequence(text.slice(best.open + 1, best.close)) ?? [] };
  }
  const alternatives: string[] = [];
  let from = best.open + 1;
  for (const comma of [...best.commas, best.close]) {
    alternatives.push(text.slice(from, comma));
    from = comma + 1;
  }
  return { open: best.open, close: best.close, alternatives };
}

/** `1..3`, `a..c`, `1..9..2` as bash expands them, or `null` when not a sequence. */
function braceSequence(inner: string): string[] | null {
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/u.exec(inner);
  if (match === null) return null;
  const [, from, to, stepText] = match as unknown as [string, string, string, string | undefined];
  const numeric = /^-?\d+$/u.test(from) && /^-?\d+$/u.test(to);
  if (!numeric && (/\d/u.test(from) || /\d/u.test(to))) return null;
  const start = numeric ? Number(from) : from.charCodeAt(0);
  const end = numeric ? Number(to) : to.charCodeAt(0);
  const step = Math.max(1, Math.abs(Number(stepText ?? "1")));
  const out: string[] = [];
  for (let value = start; start <= end ? value <= end : value >= end; value += start <= end ? step : -step) {
    out.push(numeric ? String(value) : String.fromCharCode(value));
    if (out.length > BRACE_EXPANSION_CAP) break;
  }
  return out;
}

/**
 * A braced parameter expansion collapsed to its bare name, `${NAME}`, before a
 * path is split into segments (APRV-511 review round 3). An operator inside the
 * braces may carry a slash (`${HERMES_HOME:-/x}/config.yaml`), which would
 * otherwise split the expansion across segments so that neither half reads as
 * the home; collapsed, `${HERMES_HOME:-/x}` is the home, as it is whenever the
 * variable is set, and any other name is a variable segment as before.
 */
function collapseBracedVariables(candidate: string): string {
  return candidate.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/gu, "${$1}");
}

/**
 * Does this path segment name a Hermes home (APRV-511)?
 *
 * - `"home"`: the `.hermes` segment, compared without case (a case-insensitive
 *   filesystem, macOS's default, opens `~/.Hermes/plugins` as the home's), or an
 *   unexpanded `$HERMES_HOME` / `${HERMES_HOME}`, which is the home whatever it
 *   expands to. Before this the pure classifier read `>> $HERMES_HOME/.env` as
 *   a workspace write: the Hermes hook's disk pass expanded it, but a caller
 *   with no disk pass (`approval hook classify`, Claude Code, Cursor) did not.
 * - `"maybe"`: any other segment carrying an unexpanded variable (`$X`,
 *   `${OUT}`, `pre$N`), which can expand to the home; only the organ and
 *   credential rows below it apply, never the bare-home or scheduler rows,
 *   since `$OUT` alone or `$OUT/scripts/x.sh` is ordinary work far more often.
 */
function hermesHomeKind(segment: string): "home" | "maybe" | null {
  // Folded ({@link foldFileName}): `.HERMES` and `.herme<U+017F>` are the home on APFS.
  if (foldNameLower(segment) === ".hermes") return "home";
  if (segment === "$HERMES_HOME" || segment === "${HERMES_HOME}") return "home";
  if (/\$(?:[A-Za-z_]|\{)/u.test(segment)) return "maybe";
  return null;
}

/**
 * What the Hermes rows ask of every tail of one segment list, each answer in
 * constant time after one linear pass (the lead's S2 on #688: "the home tail
 * sliced once, not per segment"). The answers are exactly the ones the walk
 * below gave when it sliced and re-walked the tail at every home segment,
 * which made a path of many home segments cost the square of its length.
 *
 * The rule each answer states (APRV-511): a tail below a home is judged twice,
 * as spelled and with its `..` segments resolved, and the strictest answer is
 * the tail's. A tail whose `..` climbs out of the home has no resolved
 * reading; the segment walk meets any later home on its own. The `.codex`
 * row's rule, that a `..` under the organ directory is itself the organ, is
 * the precedent; resolving instead keeps `~/.hermes/workspace/../workspace/x`
 * ordinary. A variable segment that MAY be the home (APRV-511 refuter M1)
 * stands over the tail as written and the rest after each `..` in it, since
 * `$X/../plugins/x` is the plugin directory when `$X` is any directory one
 * level under the home (`$(pwd)/../plugins/x` from the workspace).
 *
 * Why each answer is constant time: a judge reads at most the first four
 * segments of a tail (`profiles/<p>/` and then two names), so only the first
 * four of the tail as spelled and of the tail resolved matter. With `P[k]` the
 * count of names minus the count of `..` in `segments[0..k)`, the walk from
 * `start` climbs out exactly when some later `P[m]` falls below `P[start]`,
 * and a name at `j` is popped by a later `..` exactly when some `P[m]`, `m > j`,
 * returns to `P[j]`. Neither depends on where the walk began, so the resolved
 * tail is the run of never-popped names from `start` on, found by a
 * next-survivor table. The `fuzz` of `tests/guarded-names-fold-case.test.ts`
 * holds this against the per-segment walk.
 */
export interface HermesTails {
  /** Does `segments[start..]` hold a `..`? */
  dotdotFrom(start: number): boolean;
  /** The organ class of the tail `segments[start..]` below a home (`policy.core`, `cron.manage` or `null`). */
  organClass(start: number): string | null;
  /** Below a MAYBE home: does the tail, or the rest after any `..` in it, non-empty, take `policy.core`? */
  maybeOrgan(start: number): boolean;
  /** Is the tail `segments[start..]` below a home credential material? */
  credential(start: number): boolean;
  /** Below a MAYBE home: is the tail, or the rest after any `..` in it, credential material? */
  maybeCredential(start: number): boolean;
}

/** The strictest of a tail's answers, in the order the walk has always ranked them. */
const HERMES_TAIL_RANK: readonly string[] = ["policy.core", HERMES_SCHEDULED_SCRIPT_CLASS, "credential"];

function credentialJudge(tail: readonly string[]): string | null {
  return hermesCredentialTail(tail) ? "credential" : null;
}

/** Build the {@link HermesTails} of one segment list: linear time and space. Exported for its fuzz test. */
export function hermesTails(segments: readonly string[]): HermesTails {
  const n = segments.length;
  const dot = segments.map((segment) => segment === "..");
  const P = new Int32Array(n + 1);
  for (let k = 0; k < n; k += 1) P[k + 1] = (P[k] as number) + (dot[k] === true ? -1 : 1);
  // sufMin[k] = min P[m] over m in [k, n]; sufMin[n + 1] stands for "none".
  const sufMin = new Int32Array(n + 2);
  sufMin[n + 1] = 2147483647;
  for (let k = n; k >= 0; k -= 1) sufMin[k] = Math.min(P[k] as number, sufMin[k + 1] as number);
  const dotFrom = new Uint8Array(n + 1);
  for (let k = n - 1; k >= 0; k -= 1) dotFrom[k] = dot[k] === true || dotFrom[k + 1] === 1 ? 1 : 0;
  // nextSurvivor[k]: the first name at or after k that no later `..` pops, or n.
  const nextSurvivor = new Int32Array(n + 1);
  nextSurvivor[n] = n;
  for (let k = n - 1; k >= 0; k -= 1) {
    const survives = dot[k] !== true && (sufMin[k + 1] as number) > (P[k] as number);
    nextSurvivor[k] = survives ? k : (nextSurvivor[k + 1] as number);
  }
  const escapes = (start: number): boolean => start < n && (sufMin[start + 1] as number) < (P[start] as number);
  const resolvedHead = (start: number): string[] => {
    const out: string[] = [];
    for (let j = nextSurvivor[start] as number; j < n && out.length < 4; j = nextSurvivor[j + 1] as number) {
      out.push(segments[j] as string);
    }
    return out;
  };
  const tailClass = (start: number, judge: (tail: readonly string[]) => string | null): string | null => {
    const answers = [judge(segments.slice(start, start + 4))];
    if (!escapes(start) && dotFrom[start] === 1) answers.push(judge(resolvedHead(start)));
    for (const strictest of HERMES_TAIL_RANK) if (answers.includes(strictest)) return strictest;
    return null;
  };
  const memo = (judge: (start: number) => boolean): ((start: number) => boolean) => {
    const seen = new Map<number, boolean>();
    return (start) => {
      let answer = seen.get(start);
      if (answer === undefined) {
        answer = judge(start);
        seen.set(start, answer);
      }
      return answer;
    };
  };
  // Below a maybe home: the tail from `start`, or the rest after any `..` at
  // or after `start`. `afterDot[k]`: some `..` at m >= k has a good rest m + 1.
  const maybe = (good: (start: number) => boolean): ((start: number) => boolean) => {
    let afterDot: Uint8Array | null = null;
    return (start) => {
      if (good(start)) return true;
      if (afterDot === null) {
        afterDot = new Uint8Array(n + 1);
        for (let k = n - 1; k >= 0; k -= 1) afterDot[k] = (dot[k] === true && good(k + 1)) || afterDot[k + 1] === 1 ? 1 : 0;
      }
      return afterDot[start] === 1;
    };
  };
  const organMemo = new Map<number, string | null>();
  const organClass = (start: number): string | null => {
    if (!organMemo.has(start)) organMemo.set(start, tailClass(start, hermesOrganClass));
    return organMemo.get(start) ?? null;
  };
  const credential = memo((start) => tailClass(start, credentialJudge) !== null);
  return {
    dotdotFrom: (start) => dotFrom[start] === 1,
    organClass,
    maybeOrgan: maybe(memo((start) => start < n && organClass(start) === "policy.core")),
    credential,
    maybeCredential: maybe(credential),
  };
}

/** The tail below a profile home (`profiles/<p>/...`), or the tail itself. */
function hermesProfileTail(tail: readonly string[]): readonly string[] {
  const first = tail[0];
  return first !== undefined && foldNameLower(first) === "profiles" && tail[1] !== undefined ? tail.slice(2) : tail;
}

/**
 * The class a write below a Hermes home takes, by the home's organ rows
 * (APRV-398, APRV-445, APRV-511). Names compare folded ({@link foldFileName}).
 */
function hermesOrganClass(fullTail: readonly string[]): string | null {
  const tail = hermesProfileTail(fullTail);
  const next = tail[0] === undefined ? undefined : foldNameLower(tail[0]);
  if (
    next === undefined ||
    next === "config.yaml" ||
    next === "config.yml" ||
    next === "agent-hooks" ||
    next === "approval" ||
    next === ".env" ||
    next.startsWith(".env.") ||
    next === "auth.json" ||
    next.startsWith("shell-hooks-allowlist.json") ||
    next.startsWith("hooks") ||
    next === "hermes-agent" ||
    next === "plugins" ||
    next === ".op.env" ||
    next.startsWith(".op.env.")
  ) {
    return "policy.core";
  }
  if (next === "scripts") return HERMES_SCHEDULED_SCRIPT_CLASS;
  return null;
}

/**
 * Is the file below a Hermes home credential material (APRV-398, APRV-511)?
 *
 * `.env`, `.env.*` and `auth.json`, as before; `.op.env` (and `.op.env.*`),
 * the 1Password bootstrap file Hermes loads into the gateway; and the source
 * install's `hermes-agent/.env` and `.env.*`, its PROJECT_ROOT dotenv, except
 * `.env.example`, the template the install ships. Reading the rest of the
 * runtime's source is not a credential read. Names compare folded
 * ({@link foldFileName}).
 */
function hermesCredentialTail(fullTail: readonly string[]): boolean {
  const tail = hermesProfileTail(fullTail);
  const next = tail[0] === undefined ? undefined : foldNameLower(tail[0]);
  if (next === undefined) return false;
  if (next === ".env" || next.startsWith(".env.")) return true;
  if (next === "auth.json") return true;
  if (next === ".op.env" || next.startsWith(".op.env.")) return true;
  if (next === "hermes-agent") {
    const file = tail[1] === undefined ? undefined : foldNameLower(tail[1]);
    // `.env.example` exactly: on a case-sensitive filesystem `.env.EXAMPLE` is
    // another file, and only the template the install ships is exempt.
    return file !== undefined && (file === ".env" || (file.startsWith(".env.") && tail[1] !== ".env.example"));
  }
  return false;
}

/**
 * Which protected class does this path name, if any? (APRV-198.)
 *
 * Deliberately name-based rather than location-based: the hook runs in whatever
 * directory the harness is in, and a classifier that resolved paths against a
 * checkout would answer differently in a worktree than in the primary. A
 * false positive here costs one approval prompt; a false negative costs the
 * property the whole file exists to defend.
 *
 * **The check order IS the precedence.** A path is answered by the strictest
 * surface it names, `log.mutate` first, then `policy.core`, then
 * `policy.edit`: `.approval/log/events.jsonl` is a log write and not merely an
 * approval-home write, and a `policy.protected_paths` entry that happens to
 * name a built-in surface cannot demote it, because the built-ins are matched
 * before the policy's own list is read.
 *
 * `extra` carries `policy.protected_paths` (APRV-107). It is strictly
 * ADDITIVE: the built-in set above is protected whatever a policy says, so a
 * policy can widen the protected surface and can never narrow it, and every
 * path it adds in the APRV-107 bare-string spelling lands on `policy.edit` —
 * the reviewable class — because a policy widening its own surface is naming
 * prose and configuration, not minting authority over the gate's organs. Still
 * pure: the caller loads the policy, this function only matches segments.
 *
 * ## Routed entries (APRV-266)
 *
 * An entry written as `{path, class}` answers with the class it names, and the
 * routed tier sits between the built-in `policy.core` tier and the built-in
 * `policy.edit` tier. That position is the whole of the routing rule:
 *
 * - It is BELOW `log.mutate` and `policy.core`, so a routing can never reach
 *   the log or the gate's own organs. `{path: .approval/, class:
 *   policy.edit.home}` matches nothing, because tier 2 answered first — which
 *   is invariant 9's "no verb minting authority" holding at the one place a
 *   policy could otherwise have reached past it. The loader refuses such an
 *   entry outright rather than letting it sit inert.
 * - It is ABOVE the built-in `policy.edit` set, so a routing CAN re-label a
 *   built-in `policy.edit` path: `{path: .github/workflows/, class:
 *   policy.edit.ci}` is exactly the sentence a project wants to write. What
 *   stops that from being a demotion is not this function but the load-time
 *   floor in `policy-load.ts`, which refuses a policy whose routing would
 *   resolve a built-in path below what the `policy.edit` line itself resolves
 *   to. The classifier stays pure: it reports the class the policy named and
 *   judges no autonomy.
 *
 * Among several routed entries matching one path, the MOST SPECIFIC wins (most
 * segments). Most-specific is what a carve-out means — `design/` routed one way
 * and `design/frozen/` another. A tie is two entries of equal depth both
 * claiming one path (on a volume that folds names, `SPEC/` beside `spec/`),
 * which is the author's own ambiguity. A pure function cannot say which class
 * the policy holds stricter, so it reports every tied class, one per name
 * reading ({@link protectedPathClassReadings}), and the gate's strictest
 * decision answers. As spelled, the first declared answers alone, as it did
 * before names folded.
 *
 * A string-only `extra` cannot reach the routed tier at all, so a policy that
 * has not adopted the object form classifies byte for byte as it did before.
 *
 * ## Name readings
 *
 * This answers in the CURRENT name reading only (folded, unless the caller is
 * inside `withNamesAsSpelled`; see `name-fold.ts`). Folding can change which
 * class a path takes (`.approval/LOG/x` is `policy.core` as spelled and
 * `log.mutate` folded), so a caller that hands a class to a gate asks
 * {@link protectedPathClasses}, and a caller that grants something on the
 * answer asks {@link protectedPathClassReadings} and requires it of each.
 */
export function protectedPathClass(
  candidate: string,
  extra: readonly ProtectedPathEntry[] = [],
): string | null {
  if (candidate.length === 0) return null;
  // APRV-511 refuter M2: bash expands an unquoted brace group before the
  // command sees the word, so `~/.hermes/plugin{s,s}/x` IS the plugin
  // directory. Each expansion is judged and the strictest answers; a group too
  // large to expand is the stricter class.
  const expansions = braceCandidates(candidate);
  if (expansions === null) return "policy.core";
  let strictest: string | null = null;
  for (const expansion of expansions) {
    const cls = protectedPathClassOfWord(expansion, extra);
    if (cls !== null && (strictest === null || protectedRank(cls) < protectedRank(strictest))) strictest = cls;
  }
  return strictest;
}

// ===========================================================================
// Main's class beside every raise (lead ruling L61927; CLAIMS L61926)
// ===========================================================================
//
// GLOB-WRITE adds rules to main's classifier (glob write targets and their
// listings, organ-directory destinations and the bare organ directories, the
// dot-name rule, copies and landings, the zsh clobber redirects, the quoting
// and parameter readings). A rule may only ADD: wherever one fired on a line,
// the line is classified again with every GLOB-WRITE rule off (the classifier
// main has), and that answer joins the first as a name reading does
// ({@link unionNameReadings}): each class main gives rides beside, and a line
// main refuses stays refused. So no line's decision is looser than main's,
// under any policy. The second pass runs only where a rule fired.
//
// The switch is module state, like `name-fold.ts`'s reading: set only by
// {@link withMainRules}, whose `finally` restores it. The classifier is
// synchronous, so nothing runs in the other mode.

let mainRulesOnly = false;
let globWriteFired = false;

/** A GLOB-WRITE rule changed this line's answer: the main pass must run. */
function markGlobWriteFired(): void {
  if (!mainRulesOnly) globWriteFired = true;
}

/** {@link classifyCommand} with every GLOB-WRITE rule off: main's answer, the one the seam joins. */
export function classifyCommandWithMainRules(
  command: string,
  protectedPaths: readonly ProtectedPathEntry[] = [],
  context: ClassifierContext = {},
): CommandClassification {
  return withMainRules(() => classifyCommand(command, protectedPaths, context));
}

/** Run `run` with every GLOB-WRITE rule off (main's classifier), and restore the mode afterwards. */
function withMainRules<T>(run: () => T): T {
  const saved = mainRulesOnly;
  mainRulesOnly = true;
  try {
    return run();
  } finally {
    mainRulesOnly = saved;
  }
}

/**
 * Does the organ-directory rule ({@link bareOrganDirectory}) and its contents
 * rule ({@link folderContentClaims}) apply to the segment being classified?
 * FAIL CLOSED (lead ruling L62013, S2; security review of e9956c84): every
 * command naming the bare organ folder keeps the folder's class, a redirect
 * onto it included, except the short release list in {@link releasedFromOrganRule}:
 * commands that cannot remove, replace, move or change access to the entry.
 * Set per segment by {@link classifySegment}.
 */
let organVerbs = true;

/**
 * Lead ruling L62013 (S2): `mkdir` and `touch` keep main's class, so creating
 * a folder (or touching one) asks nothing new. Nothing else is released
 * (security reviews of e9956c84 and 8fe15089: a read such as `tar -c` was
 * released and could be made to delete by an option from the environment).
 *
 * Released only in the PLAIN form, each condition failing closed:
 * - the command word is the bare name `mkdir` or `touch`, first in the
 *   segment: no assignment before it (`PATH=/tmp mkdir`), no wrapper
 *   (`command`, `nice`, a sandbox), no path (`./mkdir`, `/bin/mkdir`);
 * - every word is exactly its text: no parameter, substitution, glob, brace,
 *   tilde or zsh pattern the shell may still expand into an option or another
 *   operand (`mkdir $X .claude`, `touch .cl*`, `mkdir -p {.claude,x}`);
 * - every option is one listed here, spelled in full (getopt_long would take
 *   a unique prefix; this list resolves none, so an abbreviation is held), and
 *   a valued option's value is consumed as its value, never as an operand.
 * `mkdir -m`/`--mode` is held: it leaves an existing folder's mode alone
 * (checked on macOS; GNU's manual says it sets the mode of created
 * directories), but it creates a missing one with that mode
 * (`mkdir -m 000 .claude` makes a locked folder).
 * A line that defines a function or alias, or sets `PATH`, is refused by main
 * already, and a refusal in main's pass refuses the line.
 */
function releasedFromOrganRule(segment: LexSegment): boolean {
  // The segment's FIRST word, compared whole: an assignment, a wrapper or a
  // path before or in it (`PATH=/tmp mkdir`, `nice touch`, `./mkdir`) is not
  // the bare name.
  const words = segment.words;
  const bin = words[0];
  if (bin === undefined) return false;
  // Every word exactly its text: no parameter (`splits`), substitution, glob or
  // brace (`expands`), leading tilde (`exact`), or zsh `#`, `^`, `~` where the
  // line may set options (`setopt extendedglob; touch .claude~x`). Each flag
  // is read; none is assumed to imply another.
  for (const word of words) {
    if (!word.exact || word.splits || word.expands || word.zshGlob !== false || word.substitutions.length > 0) return false;
  }
  const args = words.slice(1).map((word) => word.text);
  switch (bin.text) {
    case "mkdir":
      return onlyKnownOptions(args, { flags: "pv", valued: "", long: ["parents", "verbose"], longValued: [] });
    case "touch":
      return onlyKnownOptions(args, { flags: "acfhm", valued: "tdrA", long: ["no-create", "no-dereference"], longValued: ["date", "reference", "time"] });
    default:
      return false;
  }
}

interface KnownOptions {
  /** Short letters that take no value. */
  flags: string;
  /** Short letters that take a value (attached or the next word). */
  valued: string;
  /** Long options that take no value, in full. */
  long: readonly string[];
  /** Long options that take a value (`--name=v` or `--name v`), in full. */
  longValued: readonly string[];
}

/**
 * Is every option before `--` one of `known`, each long one spelled in full,
 * and does every valued option have its value? A value is consumed as the
 * value (`touch -r ref .claude`: `ref` is the reference, `.claude` the
 * operand); a valued option with nothing after it is not released.
 */
function onlyKnownOptions(args: readonly string[], known: KnownOptions): boolean {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") return true;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (known.long.includes(name) && eq === -1) continue;
      if (known.longValued.includes(name)) {
        if (eq === -1) {
          if (at + 1 >= args.length) return false;
          at += 1;
        }
        continue;
      }
      return false;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let index = 1; index < arg.length; index += 1) {
      const letter = arg[index] as string;
      if (known.flags.includes(letter)) continue;
      if (known.valued.includes(letter)) {
        if (index === arg.length - 1) {
          if (at + 1 >= args.length) return false;
          at += 1;
        }
        break;
      }
      return false;
    }
  }
  return true;
}

/**
 * Is `segments[index]` the organ directory ITSELF: the last segment, or one
 * whose tail comes back to it (`.claude/x/..`)? A tail that leaves it first
 * (`.claude/..`) names its parent, which this rule does not judge.
 */
function bareOrganDirectory(segments: readonly string[], index: number): boolean {
  if (mainRulesOnly || !organVerbs) return false;
  const bare = tailReturnsTo(segments, index);
  if (bare) markGlobWriteFired();
  return bare;
}

/** Does the tail after `segments[index]` come back to it (`x/..`, `.`), never leaving it first? */
function tailReturnsTo(segments: readonly string[], index: number): boolean {
  let depth = 0;
  for (const segment of segments.slice(index + 1)) {
    if (segment === "..") depth -= 1;
    else if (segment !== "." && segment.length > 0) depth += 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Paths under each organ folder whose built-in class may differ from the
 * folder's own (lead ruling L62013, S1): the folder's contents go with it.
 */
const FOLDER_CONTENTS: Readonly<Record<string, readonly string[]>> = {
  ".approval": ["log/x", "env"],
  ".claude": ["settings.json", "hooks/x"],
  ".cursor": ["hooks.json", "hooks/x", "agents/x"],
  ".grok": ["hooks.json", "hooks/x"],
  ".muse": ["hooks.json", "settings.json"],
  ".codex": ["config.toml", "hooks.json", "hooks/x"],
  ".github": ["workflows/x.yml"],
  ".hermes": [
    "config.yaml", "agent-hooks/x", "shell-hooks-allowlist.json", ".env", "auth.json", "approval/x", "scripts/x", "plugins/x",
    "hermes-agent/x", ".op.env",
  ],
};

/**
 * Lead ruling L62013 (S1): a command that removes, moves or changes access to
 * an organ folder ITSELF takes the class of every guarded path inside it, the
 * policy's routed entries included (`rm -rf .github` is `policy.edit.ci`
 * where `.github/workflows/` is routed there). The pure classifier has the
 * policy's entries but not their autonomy, so it cannot rank them: each class
 * is a claim of equal standing ({@link takeAmongEqual}), and the gate judges
 * every one, so the strictest decides under the policy in force. Each path
 * inside is classified as a file under the folder would be: a built-in
 * representative per organ ({@link FOLDER_CONTENTS}) and one per policy entry
 * that names a path under the folder.
 */
function protectedPathClassOfWord(candidate: string, extra: readonly ProtectedPathEntry[]): string | null {
  const own = protectedPathClassOfWordAlone(candidate, extra);
  if (own === null || !organVerbs || mainRulesOnly) return own;
  const claims = folderContentClaims(candidate, own, extra);
  if (claims.length <= 1) return own;
  markGlobWriteFired();
  return takeAmongEqual(claims);
}

/** `own`, then each distinct class of a path inside the organ folder `candidate` names bare (S1). */
function folderContentClaims(candidate: string, own: string, extra: readonly ProtectedPathEntry[]): string[] {
  const segments = pathSegments(collapseBracedVariables(candidate)).map(foldNameExact);
  let at = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (Object.hasOwn(FOLDER_CONTENTS, segments[index] as string) && tailReturnsTo(segments, index)) {
      at = index;
      break;
    }
  }
  if (at === -1) return [own];
  const name = segments[at] as string;
  const prefix = (candidate.startsWith("/") ? "/" : "") + segments.slice(0, at + 1).join("/");
  const inside = (FOLDER_CONTENTS[name] ?? []).map((tail) => `${prefix}/${tail}`);
  for (const raw of extra) {
    const entry = parseProtectedEntry(raw);
    if (entry === null) continue;
    const wanted = entry.segments.map(foldNameExact);
    for (let position = 0; position < wanted.length - 1; position += 1) {
      if (wanted[position] !== name || position > at) continue;
      if (!wanted.slice(0, position).every((segment, offset) => segment === segments[at - position + offset])) continue;
      inside.push(`${prefix}/${wanted.slice(position + 1).join("/")}${entry.directory ? "/x" : ""}`);
    }
  }
  const claims = [own];
  for (const path of inside) {
    const cls = protectedPathClassOfWordAlone(path, extra);
    if (cls !== null && !claims.includes(cls)) claims.push(cls);
  }
  return claims;
}

/**
 * {@link protectedPathClass} in each name reading: the folded answer, then the
 * as-spelled one when the two readings can differ (`name-fold.ts`). For a
 * caller that GRANTS something on the answer, which must hold in every reading.
 */
export function protectedPathClassReadings(
  candidate: string,
  extra: readonly ProtectedPathEntry[] = [],
): (string | null)[] {
  return eachNameReading(() => protectedPathClass(candidate, extra));
}

/**
 * Every class this path takes in either name reading, the folded one first,
 * without repeats: the protected classes a gate judges together, so that the
 * strictest decision answers under any policy. Empty when neither reading
 * protects it.
 */
export function protectedPathClasses(
  candidate: string,
  extra: readonly ProtectedPathEntry[] = [],
): string[] {
  return distinctClasses(protectedPathClassReadings(candidate, extra));
}

/** The non-null entries of `readings`, in order, without repeats. */
function distinctClasses(readings: readonly (string | null)[]): string[] {
  const out: string[] = [];
  for (const cls of readings) if (cls !== null && !out.includes(cls)) out.push(cls);
  return out;
}

/** {@link protectedPathClass} for one word that brace expansion has already made. */
function protectedPathClassOfWordAlone(candidate: string, extra: readonly ProtectedPathEntry[]): string | null {
  // Every guarded name below is compared with the candidate's FOLDED segments
  // ({@link foldFileName}), on every platform: APFS opens `Approval.MD`,
  // `.Claude/Settings.json` and `.APPROVAL/env` as the guarded files, and a
  // name compared by its exact case let those through as ordinary writes.
  // `spelled` keeps the segments as written for the one row that reads a
  // variable by its exact name (`$HERMES_HOME`).
  const spelled = pathSegments(collapseBracedVariables(candidate));
  const segments = spelled.map(foldNameExact);
  // Every tail's Hermes answers, built once, on first use (linear; see {@link hermesTails}).
  let built: HermesTails | null = null;
  const tails = (): HermesTails => (built ??= hermesTails(segments));

  // 1. The log directory, before anything else that would call it a policy file.
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === ".approval" && segments[index + 1] === "log") return "log.mutate";
  }

  // 2. The gate's own organs.
  const last = segments[segments.length - 1];
  if (last !== undefined && nameListIncludes(CORE_FILENAMES, last)) return "policy.core";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // The rest of the approval home: payload store, vault, keys, environment
    // map, queue. The bare `.approval` directory itself lands here too.
    if (segment === ".approval") return "policy.core";
    // The harness's own settings, which is where a hook is installed or removed.
    // The bare organ directory itself lands here too, as bare `.approval`,
    // `.codex` and `.hermes` do (review-b A686-FOLD3 M1, lead ruling L61587):
    // `rm -rf .claude`, `mv .claude x` and `chmod -R 000 .claude` remove or
    // disable the hook's registration in one command. A tail with `..` in it
    // may resolve to the directory, as `.codex`'s does.
    if (segment === ".claude") {
      const next = segments[index + 1];
      if (next !== undefined && next.startsWith("settings")) return "policy.core";
      if (bareOrganDirectory(segments, index)) return "policy.core";
    }
    // Cursor's equivalent surface: the hook install file, hook scripts, and
    // custom-agent prompts. An agent that could write those could write itself
    // out of the gate (APRV-133), which is the `policy.core` property and not
    // the prose one.
    if (segment === ".cursor") {
      const next = segments[index + 1];
      if (next === "hooks.json" || next === "hooks" || next === "agents" || bareOrganDirectory(segments, index)) return "policy.core";
    }
    // Grok Build's equivalent: `.grok/hooks/*.json` is where its PreToolUse
    // entries are installed, and the scripts beside them are what those
    // entries run. Same property as `.cursor/hooks.json` above and for the
    // same reason (APRV-243): an agent that could write those could write
    // itself out of the gate. Grok also READS `.claude/settings.json` and
    // `.cursor/hooks.json` for compatibility, and both are already here.
    if (segment === ".grok") {
      const next = segments[index + 1];
      if (next === "hooks.json" || next === "hooks" || bareOrganDirectory(segments, index)) return "policy.core";
    }
    // Muse Code's equivalent, OBSERVED rather than guessed (APRV-350): the live
    // probe on muse-bin-1.3.0-R3233.1 established that the installed build reads
    // `.muse/hooks.json` in the project, and that it rejects a malformed one
    // loudly at startup. `settings` is listed beside it because Meta documents
    // user-level hooks inside a `settings.json` `hooks` block, so a
    // project-level copy would be the same organ under a second name; it never
    // fired in the probe, and an entry for a file Muse does not read is INERT,
    // while a missing entry for one it does read would be the hole.
    //
    // `worktrees` is deliberately NOT here. Muse keeps its own worktree state
    // under `.muse/worktrees/`, which is ordinary workspace content: making it
    // `policy.core` would price routine session bookkeeping at a human's
    // attention, which is the failure mode §11 asks to avoid.
    if (segment === ".muse") {
      const next = segments[index + 1];
      if (next === "hooks.json" || next === "hooks" || next?.startsWith("settings") || bareOrganDirectory(segments, index)) {
        return "policy.core";
      }
    }
    // Hermes Agent's equivalent (APRV-398), and the one whose organ lives in
    // the USER HOME by design rather than in the repository. Hermes reads its
    // configuration from `$HERMES_HOME` (default `~/.hermes`) and documents no
    // project-local directory, so the paths below are the ones a real install
    // carries: `config.yaml`, which is where the `hooks:` entries are written;
    // `agent-hooks/`, which holds the scripts those entries run; and
    // `shell-hooks-allowlist.json`, which records the operator's one-time TTY
    // consent to a hook command and would let an agent pre-consent itself to a
    // command of its own. Same property as `.cursor/hooks.json`: an agent that
    // could write any of these could write itself out of the gate.
    //
    // NO NEW PATH GRAMMAR IS NEEDED FOR THE HOME CASE, and that is worth
    // stating because it is the one thing about this entry that differs from
    // the four above it. This loop walks EVERY segment of the candidate, so
    // `.hermes/config.yaml`, `/Users/x/.hermes/config.yaml` and
    // `~/.hermes/config.yaml` all match at whichever position `.hermes` sits
    // in; the existing matchers were already position-agnostic and nothing was
    // extended for this. What a home path does change is the CLASS a mere READ
    // of one takes: `cat ~/.hermes/config.yaml` is a read of a path outside the
    // gate root, so the read jail answers it as `read.file.out_of_scope`
    // (human-only in this repository's policy) before this tier is consulted,
    // while a WRITE to it is `policy.core` here. Both refuse under an agent;
    // they refuse for different reasons, and `docs/hermes-hook.md` says so.
    //
    // The bare `.hermes` directory itself lands here, exactly as bare
    // `.approval` and bare `.codex` do: `rm -rf ~/.hermes` removes the gate's
    // own installation. Anything else under it is deliberately NOT listed —
    // session state and transcripts are ordinary bookkeeping, and pricing those
    // at a human's attention is the failure mode §11 asks to avoid, the same
    // reasoning that keeps `.muse/worktrees/` out of the entry above.
    //
    // APRV-445 adds three rows from the Agent Village DATA-234 survey of Hermes
    // v2026.9.24. `shell-hooks-allowlist.json.lock` is the allowlist's flock
    // sidecar: an agent that makes it unwritable makes the gateway's consent
    // write raise at start, so it is the allowlist's organ as much as the file
    // is (matched by prefix, so the sidecar and the file are one row).
    // `approval/` is where a hosted install keeps the hook's own configuration
    // beside the harness. And `scripts/` is `cron.manage`, not an organ: Hermes
    // runs a scheduled job's script from `$HERMES_HOME/scripts/` with no
    // `pre_tool_call` at all, so WRITING one is scheduling code that will run
    // ungated later, which is the same act as `cronjob_manage create` and is
    // priced by the same policy line.
    //
    // `.env` (and `.env.*`) and `auth.json` are organs too, for WRITES (APRV-445
    // refutation, B2). `isCredentialPath` makes a READ of them
    // `account.credential`, but that tier is consulted for reads only, so before
    // this a `write_file`, a `patch`, a `>>`, a `sed -i` or a `tee -a` onto
    // `$HERMES_HOME/.env` classified as an ordinary `files.write.workspace` and
    // ran unattended: and Hermes loads that file with `override=True` into every
    // process it starts, which makes it the switch for the gate itself
    // (`HERMES_ACCEPT_HOOKS`) as well as a secret store. Reads stay
    // `account.credential`.
    //
    // APRV-511 adds the home's three other organs, from the custody refutation
    // (M1) and Hermes v2026.9.24's own loaders. `hermes-agent/` is the runtime's
    // source install on an Agent Village box: its `.env` is the PROJECT_ROOT
    // `.env` that `load_hermes_dotenv` loads into the gateway after the home's
    // (setting any name the home's left absent), its `plugins/` is the bundled
    // plugin directory, and the rest is the code the gateway runs. `plugins/` is
    // where user plugins load from, the gate's own `av-approval` among them, so
    // an edit there is an edit of the gate. `.op.env` is loaded the same way as
    // the project `.env` (`override=False`). A WRITE to any of them is
    // `policy.core`; a READ of `.op.env` or `hermes-agent/.env` is
    // `account.credential` (`isCredentialPath`), and a read of the rest of the
    // runtime's source stays what it was.
    // APRV-511: the home is matched by the `.hermes` segment in any case, by an
    // unexpanded `$HERMES_HOME`/`${HERMES_HOME}` (which IS the home), and by any
    // other unexpanded variable (which MAY be the home, so only its organ rows
    // apply); the tail is judged as spelled and with its `..` resolved. See
    // {@link hermesHomeKind} and {@link hermesOrganClass}.
    // The home's kind is read from the segment as spelled: a folded
    // `$HERMES_HOME` would read as some other variable, a "maybe" home.
    const spelledSegment = spelled[index];
    const home = spelledSegment === undefined ? null : hermesHomeKind(spelledSegment);
    if (home !== null) {
      const cls = tails().organClass(index + 1);
      if (home === "home" && cls !== null) return cls;
      if (home === "maybe" && tails().maybeOrgan(index + 1)) return "policy.core";
    }
    // Codex installs its hook through these configuration and script paths.
    if (segment === ".codex") {
      const next = segments[index + 1];
      if (
        next === undefined ||
        next === "config.toml" ||
        next === "hooks.json" ||
        next === "hooks" ||
        tails().dotdotFrom(index + 1)
      ) return "policy.core";
    }
  }

  // The prose and configuration about the gate (tier 4's test, also asked by
  // tier 3).
  const builtinEdit = (): boolean => {
    if (last !== undefined && nameListIncludes(PROTECTED_FILENAMES, last)) return true;
    for (let index = 0; index < segments.length; index += 1) {
      // CI configuration, and the bare `.github` directory that holds it
      // (review-b A686-FOLD3 M1, lead ruling L61587).
      if (segments[index] === ".github" && (segments[index + 1] === "workflows" || bareOrganDirectory(segments, index))) return true;
    }
    return false;
  };

  // 3. The policy's own routed entries (APRV-266), above the built-in
  //    `policy.edit` set so a routing can re-label one of those paths, and
  //    below tiers 1 and 2 so it can never reach the log or the gate's organs.
  //    Most segments win. Routes of the same depth that all match are EQUAL
  //    claims: as spelled the first declared answers, as it always did, and
  //    folded each answers in turn ({@link takeAmongEqual}), so the gate
  //    judges every one and the strictest decides (#688 review S2).
  let depth = 0;
  const routes: { path: string; routed: string }[] = [];
  for (const raw of extra) {
    const entry = parseProtectedEntry(raw);
    if (entry === null || entry.routed === null || typeof raw === "string") continue;
    if (!matchesEntry(segments, entry)) continue;
    if (entry.segments.length > depth) {
      depth = entry.segments.length;
      routes.length = 0;
    }
    if (entry.segments.length === depth) routes.push({ path: raw.path, routed: entry.routed });
  }
  if (routes.length > 0) {
    const claims: string[] = [];
    // A route may re-label a built-in `policy.edit` path because the load
    // floor (`checkProtectedRouteFloor`) has judged it no weaker. The floor
    // reads the entry as spelled, so an entry that names a built-in path only
    // when folded (`.GitHub/workflows/`) was never judged: beside such a
    // route the built-in class is a claim too, and comes first (#688 review
    // S1). As spelled no entry is one, so that reading answers as before.
    if (routes.some((route) => namesBuiltinOnlyFolded(route.path)) && builtinEdit()) claims.push("policy.edit");
    for (const route of routes) if (!claims.includes(route.routed)) claims.push(route.routed);
    return takeAmongEqual(claims);
  }

  // 4. The prose and configuration about the gate.
  if (builtinEdit()) return "policy.edit";

  // 5. The policy's own bare-string entries, which mean `policy.edit` (APRV-107).
  for (const raw of extra) {
    const entry = parseProtectedEntry(raw);
    if (entry !== null && entry.routed === null && matchesEntry(segments, entry)) {
      return "policy.edit";
    }
  }
  return null;
}

/**
 * Does a routed entry's path name a built-in guarded path in the folded
 * reading and not as spelled (`.GitHub/workflows/`, `Claude.md`)? The load
 * floor reads entries as spelled, so it never judged such a route. Always
 * false in the as-spelled reading.
 */
function namesBuiltinOnlyFolded(path: string): boolean {
  if (builtinProtectedPathClass(path) === null) return false;
  return withNamesAsSpelled(() => builtinProtectedPathClass(path)) === null;
}

/**
 * The class a path takes from the BUILT-IN set alone, ignoring every policy
 * entry (APRV-266).
 *
 * The load-time routing floor needs this and nothing else: "is the path this
 * entry routes one the runtime protects on its own?" decides whether the floor
 * applies to it, and asking {@link protectedPathClass} with the policy's own
 * entries in hand would answer with the routing under test.
 */
export function builtinProtectedPathClass(candidate: string): ProtectedPathClass | null {
  return protectedPathClass(candidate) as ProtectedPathClass | null;
}

/**
 * {@link builtinProtectedPathClass} in each name reading, folded first (see
 * {@link protectedPathClassReadings}).
 */
export function builtinProtectedPathClassReadings(candidate: string): (ProtectedPathClass | null)[] {
  return eachNameReading(() => builtinProtectedPathClass(candidate));
}

/**
 * Does this path name something only a human may write?
 *
 * The boolean face of {@link protectedPathClass}, kept because two callers
 * (`core/wysiwys.ts`'s protected-path view and the hook's file-tool gate) ask
 * whether a path is protected at all before they ask which surface it is.
 * True when either name reading protects it (a guard: either reading adds).
 */
export function isProtectedPath(
  candidate: string,
  extra: readonly ProtectedPathEntry[] = [],
): boolean {
  return protectedPathClasses(candidate, extra).length > 0;
}

/**
 * One path, in the spelling an organ attestation records (APRV-272).
 *
 * Segment-wise: separators collapse, `./` noise disappears, a trailing slash
 * goes, and the result is joined with `/` whatever the caller's platform uses.
 * Two spellings of one file therefore attest and match as one file, which is
 * the property the guard needs, since git reports `.claude/settings.json` and a
 * human at a terminal may type `./.claude/settings.json`.
 *
 * Pure and disk-free, like everything else in this file: it never resolves,
 * never follows a link, and never asks whether the path exists.
 */
export function normalizePathSpelling(candidate: string): string {
  return pathSegments(candidate).join("/");
}

/**
 * Is this path one of the gate's ORGANS — a `policy.core` surface a human can
 * attest by content (APRV-272)?
 *
 * The organs are the harness files that install the hook: `.claude/settings*`
 * and Cursor's `hooks.json`, `hooks/` and `agents/`. They are `policy.core`
 * because an agent that could write them could write itself out of the gate,
 * and `policy.core` is human-only, so the gate mints no record for them at all
 * — which is exactly why the protected-path guard could never pass a hand-made
 * edit to one, and why {@link normalizePathSpelling}-keyed attestation is the
 * evidence for them.
 *
 * Two `policy.core` surfaces are deliberately NOT organs, and both keep their
 * own rules:
 *
 * - The policy file, which has had content attestation since APRV-15 and whose
 *   attestation the gate reads on every operation. An organ record must never
 *   be able to stand in for it.
 * - Everything under the approval home (`.approval/`): the payload store, the
 *   vault, the keys, the environment map, the queue. Those are the human's own
 *   ceremony surface, and the log directory under them is `log.mutate`, which
 *   is stricter still.
 *
 * The question is asked of the BUILT-IN set alone. A policy may not route any
 * path to `policy.core` (§11.1 invariant 9 and the `policy.edit.*` namespace
 * close that), so consulting the policy's entries here could only ever widen
 * the set of files a human may attest by a routing the classifier already
 * refuses to honor.
 *
 * A GRANT (an organ is attestable by content, which a protected path is not),
 * so it must hold in both name readings: `.Approval/x` is not an organ because
 * folded it is the approval home, and `approval.md` because folded it is the
 * policy file.
 */
export function isGateOrganPath(candidate: string): boolean {
  return eachNameReading(() => isGateOrganPathAsRead(candidate)).every((organ) => organ);
}

/** {@link isGateOrganPath} in the current name reading. */
function isGateOrganPathAsRead(candidate: string): boolean {
  if (builtinProtectedPathClass(candidate) !== "policy.core") return false;
  // Folded, as the class above is: `approval.md` and `.APPROVAL/x` are
  // `policy.core` now, and an exact exclusion would let an organ record stand
  // in for the policy file or the approval home.
  const segments = pathSegments(candidate).map(foldNameExact);
  const last = segments[segments.length - 1];
  if (last !== undefined && nameListIncludes(CORE_FILENAMES, last)) return false;
  return !segments.includes(".approval");
}

// ===========================================================================
// Credential material (account.credential, APRV-194)
// ===========================================================================

/**
 * The class a credential touch takes.
 *
 * SPEC.md §7 has declared `account.credential` since v0.1 and no rule emitted
 * it, so a policy line on the class was inert: `security find-generic-password`
 * fell to `unclassified` (a deny, but undiagnostic) and `cat .approval/vault.enc`
 * fell to `read.shell`, which this repository's own policy makes AUTONOMOUS.
 * The vault is sealed, so that was not an exploit; it was the Never list
 * believing something the classifier did not enforce.
 */
const CREDENTIAL_CLASS = "account.credential";

/**
 * Files under the approval home that hold credential material.
 *
 * Named by their position under `.approval/`, so this is the same pure segment
 * matching every other rule in this file uses: `vault*` (the sealed store and
 * anything beside it), `keys/` (the subtree), and `env` (plus `env.local` and
 * kin), which is the environment map holding the Telegram token, the vault
 * passphrase and the sampling secret.
 *
 * True when either name reading names credential material (a guard: either
 * reading adds the class; see `name-fold.ts`). Inside the classifier, which
 * reports both readings itself, {@link isCredentialPathAsRead} asks the
 * current one only.
 */
export function isCredentialPath(candidate: string): boolean {
  return eachNameReading(() => isCredentialPathAsRead(candidate)).some((credential) => credential);
}

/** {@link isCredentialPath} in the current name reading. */
function isCredentialPathAsRead(candidate: string): boolean {
  if (candidate.length === 0) return false;
  // APRV-511 refuter M2: any brace expansion that names a credential is one.
  const expansions = braceCandidates(candidate);
  if (expansions === null) return true;
  return expansions.some((expansion) => isCredentialWord(expansion));
}

/**
 * {@link isCredentialPath} for one word that brace expansion has already made.
 *
 * Merge of APRV-511 and APRV-522: the word is judged as written and with its
 * braced variables collapsed (APRV-511), and each of those on every splitting,
 * as written and with `..` resolved, case folded and not (APRV-522). True when
 * any reading names credential material, so neither side's rule is narrowed.
 */
function isCredentialWord(word: string): boolean {
  const collapsed = collapseBracedVariables(word);
  const candidates = collapsed === word ? [word] : [word, collapsed];
  return candidates.some((candidate) => credentialWordReadings(candidate));
}

function credentialWordReadings(candidate: string): boolean {
  // APRV-522 (M3). Judged on two spellings of the same path, and true when
  // either one names credential material:
  //
  // - the segments as written, case folded, which is how the rows always read
  //   (a `..` before the approval home keeps its `.approval` run);
  // - the same segments with `..` resolved lexically, so a `..` out of a
  //   sibling directory inside the approval home lands on the file it names.
  //   Pure text cannot say what a symlinked parent does to
  //   a `..`; the hook's disk pass judges the physical landing as well.
  //
  // Case is folded on every platform. macOS and Windows volumes are case
  // insensitive by default, so an upper-case spelling opens the environment map
  // there; on a case-sensitive volume the fold names a different file as a
  // credential, which costs an approval prompt and never an exposure. The fold
  // is {@link foldFileName}'s full one: APFS opens `.approval/<U+017F>ault.enc`
  // as the vault, which `toLowerCase()` alone did not fold.
  //
  // APRV-522 fix round 2 (path-parser differential): a backslash separates
  // segments only on Windows. On macOS and Linux it is a character of a name,
  // so a profile directory whose name holds one is ONE segment to the kernel
  // and two to the split above, which moves the profile row's offset. When the
  // path holds a backslash, the `/`-only reading is judged as well.
  const splittings = [pathSegments(candidate)];
  if (candidate.includes("\\")) {
    splittings.push(candidate.split(/\/+/u).filter((segment) => segment.length > 0 && segment !== "."));
  }
  return splittings.some((segments) => credentialSegmentsAsWrittenOrResolved(segments));
}

/**
 * The credential rows over one splitting, as written and with `..` resolved,
 * case folded (APRV-522) and as spelled (APRV-511's rows read an unexpanded
 * `$HERMES_HOME` by its exact spelling, which the fold would turn into a
 * "maybe" home).
 */
function credentialSegmentsAsWrittenOrResolved(segments: readonly string[]): boolean {
  const folded = segments.map(foldNameLower);
  const spellings = folded.every((segment, index) => segment === segments[index]) ? [folded] : [folded, [...segments]];
  for (const written of spellings) {
    if (credentialSegments(written)) return true;
    if (!written.includes("..")) continue;
    const resolved: string[] = [];
    for (const segment of written) {
      if (segment === ".." && resolved.length > 0 && resolved[resolved.length - 1] !== "..") resolved.pop();
      else resolved.push(segment);
    }
    if (credentialSegments(resolved)) return true;
  }
  return false;
}

/** The credential rows over already-split segments. */
function credentialSegments(segments: readonly string[]): boolean {
  // Every tail's Hermes answers, built once, on first use (linear; see {@link hermesTails}).
  let built: HermesTails | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // APRV-398. Hermes Agent's own home holds two files of credential material
    // beside its configuration: `.env`, which is where its secrets go, and
    // `auth.json`, which holds an OAuth grant. `$HERMES_HOME/config.yaml` and
    // the hook paths beside it are `policy.core` (see `protectedPathClass`);
    // these two are a different class for the reason `.approval/env` is, which
    // is that what leaves the machine is the secret rather than the rule.
    //
    // Added by the task that taught this runtime about Hermes at all. A harness
    // whose organ this codebase now recognises, whose credential files it did
    // not, would be a Never-list item the classifier does not enforce — which is
    // exactly the hole APRV-194 was filed for, one harness along.
    // APRV-511: the same home matching as `protectedPathClass` (any case, an
    // unexpanded `$HERMES_HOME`, any other unexpanded variable, `..` resolved
    // in the tail); see {@link hermesCredentialTail}.
    const home = segment === undefined ? null : hermesHomeKind(segment);
    if (home !== null) {
      built ??= hermesTails(segments);
      if (home === "maybe" ? built.maybeCredential(index + 1) : built.credential(index + 1)) return true;
      continue;
    }
    if (segment !== ".approval") continue;
    const next = segments[index + 1];
    if (next === undefined) continue;
    if (next.startsWith("vault")) return true;
    if (next === "keys") return true;
    if (next === "env" || next.startsWith("env.")) return true;
  }
  return false;
}

/**
 * Binaries whose effect on a named path is a WRITE, and nothing else.
 *
 * The precedence between this task and APRV-198, in one list. A write to
 * `.approval/env` is `policy.core` — it is an edit of the gate's own directory,
 * and the protected-path override already says so — while a READ of the same
 * file is `account.credential`, because what leaves the machine is the secret.
 * These binaries are the write half: naming them here makes the credential rule
 * decline, and the segment falls through to the `policy.core` override below.
 *
 * `cp` is deliberately absent. It reads its source and writes its destination,
 * the classifier cannot tell which argument is which (that is the
 * direction-blindness APRV-198 preserves), and of the two readings the
 * exfiltrating one is the one worth naming: a `cp` touching credential material
 * is `account.credential` in either direction. Both classes are gated, so the
 * choice is about what the approver is told, not about whether they are asked.
 *
 * `git` left this list with APRV-522 (M2). It was here for `git add`, `git rm`
 * and `git checkout -- <path>` (still exempt, through
 * {@link GIT_PATH_WRITE_OPTIONS}), and it made the credential rule decline every
 * git verb, the readers included: diff and grep without an index, log with a
 * patch and show of a `<rev>:<path>` print the file, and classified
 * `read.shell`. git is direction-blind the way `cp` is, so
 * it is judged the way `cp` is, and its credential words stay in the protected
 * scan ({@link credentialProtectedScanKeeps}), so a writing verb keeps its
 * `policy.core` answer with the credential class carried beside it.
 *
 * `ln` left with it. A link to the environment map is a second name for the
 * secret that a later read can open, so its source is a read of
 * the material; it is kept in the protected scan for the same reason git is.
 */
const CREDENTIAL_WRITE_BINS: readonly string[] = [
  "rm",
  "mv",
  "tee",
  "truncate",
  "chmod",
  "chown",
  "touch",
  "mkdir",
  "rmdir",
  "dd",
  "install",
];

/**
 * Environment variables whose NAME says they carry a secret.
 *
 * Prefix-matched, because the classifier reads command text and never an
 * environment: it cannot know which `APPROVAL_*` holds a token, so it treats
 * the family alike and lets the allowlist below carve out the runtime's own
 * non-secret names. Erring wide costs one approval prompt.
 *
 * Exported since APRV-205: `core/child-env.ts` starves a spawned child of the
 * same family, and two copies of this list would be one list that drifts.
 *
 * `AGENTMAIL_` joins the family with the AgentMail adapter (APRV-224). An
 * AgentMail API key is a mailbox in one string, and the deployment the adapter
 * assumes hands the agent a key that cannot send while the sending key waits in
 * the vault (SPEC.md §10.4). A key of either half in a granted child's
 * environment would undo that split, so the prefix is withheld like the rest.
 * The adapter's own declared credentials are vault names (`agentmail.api_key`,
 * `agentmail.inbox_id`), so nothing under this prefix passes through by
 * declaration either.
 */
export const SECRET_ENV_PREFIXES: readonly string[] = [
  "APPROVAL_",
  "TELEGRAM_",
  "VAULT_",
  "AGENTMAIL_",
];

/**
 * The runtime's own variables under those prefixes that hold no secret: an
 * identity, a rendering switch, a path. Listed rather than pattern-matched so
 * that adding one is a deliberate act with a reviewer.
 */
export const NON_SECRET_ENV_NAMES: readonly string[] = [
  "APPROVAL_HUMAN",
  "APPROVAL_AGENT",
  "APPROVAL_ASCII",
  "APPROVAL_MD",
  "APPROVAL_HOME",
  "APPROVAL_DIR",
  /**
   * Where the per-machine bot-ownership registry lives (APRV-390).
   *
   * A DIRECTORY PATH, and the same kind of thing `APPROVAL_HOME` and
   * `APPROVAL_DIR` already are. It holds no secret and opens nothing: the file
   * it points at carries bot ids, usernames and instance directories, all of
   * which `.approval/env` carries in the open, and nothing reads it to widen a
   * permission. Passed through because a child `approval` verb must resolve the
   * SAME registry as its parent — a child that silently fell back to the
   * platform default would answer "which instance owns this bot?" from a
   * different file than the process that asked it.
   */
  "APPROVAL_STATE_DIR",
];

/**
 * Does this bare variable name name credential material?
 *
 * Exported since APRV-205 for the same reason the two lists are: the scrub that
 * builds a granted child's environment asks exactly this question, of a real
 * environment rather than of command text, and it must ask it the same way.
 */
export function isSecretEnvName(name: string): boolean {
  if (NON_SECRET_ENV_NAMES.includes(name)) return false;
  return SECRET_ENV_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

/** `$NAME` and `${NAME}` anywhere inside a word, including inside quotes. */
const ENV_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu;

/** The first secret-named variable this word expands, or `null`. */
function secretEnvReference(word: string): string | null {
  ENV_REFERENCE.lastIndex = 0;
  let match = ENV_REFERENCE.exec(word);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined && isSecretEnvName(name)) return name;
    match = ENV_REFERENCE.exec(word);
  }
  return null;
}

/** What a credential touch resolves to, in the shape `classifySegment` returns. */
interface CredentialOutcome {
  class: string;
  rule: string;
  path?: string;
}

/**
 * Is this segment a credential touch? (`null` when it is not.)
 *
 * Two shapes, and neither reads a value. A command naming a credential FILE
 * that it is not merely writing is a read of the material; a command whose text
 * expands a secret-named variable carries the secret into whatever it does with
 * it, which is why the rule fires on `curl -H "…: $APPROVAL_TG_TOKEN"` as well
 * as on `echo $APPROVAL_TG_TOKEN`. Because the classifier is pure over command
 * text it can only ever report the variable's NAME: there is no environment
 * here to read a value from, which is how SPEC.md §11.1's "raw secrets never
 * appear in the log" invariant survives a refusal message that names what it
 * refused.
 */
/**
 * Does this binary only WRITE the paths it names? ({@link CREDENTIAL_WRITE_BINS}
 * plus `sed -i`.) Then a credential path among its positionals is a write to the
 * gate's directory rather than a read of the material.
 */
function credentialWritesOnly(basename: string, args: readonly string[]): boolean {
  const inPlaceSed =
    basename === "sed" &&
    (hasFlag(args, ["--in-place"]) ||
      args.some((arg) => arg.startsWith("-i") && !arg.startsWith("--")));
  const gitPathWrite = basename === "git" && gitWritesNamedPathsOnly(args);
  return CREDENTIAL_WRITE_BINS.includes(basename) || inPlaceSed || gitPathWrite;
}

/**
 * Does this git argv only WRITE the paths it names? (APRV-522.) `true` only
 * when the verb is read unambiguously, is one of
 * {@link GIT_PATH_WRITE_OPTIONS}, and every option before `--` is on that
 * verb's allow-list.
 *
 * The verb is found the way APRV-520's {@link gitGlobalRefusal} reads the
 * globals: zero-value globals are skipped, and ANY other flag before the verb
 * (a global that takes a value, `-C dir`, `-c k=v`, `--git-dir x`, a joined
 * `--work-tree=`, or one this table does not know) leaves the verb unknown, so
 * the argv is a READER. `classifySegment` refuses those globals anyway; this
 * does not rely on that ordering.
 *
 * The options are a closed list, never a deny-list: git accepts any unique
 * prefix of a long option (`--pat` is `--patch`), several verbs print the
 * file's hunks (`git add -p`, `git checkout -p`, `git restore --patch`), and
 * `git checkout-index --prefix=/tmp/` writes a copy elsewhere. So an option
 * not listed for the verb (an abbreviation, a short letter bundled with one
 * not listed, `-fp`, an unknown flag) makes the argv a reader, and the
 * credential rule judges what it names.
 */
/**
 * Where git's verb sits in its argv, read the way {@link gitWritesNamedPathsOnly}
 * reads it (APRV-522 fix round 2): only zero-value globals may come before it,
 * and any other flag leaves the verb unknown (`null`). The hook's credential
 * pass uses it so that, under a directory a `CDPATH` lookup may have chosen,
 * the verb word is not judged as a path: git never opens its verb.
 */
export function gitVerbIndex(args: readonly string[]): number | null {
  let at = 0;
  while (at < args.length && isFlag(args[at] as string)) {
    if (!GIT_ZERO_VALUE_GLOBALS.includes(args[at] as string)) return null;
    at += 1;
  }
  return at < args.length ? at : null;
}

function gitWritesNamedPathsOnly(args: readonly string[]): boolean {
  let at = 0;
  while (at < args.length && isFlag(args[at] as string)) {
    if (!GIT_ZERO_VALUE_GLOBALS.includes(args[at] as string)) return false;
    at += 1;
  }
  const verb = args[at];
  if (verb === undefined || !Object.hasOwn(GIT_PATH_WRITE_OPTIONS, verb)) return false;
  const allowed = GIT_PATH_WRITE_OPTIONS[verb] as GitWriteOptions;
  for (const arg of args.slice(at + 1)) {
    if (arg === "--") break;
    if (!isFlag(arg)) continue;
    if (arg.startsWith("--")) {
      if (allowed.long.includes(arg)) continue;
      if (allowed.joined.some((prefix) => arg.startsWith(prefix))) continue;
      return false;
    }
    if (!Array.from(arg.slice(1)).every((letter) => allowed.short.includes(letter))) return false;
  }
  return true;
}

interface GitWriteOptions {
  /** Short letters, each of which may appear alone or bundled. */
  short: string;
  /** Long options, matched whole (never as a prefix). */
  long: readonly string[];
  /** `--name=` spellings whose value names no file read. */
  joined: readonly string[];
}

/**
 * The git verbs whose named paths are only WRITTEN in the worktree or the
 * index (APRV-522), each with the options (git 2.50) known not to print file
 * content or copy it elsewhere. The exemption git had as a whole, narrowed to
 * the verbs and spellings it was for. Every other verb, an unknown one
 * included, reads what it names; `stash` is absent on purpose (`git stash
 * show -p` prints). `--pathspec-from-file=` is never listed: it reads a file.
 */
const GIT_PATH_WRITE_OPTIONS: Readonly<Record<string, GitWriteOptions>> = {
  add: {
    short: "fuANnv",
    long: ["--force", "--update", "--all", "--no-all", "--intent-to-add", "--dry-run", "--verbose", "--ignore-errors", "--ignore-missing", "--renormalize", "--sparse", "--ignore-removal", "--no-ignore-removal"],
    joined: ["--chmod="],
  },
  rm: {
    short: "frnq",
    long: ["--force", "--dry-run", "--cached", "--quiet", "--ignore-unmatch", "--sparse"],
    joined: [],
  },
  mv: { short: "fknv", long: ["--force", "--dry-run", "--verbose", "--sparse"], joined: [] },
  restore: {
    short: "sSWqm",
    long: ["--source", "--staged", "--worktree", "--quiet", "--ours", "--theirs", "--merge", "--ignore-unmerged", "--overlay", "--no-overlay", "--progress", "--no-progress"],
    joined: ["--source="],
  },
  checkout: {
    short: "fqmbB",
    long: ["--force", "--quiet", "--ours", "--theirs", "--merge", "--overlay", "--no-overlay", "--ignore-skip-worktree-bits", "--progress", "--no-progress"],
    joined: [],
  },
  switch: {
    short: "cCdfqm",
    long: ["--create", "--force-create", "--detach", "--force", "--discard-changes", "--quiet", "--merge", "--progress", "--no-progress"],
    joined: [],
  },
  reset: { short: "qN", long: ["--quiet", "--soft", "--mixed", "--hard", "--keep", "--merge", "--no-refresh"], joined: [] },
  clean: { short: "fdxXnq", long: ["--force", "--dry-run", "--quiet"], joined: [] },
  "update-index": {
    short: "q",
    long: ["--add", "--remove", "--force-remove", "--refresh", "--really-refresh", "--assume-unchanged", "--no-assume-unchanged", "--skip-worktree", "--no-skip-worktree"],
    joined: ["--chmod="],
  },
  "checkout-index": { short: "fuqna", long: ["--force", "--index", "--quiet", "--no-create", "--all"], joined: [] },
};

/**
 * Binaries whose credential words stay in the protected-path scan although
 * they READ them (APRV-522). `git` is direction-blind: one verb writes the
 * gate's directory and another prints the secret, from the same argv shape. Keeping its credential words in the scan means a
 * writing verb keeps `policy.core` (the stricter surface by
 * {@link outranksCredential}) with `account.credential` carried beside it, and
 * a reading verb, which the protected scan never reads, answers
 * `account.credential`.
 */
function credentialProtectedScanKeeps(basename: string): boolean {
  return basename === "git" || basename === "ln";
}

/**
 * The words of a segment the credential rule reads as paths (APRV-522), for
 * the pure classifier and the hook's disk pass alike: one judgement, so the two
 * cannot disagree about which words a reader opens.
 *
 * Empty for a binary that only WRITES what it names
 * ({@link credentialWritesOnly}). Otherwise:
 *
 * - every positional (the words that are not flags, a flag's separate value
 *   included);
 * - the value of every `--name=value` flag and of every short flag carrying
 *   its value attached (`-fFILE`), because a reader's file operand may arrive
 *   inside its own option (M6);
 * - the file half of an upload spelling, `@FILE` and `name=@FILE;type=…`, and
 *   `name=<FILE`, which curl reads the same way;
 * - for git, the path half of a `<rev>:<path>` or `:<path>` word, pathspec
 *   magic (`:(top)`, `:/`) stripped, because show and cat-file print the blob
 *   such a word names.
 *
 * Over-reading a word costs an approval prompt when it happens to spell a
 * credential path; under-reading one costs the property.
 */
export function credentialReadWords(basename: string, args: readonly string[]): string[] {
  if (credentialWritesOnly(basename, args)) return [];
  const words: string[] = [];
  for (const arg of args) {
    if (!isFlag(arg)) {
      words.push(arg);
    } else if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals !== -1 && equals < arg.length - 1) words.push(arg.slice(equals + 1));
    } else if (arg.length > 2) {
      words.push(arg.slice(2));
      const equals = arg.indexOf("=");
      if (equals !== -1 && equals < arg.length - 1) words.push(arg.slice(equals + 1));
    }
  }
  // A snapshot: the loop appends to `words`.
  const spelled = words.slice();
  for (const word of spelled) {
    for (let at = word.search(/[@<]/u); at !== -1; ) {
      const rest = (word.slice(at + 1).split(";")[0] ?? "").trim();
      if (rest.length > 0) words.push(rest);
      const next = word.slice(at + 1).search(/[@<]/u);
      at = next === -1 ? -1 : at + 1 + next;
    }
  }
  if (basename !== "git") return words;
  const out: string[] = [];
  for (const word of words) {
    out.push(word);
    for (let at = word.indexOf(":"); at !== -1; at = word.indexOf(":", at + 1)) {
      let rest = word.slice(at + 1);
      if (rest.startsWith("(")) {
        const close = rest.indexOf(")");
        rest = close === -1 ? rest.slice(1) : rest.slice(close + 1);
      }
      if (rest.length > 0) out.push(rest);
    }
  }
  return out;
}

function credentialTouch(basename: string, args: readonly string[]): CredentialOutcome | null {
  const named = credentialReadWords(basename, args).find((word) => isCredentialPathAsRead(word));
  if (named !== undefined) {
    return { class: CREDENTIAL_CLASS, rule: "credential-path", path: named };
  }

  for (const word of args) {
    if (secretEnvReference(word) !== null) {
      return { class: CREDENTIAL_CLASS, rule: "credential-env" };
    }
  }
  return null;
}

/**
 * The credential an upload or request-body option reads (fix round 4,
 * M(L5f-1)): a source path that is a credential file, else an embedded value
 * whose file the text cannot read ({@link uploadSourcePaths}), which may be
 * one. The rule id is the argument rule's own.
 */
function uploadCredentialTouch(sources: readonly string[], unknown: string | null): CredentialOutcome | null {
  const named = sources.find((path) => isCredentialPathAsRead(path));
  if (named !== undefined) return { class: CREDENTIAL_CLASS, rule: "credential-path", path: named };
  if (unknown !== null) return { class: CREDENTIAL_CLASS, rule: "credential-path", path: unknown };
  return null;
}

/**
 * Is this segment a credential touch through a REDIRECTION? (APRV-503.)
 *
 * The same two shapes {@link credentialTouch} reads from the argument list, read
 * from the redirection targets, which the lexer keeps out of the word list. An
 * input redirection's direction is known in a way a positional's is not: `<`
 * (and `0<`, `3<`, any descriptor) opens its target for READING, whatever the
 * binary in front of it is, so a credential file there is a read of the
 * material and the {@link CREDENTIAL_WRITE_BINS} exemption does not apply
 * (`tee out.txt < .approval/env` copies the secret out). Until this, `cat <
 * ~/.hermes/.env` was `read.shell` while `cat ~/.hermes/.env` was
 * `account.credential`, and so was `echo "$(< ~/.hermes/.env)"`, the bash idiom
 * whose inner command is nothing but the redirection.
 *
 * A secret-named variable in ANY redirection target, read or write, carries the
 * secret the way it does in an argument: the shell expands it into a file name,
 * and a missing file prints that name on stderr.
 *
 * The rule id is the argument rule's own, so a channel, a doc table and a
 * policy reader see one mechanism; `path` names the target word.
 *
 * This answers WHETHER a redirect touches credential material, not which
 * class the segment takes: `classifySegment` defers it whenever the segment
 * names a protected path that outranks the credential class
 * ({@link outranksCredential}), so a redirect can never loosen an answer.
 */
function redirectCredentialTouch(
  readTargets: readonly string[],
  allTargets: readonly string[],
): CredentialOutcome | null {
  const named = readTargets.find((target) => isCredentialPathAsRead(target));
  if (named !== undefined) {
    return { class: CREDENTIAL_CLASS, rule: "credential-path", path: named };
  }
  if (allTargets.some((target) => secretEnvReference(target) !== null)) {
    return { class: CREDENTIAL_CLASS, rule: "credential-env" };
  }
  return null;
}

/** `printenv` prints one variable, or all of them. */
function refinePrintenv(ctx: RuleContext): Refinement {
  if (ctx.positionals.length === 0) {
    return { class: CREDENTIAL_CLASS, rule: "printenv-all" };
  }
  return ctx.positionals.some((name) => isSecretEnvName(name))
    ? { class: CREDENTIAL_CLASS, rule: "printenv-secret" }
    : { class: "read.shell", rule: "printenv-read" };
}

// ===========================================================================
// Tokenizer
// ===========================================================================

interface LexWord {
  /** Literal text, quotes removed and backslash escapes applied. */
  text: string;
  /** True when any part of the word was quoted. */
  quoted: boolean;
  /** Inner text of each `$(…)` in this word, for recursive classification. */
  substitutions: string[];
  /**
   * An UNQUOTED variable or `$(…)` is part of the word, so the shell may split
   * its value into several words (APRV-511 fix round 3, S(open)).
   */
  splits: boolean;
  /**
   * An UNQUOTED `{`, `*`, `?` or `[` is part of the word, so brace expansion or
   * a glob may make it several words or change its head (fix round 3).
   */
  expands: boolean;
  /**
   * An UNQUOTED `#`, `^` or `~` is part of the word: zsh's extendedglob forms
   * (GLOB-WRITE), a pattern only where the line may set options. Absent on a
   * word this lexer did not read, which counts as possibly so.
   */
  zshGlob?: boolean;
  /**
   * Every `$` in `text` is a real expansion (none was quoted or escaped) and
   * one names a special parameter (`$?`, `$#`, `$*`, ...), so the character
   * after each `$` is a name and not a glob (GLOB-WRITE; review of e6b7bf97,
   * finding 3). Absent: not known, read as text.
   */
  paramNames?: boolean;
  /**
   * Is `text` exactly the bytes the shell would hand the command for this
   * word? (APRV-510.) `false` when the shell would still change it: a `$`
   * outside single quotes (a parameter expansion), an unquoted glob or brace
   * character, a leading unquoted `~`, or a backslash inside double quotes
   * before a character the shell keeps it for (this lexer drops every such
   * backslash, the shell drops only five). Read by the `exec.code` shape alone,
   * which hashes a word and so needs the word's bytes to be the program's
   * bytes; every other reader keeps reading `text` exactly as before.
   */
  exact: boolean;
  /**
   * Is this word an assignment to bash (APRV-523)? bash decides that on the
   * word as WRITTEN, before quote removal: the name, an optional subscript, the
   * `+` and the `=` must carry no quoting or escaping character, and the name
   * no `$`, backtick or brace. {@link ASSIGNMENT} applied to the source
   * spelling, not to `text`: a word whose name is quoted or escaped has the
   * same `text` as an assignment and is a command word, the program bash runs.
   */
  assignment: boolean;
}

interface LexRedirect {
  /** `>` and `>>` write; `<` reads. */
  op: ">" | ">>" | "<";
  target: LexWord;
}

interface LexSegment {
  text: string;
  words: LexWord[];
  redirects: LexRedirect[];
  /**
   * The `$(…)` found in the bodies of unquoted heredocs consumed on this
   * segment's line (APRV-504, folded into APRV-508). The shell expands them
   * when the body is read, so they are classified like any other.
   */
  bodySubstitutions: string[];
  /** Set when the segment contains a construct whose effect cannot be read. */
  opaque: string | null;
  /**
   * Did this segment open a heredoc (`<<EOF`, `<<-EOF`)? (APRV-510.) The body
   * is skipped and never classified, and an unquoted body still expands
   * (APRV-504), so the `exec.code` shape declines a segment carrying one.
   */
  heredoc: boolean;
  /**
   * Does this segment's stdin come from somewhere the text names as input:
   * the previous segment of a pipeline (`a | b`, `a |& b`), or a descriptor
   * duplicated onto it (`<&3`)? (APRV-510, security review round 2.) A program
   * can read its real source from stdin (`echo '<src>' | python3 -c
   * 'exec(sys.stdin.read())'`), outside the hash, so the `exec.code` shape
   * declines a segment fed this way.
   */
  stdinFed: boolean;
  /**
   * Is this segment inside a subshell `( … )`? (APRV-510, refuter rS2.) A
   * redirection or heredoc written after the closing `)` feeds the stdin of
   * every command inside it (`(python3 -c '…') < evil.py`), and lands on a
   * segment of its own, so `stdinFed`, `heredoc` and `redirects` never reach
   * the program's segment. The `exec.code` shape declines any segment inside a
   * subshell at all, the stricter form of "a subshell carrying a redirection".
   * A depth that goes negative (an unmatched `)`, as in a `case` pattern)
   * counts as inside.
   */
  subshell: boolean;
}

type LexResult =
  | { ok: true; segments: LexSegment[] }
  | { ok: false; detail: string };

const OPERATOR_CHARS = new Set(["&", "|", ";", "(", ")", "<", ">", "\n"]);

/** A pending `<<TERMINATOR` whose body is skipped at the next newline. */
interface PendingHeredoc {
  terminator: string;
  stripTabs: boolean;
  /**
   * Does the shell expand the body? It does unless some part of the delimiter
   * is quoted (`<<'EOF'`, `<<"EOF"`, `<<E"OF"`, `<<\EOF`).
   */
  expands: boolean;
}

/**
 * Split a command line into segments.
 *
 * Understood: single and double quotes, backslash escapes and line
 * continuations, leading `VAR=value` assignments (left in the word list and
 * stripped by the classifier), redirections including heredocs, the operators
 * `&& || ; | &` and newline, subshell parentheses, `$(…)` command substitution
 * (captured for recursive classification) and backticks (recorded as opaque).
 *
 * Not understood, on purpose: parameter expansion values. `$VAR` and `${VAR}`
 * are kept verbatim in the word text, and every rule that reads a path or a
 * refspec treats a word containing `$` as unknown, which resolves stricter.
 *
 * ## Quoted text is DATA, and that is a contract (APRV-353)
 *
 * The command boundary this tokenizer honours is the shell's own. A quoted
 * argument is ONE word to the shell, so nothing inside it is an operator, a
 * redirection, a segment separator or a command name here either:
 *
 * - single-quoted text is wholly inert, every byte of it, `$` and backtick
 *   included;
 * - double-quoted text is inert too, with the two exceptions the shell itself
 *   makes — `$(…)` and backticks, which it expands before the command runs and
 *   which therefore keep the class they have anywhere else (a substitution is
 *   classified recursively, a backtick is `opaque`);
 * - adjacent quoted and unquoted runs concatenate into one word (`'a'"b"c`),
 *   and a backslash escape is applied where the shell applies it;
 * - UNQUOTED operators split exactly as they always did, and quoting that does
 *   not balance is {@link LexResult} `ok: false` — `unparseable`, a refusal —
 *   rather than a guess at what the writer meant.
 *
 * This is stated rather than merely true because the failure it prevents is
 * silent and one-directional. A backlog note that says the word `bash`, carries
 * an angle-bracketed placeholder, a pipe or a semicolon is prose about work; a
 * tokenizer that read it as syntax would refuse an ordinary workspace write and
 * push its author toward rewording the record of what they did, which is the
 * audit cost SPEC.md §11 exists to protect. Every printable ASCII character is
 * covered in both quote styles by `tests/command-class-quoting.test.ts`, so an
 * edit that loses the property fails there rather than in someone's notes.
 */
function lex(command: string): LexResult {
  const segments: LexSegment[] = [];
  let words: LexWord[] = [];
  let redirects: LexRedirect[] = [];
  let bodySubstitutions: string[] = [];
  let opaque: string | null = null;
  let heredoc = false;
  let stdinFed = false;
  let depth = 0;
  let segmentStart = 0;
  let index = 0;
  const pending: PendingHeredoc[] = [];

  const flush = (end: number): void => {
    if (words.length > 0 || redirects.length > 0 || bodySubstitutions.length > 0 || opaque !== null) {
      segments.push({
        text: command.slice(segmentStart, end).trim(),
        words,
        redirects,
        bodySubstitutions,
        opaque,
        heredoc,
        stdinFed,
        subshell: depth !== 0,
      });
      // Kept across an EMPTY flush, so the `&` of `|&` (or a newline after a
      // trailing `|`) does not drop the pipe into the next real segment.
      stdinFed = false;
    }
    words = [];
    redirects = [];
    bodySubstitutions = [];
    opaque = null;
    heredoc = false;
    segmentStart = end;
  };

  /**
   * Read one word starting at `index`, stopping at unquoted whitespace or an
   * operator character. Returns `null` for an unterminated quote or
   * substitution.
   */
  const readWord = (): LexWord | null => {
    let text = "";
    let quoted = false;
    let splits = false;
    let expands = false;
    let zshGlob = false;
    let exact = true;
    const substitutions: string[] = [];
    const start = index;

    for (; index < command.length; index += 1) {
      const ch = command[index] as string;

      if (ch === " " || ch === "\t") break;
      if (OPERATOR_CHARS.has(ch)) break;

      if (ch === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          // APRV-510 (refuter N1): a backslash ending the input is dropped by
          // a shell that reads the line as a script, so the text is not its.
          exact = false;
          text += "\\";
          continue;
        }
        // A backslash-newline is a line continuation and contributes nothing.
        if (next !== "\n") text += next;
        index += 1;
        continue;
      }

      if (ch === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) return null;
        text += command.slice(index + 1, close);
        quoted = true;
        index = close;
        continue;
      }

      if (ch === '"') {
        const scan = readDoubleQuoted(command, index);
        if (scan === null) return null;
        text += scan.text;
        substitutions.push(...scan.substitutions);
        if (scan.opaque !== null) opaque = scan.opaque;
        if (!scan.exact) exact = false;
        quoted = true;
        index = scan.end;
        continue;
      }

      if (ch === "`") {
        // A backtick substitution is legal shell and unreadable here: its inner
        // text is nested-quoted differently from `$(…)`, and the construct is
        // rare enough that refusing it costs nothing a rewrite cannot fix.
        const close = command.indexOf("`", index + 1);
        if (close === -1) return null;
        opaque = "backtick command substitution";
        index = close;
        continue;
      }

      if (ch === "$" && command[index + 1] === "(") {
        if (command[index + 2] === "(") {
          const end = command.indexOf("))", index + 3);
          if (end === -1) return null;
          opaque = "arithmetic expansion";
          index = end + 1;
          continue;
        }
        const scan = readSubstitution(command, index + 1);
        if (scan === null) return null;
        substitutions.push(scan.inner);
        // APRV-511 refuter M1: the substitution's OUTPUT is part of the word,
        // and a path rule must not read `$(echo ~/.hermes)/plugins/x` as
        // `/plugins/x`. The sentinel is an unexpanded variable to every rule
        // after the lexer: it may be the home (the organ and credential rows
        // apply) and it decides the directory (the Hermes disk pass).
        text += SUBSTITUTION_SENTINEL;
        splits = true;
        index = scan.end;
        continue;
      }

      if (ch === "$") splits = true;
      else if (ch === "{" || ch === "*" || ch === "?" || ch === "[") expands = true;
      else if (ch === "#" || ch === "^" || ch === "~") zshGlob = true;
      // APRV-510: what the shell would still expand in an unquoted run. The
      // text is kept as it always was; only the `exact` flag records it.
      if (ch === "$" || ch === "*" || ch === "?" || ch === "[" || ch === "{") exact = false;
      // Bash expands an unquoted `~` at a word's start and after `=` or `:` in
      // an assignment-shaped argument; any unquoted `~` is treated as one.
      if (ch === "~") exact = false;
      text += ch;
    }

    // Nothing consumed means the caller was at a delimiter: no word here. A
    // word that consumed characters and produced no text is still a word (`''`,
    // or a backtick substitution that only set the opaque flag).
    if (index === start) return null;
    const assignment = ASSIGNMENT.test(command.slice(start, index));
    const paramNames = specialParametersOnly(command.slice(start, index));
    return { text, quoted, substitutions, splits, expands, zshGlob, paramNames, exact, assignment };
  };

  while (index < command.length) {
    const ch = command[index] as string;

    if (ch === " " || ch === "\t" || ch === "\r") {
      index += 1;
      continue;
    }

    if (ch === "\\" && command[index + 1] === "\n") {
      index += 2;
      continue;
    }

    if (ch === "\n") {
      const boundary = index;
      index += 1;
      // Heredoc bodies belong to the line that opened them, so they are
      // consumed here. A quoted delimiter's body is data. An UNQUOTED one is
      // expanded by the shell when it is read (APRV-504, folded into
      // APRV-508): its `$(…)` run, so they are collected for recursive
      // classification, and a backtick or an arithmetic expansion there is
      // opaque, exactly as inside double quotes.
      while (pending.length > 0) {
        const heredoc = pending.shift() as PendingHeredoc;
        const consumed = skipHeredocBody(command, index, heredoc);
        if (consumed === null) {
          return { ok: false, detail: `heredoc <<${heredoc.terminator} is never terminated` };
        }
        if (heredoc.expands) {
          const body = heredocBodyExpansions(command, index, consumed);
          if (body === null) {
            return { ok: false, detail: `heredoc <<${heredoc.terminator} has a substitution that does not close` };
          }
          bodySubstitutions.push(...body.substitutions);
          if (body.opaque !== null) opaque = body.opaque;
        }
        index = consumed;
      }
      flush(boundary);
      segmentStart = index;
      continue;
    }

    // Redirections, including the fd-prefixed and dup forms.
    // Lead ruling L61195 (a): zsh's clobbering forms `>!`, `>>!` (and `>|`,
    // `>>|`) write the NEXT word, as `>` and `>>` do, and so do `>&!`, `>&|`,
    // `>>&!`, `>>&|` (stdout and stderr, clobbering; zsh -f writes each), read
    // ahead of the `>&` dup; `&>!` lexes as `&` and `>!`. Read as zsh reads
    // them: Claude Code's Bash tool runs zsh on macOS.
    const redirect = (mainRulesOnly ? /^(\d*)(>>|>&|>\||>|<<-|<<|<&|<)/u : /^(\d*)(>>&!|>>&\||>&!|>&\||>>!|>>\||>>|>&|>\||>!|>|<<-|<<|<&|<)/u).exec(command.slice(index));
    if (redirect !== null) {
      const op = redirect[2] as string;
      // A zsh clobber form main does not read (`>>|`, `>&!`, ...).
      if (!["", ">>", ">&", ">|", ">", "<<-", "<<", "<&", "<"].includes(op)) markGlobWriteFired();
      index += (redirect[0] as string).length;
      if (op === "<<" && command[index] === "<") {
        // A here-string (`<<<word`). Refused, as it always was, and named
        // (APRV-503): the shell expands its word, and that word is the
        // command's stdin. Parsing it would only ever loosen a refusal
        // (`cat <<< hello` would become a read), while a credential read
        // through it already has spellings that classify, so the refusal is
        // the fail-closed answer and the detail says how to rewrite it.
        return {
          ok: false,
          detail:
            "a here-string (<<<) is not read by this classifier; pipe the text in with printf or name the file as an argument",
        };
      }
      if (op === "<<" || op === "<<-") {
        heredoc = true;
        while (command[index] === " " || command[index] === "\t") index += 1;
        const delimiterStart = index;
        const terminator = readWord();
        if (terminator === null) {
          return { ok: false, detail: "heredoc has no terminator word" };
        }
        // APRV-508: bash takes a heredoc delimiter literally (quote removal
        // only, no expansion), while `readWord` sets a substitution's text
        // aside. So `cat <<$(x)` waited here for a terminator line bash never
        // looks for, and every command line after bash's real terminator was
        // swallowed as body and never classified. A delimiter carrying `$` or
        // a backtick is refused rather than guessed at.
        if (/[$`]/u.test(command.slice(delimiterStart, index))) {
          return {
            ok: false,
            detail: "a heredoc delimiter carrying $ or a backtick is not read by this classifier; use a plain word such as EOF",
          };
        }
        const raw = command.slice(delimiterStart, index);
        pending.push({
          terminator: terminator.text,
          stripTabs: op === "<<-",
          expands: !terminator.quoted && !raw.includes("\\"),
        });
        continue;
      }
      if (op === ">&" || op === "<&") {
        // APRV-510: a dup ONTO stdin (`<&3`, `0<&3`, `<&-`) feeds the command
        // input the text never names. Set before the dup or refusal below, so
        // every `<&` form closes `exec.code` for the segment it feeds. Bash's
        // `n>&m` is `dup2(m, n)` whichever way the arrow points, so a `>&`
        // whose descriptor prefix is 0 (`0>&3`, `0>& 1`, `00>&9`) feeds stdin
        // exactly as `0<&3` does and closes the class too (refuter rS1).
        if (op === "<&" || (op === ">&" && /^0+$/u.test(redirect[1] ?? ""))) stdinFed = true;
        // `2>&1`, `>&2`, `3<&0`, `2>&-`: a descriptor dup or close, no path
        // involved. Anything else after `>&` is a FILE (APRV-508 refutation
        // M1): bash reads `>&word` as `>word 2>&1`, so `paste a >& APPROVAL.md`
        // truncates the policy file. The word is read in full, as the shell
        // reads it, and is a dup only when it is exactly digits with an
        // optional trailing `-`, or a lone `-`. A word whose value the text
        // cannot settle (`>&$fd`) is taken as a file: a write is the stricter
        // reading. After `<&` a non-descriptor word is refused.
        while (command[index] === " " || command[index] === "\t") index += 1;
        const target = readWord();
        // A target that is nothing but `$(…)` (`>&$(x)`) keeps the refusal it
        // had before the substitution sentinel (APRV-511): the sentinel stands
        // for output this classifier cannot settle, and bash may read that
        // output as a descriptor or a file, so neither answer is admitted.
        if (target === null || target.text.split(SUBSTITUTION_SENTINEL).join("") === "") {
          return { ok: false, detail: `redirection ${op} has no target` };
        }
        const dup =
          target.substitutions.length === 0 && (/^\d+-?$/u.test(target.text) || target.text === "-");
        if (dup) continue;
        if (op === "<&") {
          return {
            ok: false,
            detail: `redirection <&${target.text} names no file descriptor; this classifier does not read it`,
          };
        }
        redirects.push({ op: ">", target });
        continue;
      }
      while (command[index] === " " || command[index] === "\t") index += 1;
      const target = readWord();
      if (target === null) {
        return { ok: false, detail: `redirection ${op} has no target` };
      }
      redirects.push({ op: op.startsWith(">>") ? ">>" : op === "<" ? "<" : ">", target });
      continue;
    }

    // APRV-521 (review-b M1): `NAME=(…)` and `NAME+=(…)` are bash's compound
    // (array) assignment, not a word followed by a subshell. Read as a
    // subshell, the list's words became a command and whatever followed the
    // `)` lost the assignment in front of it. Refused: a `(` straight after an
    // unquoted `=` is that assignment or a syntax error to bash.
    if (ch === "(" && command[index - 1] === "=") {
      return {
        ok: false,
        detail: "a compound (array) assignment NAME=(…) is not read by this classifier; assign the elements one by one",
      };
    }

    if (ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      const boundary = index;
      // APRV-510: a single `|` (or `|&`) pipes the previous segment into the next.
      const pipe = ch === "|" && command[index + 1] !== "|";
      index += ch === "&" && command[index + 1] === "&" ? 2 : ch === "|" && command[index + 1] === "|" ? 2 : 1;
      flush(boundary);
      // APRV-510 (refuter rS2): the subshell depth, read by the next flush.
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (pipe) stdinFed = true;
      segmentStart = index;
      continue;
    }

    // A comment (APRV-508, found by the shell differential). bash ends the
    // line at a `#` that begins a word, so `cat #<<EOF` is `cat` and the
    // lines after it are commands; read as a word, the `#<<EOF` opened a
    // heredoc here and swallowed them. The comment runs to the newline, which
    // is left for the loop. Only a `#` after a space, a tab, a newline or an
    // operator begins a word to bash; after a carriage return (whitespace to
    // this loop, a word character to bash) it does not, and is read as a word.
    if (ch === "#" && (index === 0 || /[ \t\n;&|()<>]/u.test(command[index - 1] as string))) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline;
      continue;
    }

    const word = readWord();
    if (word === null) {
      return { ok: false, detail: "unterminated quote or command substitution" };
    }
    words.push(word);
  }

  if (pending.length > 0) {
    const heredoc = pending[0] as PendingHeredoc;
    return { ok: false, detail: `heredoc <<${heredoc.terminator} is never terminated` };
  }
  flush(command.length);
  return { ok: true, segments };
}

/**
 * The refusal detail for a backtick the shell would expand inside a
 * double-quoted argument (APRV-353).
 *
 * Same code (`opaque`), same verdict (deny), more use: double quotes are what
 * an author reaches for when the text carries an apostrophe, and a note that
 * quotes a command in backticks is then legal shell that really does run
 * something. The refusal names the spelling that is inert, because a refusal a
 * reader cannot act on costs the same attention as one they can (SPEC.md §11.1:
 * refusals are machine-readable and distinct — the code stays the machine's
 * half, this is the human's).
 */
const QUOTED_BACKTICK_OPAQUE =
  "backtick command substitution inside a double-quoted argument, which the shell expands; single quotes make the same text literal";

/** Scan a double-quoted string starting at the opening quote. */
function readDoubleQuoted(
  command: string,
  start: number,
): {
  text: string;
  end: number;
  substitutions: string[];
  opaque: string | null;
  exact: boolean;
} | null {
  let text = "";
  const substitutions: string[] = [];
  let opaque: string | null = null;
  // APRV-510, see `LexWord.exact`.
  let exact = true;
  let index = start + 1;

  for (; index < command.length; index += 1) {
    const ch = command[index] as string;
    if (ch === '"') return { text, end: index, substitutions, opaque, exact };
    if (ch === "\\") {
      const next = command[index + 1];
      if (next === undefined) break;
      // The shell keeps the backslash before any other character; this lexer
      // drops it, so the text is no longer the shell's bytes.
      if (!DOUBLE_QUOTE_ESCAPES.has(next)) exact = false;
      if (next !== "\n") text += next;
      index += 1;
      continue;
    }
    if (ch === "`") {
      const close = command.indexOf("`", index + 1);
      if (close === -1) return null;
      opaque = QUOTED_BACKTICK_OPAQUE;
      index = close;
      continue;
    }
    if (ch === "$" && command[index + 1] === "(") {
      if (command[index + 2] === "(") {
        const end = command.indexOf("))", index + 3);
        if (end === -1) return null;
        opaque = "arithmetic expansion";
        index = end + 1;
        continue;
      }
      const scan = readSubstitution(command, index + 1);
      if (scan === null) return null;
      substitutions.push(scan.inner);
      text += SUBSTITUTION_SENTINEL; // APRV-511 refuter M1, as in `readWord`.
      index = scan.end;
      continue;
    }
    if (ch === "$") exact = false;
    text += ch;
  }
  return null;
}

/**
 * What a `$(…)` leaves in a word's text (APRV-511 refuter M1): an unexpanded
 * variable, which is exactly what the shell's substitution is to a classifier
 * that does not run it. The name cannot collide with a real expansion a
 * command would carry, and it is braced so no brace-expansion reading applies.
 * Defined in `name-fold.ts`, which must leave it unfolded.
 */
export { SUBSTITUTION_SENTINEL };

/**
 * The characters a backslash escapes inside double quotes, in the shell's own
 * reading (APRV-510): before anything else the backslash is kept.
 */
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(["$", "`", '"', "\\", "\n"]);

/**
 * Scan `(…)` starting at the opening paren, honouring nesting and quotes, and
 * return the inner text plus the index of the closing paren.
 */
function readSubstitution(command: string, start: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let index = start; index < command.length; index += 1) {
    const ch = command[index] as string;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) return null;
      index = close;
      continue;
    }
    if (ch === '"') {
      const close = closingDoubleQuote(command, index);
      if (close === null) return null;
      index = close;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { inner: command.slice(start + 1, index), end: index };
    }
  }
  return null;
}

/** Index of the `"` closing the one at `start`, or `null`. */
function closingDoubleQuote(command: string, start: number): number | null {
  for (let index = start + 1; index < command.length; index += 1) {
    const ch = command[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === '"') return index;
  }
  return null;
}

/** Consume a heredoc body; returns the index after it, or `null` if unclosed. */
/**
 * The expansions in an unquoted heredoc body, `command[start, end)`: every
 * `$(…)` for recursive classification, and a backtick or an arithmetic
 * expansion as opaque. A backslash escapes the next character, as it does in a
 * body; quotes are literal there, except inside a `$(…)`, which
 * {@link readSubstitution} scans as the shell does. `null` when a substitution
 * runs past the body.
 */
function heredocBodyExpansions(
  command: string,
  start: number,
  end: number,
): { substitutions: string[]; opaque: string | null } | null {
  const substitutions: string[] = [];
  let opaque: string | null = null;
  for (let index = start; index < end; index += 1) {
    const ch = command[index] as string;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "`") {
      opaque = "backtick command substitution in a heredoc body";
      continue;
    }
    if (ch === "$" && command[index + 1] === "[") {
      opaque = "arithmetic expansion in a heredoc body";
      continue;
    }
    if (ch === "$" && command[index + 1] === "(") {
      if (command[index + 2] === "(") {
        opaque = "arithmetic expansion in a heredoc body";
        continue;
      }
      const scan = readSubstitution(command, index + 1);
      if (scan === null || scan.end >= end) return null;
      substitutions.push(scan.inner);
      index = scan.end;
    }
  }
  return { substitutions, opaque };
}

function skipHeredocBody(command: string, start: number, heredoc: PendingHeredoc): number | null {
  let index = start;
  for (;;) {
    if (index >= command.length) return null;
    const newline = command.indexOf("\n", index);
    const line = newline === -1 ? command.slice(index) : command.slice(index, newline);
    const compared = heredoc.stripTabs ? line.replace(/^\t+/u, "") : line;
    if (compared.trimEnd() === heredoc.terminator) {
      return newline === -1 ? command.length : newline + 1;
    }
    if (newline === -1) return null;
    index = newline + 1;
  }
}

// ===========================================================================
// The rule table
// ===========================================================================

/**
 * Facts about the machine the command will run on, resolved by the CALLER
 * (APRV-267).
 *
 * The classifier is pure and stays pure. Some rules, though, turn on something
 * no string can carry: whether a path names the agent's own scratch space. So
 * the impure half is hoisted out of this file entirely — the caller resolves
 * the roots, this file only compares path segments against them — and the
 * shape is the one `protectedPaths` already established: an optional argument
 * whose absence yields the strictly NARROWER answer. A caller that forgets it
 * classifies every delete the way this file classified it before the field
 * existed; it never invents an authorization.
 *
 * Every root must be ABSOLUTE and already resolved (symlinks followed) by the
 * caller. This file does not touch the disk and cannot check either property,
 * so a caller handing it a relative or unresolved root gets segment matching
 * against exactly what it passed.
 */
export interface ClassifierContext {
  /**
   * Roots under which a delete is the agent tidying after itself: the session
   * scratchpad the harness allots, and the system temp directory.
   *
   * `src/cli/hook.ts` resolves these (`resolveScratchRoots`) and tightens the
   * answer afterwards with the checks that need the disk — a symlink escaping
   * the root, a git checkout living inside it. Nothing here is a grant on its
   * own: a path under a root still has to survive that second pass.
   */
  scratchRoots?: readonly string[];
  /**
   * Roots a read may stay inside: the gate root, the session scratchpad and the
   * system temp root, plus whatever `read_scope.roots` added (APRV-347).
   *
   * The polarity is the OPPOSITE of `scratchRoots`, and the difference is worth
   * stating. A scratch root LOOSENS a delete, so forgetting the field is safe
   * by construction. A read root NARROWS a read, so forgetting the field would
   * be safe in a different way — it leaves every read `read.shell`, exactly as
   * this classifier answered before the field existed. An EMPTY array means the
   * same thing as absent, and deliberately: read against no roots at all would
   * make every read in the session a decision, which is a fail-closed answer
   * nobody asked for and the one spelling a caller reaches by accident. A
   * caller that means to scope reads passes roots.
   *
   * As with `scratchRoots`, this file only compares segments. The relative
   * paths, the symlinks and the working directory are the hook's second pass,
   * which can only ever tighten the answer reached here.
   */
  readRoots?: readonly string[];
  /**
   * May a login-shell wrapper be classified by the script it runs (APRV-380)?
   *
   * `true` by default, and `false` for exactly one caller: the classifier
   * itself, recursing into an unwrapped script. That is what keeps the unwrap
   * ONE LEVEL deep — a shell nested inside the script is the shape the
   * {@link OPAQUE_BINS} position still covers, and it stays opaque.
   *
   * A caller that passes `false` gets the pre-APRV-380 answer, which is the
   * strictly stricter one: every wrapper refuses. As with every other field
   * here, forgetting it cannot loosen anything.
   */
  unwrapShell?: boolean;
  /**
   * A variable git could inherit that the command line's own shell sets
   * (APRV-521, {@link gitEnvironmentWrite}). {@link classifyCommand} fills it
   * from its own segments and hands it down to a substitution and an
   * unwrapped script, which run in a shell that inherits it; every `git`
   * segment under it is `unclassified`. A caller that sets it only refuses
   * more.
   */
  shellEnvWrite?: string;
  /**
   * May an opaque PROGRAM be classified `exec.code` rather than refused
   * (APRV-510)?
   *
   * `false` by default, and the default is today's answer exactly: `python3 -c`,
   * `node -e`, `perl -e`, `ruby -e` and `deno eval` stay `opaque`, `bun -e`,
   * `python3 <file>` and `bun <file>.ts` stay `unclassified`. `src/cli/hook.ts`
   * passes `true` only when the loaded policy declares
   * `exec.code.custody: attested`, the operator's statement that the agent's
   * code cannot reach credentials it should not hold. Like `scratchRoots`, a
   * caller that forgets it gets the stricter answer: a refusal.
   *
   * It opens a SHAPE and nothing wider ({@link execCodeShape}): `bash -c`,
   * `sh -c`, `eval`, a pipe into an interpreter and `python3 -` (stdin) are
   * refused whatever this says.
   */
  execCode?: boolean;
  /**
   * Classify a segment no built-in rule covers as a {@link NO_RULE_CLASS}
   * stand-in and read on, rather than refusing the whole command at it, so a
   * caller sees every other segment's class. Only the no-rule case: every
   * other refusal returns as it always did. `src/cli/hook.ts` passes `true`
   * only under `defaults.unclassified_command: abstain`.
   */
  noRuleSegments?: boolean;
  /**
   * The directories the hook judges a no-rule segment from (its own cwd and
   * the envelope's). Read only with {@link noRuleSegments}: a cwd inside a
   * dot-directory, a protected path or a credential home refuses the stand-in,
   * and every word is also judged resolved against each of them.
   */
  noRuleCwds?: readonly string[];
  /**
   * Where literal `cd` / `pushd` / `popd` segments earlier on the same line
   * moved the shell (APRV-518, S1), or `null` when one of them cannot be
   * followed from the text. Set by {@link classifyCommand} for each segment it
   * classifies; a caller leaves it unset, which is the line's own start.
   */
  shellDir?: ShellDir | null;
  /**
   * Does the line itself spell a `.git` segment in an assignment's value, a
   * command substitution or a quoted string (second review, S3)? Set by
   * {@link classifyCommand} for the whole line and its inner scripts.
   */
  lineNamesGit?: boolean;
  /**
   * May the line itself turn on dot-name matching for its globs (GLOB-WRITE,
   * lead ruling L60846)? True unless the whole line is plain (an allowlist,
   * {@link lineMaySetDotglob}). Set by
   * {@link classifyCommand} for the whole line and its inner scripts; without
   * it a pattern reaches a dot-name only through an explicit leading `.`, as
   * every shell's default does.
   */
  lineSetsDotglob?: boolean;
  /**
   * What the caller read of the disk for a write-target pattern (GLOB-WRITE,
   * lead ruling L61167): the names in the directory a pattern's first globbed
   * component matches in. The core never reads the disk; the hook lists the
   * directories {@link globWriteListingDirs} names and passes the result here.
   * Without it, or for a directory it does not hold, a pattern keeps the
   * over-approximated answer.
   */
  globDisk?: GlobDisk;
  /** The line's one matcher step budget (review-b M1); set by {@link classifyCommand}, shared by nested reads. */
  globBudget?: { left: number };
  /** The plain pass: no pattern or `${…}` reading (review-b S1). Internal. */
  globPatternsOff?: boolean;
  /** Records that a pattern reading raised a segment's class (review-b S1). Internal. */
  globTracker?: { raised: boolean; parent?: boolean };
  /** The pass without the parents rule (lead ruling L61587), for the class it rides beside. Internal. */
  organParentsOff?: boolean;
  /**
   * The segments whose words, targets and substitution bodies the line's own
   * reading for {@link lineNamesGit} already went through (review of the
   * substitution fold, M1). Set by {@link classifyCommand}; a caller leaves
   * it unset.
   */
  spelledSegments?: WeakSet<LexSegment>;
  /**
   * This text is a substitution body of such a segment on a line that does
   * not spell `.git`, so reading it again would find nothing: the body was
   * read, as a line of its own, by that line's reading. Set only by
   * {@link classifySegment} for the substitutions it classifies, so a deep
   * nesting is read once and not once per level.
   */
  bodyAlreadyRead?: boolean;
  /**
   * How many command substitutions this text sits inside (review of the
   * substitution fold). Set by {@link classifySegment}; a caller leaves it
   * unset.
   */
  substitutionDepth?: number;
}

/** Everything a refinement needs: the binary and the words that followed it. */
interface RuleContext {
  bin: string;
  /** Words after the binary, quotes already removed. */
  args: string[];
  /** Words after the binary that are not flags. */
  positionals: string[];
  /** The matched subcommand (first positional), or `null`. */
  sub: string | null;
  /**
   * Did any of those words come out of a command substitution? Its text is
   * gone by the time a rule sees it, so a rule that reads its arguments closely
   * (APRV-114's fetch refinement) needs to know that one of them is a hole.
   */
  substituted: boolean;
  /**
   * Did the segment carry a `NAME=value` assignment before the binary (or
   * before a sandbox wrapper around it)? The classifier strips assignments to
   * find the binary, so a rule never sees them; a rule whose answer rests on
   * the argv saying WHICH file runs needs to know the environment may say
   * otherwise (APRV-502: `BUN_OPTIONS='--cwd ../x'`, `NODE_OPTIONS`,
   * `PYTHONPATH`, `PYTHONSTARTUP`, `HOME`).
   */
  assigned: boolean;
  /**
   * Those assignments, verbatim (APRV-517). `git push` reads them: a `GIT_*`
   * variable or `HOME` decides which configuration the push runs under, and
   * configuration can carry a deleting refspec.
   */
  assignments: readonly string[];
  /** What the caller knows about the machine (APRV-267). Never read from here. */
  context: ClassifierContext;
}

/**
 * A refinement's answer: a class and the rule id that chose it, or a statement
 * that this invocation cannot be read at all.
 *
 * The opaque arm is APRV-283's. A refinement that returns `null` is answered
 * with the interpreter message (`runs inline source`), which is true of
 * `node -e` and false of `find … -exec`, and a refusal that misdescribes the
 * command it refuses sends the agent looking for a flag it did not pass. A
 * refinement that has its own reason states it.
 */
type Refinement = { class: string; rule: string; path?: string } | { opaque: string };

/**
 * One row of the classification table.
 *
 * `bins` + `subs` is the match; `class` is the answer. A row with a `refine`
 * looks at the flags before answering, and declares every class it can emit in
 * `emits` so the table stays enumerable (the dogfood test reads that list).
 */
export interface CommandRule {
  /** Stable identifier, printed by `hook classify` and pinned by the fixtures. */
  id: string;
  bins: readonly string[];
  /** Match only when the first positional is one of these. */
  subs?: readonly string[];
  class: string;
  /** Additional classes a refinement may return. */
  emits?: readonly string[];
  /** Flag-sensitive answer; falls back to `class` when it returns `null`. */
  refine?: (ctx: RuleContext) => Refinement | null;
  /**
   * Match only an argv that is nothing but version or help flags (APRV-397).
   *
   * The row a binary needs when the thing being classified is the ABSENCE of a
   * subcommand: `npm --version` carries no positional, so `subs` can never
   * match it, and a row with no `subs` at all would have matched every
   * subcommand this table does not name and turned a wall of `unclassified`
   * denials into whatever class that row declared. A `probe` row matches the
   * probe shape and nothing else, so everything it does not match keeps the
   * answer it has today.
   */
  probe?: boolean;
  /**
   * Match only an argv that runs a skill script (APRV-502): allowlisted inert
   * flags, then a `skills/<skill>/scripts/<file>` path, with no word of the
   * segment carrying a command substitution and no `NAME=value` assignment
   * before the binary ({@link skillScriptArg}, {@link matchRule}).
   *
   * The same device as `probe`, for the same reason: the row is a SHAPE, and
   * an argv outside the shape must not match it at all, so `bun --cwd /etc x`
   * and `python3 -m x` keep the `unclassified` answer they have today rather
   * than being refined into some other refusal.
   */
  skillScript?: boolean;
  /**
   * Match only an argv this predicate accepts (APRV-508).
   *
   * The general form of `probe` and `skillScript`: the row is a SHAPE, and an
   * argv outside it does not match the row at all, so the segment keeps the
   * answer it had before the row existed (`unclassified`, for a binary no other
   * row names). Before the predicate is asked, a shape row is declined by a
   * substituted word (its text is a hole) and by a binary spelled with a path
   * outside the system directories ({@link isSystemBinWord}: `./date` is
   * whatever program sits in the working directory). `assignments` are the
   * `NAME=value` words in front of the binary, verbatim.
   */
  shape?: (args: readonly string[], assignments: readonly string[]) => boolean;
  /**
   * Match only an argv in the `exec.code` shape, and only when the caller
   * opened the class (APRV-510, {@link ClassifierContext.execCode},
   * {@link execCodeShape}). The `probe`, `skillScript` and `shape` device again:
   * an argv outside the shape does not match the row at all, so it keeps the
   * answer it has today.
   */
  execCode?: boolean;
}

/** Is `word` a flag rather than a positional? */
function isFlag(word: string): boolean {
  return word.startsWith("-") && word !== "-";
}

/** Does any argument match one of these exact flags? */
function hasFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => {
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    return names.includes(name);
  });
}

/** Does any short-flag bundle (`-rf`) carry one of these letters? */
function hasShortFlag(args: readonly string[], letters: readonly string[]): boolean {
  return args.some((arg) => {
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    const bundle = arg.slice(1);
    return letters.some((letter) => bundle.includes(letter));
  });
}

/**
 * A value the classifier cannot read: an unexpanded parameter, a glob, a home
 * shortcut. Every rule that reads one resolves to its stricter branch.
 */
function isUnknownValue(word: string): boolean {
  return word.includes("$") || word.includes("*") || word.includes("?") || word.startsWith("~");
}

/** A bare release tag: the conventional `v` plus a semantic-version-shaped value. */
const V_PREFIXED_SEMVER = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/**
 * Does one side of a push refspec explicitly name a tag?
 *
 * The `refs/`, `tags/` and `heads/` prefixes are compared without case
 * (APRV-518): on a case-insensitive filesystem `refs/TAGS/t1` and
 * `refs/tags/t1` may name one loose file, so such a spelling is read as a tag.
 * git 2.50.1 on APFS refused `git push origin TAGS/v1`, so this costs nothing
 * there (tests/command-class-remote-config-case.test.ts).
 */
function isTagRef(name: string): boolean {
  const folded = foldNameLower(name);
  if (folded.startsWith("refs/tags/")) return true;
  if (folded.startsWith("refs/heads/")) return false;
  // APRV-518: git's ref DWIM tries `refs/<name>` first, so `tags/t1` is
  // `refs/tags/t1` wherever that tag exists (a local source always, a remote
  // destination when the remote has it).
  if (folded.startsWith("tags/")) return true;
  return V_PREFIXED_SEMVER.test(name);
}

/**
 * The branch a push destination names, the way git's ref DWIM reads it
 * (APRV-518), or `null` when it names no branch. `refs/heads/x` and `x` are
 * `x`; so is `heads/x`, because git matches a short destination against the
 * remote's refs through `refs/%s` first, and `git push origin lane:heads/main`
 * moved the remote trunk on git 2.50.1. Any other `refs/…` or `tags/…` /
 * `remotes/…` is not a branch.
 *
 * The prefixes are compared without case, like the branch name itself
 * ({@link isTrunkBranch}): on a case-insensitive filesystem a remote's loose
 * `refs/HEADS/main` and `refs/heads/main` may be one file, so
 * `lane:refs/HEADS/main` and `lane:HEADS/MAIN` read as the trunk wherever
 * their lower-case spelling does. git 2.50.1 on APFS refused the first and
 * created a branch `HEADS/MAIN` for the second, so this costs nothing there.
 */
function destinationBranch(destination: string): string | null {
  // Folded ({@link foldFileName}). The spelled word is sliced after as many
  // `/` as the matched prefix holds: the fold never makes or removes a `/`,
  // and it may drop a code point HFS+ ignores (`refs/<U+200D>heads/main`),
  // so the prefix's own length is not the spelled word's.
  const folded = foldNameLower(destination);
  if (folded.startsWith("refs/heads/")) return afterSlashes(destination, 2);
  if (folded.startsWith("refs/")) return null;
  if (folded.startsWith("heads/")) return afterSlashes(destination, 1);
  if (folded.startsWith("tags/") || folded.startsWith("remotes/")) return null;
  return destination;
}

/** `word` after its first `count` slashes (the whole tail past the last of them). */
function afterSlashes(word: string, count: number): string {
  let at = -1;
  for (let seen = 0; seen < count; seen += 1) {
    at = word.indexOf("/", at + 1);
    if (at < 0) return "";
  }
  return word.slice(at + 1);
}

/** The branch names every push reading treats as a trunk. */
const TRUNK_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Is this branch a trunk? Compared without case: on a case-insensitive
 * filesystem a remote's loose `refs/heads/MAIN` is its `refs/heads/main`.
 */
function isTrunkBranch(branch: string, trunks: readonly string[]): boolean {
  const folded = foldNameLower(branch);
  return trunks.some((trunk) => foldNameLower(trunk) === folded);
}

/** Does either source or destination of this refspec explicitly name a tag? */
function isTagRefspec(refspec: string): boolean {
  const colon = refspec.indexOf(":");
  if (colon === -1) return isTagRef(refspec);
  return isTagRef(refspec.slice(0, colon)) || isTagRef(refspec.slice(colon + 1));
}

/**
 * Deleting a remote ref: its own class, never the trunk-push one (APRV-352).
 *
 * A `git push` that deletes refs was `vcs.push.main` until now, which reads as
 * "this reaches the trunk" and in a repository that samples trunk pushes
 * retrospectively means an irreversible removal proceeds unasked and is looked
 * at afterwards. It is not the same act. A push adds commits somebody can still
 * see; a deletion removes the only name an unmerged branch had, and the
 * reflog that could find it again lives on a server nobody in the session can
 * reach. The two belong on separate policy lines, and a policy that wants them
 * on one can still write `vcs.*`.
 *
 * Distinct from `vcs.history.rewrite` as well, which guards SHARED history: a
 * force push moves a ref other people have already built on. That class stays
 * exactly where it was, above this one, so a force push that also deletes is
 * still a rewrite.
 */
const REF_DELETE_CLASS = "vcs.ref.delete";

/**
 * The ref a deleting refspec names, or `null` when the refspec deletes nothing.
 *
 * `:dst` (empty source) is the deletion git documents; `src:` (empty
 * destination) is the spelling the classifier has always treated as one too,
 * and it keeps doing so rather than being narrowed here. The non-empty side is
 * the name worth showing an approver either way.
 */
function deletedRef(refspec: string): string | null {
  const colon = refspec.indexOf(":");
  if (colon === -1) return null;
  const source = refspec.slice(0, colon);
  const destination = refspec.slice(colon + 1);
  if (destination.length === 0) return source.length === 0 ? refspec : source;
  if (source.length === 0) return destination;
  return null;
}

/**
 * The facts of a `git push` its class turns on (APRV-517). Two readings of one
 * argv fill it in, and {@link refineGitPush} keeps the stricter answer.
 */
interface PushFacts {
  force: boolean;
  tags: boolean;
  remove: boolean;
  prune: boolean;
  /** Pushes every branch (`--all`, `--mirror`, a submodule push): the trunk among them. */
  all: boolean;
  refspecs: string[];
  /**
   * What a colon-less `HEAD` or `@` refspec pushes to (APRV-518). Absent: the
   * word is read as a branch of that name, which is the answer this row gave
   * before and is the floor. Present: the branch it stands for, `main` when
   * the current branch is the trunk or cannot be known.
   */
  headAs?: string;
  /**
   * Branch names that are trunks beside main and master (APRV-518): the
   * branch `refs/remotes/origin/HEAD` names, when the hook could read it.
   */
  trunks?: readonly string[];
}

/**
 * A refspec that pushes the current branch to the branch of the same name
 * (APRV-518): `HEAD` or `@` with no `:dst`. Which branch that is, is a fact
 * about the checkout, so the text alone cannot say it is not the trunk. Any
 * case, because on a case-insensitive filesystem `git push origin head`
 * resolves the file `.git/HEAD` and pushes the current branch too (git 2.50.1
 * on macOS, proven in tests/git-push-remote-config.test.ts).
 */
export function isCurrentBranchRefspec(refspec: string): boolean {
  return /^(?:head|@)$/iu.test(refspec);
}

/**
 * The reading the classifier has always made: flags by exact spelling, and
 * every non-flag word after the first a refspec. Kept as a floor beneath the
 * git-grammar reading, so no spelling classifies looser than it did.
 */
function wordPushFacts(args: readonly string[]): PushFacts {
  return {
    force: hasFlag(args, ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror"]),
    tags: hasFlag(args, ["--tags", "--follow-tags"]),
    remove: hasFlag(args, ["--delete", "-d"]),
    prune: false,
    all: false,
    refspecs: args.filter((arg) => !isFlag(arg)).slice(1),
  };
}

/** `git push` classes, strictest first: the order {@link pushFactsClass} checks them in. */
const PUSH_CLASS_ORDER: readonly string[] = [
  "vcs.history.rewrite",
  "release.publish",
  REF_DELETE_CLASS,
  "vcs.push.main",
  "vcs.push.branch",
];

/** `git push` — force, release, deletion, trunk and branch turn on flags and refspecs. */
function pushFactsClass(facts: PushFacts): Refinement & { class: string } {
  const { refspecs } = facts;
  if (facts.force || refspecs.some((refspec) => refspec.startsWith("+"))) {
    return { class: "vcs.history.rewrite", rule: "git-push-force" };
  }
  // The tag check stays ABOVE the deletion check, deliberately. A tag is the
  // name a release was published under, and this repository's policy prices
  // `release.publish` accordingly; deleting one is a release act whichever
  // spelling removes it. Moving the deletion check up would re-label
  // `git push origin :refs/tags/v1.2.3` and a bulk form that mixes a tag in,
  // and APRV-352 asks for a class for branch deletions, not a loosening of the
  // tag surface.
  if (
    facts.tags ||
    refspecs.some(isTagRefspec) ||
    refspecs.some((word, index) => word === "tag" && index + 1 < refspecs.length)
  ) {
    return { class: "release.publish", rule: "git-push-tag" };
  }
  // `--delete` / `-d`: every refspec after the remote is a ref being removed.
  // A `--delete` naming no ref at all is a git error, and it stays in this
  // class with nothing bound rather than falling through to a push class: an
  // invocation whose targets cannot be read is the one that least deserves the
  // looser answer.
  if (facts.remove) {
    return {
      class: REF_DELETE_CLASS,
      rule: "git-ref-delete",
      ...(refspecs.length === 0 ? {} : { path: refspecs.join(" ") }),
    };
  }
  // `--prune` (APRV-517) removes every remote ref a refspec pattern no longer
  // matches. Which refs those are is a fact about the remote, so nothing is
  // bound: the refspecs are not the refs it removes.
  if (facts.prune) {
    return { class: REF_DELETE_CLASS, rule: "git-push-prune" };
  }
  if (refspecs.length === 0) {
    return { class: "vcs.push.main", rule: "git-push-implicit" };
  }
  // The colon-refspec spellings, which need no flag: `:refs/heads/x`, `:x`, and
  // a bulk form mixing several. ONE deleting refspec makes the whole command a
  // deletion, because the command's effect is the union of its refspecs and the
  // destructive half is the half a person is being asked about.
  const deleted = refspecs.map(deletedRef).filter((ref): ref is string => ref !== null);
  if (deleted.length > 0) {
    return { class: REF_DELETE_CLASS, rule: "git-ref-delete", path: deleted.join(" ") };
  }
  let sawMain = facts.all;
  // Did the trunk come ONLY from a `HEAD`/`@` that stands for it (APRV-518)?
  // Then the rule says so, and the repository-reading pass in the hook knows
  // which segments a current branch could answer.
  let headMain = false;
  const trunks = [...TRUNK_BRANCHES, ...(facts.trunks ?? [])];
  for (const refspec of refspecs) {
    const colon = refspec.indexOf(":");
    if (facts.headAs !== undefined && isCurrentBranchRefspec(refspec)) {
      const branch = destinationBranch(facts.headAs);
      if (branch !== null && isTrunkBranch(branch, trunks)) headMain = true;
      continue;
    }
    // A colon-less refspec pushes to the ref its source names, so `heads/main`
    // alone is the trunk too. A leading `+` has already answered above.
    const destination = (colon === -1 ? refspec : refspec.slice(colon + 1)).replace(/^\+/u, "");
    if (isUnknownValue(destination)) {
      sawMain = true;
      continue;
    }
    const branch = destinationBranch(destination);
    if (branch !== null && isTrunkBranch(branch, trunks)) sawMain = true;
  }
  if (sawMain) return { class: "vcs.push.main", rule: "git-push-main" };
  if (headMain) return { class: "vcs.push.main", rule: GIT_PUSH_HEAD_RULE_ID };
  return { class: "vcs.push.branch", rule: "git-push-branch" };
}

/** A `git push` whose `HEAD`/`@` may be the trunk (APRV-518). */
const GIT_PUSH_HEAD_RULE_ID = "git-push-head";

/**
 * `git push`, read twice and answered by the stricter reading (APRV-517).
 *
 * The first reading is git's own grammar ({@link parseGitPushArgv}): short
 * bundles (`-ud`), unique-prefix abbreviations (`--del`), `--prune`, the
 * values that option words consume, and the global options in front of
 * `push`. Anything that grammar cannot walk is answered without a guess: a
 * word the shell may expand, or an environment that steers git's
 * configuration, is `vcs.history.rewrite` (rule `git-push-unreadable`), the
 * strictest class this row emits, because such a word can hold `+main`,
 * `:main` or `-d`; an argv git itself would refuse, or one that names a
 * far-side program, is opaque.
 *
 * The second reading is the word scan this row has always made, kept as a
 * floor, so a command whose verdict moves only ever moves stricter. Where the
 * two agree on the class, the grammar's answer is kept: its rule and bound
 * refs are the ones git will act on.
 */
function refineGitPush(ctx: RuleContext): Refinement {
  return gitPushClass(ctx.args, ctx.assignments, ctx.substituted, { kind: "text" });
}

// ---------------------------------------------------------------------------
// What the repository says about a push (APRV-518)
// ---------------------------------------------------------------------------

/**
 * The facts of a checkout that decide what a `git push` sends when its text
 * does not (APRV-518). `src/cli/hook.ts` reads them with plumbing and hands
 * them in; this file never touches the disk.
 *
 * Four things the command line alone cannot show, each proven against git
 * 2.50.1 on a bare local remote in tests/git-push-remote-config.test.ts:
 *
 * - `remote.<name>.mirror` turns a refspec-less push to that remote into
 *   `--mirror`: every remote branch the checkout lacks is deleted and every
 *   other one is force-updated. `--tags` and `--all` do not stop it.
 * - `remote.<name>.push` is the refspec list of a refspec-less push, so
 *   `:refs/heads/x` there deletes and `+…` there forces; and a colon-less
 *   refspec on the command line (`git push origin lane`) takes its
 *   destination AND its force from the configured refspec that maps it, so
 *   `+refs/heads/lane:refs/heads/main` makes `git push origin lane` a forced
 *   update of the trunk.
 * - `HEAD` and `@` push the current branch, which may be the trunk. They do
 *   not take a configured mapping.
 * - A colon-less word naming a local tag (`git push origin t1`) publishes the
 *   tag; `push.followTags` publishes tags beside any push, and
 *   `push.recurseSubmodules` (or `submodule.recurse`) pushes submodule
 *   branches, which may be their trunks.
 */
export interface PushRepoFacts {
  /** The current branch's short name, or `null` when HEAD is detached or names no branch. */
  head: string | null;
  /** Is `head` a trunk: `main`, `master`, or the branch `refs/remotes/origin/HEAD` names? */
  headIsDefault: boolean;
  /** The branch `refs/remotes/origin/HEAD` names, or `null`; a trunk beside main and master. */
  defaultBranch: string | null;
  /**
   * Every remote configuration names a `mirror` or `push` key for, by its
   * subsection name verbatim (a URL can be one: `[remote "../r.git"]` applies
   * to `git push ../r.git`).
   */
  remotes: ReadonlyMap<string, { mirror: boolean; push: readonly string[] }>;
  /**
   * Names with a legacy `$GIT_DIR/remotes/<name>` or `branches/<name>` file.
   * Those files can carry `Push:` lines this pass does not parse, so a push
   * that may use one is read as unreadable.
   */
  legacyRemotes: readonly string[];
  /** Short names under `refs/tags/`. */
  tags: ReadonlySet<string>;
  /**
   * Short names under `refs/heads/` (APRV-518 review fold, S3). Absent: not
   * read, and no word is known to be a local branch.
   */
  branches?: ReadonlySet<string>;
  /** `push.followTags` is on. */
  followTags: boolean;
  /** `push.recurseSubmodules` (or, unset, `submodule.recurse`) pushes submodules. */
  submodules: boolean;
}

/** How much a `git push` reading may know beyond its text. */
type PushRepoView =
  /** The pure classifier: no repository, a `HEAD` may be the trunk. */
  | { kind: "text" }
  /** The hook tried and could not read the checkout the push runs in. */
  | { kind: "unreadable" }
  | {
      kind: "read";
      facts: PushRepoFacts;
      /**
       * An earlier segment on the line can create a local tag before the push
       * runs (APRV-518 review fold, S3): `git fetch` follows tags, and `git
       * tag`, `git pull` and `git remote update` can make one.
       */
      tagsMayAppear?: boolean;
    };

/** The rule a push takes when the configuration that decides it cannot be read. */
const GIT_PUSH_CONFIG_UNREADABLE_RULE = "git-push-config-unreadable";

/**
 * The rule ids the `git-push` row answers with, so the repository pass in the
 * hook can find the segments it may need to re-read.
 */
export const GIT_PUSH_RULES: readonly string[] = [
  "git-push-force",
  "git-push-tag",
  "git-ref-delete",
  "git-push-prune",
  "git-push-implicit",
  "git-push-main",
  GIT_PUSH_HEAD_RULE_ID,
  "git-push-branch",
  "git-push-unreadable",
];

/** The rule a push takes when its word may be a tag an earlier segment creates (APRV-518 review fold, S3). */
export const GIT_PUSH_NEW_TAG_RULE = "git-push-new-tag";

/** The strictest of several push answers; on a tie the earliest is kept. */
function strictestPush(candidates: readonly (Refinement & { class: string })[]): Refinement & { class: string } {
  let best = candidates[0] as Refinement & { class: string };
  for (const candidate of candidates.slice(1)) {
    if (PUSH_CLASS_ORDER.indexOf(candidate.class) < PUSH_CLASS_ORDER.indexOf(best.class)) best = candidate;
  }
  return best;
}

/**
 * `git push` under one {@link PushRepoView}. `args` are the words after the
 * `git` binary, `push` and any global options in front of it included.
 *
 * Every view keeps APRV-517's two readings (the git grammar and the old word
 * scan, stricter wins), so nothing here answers looser than the classifier
 * did before this task. What the view adds:
 *
 * - `text`: a colon-less `HEAD`/`@` may be the trunk, so it reads as one.
 * - `unreadable`: a push whose refs or remote configuration decides (no
 *   refspec, or a colon-less refspec other than `HEAD`/`@`) is
 *   `vcs.history.rewrite`, because configuration can make either a mirror or
 *   a forced update; a `HEAD`/`@` alone, which takes no configured mapping,
 *   reads as the trunk.
 * - `read`: the current branch answers `HEAD`/`@`, and mirror, configured
 *   refspecs, local tags, `push.followTags` and submodule recursion each add
 *   the class they imply.
 */
function gitPushClass(
  args: readonly string[],
  assignments: readonly string[],
  substituted: boolean,
  view: PushRepoView,
): Refinement {
  const floor = pushFactsClass(wordPushFacts(args.slice(1)));
  const split = splitGitPush(args);
  if (split === null) return { opaque: "git push: the push subcommand is not where the classifier found it" };
  const parsed = parseGitPushArgv(split.words, assignments, substituted, split.globals);
  if (!parsed.ok) {
    if (parsed.kind === "unreadable") return { class: "vcs.history.rewrite", rule: "git-push-unreadable" };
    return { opaque: parsed.detail };
  }
  const { reading } = parsed;
  const refspecs = reading.positionals.slice(1);
  const base = {
    force: reading.force,
    tags: reading.tags,
    remove: reading.remove,
    prune: reading.prune,
    all: reading.all,
    refspecs,
  };
  // Colon-less refspecs other than `HEAD`/`@`: their destination, and their
  // force, come from a configured refspec when one maps them. A deletion's
  // refs do not (`--delete x` removes `x` whatever `remote.*.push` says).
  const named = refspecs.filter((refspec) => !refspec.includes(":") && !isCurrentBranchRefspec(refspec));
  const configDecides = !reading.remove && (refspecs.length === 0 || named.length > 0);

  if (view.kind === "text") return strictestPush([pushFactsClass({ ...base, headAs: "main" }), floor]);
  if (view.kind === "unreadable") {
    if (configDecides) return { class: "vcs.history.rewrite", rule: GIT_PUSH_CONFIG_UNREADABLE_RULE };
    // The refs are on the line, but `push.followTags` (or submodule
    // recursion) may add a tag publication the configuration alone decides.
    // A push that only deletes pushes no tags.
    const pushesRefs = !reading.remove && refspecs.some((refspec) => deletedRef(refspec) === null);
    const configured: (Refinement & { class: string })[] = pushesRefs
      ? [{ class: "release.publish", rule: GIT_PUSH_CONFIG_UNREADABLE_RULE }]
      : [];
    return strictestPush([pushFactsClass({ ...base, headAs: "main" }), floor, ...configured]);
  }

  const { facts } = view;
  const remoteWord = reading.positionals[0];
  // No repository word (`git push`, `git push --repo=m`): the push may use any
  // configured remote, so every one of them is in play.
  const inPlay = remoteWord === undefined ? [...facts.remotes.keys()] : [remoteWord];
  // A legacy file is opened by its name, so on a case-insensitive filesystem
  // `git push OLD` reads `remotes/old` (git 2.50.1 on APFS deleted a remote
  // branch through it): the name is compared without case.
  const legacy =
    remoteWord === undefined
      ? facts.legacyRemotes.length > 0
      : facts.legacyRemotes.some((name) => foldNameLower(name) === foldNameLower(remoteWord));
  if (legacy) return { class: "vcs.history.rewrite", rule: GIT_PUSH_CONFIG_UNREADABLE_RULE };

  const headAs = facts.head === null || facts.headIsDefault ? "main" : `refs/heads/${facts.head}`;
  const trunks = facts.defaultBranch === null ? [] : [facts.defaultBranch];
  const candidates: (Refinement & { class: string })[] = [pushFactsClass({ ...base, headAs, trunks }), floor];
  const mirrored = inPlay.filter((name) => facts.remotes.get(name)?.mirror === true);
  if (mirrored.length > 0) {
    // A mirror push forces and deletes. With a refspec on the line git refuses
    // to run at all, which the stricter reading costs nothing to cover.
    candidates.push({ class: "vcs.history.rewrite", rule: "git-push-config-mirror", path: mirrored.join(" ") });
  }
  if (configDecides) {
    const configured = inPlay.flatMap((name) => facts.remotes.get(name)?.push ?? []);
    if (configured.length > 0) {
      const answer = pushFactsClass({
        force: false,
        tags: false,
        remove: false,
        prune: false,
        all: false,
        refspecs: [...configured],
        trunks,
      });
      candidates.push({
        class: answer.class,
        rule: "git-push-config-refspec",
        ...("path" in answer && answer.path !== undefined ? { path: answer.path } : {}),
      });
    }
  }
  // Compared without case, as the stricter reading: on a case-insensitive
  // filesystem a loose `refs/tags/v1` and `V1` may be one file. git 2.50.1 on
  // APFS refused `git push origin V1` beside a tag `v1`, so this costs nothing
  // there.
  const foldedTags = new Set([...facts.tags].map(foldNameLower));
  // The words whose SOURCE decides what kind of ref the push writes: a
  // colon-less word, and the source of a `src:dst` whose destination does not
  // start with `refs/` (git gives such a destination the kind of its source:
  // a tag source goes to `refs/tags/<dst>`; review fold, proven on git 2.50.1).
  // A source spelled from `HEAD` / `@` or under `refs/` names no tag here.
  const sourced = [
    ...named.map((refspec) => refspec.replace(/^\+/u, "")),
    ...refspecs
      .filter((refspec) => refspec.includes(":"))
      .map((refspec) => refspec.replace(/^\+/u, ""))
      .filter((refspec) => !refspec.slice(refspec.indexOf(":") + 1).startsWith("refs/"))
      .map((refspec) => refspec.slice(0, refspec.indexOf(":")))
      .filter((source) => source.length > 0 && !/^(?:head|@)(?:[~^].*)?$/iu.test(source) && !source.startsWith("refs/")),
  ];
  const localTags = sourced.filter((name) => foldedTags.has(foldNameLower(name)));
  if (localTags.length > 0) {
    candidates.push({ class: "release.publish", rule: "git-push-local-tag", path: localTags.join(" ") });
  }
  // S3: a tag an earlier segment creates is not among `facts.tags`, which were
  // read before the line ran. A source word that is no local branch may be
  // that tag; one that IS a local branch cannot be pushed if a tag of its name
  // appears (git 2.50.1 refuses an ambiguous source), so it keeps its answer.
  if (view.tagsMayAppear === true && !reading.remove) {
    const fresh = sourced.filter((name) => !(facts.branches?.has(name) ?? false));
    if (fresh.length > 0) {
      candidates.push({ class: "release.publish", rule: GIT_PUSH_NEW_TAG_RULE, path: fresh.join(" ") });
    }
  }
  if (!reading.remove && facts.followTags) {
    candidates.push({ class: "release.publish", rule: "git-push-config-tags" });
  }
  if (!reading.remove && facts.submodules) {
    candidates.push({ class: "vcs.push.main", rule: "git-push-config-submodules" });
  }
  return strictestPush(candidates);
}

/**
 * One `git push` segment re-read under what the checkout says (APRV-518).
 *
 * `segmentText` is a {@link ClassifiedSegment.text} the classifier answered
 * with one of {@link GIT_PUSH_RULES}; it is lexed again by the SAME lexer, and
 * a sandbox wrapper is opened the same way {@link classifySegment} opens it,
 * so the argv judged here is the argv the classifier judged. `facts` holds
 * one entry per directory the push may run in (the strictest answer wins),
 * and is `null` when the hook could not read one of them.
 *
 * Returns `null` when the text is not exactly one direct `git push` (the
 * caller then fails closed), and never an answer looser than the pure
 * classifier's except one: a `HEAD`/`@` the current branch shows is not the
 * trunk, which is the `vcs.push.branch` the classifier gave before APRV-518.
 */
export function gitPushSegmentClass(
  segmentText: string,
  facts: readonly PushRepoFacts[] | null,
  options: { tagsMayAppear?: boolean } = {},
): { class: string; rule: string; path?: string } | null {
  const lexed = lex(segmentText);
  if (!lexed.ok || lexed.segments.length !== 1) return null;
  const segment = lexed.segments[0] as LexSegment;
  if (segment.opaque !== null) return null;
  const words = segment.words.map((word) => word.text);
  let cursor = 0;
  while (cursor < words.length && ASSIGNMENT.test(words[cursor] as string)) cursor += 1;
  const assignments = words.slice(0, cursor);
  for (let depth = 0; depth < SANDBOX_WRAPPER_DEPTH; depth += 1) {
    const found = sandboxWrapper(words, cursor);
    if (found === null) break;
    if (found.kind === "unreadable") return null;
    cursor += found.skip;
  }
  const bin = words[cursor];
  if (bin === undefined || (pathSegments(bin).slice(-1)[0] ?? bin) !== "git") return null;
  const substituted = segment.words.slice(cursor + 1).some((word) => word.substitutions.length > 0);
  const views: PushRepoView[] =
    facts === null
      ? [{ kind: "unreadable" }]
      : facts.map((one) => ({ kind: "read", facts: one, ...(options.tagsMayAppear === true ? { tagsMayAppear: true } : {}) }));
  const answers: (Refinement & { class: string })[] = [];
  for (const view of views) {
    const answer = gitPushClass(words.slice(cursor + 1), assignments, substituted, view);
    if ("opaque" in answer) return null;
    answers.push(answer);
  }
  if (answers.length === 0) return null;
  const { class: cls, rule, path } = strictestPush(answers) as { class: string; rule: string; path?: string };
  return { class: cls, rule, ...(path === undefined ? {} : { path }) };
}

/**
 * The class of a delete that only removes the agent's own scratch (APRV-267).
 *
 * Every `files.delete.out_of_scope` question this repository's log held between
 * 2026-08-17 and 2026-09-05 was a lane removing its own session scratchpad or a
 * probe directory under the system temp root. Eleven were approved and two
 * expired, which is thirteen human interruptions and zero decisions: an agent
 * deleting the temp files it just made is not a decision, and pricing it at a
 * person's attention spends the audit budget SPEC.md §11 asks to protect.
 *
 * It is a sibling of `files.delete.out_of_scope` and not a replacement for it.
 * Everything that is not provably scratch keeps the old class.
 */
const SCRATCH_DELETE_CLASS = "files.delete.scratch";

// ---------------------------------------------------------------------------
// Agent harnesses (APRV-354)
// ---------------------------------------------------------------------------

/**
 * Launching an agent harness is its own class family, `harness.launch.NAME`.
 *
 * Until this, a command whose first word was `codex`, `muse`, `grok`, `claude`
 * or `cursor-agent` was `unclassified`: denied, which is fail closed and also
 * blunt. It told an approver nothing, it gave a human no class to grant through
 * the ordinary manual path, and it meant a lane could not so much as read a
 * harness version without going around the gate. The family fixes the second
 * half without touching the first: an unknown class still falls to
 * `defaults.autonomy`, so a project that adopts nothing is exactly where it was.
 *
 * ## The laundering hazard, which is why this is a class and not a table row
 *
 * A launched harness runs its own tools OUTSIDE this gate unless that harness's
 * own adapter is installed and attested. So a grant of `harness.launch.codex`
 * authorizes the LAUNCH and nothing the launched session then does — every
 * file it writes, every command it runs and every request it makes happens
 * where this runtime cannot see it. A policy that made the family autonomous
 * would have written itself out of the gate in one line, which is why SPEC.md
 * §7 says the family is never inferred autonomous and why the reference
 * proposal holds it at `manual`. The blessed Codex entry point is the confined
 * `approval codex start` (APRV-325.3), which keeps its own class.
 *
 * ## Muse, which carries a second hazard
 *
 * A Muse Code model id ending `-contributor` trades price for permission to
 * train on prompts and completions, so running one over real code shares that
 * code. Carter has ruled that Muse must never run with a Contributor model
 * selected. The classifier cannot enforce that — the model is a self-reported
 * argument, and a session may select one in its own UI where no command line
 * shows it — so it does the one thing a classifier honestly can: it BINDS the
 * `--model` value where it appears and gives a contributor value its own rule
 * id, so a prompt and a policy can both see it. This may only ever RAISE
 * scrutiny. A `-standard` id, or no `--model` at all, returns the ordinary rule
 * id and changes nothing, because a self-reported field that could lower
 * scrutiny is a field an agent would learn to write (SPEC.md §11.1 invariant 4).
 *
 * ## Where the family's name lives
 *
 * {@link HARNESS_LAUNCH_PREFIX} is `core/policy-match.ts`'s, not this file's,
 * and is imported rather than repeated. Two enforcement paths refuse a launch
 * that no policy rule names (`harnessLaunchNeedsRule`), and a second spelling of
 * the prefix is the shape of bug that closes one of those doors and leaves the
 * other open.
 */

/** The rule id prefix, so a reader can tell a launch row from a probe. */
const HARNESS_LAUNCH_RULE_PREFIX = "harness-launch-";

/**
 * Harness binaries, by BASENAME, to the name their class carries.
 *
 * Basenames, because that is what {@link classifySegment} derives before any
 * rule sees a command, and it is what makes `/opt/homebrew/bin/codex`,
 * `~/.local/bin/muse` and `$HOME/.local/bin/muse` all land here without this
 * table knowing anything about where a binary lives. A spelling the basename
 * derivation cannot see through — `$MUSE_BIN`, a wrapper script of another
 * name — is `unclassified`, which is the answer it had before and the answer it
 * should keep.
 *
 * `cursor-agent` carries the name `cursor` so the class reads
 * `harness.launch.cursor` beside the `cursor` adapter and the `.cursor/`
 * protected paths. `gemini` is deliberately absent: APRV-354 names five
 * harnesses, `gemini update` keeps its `deps.upgrade` row above this one, and a
 * bare `gemini` stays `unclassified` until somebody makes that its own decision.
 */
const HARNESS_BINS: Readonly<Record<string, string>> = {
  codex: "codex",
  muse: "muse",
  grok: "grok",
  claude: "claude",
  "cursor-agent": "cursor",
  // APRV-398. `hermes` is the console script Hermes Agent installs, and the
  // harness kind and the binary share one spelling, so the class reads
  // `harness.launch.hermes` beside the `hermes` adapter and the `.hermes/`
  // protected paths with no name mapping in between.
  hermes: "hermes",
};

/**
 * Package specs a package runner may name, EXACTLY, to the same harness names.
 *
 * Exact, and the exactness is the rule: `npx codex-helper` is not a codex
 * launch, and a substring match that said it was would let any package whose
 * name happens to contain a harness's take a class it did not earn. A spec this
 * table does not know keeps whatever class the runner already had.
 */
const HARNESS_PACKAGES: Readonly<Record<string, string>> = {
  codex: "codex",
  "@openai/codex": "codex",
  claude: "claude",
  "@anthropic-ai/claude-code": "claude",
  "cursor-agent": "cursor",
  muse: "muse",
  grok: "grok",
  // APRV-398. Hermes Agent is a Python distribution, so a package runner is not
  // how it is launched; the entries exist for the same reason the `muse` and
  // `grok` ones do, which is that a spec this table does not know keeps
  // whatever class the runner already had, and a spec it does know cannot be
  // spelled around the direct row.
  hermes: "hermes",
  "hermes-agent": "hermes",
};

/**
 * Argv that starts nothing: a version or help probe.
 *
 * A probe prints a string and exits, so it is a read, and reading a harness's
 * own version is exactly what a session needs to be able to do without a
 * prompt. `help` counts only as the WHOLE argv: `codex help` prints usage,
 * while `codex help me refactor this` is a session.
 */
const HARNESS_PROBE_FLAGS: readonly string[] = ["--version", "-V", "--help", "-h"];

/** The probe's rule id and class. A probe starts no session, so it reads. */
const HARNESS_PROBE_RULE = "harness-probe";
const HARNESS_PROBE_CLASS = "read.shell";

/** The rule id a Muse launch takes when its `--model` names a Contributor model. */
const MUSE_CONTRIBUTOR_RULE = "harness-launch-muse-contributor";

/**
 * The suffix that marks a Muse model as training on what it is shown.
 *
 * Exported since APRV-350 so the hook adapter's contributor guard and this
 * classifier's `harness.launch.muse` refinement test the SAME mark. Two
 * spellings of "which models are unsafe" would drift, and the direction they
 * drift in is the one where a launch is refused and a tool call is not.
 */
export const CONTRIBUTOR_SUFFIX = "-contributor";

/** The `--model` value in either spelling, or `null` when none is written. */
function harnessModel(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--model") {
      const value = args[index + 1];
      return value === undefined || isFlag(value) ? null : value;
    }
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
  }
  return null;
}

/**
 * The harness a package spec names, version suffix stripped, or `null`.
 *
 * `@openai/codex@0.152.1` is the scoped case the split has to get right: the
 * `@` that opens a scope is not the `@` that opens a version.
 */
function harnessPackage(spec: string): string | null {
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
  const bare = at === -1 ? spec : spec.slice(0, at);
  return HARNESS_PACKAGES[bare] ?? null;
}

/**
 * One harness invocation, given its name and the argv that follows its identity.
 *
 * Shared by the direct rows and the package-runner refinement, so a launch
 * spelled `npx @openai/codex exec` answers exactly as `codex exec` does. The
 * argv is bound to `path`: the segment's own `text` carries the command as
 * written, and `path` carries the part the class is ABOUT, which is what lets a
 * channel name it without re-parsing the line.
 */
function harnessRefinement(name: string, args: readonly string[]): Refinement {
  if (
    args.length === 1 &&
    (HARNESS_PROBE_FLAGS.includes(args[0] as string) || args[0] === "help")
  ) {
    return { class: HARNESS_PROBE_CLASS, rule: HARNESS_PROBE_RULE };
  }
  // Anything else is a session. A probe flag beside other arguments is NOT a
  // probe here: the classifier cannot know which of the two the binary will
  // honour, and the stricter reading of an ambiguous harness invocation is the
  // one that assumes a session started.
  const model = name === "muse" ? harnessModel(args) : null;
  const contributor = model !== null && model.toLowerCase().endsWith(CONTRIBUTOR_SUFFIX);
  return {
    class: `${HARNESS_LAUNCH_PREFIX}${name}`,
    rule: contributor ? MUSE_CONTRIBUTOR_RULE : `${HARNESS_LAUNCH_RULE_PREFIX}${name}`,
    ...(args.length === 0 ? {} : { path: args.join(" ") }),
  };
}

/** `codex …`, `muse …`, `grok …`, `claude …`, `cursor-agent …`. */
function refineHarness(ctx: RuleContext): Refinement {
  const name = HARNESS_BINS[ctx.bin];
  // Unreachable through the table, which matches on these basenames; a defensive
  // arm rather than a silent wrong class if a row is ever edited apart from the
  // table it is generated from.
  if (name === undefined) {
    return { opaque: `${ctx.bin} is an agent harness this table cannot name` };
  }
  if (name === "hermes") {
    const organWrite = hermesOrganWrite(ctx.args);
    if (organWrite !== null) return organWrite;
  }
  return harnessRefinement(name, ctx.args);
}

/** The rule id a `hermes` subcommand that rewrites the home's organs takes (APRV-511). */
const HERMES_ORGAN_WRITE_RULE = "hermes-organ-write";

/**
 * `hermes` subcommands that rewrite the gate's organs, each with the verbs that
 * only read (APRV-511), read off Hermes v2026.9.24's parsers and dispatchers. A
 * verb not on the read list is the write, so a verb a later Hermes adds is
 * assumed to change something. `bare` is what the group does with no verb:
 * `hermes config` shows the configuration and `hermes hooks` prints usage, while
 * bare `hermes plugins` opens the interactive enable/disable toggle.
 *
 * - `plugins` installs, updates, removes, enables and disables code under
 *   `$HERMES_HOME/plugins/` and the `plugins.enabled`/`disabled` lists in
 *   `config.yaml`; `pack install` does the same in bulk.
 * - `config` `set`/`unset`/`edit`/`migrate` rewrite `config.yaml`.
 * - `hooks` `revoke` (`remove`, `rm`) rewrites the consent allowlist.
 * - `update` rewrites `$HERMES_HOME/hermes-agent/`, and `uninstall` removes it.
 *
 * A write through the CLI is the same act as the file write it performs, so it
 * takes the same class, `policy.core`. On an Agent Village box the overlay
 * installs and enables plugins at provisioning, outside any hooked tool call.
 * Every other subcommand keeps `harness.launch.hermes`.
 */
const HERMES_ORGAN_SUBCOMMANDS: Readonly<Record<string, { reads: readonly string[]; bare: "read" | "write" }>> = {
  plugins: {
    reads: ["search", "browse", "validate", "list", "ls", "capabilities", "doctor", "compat", "show", "info"],
    bare: "write",
  },
  config: { reads: ["show", "get", "path", "env-path", "check"], bare: "read" },
  hooks: { reads: ["list", "ls", "test", "doctor"], bare: "read" },
  update: { reads: [], bare: "write" },
  uninstall: { reads: [], bare: "write" },
};

/**
 * The `policy.core` answer for a `hermes` argv that rewrites an organ, or
 * `null` for every other argv (APRV-511).
 *
 * The classifier does not know which of Hermes's flags take a value, so a word
 * directly after a flag written without `=` may be that flag's value, and every
 * reading below that depends on such a word resolves to the write:
 *
 * - The subcommand is the first word that is not a flag, skipping a word that
 *   directly follows a flag (`hermes -p work plugins install x`). A group word
 *   in that position is still taken as the group, the stricter reading.
 * - The verb is the first word after the group that is not a flag. When it
 *   directly follows a flag (`hermes plugins --source list install x`, where
 *   `list` may be the value), the verb is unknown and the answer is the write.
 * - A help request (`--help`, `-h`) keeps the earlier answer only as a flag in
 *   its own right: argparse prints usage and exits before any handler runs. It
 *   is not honoured when it directly follows a flag (`hermes plugins install
 *   --name --help`, where it may be the value), nor after `--`.
 * - An end-of-options `--` anywhere in the argv makes every later word a
 *   positional to the real CLI (`hermes plugins install x -- --help` installs),
 *   so an organ group's argv carrying one is the write, whatever else it says,
 *   and so is an organ group word after a leading `--` (`hermes -- plugins
 *   install x`), which argparse still dispatches to the subcommand.
 *
 * `hermes plugins --help install x` is a read: the `plugins` parser meets
 * `--help` before the verb and exits with usage.
 */
function hermesOrganWrite(args: readonly string[]): Refinement | null {
  const write: Refinement = { class: "policy.core", rule: HERMES_ORGAN_WRITE_RULE, path: args.join(" ") };
  /** Could `args[index]` be the value of the flag before it? */
  const mayBeValue = (index: number): boolean => {
    const previous = index === 0 ? undefined : args[index - 1];
    return previous !== undefined && previous.startsWith("-") && previous !== "--" && !previous.includes("=");
  };
  let at = -1;
  for (const [index, arg] of args.entries()) {
    if (arg === "--") {
      // argparse still hands a subcommand word after `--` to its subparsers
      // (`hermes -- plugins install x`), so an organ group there is the write.
      return args.slice(index + 1).some((word) => Object.hasOwn(HERMES_ORGAN_SUBCOMMANDS, word)) ? write : null;
    }
    if (arg.startsWith("-")) continue;
    if (Object.hasOwn(HERMES_ORGAN_SUBCOMMANDS, arg)) {
      at = index;
      break;
    }
    if (mayBeValue(index)) continue;
    return null;
  }
  if (at === -1) return null;
  if (args.includes("--")) return write;
  const helped = args.some((arg, index) => (arg === "--help" || arg === "-h") && !mayBeValue(index));
  if (helped) return null;
  const spec = HERMES_ORGAN_SUBCOMMANDS[args[at] as string] as { reads: readonly string[]; bare: "read" | "write" };
  const verbAt = args.findIndex((arg, index) => index > at && !arg.startsWith("-"));
  if (verbAt === -1) return spec.bare === "read" ? null : write;
  if (mayBeValue(verbAt)) return write;
  const verb = args[verbAt] as string;
  if (spec.reads.includes(verb)) return null;
  // `plugins pack` writes only in its `install` form.
  if (args[at] === "plugins" && verb === "pack") {
    const formAt = args.findIndex((arg, index) => index > verbAt && !arg.startsWith("-"));
    const form = formAt === -1 ? undefined : args[formAt];
    if ((form === "show" || form === "export") && !mayBeValue(formAt)) return null;
  }
  return write;
}

/**
 * `npx`, `tsx`, `tsc`, … — unchanged, except a package runner naming a harness.
 *
 * `npx @openai/codex` starts the same session `codex` starts, and before this
 * it was `files.write.workspace`: the looser of the two answers, reachable by
 * typing four extra characters. The refinement is deliberately narrow — only
 * `npx`, only an EXACT package spec, and everything else returns the row's own
 * answer byte for byte, which is what keeps this from being a widening of the
 * workspace-tool row.
 */
function refineWorkspaceTool(ctx: RuleContext): Refinement {
  const unchanged: Refinement = { class: "files.write.workspace", rule: "workspace-tool" };
  if (ctx.bin !== "npx") return unchanged;
  const index = ctx.args.findIndex((arg) => !isFlag(arg));
  if (index === -1) return unchanged;
  const name = harnessPackage(ctx.args[index] as string);
  if (name === null) return unchanged;
  return harnessRefinement(name, ctx.args.slice(index + 1));
}

/** The five generated harness rows, one per binary, sharing one refinement. */
const HARNESS_RULES: readonly CommandRule[] = Object.entries(HARNESS_BINS).map(([bin, name]) => ({
  id: `${HARNESS_LAUNCH_RULE_PREFIX}${name}`,
  bins: [bin],
  class: `${HARNESS_LAUNCH_PREFIX}${name}`,
  // APRV-511: `hermes plugins install` and its kin rewrite the home's organs.
  emits: name === "hermes" ? [HARNESS_PROBE_CLASS, "policy.core"] : [HARNESS_PROBE_CLASS],
  refine: refineHarness,
}));

/**
 * Is `candidate` a STRICT descendant of `root`? Both are compared by path
 * segment, so `/private/tmpfoo` is not under `/private/tmp` and a root is never
 * under itself: deleting the temp root wholesale is not tidying up.
 *
 * Pure segment matching, like every other path test in this file. The caller
 * has already resolved both sides (see {@link ClassifierContext}).
 */
function isUnderRoot(candidate: string, root: string): boolean {
  const want = pathSegments(root);
  const have = pathSegments(candidate);
  if (want.length === 0) return false;
  if (have.length <= want.length) return false;
  return want.every((segment, index) => segment === have[index]);
}

/**
 * Does every one of these targets sit strictly under a scratch root?
 *
 * Four ways to say no, and each is a fail-closed branch rather than a filter:
 * an empty target list (an `rm` with only flags is not a delete this rule can
 * vouch for), a relative path (its meaning depends on a working directory the
 * classifier does not have), a `..` segment or an unreadable value (either can
 * leave the root after expansion), and a path under no root at all. ALL targets
 * must pass, because the class describes the command and a command that removes
 * one scratch file and one real one is not a scratch delete.
 */
function allTargetsAreScratch(
  targets: readonly string[],
  roots: readonly string[],
): boolean {
  if (targets.length === 0 || roots.length === 0) return false;
  for (const target of targets) {
    if (!target.startsWith("/")) return false;
    if (isUnknownValue(target)) return false;
    if (pathSegments(target).includes("..")) return false;
    if (!roots.some((root) => isUnderRoot(target, root))) return false;
  }
  return true;
}

// ===========================================================================
// Read scope (read.file.out_of_scope, APRV-347)
// ===========================================================================

/** The rule id for a read whose ABSOLUTE target sits outside every root. */
export const READ_OUT_OF_SCOPE_RULE = "read-out-of-scope";

/** The rule id for a read target whose expansion the text cannot show. */
export const READ_UNREADABLE_TARGET_RULE = "read-unreadable-path";

/**
 * The first target of this read command that the TEXT places outside every
 * root, or `null` when nothing here settles it.
 *
 * `null` covers three different situations on purpose, and all three are
 * handed on rather than decided: the binary is not a scoped reader, every
 * target is provably inside a root, or a target is relative (or carries `..`)
 * and therefore means nothing without a working directory. The last of those
 * is the common case, and it is why the hook's second pass exists.
 */
function escapedReadTarget(
  bin: string,
  positionals: readonly string[],
  args: readonly string[],
  roots: readonly string[],
): { path: string; rule: string } | null {
  const targets = readTargetsOf(bin, positionals, args);
  if (targets === null) return null;
  for (const target of targets) {
    switch (readTargetVerdict(target, roots)) {
      case "out-of-scope":
        return {
          path: target,
          rule: isUnreadableTarget(target)
            ? READ_UNREADABLE_TARGET_RULE
            : READ_OUT_OF_SCOPE_RULE,
        };
      case "in-scope":
      case "needs-disk":
        break;
    }
  }
  return null;
}

/**
 * The first `<` target the text places outside every root, or `null`
 * (APRV-522, S2). The same verdict a positional read target gets: a `<` opens
 * its target for reading, so a reader fed a file through `<` reads the file
 * it would read named as a positional. A relative target is `needs-disk` and is left to the
 * hook's disk pass, as a relative positional is.
 */
function redirectReadEscape(
  readTargets: readonly string[],
  roots: readonly string[],
): { path: string; rule: string } | null {
  for (const target of readTargets) {
    if (readTargetVerdict(target, roots) === "out-of-scope") {
      return {
        path: target,
        rule: isUnreadableTarget(target) ? READ_UNREADABLE_TARGET_RULE : READ_OUT_OF_SCOPE_RULE,
      };
    }
  }
  return null;
}

/** `rm` — everything outside the workspace, and every unreadable path, is manual. */
function refineRm(ctx: RuleContext): Refinement {
  const recursive =
    hasFlag(ctx.args, ["--recursive"]) || hasShortFlag(ctx.args, ["r", "R"]);
  // APRV-267, checked first because it is the narrowest branch: every target
  // strictly under a root the CALLER resolved, with no `..` and nothing the
  // text cannot read. The symlink and git-checkout halves of the rule need the
  // disk and live in `src/cli/hook.ts`, which can only tighten this answer back
  // to `files.delete.out_of_scope`; a caller that passes no roots never reaches
  // this branch at all.
  if (allTargetsAreScratch(ctx.positionals, ctx.context.scratchRoots ?? [])) {
    return { class: SCRATCH_DELETE_CLASS, rule: "rm-scratch" };
  }
  for (const path of ctx.positionals) {
    if (path.startsWith("/")) return { class: "files.delete.out_of_scope", rule: "rm-absolute" };
    if (pathSegments(path).includes("..")) {
      return { class: "files.delete.out_of_scope", rule: "rm-parent" };
    }
    if (isUnknownValue(path)) {
      return { class: "files.delete.out_of_scope", rule: "rm-unreadable-path" };
    }
    if (recursive && (path === "." || path === "..")) {
      return { class: "files.delete.out_of_scope", rule: "rm-recursive-root" };
    }
  }
  return { class: "files.write.workspace", rule: "rm-workspace" };
}

// ---------------------------------------------------------------------------
// git global options (APRV-520)
// ---------------------------------------------------------------------------

/**
 * The git global options that take a value, read from git 2.50.1's
 * `handle_options` table (the options git(1) lists between `git` and
 * `<command>`, plus the undocumented `--shallow-file`; the strings are in the
 * installed binary). The separate spelling consumes the NEXT argv word, so the
 * first positional this classifier reads is that value and not the subcommand:
 * `git -C status push --force origin main` is a force push in the directory
 * `status`, and it classified as `read.shell`. The `=`-joined long spellings
 * shift nothing, but they repoint the repository, its configuration or (for
 * `--exec-path=`) the directory git runs its helpers and hooks from, which is
 * the same question this table answers for the separate spelling: what does
 * the command act on? So every one of them leaves the segment `unclassified`,
 * which the hook refuses (`hook-unclassified`, in every mode, an open window
 * included), rather than this classifier re-deriving the subcommand.
 * `--super-prefix` is gone from git 2.50 and kept here because an older git
 * still consumes its value.
 */
const GIT_VALUE_GLOBALS: readonly string[] = [
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--attr-source",
  "--shallow-file",
];

/** The `=`-joined long spellings git accepts for a value-taking global. */
const GIT_JOINED_VALUE_GLOBALS: readonly string[] = [
  "--config-env=",
  "--git-dir=",
  "--work-tree=",
  "--namespace=",
  "--super-prefix=",
  "--attr-source=",
  "--exec-path=",
];

/**
 * The git global options that take no value, exactly as git 2.50.1 spells
 * them (no prefix abbreviation: git compares each one whole). Each is skipped
 * as it was before APRV-520. `--html-path`, `--man-path`, `--info-path`, a bare
 * `--exec-path` and `--list-cmds=` print and exit before any subcommand runs,
 * so reading on past them only ever answers stricter than git behaves.
 */
const GIT_ZERO_VALUE_GLOBALS: readonly string[] = [
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--bare",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-advice",
  "--html-path",
  "--man-path",
  "--info-path",
  "--exec-path",
];

/**
 * The options at which git stops reading globals: it runs `git version` or
 * `git help` with the rest of the line as that command's arguments. Left to
 * the handling they had before APRV-520.
 */
const GIT_GLOBALS_END: readonly string[] = ["-h", "--help", "-v", "--version"];

/**
 * Why the git global options in front of the subcommand leave this segment
 * `unclassified`, or `null` when they do not (APRV-520). Only the words before
 * the first non-flag word are globals; after it they belong to the subcommand
 * (`git commit -C <commit>` is the commit's own option).
 */
function gitGlobalRefusal(args: readonly string[]): string | null {
  for (const word of args) {
    if (!isFlag(word) || GIT_GLOBALS_END.includes(word)) return null;
    if (GIT_ZERO_VALUE_GLOBALS.includes(word) || word.startsWith("--list-cmds=")) continue;
    if (GIT_VALUE_GLOBALS.includes(word)) {
      return `no rule for git ${word} <value>: the global option takes the next word as its value, so the first positional is not the subcommand`;
    }
    const joined = GIT_JOINED_VALUE_GLOBALS.find((prefix) => word.startsWith(prefix));
    if (joined !== undefined) {
      return `no rule for git ${joined}<value>: the global option repoints what the subcommand acts on`;
    }
    return `no rule for the git global option ${word}: an option this classifier does not know may take the next word as its value`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Environment assignments in front of git (APRV-521)
// ---------------------------------------------------------------------------

/**
 * The `NAME=value` words that may stand in front of `git`, compared as whole
 * words (APRV-521). A CLOSED list: any other assignment in front of `git`
 * leaves the segment `unclassified`, because git(1)'s ENVIRONMENT section is
 * mostly variables that run a program (`GIT_PAGER`, `GIT_EDITOR`,
 * `GIT_SEQUENCE_EDITOR`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
 * `GIT_EXTERNAL_DIFF`), repoint the repository (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`,
 * `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`), redirect the
 * configuration (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
 * `GIT_CONFIG_NOSYSTEM`, and git-config(1)'s `GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`; `GIT_CONFIG_PARAMETERS` is the
 * internal carrier of `-c`), move the helper directory (`GIT_EXEC_PATH`), or
 * write a file (`GIT_TRACE*=<absolute path>` appends to it). `GIT_PAGER=evil
 * git log` ran `evil` and classified `read.shell`.
 *
 * Each entry below can only remove a program git would otherwise run, or
 * swap it for a no-op, and none names a path, a repository or configuration:
 *
 * - `GIT_TERMINAL_PROMPT=0`: git(1), "If this Boolean environment variable is
 *   set to false, git will not prompt on the terminal". It silences a prompt.
 * - `GIT_PAGER=cat`: git(1), "If it is set to an empty string or to the value
 *   "cat", Git will not launch a pager". No program runs.
 * - `PAGER=cat`: git(1) GIT_PAGER "overrides $PAGER", and the same `cat` test
 *   applies to whichever source supplied the pager. Where `GIT_PAGER` or
 *   `core.pager` is set, that pager runs with or without this word.
 * - `GIT_EDITOR=true`, `GIT_EDITOR=:`: git(1) GIT_EDITOR "overrides $EDITOR and
 *   $VISUAL". git skips the editor outright for `:` and runs the no-op `true`
 *   otherwise, so the file is left as git wrote it. `GIT_SEQUENCE_EDITOR`
 *   still outranks it for a rebase todo list, exactly as without the word.
 * - `EDITOR=true`, `EDITOR=:`, `VISUAL=true`, `VISUAL=:`: the fallbacks below
 *   `GIT_EDITOR` and `core.editor`, set to the same no-ops. These four and the
 *   two above are APRV-433's (#648) harmless-assignment list, kept equal so a
 *   spelling that list judges local is not refused here first.
 *
 * {@link isHarmlessGitAssignment} also admits the locale and the zone with a
 * plain value. git(1) names neither: git reads them only through the C library
 * (`setlocale`, `localtime`), and a value with no `/` and no `..` is looked up
 * inside the system's locale or zone database, never as a file the agent
 * chose. `LANGUAGE` is left out (git(1) does not name it either, and its
 * colon list is read by gettext).
 */
const GIT_HARMLESS_ASSIGNMENTS: readonly string[] = [
  "GIT_TERMINAL_PROMPT=0",
  "GIT_PAGER=cat",
  "PAGER=cat",
  "GIT_EDITOR=true",
  "GIT_EDITOR=:",
  "EDITOR=true",
  "EDITOR=:",
  "VISUAL=true",
  "VISUAL=:",
];

/** The locale variables, POSIX's and glibc's, admitted with a plain value. */
const GIT_LOCALE_NAMES: readonly string[] = [
  "LANG",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
];

/** A locale name (`C`, `POSIX`, `C.UTF-8`, `en_US.UTF-8`, `sr_RS@latin`), never a path. */
const PLAIN_LOCALE = /^[A-Za-z][A-Za-z0-9_@.-]*$/u;

/**
 * May this assignment word stand in front of `git` without changing what the
 * subcommand runs, reads or writes ({@link GIT_HARMLESS_ASSIGNMENTS})? A word
 * carrying a command substitution never may: its value is not in the text.
 */
function isHarmlessGitAssignment(word: LexWord): boolean {
  if (word.substitutions.length > 0) return false;
  const text = word.text;
  // Only the plain `NAME=value` spelling ({@link PLAIN_ASSIGNMENT}).
  if (!PLAIN_ASSIGNMENT.test(text)) return false;
  if (GIT_HARMLESS_ASSIGNMENTS.includes(text)) return true;
  const equals = text.indexOf("=");
  if (equals <= 0) return false;
  const name = text.slice(0, equals);
  const value = text.slice(equals + 1);
  if (name === "TZ") return isZoneValue(value);
  if (GIT_LOCALE_NAMES.includes(name)) return PLAIN_LOCALE.test(value) && !value.includes("..");
  return false;
}

/**
 * Why the assignments in front of `git` leave the segment `unclassified`, or
 * `null` when every one is harmless (APRV-521).
 */
function gitAssignmentRefusal(prefix: readonly LexWord[]): string | null {
  const word = prefix.find((candidate) => !isHarmlessGitAssignment(candidate));
  if (word === undefined) return null;
  return `no rule for ${assignmentHead(word.text)}… in front of git: an environment assignment can run a program, repoint the repository or its configuration, or write a file`;
}

/**
 * Is this a variable git, or a program git starts (its pager, editor, ssh,
 * askpass helper, hooks), reads to pick a program, a library, a repository,
 * configuration or a file to write (APRV-521)? Read by the command-line scan
 * ({@link gitEnvironmentWrite}) and the bare-assignment rule, where a value
 * reaches git only if the name was already exported: so the scan is bounded
 * to these names, and an ordinary script variable (`b=$(git branch
 * --show-current); git push origin "$b"`) is left alone. In front of `git`
 * itself no name is trusted: {@link gitAssignmentRefusal} is a closed list.
 */
function isGitInheritedName(name: string): boolean {
  if (/^(?:GIT_|XDG_|LESS|LC_|LD_|DYLD_)/u.test(name)) return true;
  return [
    "PAGER",
    "EDITOR",
    "VISUAL",
    "LV",
    "HOME",
    "PATH",
    "TMPDIR",
    "SSH_ASKPASS",
    "BASH_ENV",
    "ENV",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TZDIR",
    "LOCPATH",
    "GCONV_PATH",
    "GNUPGHOME",
  ].includes(name);
}

/** The builtins that set or export a variable named in their arguments. */
const SHELL_SETTING_BUILTINS: readonly string[] = ["export", "declare", "typeset", "readonly", "local"];

/**
 * POSIX's special builtins: an assignment in front of one persists in the
 * shell (in `sh` and in bash's POSIX mode) rather than reaching that command
 * alone.
 */
const POSIX_SPECIAL_BUILTINS: readonly string[] = [
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "times",
  "trap",
  "unset",
];

/**
 * `${NAME=word}` and `${NAME:=word}` assign NAME in the shell that expands
 * them, and so do `${NAME[i]=word}` and `${NAME[i]:=word}` (review-b N2).
 */
const PARAMETER_ASSIGNMENT = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?:?=/u;

/**
 * The first variable git could inherit ({@link isGitInheritedName}) that this
 * command line's own shell sets to something other than a harmless value, or
 * `null` (APRV-521). Counted: a bare `NAME=value` (it reaches every later
 * command when NAME is already exported), an assignment in front of a POSIX
 * special builtin, the arguments of `export`, `declare`, `typeset`, `readonly`
 * and `local` (a bare `export NAME` exports a value the text does not show),
 * `printf -v NAME`, and `${NAME=word}` / `${NAME:=word}` in any word.
 *
 * The whole line is read, not just the part before a `git` segment: a loop
 * body runs again after its own later assignments. A subshell or a pipeline
 * stage that keeps its assignment to itself is counted too, which only ever
 * refuses more.
 */
function gitEnvironmentWrite(segments: readonly LexSegment[]): string | null {
  const nameOf = assignedName;
  for (const segment of segments) {
    const words = segment.words;
    let cursor = 0;
    while (cursor < words.length && ASSIGNMENT.test((words[cursor] as LexWord).text)) cursor += 1;
    const binWord = words[cursor];
    const base = binWord === undefined ? null : (pathSegments(binWord.text).slice(-1)[0] ?? binWord.text);
    if (base === null || POSIX_SPECIAL_BUILTINS.includes(base)) {
      for (const word of words.slice(0, cursor)) {
        if (isGitInheritedName(nameOf(word.text)) && !isHarmlessGitAssignment(word)) return nameOf(word.text);
      }
    }
    if (base !== null && SHELL_SETTING_BUILTINS.includes(base)) {
      for (const word of words.slice(cursor + 1)) {
        if (isFlag(word.text)) continue;
        const name = nameOf(word.text);
        // The name as written, subscript included: `a[$x]` is not a name the text settles.
        const written = word.text.includes("=") ? word.text.slice(0, word.text.indexOf("=")) : word.text;
        if (/[$`]/u.test(written)) return name;
        if (isGitInheritedName(name) && !isHarmlessGitAssignment(word)) return name;
      }
    }
    if (base === "printf") {
      const args = words.slice(cursor + 1).map((word) => word.text);
      for (let at = 0; at < args.length; at += 1) {
        const arg = args[at] as string;
        if (arg === "--") break;
        const name = arg === "-v" ? args[at + 1] : arg.startsWith("-v") ? arg.slice(2) : undefined;
        if (name === undefined) continue;
        const bare = name.replace(/\[.*$/su, "");
        if (/[$`]/u.test(bare) || isGitInheritedName(bare)) return bare;
      }
    }
    for (const word of [...words, ...segment.redirects.map((redirect) => redirect.target)]) {
      const match = PARAMETER_ASSIGNMENT.exec(word.text);
      if (match !== null && isGitInheritedName(match[1] as string)) return match[1] as string;
    }
  }
  return null;
}

/** `git commit --amend` rewrites; a plain commit does not. */
function refineGitCommit(ctx: RuleContext): Refinement {
  return hasFlag(ctx.args, ["--amend"])
    ? { class: "vcs.history.rewrite", rule: "git-commit-amend" }
    : { class: "vcs.commit.branch", rule: "git-commit" };
}

/** `git reset --hard` discards committed work; a soft reset moves a pointer. */
function refineGitReset(ctx: RuleContext): Refinement {
  return hasFlag(ctx.args, ["--hard"])
    ? { class: "vcs.history.rewrite", rule: "git-reset-hard" }
    : { class: "vcs.commit.branch", rule: "git-reset" };
}

/**
 * `git remote` that only reads (APRV-518). A closed list; every other form,
 * and every form whose words the text cannot read, writes.
 *
 * `git remote add --mirror=push m <url>` used to be `read.vcs.remote`, and a
 * following `git push m` read as an implicit `vcs.push.main`. It is a mirror
 * push: on git 2.50.1 it deleted every remote branch the checkout lacked. The
 * other writing subcommands move the same configuration around: `rename`
 * carries a mirror or push refspec onto another name (`origin`), `set-url`
 * points one at another repository, `set-head` changes the branch
 * `refs/remotes/origin/HEAD` names (which is how a trunk other than main is
 * recognised), and `remove`, `prune`, `set-branches` and `update --prune`
 * delete or re-scope the refs and keys a later reading relies on.
 *
 * So a writing form takes the class of the push it can arm, the strictest the
 * push row answers: a mirror push is `vcs.history.rewrite` (APRV-517 reads
 * `--mirror` as a force). No narrower existing class fits: `vcs.ref.delete`
 * is below a mirror push, and `policy.*` is the gate's own surface.
 *
 * What reads, and why it is safe to keep reading:
 *
 * - `git remote`, `git remote -v` / `--verbose`: lists.
 * - `show [-n] <name>…`: prints, asking the remote (`-n` asks nothing).
 * - `get-url [--push] [--all] <name>`: prints a configured URL.
 * - `update [--no-prune] [<group>|<remote>…]`: `git fetch` of those remotes,
 *   which is what `git fetch` is everywhere in this table. With `-p` /
 *   `--prune` (or any other option) it writes.
 */
const GIT_REMOTE_WRITE: Refinement = { class: "vcs.history.rewrite", rule: "git-remote-write" };
const GIT_REMOTE_READ: Refinement = { class: "read.vcs.remote", rule: "git-remote-read" };

function refineGitRemote(ctx: RuleContext): Refinement {
  if (ctx.sub !== "remote") return GIT_REMOTE_READ;
  // A word that came out of a substitution may be the subcommand.
  if (ctx.substituted) return GIT_REMOTE_WRITE;
  const at = ctx.args.findIndex((word) => !isFlag(word));
  const rest = ctx.args.slice(at + 1);
  let index = 0;
  while (index < rest.length && (rest[index] === "-v" || rest[index] === "--verbose")) index += 1;
  const sub = rest[index];
  if (sub === undefined) return GIT_REMOTE_READ;
  const tail = rest.slice(index + 1);
  const only = (flags: readonly string[]): boolean =>
    tail.every((word) => (isFlag(word) ? flags.includes(word) : true));
  switch (sub) {
    case "show":
      return only(["-n"]) ? GIT_REMOTE_READ : GIT_REMOTE_WRITE;
    case "get-url":
      return only(["--push", "--all", "--no-push", "--no-all"]) ? GIT_REMOTE_READ : GIT_REMOTE_WRITE;
    case "update":
      // A word the shell may expand could be `--prune`.
      return only(["--no-prune"]) && !tail.some(isUnreadablePushWord) ? GIT_REMOTE_READ : GIT_REMOTE_WRITE;
    default:
      return GIT_REMOTE_WRITE;
  }
}

/** The rule a write into a git directory takes (APRV-518). */
const GIT_DIR_WRITE_RULE = "git-dir-write";

/** Does this path have a `.git` segment (the directory, or a worktree's `.git` file)? */
function namesGitDirectory(word: string): boolean {
  return mayNameGitDirectory(word);
}

/** Past this many brace alternatives a word is judged as naming `.git`. */
const BRACE_LIMIT = 1024;

/** Past this many brace alternatives a word with outputs in it is judged as joining into `.git`. */
const JOIN_BRACE_LIMIT = 16;

/**
 * Past this many expansion steps, the same: each step re-reads the word, and
 * a group of one alternative (`{a..a}`) adds a step but no word (codex's
 * SOURCE HOLD on 1d42d749). A step is one visit of the worklist: a group
 * expanded, or a finished word, so 63 one-alternative groups finish and 64
 * count.
 */
const JOIN_BRACE_STEPS = 64;

/**
 * The words brace expansion makes of `word` (second review, S1): `.g{i,}t`
 * gives `.git` and `.gt`, `.{f..h}it` gives `.fit`, `.git` and `.hit`.
 * `null` past {@link BRACE_LIMIT}, or past `steps` visits of its worklist (a
 * group expanded or a word finished), which the caller judges the strict way. A group with no comma and no sequence is kept
 * as text, as the shell keeps it.
 */
export function expandBraces(word: string, limit = BRACE_LIMIT, steps = Number.POSITIVE_INFINITY): string[] | null {
  const done: string[] = [];
  const pending = [word];
  let taken = 0;
  while (pending.length > 0) {
    taken += 1;
    if (taken > steps) return null;
    const current = pending.pop() as string;
    const group = braceGroup(current);
    if (group === null) {
      done.push(current);
    } else {
      for (const part of group.parts) pending.push(`${current.slice(0, group.start)}${part}${current.slice(group.end + 1)}`);
    }
    if (done.length + pending.length > limit) return null;
  }
  return done;
}

/**
 * Where each `{` of `word` closes, and its commas at its own depth, from ONE
 * pass (#677's own cost: scanning from every `{` to its close was quadratic,
 * and `{` x 40,000, `a`, `}` x 40,000 took 3.7 CPU seconds, a minute near
 * 160,000).
 *
 * The scan from a `{` at `start` skips the same escaped characters as a scan
 * from the word's start does after `start` (the `{` itself is no backslash),
 * so its depth at any later position is the word's depth there, minus the
 * word's depth just after `start`, plus one. The group closes at the first `}`
 * that brings the word's depth to one below that, and its commas are the
 * unescaped commas at exactly that depth in between. A `{` the word-level scan
 * skips as escaped is still a start, as `indexOf` finds it, with the depth
 * unchanged.
 */
function braceIndex(word: string): {
  depthAfter: Map<number, number>;
  closes: Map<number, number[]>;
  commas: Map<number, number[]>;
} {
  const depthAfter = new Map<number, number>();
  const closes = new Map<number, number[]>();
  const commas = new Map<number, number[]>();
  const push = (map: Map<number, number[]>, key: number, at: number): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [at]);
    else list.push(at);
  };
  let depth = 0;
  for (let at = 0; at < word.length; at += 1) {
    const char = word[at];
    if (char === "\\") {
      if (word[at + 1] === "{") depthAfter.set(at + 1, depth);
      at += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      depthAfter.set(at, depth);
    } else if (char === "}") {
      depth -= 1;
      push(closes, depth, at);
    } else if (char === ",") {
      push(commas, depth, at);
    }
  }
  return { depthAfter, closes, commas };
}

/** The index of the first entry of the ascending `list` above `after`, or `list.length`. */
function firstAbove(list: readonly number[], after: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((list[middle] as number) > after) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The first brace group of `word` the shell would expand, with its alternatives. */
function braceGroup(word: string): { start: number; end: number; parts: string[] } | null {
  if (!word.includes("{")) return null;
  const index = braceIndex(word);
  for (let start = word.indexOf("{"); start !== -1; start = word.indexOf("{", start + 1)) {
    const base = index.depthAfter.get(start) as number;
    const closesAt = index.closes.get(base - 1) ?? [];
    const next = firstAbove(closesAt, start);
    if (next === closesAt.length) return null;
    const end = closesAt[next] as number;
    const commasAt = index.commas.get(base) ?? [];
    const cuts: number[] = [];
    for (let at = firstAbove(commasAt, start); at < commasAt.length && (commasAt[at] as number) < end; at += 1) {
      cuts.push(commasAt[at] as number);
    }
    const body = word.slice(start + 1, end);
    if (cuts.length > 0) {
      const parts: string[] = [];
      let from = start + 1;
      for (const cut of [...cuts, end]) {
        parts.push(word.slice(from, cut));
        from = cut + 1;
      }
      return { start, end, parts };
    }
    const sequence = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/u.exec(body);
    if (sequence !== null) {
      const [first, last] = [sequence[1] as string, sequence[2] as string];
      const numeric = /\d/u.test(first) && /\d/u.test(last);
      // Every alternative of a numeric sequence holds a digit, and `.git`
      // holds none, so one stands for them all (`touch f{1..300}` is no `.git`).
      if (numeric) return { start, end, parts: ["0"] };
      if (first.length !== 1 || last.length !== 1) continue;
      const from = numeric ? Number(first) : first.charCodeAt(0);
      const to = numeric ? Number(last) : last.charCodeAt(0);
      if (Math.abs(to - from) > BRACE_LIMIT) return { start, end, parts: Array.from({ length: BRACE_LIMIT + 1 }, () => "") };
      const parts: string[] = [];
      for (let at = from; from <= to ? at <= to : at >= to; at += from <= to ? 1 : -1) {
        parts.push(numeric ? String(at) : String.fromCharCode(at));
      }
      return { start, end, parts };
    }
  }
  return null;
}

/** Does this one path segment hold a glob character the shell would expand? */
export function isPatternSegment(segment: string): boolean {
  return /[*?[]/u.test(segment);
}

/** Past this many glob characters one pattern segment is judged to match. */
const GLOB_ELEMENT_LIMIT = 1024;

/**
 * One element of a glob pattern segment: a run of any characters but `/`
 * (`*`, and an unclosed bracket expression holding a class), or exactly one
 * character, tested by the expression source of that one character.
 */
type GlobElement = { star: true } | { star: false; source: string; test?: RegExp };

/** The last pattern read into elements, so a disk walk reads it once. */
let globElementsCache: { pattern: string; elements: GlobElement[] | null } | null = null;

/**
 * A glob pattern segment as elements (review of the substitution fold, M1),
 * read exactly as the anchored expression this matcher used to build was:
 * an escaped character is itself, `*` a run, `?` one character, a bracket
 * expression one character (any one when it holds a POSIX class), an
 * unclosed `[` a literal unless a class inside it left the reading uncertain
 * (then a run, and nothing after it is read). Runs next to each other are
 * one. `null` past {@link GLOB_ELEMENT_LIMIT} glob characters, or when a
 * bracket expression cannot be turned into an expression: the caller judges
 * both the strict way.
 */
function globElements(pattern: string): GlobElement[] | null {
  if (globElementsCache !== null && globElementsCache.pattern === pattern) return globElementsCache.elements;
  let globs = 0;
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at];
    if ((char === "*" || char === "?" || char === "[") && (globs += 1) > GLOB_ELEMENT_LIMIT) {
      globElementsCache = { pattern, elements: null };
      return null;
    }
  }
  const elements: GlobElement[] = [];
  const star = (): void => {
    if (elements[elements.length - 1]?.star !== true) elements.push({ star: true });
  };
  const one = (source: string): void => {
    // A surrogate pair split over two units is one character, as it was in
    // the one expression.
    const last = elements[elements.length - 1];
    if (last !== undefined && !last.star && /^[\uD800-\uDBFF]$/u.test(last.source) && /^[\uDC00-\uDFFF]$/u.test(source)) {
      last.source += source;
      return;
    }
    elements.push({ star: false, source });
  };
  // Once a `[` is unclosed with no class inside, every later `[` is too: its
  // scan would visit the same characters. Read once, not once per `[`.
  let unclosedFrom = -1;
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] as string;
    if (char === "\\" && at + 1 < pattern.length) {
      at += 1;
      one((pattern[at] as string).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    } else if (char === "*") {
      star();
    } else if (char === "?") {
      one("[^/]");
    } else if (char === "[") {
      if (unclosedFrom !== -1 && at > unclosedFrom) {
        one("\\[");
        continue;
      }
      // A bracket expression: a leading `!` or `^` negates it and a leading
      // `]` is a member; a POSIX class, equivalence class or collating
      // element (`[:alpha:]`, `[=g=]`, `[.g.]`) is skipped to its own close
      // and makes the expression match ANY one character, the strict side
      // (review of the second fold). Unclosed, the `[` is a literal.
      let close = at + 1;
      if (pattern[close] === "!" || pattern[close] === "^") close += 1;
      if (pattern[close] === "]") close += 1;
      let posix = false;
      while (close < pattern.length && pattern[close] !== "]") {
        const kind = pattern[close + 1];
        if (pattern[close] === "[" && (kind === ":" || kind === "=" || kind === ".")) {
          const end = pattern.indexOf(`${kind}]`, close + 2);
          if (end === -1) {
            posix = true;
            close = pattern.length;
            break;
          }
          posix = true;
          close = end + 2;
          continue;
        }
        close += 1;
      }
      if (close >= pattern.length) {
        // Unclosed: a literal `[`, unless a class inside it left the reading
        // uncertain, which the strict side reads as any characters.
        if (posix) {
          star();
          break;
        }
        unclosedFrom = at;
        one("\\[");
        continue;
      }
      if (posix) {
        one("[^/]");
        at = close;
        continue;
      }
      let body = pattern.slice(at + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      one(`[${negated ? "^" : ""}${body.replace(/[\\\]^]/gu, "\\$&")}]`);
      at = close;
    } else {
      one(char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    }
  }
  let result: GlobElement[] | null = elements;
  for (const element of elements) {
    if (element.star || !element.source.startsWith("[")) continue;
    try {
      element.test = new RegExp(`^${element.source}$`, "iu");
    } catch {
      // A bracket expression this reader cannot turn into one: the strict side.
      result = null;
      break;
    }
  }
  globElementsCache = { pattern, elements: result };
  return result;
}

/**
 * Does the glob `pattern` (one path segment: `*`, `?`, `[...]`) match the
 * file name `name`, letter case ignored (second review, S1)? A name starting
 * with `.` is matched only by a pattern that starts with a literal `.` or a
 * bracket expression holding one, as the shell's filename expansion requires,
 * so `*` never names `.git` while `.g*t` and `.[g]it` do. No shell and no
 * file system.
 *
 * The pattern is walked over the name as a set of positions, one element at
 * a time, so the cost is the elements read times the name's length (review
 * of the substitution fold, M1: the one anchored expression it used to build
 * backtracked, and `.` and 400 `*` and `x` took 14 s). The walk stops when no
 * position is left. Past {@link GLOB_ELEMENT_LIMIT} glob characters a
 * pattern is judged to match, the strict side (the one expression failed to
 * build past about ten thousand, and was then judged to match too).
 */
export function globSegmentMatches(pattern: string, name: string): boolean {
  if (!isPatternSegment(pattern)) return foldNameLower(pattern) === foldNameLower(name);
  if (name.startsWith(".") && (pattern.startsWith("*") || pattern.startsWith("?"))) return false;
  const elements = globElements(pattern);
  if (elements === null) return true;
  const chars = Array.from(name);
  // live[p]: the first p characters of the name are matched so far.
  let live = new Uint8Array(chars.length + 1);
  live[0] = 1;
  for (const element of elements) {
    const next = new Uint8Array(chars.length + 1);
    let any = false;
    if (element.star) {
      for (let p = 0; p <= chars.length; p += 1) {
        if (live[p] === 1 || (p > 0 && next[p - 1] === 1 && chars[p - 1] !== "/")) {
          next[p] = 1;
          any = true;
        }
      }
    } else {
      element.test ??= new RegExp(`^${element.source}$`, "iu");
      for (let p = 0; p < chars.length; p += 1) {
        if (live[p] === 1 && element.test.test(chars[p] as string)) {
          next[p + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    live = next;
  }
  return live[chars.length] === 1;
}

/**
 * Does this path name a `.git` segment, read as the shell would expand it
 * (second review, S1)? Each brace alternative is tested, and each segment
 * holding a glob is a PATTERN that names `.git` when `.git` matches it, any
 * letter case. Past the brace bound it is judged to.
 */
export function mayNameGitDirectory(word: string): boolean {
  const words = word.includes("{") ? expandBraces(word) : [word];
  if (words === null) return true;
  return words.some((each) => pathSegments(each).some((segment) => globSegmentMatches(segment, ".git")));
}

/**
 * {@link mayNameGitDirectory} for the words the substitution fold reads (a
 * parameter's word, an ANSI-C string): past {@link JOIN_BRACE_LIMIT} brace
 * alternatives the strict answer, since each one re-reads and copies the
 * word (review-b's M2 on 2f4100fc).
 */
function mayNameGitDirectoryBounded(word: string): boolean {
  const words = word.split(SUBSTITUTION_SENTINEL).join("").includes("{") ? expandBraces(word, JOIN_BRACE_LIMIT, JOIN_BRACE_STEPS) : [word];
  if (words === null) return true;
  return words.some((each) => pathSegments(each).some((segment) => globSegmentMatches(segment, ".git")));
}

/** The rule a write to a git configuration file outside a repository takes (APRV-518). */
const GIT_CONFIG_FILE_WRITE_RULE = "git-config-file-write";

/**
 * Is this path one of git's own configuration files outside a repository:
 * a `.gitconfig` (the user file and its usual include targets), anything
 * under `.config/git/` (the XDG user directory), or `/etc/gitconfig`? Each
 * is read by every push, so a write to one arms a push exactly as a write to
 * `.git/config` does.
 */
function namesGitConfigFile(word: string): boolean {
  const segments = pathSegments(word).map(foldNameLower);
  const last = segments[segments.length - 1];
  if (last === ".gitconfig" || last === "gitconfig") return true;
  // The directory itself too: `cp -t ~/.config/git x` writes into it.
  for (let at = 0; at + 1 < segments.length; at += 1) {
    if (segments[at] === ".config" && segments[at + 1] === "git") return true;
  }
  return false;
}

/**
 * Where the shell stands, as path segments, after the literal `cd`s earlier
 * on a line (APRV-518, S1). `segments` start from the directory the line
 * started in, unless the first is `/` (absolute) or `~` (the home); `..`
 * that climbs above the start stays as `..`. `stack` is `pushd`'s.
 */
export interface ShellDir {
  segments: readonly string[];
  stack: readonly (readonly string[])[];
}

const SHELL_DIR_START: ShellDir = { segments: [], stack: [] };

/** `base` and then `parts`, with `.` dropped and `..` taking back a name. */
function joinShellPath(base: readonly string[], parts: readonly string[]): string[] {
  const out = [...base];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    const last = out[out.length - 1];
    if (part === ".." && last !== undefined && last !== ".." && last !== "/" && last !== "~") {
      out.pop();
      continue;
    }
    if (part === ".." && last === "/") continue;
    out.push(part);
  }
  return out;
}

/**
 * The directory a `cd`/`pushd` word moves to, from `from`, or `null` when the
 * text cannot say: an option, an expansion, a glob, `-`, or `~user`. A bare
 * relative name may go through `CDPATH`; it still ends in the name's own
 * segments, so it is followed as relative, which can only ever find a `.git`
 * the name itself spells.
 */
function shellDirTarget(word: string, from: readonly string[] | null): string[] | null {
  // A glob or brace word is kept as its pattern (second review, S1): where
  // it lands is judged by whether `.git` matches it.
  if (word.startsWith("-") || /[$`\\]/u.test(word)) return null;
  if (word === "~") return ["~"];
  if (word.startsWith("~/")) return joinShellPath(["~"], word.slice(2).split("/"));
  if (word.startsWith("~")) return null;
  if (word.startsWith("/")) return joinShellPath(["/"], word.split("/"));
  return from === null ? null : joinShellPath(from, word.split("/"));
}

/**
 * The shell's directory after `segment` (APRV-518, S1): `cd`, `chdir`,
 * `pushd` and `popd` followed from their literal words, every other segment
 * leaving it where it was. A directory change behind an assignment
 * (`HOME=… cd`, `CDPATH=… cd`) or a word the shell may still change cannot be
 * followed, and gives `null`.
 */
function nextShellDir(segment: LexSegment, dir: ShellDir | null): ShellDir | null {
  const cursor = bashAssignmentCount(segment.words);
  const command = segment.words[cursor];
  if (command === undefined) return dir;
  const name = command.text.split("/").pop() ?? command.text;
  if (!["cd", "chdir", "pushd", "popd"].includes(name)) return dir;
  const rest = segment.words.slice(cursor + 1);
  // A word inexact only through a glob or brace is still followed, as its pattern.
  const followable = (word: LexWord): boolean =>
    word.substitutions.length === 0 && (word.exact || (word.expands && !word.splits && !/[$`~\\]/u.test(word.text)));
  if (cursor > 0 || !command.exact || rest.some((word) => !followable(word))) return null;
  const words = rest.map((word) => word.text);
  const args = words[0] === "--" ? words.slice(1) : words;
  if (name === "popd") {
    if (dir === null || args.length > 0 || dir.stack.length === 0) return null;
    return { segments: dir.stack[dir.stack.length - 1] as readonly string[], stack: dir.stack.slice(0, -1) };
  }
  if (args.length > 1 || (name === "pushd" && args.length === 0)) return null;
  const target = args.length === 0 ? ["~"] : shellDirTarget(args[0] as string, dir === null ? null : dir.segments);
  if (target === null) return null;
  const stack = dir === null ? [] : dir.stack;
  return name === "pushd" && dir !== null
    ? { segments: target, stack: [...stack, dir.segments] }
    : { segments: target, stack: name === "pushd" ? [] : stack };
}

/**
 * Does a write to `word`, made after the shell moved to `dir`, land in a
 * `.git` directory (APRV-518, S1)? Only a relative word is resolved here; an
 * absolute or home word is judged as written by {@link namesGitDirectory}.
 */
function relativeLandsInGitDir(word: string, dir: ShellDir | null | undefined): boolean {
  if (dir === null || dir === undefined || dir.segments.length === 0) return false;
  if (word.startsWith("/") || word.startsWith("~") || /[$`]/u.test(word) || /\s/u.test(word)) return false;
  return mayNameGitDirectory(joinShellPath(dir.segments, word.split("/")).join("/"));
}

/**
 * The value an attached short option carries (APRV-518, S2): every tail of a
 * single-dash word after its first option letter, so `-o.git/config`,
 * `-O.git/hooks/pre-push`, `-t.git/hooks`, `-C.git` and a cluster such as
 * `-xfC.git` are each read for the path they may name. Every tail rather than
 * a table of which letter takes a value: a tail that is not a path can only
 * make a segment stricter, and no option table can drift out of date.
 */
function attachedOptionValues(word: string): string[] {
  if (!word.startsWith("-") || word.startsWith("--") || word.length < 3) return [];
  const tails: string[] = [];
  for (let at = 2; at < word.length; at += 1) tails.push(word.slice(at));
  return tails;
}

/**
 * The files a READ-class command writes through its own words (follow-up,
 * item B), read from this Mac's manual pages: `sort -o <file>` /
 * `--output=<file>` (any prefix of one letter or more), `uniq`'s second
 * operand, `sed`'s `w` command and the `w` flag of `s` in a script given on
 * the line, and `tree -o <file>`. Every other command the table reads
 * (`cat`, `grep`, `head`, `cut`, `jq`, `diff`, `ls`, `wc` and the rest) names
 * no file it writes. A `sed -f` script file cannot be read here.
 */
export function readWriteTargets(bin: string, args: readonly string[]): string[] {
  switch (bin) {
    case "sort":
      return optionOutputs(args, "o", "kStT", ["--output"], [
        "--key", "--field-separator", "--buffer-size", "--temporary-directory", "--batch-size",
        "--compress-program", "--random-source", "--files0-from", "--parallel",
      ]);
    case "tree":
      return optionOutputs(args, "o", "LPIHT", [], ["--filelimit", "--charset", "--timefmt", "--sort"]);
    case "uniq":
      return uniqOutput(args);
    case "sed":
      return sedScripts(args).flatMap(sedWriteFiles);
    default:
      return [];
  }
}

/**
 * The outputs {@link readWriteTargets} is SURE of: every one but a sed
 * script's, which are only possible targets.
 */
export function readWriteSureTargets(bin: string, args: readonly string[]): string[] {
  return bin === "sed" ? [] : readWriteTargets(bin, args);
}

/**
 * The values of an output option: a short `letter` in a cluster takes the
 * rest of the word or the next word; a letter in `valued` takes a value
 * that is not an output and ends the cluster; a long option of one letter
 * or more that is a prefix of one in `outputs` takes its `=` value or the
 * next word, and one in `skipping` consumes the next word.
 */
function optionOutputs(
  args: readonly string[],
  letter: string,
  valued: string,
  outputs: readonly string[],
  skipping: readonly string[],
): string[] {
  const values: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (name.length >= 3 && outputs.some((option) => option.startsWith(name))) {
        const value = equals === -1 ? args[at + 1] : arg.slice(equals + 1);
        if (value !== undefined) values.push(value);
        if (equals === -1) at += 1;
      } else if (equals === -1 && skipping.includes(name)) {
        at += 1;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) continue;
    for (let index = 1; index < arg.length; index += 1) {
      const char = arg[index] as string;
      if (char !== letter && !valued.includes(char)) continue;
      const rest = arg.slice(index + 1);
      if (char === letter) {
        const value = rest.length > 0 ? rest : args[at + 1];
        if (value !== undefined) values.push(value);
      }
      if (rest.length === 0) at += 1;
      break;
    }
  }
  return values;
}

/** `uniq [options] [input [output]]`: the second operand is the file it writes. */
function uniqOutput(args: readonly string[]): string[] {
  const operands: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (arg === "-f" || arg === "-s" || arg === "-w" || arg === "--skip-fields" || arg === "--skip-chars" || arg === "--check-chars") {
      at += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") continue;
    operands.push(arg);
  }
  return operands[1] === undefined || operands[1] === "-" ? [] : [operands[1]];
}

/** The scripts a `sed` line gives: each `-e` value, else its first operand. */
function sedScripts(args: readonly string[]): string[] {
  const scripts: string[] = [];
  let fromFile = false;
  let first: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "-e" || arg === "--expression" || /^-[nEralsuz]+e$/u.test(arg)) {
      const value = args[at + 1];
      if (value !== undefined) scripts.push(value);
      at += 1;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
    } else if (/^-[nEralsuz]*e./u.test(arg)) {
      scripts.push(arg.slice(arg.indexOf("e") + 1));
    } else if (arg === "-f" || arg === "--file" || arg.startsWith("--file=") || /^-[nEralsuz]*f/u.test(arg)) {
      fromFile = true;
      if (arg === "-f" || arg === "--file") at += 1;
    } else if (arg === "-I" || arg === "-i") {
      continue;
    } else if (!arg.startsWith("-") && first === undefined) {
      first = arg;
    }
  }
  if (scripts.length === 0 && !fromFile && first !== undefined) scripts.push(first);
  return scripts;
}

/**
 * The POSSIBLE files a sed script text may write (follow-up, item B). The
 * script is NOT parsed: a hand-written sed parser differs from BSD's and
 * GNU's in brackets, labels and file names, and each difference is a way
 * past. A text with no `w` and no `W` writes nothing. Otherwise every one
 * of these is a possible target: for each `w` or `W`, the rest of its line
 * with leading blanks trimmed (a file name with blanks kept whole); every
 * run of characters between blanks, `;`, `{` and `}`; and, as the plain
 * text rule, the `.git` path the text spells anywhere.
 */
function sedWriteFiles(script: string): string[] {
  if (!/[wW]/u.test(script)) return [];
  const files: string[] = [];
  for (let at = 0; at < script.length; at += 1) {
    if (script[at] !== "w" && script[at] !== "W") continue;
    const end = script.indexOf("\n", at);
    const rest = script.slice(at + 1, end === -1 ? script.length : end).replace(/^[ \t]+/u, "");
    if (rest.length > 0) files.push(rest);
  }
  files.push(...script.split(/[\s;{}]+/u).filter((word) => word.length > 0));
  const spelled = GIT_SEGMENT_IN_TEXT.exec(script);
  if (spelled !== null) {
    const from = script.indexOf(".", spelled.index);
    const tail = script.slice(from).split(/[\s;{}]/u)[0] ?? "";
    files.push(tail.length > 0 ? tail : ".git");
  }
  return files;
}

/**
 * The files and directories git ITSELF writes, from its own options
 * (second review, S2), read from git 2.50.1's manual pages: the diff
 * family's `--output=<file>` (`diff`, `log`, `show`, `stash show` and every
 * other verb that takes diff options, so any verb here), `git apply`'s
 * `--directory=<root>` (where the patched files land) and
 * `--build-fake-ancestor=<file>`, `git worktree add <path>` (a checkout made
 * there), and `git clone`'s `<directory>` and `--separate-git-dir`. The
 * verbs that also write a file but have no row (`format-patch -o`,
 * `archive -o`, `bundle create`, `init`, `config --file`) stay refused, and
 * `--git-dir=` / `--work-tree=` name the repository git runs against, not a
 * file it writes.
 */
export function gitWriteTargets(args: readonly string[]): string[] {
  const verbAt = gitVerbIndex(args);
  const verb = verbAt === null ? undefined : args[verbAt];
  const rest = verbAt === null ? args : args.slice(verbAt + 1);
  const values: string[] = [];
  const positionals: string[] = [];
  const skipNext = new Set(
    verb === "clone"
      ? ["-b", "--branch", "-o", "--origin", "-u", "--upload-pack", "--depth", "--reference", "--reference-if-able", "--shallow-since", "--shallow-exclude", "-c", "--config", "-j", "--jobs", "--filter", "--bundle-uri", "--server-option", "--template", "--separate-git-dir"]
      : verb === "worktree"
        ? ["-b", "-B", "--reason"]
        : [],
  );
  // git takes any unambiguous prefix of a long option (`--outp=f`, `--out f`
  // write as `--output` does), and this reader cannot know every verb's
  // full option list, so ANY long option of one letter or more that is a
  // prefix of a write option's name is read as that option.
  const writeOptions = [
    "--output",
    ...(verb === "apply" ? ["--directory", "--build-fake-ancestor"] : []),
    ...(verb === "clone" ? ["--separate-git-dir"] : []),
  ];
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at] as string;
    if (arg === "--") {
      positionals.push(...rest.slice(at + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (name.length >= 3 && writeOptions.some((option) => option.startsWith(name))) {
        const value = equals === -1 ? rest[at + 1] : arg.slice(equals + 1);
        if (value !== undefined) values.push(value);
        if (equals === -1) at += 1;
        continue;
      }
    }
    if (arg.startsWith("-")) {
      if (skipNext.has(arg)) at += 1;
      continue;
    }
    positionals.push(arg);
  }
  // `git worktree add <path> [<commit-ish>]`: the path is the first operand.
  if (verb === "worktree" && positionals[0] === "add" && positionals[1] !== undefined) values.push(positionals[1]);
  // `git clone <repository> [<directory>]`.
  if (verb === "clone" && positionals[1] !== undefined) values.push(positionals[1]);
  return values;
}

/**
 * The `.git` or git configuration file write a segment makes, if any
 * (APRV-518): its write targets, and the words it may write through
 * (`named`), each judged as written and, when relative, from the directory
 * earlier `cd`s moved the shell to (S1). `namedWrites` is false for a read
 * whose only write is its redirection (`echo x > f`): its words are judged as
 * written, never resolved from the shell's directory, since it writes none.
 */
function gitWriteRefinement(
  writeTargets: readonly string[],
  named: readonly string[],
  dir: ShellDir | null | undefined,
  namedWrites = true,
  lineNamesGit = false,
  dotGit?: (word: string) => boolean,
): { class: string; rule: string; path: string } | null {
  const spelled = named.filter((word) => !/\s/u.test(word));
  const words = [...writeTargets, ...spelled];
  const resolvable = namedWrites ? words : writeTargets;
  // Second review, S3: on a line that itself spells `.git` in an assignment,
  // a substitution or a quoted string, a target that expands, or a relative
  // target after a directory change the text cannot place, may be that `.git`.
  const throughLine = lineNamesGit
    ? resolvable.find((word) => /[$`]/u.test(word) || (dir === null && !word.startsWith("/") && !word.startsWith("~")))
    : undefined;
  const gitDir =
    words.find((word) => namesGitDirectory(word)) ??
    resolvable.find((word) => relativeLandsInGitDir(word, dir)) ??
    throughLine ??
    (dotGit === undefined ? undefined : words.find(dotGit));
  if (gitDir !== undefined) return { class: "vcs.history.rewrite", rule: GIT_DIR_WRITE_RULE, path: gitDir };
  const gitConfig = words.find(namesGitConfigFile);
  if (gitConfig !== undefined) return { class: "vcs.history.rewrite", rule: GIT_CONFIG_FILE_WRITE_RULE, path: gitConfig };
  return null;
}

/** A `.git` path segment inside free text (`D=.git`, `$PWD/.git/hooks`, `echo .git`), any case. */
const GIT_SEGMENT_IN_TEXT = /(?:^|[^A-Za-z0-9_.-])\.git(?:$|[^A-Za-z0-9_.-])/iu;

/**
 * The `git rev-parse` options that print a path to, or inside, the git
 * directory (APRV-518, substitution fold), read from git 2.50.1's manual:
 * `--git-dir`, `--absolute-git-dir`, `--git-common-dir`, `--git-path
 * <path>`, `--resolve-git-dir <path>` (a gitfile's repository) and
 * `--shared-index-path` (a file in it). The options that print the working
 * tree (`--show-toplevel`, `--show-cdup`, `--show-prefix`,
 * `--show-superproject-working-tree`), a word (`--is-*`, `--show-*-format`,
 * `--local-env-vars`) or an object name are not here.
 */
const GIT_DIR_QUERY_OPTIONS: readonly string[] = [
  "--git-dir",
  "--absolute-git-dir",
  "--git-common-dir",
  "--git-path",
  "--resolve-git-dir",
  "--shared-index-path",
];

/**
 * Does one segment of a substitution body ask git for its own directory
 * (APRV-518, substitution fold): a `rev-parse` (any case, also as
 * `git-rev-parse` or inside an alias value such as `alias.d=rev-parse
 * --git-dir`) followed by one of {@link GIT_DIR_QUERY_OPTIONS}? An option is
 * read by any prefix of three characters or more (`--git-d`), and an option
 * name the text cannot read (`--git-$(echo dir)`, `-$X`) counts, as does a
 * verb it cannot read (`git $(echo rev-parse) --git-dir`). A bare `$X`
 * operand is a revision, as it almost always is, and does not count; nor
 * does a value the text cannot read after a readable name (`--short=$N`).
 */
function asksGitForItsDirectory(segment: LexSegment): boolean {
  const tokens = segment.words.flatMap((word) => word.text.split(/\s+/u)).filter((token) => token.length > 0);
  const unreadable = (token: string): boolean => /[$`*?[]/u.test(token);
  let verb = false;
  for (const token of tokens) {
    const name = (token.startsWith("-") ? token.split("=")[0] : token) as string;
    const option =
      name.startsWith("--") &&
      name.length >= 3 &&
      GIT_DIR_QUERY_OPTIONS.some((each) => each.startsWith(name.toLowerCase()));
    if (verb && (option || (name.startsWith("-") && unreadable(name)))) return true;
    if (/(?:^|[=!/-])rev-parse$/iu.test(token) || unreadable(token)) verb = true;
  }
  return false;
}

/**
 * The positions of `.git` a literal character may stand at, any letter case,
 * as a set of bits (bit `p` for the character at index `p`).
 */
function gitLetterPositions(char: string): number {
  switch (char) {
    case ".":
      return 0b0001;
    case "g":
    case "G":
      return 0b0010;
    case "i":
    case "I":
      return 0b0100;
    case "t":
    case "T":
      return 0b1000;
    default:
      return 0;
  }
}

/** Every position of `.git`, start to end, as a set of bits. */
const GIT_POSITIONS_ALL = 0b11111;

/** A run of any text from the lowest position in `positions` on. */
function anyRunFrom(positions: number): number {
  return positions === 0 ? 0 : GIT_POSITIONS_ALL & ~((positions & -positions) - 1);
}

/**
 * The positions of `.git` reachable after one literal run of a word, from
 * `positions` (bit `p` set: the first `p` characters of `.git` are matched),
 * its glob characters read the broad way (APRV-518, substitution fold): `*`
 * any run, `?` and a closed bracket expression any one character, anything
 * else itself in any letter case. A hand-written set walk over the four
 * characters of `.git`, so its cost is the run's length times a constant:
 * no expression is built from the line's text, and nothing backtracks
 * (review of the substitution fold, M1).
 */
function stepGitThroughRun(positions: number, run: string): number {
  // The walk stops when no position is left, so an unclosed `[` (a literal,
  // which `.git` does not hold) ends it: its scan for a `]` runs once.
  for (let at = 0; at < run.length && positions !== 0; at += 1) {
    const char = run[at] as string;
    if (char === "*") {
      positions = anyRunFrom(positions);
      continue;
    }
    if (char === "?") {
      positions = (positions << 1) & GIT_POSITIONS_ALL;
      continue;
    }
    if (char === "[") {
      let close = at + 1;
      if (run[close] === "!" || run[close] === "^") close += 1;
      if (run[close] === "]") close += 1;
      const closeAt = run.indexOf("]", close);
      if (closeAt !== -1) {
        positions = (positions << 1) & GIT_POSITIONS_ALL;
        at = closeAt;
        continue;
      }
    }
    positions = ((positions & gitLetterPositions(char)) << 1) & GIT_POSITIONS_ALL;
  }
  return positions;
}

/**
 * Can literal text and a substitution's output JOIN into a `.git` segment
 * of this word (APRV-518, substitution fold)? `$(printf .gi)t`,
 * `.g$(printf it)`, `$(printf .)git`, `.$(echo g)it`. The output is unknown
 * and may hold a `/`, so a `.git` segment may begin inside one output and
 * end inside another; what the text fixes is the literal run between them.
 * So, for each piece of the word between `/`, `=`, `:` and blanks that holds
 * both a substitution and a literal character: does `.git` match a window of
 * it that starts at the piece's start or inside an output, ends at its end
 * or inside an output, and holds at least one literal character, each output
 * read as any text and each glob character the broad way? A piece made only
 * of outputs (`$(pwd)/build`) does not count: the output alone would spell
 * `.git`, and its body is judged for that. Neither do pieces whose literal
 * text cannot be part of `.git` (`out/$(date +%F).txt`, `v$(cat V).tgz`).
 *
 * Every window is tried in ONE walk of the piece (review of the substitution
 * fold, M1: a window at a time, each an expression of `.*` runs, grew as
 * about the fifth power of the outputs). Two sets of `.git` positions are
 * carried: windows with no literal character yet, and windows with one. A
 * window starts at the piece's start or inside any output (any position,
 * since the output's own text comes first); an output carries every window
 * on through any text; a window holding a literal character that reaches an
 * output may end inside it; one that reaches the piece's end must stand at
 * the end of `.git`. The cost is the word's length times a constant.
 */
function wordJoinsGitAcrossSubstitution(text: string): boolean {
  if (!text.includes(SUBSTITUTION_SENTINEL)) return false;
  // Each expansion re-reads and copies the whole word, so this reading takes
  // at most JOIN_BRACE_LIMIT of them, and past that counts as naming `.git`;
  // a word whose only braces are the outputs' own is not expanded at all
  // (review-b's M2 on 2f4100fc: `{a,b}$(pwd)` to 1 MB took 39 s at 1,024).
  const words = text.split(SUBSTITUTION_SENTINEL).join("").includes("{") ? expandBraces(text, JOIN_BRACE_LIMIT, JOIN_BRACE_STEPS) : [text];
  if (words === null) return true;
  for (const word of words) {
    for (const piece of word.split(/[/=:\s]/u)) {
      const runs = piece.split(SUBSTITUTION_SENTINEL);
      if (runs.length === 1 || runs.join("").length === 0) continue;
      // Bit p: the first p characters of `.git` are matched.
      let bare = 0b1;
      let holding = 0;
      for (let at = 0; at < runs.length; at += 1) {
        if (at > 0) {
          // An output: a window holding a literal character ends inside it.
          if (holding !== 0) return true;
          // Every window goes on through it, and a new one starts in it.
          bare = GIT_POSITIONS_ALL;
        }
        const run = runs[at] as string;
        if (run.length === 0) continue;
        holding = stepGitThroughRun(bare | holding, run);
        bare = 0;
      }
      if ((holding & 0b10000) !== 0) return true;
    }
  }
  return false;
}

/**
 * How deep command substitutions may nest before a line is refused (review
 * of the substitution fold): far past any command an agent writes, and far
 * short of the call stack's own limit.
 */
const SUBSTITUTION_NESTING_LIMIT = 128;

/** How many levels of nested substitution bodies the line's `.git` reading reads. */
const SUBSTITUTION_READ_DEPTH = 64;

/**
 * `text` with its backslash escapes decoded (review of the substitution
 * fold, S1), as bash's `$'…'` and `printf` read them: `\xHH`, `\uHHHH`,
 * `\UHHHHHHHH`, `\cX`, the letter escapes, and octal, read as `\NNN` (bash,
 * a `printf` format) or, with `zeroOctal`, as `\0NNN` (`echo -e`, `printf
 * %b`). An escape it does not know is kept as written.
 */
function decodeBackslashEscapes(text: string, zeroOctal: boolean): string {
  const letters: Readonly<Record<string, string>> = {
    a: "\u0007",
    b: "\b",
    e: "\u001B",
    E: "\u001B",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    const next = text[at + 1];
    if (char !== "\\" || next === undefined) {
      out += char;
      continue;
    }
    const digits = (from: number, pattern: RegExp, most: number): string => {
      let end = from;
      while (end < text.length && end - from < most && pattern.test(text[end] as string)) end += 1;
      return text.slice(from, end);
    };
    let code: number | null = null;
    let used = 0;
    if (next === "x" || next === "u" || next === "U") {
      const hex = digits(at + 2, /[0-9A-Fa-f]/u, next === "x" ? 2 : next === "u" ? 4 : 8);
      if (hex.length > 0) [code, used] = [Number.parseInt(hex, 16), 1 + hex.length];
    } else if (zeroOctal ? next === "0" : /[0-7]/u.test(next)) {
      const octal = zeroOctal ? digits(at + 2, /[0-7]/u, 3) : digits(at + 1, /[0-7]/u, 3);
      [code, used] = [Number.parseInt(octal === "" ? "0" : octal, 8), zeroOctal ? 1 + octal.length : octal.length];
    } else if (next === "c" && text[at + 2] !== undefined) {
      [code, used] = [(text.charCodeAt(at + 2) & 0x1f), 2];
    } else if (letters[next] !== undefined) {
      out += letters[next];
      at += 1;
      continue;
    }
    if (code === null || code > 0x10ffff) {
      out += char;
      continue;
    }
    out += String.fromCodePoint(code);
    at += used;
  }
  return out;
}

/**
 * An ANSI-C string ends at a decoded NUL (bash keeps nothing after it in that
 * quote; the word goes on after the closing quote): `$'.g\0junk'it` is `.git`
 * (#680's source review, S2).
 */
function cutAtNul(decoded: string): string {
  const at = decoded.indexOf("\0");
  return at === -1 ? decoded : decoded.slice(0, at);
}

/** A command substitution drops the NUL bytes of its output: `$(printf '.g\0it')` is `.git`. */
function dropNuls(decoded: string): string {
  return decoded.replace(/\0/gu, "");
}

/**
 * The first, broader reading of an ANSI-C quoted string, kept beside
 * {@link ansiCQuotingSpellsGit} so the fold only adds: every `$'` of the raw
 * text, quotes around it or not, decoded with up to five characters on
 * either side. It also reads a `$'` the shell leaves as written (inside
 * single or double quotes), the strict side.
 */
function ansiCQuotingNearSpellsGit(raw: string): boolean {
  const delimiter = /[\s;&|()<>]/u;
  let close = -1;
  for (let open = raw.indexOf("$'"); open !== -1; open = raw.indexOf("$'", close + 1)) {
    close = open + 2;
    while (close < raw.length && raw[close] !== "'") close += raw[close] === "\\" ? 2 : 1;
    if (close >= raw.length) return true;
    let from = open;
    while (from > 0 && open - from < 5 && !delimiter.test(raw[from - 1] as string)) from -= 1;
    let to = close + 1;
    while (to < raw.length && to - close <= 5 && !delimiter.test(raw[to] as string)) to += 1;
    const before = raw.slice(from, open).replace(/["']/gu, "");
    const after = raw.slice(close + 1, to).replace(/["']/gu, "");
    const body = raw.slice(open + 2, close);
    for (const zeroOctal of [false, true]) {
      const decoded = decodeBackslashEscapes(body, zeroOctal);
      if (GIT_SEGMENT_IN_TEXT.test(`${before}${cutAtNul(decoded)}${after}`)) return true;
      if (GIT_SEGMENT_IN_TEXT.test(`${before}${dropNuls(decoded)}${after}`)) return true;
    }
  }
  return false;
}

/** Glob and brace characters escaped, so quoted text is read as itself. */
function quotedForGlob(text: string): string {
  return text.replace(/[*?[\]{}\\]/gu, "\\$&");
}

/**
 * Does a word of this raw segment text that holds an ANSI-C quoted string
 * spell `.git` once the shell has read it (review of the substitution fold,
 * S1, and its security review, points a and b)? The lexer keeps a `$'…'`
 * undecoded, so no other reading sees the `.git` it spells. The raw text is
 * read as the shell reads it, quote by quote: each `$'…'` is decoded (both
 * ways octal is written), quotes are removed, and the pieces of a word are
 * joined; a substitution stands as an unknown output. A word that holds a
 * `$'…'` then names `.git` when its text has a `.git` segment, when it is a
 * pattern `.git` matches (globs only where unquoted), or when its literal
 * text and an output join into `.git`. A quote or substitution that does not
 * close is unreadable, and the strict side.
 */
function ansiCQuotingSpellsGit(raw: string): boolean {
  if (!raw.includes("$'")) return false;
  // Two readings, octal as `\NNN` and as `\0NNN`; each as text and as a
  // pattern (quoted characters escaped).
  const text = ["", ""];
  const glob = ["", ""];
  let ansi = false;
  const add = (literal: string, quoted: boolean): void => {
    for (const r of [0, 1]) {
      text[r] += literal;
      glob[r] += quoted ? quotedForGlob(literal) : literal;
    }
  };
  const flush = (): boolean => {
    const names =
      ansi &&
      [0, 1].some(
        (r) =>
          GIT_SEGMENT_IN_TEXT.test((text[r] as string).split(SUBSTITUTION_SENTINEL).join("/")) ||
          (glob[r] as string).split(":").some(mayNameGitDirectoryBounded) ||
          wordJoinsGitAcrossSubstitution(text[r] as string),
      );
    text[0] = text[1] = glob[0] = glob[1] = "";
    ansi = false;
    return names;
  };
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at] as string;
    if (/[\s;&|()<>]/u.test(char)) {
      if (flush()) return true;
      continue;
    }
    if (char === "\\") {
      if (at + 1 < raw.length) add(raw[at + 1] as string, true);
      at += 1;
      continue;
    }
    if (char === "'") {
      const close = raw.indexOf("'", at + 1);
      if (close === -1) return true;
      add(raw.slice(at + 1, close), true);
      at = close;
      continue;
    }
    if (char === "$" && raw[at + 1] === "'") {
      let close = at + 2;
      while (close < raw.length && raw[close] !== "'") close += raw[close] === "\\" ? 2 : 1;
      if (close >= raw.length) return true;
      const body = raw.slice(at + 2, close);
      for (const r of [0, 1]) {
        const decoded = cutAtNul(decodeBackslashEscapes(body, r === 1));
        text[r] += decoded;
        glob[r] += quotedForGlob(decoded);
      }
      ansi = true;
      at = close;
      continue;
    }
    if (char === '"' || (char === "$" && raw[at + 1] === '"')) {
      let close = char === "$" ? at + 2 : at + 1;
      let inner = "";
      for (; close < raw.length && raw[close] !== '"'; close += 1) {
        const ch = raw[close] as string;
        if (ch === "\\" && close + 1 < raw.length) {
          inner += DOUBLE_QUOTE_ESCAPES.has(raw[close + 1] as string) ? (raw[close + 1] as string) : `\\${raw[close + 1] as string}`;
          close += 1;
          continue;
        }
        if (ch === "$" && raw[close + 1] === "(") {
          const scan = readSubstitution(raw, close + 1);
          if (scan === null) return true;
          inner += SUBSTITUTION_SENTINEL;
          close = scan.end;
          continue;
        }
        if (ch === "`") {
          const end = raw.indexOf("`", close + 1);
          if (end === -1) return true;
          inner += SUBSTITUTION_SENTINEL;
          close = end;
          continue;
        }
        inner += ch;
      }
      if (close >= raw.length) return true;
      add(inner, true);
      at = close;
      continue;
    }
    if (char === "$" && raw[at + 1] === "(") {
      const scan = readSubstitution(raw, at + 1);
      if (scan === null) return true;
      add(SUBSTITUTION_SENTINEL, false);
      at = scan.end;
      continue;
    }
    if (char === "`") {
      const end = raw.indexOf("`", at + 1);
      if (end === -1) return true;
      add(SUBSTITUTION_SENTINEL, false);
      at = end;
      continue;
    }
    add(char, false);
  }
  return flush();
}

/** The most characters of a `printf` body's output that are rendered. */
const PRINTED_OUTPUT_LIMIT = 65_536;

/** A private-use mark {@link printedOutputs} sets an unclosed `${` aside with. */
const SET_ASIDE = String.fromCharCode(0xe000);

/**
 * What `printf` or `echo` in a substitution body may print (review of the
 * substitution fold, S1, and its security review, point c), read from the
 * body's lexed words, quotes already removed: `echo` joins its words,
 * `printf` fills its format from its words (`%s` and `%c` take a word as it
 * is, `%b` decodes it, `%d` is an unknown output, `%%` is a `%`), and every
 * escape is decoded, both ways octal is written. printf is read only when
 * its format is a literal word using no other conversion and every word
 * after it keeps its place, and `echo` (zsh's decodes escapes) only when
 * every word does and holds no unknown value; `%b` of an unknown value, and
 * zsh's `print` with one, count as naming `.git` too (the fifth and sixth
 * security reviews). A word
 * the text cannot read (`$X`) stands as an unknown output. Past
 * {@link PRINTED_OUTPUT_LIMIT} characters the output counts as naming
 * `.git`. `null` when the segment runs neither.
 */
function printerCommand(segment: LexSegment): { lexed: LexWord[]; start: number; name: string; byPath: boolean; otherPath: boolean } {
  const lexed = segment.words.slice(bashAssignmentCount(segment.words));
  // Read by index, not by shifts: a run of thousands of `command` or `-n`
  // words then costs its length, not its square (review-b's M1 on b085cd91).
  let start = 0;
  while (lexed[start]?.text === "command" || lexed[start]?.text === "builtin") start += 1;
  // Named by its path too, when the path is the system's own binary
  // (`/usr/bin/printf`, `/bin/echo`; #680's gate, M2), written plainly.
  const command = lexed[start]?.text ?? "";
  const byPath = command.includes("/") && isSystemBinWord(command, lexed[start]?.exact ?? false);
  const name = foldNameLower(byPath ? (command.split("/").pop() ?? "") : command);
  // Any other path whose last name is a printer (`/usr/bin//printf`,
  // `/bin/../usr/bin/printf`, `./printf`) may run the system's own: what it
  // prints is not read, and counts (review-b's read of #683, M1).
  const otherPath = !byPath && command.includes("/") && /^(?:printf|echo|print)$/u.test(foldNameLower(command.split("/").pop() ?? ""));
  return { lexed, start, name, byPath, otherPath };
}

/**
 * Does the segment run `printf -v` (bash, zsh) or zsh's `print -v`, which
 * set a variable to what would be printed (review-b's read of #683, N1)? The
 * line then counts as spelling `.git`, so a target the variable reaches
 * (`printf -v d %.4s .gitfoo; echo x > "$d/config"`) counts.
 */
function assignsByPrinter(segment: LexSegment): boolean {
  const { lexed, start, name, otherPath } = printerCommand(segment);
  return (otherPath || name === "printf" || name === "print") && /^-[A-Za-z]*v/u.test(lexed[start + 1]?.text ?? "");
}

function printedOutputs(segment: LexSegment): string[] | null {
  const { lexed, start, name, otherPath } = printerCommand(segment);
  if (otherPath) return ["/.git/", "/.git/"];
  const all = lexed.map((word) => word.text);
  const words = all.slice(start + 1);
  // zsh's `print` decodes escapes unless given `-r`: with a word the text
  // cannot read, what it prints counts (the sixth security review). Its
  // literal words are read by the body's own escape check.
  if (name === "print") {
    const raw = words.some((word) => /^-[A-Za-z]*r/u.test(word));
    const readable = lexed.slice(start + 1).every((word) => word.exact && word.substitutions.length === 0 && !/[$`]/u.test(word.text));
    return raw || readable ? null : ["/.git/", "/.git/"];
  }
  if (name !== "echo" && name !== "printf") return null;
  // Does each word stay one word in its place? A literal word does, and so
  // does a fully quoted plain scalar (`"$SHA"`, its whole text one name, an
  // unknown value). A quoted word whose text is not the shell's (`"\x2e"`,
  // whose backslash the lexer drops) is not read as literal text: its
  // letters may print other bytes (codex's SOURCE HOLD on 101630f2, M3). Any other (an unquoted
  // variable, a glob or brace, `"$@"`, `${a[@]}`, an indirection `${!r}`,
  // zsh's flags `${(s: :)u}`, a substitution) may become no word or several,
  // and printf then pairs the words with other conversions than the text
  // shows (the security reviews of the gate's fold).
  const keeps = lexed
    .slice(start + 1)
    .map(
      (word) =>
        word.substitutions.length === 0 &&
        !word.text.includes(SUBSTITUTION_SENTINEL) &&
        !/\$['"]/u.test(word.text) &&
        (word.exact ||
          (word.quoted && !word.splits && !word.expands && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)\})$/u.test(word.text))),
    );
  const unknown = (word: string): string => {
    // A `${` with no `}` after it cannot close, and the scan for its close
    // would run to the end from each one (review-b's M1 on b085cd91: 500 KB
    // of `${` took 114 s). Each is set aside first, then put back as text.
    const close = word.lastIndexOf("}");
    const tail = word.slice(close + 1);
    const setAside = tail.includes("${");
    // The mark itself in such a word: not read, and counts (the strict side).
    if (setAside && word.includes(SET_ASIDE)) return "/.git/";
    const text = setAside ? `${word.slice(0, close + 1)}${tail.replaceAll("${", `$${SET_ASIDE}`)}` : word;
    const read = text.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]|`[^`]*`/gu, SUBSTITUTION_SENTINEL);
    return setAside ? read.replaceAll(`$${SET_ASIDE}`, "${") : read;
  };
  const outputs: string[] = [];
  for (const zeroOctal of [false, true]) {
    const decode = (word: string): string => dropNuls(decodeBackslashEscapes(unknown(word), zeroOctal));
    if (name === "echo") {
      let newline = "\n";
      let first = 0;
      while (first < words.length && /^-[neE]+$/u.test(words[first] as string)) {
        if ((words[first] as string).includes("n")) newline = "";
        first += 1;
      }
      // zsh's `echo` decodes escapes without `-e` (zsh is this Mac's shell),
      // so every `echo` is read only when every word keeps its place and
      // holds no value the text cannot read: an unknown value may decode to
      // `.git` (the fifth and sixth security reviews).
      const printed = words.slice(first).map(decode);
      // A `\c` stops all output (zsh's `echo`, `echo -e`), which this reading
      // does not model: it counts (codex's SOURCE HOLD on 101630f2, M2).
      if (
        keeps.slice(first).some((one) => !one) ||
        segment.text.includes("`") ||
        words.slice(first).some((word) => word.includes("\\c")) ||
        printed.some((word) => word.includes(SUBSTITUTION_SENTINEL))
      ) {
        outputs.push("/.git/");
        continue;
      }
      outputs.push(`${printed.join(" ")}${newline}`);
      continue;
    }
    const args = words.map((text, index) => ({ text, keeps: keeps[index] === true, exact: lexed[start + 1 + index]?.exact === true }));
    if (args[0]?.text === "--") args.shift();
    // `printf -v` sets a variable and prints nothing; what it sets is read
    // by the line (assignsByPrinter). Its segment is not read, and counts
    // (review-b's read of #683, N3).
    if (/^-[A-Za-z]*v/u.test(args[0]?.text ?? "")) {
      outputs.push("/.git/");
      continue;
    }
    const formatWord = args.shift();
    const format = decode(formatWord?.text ?? "");
    // The coarse rule (the fifth security review of the gate's fold, after
    // four rounds each found another corner of a finer model): printf is
    // read only when its format is a literal word and every word after it
    // keeps its place (a literal word or a fully quoted plain scalar). A
    // format held in a variable (`F=%.4s; printf "$F" .gitfoo`), a word that
    // may become no word or several (`$u`, `"$@"`, `${a[@]}`, `{a,b}`, `*`),
    // counts as naming `.git`.
    // A format whose escapes decode to a `%` (`'\x25s'`) is read by bash
    // as the text `%`, not a conversion: it counts too.
    const percents = (text: string): number => text.split("%").length - 1;
    if (
      (formatWord !== undefined && !(formatWord.exact && formatWord.keeps)) ||
      args.some((arg) => !arg.keeps) ||
      segment.text.includes("`") ||
      percents(format) !== percents(formatWord?.text ?? "") ||
      // A `\c` (in `%b`'s words, and zsh's format) stops all output, which
      // this reading does not model: it counts (codex's SOURCE HOLD on
      // 101630f2, M2).
      (formatWord?.text ?? "").includes("\\c") ||
      args.some((arg) => arg.text.includes("\\c"))
    ) {
      outputs.push("/.git/");
      continue;
    }
    // The words are read by index: a shift per conversion made a line of
    // many words cost the square of its length (review-b's M1 on b085cd91).
    let next = 0;
    const take = (): { text: string; keeps: boolean; exact: boolean } | undefined => (next < args.length ? args[next++] : undefined);
    // The format is parsed once, into its text and its conversions; each
    // pass then walks the pieces, not the format, so a long spec with many
    // words costs their sum, not their product (codex's SOURCE HOLD on
    // ef0531c0: `%` with many 0 flags, `.0s`, and many words).
    type Conversion = { conversion: string; stars: number; precision: number | null };
    const pieces: (string | Conversion)[] = [];
    // Which text pieces are a parsed `%%`: a `%` in any other (`%`, `%s%`,
    // `a%`) is one this reading did not take (codex's SOURCE HOLD on
    // 101630f2, N1).
    const parsedPercent = new Set<number>();
    let last = 0;
    // A width starts with 1 to 9 or `*` (a 0 is a flag), so the flag and
    // width runs cannot both take a 0 and a `%` then zeros is read once
    // (review-b's M1 on b085cd91: 250 KB of them took 64 s). A length
    // modifier (`%.4ls`, which bash reads as `%.4s`) is read as the
    // conversion letter, one this reading does not model, and counts.
    for (const match of format.matchAll(/%(%|[-+ #0]*(?:[1-9*][0-9*]*)?(?:\.([0-9*]*))?([a-zA-Z]))/gu)) {
      const [whole, spec, precision, conversion] = match as unknown as [string, string, string | undefined, string | undefined];
      pieces.push(format.slice(last, match.index));
      last = match.index + whole.length;
      if (spec === "%") {
        parsedPercent.add(pieces.length);
        pieces.push("%");
        continue;
      }
      pieces.push({
        conversion: conversion as string,
        stars: spec.split("*").length - 1,
        precision: precision === undefined ? null : Number(precision || "0"),
      });
    }
    pieces.push(format.slice(last));
    // Only `%s`, `%b`, `%c` and `%d` are read, with flags, width and
    // precision; any other conversion (`%q`, `%Q`, `%ls`, bash's `%(…)T`) or a
    // `%` this reading did not take counts (the fifth security review).
    if (
      pieces.some((piece, at) =>
        typeof piece === "string" ? !parsedPercent.has(at) && piece.includes("%") : !/^[sbcd]$/u.test(piece.conversion),
      )
    ) {
      outputs.push("/.git/");
      continue;
    }
    const render = (piece: Conversion, took: () => void): string => {
      // A `*` width or precision takes its value from an argument: the
      // output is not modelled, and counts as naming `.git` (#680's source
      // review, S1). A literal precision cuts a string, as printf does:
      // `%.4s` of `.gitfoo` is `.git`. A width only pads with blanks.
      if (piece.stars > 0) {
        // Each `*` takes an argument, as the conversion does, so the passes
        // end once the words run out (codex's cost note on 09a3acd7).
        for (let star = piece.stars; star >= 0; star -= 1) {
          if (take() !== undefined) took();
        }
        return "/.git/";
      }
      // A precision cuts only text whose characters are known: cutting an
      // unknown value (a variable, a substitution) could leave any prefix of
      // it, so that counts as naming `.git` (the security review of this fold).
      // printf counts bytes, not characters, so a cut of non-ASCII text
      // counts too (codex's SOURCE HOLD on fc846a73: `%.7s` of `é/.gitfoo`
      // is `é/.git`).
      const cut = (text: string): string =>
        piece.precision === null
          ? text
          : text.includes(SUBSTITUTION_SENTINEL) || /[\u0080-\u{10FFFF}]/u.test(text)
            ? "/.git/"
            : text.slice(0, piece.precision);
      const arg = take();
      if (arg !== undefined) took();
      const value = (): string => unknown(arg?.text ?? "");
      if (piece.conversion === "s") return cut(value());
      // `%b` cuts the decoded bytes, NULs still in them, and the
      // substitution drops the NULs after: `%.5b` of `.g\0itX` is
      // `.g<NUL>it`, so `.git` (codex's SOURCE HOLD on 09a3acd7).
      // An unknown value `%b` decodes may decode to anything: it counts (the
      // sixth security review).
      if (piece.conversion === "b") return value().includes(SUBSTITUTION_SENTINEL) ? "/.git/" : dropNuls(cut(decodeBackslashEscapes(value(), zeroOctal)));
      // `%c` cuts to one character: of an unknown value that may be any one
      // (four of them can spell `.git`), so it counts, as a precision does.
      if (piece.conversion === "c") return value().includes(SUBSTITUTION_SENTINEL) ? "/.git/" : value().slice(0, 1);
      // `%d` prints a number: an unknown output.
      return SUBSTITUTION_SENTINEL;
    };
    let out = "";
    // Each pass of the format takes words; it repeats while words are left,
    // as printf does, and stops once a pass takes none.
    for (let pass = 0; pass === 0 || next < args.length; pass += 1) {
      let took = false;
      const mark = (): void => {
        took = true;
      };
      for (const piece of pieces) out += typeof piece === "string" ? piece : render(piece, mark);
      if (!took) break;
      // Past this many characters the rest is not rendered: it counts as
      // naming `.git`, the strict side, so the cost stays the line's own.
      if (out.length > PRINTED_OUTPUT_LIMIT) {
        out += "/.git/";
        break;
      }
    }
    outputs.push(out);
  }
  return outputs;
}

/**
 * Does what a substitution body prints spell `.git` (review of the
 * substitution fold, security review point c)? The body's output is the
 * output of its segments in turn: what `printf` and `echo` print
 * ({@link printedOutputs}), and any other segment's an unknown output, as is
 * a segment whose output is piped on (the next one prints instead). So
 * `$(printf .g; printf it)` is `.git`. Both readings of octal are tried.
 */
function bodyPrintsGit(segments: readonly LexSegment[]): boolean {
  // Readings 2 and 3 read a printer named by its path (`/usr/bin/printf`)
  // as main did before this fold read it, as an unknown output: a newly read
  // printer then never makes the body's reading looser than it was (codex's
  // SOURCE HOLD on 101630f2, M1: `printf .g; /usr/bin/printf x`).
  const readings = ["", "", "", ""];
  let printed = false;
  segments.forEach((segment, index) => {
    const outputs = printedOutputs(segment);
    const piped = segments[index + 1]?.stdinFed === true;
    const byPath = outputs !== null && printerCommand(segment).byPath;
    for (const r of [0, 1, 2, 3]) {
      readings[r] += outputs === null || piped || (r >= 2 && byPath) ? SUBSTITUTION_SENTINEL : (outputs[r % 2] as string);
    }
    if (outputs !== null && !piped) printed = true;
  });
  return (
    printed &&
    readings.some(
      (output) =>
        GIT_SEGMENT_IN_TEXT.test(output.split(SUBSTITUTION_SENTINEL).join("/")) ||
        wordJoinsGitAcrossSubstitution(output) ||
        // An unquoted substitution's output is still globbed: `.gi*`, `.g?t`
        // or `.gi[t]` printed (a precision may cut a longer word to it)
        // may name `.git` (the security review of the precision fold).
        output
          .split(SUBSTITUTION_SENTINEL)
          .join(" ")
          .split(/\s+/u)
          // Bounded, as the fold's other readers are (review-b's M3 on 689d4f88).
          .some((word) => /[*?[]/u.test(word) && mayNameGitDirectoryBounded(word)),
    )
  );
}

/**
 * Does a zsh subscript or modifier on an unbraced parameter carry `.git`
 * (#680's gate, M3)? zsh reads `$f[1,4]` as a substring, `$f[2]` of a scalar
 * as one character, and `$f:r`, `$f:t`, `$f:s/x/i/`, `$f:S/x/i/` as
 * modifiers, on a special parameter too (`$@:r`, `$*[1,4]`); no other
 * reading sees them. The coarse rule (the fifth security review): after an
 * unbraced parameter, any `[`, or a `:` then any letter or `&`, counts, on
 * any parameter, as every operator in braces does. bash reads the same text
 * as the value and literal text, which the other readings judge.
 */
function zshUnbracedOperatorNamesGit(text: string): boolean {
  // zsh's flags `$=f`, `$~f`, `$^f` (and `$+f`) may stand before the name;
  // `$~f` globs the value and `$=f` splits it, so a flag alone counts.
  return (
    text.includes("$") &&
    (/\$[=~^+]*(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:\[|:[A-Za-z&])/u.test(text) || /\$[=~^]+[A-Za-z_0-9@*#?$!{-]/u.test(text))
  );
}

/** How many `${` levels {@link expansionWordNamesGit} reads; a deeper word counts as naming `.git`. */
const EXPANSION_READ_DEPTH = 32;

/**
 * Does a parameter expansion in this word carry `.git` (review of the
 * substitution fold, S2, and its security review, points d and e)? Each
 * `${…}` is read by its operator:
 * - a word it may expand to (`:-`, `-`, `:=`, `=`, `:+`, `+`) is judged as an
 *   assignment's value is, and stands for the expansion in the word around
 *   it, so `.g${V:-i}t` is `.git`;
 * - `:?`, `?`, a length (`${#X}`) and an indirection (`${!X}`) carry no
 *   new text, and stand as an unknown value as `$V` does;
 * - every other operator transforms the value (removal, substring,
 *   replacement, case, `@`; points d and f to q), and counts, and so does a
 *   subscript other than `[@]` and `[*]` (zsh reads `${f[1,4]}` of a scalar
 *   as a substring; #680's gate, M3);
 * - a `${` that does not close counts.
 * A nested expansion stands, inside another's word, as the text it may
 * carry or as an unknown output.
 */
function expansionWordNamesGit(text: string): boolean {
  if (!text.includes("${")) return false;
  const valueNamesGit = (value: string): boolean =>
    GIT_SEGMENT_IN_TEXT.test(value.split(SUBSTITUTION_SENTINEL).join("/")) ||
    value.split(":").some(mayNameGitDirectoryBounded) ||
    wordJoinsGitAcrossSubstitution(value);
  const open: string[] = [""];
  let rewritten = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === "$" && text[at + 1] === "{") {
      // Each closing `}` reads its whole word again, so past
      // EXPANSION_READ_DEPTH levels the word counts as naming `.git`, the
      // strict side, and the cost stays the line's length times the depth
      // (review-b's M1 on b085cd91: 20,000 levels took 90 s).
      if (open.length > EXPANSION_READ_DEPTH) return true;
      open.push("");
      at += 1;
      continue;
    }
    if (char !== "}" || open.length === 1) {
      open[open.length - 1] += char;
      continue;
    }
    const inner = open.pop() as string;
    // Inside another expansion's word a value is an unknown output that may
    // join the text around it; in the word itself it stays a variable, as
    // `.g$X` does (a known limit).
    const unknownValue = open.length > 1 ? SUBSTITUTION_SENTINEL : "$V";
    let standIn: string;
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?|[0-9]+|[@*#?$!-])/u.exec(inner);
    const rest = name === null ? null : inner.slice(name[0].length);
    if (`\${${inner}}` === SUBSTITUTION_SENTINEL) {
      standIn = SUBSTITUTION_SENTINEL;
    } else if (rest === null) {
      return true;
    } else if (name?.[1] !== undefined && !/^\[[@*]\]$/u.test(name[1])) {
      // A subscript transforms a value: zsh reads `${f[1,4]}` of a scalar as
      // a substring and `${f[2]}` as one character (#680's gate, M3). It
      // counts, as every other operator does; `[@]` and `[*]` are the value.
      return true;
    } else if (rest === "" || /^[!#](?:[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?|[0-9]+|[@*#?$!-])$/u.test(inner)) {
      // A plain expansion, a length, an indirection (`${#X}`, `${!X}`, read
      // only when that is ALL it is, so `${!-.git}`, the default of `$!`,
      // is the operator it is): an unknown value.
      standIn = unknownValue;
    } else if (/^:?[-=+]/u.test(rest)) {
      const value = rest.replace(/^:?[-=+]/u, "");
      if (valueNamesGit(value)) return true;
      standIn = value;
      rewritten = true;
    } else if (/^:?\?/u.test(rest)) {
      // `:?` and `?` give the value itself or stop the shell: as `$V`.
      standIn = unknownValue;
    } else {
      // Every other operator transforms the value (removal, substring,
      // replacement, case, `@`), on any parameter (a name, a positional, a
      // special parameter, an array element): it counts as naming `.git`
      // (security review, points d and f to q). Working the result out
      // exactly was tried and left as a carry: each review round found
      // another shell corner.
      return true;
    }
    open[open.length - 1] += standIn;
  }
  if (open.length > 1) return true;
  return rewritten && valueNamesGit(open[0] as string);
}

/**
 * Does the line spell a `.git` segment where the shell may carry it to a
 * later word (second review, S3): an assignment's value, the body of a
 * command substitution, or a quoted string? A literal unquoted `.git` word
 * is judged where it stands and does not count. The substitution fold adds
 * two spellings: a body that asks git for its directory
 * ({@link asksGitForItsDirectory}), and a word whose literal text and
 * substitution output join into `.git` ({@link wordJoinsGitAcrossSubstitution}).
 * The review of that fold adds two more: an ANSI-C quoted string or what
 * `printf` or `echo` in a substitution body prints, escapes decoded
 * ({@link ansiCQuotingSpellsGit}, {@link printedOutputs}), and what a
 * parameter expansion may carry (`${VAR:-.git}`, `${G/x/.}`,
 * {@link expansionWordNamesGit}).
 *
 * Substitution bodies are read this way to {@link SUBSTITUTION_READ_DEPTH}
 * levels; a deeper one counts as naming `.git`, the strict side, so the
 * reading's cost and its depth on the call stack stay bounded.
 */
function lineSpellsGitIndirectly(segments: readonly LexSegment[], depth = 0): boolean {
  // A substitution body's words, each read as a path the shell may still
  // expand (`$(echo .gi?)`); its own segments read as a line of their own
  // (a nested substitution, an assignment in it, a split spelling); and a
  // `git rev-parse --git-dir` in it. A body that does not lex is unreadable,
  // and the strict side.
  const bodyNamesGit = (body: string): boolean => {
    if (depth >= SUBSTITUTION_READ_DEPTH) return true;
    if (GIT_SEGMENT_IN_TEXT.test(body) || body.split(/[\s;&|()]+/u).some((token) => mayNameGitDirectory(token.replace(/["']/gu, "")))) {
      return true;
    }
    // `printf '\x2egit'`, `echo -e '\0056git'`: escapes a command in the body
    // may decode, read both ways octal is written.
    // A NUL is read three ways, the strict side of each: kept, dropped (a
    // substitution drops it) and as an end (an ANSI-C string ends there).
    if (
      body.includes("\\") &&
      [false, true].some((zeroOctal) => {
        const decoded = decodeBackslashEscapes(body, zeroOctal);
        return [decoded, dropNuls(decoded), cutAtNul(decoded)].some((text) => GIT_SEGMENT_IN_TEXT.test(text));
      })
    ) {
      return true;
    }
    const lexed = lex(body);
    if (!lexed.ok) return true;
    return (
      lexed.segments.some(asksGitForItsDirectory) ||
      bodyPrintsGit(lexed.segments) ||
      lineSpellsGitIndirectly(lexed.segments, depth + 1)
    );
  };
  return segments.some((segment) => {
    const assignments = bashAssignmentCount(segment.words);
    const words = [...segment.words, ...segment.redirects.map((redirect) => redirect.target)];
    return (
      ansiCQuotingSpellsGit(segment.text) ||
      ansiCQuotingNearSpellsGit(segment.text) ||
      assignsByPrinter(segment) ||
      segment.bodySubstitutions.some(bodyNamesGit) ||
      words.some((word, index) => {
        if (word.substitutions.some(bodyNamesGit)) return true;
        if (wordJoinsGitAcrossSubstitution(word.text)) return true;
        if (expansionWordNamesGit(word.text)) return true;
        if (zshUnbracedOperatorNamesGit(word.text)) return true;
        // An assignment's VALUE is judged as a target is, patterns and braces
        // included (`D=.gi?`, `D=.g{i,}t`, `D='.[g]it'`): an unquoted `$D`
        // later expands it. Its words after `:` (a PATH-like list) too.
        if (index < assignments) {
          const value = word.text.slice(word.text.indexOf("=") + 1);
          return GIT_SEGMENT_IN_TEXT.test(value) || value.split(":").some(mayNameGitDirectory);
        }
        return word.quoted && GIT_SEGMENT_IN_TEXT.test(word.text);
      })
    );
  });
}

/**
 * A sed script's possible file names judged as sed reads them: LITERALLY
 * (sed expands no glob, brace, `~` or variable in a `w` name), so `.gi?`
 * names a directory called `.gi?`, never `.git`. A name with a `.git`
 * segment, or a relative one that lands in `.git` after the line's `cd`s,
 * is `git-dir-write`; and on a line that spells `.git` indirectly (S3), a
 * name the SHELL still expands (`$D` inside double quotes) or a relative
 * one after a `cd` the text cannot place is too.
 */
function sedLiteralGitWrite(
  words: readonly string[],
  dir: ShellDir | null | undefined,
  lineNamesGit: boolean,
): { class: string; rule: string; path: string } | null {
  const literalGit = (path: string): boolean => pathSegments(path).some((segment) => foldNameLower(segment) === ".git");
  const hit = words.find(
    (word) =>
      literalGit(word) ||
      (dir !== null && dir !== undefined && dir.segments.length > 0 && !word.startsWith("/") && literalGit(joinShellPath(dir.segments, word.split("/")).join("/"))) ||
      (lineNamesGit && (/[$`]/u.test(word) || (dir === null && !word.startsWith("/")))),
  );
  return hit === undefined ? null : { class: "vcs.history.rewrite", rule: GIT_DIR_WRITE_RULE, path: hit };
}

/** `git branch` reads until it is asked to delete, rename or force-set one. */
function refineGitBranch(ctx: RuleContext): Refinement {
  const mutating =
    hasFlag(ctx.args, ["--delete", "--move", "--copy", "--force", "--set-upstream-to"]) ||
    hasShortFlag(ctx.args, ["d", "D", "m", "M", "c", "C", "f"]);
  return mutating
    ? { class: "vcs.commit.branch", rule: "git-branch-write" }
    : { class: "read.shell", rule: "git-branch-read" };
}

/** `npm install` with a package name adds a dependency; without one it restores. */
function refineNpmInstall(ctx: RuleContext): Refinement {
  const packages = ctx.positionals.slice(1);
  return packages.length === 0
    ? { class: "deps.install", rule: "npm-install-lockfile" }
    : { class: "deps.add", rule: "npm-install-package" };
}

/**
 * `find` primaries that run another command. Opaque, for the reason `xargs` is
 * (APRV-283): what `-exec` runs is a command line this classifier is not
 * reading, so the segment's effect is not in the words it can see.
 */
const FIND_EXEC_PRIMARIES: readonly string[] = ["-exec", "-execdir", "-ok", "-okdir"];

/**
 * `find` primaries that write. `-delete` removes every match; `-fprint`,
 * `-fprintf` and `-fls` each create or truncate the file named after them.
 */
const FIND_WRITE_PRIMARIES: readonly string[] = ["-fprint", "-fprintf", "-fls"];

/**
 * `find` walks and prints, until a primary makes it act (APRV-283).
 *
 * Until this row existed `find` sat in the read table with `ls` and `grep`, so
 * `find . -type f -delete` and `find . -exec rm {} +` both classified
 * `read.shell`: a recursive delete answered as a listing. It went unnoticed
 * because a `2>/dev/null` on the end reclassified the whole segment
 * `files.write.workspace` by the redirect override, which is the bug this task
 * fixes; taking that override away without this row would have left the delete
 * reading as a walk.
 *
 * `-delete` is `files.delete.out_of_scope` rather than a workspace write on the
 * same reasoning `refineRm` uses for `rm -r .`: `find` is recursive by
 * construction and its start points are usually relative, so the classifier
 * cannot establish what a delete covers, and a delete whose scope cannot be
 * established is the manual one.
 */
function refineFind(ctx: RuleContext): Refinement {
  const running = ctx.args.find((arg) => FIND_EXEC_PRIMARIES.includes(arg));
  if (running !== undefined) {
    return {
      opaque: `find ${running} runs a command this classifier does not read`,
    };
  }
  if (ctx.args.includes("-delete")) {
    return { class: "files.delete.out_of_scope", rule: "find-delete" };
  }
  const writing = ctx.args.find((arg) => FIND_WRITE_PRIMARIES.includes(arg));
  if (writing !== undefined) return { class: "files.write.workspace", rule: "find-write" };
  return { class: "read.shell", rule: "find-read" };
}

/** `sed -i` edits in place; every other `sed` reads. */
function refineSed(ctx: RuleContext): Refinement {
  const inPlace =
    hasFlag(ctx.args, ["--in-place"]) ||
    ctx.args.some((arg) => arg.startsWith("-i") && !arg.startsWith("--"));
  return inPlace
    ? { class: "files.write.workspace", rule: "sed-in-place" }
    : { class: "read.shell", rule: "sed-read" };
}

// ===========================================================================
// Packaging and archives (APRV-397)
// ===========================================================================

/**
 * The read-only packaging and archive tools, and the one rule they share.
 *
 * ## What was wrong
 *
 * A release verification is mostly reading: pack a tarball, list what is in it,
 * unpack it somewhere disposable, hash a file, decode a base64 blob, ask a
 * binary its version. Every one of those commands was `unclassified` until this
 * task, so every one of them was DENIED, and the verifier that met the wall on
 * 2026-09-20 did the work anyway by fetching the tarball with `curl` and
 * parsing it in a script: a chain of network and interpreter calls in place of
 * six readers. A gate that refuses the legible spelling and leaves the
 * illegible one open has made the session less inspectable rather than safer.
 *
 * ## The one rule
 *
 * Each of these commands either reads what it names or writes into a
 * destination it names, and the destination is in the text. So they are decided
 * by the arithmetic {@link refineRm} already uses, hoisted into
 * {@link scopedWrite}: a destination strictly under a scratch root the CALLER
 * resolved is the agent's own space, a relative destination is the workspace,
 * and an absolute path anywhere else, a `..` segment, or a value the text cannot
 * read is out of scope.
 *
 * ## Why the out-of-scope answer is a class that already exists
 *
 * {@link OUT_OF_SCOPE_WRITE_CLASS} is `files.delete.out_of_scope`, which is
 * what `rm` and `find -delete` already answer for a destructive file operation
 * the text places outside the workspace. Minting `files.write.out_of_scope`
 * instead would have been the one change here capable of loosening something: a
 * class no policy names resolves by `defaults.autonomy` (SPEC.md §7), so in
 * every deployment whose defaults are permissive a brand-new name arrives
 * autonomous, while the existing class is held at `manual` by the reference
 * policy and by this repository's. An extraction is also honestly described by
 * it: unpacking an archive over a directory overwrites whatever it finds there,
 * which is the destruction the class is about.
 *
 * The strictness this inherits is `rm`'s, and it is deliberate. An ABSOLUTE
 * destination is out of scope even when it happens to sit inside the checkout,
 * because this file holds no workspace root, and the read roots it does hold
 * are a read notion that must not become a write authorization.
 */
const OUT_OF_SCOPE_WRITE_CLASS = "files.delete.out_of_scope";

/** The one rule id every out-of-scope packaging destination reports. */
const OUT_OF_SCOPE_WRITE_RULE = "packaging-write-out-of-scope";

/**
 * A destination a flag names, as a list {@link scopedWrite} can read.
 *
 * Three answers, and the third is the one worth naming: `[]` when the flag is
 * absent (the command writes where it stands, which is the working directory),
 * `[value]` when the flag names something the text can read, and `[null]` when
 * the flag is PRESENT and its value is not in the words. The last is a refusal
 * rather than an absence, because a flag present with nothing readable after it
 * would otherwise be answered as "no destination named" and take the looser
 * branch.
 */
function namedDestination(
  args: readonly string[],
  names: readonly string[],
): readonly (string | null)[] {
  if (!hasFlag(args, names)) return [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!names.includes(name)) continue;
    if (equals !== -1) {
      const value = arg.slice(equals + 1);
      return [value.length === 0 ? null : value];
    }
    const value = args[index + 1];
    return [value === undefined || isFlag(value) ? null : value];
  }
  return [null];
}

/**
 * The class of a write into destinations the command names (APRV-397).
 *
 * The same fail-closed branches {@link refineRm} has, in the same order,
 * against the same roots: all-scratch loosens, and an unreadable destination, an
 * absolute one, or a `..` segment is out of scope with the destination BOUND so
 * an approver is told which path earned the class. An empty destination list is
 * the working directory, which this file cannot see and must not guess at, so it
 * takes the row's own workspace answer exactly as `rm` with no target does.
 */
function scopedWrite(
  ctx: RuleContext,
  destinations: readonly (string | null)[],
  rule: string,
): Refinement {
  const named = destinations.filter((entry): entry is string => entry !== null);
  if (named.length < destinations.length) {
    return { class: OUT_OF_SCOPE_WRITE_CLASS, rule: OUT_OF_SCOPE_WRITE_RULE };
  }
  if (allTargetsAreScratch(named, ctx.context.scratchRoots ?? [])) {
    return { class: "files.write.workspace", rule };
  }
  for (const destination of named) {
    if (
      destination.startsWith("/") ||
      pathSegments(destination).includes("..") ||
      isUnknownValue(destination)
    ) {
      return { class: OUT_OF_SCOPE_WRITE_CLASS, rule: OUT_OF_SCOPE_WRITE_RULE, path: destination };
    }
  }
  return { class: "files.write.workspace", rule };
}

/**
 * An argv that asks a binary about itself: a version or a usage string.
 *
 * The harness table has its own copy of this idea ({@link HARNESS_PROBE_FLAGS})
 * and keeps it, because a harness probe still EXECUTES a whole second agent's
 * binary and is named in {@link CODE_EXECUTING_RULES} for that reason. This one
 * is the package managers', where `npm --version` prints a string and starts
 * nothing at all. `-v` is here and absent there: it is npm's version flag and
 * nothing else's.
 */
const VERSION_PROBE_FLAGS: readonly string[] = ["--version", "-v", "-V", "--help", "-h"];

/** Is this argv nothing but probe flags? One word at minimum, so a bare binary is not a probe. */
function isVersionProbe(args: readonly string[]): boolean {
  return args.length > 0 && args.every((arg) => VERSION_PROBE_FLAGS.includes(arg));
}

/** Positionals, with the values of value-taking flags left out of the count. */
function positionalsBesideValues(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (isFlag(arg)) {
      if (valueFlags.includes(arg)) index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** `npm pack`'s flags whose value is a path or a workspace name, never a package spec. */
const NPM_PACK_VALUE_FLAGS: readonly string[] = ["--pack-destination", "--workspace", "-w"];

/**
 * Does this `npm pack` argument name something on disk rather than a registry
 * package?
 *
 * A path, in the spellings npm accepts for one. Everything else is a package
 * spec, which `npm pack` resolves by FETCHING it, and a value the text cannot
 * read is a spec too: the looser reading of an unreadable argument is the one
 * that lets a download through as a local pack.
 */
function isLocalPackSpec(spec: string): boolean {
  if (isUnknownValue(spec)) return false;
  if (spec.startsWith(".") || spec.startsWith("/")) return true;
  return spec.includes("/") && !spec.startsWith("@");
}

/**
 * `npm pack` — a tarball into the working directory, or into
 * `--pack-destination`.
 *
 * Two answers beside the scoped write. A positional naming a REGISTRY package
 * is `network.call`, because that spelling downloads the package before it packs
 * it and the tarball it then writes is beside the point. And the write itself
 * runs the package's own `prepack` and `prepare` scripts, which is why the rule
 * id is in {@link CODE_EXECUTING_RULES}.
 */
function refineNpmPack(ctx: RuleContext): Refinement {
  const specs = positionalsBesideValues(ctx.args, NPM_PACK_VALUE_FLAGS).slice(1);
  if (specs.some((spec) => !isLocalPackSpec(spec))) {
    return { class: "network.call", rule: "npm-pack-remote" };
  }
  return scopedWrite(ctx, namedDestination(ctx.args, ["--pack-destination"]), "npm-pack");
}

/**
 * `npm init` — `package.json` into the working directory.
 *
 * No flag moves it, so there is no destination to scope and the answer is the
 * workspace write the row declares. `npm init <pkg>` is a different act, since
 * it downloads an initializer and runs it, which is `npm exec` wearing another
 * name; it takes its own rule id and its seat in {@link CODE_EXECUTING_RULES}
 * beside `npm-script`.
 */
function refineNpmInit(ctx: RuleContext): Refinement {
  const initializer = positionalsBesideValues(ctx.args, ["--workspace", "-w"]).slice(1);
  return initializer.length === 0
    ? { class: "files.write.workspace", rule: "npm-init" }
    : { class: "files.write.workspace", rule: "npm-init-create" };
}

/** `tar`'s long spellings of each mode, beside the one-letter ones. */
const TAR_LIST_FLAGS: readonly string[] = ["--list"];
const TAR_EXTRACT_FLAGS: readonly string[] = ["--extract", "--get"];
const TAR_CREATE_FLAGS: readonly string[] = [
  "--create",
  "--append",
  "--update",
  "--delete",
  "--concatenate",
  "--catenate",
];

/** The argv that ask `tar` about itself and open no archive at all. */
const TAR_PROBE_FLAGS: readonly string[] = ["--version", "--help", "--usage"];

/**
 * The mode letters `tar` was given, from the short bundles and the old-style
 * first word.
 *
 * `tar xzf a.tgz` carries no dash at all, and it is the spelling most sessions
 * write, so a rule that read only `-x` would answer the common form with a
 * refusal. Only the FIRST word can be an old-style bundle, and a word is read as
 * a bundle only when it is letters and nothing else: `-fa.tgz` is a glued
 * filename, and a letter taken out of a filename is a mode the command never
 * named. Dropping such a word costs a refusal (the mode becomes unreadable) and
 * can never invent a read.
 */
function tarModeLetters(args: readonly string[]): string {
  let letters = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (/^-[A-Za-z]+$/u.test(arg)) letters += arg.slice(1);
    else if (index === 0 && /^[A-Za-z]+$/u.test(arg)) letters += arg;
  }
  return letters;
}

/** The tar letters that consume the next word, which is what makes a bundle ambiguous. */
const TAR_VALUE_LETTERS: readonly string[] = ["f", "C"];

/** The option letters of a tar word, or `null` when it is not a bundle of them. */
function tarBundle(arg: string, index: number): string | null {
  if (/^-[A-Za-z]+$/u.test(arg)) return arg.slice(1);
  if (index === 0 && /^[A-Za-z]+$/u.test(arg)) return arg;
  return null;
}

/**
 * The value a tar flag carries, in every spelling tar accepts for it.
 *
 * The glued bundle is the whole reason this exists rather than
 * {@link namedDestination}: `tar -czf out.tgz src` names its archive with an
 * `f` buried in `-czf`, which an exact-word flag match cannot see, and a rule
 * that missed it would answer the commonest spelling of a create with the
 * looser branch.
 *
 * One bundle carrying BOTH value-taking letters (`-xCf`) is `null`, which
 * {@link scopedWrite} refuses: which of the following words feeds which letter
 * depends on tar's own option order, so the destination is not in the text
 * (SPEC.md §11.1, ambiguity resolves to the stricter class).
 */
function tarFlagValue(
  args: readonly string[],
  letter: string,
  longNames: readonly string[],
): readonly (string | null)[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (longNames.includes(name)) {
      if (equals === -1) {
        const next = args[index + 1];
        return [next === undefined || isFlag(next) ? null : next];
      }
      const value = arg.slice(equals + 1);
      return [value.length === 0 ? null : value];
    }
    const bundle = tarBundle(arg, index);
    if (bundle === null || !bundle.includes(letter)) continue;
    if (TAR_VALUE_LETTERS.filter((candidate) => bundle.includes(candidate)).length > 1) {
      return [null];
    }
    const next = args[index + 1];
    return [next === undefined || isFlag(next) ? null : next];
  }
  return [];
}

/**
 * `tar` — a listing reads, an extraction writes where `-C` points, a creation
 * writes the archive `-f` names.
 *
 * The write branch is checked FIRST and takes both destinations when one command
 * names both modes, because `tar` resolves a contradictory mode by its own
 * option order and the stricter reading is the one that assumes it writes.
 *
 * A mode the text does not carry is `opaque` rather than a guess, and that is
 * the honest code for it: a `tar` whose mode is not in its words is a command
 * whose effect is not in its words, which is what {@link OPAQUE_BINS} refuses
 * for the same reason.
 */
function refineTar(ctx: RuleContext): Refinement {
  const letters = tarModeLetters(ctx.args);
  const extracting = letters.includes("x") || hasFlag(ctx.args, TAR_EXTRACT_FLAGS);
  const creating =
    ["c", "r", "u", "A"].some((letter) => letters.includes(letter)) ||
    hasFlag(ctx.args, TAR_CREATE_FLAGS);
  if (extracting || creating) {
    const destinations = [
      ...(extracting ? tarFlagValue(ctx.args, "C", ["--directory"]) : []),
      ...(creating ? tarFlagValue(ctx.args, "f", ["--file"]) : []),
    ];
    return scopedWrite(ctx, destinations, extracting ? "tar-extract" : "tar-create");
  }
  if (letters.includes("t") || hasFlag(ctx.args, TAR_LIST_FLAGS)) {
    return { class: "read.shell", rule: "tar-list" };
  }
  if (ctx.args.length > 0 && ctx.args.every((arg) => TAR_PROBE_FLAGS.includes(arg))) {
    return { class: "read.shell", rule: "tar-probe" };
  }
  return { opaque: "tar names no mode this classifier can read" };
}

/**
 * `gunzip` — the stdout, test and list forms read; every other form REPLACES a
 * file.
 *
 * The default is the trap: `gunzip pkg.tgz` removes `pkg.tgz` and leaves
 * `pkg.tar` in its place, so the plain spelling is a write of the path it names.
 * Three flags leave the disk alone: `-c`/`--stdout` decompresses to standard
 * output, `-t`/`--test` checks the integrity of the archive, and `-l`/`--list`
 * prints the compressed and uncompressed sizes, the ratio and the member name.
 * A listing is the same kind of act as `tar -t` beside it and belongs in the
 * same class. `-k` (`--keep`) is deliberately not a read: it spares the input
 * and still creates the output.
 */
function refineGunzip(ctx: RuleContext): Refinement {
  const reading =
    hasShortFlag(ctx.args, ["c", "t", "l"]) ||
    hasFlag(ctx.args, ["--stdout", "--to-stdout", "--test", "--list"]);
  return reading
    ? { class: "read.shell", rule: "gunzip-read" }
    : scopedWrite(ctx, ctx.positionals, "gunzip-write");
}

/** `base64` — a read of what it names, unless `-o` names a file to write. */
function refineBase64(ctx: RuleContext): Refinement {
  const destination = namedDestination(ctx.args, ["-o", "--output"]);
  return destination.length === 0
    ? { class: "read.shell", rule: "base64-read" }
    : scopedWrite(ctx, destination, "base64-write");
}

/**
 * `openssl`'s digest subcommands, and only those.
 *
 * The row names the digests rather than the binary, so `openssl enc`, `genrsa`,
 * `req`, `rand` and `s_client` stay exactly as unclassified as they were. Each
 * of those writes key material, encrypts, or opens a socket, and none of them is
 * what a release verification runs; a row for the binary would have swept all of
 * them into a read.
 */
const OPENSSL_DIGEST_SUBS: readonly string[] = [
  "dgst",
  "md5",
  "sha1",
  "sha256",
  "sha384",
  "sha512",
];

/** `openssl dgst …` — a read of its named files, unless `-out` names one to write. */
function refineOpensslDigest(ctx: RuleContext): Refinement {
  const destination = namedDestination(ctx.args, ["-out"]);
  return destination.length === 0
    ? { class: "read.shell", rule: "openssl-digest" }
    : scopedWrite(ctx, destination, "openssl-digest-out");
}

/**
 * `git tag` — the listing forms read (APRV-397).
 *
 * APRV-305 gave the whole verb `release.publish`, which is right for the half
 * of it that creates, moves, signs and deletes tags: a tag is the name a
 * release was published under. It is wrong for the other half. `git tag -l` is
 * a listing of local refs, and on 2026-09-20 it put a nine-minute question on a
 * phone during a state check. Nothing about a listing reaches a registry, a
 * remote or a consumer, and the class it takes is `read.shell`, the class every
 * other reader of local repository metadata takes (`git log`, `git branch`,
 * `git status`).
 *
 * The split is an ALLOWLIST of the flags that list, and that direction is the
 * whole safety argument: a flag this rule has never heard of is a creation, so a
 * future `git tag` option cannot arrive as a read by default. A positional is a
 * TAG NAME, which creates one, unless `-l` is present and makes it a pattern.
 * The shape mirrors {@link refineGitBranch}, which splits read and write halves
 * of one verb for the same reason.
 */
const GIT_TAG_READ_FLAGS: readonly string[] = [
  "-l",
  "--list",
  "-n",
  "-i",
  "--ignore-case",
  "--omit-empty",
  "--column",
  "--no-column",
  "--color",
  "--no-color",
];

/** Listing flags whose next word is a value rather than a tag name. */
const GIT_TAG_READ_VALUE_FLAGS: readonly string[] = [
  "--contains",
  "--no-contains",
  "--points-at",
  "--merged",
  "--no-merged",
  "--sort",
  "--format",
];

function refineGitTag(ctx: RuleContext): Refinement {
  const publish: Refinement = { class: "release.publish", rule: "git-tag" };
  const args = ctx.args.slice(1);
  const names: string[] = [];
  let listing = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!isFlag(arg)) {
      names.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name === "-l" || name === "--list") {
      listing = true;
      continue;
    }
    if (GIT_TAG_READ_FLAGS.includes(name) || /^-n\d+$/u.test(arg)) continue;
    if (GIT_TAG_READ_VALUE_FLAGS.includes(name)) {
      if (equals === -1) index += 1;
      continue;
    }
    // Everything the allowlist does not name: a creation, a deletion, a
    // signature, a force-move, and also a flag that did not exist when this rule
    // was written.
    return publish;
  }
  return names.length > 0 && !listing ? publish : { class: "read.shell", rule: "git-tag-read" };
}

/**
 * The methods a fetch may name and still be a read: GET, and HEAD, which is a
 * GET that discards the body. Everything else, including a method the
 * classifier cannot read, is a write as far as this file is concerned.
 */
const READ_METHODS: readonly string[] = ["GET", "HEAD"];

/** What a command line says about the HTTP method it will use. */
type MethodVerdict = "absent" | "read" | "other";

/**
 * Read the method out of a method-naming flag.
 *
 * `long` holds the exact spellings (`--request`, `-X`, `--method`), matched
 * both bare (`-X GET`) and joined (`--request=GET`); `short` is the short flag
 * whose value may be glued to it (`-XGET`). A flag present with a value we
 * cannot read, or with no value at all, is `other`: an unreadable method is a
 * method we must assume mutates.
 */
function readMethodFlag(
  args: readonly string[],
  long: readonly string[],
  short: string,
): MethodVerdict {
  let verdict: MethodVerdict = "absent";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    let value: string | undefined;
    if (long.includes(name)) {
      value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    } else if (!arg.startsWith("--") && arg.startsWith(short) && arg.length > short.length) {
      value = arg.slice(short.length);
    } else {
      continue;
    }
    if (value === undefined || isUnknownValue(value) || !READ_METHODS.includes(value.toUpperCase())) {
      return "other";
    }
    verdict = "read";
  }
  // A short-flag bundle carrying the method letter without being the whole flag
  // (`-sSX POST`) hides its value from the scan above. This is a classifier over
  // shell text, not curl's option grammar, so the bundle itself is the answer.
  if (verdict === "absent" && hasShortFlag(args, [short.slice(1)])) return "other";
  return verdict;
}

/**
 * Flags that hand curl, wget or httpie a request body or an upload. Any one of
 * them makes the invocation a write whatever method it names, so they are
 * checked before the method is.
 */
const WEB_BODY_FLAGS: readonly string[] = [
  "-d",
  "--data",
  "--data-raw",
  "--data-ascii",
  "--data-binary",
  "--data-urlencode",
  "--json",
  "-F",
  "--form",
  "--form-string",
  "-T",
  "--upload-file",
  "--post-data",
  "--post-file",
  "--body-data",
  "--body-file",
];

/**
 * Flags that let a file supply options this classifier never sees. A curl
 * `-K config` can name any method and carry any body, so the invocation is
 * unreadable in the only sense that matters here and takes the stricter class.
 */
const WEB_CONFIG_FLAGS: readonly string[] = ["-K", "--config"];

/**
 * Is this httpie word a request item (`name=value`, `field:=1`, `file@path`)
 * rather than a URL? httpie turns request items into a JSON body and the method
 * into POST, so an item is a write.
 *
 * A URL is exempted by its scheme or its path separator, which keeps
 * `https://x/?a=b` a read; anything else carrying `=` or `@` is an item.
 */
function isHttpieRequestItem(word: string): boolean {
  if (word.startsWith("http://") || word.startsWith("https://")) return false;
  if (word.includes("/")) return false;
  return word.includes("=") || word.includes("@");
}

/**
 * curl, wget and httpie — a GET-shaped fetch is `read.web` (APRV-114).
 *
 * SPEC.md §7 already puts "web fetch, API GET" under `read.*`, and before this
 * refinement the classifier answered `network.call` for every one of them, so a
 * policy holding mutating calls at manual held every research fetch there too.
 * That is the APRV-83 shape of problem (a class too coarse to state the policy
 * the taxonomy already describes), and it takes the APRV-83 fix.
 *
 * The read branch is deliberately narrow: a body or upload flag, a method that
 * is not GET or HEAD, a config file that could hold either, a short-flag bundle
 * we decline to unbundle, or a bare `$VAR` that could expand into any of them
 * all take `network.call`. Over-classifying a read as a write costs one
 * approval; the reverse runs an unreviewed write.
 */
function refineWebFetch(ctx: RuleContext): Refinement {
  const write: Refinement = { class: "network.call", rule: "web-write" };
  // The method flag may carry its value glued on (`-XGET`), and those letters
  // are not a short-flag bundle; scanning them for body letters would read the
  // `T` in `GET` as an upload. The method is read on its own below.
  const bundles = ctx.args.filter((arg) => arg.startsWith("--") || !arg.startsWith("-X"));
  if (hasFlag(ctx.args, WEB_BODY_FLAGS) || hasShortFlag(bundles, ["d", "F", "T"])) return write;
  if (hasFlag(ctx.args, WEB_CONFIG_FLAGS) || hasShortFlag(bundles, ["K"])) return write;
  // A word that is an unexpanded expansion, or that came out of a command
  // substitution, is not a URL we can read; it is whatever the environment puts
  // there, flags included.
  if (ctx.substituted || ctx.args.some((arg) => arg.startsWith("$"))) return write;
  if (readMethodFlag(ctx.args, ["-X", "--request", "--method"], "-X") === "other") return write;
  if (ctx.bin === "http" || ctx.bin === "httpie") {
    // httpie names its method in a bare word and its body in request items.
    // Every bare word is tested for the method, not only the first: a flag
    // value ahead of it (`http -a user:pass POST url`) shifts its position, and
    // this classifier does not know which flags take values.
    for (const positional of ctx.positionals) {
      if (/^[A-Z]+$/u.test(positional) && !READ_METHODS.includes(positional)) return write;
      if (isHttpieRequestItem(positional)) return write;
    }
  }
  return { class: "read.web", rule: "web-read" };
}

/**
 * Flags that give `gh api` a request body. `-f`/`-F` here are gh's field flags,
 * not curl's form and upload ones, and `--input` reads a body from a file.
 */
const GH_API_FIELD_FLAGS: readonly string[] = ["-f", "--field", "-F", "--raw-field", "--input"];

// ---------------------------------------------------------------------------
// GitHub metadata on the repository's own remote (APRV-268)
// ---------------------------------------------------------------------------

/**
 * Nudging the forge about THIS checkout's own repository.
 *
 * From the log, 2026-09-05: of 52 `network.call` questions since 2026-08-17, 48
 * were approved, and three forms account for the bulk of them: `gh api graphql`
 * queries, `gh pr update-branch` and `gh run rerun`, all against this
 * repository's own origin. Sending things is what `network.call` is FOR (a
 * webhook, an email, an arbitrary POST), and those stay manual. Asking GitHub a
 * question about the repository the checkout already tracks, or telling it to
 * redo bookkeeping about work already pushed, is a different act, and it had no
 * class of its own to be granted through.
 *
 * The class is exactly three forms wide, and that width is the point. APRV-268
 * first drew it wider, over `gh pr view`, `gh run list`, `gh issue view` and a
 * plain `gh api` GET as well. Those were already `read.vcs.remote`, which this
 * repository's policy makes autonomous, and an undeclared class falls to the
 * manual default: moving them would have RAISED friction on the commonest reads
 * in the repo to buy a class none of them needed. So the rule covers only the
 * forms the log showed as `network.call`, and every read keeps the class it had.
 *
 * The class sits beside `read.vcs.remote` and `vcs.pr.open`: same forge, same
 * repository, and no payload of the operator's authorship leaves the machine.
 * Two of the three are metadata MUTATIONS (`pr update-branch`, `run rerun`), in
 * because what they change is the forge's own bookkeeping about work already
 * pushed, not content: the merge-base of a branch, a re-run of a workflow that
 * already ran.
 */
const REMOTE_META_CLASS = "vcs.remote.meta";

/**
 * Flags that point `gh` at a repository other than the checkout's own, or at
 * another forge entirely.
 *
 * The classifier is pure: it cannot resolve `origin`, so it cannot tell
 * `-R approval-md/approval-md` (this repository, named explicitly) from
 * `-R someone/else`. It therefore treats EVERY one of these as foreign and
 * falls back to today's class. Over-classifying costs one approval prompt; the
 * other direction would let `gh api -R victim/repo` ride a rule written for
 * this repository's own metadata.
 */
const GH_FOREIGN_TARGET_FLAGS: readonly string[] = ["-R", "--repo", "--hostname"];

/**
 * Does this invocation use gh's DEFAULT repository resolution?
 *
 * `gh` with no `-R`/`--repo` resolves the repository from the checkout's git
 * remotes, which is exactly "the checkout's own origin repository" — the only
 * form this rule vouches for. A substitution or an unexpanded `$VAR` anywhere
 * in the argv hides words the classifier never sees, one of which could be a
 * `--repo`, so those are foreign too.
 */
function isOwnRepoInvocation(ctx: RuleContext): boolean {
  if (ctx.substituted) return false;
  if (ctx.args.some((arg) => arg.includes("$"))) return false;
  return !hasFlag(ctx.args, GH_FOREIGN_TARGET_FLAGS);
}

/**
 * The gh noun/action pairs that are metadata on the repository's own remote.
 *
 * Exactly the two the log showed as `network.call`, and no wider. Every other
 * action on these nouns keeps the class it had: `gh pr view`, `gh pr list`,
 * `gh pr checks`, `gh pr diff`, `gh pr status`, `gh run view`, `gh run list`
 * and `gh issue view/list` stay `read.vcs.remote`, `gh pr create` stays
 * `vcs.pr.open`, `gh pr merge` stays `vcs.push.main`. A rule that grew by
 * analogy would be a rule nobody reviewed.
 */
const GH_META_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  pr: ["update-branch"],
  run: ["rerun"],
};

/**
 * The GraphQL keyword that turns a query into a write.
 *
 * Matched as a word so a field named `mutationCount` cannot trip it and a
 * `mutation(` cannot slip past. Anchored nowhere: an operation can appear
 * anywhere in a document, and a document with a mutation anywhere in it is a
 * mutation.
 */
const GRAPHQL_MUTATION = /(^|[^A-Za-z0-9_])mutation([^A-Za-z0-9_]|$)/u;

/**
 * Is this `gh api graphql` call a pure query?
 *
 * Every word of the invocation is searched, because gh takes the document in a
 * field (`-f query=…`, `--field query=@file`) and the classifier does not know
 * gh's option grammar well enough to say which word is the document. Two ways
 * to answer no, both fail-closed: the text contains `mutation` anywhere, or it
 * reads the document from a file (`@path`, `--input`), whose contents this
 * classifier will never see.
 */
function isGraphqlQueryOnly(args: readonly string[]): boolean {
  if (hasFlag(args, ["--input"])) return false;
  for (const arg of args) {
    if (GRAPHQL_MUTATION.test(arg)) return false;
    // `-f query=@file` and `--field query=@-` read the document from elsewhere.
    const equals = arg.indexOf("=");
    if (equals !== -1 && arg.slice(equals + 1).startsWith("@")) return false;
  }
  return true;
}

/**
 * `gh api` — a GET reads as it always has (APRV-114); a GraphQL query on this
 * checkout's own repository is metadata (APRV-268); everything else is a call.
 *
 * gh defaults to GET, and to POST the moment a field appears, so those two flag
 * families were the whole test before APRV-268 and remain it: a bodyless,
 * methodless call is `read.vcs.remote`, whatever repository it names, exactly as
 * it has classified since APRV-114.
 *
 * GraphQL is the one shape that test could not read, and the only thing APRV-268
 * moves here. A query is carried in a field, so `gh api graphql -f query='query
 * {…}'` looks exactly like a POST and classified `network.call`, which is how a
 * run of approved read questions came to sit in the log. It is promoted only out
 * of `network.call`, never out of the read class: the branch below runs after
 * the GET test, so a form that read before still reads.
 *
 * The row this refines also matches `auth`, `gist`, `secret` and `workflow`,
 * which stay `network.call` unconditionally.
 */
function refineGhApi(ctx: RuleContext): Refinement {
  if (ctx.sub !== "api") return { class: "network.call", rule: "gh-api" };
  const bundles = ctx.args.filter((arg) => arg.startsWith("--") || !arg.startsWith("-X"));
  const methodIsWrite = readMethodFlag(ctx.args, ["-X", "--method"], "-X") === "other";
  const bodied =
    hasFlag(ctx.args, GH_API_FIELD_FLAGS) ||
    hasShortFlag(bundles, ["f", "F"]) ||
    ctx.substituted ||
    ctx.args.some((arg) => arg.startsWith("$")) ||
    methodIsWrite;
  // Unchanged by APRV-268: no body and no method is a GET, and a GET reads.
  if (!bodied) return { class: "read.vcs.remote", rule: "gh-api-read" };
  // The one carve-out: a GraphQL document carrying no `mutation`, on the
  // repository gh resolves from this checkout's own remotes. Anything the
  // classifier cannot read (a document from a file, a `$VAR`, an explicit
  // `--repo`) fails closed to the class it had.
  if (
    ctx.positionals[1] === "graphql" &&
    !methodIsWrite &&
    isOwnRepoInvocation(ctx) &&
    isGraphqlQueryOnly(ctx.args)
  ) {
    return { class: REMOTE_META_CLASS, rule: "gh-api-graphql-query" };
  }
  return { class: "network.call", rule: "gh-api-write" };
}

/** Does this path invoke the compiled `approval` CLI? */
function isGateEntrypoint(path: string): boolean {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1];
  // The repository-root wrapper (`cli.js`, `./cli.js`), or the compiled entry
  // point under dist/. A `cli.js` in some other directory is just a script.
  if (last === "cli.js") {
    const dir = segments.slice(0, -1).filter((segment) => segment !== ".");
    return dir.length === 0;
  }
  if (last !== "main.js") return false;
  return segments.slice(0, -1).join("/").endsWith("dist/src/cli");
}

/**
 * The `approval` invocations that are NOT pass-through (APRV-125, APRV-214).
 *
 * Everything else this CLI does is the enforcement path itself, and gating the
 * gate with the gate deadlocks or recurses (see {@link GATE_SELF_CLASS}). `log
 * sync` and `log advance` are different in kind: they move the log FILE and
 * they drive git against a shared remote, which is a real-world effect, and the
 * policy has to be able to hold them at manual while trust builds and to relax
 * them independently later.
 *
 * `gate open` and `gate close` (APRV-214, amended SPEC.md §5.2) are different
 * in the same way and more so: opening the window SUSPENDS the policy for every
 * harness tool call under the root, which makes it the most consequential thing
 * this CLI can do. Classified `policy.core` it lands where APPROVAL.md already
 * puts the policy's own machinery, which today is `human-only`, so the hook
 * denies an agent running the ceremony with `hook-class-human-only` — the
 * classification lock, sitting behind the terminal lock and the typed word.
 * `gate status` reports and writes nothing, so it stays pass-through.
 *
 * Naming them here is also what stops the prompt lying. Performed by hand, the
 * ritual reached the approver's phone as `policy.edit` over a protected path —
 * true, and useless. Classified by name it arrives as what it is.
 *
 * `policy attest --path` (APRV-338) is the newest member and the one that reads
 * a FLAG, because the flag is what changes the act. Without it the verb attests
 * the policy file or a gate organ, which are records about the gate's own
 * configuration; with it the verb ratifies protected TEXT, and that record is
 * what resolves SPEC.md's pending-sign-off suffix. An agent able to write one
 * could ratify its own amendments, so it is classified where the rest of the
 * gate's ceremonies are: `policy.core`, which this repository's policy holds
 * human-only, so the hook denies it with `hook-class-human-only` before the
 * verb's own `actor-not-human` refusal is ever reached. It mints no new class
 * (§11.1 invariant 9): `policy.core` already exists and is already in the row's
 * `emits`.
 *
 * `positionals` is read rather than `args` for the verb words, so a flag between
 * them cannot hide the verb: `approval --json log sync` is the same invocation.
 * `args` is read only where a flag is the act, as it is above.
 */
function refineApprovalVerb(
  positionals: readonly string[],
  args: readonly string[] = [],
): Refinement | null {
  const verb = positionals[0];
  const sub = positionals[1];
  if (verb === "policy" && sub === "attest" && hasFlag(args, ["--path"])) {
    return { class: "policy.core", rule: "approval-policy-signoff" };
  }
  if (verb === "quickstart") {
    return { class: "policy.core", rule: "approval-quickstart" };
  }
  if (verb === "log") {
    if (sub === "sync") return { class: "log.sync", rule: "approval-log-sync" };
    if (sub === "advance") return { class: "log.advance", rule: "approval-log-advance" };
    // APRV-220. Signing a checkpoint is the human's own ceremony, exactly as
    // `gate open` is: the whole value of a checkpoint is that an agent process
    // cannot produce one, and an agent that could run this verb could vouch for
    // a chain it had just written. Classified `policy.core`, which the
    // reference policy holds human-only, so the hook denies it with
    // `hook-class-human-only` — the classification lock, sitting behind the
    // vault passphrase an agent's environment does not carry. It mints no new
    // class (SPEC.md §11.1 invariant 9): `policy.core` already exists and is
    // already in this row's `emits`.
    if (sub === "checkpoint") return { class: "policy.core", rule: "approval-log-checkpoint" };
    // APRV-479. Taking over the log's lock from a holder no writer can prove
    // gone is a person's assertion, recorded under their name: an agent that
    // could run it could break a live writer's lock and fork the chain. The
    // same lock as `checkpoint`, for the same reason, and no new class.
    if (sub === "unlock") return { class: "policy.core", rule: "approval-log-unlock" };
    return null;
  }
  // APRV-455. `channel relay` records gestures attributed to an EdgeOS account
  // on the word of whoever holds a secret the LAUNCHER chose. An agent that
  // could start one with a secret of its own, and post to it, would write
  // records that read as transport-authenticated evidence from a person's
  // session, which a Telegram listener cannot be made to do without the bot
  // token. So starting it is the operator's ceremony: `policy.core`, held
  // human-only by the reference policy, and the hook denies it with
  // `hook-class-human-only`. A deployment starts it from its own launcher, as
  // the store's user, outside any agent's hook. It mints no new class (SPEC.md
  // §11.1 invariant 9).
  if (verb === "channel" && sub === "relay") {
    return { class: "policy.core", rule: "approval-channel-relay" };
  }
  if (verb === "gate") {
    if (sub === "open") return { class: "policy.core", rule: "approval-gate-open" };
    if (sub === "close") return { class: "policy.core", rule: "approval-gate-close" };
    return null;
  }
  // APRV-343. `policy apply` WRITES `APPROVAL.md`, which is the one file in this
  // repository nothing but a human's own hand may change: an agent that could
  // run it could widen the policy that governs it and then attest the result
  // through the amendment the verb goes on to run. Classified where the file
  // already is (`policy.core`, human-only in the reference policy), so the hook
  // denies it with `hook-class-human-only`, behind the verb's own
  // `apply-agent-actor` refusal. It mints no new class (SPEC.md §11.1 invariant
  // 9): `policy.core` already exists and already covers the policy's machinery.
  //
  // The other `policy` subcommands stay pass-through. `check` and `test` read,
  // `attest` and `amend` refuse a non-human actor in code and collect a human's
  // tap through a channel when an agent runs them, which is the widening
  // APRV-109 deliberately made — and neither of them writes the policy file.
  if (verb === "policy" && sub === "apply") {
    return { class: "policy.core", rule: "approval-policy-apply" };
  }
  // APRV-257. `setup checkpoint` MINTS the key `log checkpoint` signs with, so
  // an agent that could run it could mint a key, store it, and vouch for a
  // chain it had just written — the mechanism defeated at its source rather
  // than at its use. Classified where the use already is (`policy.core`,
  // human-only in the reference policy), so the hook denies it with
  // `hook-class-human-only`, behind the terminal check and the `--as` gate the
  // setup family already carries. It mints no new class (SPEC.md §11.1
  // invariant 9).
  //
  // The other `setup` subcommands stay pass-through. They write `.approval/env`
  // lines and OS keystore items, which the family's terminal check already
  // reserves to a human at a machine, and none of them mints a witness.
  if (verb === "setup" && sub === "checkpoint") {
    return { class: "policy.core", rule: "approval-setup-checkpoint" };
  }
  return null;
}

/**
 * `approval …` — the gate's own CLI, minus the two verbs that move the log.
 *
 * Never returns `null`: in this table a `null` refinement means "opaque, I
 * cannot read this command" (see `refineNode`'s inline-source branch), and
 * every `approval` invocation is readable. Everything that is not one of the
 * two log verbs keeps the pass-through class and the row's own rule id.
 */
function refineApproval(ctx: RuleContext): Refinement {
  return (
    refineApprovalVerb(ctx.positionals, ctx.args) ?? { class: GATE_SELF_CLASS, rule: "approval" }
  );
}

// ---------------------------------------------------------------------------
// Skill scripts (APRV-502)
// ---------------------------------------------------------------------------

/**
 * The class an interpreter run of a skill script takes: SPEC.md §7's
 * `exec.local`, "tests, lint, build, scripts inside the workspace". No new
 * class is minted; the classifier simply had no row that emitted this one.
 */
const SKILL_SCRIPT_CLASS = "exec.local";

/** The rule id for `bun` / `python` / `python3` running a skill script. */
export const SKILL_SCRIPT_RULE = "skill-script";

/** The rule id `refineNode` returns for `node` running a skill script. */
export const NODE_SKILL_SCRIPT_RULE = "node-skill-script";

/**
 * The flags an interpreter may carry BEFORE a skill script, per binary
 * (APRV-502). An ALLOWLIST: a flag outside it, a `--flag=value`, a lone `-`
 * (stdin) or `--` means the rule does not match at all, so the command keeps
 * exactly the answer it had before this rule existed (`unclassified` for
 * `bun --cwd /etc …` and `python3 -m x`, opaque for `python3 -c`, `node -e`).
 *
 * Every flag here is inert in the sense that matters: it changes neither WHICH
 * file runs nor where code comes from. A flag that takes a value (`--cwd`,
 * `--require`, `--import`, `-W`, `-X`) is absent on purpose, because its value
 * would be a second thing the interpreter loads or a different directory the
 * script path is read from. The same flags spelled through the environment
 * (`BUN_OPTIONS`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `HOME`) are
 * refused the same way: any `NAME=value` prefix on the segment declines the
 * shape ({@link matchRule}, `RuleContext.assigned`).
 */
const SKILL_SCRIPT_FLAGS: Readonly<Record<string, readonly string[]>> = {
  bun: ["--bun", "--smol"],
  node: ["--no-warnings", "--enable-source-maps", "--experimental-strip-types"],
  python: [],
  python3: [],
};

/**
 * Python's inert single-letter flags, alone or clustered (`-I`, `-IB`, `-OO`):
 * isolated mode, unbuffered, no bytecode, ignore `PYTHON*` variables, no user
 * site, no `site` import, optimise, quiet. None of them takes a value, so a
 * cluster cannot hide one; `-c`, `-m`, `-W` and `-X` are not letters here.
 */
const PYTHON_SKILL_SCRIPT_FLAGS = /^-[IuBEsSOq]+$/u;

/**
 * One segment of a skill-script path: non-empty, not `.` or `..`, not
 * flag-shaped, and free of anything a shell could expand (`$`, backtick, a
 * glob or brace character, a home shortcut) or a platform could read as a
 * separator (`\`).
 */
function isSkillScriptSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return false;
  if (segment.startsWith("-")) return false;
  return !/[*?[\]{}$`~\\]/u.test(segment);
}

/**
 * Is `word` a skill-script path, in exactly one of the two shapes (APRV-502)?
 *
 * - Relative: `skills/<skill>/scripts/<file>`, with any number of leading
 *   `./` normalised away. Four segments, no more: `skills/x/scripts/sub/f.ts`
 *   and `.hermes/skills/x/scripts/f.ts` are not this shape.
 * - Absolute: a path ending `.hermes/skills/<skill>/scripts/<file>` or
 *   `.hermes/profiles/<p>/skills/<skill>/scripts/<file>`, the same Hermes-home
 *   grammar {@link protectedPathClass} reads (a profile home is a home of its
 *   own, one level down).
 *
 * Every segment of either shape, the absolute prefix included, must pass
 * {@link isSkillScriptSegment}: an empty segment (`skills//x`), a `.` or `..`
 * anywhere, a glob, a variable or a backtick, and the shape does not match.
 * An unexpanded `$HERMES_HOME/skills/…` or `~/.hermes/skills/…` is therefore
 * not this rule; the text cannot say where it points.
 *
 * Text only, like everything in this file. Whether the file really sits in
 * the directory it was spelled in is `src/cli/hook.ts`'s disk pass, which can
 * only tighten this answer.
 */
export function isSkillScriptPath(word: string): boolean {
  if (word.startsWith("/")) {
    const parts = word.slice(1).split("/");
    if (!parts.every(isSkillScriptSegment)) return false;
    const n = parts.length;
    const tail = (offset: number): boolean =>
      parts[n - offset] === ".hermes" && parts[n - 4] === "skills" && parts[n - 2] === "scripts";
    if (n >= 5 && tail(5)) return true;
    return n >= 7 && parts[n - 6] === "profiles" && tail(7);
  }
  let rest = word;
  while (rest.startsWith("./")) rest = rest.slice(2);
  const parts = rest.split("/");
  return (
    parts.length === 4 &&
    parts.every(isSkillScriptSegment) &&
    parts[0] === "skills" &&
    parts[2] === "scripts"
  );
}

/**
 * The skill script this interpreter argv runs, or `null` when the argv is not
 * exactly `[allowlisted flags…] <skill-script path> [arguments…]` (APRV-502).
 *
 * Words AFTER the script are the script's own arguments and are not read here:
 * `python3 skills/agent-commons/scripts/search_forum.py --q x` is the shape.
 * They are still scanned for protected and credential paths by
 * `classifySegment`, which runs after the table and can only tighten.
 */
export function skillScriptArg(bin: string, args: readonly string[]): string | null {
  const allowed = SKILL_SCRIPT_FLAGS[bin];
  if (allowed === undefined) return null;
  const python = bin === "python" || bin === "python3";
  for (const arg of args) {
    if (!arg.startsWith("-")) return isSkillScriptPath(arg) ? arg : null;
    if (allowed.includes(arg)) continue;
    if (python && PYTHON_SKILL_SCRIPT_FLAGS.test(arg)) continue;
    // Anything else: a value-taking flag, `--flag=value`, inline code (`-c`,
    // `-e`, `-m`, `-p`), a lone `-` (stdin) or `--`. Not this rule.
    return null;
  }
  return null;
}

/** `bun` / `python` / `python3` running a skill script; binds the script path. */
function refineSkillScript(ctx: RuleContext): Refinement {
  // `matchRule` only lets this row match when `skillScriptArg` found a script,
  // so the fallback is unreachable; it is spelled as the row's own answer
  // rather than as a `null`, which would be read as "opaque".
  const script = skillScriptArg(ctx.bin, ctx.args);
  return script === null
    ? { class: SKILL_SCRIPT_CLASS, rule: SKILL_SCRIPT_RULE }
    : { class: SKILL_SCRIPT_CLASS, rule: SKILL_SCRIPT_RULE, path: script };
}

// ---------------------------------------------------------------------------
// Opaque agent code (APRV-510)
// ---------------------------------------------------------------------------

/**
 * The class an opaque program takes once a policy opens it: an inline program
 * or an interpreter run of a file the gate cannot read as a skill script.
 * Under `exec.*` (SPEC.md §7) beside `exec.local`, and deliberately not under
 * it: `exec.local` is code in the workspace the runtime may name, this is code
 * whose effect nothing here reads. A record of it says the program EXISTED
 * (its hash and length), never what it did: every tool call the program then
 * makes through the harness is its own hook event, and a shell command it
 * spawns is not seen at all.
 */
export const EXEC_CODE_CLASS = "exec.code";

/** The table row that matches the `exec.code` shape. */
export const EXEC_CODE_ROW = "exec-code";

/** The rule id of an inline program (`python3 -c`, `node -e`, ...). */
export const EXEC_CODE_INLINE_RULE = "exec-code-inline";

/** The rule id of an interpreter running a file (`python3 x.py`, `bun x.ts`). */
export const EXEC_CODE_FILE_RULE = "exec-code-file";

/**
 * The inline-program flag of each interpreter the shape knows (APRV-510).
 * `deno` is absent because its inline form is a subcommand (`deno eval`).
 * `node -p` / `--print` is absent on purpose: the brief's list, kept tight.
 */
const EXEC_CODE_INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval"],
  bun: ["-e", "--eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};

/** Every binary the `exec.code` row may match. */
const EXEC_CODE_BINS: readonly string[] = [...Object.keys(EXEC_CODE_INLINE_FLAGS), "deno"];

/**
 * The interpreters whose FILE runs take `exec.code`. `node <file>` is absent:
 * the table already answers it (`node-script`, `files.write.workspace`), and a
 * name the table classifies from its arguments is not re-read here.
 */
const EXEC_CODE_FILE_BINS: ReadonlySet<string> = new Set(["python", "python3", "bun"]);

/**
 * The file a `bun` run must name to be read as a file rather than a
 * subcommand: bun prefers a subcommand over a file of the same name, so only a
 * word that cannot be one (a script extension) is taken.
 */
const BUN_SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/** Where an `exec.code` argv carries its program (an index into the args). */
export interface ExecCodeShape {
  mode: ExecCodeMode;
  /** Index into the args (the words after the binary) of the source word. */
  index: number;
}

/** A word as {@link execCodeShape} needs it: its text and whether the shell would change it. */
interface ExecShapeWord {
  exact: boolean;
  substitutions: readonly string[];
}

/**
 * The `exec.code` shape of an interpreter argv, or `null` (APRV-510).
 *
 * An ALLOWLIST, like {@link skillScriptArg}, and the same flags are inert here:
 *
 * - inline: `[inert flags…] <inline flag> <program>`, and NOTHING after the
 *   program, for every interpreter. A word after it is handed to the program
 *   (`sys.argv`, `process.argv`, `ARGV`), and a one-line loader
 *   (`python3 -c 'import sys; exec(sys.argv[1])' '<real program>'`) would put
 *   the real program there, outside the hash and inside the argv the payload
 *   carries verbatim (security review of APRV-510, finding 3a). `deno` is
 *   exactly `deno eval <program>`;
 * - file (python, python3 and bun only): `[inert flags…] <path> [args…]`,
 *   where the path is not a skill script (those are `exec.local`, APRV-502)
 *   and, for `bun`, carries a script extension.
 *
 * Anything else is not the shape: a value-taking flag, `--flag=value`, `-m`,
 * a lone `-` (stdin), an inline flag with no program, two programs, a cluster
 * hiding the inline flag (`-Ic`), and, when `words` is given, a source word the
 * shell would still change (`LexWord.exact`) or one built from a substitution:
 * the hash binds the program's bytes, so the word must BE them.
 */
export function execCodeShape(
  bin: string,
  args: readonly string[],
  words: readonly ExecShapeWord[] | null = null,
): ExecCodeShape | null {
  const exactAt = (index: number): boolean => {
    if (words === null) return true;
    const word = words[index];
    return word !== undefined && word.exact && word.substitutions.length === 0;
  };
  if (bin === "deno") {
    if (args.length !== 2 || args[0] !== "eval") return null;
    return exactAt(1) ? { mode: "inline", index: 1 } : null;
  }
  const inline = EXEC_CODE_INLINE_FLAGS[bin];
  if (inline === undefined) return null;
  const python = bin === "python" || bin === "python3";
  const inert = SKILL_SCRIPT_FLAGS[bin] ?? [];
  for (const [position, arg] of args.entries()) {
    if (inline.includes(arg)) {
      const index = position + 1;
      if (index !== args.length - 1) return null;
      return exactAt(index) ? { mode: "inline", index } : null;
    }
    if (!arg.startsWith("-")) {
      if (!EXEC_CODE_FILE_BINS.has(bin)) return null;
      if (isSkillScriptPath(arg)) return null;
      // Refuter N5: a device or process path is a descriptor, not a program
      // file (`/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`).
      if (arg.startsWith("/dev/") || arg.startsWith("/proc/")) return null;
      if (bin === "bun" && !BUN_SCRIPT_FILE.test(arg)) return null;
      return exactAt(position) ? { mode: "file", index: position } : null;
    }
    if (inert.includes(arg)) continue;
    if (python && PYTHON_SKILL_SCRIPT_FLAGS.test(arg)) continue;
    return null;
  }
  return null;
}

/**
 * Is `bin` an interpreter spelling the `exec.code` row accepts? A bare name
 * (found on the PATH the harness's shell started with: a segment earlier in
 * the same command that can change name resolution closes the class for the
 * rest of the line, see {@link movesNameResolution}), or an absolute path in
 * one of the `bin` directories of {@link SYSTEM_BIN_DIRS}: `/bin`, `/usr/bin`
 * and `/usr/local/bin` (security review of APRV-510, finding 1).
 *
 * One list for the whole classifier (refuter N6, the reconcile with APRV-508):
 * a shape row's binary and an interpreter are spelled from the same system
 * directories, read by the same {@link isSystemBinWord} (`..` and `//`
 * refused). The interpreter reads the stricter part of it: the `sbin`
 * directories hold administrative tools, never an interpreter, and
 * `/opt/homebrew/bin` (admitted before the reconcile) is in neither. It is a
 * rule about SPELLING rather than about who can write there:
 * `/usr/local/bin` is often owned by the user on macOS (refuter N3), and a
 * bare `python3` resolves through it anyway. What the rule refuses is a
 * spelling the agent chooses outright (`/home/hermes/x/bin/python3`, a venv,
 * the workspace, a Homebrew path). Anything else, a relative path
 * (`./python3`, `.venv/bin/python`) included, keeps today's answer.
 */
function isExecCodeInterpreter(bin: string): boolean {
  if (!bin.includes("/")) return true;
  const cut = bin.lastIndexOf("/");
  if (cut >= bin.length - 1 || !isSystemBinWord(bin)) return false;
  return !bin.slice(0, cut + 1).endsWith("/sbin/");
}

/**
 * The builtins that can change which program a bare name runs: `PATH` (`export`,
 * `declare`, `set`), a function or alias of that name, the hash table.
 */
const NAME_RESOLUTION_BUILTINS: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
  "set",
  "unset",
  "alias",
  "unalias",
  "hash",
  "enable",
  "builtin",
  "command",
  "function",
  // Refuter S4: builtins that WRITE a shell variable (PATH among them).
  "read",
  "readarray",
  "mapfile",
  "getopts",
  "let",
]);

/**
 * Can this segment change what a LATER bare interpreter name resolves to?
 * (Security review of APRV-510, finding 1.) A bare assignment (`PATH=/tmp/x`,
 * which reaches the lookup when `PATH` is exported, as it always is) or one of
 * {@link NAME_RESOLUTION_BUILTINS}. Text only, and deliberately broad: a
 * segment this answers `true` for only closes `exec.code` for the rest of the
 * command line, which leaves those segments their pre-APRV-510 answer.
 */
function movesNameResolution(segment: LexSegment): boolean {
  const words = segment.words.map((word) => word.text);
  let cursor = 0;
  while (cursor < words.length && ASSIGNMENT.test(words[cursor] as string)) cursor += 1;
  const bin = words[cursor];
  if (bin === undefined) return cursor > 0;
  const base = pathSegments(bin).slice(-1)[0] ?? bin;
  // Refuter S4: `printf -v PATH …` assigns a variable, and the `printf` row
  // reads it as `read.shell`.
  if (base === "printf" && words.slice(cursor + 1).some((word) => word.startsWith("-v"))) {
    return true;
  }
  return NAME_RESOLUTION_BUILTINS.has(base);
}

/** The `exec.code` row's answer: inline or file, with the file bound as the path. */
function refineExecCode(ctx: RuleContext): Refinement {
  const shape = execCodeShape(ctx.bin, ctx.args);
  if (shape === null || shape.mode === "inline") {
    // `matchRule` lets this row match only the shape, so `null` is unreachable;
    // it is answered as the row's own class rather than as a `null` refinement,
    // which this table reads as "opaque".
    return { class: EXEC_CODE_CLASS, rule: EXEC_CODE_INLINE_RULE };
  }
  return { class: EXEC_CODE_CLASS, rule: EXEC_CODE_FILE_RULE, path: ctx.args[shape.index] as string };
}

/**
 * `node` — an inline script is opaque, the gate's own entry point is
 * pass-through, a skill script is `exec.local` (APRV-502), and anything else
 * is a workspace script.
 */
function refineNode(ctx: RuleContext): Refinement | null {
  if (hasFlag(ctx.args, ["-e", "--eval", "-p", "--print"])) return null;
  const script = ctx.positionals[0];
  if (script !== undefined && isGateEntrypoint(script)) {
    // `node cli.js log sync` is `approval log sync` spelled the long way, and
    // it must classify identically or the classification is a spelling test.
    return (
      refineApprovalVerb(ctx.positionals.slice(1), ctx.args) ?? {
        class: GATE_SELF_CLASS,
        rule: "node-approval-cli",
      }
    );
  }
  // APRV-502. A substituted word is a hole in the text, and an assignment
  // prefix (`NODE_OPTIONS='--require …'`) is a flag spelled through the
  // environment, so either declines the skill-script reading and the segment
  // keeps the answer it had before.
  const skill = ctx.substituted || ctx.assigned ? null : skillScriptArg("node", ctx.args);
  if (skill !== null) {
    return { class: SKILL_SCRIPT_CLASS, rule: NODE_SKILL_SCRIPT_RULE, path: skill };
  }
  return { class: "files.write.workspace", rule: "node-script" };
}

/**
 * The table.
 *
 * Order matters: the first row whose binary and subcommand match decides. Rows
 * are grouped by binary, strictest interpretation first within a binary, and
 * every class named here is one SPEC.md §7 declares (§7's developer-workstation
 * namespaces, plus `read.shell` / `read.vcs.remote` / `read.web` under
 * `read.*`), with one addition: the `log.*` namespace of the two verbs that
 * move the log file, introduced by SPEC §10.1's APRV-125 amendment.
 */
export const COMMAND_RULES: readonly CommandRule[] = [
  // -- git -----------------------------------------------------------------
  {
    id: "git-push",
    bins: ["git"],
    subs: ["push"],
    class: "vcs.push.main",
    emits: ["vcs.push.branch", "vcs.push.main", "vcs.history.rewrite", "vcs.ref.delete"],
    refine: refineGitPush,
  },
  {
    id: "git-rewrite",
    bins: ["git"],
    subs: ["rebase", "filter-branch", "filter-repo"],
    class: "vcs.history.rewrite",
  },
  { id: "git-reset", bins: ["git"], subs: ["reset"], class: "vcs.commit.branch", emits: ["vcs.history.rewrite"], refine: refineGitReset },
  { id: "git-commit", bins: ["git"], subs: ["commit"], class: "vcs.commit.branch", emits: ["vcs.history.rewrite"], refine: refineGitCommit },
  { id: "git-branch", bins: ["git"], subs: ["branch"], class: "read.shell", emits: ["vcs.commit.branch"], refine: refineGitBranch },
  // APRV-397 split the verb: the listing flags read, everything else publishes.
  // See {@link refineGitTag} for why the split is an allowlist.
  {
    id: "git-tag",
    bins: ["git"],
    subs: ["tag"],
    class: "release.publish",
    emits: ["read.shell"],
    refine: refineGitTag,
  },
  { id: "git-clone", bins: ["git"], subs: ["clone"], class: "network.call" },
  {
    id: "git-write",
    bins: ["git"],
    subs: [
      "add",
      "apply",
      "checkout",
      "cherry-pick",
      "merge",
      "mv",
      "pull",
      "restore",
      "revert",
      "rm",
      "stash",
      "switch",
      "worktree",
    ],
    class: "vcs.commit.branch",
  },
  {
    id: "git-remote-read",
    bins: ["git"],
    subs: ["fetch", "ls-remote", "remote"],
    class: "read.vcs.remote",
    // APRV-518: `git remote` reads only in the forms {@link refineGitRemote}
    // names; every other `git remote` writes the configuration a later push
    // reads.
    emits: ["vcs.history.rewrite"],
    refine: refineGitRemote,
  },
  {
    id: "git-read",
    bins: ["git"],
    subs: [
      "blame",
      "describe",
      "diff",
      "grep",
      "log",
      "ls-files",
      "reflog",
      "rev-list",
      "rev-parse",
      "shortlog",
      "show",
      "status",
    ],
    class: "read.shell",
  },

  // -- gh ------------------------------------------------------------------
  { id: "gh-release", bins: ["gh"], subs: ["release"], class: "release.publish" },
  {
    id: "gh-api",
    bins: ["gh"],
    subs: ["api", "auth", "gist", "secret", "workflow"],
    class: "network.call",
    emits: ["read.vcs.remote", REMOTE_META_CLASS],
    refine: refineGhApi,
  },
  {
    id: "gh-simple-read",
    bins: ["gh"],
    subs: ["browse", "search", "status"],
    class: "read.vcs.remote",
  },
  // `gh pr`, `gh issue`, `gh repo` and `gh run` split on their own second word;
  // the split is a refinement because the table matches one subcommand deep.
  {
    id: "gh",
    bins: ["gh"],
    subs: ["pr", "issue", "repo", "run", "cache"],
    class: "network.call",
    emits: [
      "read.vcs.remote",
      "network.call",
      REMOTE_META_CLASS,
      "vcs.pr.open",
      "vcs.pr.update",
      "vcs.push.main",
      "vcs.commit.branch",
    ],
    refine: refineGh,
  },

  // -- package managers ----------------------------------------------------
  // APRV-397. The probe row matches ONLY an argv that is nothing but version or
  // help flags, which is what `probe` means and what keeps `npm doctor`,
  // `npm cache clean` and every other subcommand this table does not name at the
  // `unclassified` deny they have today. `npm version` is a different word and
  // keeps its `release.publish` row below.
  { id: "npm-version", bins: ["npm", "pnpm", "yarn", "bun"], class: "read.shell", probe: true },
  { id: "npm-publish", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["publish", "version", "deprecate", "dist-tag", "unpublish"], class: "release.publish" },
  // APRV-397: the two package-manager verbs that write into a directory they
  // name rather than touching the registry or the lockfile.
  {
    id: "npm-pack",
    bins: ["npm", "pnpm", "yarn", "bun"],
    subs: ["pack"],
    class: "files.write.workspace",
    emits: [OUT_OF_SCOPE_WRITE_CLASS, "network.call"],
    refine: refineNpmPack,
  },
  {
    id: "npm-init",
    bins: ["npm", "pnpm", "yarn", "bun"],
    subs: ["init"],
    class: "files.write.workspace",
    refine: refineNpmInit,
  },
  { id: "npm-install", bins: ["npm", "bun"], subs: ["install", "i", "add"], class: "deps.add", emits: ["deps.install"], refine: refineNpmInstall },
  { id: "yarn-add", bins: ["yarn", "pnpm"], subs: ["add"], class: "deps.add" },
  { id: "yarn-install", bins: ["yarn", "pnpm"], subs: ["install"], class: "deps.install" },
  { id: "npm-ci", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["ci"], class: "deps.install" },
  { id: "npm-update", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["update", "upgrade", "up"], class: "deps.upgrade" },
  { id: "npm-remove", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["uninstall", "remove", "rm", "un"], class: "deps.remove" },
  { id: "npm-link", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["link"], class: "deps.add" },
  { id: "npm-network", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["audit", "outdated", "view", "search", "info", "login", "whoami"], class: "network.call" },
  { id: "npm-list", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["ls", "list", "config", "help"], class: "read.shell" },
  { id: "npm-script", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["run", "run-script", "test", "start", "build", "lint", "exec"], class: "files.write.workspace" },

  // -- harness self-update (APRV-228) --------------------------------------
  // The coding-agent harnesses' own `update` verbs, and the unattended updater
  // that drives them. A harness upgrade swaps the binary that HOSTS this hook,
  // which SPEC.md §7 already calls a supply-chain decision (`deps.*`), and
  // before these rows it fell to `unclassified`: denied, but denied as "no
  // rule", which told the approver nothing and gave a human no class to grant
  // through the ordinary manual path. `npm install -g <harness>` was `deps.add`
  // all along and keeps that class; these rows name the spellings that bypass
  // the package manager.
  //
  // Both resolve to an EXISTING class and mint no authority for a human-only
  // one (SPEC.md §11.1 invariant 9): `deps.upgrade` is manual under the
  // reference policy, so the refusal now says what it is.
  //
  // `claude update` matches on its subcommand, so `claude --version`,
  // `claude -p …` and a bare `claude` stay unclassified: they are not upgrades,
  // and this row must not become the rule that lets an agent launch a nested
  // harness unattended. `uca` matches with ANY arguments, `--dry-run` included:
  // the classifier reads text, cannot know which flags the script honours, and
  // the strictest reading of an updater is that it updates.
  //
  // APRV-354 answers the other half of that sentence: the launch rows below now
  // name what a bare `claude` or `codex …` is. This row stays ABOVE them on
  // purpose, so `codex update` and `claude update` keep `deps.upgrade` — an
  // upgrade swaps the binary that hosts the hook, which is the stricter of the
  // two readings and the class they already had.
  { id: "harness-update", bins: ["claude", "codex", "gemini"], subs: ["update"], class: "deps.upgrade" },
  { id: "harness-updater", bins: ["uca"], class: "deps.upgrade" },

  // -- agent harness launch (APRV-354) --------------------------------------
  // Generated from {@link HARNESS_BINS}, one row per binary, all sharing
  // {@link refineHarness}. Below `harness-update` so an upgrade keeps its
  // class; above the workspace tools so a package-runner spelling is the only
  // one that has to be refined rather than matched.
  ...HARNESS_RULES,

  // -- workspace tools -----------------------------------------------------
  // APRV-510. Opaque agent code, matched ONLY when the caller opened the class
  // and the argv is exactly the shape ({@link execCodeShape}). Above `node`, so
  // `node -e` reaches it before `refineNode` answers opaque; below every `bun`
  // row of the package-manager group, so a `bun` argv the table already
  // classifies keeps its class. With the class closed the row never matches,
  // and every argv keeps the answer it had before the row existed.
  {
    id: EXEC_CODE_ROW,
    bins: EXEC_CODE_BINS,
    class: EXEC_CODE_CLASS,
    execCode: true,
    refine: refineExecCode,
  },
  // APRV-193: three of the rules below hand control to code the runtime did not
  // author, and they are named in {@link CODE_EXECUTING_RULES}.
  {
    id: "node",
    bins: ["node"],
    class: "files.write.workspace",
    emits: [GATE_SELF_CLASS, "log.sync", "log.advance", "policy.core", SKILL_SCRIPT_CLASS],
    refine: refineNode,
  },
  // APRV-502. An interpreter running a skill script, `exec.local`. Below every
  // `bun` row of the package-manager group, so `bun run x`, `bun install` and
  // `bun --version` keep their classes; `skillScript` makes the row match ONLY
  // the exact shape, so every other `bun`, `python` or `python3` argv keeps the
  // answer it had before the row existed. `node` reaches the same answer
  // inside {@link refineNode}, because its row has no `subs` to sit beside.
  // Named in {@link CODE_EXECUTING_RULES}: a skill script is code the runtime
  // did not author.
  {
    id: SKILL_SCRIPT_RULE,
    bins: ["bun", "python", "python3"],
    class: SKILL_SCRIPT_CLASS,
    skillScript: true,
    refine: refineSkillScript,
  },
  {
    id: "approval",
    bins: ["approval"],
    class: GATE_SELF_CLASS,
    emits: ["log.sync", "log.advance", "policy.core"],
    refine: refineApproval,
  },
  {
    id: "workspace-tool",
    bins: ["npx", "tsx", "ts-node", "tsc", "oxlint", "eslint", "prettier", "vitest", "jest", "backlog", "make"],
    class: "files.write.workspace",
    // APRV-354: only `npx` naming a harness package changes; see
    // {@link refineWorkspaceTool}, which returns this row's own answer for
    // every other binary and every other package.
    emits: [
      HARNESS_PROBE_CLASS,
      ...Object.values(HARNESS_PACKAGES).map((name) => `${HARNESS_LAUNCH_PREFIX}${name}`),
    ],
    refine: refineWorkspaceTool,
  },
  {
    id: "workspace-write",
    bins: ["mkdir", "cp", "mv", "touch", "tee", "ln", "chmod", "truncate", "rmdir"],
    class: "files.write.workspace",
  },
  {
    id: "rm",
    bins: ["rm"],
    class: "files.write.workspace",
    emits: ["files.delete.out_of_scope", SCRATCH_DELETE_CLASS],
    refine: refineRm,
  },
  { id: "sed", bins: ["sed"], class: "read.shell", emits: ["files.write.workspace"], refine: refineSed },
  // APRV-283. Its own row rather than a seat in the read table: `find` is the
  // one reader with primaries that delete, write and run other commands.
  {
    id: "find",
    bins: ["find"],
    class: "read.shell",
    emits: ["files.delete.out_of_scope", "files.write.workspace"],
    refine: refineFind,
  },

  // -- packaging and archives (APRV-397) -----------------------------------
  // Four binaries a release verification cannot do without, each of which either
  // reads what it names or writes into a destination it names. The section
  // comment above {@link OUT_OF_SCOPE_WRITE_CLASS} holds the reasoning; these
  // rows only say which binary reaches which refinement.
  {
    id: "tar",
    bins: ["tar"],
    class: "files.write.workspace",
    emits: ["read.shell", OUT_OF_SCOPE_WRITE_CLASS],
    refine: refineTar,
  },
  {
    id: "gunzip",
    bins: ["gunzip"],
    class: "files.write.workspace",
    emits: ["read.shell", OUT_OF_SCOPE_WRITE_CLASS],
    refine: refineGunzip,
  },
  {
    id: "base64",
    bins: ["base64"],
    class: "read.shell",
    emits: ["files.write.workspace", OUT_OF_SCOPE_WRITE_CLASS],
    refine: refineBase64,
  },
  {
    id: "openssl-digest",
    bins: ["openssl"],
    subs: OPENSSL_DIGEST_SUBS,
    class: "read.shell",
    emits: ["files.write.workspace", OUT_OF_SCOPE_WRITE_CLASS],
    refine: refineOpensslDigest,
  },

  // -- network -------------------------------------------------------------
  // The HTTP clients split on their flags; the transports do not. What `ssh`,
  // `rsync` or `nc` will do at the far end is not written in the argv, so there
  // is no read-shaped invocation to carve out and they stay manual.
  {
    id: "web-fetch",
    bins: ["curl", "wget", "http", "httpie"],
    class: "network.call",
    emits: ["read.web"],
    refine: refineWebFetch,
  },
  {
    id: "network",
    bins: ["ssh", "scp", "sftp", "rsync", "nc", "telnet", "ftp"],
    class: "network.call",
  },

  // -- credentials (APRV-194) ----------------------------------------------
  // The keychain readers. Every subcommand of these binaries exists to move
  // credential material, so the row does not split on one: `security` is
  // macOS's keychain, `secret-tool` the libsecret CLI, `keyring` the Python
  // one, `pass` the unix password store.
  {
    id: "keychain",
    bins: ["security", "secret-tool", "keyring", "pass"],
    class: CREDENTIAL_CLASS,
  },
  {
    id: "printenv",
    bins: ["printenv"],
    class: CREDENTIAL_CLASS,
    emits: ["read.shell"],
    refine: refinePrintenv,
  },

  // -- reads ---------------------------------------------------------------
  // APRV-508. `date` prints the time or sets the clock, with one binary and
  // overlapping flags, so it is a shape row rather than a seat in the read
  // table: only the display forms {@link isDateDisplay} reads match, and every
  // setting form (`-s`, `--set`, a bare `MMDDhhmm` operand), every file-reading
  // form (`-f`, `-r`) and everything else keeps the `unclassified` refusal it
  // had. The only assignments the row admits are the zone and the locale, with
  // values that cannot name a file (`TZ=Asia/Kolkata date`).
  {
    id: "date-read",
    bins: ["date"],
    class: "read.shell",
    shape: isDateDisplay,
  },
  // APRV-508. The system-information readers, each a strict allow-grammar in
  // `sysinfo-argv.ts`: `hostname NAME` sets the host name, `free -s` loops,
  // `uptime FILE` reads a utmp file, so none of them is a plain seat in the
  // read table. No assignment rides in front of any of them.
  {
    id: "sysinfo-read",
    bins: ["uptime", "whoami"],
    class: "read.shell",
    shape: (args, assignments) => assignments.length === 0 && isBareInfo(args),
  },
  {
    id: "hostname-read",
    bins: ["hostname"],
    class: "read.shell",
    shape: (args, assignments) => assignments.length === 0 && isHostnameDisplay(args),
  },
  {
    id: "df-read",
    bins: ["df"],
    class: "read.shell",
    shape: (args, assignments) => assignments.length === 0 && isDfDisplay(args),
  },
  {
    id: "free-read",
    bins: ["free"],
    class: "read.shell",
    shape: (args, assignments) => assignments.length === 0 && isFreeDisplay(args),
  },
  {
    id: "seq-read",
    bins: ["seq"],
    class: "read.shell",
    shape: (args, assignments) => assignments.length === 0 && isSeqDisplay(args),
  },
  // `paste` reads the files it names, and the read scope takes them exactly as
  // it takes `cat`'s (`paste: "all"` in read-scope.ts).
  {
    id: "paste-read",
    bins: ["paste"],
    class: "read.shell",
    shape: (args, assignments) => assignments.length === 0 && isPasteRead(args),
  },
  {
    id: "read-shell",
    bins: [
      // APRV-508: `[` is `test` under its other name; the closing `]` is an
      // argument. Both read nothing but their operands and the file modes.
      "[",
      "basename",
      "cat",
      "cd",
      "cksum",
      "cut",
      "diff",
      "dirname",
      "du",
      "echo",
      "false",
      "file",
      "grep",
      "head",
      "jq",
      "ls",
      "md5sum",
      "printf",
      "pwd",
      "readlink",
      "realpath",
      "rg",
      "shasum",
      "sha256sum",
      "sort",
      "stat",
      "tail",
      "test",
      "tr",
      "tree",
      "true",
      "type",
      "uniq",
      "wc",
      "which",
    ],
    class: "read.shell",
  },
];

/** `gh pr view` reads; `gh pr create` reaches the network on the repo's behalf. */
const GH_READ_ACTIONS: readonly string[] = [
  "view",
  "list",
  "status",
  "checks",
  "diff",
  "watch",
  "download",
];

/**
 * `gh pr` writes get their own classes (APRV-83). Opening or updating a pull
 * request is the routine partner of pushing a feature branch, and a policy
 * that wants to treat it as such needs a class narrower than `network.call`.
 * Merging is a write to main whatever the transport, so it shares
 * `vcs.push.main`; `checkout` only touches the local clone.
 */
const GH_PR_UPDATE_ACTIONS: readonly string[] = [
  "edit",
  "comment",
  "review",
  "ready",
  "close",
  "reopen",
  "lock",
  "unlock",
];

function refineGh(ctx: RuleContext): Refinement {
  const noun = ctx.positionals[0];
  const action = ctx.positionals[1];
  // APRV-268: the two listed noun/action pairs (`pr update-branch`, `run
  // rerun`), on the repository gh would resolve from this checkout's own
  // remotes. Neither is a read, so this sits above the read branch only for
  // symmetry with the rest of the refinement; everything else on these nouns,
  // reads included, falls through unchanged.
  if (
    noun !== undefined &&
    action !== undefined &&
    (GH_META_ACTIONS[noun] ?? []).includes(action) &&
    isOwnRepoInvocation(ctx)
  ) {
    return { class: REMOTE_META_CLASS, rule: "gh-remote-meta" };
  }
  if (action !== undefined && GH_READ_ACTIONS.includes(action)) {
    return { class: "read.vcs.remote", rule: "gh-read" };
  }
  if (noun === "pr" && action !== undefined) {
    if (action === "create") return { class: "vcs.pr.open", rule: "gh-pr-open" };
    if (GH_PR_UPDATE_ACTIONS.includes(action)) return { class: "vcs.pr.update", rule: "gh-pr-update" };
    if (action === "merge") return { class: "vcs.push.main", rule: "gh-pr-merge" };
    if (action === "checkout") return { class: "vcs.commit.branch", rule: "gh-pr-checkout" };
  }
  return { class: "network.call", rule: "gh-write" };
}

/**
 * Binaries whose effect lives in a string this classifier will not interpret.
 *
 * A second parser for the same text is a second answer waiting to disagree with
 * the shell's, so these refuse instead. `eval`, `xargs` and the `-e`
 * interpreters can express anything at all; `sudo` and `env` re-launch
 * something else with different authority.
 *
 * ONE NARROW EXCEPTION since APRV-380, and it is a narrowing of this rule
 * rather than a hole in it: a segment that is EXACTLY a known shell, one
 * inline-script flag and one script word is classified by the script, through
 * this same classifier. No second parser is written and the text is not read a
 * second way. {@link loginShellScript} states the shape and the reasoning, and
 * everything outside it — including the same shell with a script file, or a
 * shell nested inside an unwrapped script — is refused here exactly as before.
 */
const OPAQUE_BINS: Readonly<Record<string, string>> = {
  bash: "runs a shell script",
  sh: "runs a shell script",
  zsh: "runs a shell script",
  dash: "runs a shell script",
  ksh: "runs a shell script",
  fish: "runs a shell script",
  eval: "evaluates a constructed command",
  source: "runs another file in this shell",
  ".": "runs another file in this shell",
  exec: "replaces this shell with another command",
  sudo: "runs a command with different authority",
  doas: "runs a command with different authority",
  env: "runs a command with a modified environment",
  nohup: "detaches a command from this shell",
  xargs: "runs a command built from its input",
  watch: "re-runs a command on a timer",
  timeout: "runs another command under a timer",
  time: "runs another command under a timer",
};

/**
 * The shells {@link loginShellScript} will unwrap: the six in
 * {@link OPAQUE_BINS} that run a script.
 *
 * The other opaque binaries stay opaque under every shape. `eval`, `xargs` and
 * the `-e` interpreters build their text from somewhere this file cannot see;
 * `sudo`, `doas`, `env`, `nohup`, `exec`, `source`, `.`, `watch`, `timeout` and
 * `time` re-launch something else, with different authority or under a timer,
 * and what they re-launch is an argv rather than a script.
 */
const UNWRAPPABLE_SHELLS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
]);

/**
 * The inline-script flags a wrapper may carry: `-c`, with any run of `l` and
 * `i` before it (APRV-380).
 *
 * `-lc` is the shape the 2026-09-18 probe recorded on every Codex exec request.
 * `c` must be LAST, because that is the letter that takes the next word as its
 * argument, and a combination where it is not last is one whose reading depends
 * on the shell's own option parser. That is a shape this rule declines to guess
 * at, so it stays opaque.
 */
const INLINE_SCRIPT_FLAG = /^-[li]*c$/u;

/**
 * The script a LOGIN-SHELL WRAPPER runs, when the segment is exactly one
 * (APRV-380), or `null`.
 *
 * ## Why this is not the second parser the table above refuses
 *
 * {@link OPAQUE_BINS} states the position this narrows: a second parser for the
 * same text is a second answer waiting to disagree with the shell's. The hazard
 * that names is reading shell text a SECOND WAY. This is not that. When the
 * argv is exactly `[shell, -lc, script]` and nothing else, the script is the
 * text a Claude Code `Bash` call hands this classifier directly, and what
 * happens to it here is what happens to that: the same lexer, the same segment
 * rules, the same table. No new parser is written, and the text is not read a
 * second way — it is read the first way, by the only reader there is.
 *
 * ## The line, and it is exact
 *
 * Three words, no more: a known shell, one inline-script flag, one script. Any
 * of these keeps the wrapper opaque, because each is a shape whose effect
 * depends on something the argv alone does not say:
 *
 * - extra words (a script FILE, `--`, an option this rule does not model);
 * - an assignment prefix, which changes the environment the script runs in;
 * - a redirection on the wrapper, which is the outer shell's and not the
 *   script's;
 * - a substitution in any of the three words, whose effect happens before the
 *   shell even starts;
 * - a nested shell inside the script, refused by {@link ClassifierContext} when
 *   the recursion runs (the inner classification unwraps nothing);
 * - a shell word that is not the system's binary ({@link isSystemBinWord}): a
 *   relative path, or an absolute one outside the system-bin directories, is
 *   whatever program sits there, which its last path segment does not name
 *   (APRV-523 fix round, review-b S1);
 * - a shell word that is assignment-shaped, in its source spelling
 *   ({@link LexWord.assignment}) or its dequoted text ({@link ASSIGNMENT}).
 *   bash runs a word whose name is quoted or escaped as a program named by the
 *   whole word, and {@link classifySegment} refuses that segment; unwrapping
 *   it here would answer before that check runs.
 *
 * The BINDING does not move. `cli/hook.ts` binds the outer command and argv
 * exactly as APRV-362 built them; what this changes is only which text is
 * classified, and the classes are additional evidence about bytes that are
 * bound elsewhere and unchanged.
 */
export function loginShellScript(segment: LexSegment): string | null {
  if (segment.opaque !== null) return null;
  if (segment.redirects.length > 0) return null;
  if (segment.words.length !== 3) return null;
  const [shell, flag, script] = segment.words as [LexWord, LexWord, LexWord];
  if (shell.substitutions.length > 0) return null;
  if (flag.substitutions.length > 0) return null;
  if (script.substitutions.length > 0) return null;
  // APRV-523 fix round (review-b S1): only the system's shell, named as
  // written. A bare name and a system-bin path keep the route.
  if (shell.assignment || ASSIGNMENT.test(shell.text)) return null;
  if (!isSystemBinWord(shell.text, shell.exact)) return null;
  const base = pathSegments(shell.text).slice(-1)[0] ?? shell.text;
  if (!UNWRAPPABLE_SHELLS.has(base)) return null;
  if (!INLINE_SCRIPT_FLAG.test(flag.text)) return null;
  // An empty script runs nothing, and `classifyCommand` answers `unclassified`
  // for an empty command. Leaving it wrapped keeps that answer the wrapper's.
  return script.text.trim().length === 0 ? null : script.text;
}

/** Interpreters that are opaque only when handed inline source. */
const INLINE_SOURCE_BINS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  deno: ["eval"],
};

// ===========================================================================
// Classification
// ===========================================================================

/**
 * `VAR=value` prefixes, which are not the command: every spelling of bash's
 * assignment word (APRV-521, review-b M1). A name, an optional `[subscript]`,
 * then `=` or the append operator `+=`: `NAME=v`, `NAME+=v`, `NAME[i]=v`,
 * `NAME[i]+=v`. bash puts each one in the environment of the command it
 * precedes, so a cursor that stopped at `NAME+=v` took that word for the
 * program and judged the real one as its argument. The compound form
 * `NAME=(…)` never reaches here: the tokenizer refuses it ({@link lex}).
 *
 * bash applies this grammar to the word as written (APRV-523). Applied to the
 * source spelling ({@link LexWord.assignment}) it is bash's rule: a quote, a
 * backslash, a `$`, a backtick or a brace in the name is none of
 * `[A-Za-z0-9_]`, so such a word is a command word. Applied to a word's
 * dequoted `text` it says only that the word is assignment-SHAPED, which is
 * what the deliberately broad line scans read ({@link gitEnvironmentWrite},
 * {@link movesNameResolution}): they count both readings and only refuse more.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;

/**
 * The one spelling a rule may read past: a bare name and `=`. An append keeps
 * whatever value the name already had, so its text does not say what the
 * command will see, and a subscript writes an array element. Either one in
 * front of a command leaves the segment `unclassified`.
 */
const PLAIN_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * A command word that opens like an assignment with a subscript (`NAME[`) but
 * is not one {@link ASSIGNMENT} reads. bash reads the subscript as a bracketed
 * pair in command position, spaces and operators included, so a word this
 * tokenizer split there may still be one assignment to bash, ahead of the
 * real program. No program is named like this, so it is refused, not guessed.
 */
const ASSIGNMENT_LIKE = /^[A-Za-z_][A-Za-z0-9_]*\[/u;

/**
 * The variable an assignment word sets: the name in front of `=`, of the
 * append operator `+=`, or of a `[subscript]`. `GIT_PAGER+=x` sets GIT_PAGER
 * and `PATH[0]=x` sets PATH. A word with no `=` is returned without its
 * subscript and `+`.
 */
function assignedName(word: string): string {
  const equals = word.indexOf("=");
  const head = equals === -1 ? word : word.slice(0, equals);
  return head.replace(/\[.*$/su, "").replace(/\+$/u, "");
}

/** The assignment word's spelling up to its value (`NAME=`, `NAME+=`, `NAME[i]=`), for a refusal detail. */
function assignmentHead(word: string): string {
  return ASSIGNMENT.exec(word)?.[0] ?? `${assignedName(word)}=`;
}

/**
 * Redirection targets that create no file (APRV-283).
 *
 * `> file` is a write because it creates or truncates one. `2>/dev/null` does
 * neither: the kernel's bit bucket has no contents to lose and no directory
 * entry to make. The same is true of the standard streams by path
 * (`/dev/stdout`, `/dev/stderr`), of the controlling terminal, and of
 * `/dev/fd/<n>`, which names a descriptor this process already holds.
 *
 * The set is EXACT and closed. Anything else under `/dev` classifies as a write,
 * because a device node this list does not know is a device node this file
 * cannot vouch for, and the strict reading of a redirection is that it writes.
 */
const DISCARD_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

/** `/dev/fd/3`, and nothing that merely starts with it. */
const DEV_FD = /^\/dev\/fd\/\d+$/u;

/** Does redirecting onto `target` create nothing? (APRV-283.) */
function isDiscardTarget(target: string): boolean {
  return DISCARD_TARGETS.has(target) || DEV_FD.test(target);
}

/**
 * Strictest-first, and the order is normative (APRV-198): a segment naming
 * more than one protected path is answered by the most consequential of them.
 */
const PROTECTED_PRECEDENCE: readonly ProtectedPathClass[] = [
  "log.mutate",
  "policy.core",
  "policy.edit",
];

/**
 * Where a surface sits in {@link PROTECTED_PRECEDENCE}.
 *
 * A `policy.edit` sub-class (APRV-266) ranks exactly where `policy.edit` ranks,
 * and that is not a shortcut: routing re-labels the `policy.edit` tier and can
 * reach no other, so a routed class IS a `policy.edit` surface wearing the name
 * its policy gave it. Ranking it by the autonomy the policy declares for it was
 * the alternative and is rejected — this function is the pure classifier, it
 * has no policy to resolve against, and a precedence that moved with a rate
 * would make the class a command takes depend on a number an author was tuning.
 */
function protectedRank(surface: string): number {
  const index = PROTECTED_PRECEDENCE.indexOf(surface as ProtectedPathClass);
  return index === -1 ? PROTECTED_PRECEDENCE.indexOf("policy.edit") : index;
}

/**
 * Does this protected surface outrank `account.credential`? (APRV-503.)
 *
 * Where the credential class sits in {@link PROTECTED_PRECEDENCE}: below
 * `log.mutate` and `policy.core`, above `policy.edit` and its routed
 * sub-classes. `log.mutate` is the one class the open window refuses with no
 * policy consulted, and `policy.core` is an edit of the gate's own organs; a
 * credential READ named by a redirection must never displace either of them,
 * under any policy's ordering of the three. `policy.edit` is prose about the
 * gate, and a secret leaving the machine is the stricter statement.
 */
function outranksCredential(surface: string): boolean {
  return protectedRank(surface) <= protectedRank("policy.core");
}

/**
 * The protected path, if any, that outranks a credential answer for this
 * segment (APRV-503). `null` when none does, which is when the credential tier
 * may answer at once.
 *
 * Scanned as the protected scan reads the segment: the positionals with the
 * prose skip, and the `<` targets. A credential file is ALSO a protected path
 * (`.approval/env` lies under the gate's directory), so the words that ARE the
 * credential read are left out, or every credential read would outrank itself:
 * the `<` targets that are credential files, and the credential positionals of
 * a binary that reads what it names. A write-only binary's credential
 * positional stays in, because for it that word is a write to the gate's
 * directory (`tee .approval/env < .approval/vault.enc` is `policy.core`, as
 * `tee .approval/env` is). On equal rank the positional is the one named.
 */
function outrankingProtected(
  positionals: readonly string[],
  readTargets: readonly string[],
  writesOnly: boolean,
  protectedPaths: readonly ProtectedPathEntry[],
): { surface: string; path: string } | null {
  // APRV-522: a credential word whose OWN protected class outranks
  // `policy.core` stays in the scan. Since `..` resolves in the credential
  // rule, a `..` spelling can name the environment map while its spelling also
  // names the log directory; the stricter of the two must not be dropped.
  const isTheRead = (word: string): boolean =>
    isCredentialPathAsRead(word) &&
    protectedRank(protectedPathClass(word, protectedPaths) ?? "policy.core") >= protectedRank("policy.core");
  const named = strictestProtected(
    writesOnly ? positionals : positionals.filter((arg) => !isTheRead(arg)),
    protectedPaths,
    true,
  );
  const fed = strictestProtected(
    readTargets.filter((target) => !isTheRead(target)),
    protectedPaths,
  );
  const found =
    fed === null || (named !== null && protectedRank(named.surface) <= protectedRank(fed.surface))
      ? named
      : fed;
  return found !== null && outranksCredential(found.surface) ? found : null;
}

/**
 * Is this word PROSE that merely spells a protected path, rather than a path?
 * (APRV-409.)
 *
 * The incident: a `backlog task create` whose acceptance-criterion argument
 * began with the literal text of a workflow path and continued into a sentence
 * classified `policy.edit.ci`, sat the full hook wait on the gate and was
 * denied on timeout. The command writes one task file and touches no workflow.
 * {@link pathSegments} splits on slashes only, so a word whose leading segments
 * are a protected DIRECTORY run prefix-matches whatever follows those slashes,
 * sentence included. An exact-file entry does not, because it matches on the
 * FINAL segment, which is why the same sentence beginning `CLAUDE.md` always
 * classified as an ordinary workspace write.
 *
 * The test drawn here is the narrow one, and it is narrow in a stated way: the
 * word is prose only when the protected match came ENTIRELY from a
 * whitespace-free head. Concretely, all three hold:
 *
 * 1. the word contains whitespace at all;
 * 2. the first of its segments carrying whitespace is not the first segment,
 *    so there is a head in front of it;
 * 3. that head, on its own, already classifies as the SAME surface the whole
 *    word did.
 *
 * When (3) fails the word is kept, which is the fail-closed direction and is
 * what keeps the shapes below unmoved:
 *
 * - `my notes/CLAUDE.md` and any other exact-file match at any depth: the match
 *   needs the final segment, the head classifies as nothing, and the word keeps
 *   `policy.edit`. A real file named with a space therefore stays protected.
 * - `my notes/.github/workflows/x.yml`: whitespace BEFORE the protected run,
 *   head `my notes` classifies as nothing, word unmoved.
 * - every word with no whitespace at all, which is the whole ordinary universe
 *   of paths: condition (1) fails before anything is computed.
 *
 * What does move is the one shape prose and a path share exactly: a
 * directory-prefix match whose remainder carries whitespace. `cp x
 * ".approval/my file.txt"` is a real path of that shape and now takes the
 * command's own class. That is a deliberate trade and not an oversight —
 * `my file.txt` and `ci.yml should not gate this task` are the same string
 * shape, and no pure, disk-free rule tells them apart. A threshold on how much
 * whitespace the remainder carries would have rescued the first, and it is
 * rejected: a number here is folklore a second implementation has to guess at,
 * and the conformance suite would be pinning it. The write itself is not
 * unguarded: `core/protected-path-guard.ts` judges what a commit actually
 * changed, from the log rather than from a session, and a `.approval/` file
 * with no authorization record still fails the pull request.
 *
 * Pure and disk-free like the rest of this file: no resolution, no stat, no
 * question about whether anything exists.
 */
function proseNamingProtectedPath(
  word: string,
  surface: string,
  protectedPaths: readonly ProtectedPathEntry[],
): boolean {
  if (!/\s/u.test(word)) return false;
  const segments = pathSegments(word);
  const firstSpaced = segments.findIndex((segment) => /\s/u.test(segment));
  // `-1` is a word whose whitespace survived no segment (nothing produces it
  // today) and `0` is whitespace in or before the first segment: both leave no
  // whitespace-free head to have matched, so both keep the word.
  if (firstSpaced <= 0) return false;
  const head = segments.slice(0, firstSpaced).join("/");
  return protectedPathClass(head, protectedPaths) === surface;
}

/**
 * How the shell may still change one argv word before the program sees it
 * (APRV-511 fix round 3, S(open)): `splits`, an unquoted variable or `$(…)` is
 * in it; `expands`, an unquoted brace or glob character is. A caller that
 * cannot say passes neither, and only the text is read.
 */
export interface ArgExpansion {
  splits: boolean;
  expands: boolean;
}

const LITERAL_ARG: ArgExpansion = { splits: false, expands: false };

/**
 * Could the shell turn this argv word into an option the program then obeys,
 * or into a different NUMBER of words (APRV-511 fix round 3, S(open), the class
 * rule)? For `curl`, `wget`, `cp`, `mv`, `ln` and `install`, an option may name
 * a write target (`-o`, `-O`, `-t`, `--output-dir`, `-P`), so a word whose
 * expansion this text cannot see makes the whole argv unknowable:
 *
 * - in a slot where the program reads OPTIONS (`option`): a word that begins
 *   with a variable or a substitution (`$OPTS`, `"$U"`, `${…}`), whose value
 *   may begin with `-`, quoted or not; an unquoted variable or substitution
 *   anywhere in it, whose value may split into `-o FILE`; an unquoted glob at
 *   its head, which may match a file named `-o…`; an unquoted brace group that
 *   makes a word beginning with `-` or `$`, or too many words to know
 *   (`curl {-o,~/.hermes/config.yaml}`);
 * - in an option's VALUE slot: an unquoted variable or substitution, or an
 *   unquoted brace or glob that may make other than one word, because the
 *   words after the first are read as options again.
 *
 * Words after `--` are operands and never reach this test.
 */
function argvWordUnknowable(word: string, flags: ArgExpansion, slot: "option" | "value"): boolean {
  if (flags.splits) return true;
  if (slot === "option" && word.startsWith("$")) return true;
  if (!flags.expands) return false;
  const words = braceExpansions(word);
  if (words === null) return true;
  if (slot === "value") return words.length !== 1 || /[*?[]/u.test(word);
  return words.some((each) => /^[-$*?[]/u.test(each));
}

/**
 * The first word of a `cp`, `mv`, `ln` or `install` argv that makes its write
 * targets unknowable (APRV-511 fix round 3, S(open)), or `null`. GNU permutes
 * options, so every word before `--` is in an option slot.
 */
export function copyArgvUnknown(args: readonly string[], flags: readonly ArgExpansion[] = []): string | null {
  for (const [at, arg] of args.entries()) {
    if (arg === "--") return null;
    if (argvWordUnknowable(arg, flags[at] ?? LITERAL_ARG, "option")) return arg;
  }
  return null;
}

/**
 * The destination directories a `cp`, `mv`, `ln` or `install` argv names by
 * flag (APRV-511 refuter S3, recheck S(open)): `-t DIR`, `-tDIR`, `-t` anywhere
 * in a short cluster (`-vtDIR`, `-rt DIR`, `-ftDIR`, `-stDIR`), and the long
 * option by any unique prefix GNU accepts (`--target-directory=DIR`,
 * `--target-dir=DIR`, `--t DIR`). A cluster is read from its first `t` even
 * where an earlier letter would have taken the rest as its own value: one more
 * target judged can only make the answer stricter. Words after `--` are
 * operands. An absent value is not returned (the operand scan judges the rest).
 */
export function copyTargetDirectories(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (name.length === 0 || !"target-directory".startsWith(name)) continue;
      const value = eq === -1 ? args[at + 1] : arg.slice(eq + 1);
      if (value !== undefined) out.push(value);
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) continue;
    const t = arg.indexOf("t", 1);
    if (t === -1) continue;
    const value = t + 1 < arg.length ? arg.slice(t + 1) : args[at + 1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * What one `curl` or `wget` option does to the file system (APRV-511 review):
 * `safe` writes nothing (a value, if it takes one, is not an output path),
 * `file` names a file it writes, `dir` names the directory it writes
 * server-chosen names into, `remote` makes curl write the remote name into the
 * output directory, and `config` reads more options from a file or a string,
 * so its outputs cannot be known, and `format` is curl's `-w`/`--write-out`,
 * whose `%output{FILE}` writes FILE (recheck S(open)). `source` names a file
 * the program READS and sends or reads URLs from (fix round 4, M(L5f-1)): an
 * upload or request-body flag, judged by {@link uploadSourcePaths} with its
 * `source` reading. `value` says whether it takes an argument.
 */
interface FetchOption {
  value: boolean;
  effect: "safe" | "file" | "dir" | "remote" | "config" | "format" | "source";
  source?: UploadSourceKind;
}

/**
 * How an upload or request-body option names the file it reads (fix round 4,
 * M(L5f-1)): `file`, the value IS the path (`curl -T`, `--upload-file`; wget
 * `--post-file`, `--body-file`, `--input-file`/`-i`); `data`, a value that
 * begins with `@` reads the file after it (`-d`, `--data*`, `--json`);
 * `urlencode`, `@file` or `name@file` (`--data-urlencode`); `form`, `name=@file`
 * or `name=<file` (`-F`, `--form*`).
 */
type UploadSourceKind = "file" | "data" | "urlencode" | "form";

const bodySource = (kind: UploadSourceKind): FetchOption => ({ value: true, effect: "source", source: kind });

const safe = (value: boolean): FetchOption => ({ value, effect: "safe" });

/** curl's long options this classifier knows, by full name. */
const CURL_LONG_OPTIONS: Readonly<Record<string, FetchOption>> = {
  output: { value: true, effect: "file" },
  "dump-header": { value: true, effect: "file" },
  "cookie-jar": { value: true, effect: "file" },
  trace: { value: true, effect: "file" },
  "trace-ascii": { value: true, effect: "file" },
  stderr: { value: true, effect: "file" },
  "etag-save": { value: true, effect: "file" },
  hsts: { value: true, effect: "file" },
  "alt-svc": { value: true, effect: "file" },
  libcurl: { value: true, effect: "file" },
  "write-out": { value: true, effect: "format" },
  "output-dir": { value: true, effect: "dir" },
  "remote-name": { value: false, effect: "remote" },
  "remote-name-all": { value: false, effect: "remote" },
  config: { value: true, effect: "config" },
  // Fix round 4 (M(L5f-1)): the files a request body or an upload reads.
  "upload-file": bodySource("file"),
  data: bodySource("data"),
  "data-raw": bodySource("data"),
  "data-binary": bodySource("data"),
  "data-ascii": bodySource("data"),
  json: bodySource("data"),
  "data-urlencode": bodySource("urlencode"),
  form: bodySource("form"),
  "form-string": bodySource("form"),
  ...Object.fromEntries(
    [
      "silent", "show-error", "fail", "fail-with-body", "fail-early", "location", "location-trusted", "insecure",
      "verbose", "include", "head", "get", "compressed", "http1.0", "http1.1", "http2", "http2-prior-knowledge",
      "http3", "ipv4", "ipv6", "no-buffer", "no-progress-meter", "progress-bar", "globoff", "netrc",
      "netrc-optional", "no-keepalive", "raw", "tcp-nodelay", "ssl", "ssl-reqd", "tlsv1", "tlsv1.0", "tlsv1.1",
      "tlsv1.2", "tlsv1.3", "anyauth", "basic", "digest", "ntlm", "negotiate", "no-sessionid", "disable",
      "path-as-is", "create-dirs", "remote-header-name", "remote-time", "list-only", "append", "crlf",
      "ignore-content-length", "junk-session-cookies", "post301", "post302", "post303", "styled-output",
      "no-styled-output", "suppress-connect-headers", "false-start", "tr-encoding", "ssl-no-revoke",
      "proxy-insecure", "retry-all-errors", "retry-connrefused", "parallel", "parallel-immediate", "skip-existing",
      "no-clobber", "no-alpn", "no-npn", "manual", "help", "version", "disable-epsv", "disable-eprt",
    ].map((name) => [name, safe(false)]),
  ),
  ...Object.fromEntries(
    [
      "header", "request", "user-agent", "user", "referer", "max-time", "connect-timeout", "retry", "retry-delay",
      "retry-max-time", "range", "url", "proxy", "proxy-user", "resolve", "connect-to", "cacert", "capath", "cert",
      "key", "cert-type", "key-type", "pass", "cookie", "max-filesize", "max-redirs", "limit-rate", "speed-limit",
      "speed-time", "time-cond", "interface", "dns-servers", "oauth2-bearer", "aws-sigv4",
      "keepalive-time", "expect100-timeout", "local-port", "ciphers", "tls-max", "proto", "proto-redir",
      "proto-default", "request-target", "unix-socket", "url-query", "parallel-max", "quote", "mail-from",
      "mail-rcpt", "preproxy", "noproxy", "socks5", "socks5-hostname", "continue-at", "etag-compare", "variable",
    ].map((name) => [name, safe(true)]),
  ),
};

/** curl's short options this classifier knows. */
const CURL_SHORT_OPTIONS: Readonly<Record<string, FetchOption>> = {
  o: { value: true, effect: "file" },
  D: { value: true, effect: "file" },
  c: { value: true, effect: "file" },
  w: { value: true, effect: "format" },
  O: { value: false, effect: "remote" },
  K: { value: true, effect: "config" },
  T: bodySource("file"),
  d: bodySource("data"),
  F: bodySource("form"),
  ...Object.fromEntries(
    ["s", "S", "f", "L", "k", "v", "i", "I", "G", "N", "n", "q", "j", "J", "l", "R", "Z", "0", "1", "2", "3", "4", "6", "#", "a", "B", "M", "p", "g", "h", "V"].map(
      (letter) => [letter, safe(false)],
    ),
  ),
  ...Object.fromEntries(
    ["H", "X", "A", "u", "e", "m", "r", "x", "U", "E", "b", "Y", "y", "z", "Q", "C", "t", "P"].map(
      (letter) => [letter, safe(true)],
    ),
  ),
};

/** wget's long options this classifier knows, by full name. */
const WGET_LONG_OPTIONS: Readonly<Record<string, FetchOption>> = {
  "output-document": { value: true, effect: "file" },
  "output-file": { value: true, effect: "file" },
  "append-output": { value: true, effect: "file" },
  "save-cookies": { value: true, effect: "file" },
  "warc-file": { value: true, effect: "file" },
  "rejected-log": { value: true, effect: "file" },
  "directory-prefix": { value: true, effect: "dir" },
  execute: { value: true, effect: "config" },
  config: { value: true, effect: "config" },
  "post-file": bodySource("file"),
  "body-file": bodySource("file"),
  "input-file": bodySource("file"),
  ...Object.fromEntries(
    [
      "quiet", "verbose", "no-verbose", "server-response", "spider", "no-check-certificate", "continue",
      "timestamping", "no-clobber", "inet4-only", "inet6-only", "no-cache", "no-cookies", "ignore-length",
      "content-disposition", "trust-server-names", "show-progress", "no-dns-cache", "debug", "https-only",
      "no-parent", "no-directories", "force-directories", "no-host-directories", "adjust-extension",
      "recursive", "mirror", "page-requisites", "convert-links", "help", "version", "no-config", "keep-session-cookies",
      "auth-no-challenge", "no-http-keep-alive", "retry-connrefused", "force-html", "span-hosts", "relative",
    ].map((name) => [name, safe(false)]),
  ),
  ...Object.fromEntries(
    [
      "tries", "timeout", "wait", "user-agent", "header", "user", "password", "http-user", "http-password",
      "post-data", "method", "body-data", "limit-rate", "level", "accept", "reject",
      "domains", "exclude-domains", "referer", "max-redirect", "ca-certificate", "ca-directory", "certificate",
      "private-key", "base", "dns-timeout", "connect-timeout", "read-timeout", "waitretry", "quota",
      "restrict-file-names", "local-encoding", "remote-encoding", "progress", "bind-address", "cut-dirs",
      "load-cookies", "include-directories", "exclude-directories", "secure-protocol", "proxy-user",
      "proxy-password", "https-proxy", "http-proxy",
    ].map((name) => [name, safe(true)]),
  ),
};

/** wget's short options this classifier knows (`-n` takes its sub-letters). */
const WGET_SHORT_OPTIONS: Readonly<Record<string, FetchOption>> = {
  O: { value: true, effect: "file" },
  o: { value: true, effect: "file" },
  a: { value: true, effect: "file" },
  P: { value: true, effect: "dir" },
  e: { value: true, effect: "config" },
  // `-b` backgrounds and writes `wget-log` into the working directory.
  b: { value: false, effect: "remote" },
  i: bodySource("file"),
  ...Object.fromEntries(
    ["q", "v", "V", "h", "S", "c", "N", "r", "m", "p", "k", "K", "E", "H", "L", "x", "4", "6", "F"].map((letter) => [letter, safe(false)]),
  ),
  ...Object.fromEntries(
    ["t", "T", "w", "U", "l", "A", "R", "D", "B", "Q", "I", "X"].map((letter) => [letter, safe(true)]),
  ),
};

/**
 * A long option by its full name or by a unique prefix, as both tools accept
 * abbreviations (GNU wget always; curl's parser tries the same). `null` when
 * the name is unknown or ambiguous.
 */
function fetchLongOption(table: Readonly<Record<string, FetchOption>>, name: string): FetchOption | null {
  const exact = table[name];
  if (exact !== undefined) return exact;
  const matches = Object.keys(table).filter((known) => known.startsWith(name));
  return matches.length === 1 ? (table[matches[0] as string] as FetchOption) : null;
}

/**
 * Where `curl` and `wget` write (APRV-511 refuter S1 and review): `files`,
 * paths written by name (`curl -o F`, `-sSLoF`, `--output F`, `--outp=F`,
 * `-D`, `-c`, `--trace`, `--stderr`; `wget -O F`, `--output-doc=F`, `-o`/`-a`
 * logs), and `directories`, directories written with a name the server
 * chooses (`curl -O` into `--output-dir` or `.`; `wget` without `-O` into
 * `-P`/`--directory-p…` or `.`). `unknown` names the first option that makes
 * the outputs unknowable: one this table does not know, an ambiguous prefix,
 * or a config source (`curl -K`/`--config`, `wget -e`/`--execute`/`--config`).
 * `-` is standard output and writes nothing. Any other binary writes nothing.
 *
 * Fix round 4 (M(L5f-1)): `sources` are the files an upload or request-body
 * option READS ({@link uploadSourcePaths}), in every spelling: separated
 * (`-T F`, `--data @F`), joined by `=` (`--upload-file=F`, `--data=@F`) and
 * glued (`-TF`, `-sd@F`, `-Ff=@F`). `sourceUnknown` is the first option word
 * whose EMBEDDED value names a file this text cannot read (a variable, a
 * substitution, a glob or a brace in it). A separated value is a word of its
 * own and is judged as the positional it also is.
 */
export function fetchOutputs(
  bin: string,
  args: readonly string[],
  flags: readonly ArgExpansion[] = [],
): { files: string[]; directories: string[]; unknown: string | null; sources: string[]; sourceUnknown: string | null } {
  const files: string[] = [];
  const directories: string[] = [];
  let unknown: string | null = null;
  const sources: string[] = [];
  let sourceUnknown: string | null = null;
  if (bin !== "curl" && bin !== "wget") return { files, directories, unknown, sources, sourceUnknown };
  const longTable = bin === "curl" ? CURL_LONG_OPTIONS : WGET_LONG_OPTIONS;
  const shortTable = bin === "curl" ? CURL_SHORT_OPTIONS : WGET_SHORT_OPTIONS;
  let remote = false;
  let named = false;
  let directory: string | null = null;
  // curl's `-o`/`--output` values, which `--output-dir` places (recheck S(open)).
  const curlNamed: string[] = [];
  // Fix round 3 (S(open)): curl fills `#1`, `#2`… in an output name from the
  // URL's glob (`'https://e/{s}' -o ~/.hermes/plugin#1/x`), so a value holding
  // `#<digit>` names a file this text cannot place.
  const placeable = (value: string): boolean => !value.includes("$") && !/#\d/u.test(value);
  // `word` is the option word itself when the value is embedded in it.
  const apply = (option: FetchOption, value: string | undefined, spelled: string, word?: string): void => {
    if (option.effect === "config") unknown ??= spelled;
    else if (option.effect === "source") {
      if (value === undefined) return;
      const paths = uploadSourcePaths(option.source ?? "file", value);
      if (paths !== null) sources.push(...paths);
      else if (word !== undefined) sourceUnknown ??= word;
    }
    else if (option.effect === "file") {
      // Recheck S(open): an absent value, or one a variable or a substitution
      // decides, is a target this classifier cannot place: the stricter class.
      if (value === undefined || !placeable(value)) unknown ??= spelled;
      else {
        files.push(value);
        if (bin === "wget" && (spelled === "-O" || spelled.startsWith("--output-d"))) named = true;
        if (bin === "curl" && (spelled === "-o" || spelled === "--output")) curlNamed.push(value);
      }
    } else if (option.effect === "dir") {
      if (value === undefined || !placeable(value)) unknown ??= spelled;
      else directory = value;
    } else if (option.effect === "remote") remote = true;
    else if (option.effect === "format") {
      // `-w @FILE` (or `@-`) reads the format from elsewhere, so its
      // `%output{…}` targets are unknowable; otherwise each `%output{FILE}`
      // (`%output{>>FILE}` appends) is a file curl writes.
      if (value === undefined || value.startsWith("@")) {
        unknown ??= spelled;
        return;
      }
      for (const match of value.matchAll(/%output\{(?:>>)?([^}]*)\}/gu)) {
        const target = match[1] ?? "";
        if (target.length === 0 || !placeable(target)) unknown ??= spelled;
        else files.push(target);
      }
      // A `%output{` without its closing brace still names some file.
      if (/%output\{(?![^}]*\})/u.test(value)) unknown ??= spelled;
    }
  };
  /** Fix round 3 (S(open)): the word at `at`, in `slot`, may become an option. */
  const unknowable = (at: number, slot: "option" | "value"): boolean =>
    at < args.length && argvWordUnknowable(args[at] as string, flags[at] ?? LITERAL_ARG, slot);
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") break;
    if (unknowable(at, "option")) {
      unknown ??= arg;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      // `--no-<option>` turns a boolean off and writes nothing more.
      const option = fetchLongOption(longTable, name) ?? (name.startsWith("no-") ? fetchLongOption(longTable, name.slice(3)) : null);
      if (option === null) {
        unknown ??= arg;
        continue;
      }
      let value: string | undefined;
      if (option.value) {
        value = eq === -1 ? args[at + 1] : arg.slice(eq + 1);
        if (eq === -1) {
          if (unknowable(at + 1, "value")) unknown ??= arg;
          at += 1;
        }
      }
      apply(
        option,
        value,
        `--${Object.keys(longTable).find((known) => longTable[known] === option) ?? name}`,
        eq === -1 ? undefined : arg,
      );
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const letters = arg.slice(1);
      for (let index = 0; index < letters.length; index += 1) {
        const letter = letters[index] as string;
        if (bin === "wget" && letter === "n") {
          // `-nv`, `-nc`, `-nd`, `-nH`, `-np`: wget reads every letter after
          // `n` as one of those; any other letter there is not a known form.
          if (!/^[vcdHp]+$/u.test(letters.slice(index + 1))) unknown ??= arg;
          break;
        }
        const option = shortTable[letter];
        if (option === undefined) {
          unknown ??= arg;
          break;
        }
        if (option.value) {
          const rest = letters.slice(index + 1);
          let value: string | undefined = rest;
          if (rest.length === 0) {
            value = args[at + 1];
            if (unknowable(at + 1, "value")) unknown ??= arg;
            at += 1;
          }
          apply(option, value, `-${letter}`, rest.length === 0 ? undefined : arg);
          break;
        }
        apply(option, undefined, `-${letter}`);
      }
    }
  }
  if (bin === "curl" && remote) directories.push(directory ?? ".");
  // Recheck S(open): curl stores every `-o` output in `--output-dir` too, so a
  // named output lands there (`--output-dir <organ> -o x.py`); fix round 3:
  // an ABSOLUTE one too, as curl joins the two strings whatever the value
  // (`--output-dir ~/.hermes -o /plugins/x.py` writes `~/.hermes/plugins/x.py`).
  // The value as spelled stays judged as well: the stricter of the two readings.
  // (`directory` is assigned inside `apply`, which the compiler cannot follow.)
  const outputDir = directory as string | null;
  if (bin === "curl" && outputDir !== null) {
    for (const value of curlNamed) {
      if (value !== "-") files.push(`${outputDir.replace(/\/+$/u, "")}/${value.replace(/^\/+/u, "")}`);
    }
  }
  if (bin === "wget" && (!named || remote)) directories.push(directory ?? ".");
  return { files: files.filter((file) => file !== "-"), directories, unknown, sources, sourceUnknown };
}

/**
 * The file an upload or request-body option value reads, for each reading of
 * it (fix round 4, M(L5f-1)): `[]` when the value reads no file (`--data=hello`,
 * `-F name=value`), `null` when the text cannot say which file it reads.
 *
 * curl reads a `--data`/`-d`/`--json` file only when the value begins with `@`;
 * `--data-urlencode` when an `@` comes before any `=` (`@F`, `name@F`); `-F`
 * when the part after the first `=` begins with `@` or `<`, and there the path
 * may be double-quoted and followed by `;type=…` or a `,` list, so the path is
 * judged whole, unquoted, and cut at each `;` and `,` (one more path judged can
 * only be stricter).
 * `--data-raw` and `--form-string` never read a file, and are read the same
 * way all the same: the stricter of two answers. The round-3 class rule, for a
 * value the option word carries: a variable or a substitution (`$`, which
 * the substitution sentinel also begins with), a glob (`*`, `?`, `[`; curl
 * globs `-T` itself) or a brace group (`{`) in the path, or a variable where
 * the `@` would be, makes the file unknowable.
 */
function uploadSourcePaths(kind: UploadSourceKind, value: string): string[] | null {
  const literal = (text: string): boolean => !/[$`*?[{]/u.test(text);
  if (kind === "file") return literal(value) ? [value] : null;
  if (kind === "data") {
    if (value.startsWith("$")) return null;
    if (!value.startsWith("@")) return [];
    const file = value.slice(1);
    return literal(file) ? [file] : null;
  }
  if (kind === "urlencode") {
    const at = value.search(/[@=$]/u);
    if (at === -1 || value[at] === "=") return [];
    if (value[at] === "$") return null;
    const file = value.slice(at + 1);
    return literal(file) ? [file] : null;
  }
  const eq = value.search(/[=$]/u);
  if (eq === -1) return [];
  if (value[eq] === "$") return null;
  const rest = value.slice(eq + 1);
  if (rest.startsWith("$")) return null;
  if (!rest.startsWith("@") && !rest.startsWith("<")) return [];
  const file = rest.slice(1);
  if (!literal(file)) return null;
  // curl lets the path be double-quoted (`f=@"x;y";type=…`): judged unquoted too.
  const unquoted = file.replaceAll('"', "");
  return [...new Set([file, unquoted, ...file.split(/[;,]/u), ...unquoted.split(/[;,]/u)])].filter(
    (path) => path.length > 0,
  );
}

/**
 * The strictest protected surface named by these words, with the word itself.
 *
 * `null` when none of them is protected. The word is returned verbatim, which
 * is what {@link ClassifiedSegment.path} carries to the approver.
 *
 * Among several words at the same rank the FIRST wins, which is what it always
 * did and is what keeps a bare-string policy byte-identical: two routed paths
 * in one segment are two equally consequential surfaces, and the segment's
 * class names one of them while `ClassifiedSegment.path` names the word.
 *
 * `skipProse` turns on {@link proseNamingProtectedPath} (APRV-409) and is
 * passed by the POSITIONAL scan alone. The other caller here is the
 * write-redirection targets, whose words are paths by construction — the shell
 * is about to create that file — and the same is true of the paths
 * `core/apply-patch.ts` and the hook's file-tool pass hand to
 * {@link protectedPathClass} directly. None of them is offered the skip.
 */
function strictestProtected(
  words: readonly string[],
  protectedPaths: readonly ProtectedPathEntry[],
  skipProse = false,
): { surface: string; path: string } | null {
  let best: { surface: string; path: string } | null = null;
  for (const word of words) {
    const surface = protectedPathClass(word, protectedPaths);
    if (surface === null) continue;
    if (skipProse && proseNamingProtectedPath(word, surface, protectedPaths)) continue;
    if (best === null || protectedRank(surface) < protectedRank(best.surface)) {
      best = { surface, path: word };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// A glob in a WRITE target (GLOB-WRITE ruling, 22 Nov 2026)
// ---------------------------------------------------------------------------

/** Builtins and wrappers that may set a shell option: a WHOLE folded word (lead allowlist, 22 Nov 2026). */
const DOTGLOB_SETTER_WORDS: readonly string[] = [
  "shopt", "setopt", "unsetopt", "set", "emulate", "eval", "source", "autoload", "typeset", "declare",
  "export", "local", "readonly", "read", "let", "printf", "builtin", "command", "exec", "enable",
];
/** Option names: a substring anywhere in the folded line. */
const DOTGLOB_OPTION_NAMES = /options|dotglob|globdots|globignore|bashopts|shellopts|bashenv|zdotdir/u;
/** Names whose assignment may set an option or load start-up files (folded, by prefix). */
const DOTGLOB_ASSIGNED = /^(?:options|bashopts|shellopts|globignore|bashenv|env|zdotdir)/u;
/** Programs that start a shell or run another command: any of them makes the line strict. */
const DOTGLOB_LAUNCHERS: readonly string[] = [
  "bash", "sh", "zsh", "dash", "ksh", "mksh", "yash", "posh", "fish", "env", "xargs", "sudo", "nohup", "timeout", "nice",
];

/**
 * May this command line turn on dot-name matching (bash `dotglob`, zsh
 * `GLOB_DOTS`)? An ALLOWLIST, fail closed (lead ruling, 22 Nov 2026): the
 * default reading, where a pattern reaches a dot-name only through an explicit
 * leading `.`, applies only to a PLAIN line. Anything else is `true`:
 *
 * - any `$` (expansion, ANSI-C `$'…'` and locale `$"…"` quoting), backtick,
 *   brace, or parenthesis anywhere;
 * - after removing quotes, backslashes and underscores and folding case: any
 *   option name as a substring (`options`, `dotglob`, `globdots`,
 *   `globignore`, `bashopts`, `shellopts`, `bashenv`, `zdotdir`); any WHOLE
 *   word that is a builtin which may set one ({@link DOTGLOB_SETTER_WORDS});
 *   an assignment to a name opening with `options`, `bashopts`, `shellopts`,
 *   `globignore`, `bashenv`, `env` or `zdotdir`;
 * - `.` as a command word; any word naming a shell or a launcher
 *   ({@link DOTGLOB_LAUNCHERS}); find's `-exec`, `-execdir`, `-ok`; a
 *   single-dash cluster holding `l` or `i` (a login or interactive shell).
 *
 * A user's own start-up file may set dotglob or globdots unseen, so every
 * write-target pattern is read with dot-names matched as well, whatever this
 * says (lead ruling, CLAIMS L61492 and L61497; {@link globGuardClass}). What
 * this still decides: whether `*` and `?` may also be read as `.` and `..`,
 * and whether zsh's extendedglob and braceccl forms are patterns.
 */
function lineMaySetDotglob(command: string): boolean {
  if (/[$`{}()]/u.test(command)) return true;
  // Shell option names, not file names: zsh folds ASCII case and drops
  // underscores, so this stays an ASCII lower case, not the guarded-name fold.
  const folded = command.replace(/['"\\_]/gu, "").toLowerCase();
  if (DOTGLOB_OPTION_NAMES.test(folded)) return true;
  for (const piece of folded.split(/[;&|\n]+/u)) {
    const words = piece.trim().split(/\s+/u).filter((word) => word.length > 0);
    if (words[0] === ".") return true;
    for (const word of words) {
      // A program named by an absolute path counts as its name (`/usr/bin/env`).
      const name = word.startsWith("/") ? (word.split("/").pop() ?? word) : word;
      if (DOTGLOB_SETTER_WORDS.includes(word) || DOTGLOB_SETTER_WORDS.includes(name)) return true;
      if (DOTGLOB_LAUNCHERS.includes(name.replace(/[0-9.]+$/u, ""))) return true;
      if (word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir") return true;
      if (/^-[a-z0-9]*[li]/u.test(word) && !word.startsWith("--")) return true;
      const assigned = /^([a-z0-9[\]]+)\+?=/u.exec(word);
      if (assigned !== null && DOTGLOB_ASSIGNED.test(assigned[1] as string)) return true;
    }
  }
  return false;
}

/**
 * What the caller read of the disk for write-target patterns (GLOB-WRITE, lead
 * ruling L61167). `listings` maps an absolute directory to the names it holds,
 * or `"unreadable"` when the caller could not list it in full (an error, the
 * entry cap, the timeout): that directory keeps the over-approximated answer.
 * `cwd` and `home` place a relative or `~` prefix; `relativeOk` is set false by
 * {@link classifyCommand} on a line that may change directory first. `collect`,
 * when present, receives every directory a pattern asked for
 * ({@link globWriteListingDirs}).
 */
export interface GlobDisk {
  cwd: string;
  home: string | null;
  /** Directory listings by absolute path, and canonical paths keyed by {@link realpathKey}. */
  listings: ReadonlyMap<string, readonly string[] | "unreadable" | "missing">;
  /**
   * `false`: the line has more than one segment, so a directory that was not
   * there when listed (`"missing"`) may be made before the pattern runs
   * (`mkdir -p d && cp x d/*`): it is not read as empty (review of e6b7bf97, 4).
   */
  singleSegment?: boolean;
  /** `false`: a relative prefix is not placed (the line may change directory, or the caller is not sure `cwd` is the shell's). */
  relativeOk?: boolean;
  /** `false`: a `~` prefix is not placed (the line names `HOME`). */
  homeOk?: boolean;
  /** `false`: no listing is used (something else on the line may create, move, link or extract a file). */
  listingsOk?: boolean;
  collect?: Set<string>;
}

/**
 * The key under which the hook passes a path's canonical form (symlinks
 * resolved, letter case as on disk) in {@link GlobDisk.listings}: a
 * one-element listing. Directory keys are absolute, so the two never meet.
 */
export function realpathKey(path: string): string {
  return `realpath:${path}`;
}

/**
 * The names the caller listed in `dir`, or `undefined` (not listed, or not
 * listable in full). A directory that was not there is empty only to a glob on
 * a one-segment line (`missingIsEmpty`); to a contents copy it is never empty
 * (review of e6b7bf97, findings 2 and 4).
 */
function diskListing(disk: GlobDisk, dir: string, missingIsEmpty: boolean): readonly string[] | undefined {
  const listed = disk.listings.get(dir);
  if (Array.isArray(listed)) return listed;
  if (listed === "missing" && missingIsEmpty && disk.singleSegment === true) return [];
  return undefined;
}

/** Commands that create, move, link and extract nothing: the only company a listed pattern may keep on its line. */
const LISTING_SAFE_COMPANIONS: readonly string[] = [
  "ls", "cat", "echo", "true", "false", "pwd", "test", "[", "head", "tail", "wc", "grep", "date", "whoami",
];

/**
 * May a listing made before the line runs stand for what the pattern will
 * meet (review of 6e3cbc9e, M2)? Only on a line with no substitution, no
 * heredoc body to expand and no subshell, where at most one segment is
 * anything but a plain {@link LISTING_SAFE_COMPANIONS} command with no write
 * redirection: `touch dist/APPROVAL.md; rm -rf dist/*` creates the name the
 * listing never saw, and a pipeline or a background job runs beside it.
 */
function lineListingSafe(command: string, segments: readonly LexSegment[]): boolean {
  if (/[`]|\$\(|<\(|>\(/u.test(command)) return false;
  let others = 0;
  for (const segment of segments) {
    if (segment.subshell || segment.heredoc || segment.bodySubstitutions.length > 0 || segment.opaque !== null) return false;
    if (segment.words.some((word) => word.substitutions.length > 0)) return false;
    const head = segment.words.find((word) => !ASSIGNMENT.test(word.text));
    const plain =
      head !== undefined &&
      head.exact &&
      LISTING_SAFE_COMPANIONS.includes(head.text) &&
      segment.words.every((word) => !ASSIGNMENT.test(word.text) || word === head) &&
      segment.redirects.every((redirect) => redirect.op === "<");
    if (!plain) others += 1;
    if (others > 1) return false;
  }
  return true;
}

/**
 * The absolute directory a pattern's literal prefix names, or `null` when the
 * text cannot place it: a variable or a `..` in the prefix (a symlinked parent
 * makes `..` a disk question), `~user`, `~+`, `~-`, or a relative prefix on a
 * line that may change directory. Lexical, like everything in this file.
 */
function globListingDir(prefix: readonly string[], disk: GlobDisk): string | null {
  if (prefix.some((segment) => segment.includes("$") || segment.includes(PARAMETER_MARK) || segment === "..")) return null;
  const strip = (path: string): string => path.replace(/\/+$/u, "");
  const rest = (from: number): string[] => prefix.slice(from).filter((segment) => segment.length > 0 && segment !== ".");
  let base: string;
  let parts: string[];
  if (prefix.length > 0 && prefix[0] === "") {
    base = "";
    parts = rest(1);
  } else if (prefix[0] === "~") {
    if (disk.homeOk === false || disk.home === null || !disk.home.startsWith("/")) return null;
    base = strip(disk.home);
    parts = rest(1);
  } else if (prefix[0]?.startsWith("~") === true) {
    return null;
  } else {
    if (disk.relativeOk === false || !disk.cwd.startsWith("/")) return null;
    base = strip(disk.cwd);
    parts = rest(0);
  }
  const dir = [base, ...parts].join("/");
  return dir.length === 0 ? "/" : dir;
}

/**
 * The directories the hook lists before it classifies `command` (GLOB-WRITE,
 * lead ruling L61167): the directory of the first globbed component of every
 * write-target pattern the classifier reads, placed against `cwd` and `home`.
 * Pure; the listing itself is the caller's (`src/cli/glob-listing.ts`).
 */
export function globWriteListingDirs(command: string, cwd: string, home: string | null): string[] {
  const collect = new Set<string>();
  classifyCommand(command, [], { globDisk: { cwd, home, listings: new Map(), collect } });
  return [...collect];
}

/**
 * {@link strictestProtected} for words a command WRITES through, read the way
 * the shell may still read them. Nothing here may be looser than the shell.
 *
 * `echo x > ~/.hermes/auth.json` is `policy.core`, and `echo x >
 * ~/.hermes/[!Z]uth.json` was `files.write.workspace`: bash and zsh write
 * through a glob in a redirect target when it matches one file, and every shell
 * writes through one in a `cp`, `mv`, `tee` or `ln` operand, so the second
 * command overwrote the same organ with nothing gating it. Each word is judged
 * as written and in every reading of {@link writeWordReadings} (the default or
 * alternative text of a `${X:-…}` it carries, which the shell substitutes and
 * then globs), and each reading the shell may still glob (`inexact(word)`, the
 * lexer's verdict, and a glob construct in the reading) by every guarded path
 * its pattern could match ({@link globGuardClass}). The strictest class
 * answers; the path bound is the word as written.
 *
 * `skipProse` keeps its meaning (a positional with whitespace in it that names
 * a protected head is prose); a prose word is offered no other reading.
 */
function strictestProtectedWrite(
  words: readonly string[],
  protectedPaths: readonly ProtectedPathEntry[],
  inexact: (word: string) => boolean,
  skipProse = false,
  glob: GlobReading = defaultGlobReading(),
): { surface: string; path: string } | null {
  let best = strictestProtected(words, protectedPaths, skipProse);
  // The text answer, for the record of whether a reading raised it.
  const text = best;
  if (glob.off || mainRulesOnly) return best;
  const offer = (surface: string | null, word: string): void => {
    if (surface !== null && (best === null || protectedRank(surface) < protectedRank(best.surface))) {
      best = { surface, path: word };
    }
  };
  // The matcher steps each word already judged here took. The same word again
  // (`rsync -aR s0/*/./a* … s45/*/./a* d/` lands every source as `d/a*`, and
  // 46 sources made 46 walks of one pattern) offers exactly what it offered
  // the first time, none of it stricter than `best` now, so it is not walked
  // again. It still pays the steps it took, so the shared budget runs out
  // where it ran out before: a walk that would have exhausted it answers
  // `log.mutate`, as that walk did.
  const spent = new Map<string, number>();
  for (const word of words) {
    // Review-b M1: nothing is stricter than log.mutate, so stop there.
    if (best !== null && (best as { surface: string }).surface === "log.mutate") break;
    if (!inexact(word)) continue;
    if (skipProse && /\s/u.test(word)) continue;
    const steps = spent.get(word);
    if (steps !== undefined) {
      glob.budget.left -= steps;
      if (steps > 0 && glob.budget.left < 0) offer("log.mutate", word);
      continue;
    }
    const budgetBefore = glob.budget.left;
    // A special parameter's name is not a glob, where the word's every `$` is real.
    const subject = glob.names?.(word) === true ? maskSpecialParameters(word) : word;
    const { readings, overflow } = writeWordReadings(subject);
    if (overflow) offer("log.mutate", word);
    for (const reading of readings) {
      if (reading !== subject) offer(protectedPathClass(reading, protectedPaths), word);
      // ONE matcher budget for the whole command line (review-b M1), shared
      // through the classifier context by every segment, word and reading.
      if (globLive(glob, word) && hasGlobConstruct(reading)) offer(globGuardClass(reading, protectedPaths, glob.budget, glob.options, glob.disk), word);
    }
    spent.set(word, budgetBefore - glob.budget.left);
  }
  if (best !== text) markGlobWriteFired();
  if (best !== text && glob.tracker !== undefined) glob.tracker.raised = true;
  return best;
}

/**
 * How the write-target pattern reading runs for one segment (GLOB-WRITE):
 * `options` true when the line may set shell options (dot matching, and the
 * zsh/bash forms that need an option: extendedglob's `#`, `^`, `~`, braceccl),
 * the caller's listings, the line's shared step budget, `off` for the plain
 * (text-only) pass, and the tracker that records a raise.
 */
interface GlobReading {
  /**
   * May the shell still glob this word? `false` when every glob character in
   * it was quoted or escaped (the lexer's `splits`, `expands` and, where the
   * line may set options, `zshGlob`).
   */
  live?: (word: string) => boolean;
  /** Is every `$` in this word a real expansion ({@link specialParametersOnly})? */
  names?: (word: string) => boolean;
  options: boolean;
  disk?: GlobDisk;
  budget: { left: number };
  off: boolean;
  tracker?: { raised: boolean; parent?: boolean };
}
/**
 * `(text) => words.some((word) => word.includes(text))`, the segment's
 * `inexact` and `glob.live` questions, answered once per text (review
 * A686-FOLD2, M2): the copy readers ask them of every source and destination,
 * so a scan of the segment's words per call made a line of many globbed
 * sources quadratic. A text that IS one of the words is contained in it, so
 * the set answers it at once. Any other text is looked for once, and
 * remembered, in the words joined by NUL: a text with no NUL in it lies in
 * that string exactly when it lies in one word, since an occurrence holds no
 * NUL and so crosses no join; a text with a NUL keeps the scan. The answer is
 * the scan's for every text (an empty text is in any word, and in none of no
 * words).
 */
export function containedInAny(words: readonly string[]): (text: string) => boolean {
  const whole = new Set(words);
  const seen = new Map<string, boolean>();
  let joined: string | null = null;
  return (text: string): boolean => {
    let hit = seen.get(text);
    if (hit === undefined) {
      if (whole.has(text)) hit = true;
      else if (words.length === 0) hit = false;
      else if (text.includes("\0")) hit = words.some((word) => word.includes(text));
      else {
        joined ??= words.join("\0");
        hit = joined.includes(text);
      }
      seen.set(text, hit);
    }
    return hit;
  };
}

/**
 * Could the shell expand this write target to a path through `.git` with
 * dotglob or globdots set where the line cannot show it (lead ruling, CLAIMS
 * L61492 and L61497)? {@link mayNameGitDirectory} keeps the rule that a
 * leading `*` or `?` never matches a leading dot, so only such segments are
 * read here, each against `.git`. With the caller's listing of the directory
 * before the segment, only a `.git` that is there counts (`rm -f *` in a
 * checkout's root, not in `dist/`); with none, the pattern decides. The plain
 * (text-only) pass reads no pattern; a hit is a raise (review-b S1).
 */
function dotGlobNamesGit(word: string, inexact: (word: string) => boolean, glob: GlobReading): boolean {
  if (mainRulesOnly) return false;
  const named = dotGlobNamesGitRule(word, inexact, glob);
  if (named) markGlobWriteFired();
  return named;
}

function dotGlobNamesGitRule(word: string, inexact: (word: string) => boolean, glob: GlobReading): boolean {
  if (glob.off || !inexact(word) || !globLive(glob, word)) return false;
  const hit = ((): boolean => {
    const alternatives = word.includes("{") ? expandBraces(word) : [word];
    if (alternatives === null) return true;
    for (const each of alternatives) {
      const segments = each.split("/");
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] as string;
        if (!/^[*?]/u.test(segment)) continue;
        const match = globTokensMatch(globSegmentTokens(segment, glob.options), ".git", false, glob.budget);
        if (match === false) continue;
        if (match === null) return true;
        const prefix = segments.slice(0, index);
        const disk = glob.disk;
        if (disk !== undefined && disk.listingsOk !== false && !prefix.some((part) => hasGlobConstruct(part))) {
          const dir = globListingDir(prefix, disk);
          if (dir !== null) {
            disk.collect?.add(dir);
            const listing = diskListing(disk, dir, true);
            if (listing !== undefined) {
              // One fold for every guarded name (review-b A686-FOLD3 N2): the swap to
              // the shared helper reaches this comparison too.
              if (listing.some((name) => sameGuardedName(name, ".git"))) return true;
              continue;
            }
          }
        }
        return true;
      }
    }
    return false;
  })();
  if (hit && glob.tracker !== undefined) glob.tracker.raised = true;
  return hit;
}

/** Unknown liveness is live: fail closed. */
function globLive(glob: GlobReading, word: string): boolean {
  return glob.live === undefined || glob.live(word);
}
function defaultGlobReading(): GlobReading {
  return { options: false, budget: { left: GLOB_GUARD_STEP_CAP }, off: false };
}

/**
 * The words a command WRITES through, for {@link strictestProtectedWrite}
 * (GLOB-WRITE). FAIL CLOSED: every operand of a command that is not a read is
 * a possible write target, unless a row says which operand it writes:
 *
 * - `cp`, `ln`, `install`: the destination, the last operand (`-t DIR` is
 *   judged with the download outputs). A glob in a SOURCE operand is a read
 *   (`cp ./*.md docs/` copies the policy file out, it does not write it), and a
 *   read through a glob is the read jail's question.
 *
 * Only WHOLE words. The shell globs a word as a whole, so the value inside an
 * option word (`--out=APPROVAL.m?`, `-oAPPROVAL.m?`, `of=APPROVAL.m?`) is
 * never a pattern on the path the program writes: the program receives it as
 * written. A read-class command's own outputs (`sort -o`, `uniq in out`,
 * sed's `w`) are {@link readWriteTargets}, judged where the read is answered.
 */
function globWriteOperands(basename: string, positionals: readonly string[]): string[] {
  if (basename === "cp" || basename === "ln" || basename === "install") {
    const last = positionals[positionals.length - 1];
    return last === undefined ? [] : [last];
  }
  return [...positionals];
}

/**
 * Are `a` and `b` one guarded name? The GLOB-WRITE code compares names
 * through the shared fold ({@link foldNameExact}, `name-fold.ts`; lead ruling
 * 04:11Z: one fold): folded in the folded reading, and EXACTLY in the
 * as-spelled one, as main compares a name there (main had no GLOB-WRITE rule,
 * so as spelled `.gItHuB` is not `.github`). A case variant then keeps the
 * class main gives that spelling beside the folded protected one, and the
 * strictest decision across the readings answers (review-b A686-FOLD5 M1).
 */
function sameGuardedName(a: string, b: string): boolean {
  return foldNameExact(a) === foldNameExact(b);
}

/**
 * Harness directories whose files are organs only when named (`.claude/settings*`,
 * `.cursor/hooks.json`, ...): a write that may land ANY name inside one is an
 * organ write (review of b402adec, M2). `.github` for its workflows. The
 * approval home, the Hermes home, `.codex` and `.git` are guarded bare already.
 */
const ORGAN_DIRECTORIES: Readonly<Record<string, string>> = {
  ".claude": "policy.core",
  ".cursor": "policy.core",
  ".grok": "policy.core",
  ".muse": "policy.core",
  ".github": "policy.edit",
};

/**
 * The class of a destination directory that a copy, move, link, sync or
 * extraction may fill with any name (review of b402adec M2; lead ruling on
 * the #686 split, CLAIMS L61320): the destination IS a guarded directory, or
 * a path under one, decided by its name alone and with no listing. Normalised
 * lexically first (`.claude/x/..`, `./.claude/.` and `.claude//` are
 * `.claude`); each component, case folded, that is an
 * {@link ORGAN_DIRECTORIES} name (or, in a word the shell may still
 * glob, could match one, dot-names always: dotglob and globdots may be set
 * where the line cannot show it) takes that class.
 */
function organDestination(dest: string, inexact: (word: string) => boolean, glob: GlobReading): { surface: string; path: string } | null {
  if (mainRulesOnly) return null;
  const hit = organDestinationRule(dest, inexact, glob);
  if (hit !== null) markGlobWriteFired();
  return hit;
}

function organDestinationRule(dest: string, inexact: (word: string) => boolean, glob: GlobReading): { surface: string; path: string } | null {
  const { parts } = lexicalParts(dest);
  // `.git` is #683's git-dir rule's, which keeps its own rule id: a landing's
  // `.git` component is spelled in its source word, which that rule reads.
  const guarded = Object.entries(ORGAN_DIRECTORIES);
  let best: string | null = null;
  // The answer by names alone, for the record of whether a pattern raised it.
  let named: string | null = null;
  // Asked once for the whole word, not per component (review A686-FOLD2, M1:
  // per component it was quadratic in the destination's length).
  const liveDest = inexact(dest) && globLive(glob, dest);
  for (const part of parts) {
    if (part === "..") continue;
    const pattern =
      // Every organ directory is a dot-name, which a pattern may reach under
      // dotglob or globdots set where the line cannot show it (lead ruling,
      // CLAIMS L61492 and L61497): any globbed component is read against them.
      // The plain pass keeps the reading from before that ruling (an explicit
      // leading `.` or group, or a line that may set options), so what it
      // carries beside a raised class is what it carried before.
      liveDest && hasGlobConstruct(part) && (!glob.off || glob.options || part.startsWith(".") || /^[(]/u.test(part))
        ? globSegmentTokens(part, glob.options)
        : null;
    for (const [name, cls] of guarded) {
      const spelled = sameGuardedName(part, name);
      if (spelled && (named === null || protectedRank(cls) < protectedRank(named))) named = cls;
      const hit = spelled || (pattern !== null && globTokensMatch(pattern, name, false, glob.budget) !== false);
      if (hit && (best === null || protectedRank(cls) < protectedRank(best))) best = cls;
    }
  }
  // A pattern reading never takes a class away (review-b S1): where one
  // raised the answer, the plain pass is classified too and rides beside it.
  if (best !== named && glob.tracker !== undefined) glob.tracker.raised = true;
  return best === null ? null : { surface: best, path: dest };
}

/**
 * A PARENT of an organ directory (lead ruling, CLAIMS L61587: "a recursive
 * delete, move, rename or chmod whose target IS a guarded organ directory (or
 * a parent of one, up to the workspace root: rm -rf . counts) takes that
 * directory's strictest class"). The operands it reads: a recursive `rm`'s, a
 * `mv`'s sources, a recursive `chmod`'s files. `chown`, `chgrp`, `rename`,
 * `find -delete` and `git clean` are not read here (refused, or a follow-up).
 */
function organParentOperands(
  basename: string,
  args: readonly string[],
  positionals: readonly string[],
  plan: CopyPlan | null,
  assignments: readonly LexWord[] = [],
): string[] {
  const recursive = (...letters: string[]): boolean => hasFlag(args, ["--recursive"]) || hasShortFlag(args, letters);
  if (basename === "rm") return recursive("r", "R") ? [...positionals] : [];
  // `mv .`, `mv ./` and `mv sub/..` are refused by rename(2) (EINVAL in
  // bash, zsh and dash on macOS): a source whose last component is `.` or
  // `..` moves nothing, so only a parent spelled by name is read.
  if (basename === "mv") {
    return (plan?.sources ?? []).filter((source) => {
      const last = source.split("/").filter((part) => part.length > 0).pop();
      return last !== "." && last !== "..";
    });
  }
  if (basename === "chmod") return chmodFiles(args);
  // Security reviews of e9956c84 and 8fe15089: tools that delete what they
  // read, or every match they find. chown and chgrp have no rule and are
  // refused before this; were they classified, their files are every word
  // after the owner or group.
  if (basename === "chown" || basename === "chgrp") return positionals.slice(1);
  // find: any -delete, -exec, -execdir or -ok (a test narrows what it deletes
  // to what matches, which may be `.claude/settings.json`: fail closed).
  if (basename === "find") return args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg)) ? findStartPaths(args) : [];
  if (basename === "git") return gitRemovedPaths(args);
  // tar `--remove-files` (any unique prefix, `--rem` on), or an option from
  // the environment (`TAR_OPTIONS=` before it): every operand.
  if (basename === "tar") {
    const removes = args.some((arg) => /^--rem(?:o(?:v(?:e(?:-(?:f(?:i(?:l(?:es?)?)?)?)?)?)?)?)?$/u.test(arg.split("=")[0] as string));
    const fromEnvironment = assignments.some((word) => word.text.startsWith("TAR_OPTIONS="));
    return removes || fromEnvironment ? [...positionals, ...(plan?.anyName ?? [])] : [];
  }
  // rsync removing what it sent: its sources.
  if (basename === "rsync") {
    // `--remove-source-files`, the older `--remove-sent-files`, or any prefix
    // (openrsync on this Mac takes `--remov` and both spellings): fail closed.
    const removes = args.some((arg) => arg.startsWith("--remov"));
    return removes ? [...(plan?.sources ?? positionals)] : [];
  }
  // zip `-m` / `--move`: deletes what it archives.
  if (basename === "zip") return hasShortFlag(args, ["m"]) || hasFlag(args, ["--move"]) ? positionals.slice(1) : [];
  return [];
}

/**
 * What a `git rm` or `git clean` removes from the disk, fail closed (security
 * review of d3ecdd5e, 3). The subcommand is found past git's global options
 * (main refuses a valued one such as `-C`, `-c` or `--git-dir`, and one its
 * table does not know, so a line that reaches here has flags only). `git rm`
 * without `--cached` removes its pathspecs, `-r` or not (a symlink or a
 * submodule needs none); git expands a pathspec itself, so one with a glob
 * character or pathspec magic (`.cl*`, `:(glob).claude/**`) is `.`. With
 * `--cached` only the index changes: main's class. `git clean` removes
 * untracked files under its paths, `.` with none.
 */
export function gitRemovedPaths(args: readonly string[]): string[] {
  let at = 0;
  for (; at < args.length; at += 1) {
    const arg = args[at] as string;
    // Main refuses a global option that takes a value or that its table does
    // not know (gitGlobalRefusal), so a word here is a flag it knows.
    if (!arg.startsWith("-")) break;
  }
  const sub = args[at];
  if (sub !== "rm" && sub !== "clean") return [];
  // Each subcommand's options as `git <sub> -h` lists them on this Mac, spelled
  // in full (an abbreviation or an option not listed: `.`, fail closed). An
  // option is an option only before `--`; after it every word is a pathspec
  // (`git rm -r -- .claude --cached` removes `.claude` and a file `--cached`).
  const table =
    sub === "rm"
      ? { flags: "nqfr", valued: "", long: ["dry-run", "quiet", "cached", "force", "ignore-unmatch", "sparse", "pathspec-file-nul"], longValued: [] as string[] }
      : { flags: "dfinqxX", valued: "e", long: ["dry-run", "quiet", "force", "interactive"], longValued: ["exclude"] };
  const operands: string[] = [];
  let ended = false;
  let cached = false;
  let dryRun = false;
  const rest = args.slice(at + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (!ended && arg === "--") {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const full = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const negated = full.startsWith("no-") && (table.long.includes(full.slice(3)) || table.longValued.includes(full.slice(3)));
      const name = negated ? full.slice(3) : full;
      // Pathspecs read from a file: unknown, so `.`.
      if (sub === "rm" && name === "pathspec-from-file") {
        operands.push(".");
        if (eq === -1) index += 1;
        continue;
      }
      if (table.long.includes(name) && eq === -1) {
        if (name === "cached") cached = !negated;
        if (name === "dry-run") dryRun = !negated;
        continue;
      }
      if (table.longValued.includes(name) && !negated) {
        if (eq === -1) {
          if (index + 1 >= rest.length) return ["."];
          index += 1;
        }
        continue;
      }
      return ["."];
    }
    if (!ended && arg.startsWith("-") && arg.length > 1) {
      for (let letter = 1; letter < arg.length; letter += 1) {
        const char = arg[letter] as string;
        if (table.flags.includes(char)) {
          if (char === "n") dryRun = true;
          continue;
        }
        if (table.valued.includes(char)) {
          // `-e PAT` / `-ePAT`: an exclude pattern, never a path.
          if (letter === arg.length - 1) {
            if (index + 1 >= rest.length) return ["."];
            index += 1;
          }
          break;
        }
        return ["."];
      }
      continue;
    }
    operands.push(/[*?[]/u.test(arg) || arg.startsWith(":") ? "." : arg);
  }
  // A dry run removes nothing, and `--cached` only the index entries: main's class.
  if (dryRun) return [];
  if (sub === "rm") return cached ? [] : operands;
  return operands.length > 0 ? operands : ["."];
}

/**
 * find's start paths, fail closed (security review of d3ecdd5e, 1). Leading
 * options: BSD's `-E -X -d -s -x` and `-H -L -P` are skipped, `-f PATH` is a
 * start path, GNU's `-D OPTS` takes a value and `-O<n>` none. Then the words
 * before the expression. No start path means `.` to GNU find (this Mac's
 * /usr/bin/find, BSD, refuses it, as it refuses `-D` and `-O`: checked in a
 * fixture), so it is `.`; a leading option this list does not know may change
 * what is a path: `.`, the strict answer.
 */
function findStartPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  let at = 0;
  for (; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") {
      at += 1;
      break;
    }
    if (!arg.startsWith("-") || arg.length < 2) break;
    if (/^-[EXdsxHLP]+$/u.test(arg)) continue;
    if (arg === "-f" || arg === "-D") {
      const value = args[at + 1];
      if (value === undefined) return ["."];
      if (arg === "-f") paths.push(value);
      at += 1;
      continue;
    }
    if (/^-O\d*$/u.test(arg)) continue;
    // An expression primary (`-delete`, `-name`): the paths are over.
    if (FIND_PRIMARY.test(arg)) break;
    return ["."];
  }
  for (; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg.startsWith("-") || arg === "(" || arg === "!") break;
    paths.push(arg);
  }
  return paths.length === 0 ? ["."] : paths;
}

/** A find expression word: a primary or an operator, never a leading option. */
const FIND_PRIMARY = /^-(?:[a-z]{2,}|a|o)$/u;

/**
 * chmod's files (security review of the parents rule, 1): its options are
 * `-R`, `-c`, `-f`, `-v`, `-h`, `-H`, `-L`, `-P` and long `--…` ones; the
 * first other word is the mode even when it starts with `-` (`chmod -R -w .`)
 * unless `--reference=` gives it, and every word after is a file. A chmod of a
 * parent counts with or without `-R`: `chmod 000 .` locks every organ
 * directory below it, as `chmod 000 .claude` locks that one.
 */
function chmodFiles(args: readonly string[]): string[] {
  const files: string[] = [];
  let mode = hasFlag(args, ["--reference"]);
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === "--") {
      ended = true;
      continue;
    }
    if (!ended && (arg.startsWith("--") || /^-[RcfvhHLP]+$/u.test(arg))) continue;
    if (!mode) {
      mode = true;
      continue;
    }
    files.push(arg);
  }
  return files;
}

/** The most directories on one parent's chain that are listed before the parent is judged strict. */
const ORGAN_PARENT_CHAIN_CAP = 8;

/**
 * Is `operand` the working directory, an ancestor of it, the home or an
 * ancestor of the home (`.`, `./`, `sub/..`, `..`, `$PWD`, `"$PWD"`, `$(pwd)`,
 * `~`, `~/`, `$HOME`, `/`)? `null` when it is not such a word, or not one the
 * text can tell (any other variable or substitution, a glob: their own rules
 * answer). Otherwise the absolute directories whose listings decide (the
 * operand and every directory from it down to the working directory or home
 * it holds), or `"unplaced"` when the caller cannot place or list them.
 */
function organParentDirs(operand: string, pwdWord: boolean, disk: GlobDisk | undefined): string[] | "unplaced" | null {
  let base: "cwd" | "home" | "root";
  let rest: string;
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/u.exec(operand);
  const pwd = /^(?:\$PWD|\$\{PWD\})(?=\/|$)/u.exec(operand);
  if (home !== null) [base, rest] = ["home", operand.slice(home[0].length)];
  else if (pwd !== null) [base, rest] = ["cwd", operand.slice(pwd[0].length)];
  else if (pwdWord && operand.startsWith(SUBSTITUTION_SENTINEL)) [base, rest] = ["cwd", operand.slice(SUBSTITUTION_SENTINEL.length)];
  else if (operand.startsWith("/")) [base, rest] = ["root", operand];
  else [base, rest] = ["cwd", operand];
  // Normalise lexically: `.` and empty parts go, a `..` removes the part
  // before it. A word the text cannot read (`$X`, `"$X"`, `${X}`, `$OLDPWD`,
  // a substitution, `~user`) may itself hold `..` or be the working
  // directory or the home (security review, 4 and 5). So: a `..` that would
  // remove such a word, or such a word (or a glob after one) last, leaves the
  // target unknown: fail closed. A readable name after it (`$X/dist`,
  // `"$TMPDIR"/x`) is not the directory itself: not judged here, as on main.
  const unreadable = (part: string): boolean =>
    /[$`]/u.test(part) || part.includes(SUBSTITUTION_SENTINEL) || part.includes(PARAMETER_MARK);
  const globbed = (part: string): boolean => /[*?[\]{}~]/u.test(part);
  const parts = rest.split("/");
  // `~user` leads to a home, maybe this one: a word the text cannot read.
  if (base === "cwd" && /^~[^/]/u.test(parts[0] ?? "")) parts[0] = "$~user";
  const stack: string[] = [];
  // A `..` that removes a name (`link/..`): the kernel applies it after it
  // follows the name if that is a symlink, so the text alone cannot place it.
  let poppedName = false;
  for (const segment of parts) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." && stack.length > 0 && stack[stack.length - 1] !== "..") {
      if (unreadable(stack.pop() as string)) return "unplaced";
      poppedName = true;
    } else if (segment === ".." && base === "root") continue;
    else stack.push(segment);
  }
  const firstUnread = stack.findIndex(unreadable);
  if (firstUnread >= 0) {
    const last = stack[stack.length - 1] as string;
    if (unreadable(last) || stack.slice(firstUnread + 1).some(globbed)) return "unplaced";
    return null;
  }
  // A glob that names what a directory holds (`dist/*`) is the glob rule's.
  if (stack.some(globbed)) return null;
  // Leading `..`s, then the names after them (security review, 2: `../w`,
  // `~/../other`). Names with no `..` before them stay inside the working
  // directory or the home (`./dist`, `~/build`): not a parent.
  let ups = 0;
  while (ups < stack.length && stack[ups] === "..") ups += 1;
  const names = stack.slice(ups);
  // Without the caller's disk: the working directory, the home, their
  // ancestors and `/` are parents of an organ directory the text cannot rule
  // out, and so is a path with a `..` after a name (security review, 7); any
  // other absolute path is not judged here.
  if (!poppedName && base !== "root" && ups === 0 && names.length > 0) return null;
  if (disk === undefined) return !poppedName && base === "root" && stack.length > 0 ? null : "unplaced";
  let target: string;
  let from = "";
  if (base === "root") {
    target = `/${stack.join("/")}`;
  } else {
    const start = base === "home" ? (disk.homeOk === false ? null : disk.home) : disk.relativeOk === false ? null : disk.cwd;
    if (start === null || !start.startsWith("/")) return "unplaced";
    from = start;
    const parts = from.split("/").filter((part) => part.length > 0);
    target = `/${[...parts.slice(0, Math.max(0, parts.length - ups)), ...names].join("/")}`;
  }
  const under = (dir: string, top: string): boolean => dir === top || top === "/" || dir.startsWith(`${top}/`);
  // Paths compare by the shared fold too (#688: one fold): folded in the
  // folded reading, exactly as spelled in the other (review-b A686-FOLD5 M1).
  const fold = (path: string): string => foldNameExact(path);
  const sides = [disk.relativeOk === false ? null : disk.cwd, disk.homeOk === false ? null : disk.home].filter(
    (dir): dir is string => dir !== null && dir.startsWith("/"),
  );
  const canonical = (path: string): string | null => {
    const resolved = disk.listings.get(realpathKey(path));
    return Array.isArray(resolved) && typeof resolved[0] === "string" && resolved[0].startsWith("/") ? resolved[0] : null;
  };
  if (poppedName) {
    // Placed by the hook's resolution of the operand AS WRITTEN (the kernel's
    // reading, `..` after the symlink it follows), not by the text's. Not
    // resolved: fail closed. Holding neither the working directory nor the
    // home: judged by its own listing, read through the same spelling. Holding
    // one: only when it is the directory the text names, else fail closed.
    if (base === "root" && (disk.relativeOk === false || disk.homeOk === false)) return "unplaced";
    const written = base === "root" ? rest : `${from}/${rest.replace(/^\/+/u, "")}`;
    disk.collect?.add(written);
    disk.collect?.add(target);
    const physical = canonical(written);
    const physicalSides = sides.map(canonical);
    if (physical === null || physicalSides.some((dir) => dir === null)) return "unplaced";
    if (!physicalSides.some((dir) => dir !== null && under(fold(dir), fold(physical)))) {
      return disk.listingsOk === false ? "unplaced" : [written];
    }
    const lexical = canonical(target);
    if (lexical === null || fold(lexical) !== fold(physical)) return "unplaced";
    if (base !== "root" && ups === 0 && names.length > 0) return null;
  }
  const places = sides.filter((dir) => under(dir, target));
  if (places.length === 0) {
    // A path that holds neither the working directory nor the home as
    // written may still hold one by another spelling (security review, 6):
    // another letter case on a case-insensitive volume (`/Users/Me/Proj`
    // for /Users/me/proj), or a symlink on the way (`/tmp/x` for
    // /private/tmp/x). The chain cannot be named then: fail closed. It is
    // elsewhere only when the canonical paths the hook resolved (keyed by
    // {@link realpathKey}) show it, compared with letter case folded too;
    // then it is judged by its own listing (a sibling, `../other-project`;
    // `/tmp/build`). Without them nothing shows it: fail closed.
    if (base === "root" && (disk.relativeOk === false || disk.homeOk === false)) return "unplaced";
    disk.collect?.add(target);
    const canonicalTarget = canonical(target);
    const canonicalSides = sides.map(canonical);
    if (canonicalTarget === null || canonicalSides.some((dir) => dir === null)) return "unplaced";
    if (canonicalSides.some((dir) => dir !== null && under(fold(dir), fold(canonicalTarget)))) return "unplaced";
    return disk.listingsOk === false ? "unplaced" : [target];
  }
  if (disk.listingsOk === false) return "unplaced";
  const dirs = new Set<string>([target]);
  for (const place of places) {
    const below = place.slice(target === "/" ? 1 : target.length + 1).split("/").filter((part) => part.length > 0);
    let at = target === "/" ? "" : target;
    for (const part of below) {
      at = `${at}/${part}`;
      dirs.add(at);
    }
  }
  return dirs.size > ORGAN_PARENT_CHAIN_CAP ? "unplaced" : [...dirs];
}

let guardedSpellings: Map<string, string[]> | null = null;

/** The guarded spellings by their case-folded form, built once (a listing may hold 2,000 names). */
function guardedSpellingsByFold(): Map<string, string[]> {
  if (guardedSpellings !== null) return guardedSpellings;
  const map = new Map<string, string[]>();
  for (const spelling of [...Object.keys(ORGAN_DIRECTORIES), ...GLOB_GUARD_NAMES, ...CORE_FILENAMES, ...PROTECTED_FILENAMES]) {
    // Candidates by the full fold, the same in both readings; each is then
    // compared in the current reading by sameGuardedName.
    const key = foldFileName(spelling);
    map.set(key, [...(map.get(key) ?? []), spelling]);
  }
  guardedSpellings = map;
  return map;
}

/**
 * The class a listed name gives the directory that holds it: an organ
 * directory ({@link ORGAN_DIRECTORIES}), a guarded name the path rule knows
 * (`.approval`, `.codex`, `.hermes`, `APPROVAL.md`, `CLAUDE.md`, ...), or `.git`
 * (`vcs.history.rewrite`, the git-dir rule's). The table is read directly, so
 * the parent rule does not depend on how the bare-directory rule is scoped.
 */
function guardedEntryClass(
  name: string,
  protectedPaths: readonly ProtectedPathEntry[],
  dir = "",
): { protectedClass: string | null; classes: string[]; git: boolean } {
  // Every guarded spelling that is this name in the current reading (security
  // review, 3; #688; review-b A686-FOLD5 M1): folded, `.Claude` and
  // `.mu<U+017F>e` are the guarded names, as APFS opens them; as spelled they
  // are other names, so the segment's own class answers there too.
  const spellings = [name, ...(guardedSpellingsByFold().get(foldFileName(name)) ?? []).filter((spelling) => sameGuardedName(spelling, name))];
  let best: string | null = null;
  const classes: string[] = [];
  const add = (cls: string | null): void => {
    if (cls === null) return;
    if (!classes.includes(cls)) classes.push(cls);
    if (best === null || protectedRank(cls) < protectedRank(best)) best = cls;
  };
  for (const spelling of spellings) {
    const organ = Object.hasOwn(ORGAN_DIRECTORIES, spelling) ? (ORGAN_DIRECTORIES[spelling] as string) : null;
    // The name's own class, then (lead ruling L62013, S1) the class of every
    // guarded path inside the folder it names, routed ones included: a parent
    // takes the classes of the folders it holds, each by that rule.
    const own = protectedPathClassOfWordAlone(spelling, protectedPaths);
    add(organ);
    add(own);
    const first = own ?? organ;
    if (first !== null) for (const cls of folderContentClaims(`${dir.replace(/\/+$/u, "")}/${spelling}`, first, protectedPaths)) add(cls);
  }
  return { protectedClass: best, classes, git: sameGuardedName(name, ".git") };
}

/**
 * The parent rule for one segment: the strictest protected class among the
 * operands that are parents of an organ directory (`path` the operand), and
 * the operands whose directories hold only `.git` (judged by the git-dir rule).
 * A parent the caller cannot place or list is `policy.core`, fail closed; one
 * whose listings hold no guarded name keeps the segment's own class.
 */
function organParentClass(
  operands: readonly string[],
  words: readonly LexWord[],
  protectedPaths: readonly ProtectedPathEntry[],
  disk: GlobDisk | undefined,
): { named: { surface: string; path: string } | null; git: Set<string> } {
  let named: { surface: string; path: string } | null = null;
  const git = new Set<string>();
  // Every class a held folder gives (lead ruling L62013, S1): the classifier
  // cannot rank routed classes, so each is a claim and the gate judges all.
  const claims: string[] = [];
  const offer = (surface: string, path: string): void => {
    if (!claims.includes(surface)) claims.push(surface);
    if (named === null || protectedRank(surface) < protectedRank(named.surface)) named = { surface, path };
  };
  for (const operand of operands) {
    // `$(pwd)`, `$(pwd -P)`, `$(builtin pwd)`, `$(command pwd -L)` (security review, 4).
    const pwdWord = words.some(
      (word) => word.text === operand && word.substitutions.length === 1 && /^(?:(?:builtin|command)\s+)?pwd(?:\s+-[LP]+)*$/u.test(word.substitutions[0]?.trim() ?? ""),
    );
    const dirs = organParentDirs(operand, pwdWord, disk);
    if (dirs === null) continue;
    if (dirs === "unplaced" || disk === undefined) {
      offer("policy.core", operand);
      continue;
    }
    for (const dir of dirs) {
      disk.collect?.add(dir);
      // A directory that is not there holds nothing, on a line where nothing before it may make it.
      const listing = diskListing(disk, dir, true);
      if (listing === undefined) {
        offer("policy.core", operand);
        continue;
      }
      for (const name of listing) {
        const entry = guardedEntryClass(name, protectedPaths, dir);
        for (const cls of entry.classes) offer(cls, operand);
        if (entry.git) git.add(operand);
      }
    }
  }
  const strictest = named as { surface: string; path: string } | null;
  if (strictest === null || claims.length <= 1) return { named: strictest, git };
  const ordered = [strictest.surface, ...claims.filter((cls) => cls !== strictest.surface)];
  return { named: { surface: takeAmongEqual(ordered), path: strictest.path }, git };
}

/**
 * How one copy, move, link or sync tool reads its argv (review of 039b840a,
 * finding 2): which short letters and long options it knows, and which take a
 * value. A letter one platform reads as a flag and another as taking a value
 * is `ambiguous`. GNU accepts a unique prefix of a long option.
 */
interface CopyOptionTable {
  short: string;
  shortValue: string;
  ambiguous: string;
  long: Readonly<Record<string, "none" | "req" | "opt">>;
  /** rsync: `--no-OPTION` for any option it knows. */
  negates?: boolean;
}

const COPY_LONG_COMMON: Readonly<Record<string, "none" | "req" | "opt">> = {
  backup: "opt",
  force: "none",
  interactive: "none",
  suffix: "req",
  "target-directory": "req",
  "no-target-directory": "none",
  verbose: "none",
  help: "none",
  version: "none",
  debug: "none",
};

const COPY_OPTION_TABLES: Readonly<Record<string, CopyOptionTable>> = {
  // GNU and BSD cp; `-S` is GNU's suffix and not every BSD's.
  cp: {
    short: "abcdfHiLlNnPpRrsTuvXxZ",
    shortValue: "t",
    ambiguous: "S",
    long: {
      ...COPY_LONG_COMMON,
      archive: "none",
      "attributes-only": "none",
      "copy-contents": "none",
      dereference: "none",
      link: "none",
      "no-dereference": "none",
      "no-clobber": "none",
      "no-preserve": "req",
      parents: "none",
      preserve: "opt",
      recursive: "none",
      reflink: "opt",
      "remove-destination": "none",
      sparse: "req",
      "strip-trailing-slashes": "none",
      "symbolic-link": "none",
      update: "opt",
      "one-file-system": "none",
      context: "opt",
      "keep-directory-symlink": "none",
    },
  },
  mv: {
    short: "bfhinTuvZ",
    shortValue: "St",
    ambiguous: "",
    long: {
      ...COPY_LONG_COMMON,
      "no-clobber": "none",
      "no-copy": "none",
      "strip-trailing-slashes": "none",
      update: "opt",
      context: "none",
      exchange: "none",
    },
  },
  ln: {
    short: "bdFfhiLnPrsTvw",
    shortValue: "St",
    ambiguous: "",
    long: {
      ...COPY_LONG_COMMON,
      directory: "none",
      logical: "none",
      "no-dereference": "none",
      physical: "none",
      relative: "none",
      symbolic: "none",
    },
  },
  // GNU and BSD install: `-S` and `-T` take a value on one and not the other.
  install: {
    short: "bcCdDMpsUvZ",
    shortValue: "BfglmNot",
    ambiguous: "ST",
    long: {
      ...COPY_LONG_COMMON,
      compare: "none",
      directory: "none",
      group: "req",
      mode: "req",
      owner: "req",
      "preserve-timestamps": "none",
      strip: "none",
      "strip-program": "req",
      "preserve-context": "none",
      context: "opt",
    },
  },
  rsync: {
    short: "vqcarRbulLkKHpEAXogDtUNOJmnWxCySzPhi8s0Fd46I",
    shortValue: "efTBM@",
    ambiguous: "",
    negates: true,
    long: {
      ...Object.fromEntries(
        [
          "verbose", "quiet", "no-motd", "checksum", "archive", "recursive", "relative", "no-implied-dirs", "backup",
          "update", "inplace", "append", "append-verify", "dirs", "mkpath", "links", "copy-links", "copy-unsafe-links",
          "safe-links", "munge-links", "copy-dirlinks", "keep-dirlinks", "hard-links", "perms", "executability", "acls",
          "xattrs", "owner", "group", "devices", "copy-devices", "write-devices", "specials", "times", "atimes",
          "open-noatime", "crtimes", "omit-dir-times", "omit-link-times", "super", "fake-super", "sparse", "preallocate",
          "dry-run", "whole-file", "one-file-system", "existing", "ignore-existing", "remove-source-files", "delete",
          "delete-before", "delete-during", "delete-delay", "delete-after", "delete-excluded", "ignore-missing-args",
          "delete-missing-args", "ignore-errors", "force", "partial", "progress", "delay-updates", "prune-empty-dirs",
          "numeric-ids", "ignore-times", "size-only", "compress", "cvs-exclude", "from0", "protect-args",
          "secluded-args", "trust-sender", "stats", "8-bit-output", "human-readable", "itemize-changes", "list-only",
          "blocking-io", "fuzzy", "old-args", "old-dirs", "ipv4", "ipv6", "help", "version", "fsync", "copy-as",
        ].map((name) => [name, "none" as const]),
      ),
      ...Object.fromEntries(
        [
          "rsh", "rsync-path", "filter", "exclude", "include", "exclude-from", "include-from", "files-from", "temp-dir",
          "partial-dir", "backup-dir", "suffix", "compare-dest", "copy-dest", "link-dest", "block-size", "max-size",
          "min-size", "max-delete", "timeout", "contimeout", "port", "sockopts", "chmod", "chown", "usermap", "groupmap",
          "log-file", "log-file-format", "out-format", "password-file", "bwlimit", "write-batch", "only-write-batch",
          "read-batch", "protocol", "iconv", "checksum-choice", "compress-choice", "compress-level", "skip-compress",
          "remote-option", "info", "debug", "stop-after", "stop-at", "modify-window", "address", "outbuf",
          "max-alloc", "checksum-seed", "early-input",
        ].map((name) => [name, "req" as const]),
      ),
      "copy-as": "req",
    },
  },
  scp: { short: "346ABCOpqRrTv", shortValue: "cDFiJlmoPSX", ambiguous: "", long: {} },
};

/** What {@link parseCopyArgv} read: the operands, the options seen by name, their values, and the first option it does not know. */
interface CopyArgv {
  operands: string[];
  seen: Set<string>;
  values: { name: string; value: string }[];
  unknown: string | null;
}

/**
 * A copy tool's argv read by its {@link CopyOptionTable} (review of 039b840a,
 * finding 2): an option's value is never an operand (`rsync -a src/ .claude/
 * --exclude x` writes `.claude/`, not `x`). An option the table does not know,
 * an ambiguous long prefix and an ambiguous letter are `unknown`: the caller
 * then takes every operand as a possible destination.
 */
function parseCopyArgv(args: readonly string[], table: CopyOptionTable): CopyArgv {
  const operands: string[] = [];
  const seen = new Set<string>();
  const values: { name: string; value: string }[] = [];
  let unknown: string | null = null;
  const flag = (word: string): void => {
    if (unknown === null) unknown = word;
  };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (table.negates === true && name.startsWith("no-") && table.long[name] === undefined && table.long[name.slice(3)] !== undefined) {
        seen.add(name);
        if (eq !== -1) flag(arg);
        continue;
      }
      const names = Object.keys(table.long);
      const matches = table.long[name] !== undefined ? [name] : names.filter((candidate) => candidate.startsWith(name));
      if (name.length === 0 || matches.length !== 1) {
        flag(arg);
        continue;
      }
      name = matches[0] as string;
      const kind = table.long[name] as "none" | "req" | "opt";
      seen.add(name);
      if (eq !== -1) {
        if (kind === "none") flag(arg);
        values.push({ name, value: arg.slice(eq + 1) });
      } else if (kind === "req") {
        const value = args[at + 1];
        if (value !== undefined) values.push({ name, value });
        at += 1;
      }
      continue;
    }
    for (let k = 1; k < arg.length; k += 1) {
      const letter = arg[k] as string;
      if (table.shortValue.includes(letter)) {
        seen.add(letter);
        const rest = arg.slice(k + 1);
        if (rest.length > 0) values.push({ name: letter, value: rest });
        else {
          const value = args[at + 1];
          if (value !== undefined) values.push({ name: letter, value });
          at += 1;
        }
        break;
      }
      if (table.short.includes(letter)) seen.add(letter);
      else flag(arg);
    }
  }
  return { operands, seen, values, unknown };
}

/**
 * Where a copy, move, link, sync or extraction may put names its text does not
 * show (review of b402adec M2; review of 039b840a findings 1 to 3):
 *
 * - `dests`, `sources`: each source lands as `<dest>/<basename>` ({@link copyLandings});
 * - `anyName`: a directory any name may land in, judged by
 *   {@link organDestination} (a guarded directory itself, or under one);
 * - `files`: files an option writes (`rsync --log-file`).
 *
 * A contents copy or extraction into an ORDINARY directory, or into an
 * ancestor of a guarded one (`tar -xf a.tar`, `cp -r src/. .`), keeps main's
 * class here: its names come from its source, which is the follow-up's
 * question (lead ruling on the #686 split, CLAIMS L61320).
 *
 * An option a tool's table does not know makes every operand each of these.
 * `null` for a command that is none of these tools.
 */
interface CopyPlan {
  dests: string[];
  sources: string[];
  anyName: string[];
  /** The destination is implied (`ln -s target` links into `.`). */
  implicitDest?: boolean;
  /**
   * The copy may keep each source's path under the destination (`cp
   * --parents`, rsync's `-R`/`--relative` anywhere on the line, with a `/./`
   * cutting the kept path): `<dest>/<the source's relative path>` is judged
   * beside the basename landing (reviews of 8e1e84ae (3) and 4f0169ec).
   */
  preserve?: boolean;
  files: string[];
  unknown: string | null;
  operands: string[];
}

/**
 * Archive and copy tools this classifier has no argv table for (most have no
 * rule and are refused): every operand and option value is a possible
 * destination of any name (finding 3, the backstop).
 */
const UNTABLED_COPY_TOOLS: ReadonlySet<string> = new Set([
  "unzip", "ditto", "cpio", "pax", "bsdtar", "gtar", "star", "7z", "7za", "7zr", "7zz", "unar", "unrar", "xar", "jar",
  "ar", "rclone", "gcp", "gmv", "gln", "ginstall", "sftp", "lftp", "unxz", "bsdcpio", "rpm2cpio", "dpkg-deb", "lha",
]);

/** A `host:path` rsync or scp operand names a remote path, never a local one. */
function remoteOperand(word: string): boolean {
  return /^[^/]*:/u.test(word);
}

function copyPlan(basename: string, args: readonly string[]): CopyPlan | null {
  const empty = (operands: string[]): CopyPlan => ({ dests: [], sources: [], anyName: [], files: [], unknown: null, operands });
  if (basename === "tar") return tarPlan(args);
  if (UNTABLED_COPY_TOOLS.has(basename)) {
    const words = args.flatMap((arg) => {
      if (!arg.startsWith("-")) return [arg];
      const eq = arg.indexOf("=");
      if (eq !== -1) return [arg.slice(eq + 1)];
      // An attached short value (`-o.claude`, `-d.claude`): every tail counts.
      return arg.startsWith("--") ? [] : Array.from({ length: arg.length - 2 }, (_, k) => arg.slice(k + 2));
    });
    return { ...empty(words), anyName: [...words], unknown: basename };
  }
  const table = COPY_OPTION_TABLES[basename];
  if (table === undefined) return null;
  const parsed = parseCopyArgv(args, table);
  const remote = basename === "rsync" || basename === "scp";
  const operands = parsed.operands;
  const local = (words: readonly string[]): string[] => (remote ? words.filter((word) => !remoteOperand(word)) : [...words]);
  if (basename === "install" && (parsed.seen.has("d") || parsed.seen.has("directory"))) return empty(operands);
  const targets = parsed.values.filter((entry) => entry.name === "t" || entry.name === "target-directory").map((entry) => entry.value);
  if (parsed.unknown !== null) {
    const all = local([...operands, ...targets]);
    return { dests: all, sources: [...operands], anyName: [...all], files: [], unknown: parsed.unknown, operands };
  }
  // rsync with one operand lists it; every tool needs a source and a destination.
  // Review of e6b7bf97 (1): `ln TARGET` links into the working directory,
  // named by the target's basename.
  const implicit = basename === "ln" && targets.length === 0 && operands.length === 1;
  const dests = implicit ? ["."] : local(targets.length > 0 ? targets : operands.length >= 2 ? operands.slice(-1) : []);
  const sources = targets.length > 0 || implicit ? [...operands] : operands.slice(0, -1);
  // Lead ruling on the split (L61320): a copy, move, link or sync INTO a
  // guarded directory is judged by the directory's name alone, whatever it
  // copies.
  const has = (...names: string[]): boolean => names.some((name) => parsed.seen.has(name));
  // Review of 4f0169ec (1, 2): rsync's relative mode follows option order
  // (`--no-relative` after `-R` turns it off) and a `/./` matters only with it
  // on. Wherever it may be on, the path-preserving landing is judged BESIDE
  // the basename landing, which is always judged: the stricter answers.
  const preserve = (basename === "cp" && has("parents")) || (basename === "rsync" && has("R", "relative"));
  const plan: CopyPlan = {
    ...empty(operands),
    dests,
    sources,
    anyName: [...dests],
    ...(implicit ? { implicitDest: true } : {}),
    ...(preserve ? { preserve: true } : {}),
  };
  if (basename === "rsync") {
    // Directories rsync writes any name into; relative ones are relative to the destination.
    for (const entry of parsed.values) {
      if (!["T", "temp-dir", "partial-dir", "backup-dir"].includes(entry.name)) continue;
      plan.anyName.push(entry.value);
      if (!entry.value.startsWith("/")) for (const dest of dests) plan.anyName.push(`${dest.replace(/\/+$/u, "")}/${entry.value}`);
    }
    plan.files = parsed.values.filter((entry) => ["log-file", "write-batch", "only-write-batch"].includes(entry.name)).map((entry) => entry.value);
  }
  return plan;
}

/**
 * tar's extraction destinations in every spelling GNU tar and bsdtar accept
 * (finding 3): `-C DIR`, `-CDIR`, a cluster ending in `C` or carrying it with
 * its value attached, `--directory`/`--cd` by any prefix with or without `=`,
 * and the dashless first-word bundle (`tar xCf .claude a.tar`), whose letters
 * take the following words in order: a bundle carrying `C` and other value
 * letters offers each of those words. An extraction with no `-C` writes into
 * the working directory, an ordinary place: main's class (the follow-up's).
 */
const TAR_ALL_VALUE_LETTERS = "bfgCFHIKLNTVX";
function tarPlan(args: readonly string[]): CopyPlan {
  const letters = tarModeLetters(args);
  const extracting = letters.includes("x") || args.some((arg) => /^--(?:ex|ext|extr|extra|extrac|extract|get?)$/u.test(arg));
  const plan: CopyPlan = { dests: [], sources: [], anyName: [], files: [], unknown: null, operands: [] };
  if (!extracting) return plan;
  const dirs: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (name === "cd" || (name.length >= 2 && "directory".startsWith(name))) {
        const value = eq === -1 ? args[at + 1] : arg.slice(eq + 1);
        if (value !== undefined) dirs.push(value);
      }
      continue;
    }
    const bundle = arg.startsWith("-") ? arg.slice(1) : at === 0 && /^[A-Za-z]+$/u.test(arg) ? arg : null;
    if (bundle === null || bundle.length === 0) continue;
    const c = bundle.indexOf("C");
    if (c === -1) continue;
    if (arg.startsWith("-") && c + 1 < bundle.length && !/^[A-Za-z]*$/u.test(bundle.slice(c + 1))) {
      dirs.push(bundle.slice(c + 1));
      continue;
    }
    // Attached letters may be a value (`-C.claude` is above; `-xCclaude`) or more
    // letters; every reading counts.
    if (arg.startsWith("-") && c + 1 < bundle.length) dirs.push(bundle.slice(c + 1));
    const takers = [...bundle].filter((letter) => TAR_ALL_VALUE_LETTERS.includes(letter)).length;
    for (let k = 1; k <= takers; k += 1) {
      const next = args[at + k];
      if (next !== undefined) dirs.push(next);
    }
  }
  plan.anyName = [...dirs];
  return plan;
}

/**
 * A path normalised lexically (finding 1): empty and `.` components dropped,
 * `name/..` collapsed. `null` for a word that does not name one path (a
 * variable, a substitution, a pattern the shell may still glob).
 */
function lexicalParts(path: string): { absolute: boolean; parts: string[] } {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== ".." && parts[parts.length - 1] !== "~") {
      parts.pop();
      continue;
    }
    if (part === ".." && absolute) continue;
    parts.push(part);
  }
  return { absolute, parts };
}

/**
 * The files a `cp`, `mv`, `ln` or `install` would create inside a directory
 * destination (lead ruling L61195 (b)): `<dest>/<basename>` for each source,
 * the destination being every `-t` directory, or else the last operand. A
 * source the shell may still glob is expanded from the caller's listing of
 * its own directory where there is one (`plain`), and otherwise judged as a
 * pattern under the destination (`patterns`, read with no listing: the names
 * come from the source, not the destination). `install -d` creates
 * directories only. Lexical: whether the destination IS a directory is not
 * asked; a file destination makes a path that names nothing new.
 */
function copyLandings(
  plan: CopyPlan,
  inexact: (word: string) => boolean,
  glob: GlobReading,
): { plain: string[]; patterns: string[] } | null {
  if (mainRulesOnly) return null;
  const { dests, sources } = plan;
  if (dests.length === 0 || sources.length === 0) return null;
  const plain: string[] = [];
  const patterns: string[] = [];
  for (const source of sources) {
    // rsync and scp: `host:path` lands by the path's basename.
    const local = source.replace(/^[^/]*:/u, "");
    if (plan.preserve === true) {
      // `cp --parents a/b d` makes `d/a/b`; rsync `-R` keeps the path after a
      // `/./` (else the whole path), a leading `/` dropped.
      const cut = local.indexOf("/./");
      const kept = (cut === -1 ? local : local.slice(cut + 3)).replace(/^\/+/u, "");
      for (const dest of dests) {
        const into = dest.replace(/\/+$/u, "");
        const landing = `${into}/${kept}`;
        if (inexact(source) && globLive(glob, source) && hasGlobConstruct(kept)) patterns.push(landing);
        else plain.push(landing);
        // A destination the shell may still glob is a pattern too (review of 4f0169ec, 3).
        if (inexact(dest) && globLive(glob, dest) && hasGlobConstruct(into)) patterns.push(landing);
      }
    }
    const parts = local.split("/").filter((part) => part.length > 0);
    const base = parts[parts.length - 1];
    if (base === undefined || base === "." || base === "..") continue;
    const globbed = inexact(source) && globLive(glob, source) && hasGlobConstruct(base);
    const listed = globbed ? listedMatches(source, base, glob) : null;
    for (const dest of dests) {
      const into = dest.replace(/\/+$/u, "");
      // A destination the shell may still glob is a pattern too.
      if (inexact(dest) && globLive(glob, dest) && hasGlobConstruct(into)) patterns.push(`${into}/${base}`);
      if (!globbed) plain.push(`${into}/${base}`);
      else if (listed !== null) for (const name of listed) plain.push(`${into}/${name}`);
      else patterns.push(`${into}/${base}`);
    }
  }
  // Where a file lands is GLOB-WRITE's reading (main judges the destination
  // as written): the main pass joins the line.
  if (plain.length > 0 || patterns.length > 0) markGlobWriteFired();
  return { plain, patterns };
}

/**
 * The names in a source pattern's own directory that its last component
 * matches, from the caller's listing (GLOB-WRITE, L61167), or `null` when
 * there is no listing to read (the pattern is then judged as a pattern).
 */
function listedMatches(source: string, base: string, glob: GlobReading): string[] | null {
  const disk = glob.disk;
  if (disk === undefined || disk.listingsOk === false) return null;
  const segments = source.split("/");
  const prefix = segments.slice(0, -1);
  if (prefix.some((segment) => hasGlobConstruct(segment))) return null;
  const dir = globListingDir(prefix, disk);
  if (dir === null) return null;
  disk.collect?.add(dir);
  const listing = diskListing(disk, dir, true);
  if (listing === undefined) return null;
  const pattern = globSegmentTokens(base, glob.options);
  const out: string[] = [];
  // Dot-names too: dotglob or globdots may be set where the line cannot show
  // it (lead ruling, CLAIMS L61492 and L61497). A listing holds no `.` or `..`.
  for (const name of listing) {
    const hit = globTokensMatch(pattern, name, false, glob.budget);
    if (hit === null) return null;
    if (hit) out.push(name);
  }
  return out;
}

/** The private-use character {@link maskParameters} marks a placeholder with. */
const PARAMETER_MARK = "";

/**
 * Could the shell still glob part of this reading? Any of `*`, `?`, `[`, zsh's
 * `(…)`, `#`, `^`, `<…>`, `|`, a brace (one {@link braceCandidates} leaves is
 * zsh's `braceccl` class), or a `~` after the first character (zsh's
 * exclusion), outside a `${…}` parameter expansion, whose operators are not a
 * pattern on the path (its default text is a reading of its own,
 * {@link writeWordReadings}). Read on the dequoted text, so a quoted
 * metacharacter in a word that is otherwise inexact counts too: the stricter
 * reading. A word holding {@link PARAMETER_MARK} counts, and fails closed.
 */
function hasGlobConstruct(word: string): boolean {
  if (word.includes(PARAMETER_MARK)) return true;
  const outside = maskParameters(word).text;
  return /[*?[\]{}()#^<>|]/u.test(outside) || outside.slice(1).includes("~");
}

/**
 * Read on a word's SOURCE spelling: does it expand a special parameter, and is
 * every `$` in it a real expansion (none inside single quotes, escaped by a
 * backslash, or opening `$'…'`)? Only then may {@link maskSpecialParameters}
 * read the character after each `$` in its text as a name.
 */
function specialParametersOnly(raw: string): boolean {
  let quote: "" | "'" | '"' = "";
  let special = false;
  for (let at = 0; at < raw.length; at += 1) {
    const ch = raw[at] as string;
    if (quote === "'") {
      if (ch === "'") quote = "";
      else if (ch === "$") return false;
      continue;
    }
    if (ch === "\\") {
      if (raw[at + 1] === "$") return false;
      at += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = "";
      continue;
    }
    if (quote === "" && (ch === "'" || ch === '"')) {
      quote = ch;
      continue;
    }
    if (ch === "$") {
      const next = raw[at + 1];
      // `$'…'`, `$"…"`, `$\x`, a `$` at the end: not an expansion of a name.
      if (next === undefined || !/[?#*@!$\-0-9A-Za-z_{(]/u.test(next)) return false;
      if (/[?#*@!$\-0-9]/u.test(next)) {
        special = true;
        at += 1;
      }
    }
  }
  return special;
}

/**
 * `$?`, `$#`, `$*`, `$@`, `$!`, `$$`, `$-` and `$0`..`$9` name a parameter:
 * the character after the `$` is its name, never a glob (`exit-$?.txt`). Each
 * is read as `$0`, an unknown value like any other. `${…}` is masked first.
 */
function maskSpecialParameters(text: string): string {
  return text.replace(/\$[?#*@!$\-0-9]/gu, "$$0");
}

/**
 * The word with each `${…}` (nesting counted) replaced by a placeholder, `$`
 * then {@link PARAMETER_MARK}, its index and the mark again, and the
 * expansions it stands for. An unclosed `${` runs to the end of the word.
 */
function maskParameters(word: string): { text: string; held: string[] } {
  const held: string[] = [];
  let text = "";
  for (let at = 0; at < word.length; at += 1) {
    if (word[at] === "$" && word[at + 1] === "{") {
      const end = parameterEnd(word, at);
      held.push(word.slice(at, end + 1));
      text += `$${PARAMETER_MARK}${String(held.length - 1)}${PARAMETER_MARK}`;
      at = end;
    } else {
      text += word[at];
    }
  }
  return { text, held };
}

/** The index of the `}` closing the `${` at `at` (nesting counted), or the last index. */
function parameterEnd(word: string, at: number): number {
  let depth = 0;
  for (let end = at + 1; end < word.length; end += 1) {
    if (word[end] === "{") depth += 1;
    else if (word[end] === "}") {
      depth -= 1;
      if (depth === 0) return end;
    }
  }
  return word.length - 1;
}

/** Most `${…}` operator texts one word is read through; past it the word is `log.mutate`. */
const PARAMETER_READINGS_CAP = 8;
/**
 * How deep a default inside a default is followed; deeper is `log.mutate`. The
 * `.git` reader's depth (32 levels of `${`).
 */
const PARAMETER_READINGS_DEPTH = 32;

/** The `${X<op>WORD}` spans of a word (top level), with their WORD texts. */
function parameterOperatorSpans(word: string): { at: number; end: number; text: string }[] {
  const spans: { at: number; end: number; text: string }[] = [];
  for (let at = 0; at < word.length; at += 1) {
    if (word[at] !== "$" || word[at + 1] !== "{") continue;
    const end = parameterEnd(word, at);
    const inner = word.slice(at + 2, end);
    const operator = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(:?[-=+?])([\s\S]*)$/u.exec(inner);
    if (operator !== null) spans.push({ at, end, text: operator[2] as string });
    at = end;
  }
  return spans;
}

/**
 * The texts the shell may make of a write-target word through its `${…}`
 * operators: the word itself, and the word with the WORD of each `${X:-WORD}`,
 * `${X-WORD}`, `${X:=WORD}`, `${X=WORD}`, `${X:+WORD}` and `${X+WORD}` (and
 * `:?`, `?`) in place of the expansion: one at a time and all at once, and a
 * default inside a default followed {@link PARAMETER_READINGS_DEPTH} deep (the
 * reading with every span replaced holds exactly the nested ones).
 * bash and zsh substitute that text and then glob it (`${X:-~/.h*}` is
 * `~/.hermes` when X is unset). A value the text does not hold (`${X}`,
 * `${X#…}`, zsh's `${~X}`) stays as written, as {@link protectedPathClass}
 * reads every variable.
 *
 * FAIL CLOSED: more than {@link PARAMETER_READINGS_CAP} operator spans in one
 * word, or an operator span left past the depth, is `overflow`, and the word
 * is then the strictest class, never the readings made so far.
 */
function writeWordReadings(word: string, depth = 0): { readings: string[]; overflow: boolean } {
  if (!word.includes("${")) return { readings: [word], overflow: false };
  const spans = parameterOperatorSpans(word);
  if (spans.length === 0) return { readings: [word], overflow: false };
  if (spans.length > PARAMETER_READINGS_CAP || depth >= PARAMETER_READINGS_DEPTH) {
    return { readings: [word], overflow: true };
  }
  const replace = (chosen: readonly number[]): string => {
    let out = "";
    let from = 0;
    for (const index of chosen) {
      const span = spans[index] as { at: number; end: number; text: string };
      out += word.slice(from, span.at) + span.text;
      from = span.end + 1;
    }
    return out + word.slice(from);
  };
  const all = replace(spans.map((_, index) => index));
  const readings = new Set<string>([word, all]);
  for (let index = 0; index < spans.length; index += 1) readings.add(replace([index]));
  // The reading with every span replaced holds exactly the nested defaults.
  const nested = writeWordReadings(all, depth + 1);
  for (const each of nested.readings) readings.add(each);
  return { readings: [...readings], overflow: nested.overflow };
}

/**
 * Segment names the guarded-path rules read ({@link protectedPathClass},
 * {@link credentialSegments}, {@link hermesOrganClass}). A pattern segment that
 * could match one of these (case folded) is judged with that name in its
 * place. A rule added to those functions that reads a new segment name must
 * add it here, or a pattern for it would be judged by its text alone; the
 * glob-write tests pin one path per row.
 */
const GLOB_GUARD_NAMES: readonly string[] = [
  ".",
  "..",
  ".approval",
  "log",
  "env",
  "keys",
  "vault",
  ".hermes",
  "profiles",
  "auth.json",
  ".env",
  ".op.env",
  "config.yaml",
  "config.yml",
  "agent-hooks",
  "approval",
  "hooks",
  "hooks.json",
  "hermes-agent",
  "plugins",
  "scripts",
  "shell-hooks-allowlist.json",
  ".claude",
  ".cursor",
  "agents",
  ".grok",
  ".muse",
  ".codex",
  "config.toml",
  ".github",
  "workflows",
  ...CORE_FILENAMES,
  ...PROTECTED_FILENAMES,
];

/**
 * Prefixes the guarded-path rules match with `startsWith` (`.claude/settings*`,
 * `.env.*`, `vault*`, `hooks*`, ...). A pattern segment that could match SOME
 * name beginning with one is judged with the prefix itself in its place, which
 * the same `startsWith` accepts.
 */
const GLOB_GUARD_PREFIXES: readonly string[] = [
  "settings",
  ".env.",
  ".op.env.",
  "env.",
  "vault",
  "hooks",
  "shell-hooks-allowlist.json",
];

/** Most candidate paths one reading is judged as before it is judged `log.mutate`. */
const GLOB_GUARD_CANDIDATE_CAP = 4096;
/** Most segments one reading is read as before it is judged `log.mutate`. */
const GLOB_GUARD_SEGMENTS_CAP = 32;
/**
 * Most matcher steps one reading may take, over every segment and name, before
 * it is judged `log.mutate`. A step is one memoized state or one bracket end
 * tried, so the work is bounded whatever the pattern holds.
 */
const GLOB_GUARD_STEP_CAP = 2_000_000;

type GlobToken =
  | { kind: "lit"; ch: string }
  | { kind: "one" }
  | { kind: "run" }
  | { kind: "rest" }
  | { kind: "bracket" }
  | { kind: "set"; chars: string };

/**
 * One path segment of a pattern as an over-approximating token list, and the
 * token indices of its `]` characters. `spans` is true when the segment may
 * stand for more than one directory.
 *
 * - `*` is any run (a run of them is one), `?` any one character.
 * - `[` is EITHER a literal `[` (an unclosed bracket is literal in every shell)
 *   OR one character of any kind, the class ending at ANY later `]`: every
 *   shell ends a class at one of them, so the union holds each shell's parse
 *   (`[!]]`, `[]c]`, `[\]c]`, `[[:alpha:]]`, `[[!Z]]` all included).
 * - `(…)` (zsh groups and qualifiers, bash extglob with its `?*+@!` prefix) and
 *   `<…>` (zsh numeric ranges) are any run.
 * - `#` (zsh extendedglob: zero or more of the atom before it) turns that atom
 *   into a run; `^` (zsh negation) leaves the rest of the segment free. Both,
 *   and braceccl below, only with `options` (the line may set one); otherwise
 *   they are literal characters, as every shell reads them by default.
 * - `{…}` left by brace expansion is zsh's `braceccl`: from the `{` to the last
 *   `}`, a run of the characters inside, a range `a-z` counting every character
 *   between; a range over `/` may make several directories (`spans`).
 */
function globSegmentTokens(segment: string, options = true): { tokens: GlobToken[]; closes: number[]; spans: boolean } {
  const tokens: GlobToken[] = [];
  const closes: number[] = [];
  let spans = false;
  const pushRun = (): void => {
    if (tokens[tokens.length - 1]?.kind !== "run") tokens.push({ kind: "run" });
  };
  const lastClose = segment.lastIndexOf("}");
  for (let at = 0; at < segment.length; at += 1) {
    const ch = segment[at] as string;
    if (ch === "*") pushRun();
    else if (ch === "?") tokens.push({ kind: "one" });
    else if (ch === "^" && options) tokens.push({ kind: "rest" });
    else if (ch === "#" && options) {
      tokens.pop();
      pushRun();
    } else if (ch === "(" || ch === "<") {
      const close = ch === "(" ? ")" : ">";
      const previous = segment[at - 1];
      if (ch === "(" && previous !== undefined && "?*+@!".includes(previous) && tokens.length > 0) tokens.pop();
      let depth = 1;
      let end = at + 1;
      for (; end < segment.length && depth > 0; end += 1) {
        if (segment[end] === ch) depth += 1;
        else if (segment[end] === close) depth -= 1;
      }
      pushRun();
      at = end - 1;
    } else if (ch === "{" && options && lastClose > at) {
      const inside = segment.slice(at + 1, lastClose).replace(/[{},]/gu, "");
      const chars = new Set(foldNameExact(inside));
      let wide = false;
      for (let k = 1; k + 1 < inside.length && !wide; k += 1) {
        if (inside[k] !== "-") continue;
        const low = Math.min(inside.charCodeAt(k - 1), inside.charCodeAt(k + 1));
        const high = Math.max(inside.charCodeAt(k - 1), inside.charCodeAt(k + 1));
        if (low <= 0x2f && high >= 0x2f) spans = true;
        // A range wider than ASCII may be any character.
        if (high - low > 0x80) wide = true;
        else for (let code = low; code <= high; code += 1) for (const folded of foldNameExact(String.fromCharCode(code))) chars.add(folded);
      }
      if (wide) pushRun();
      else tokens.push({ kind: "set", chars: [...chars].join("") });
      at = lastClose;
    } else if (ch === "[") {
      tokens.push({ kind: "bracket" });
    } else {
      if (ch === "]") closes.push(tokens.length);
      // The matcher compares one character at a time against the whole name
      // folded first. A character whose fold is not one character (`ß` is
      // `ss`, a ligature two or three letters, a combining mark split off by
      // NFD, an HFS+-ignored code point none) cannot be one token: it is read
      // as any run, which is strict (it may match more, never less).
      const folded = foldNameExact(ch);
      if ([...folded].length === 1) tokens.push({ kind: "lit", ch: folded });
      else pushRun();
    }
  }
  return { tokens, closes, spans };
}

/**
 * Could `tokens` match `name` (case folded)? With `prefix`, could it match some
 * name BEGINNING with `name`: every token can match some text, so reaching the
 * end of `name` anywhere is enough. Memoized; each state and each bracket end
 * tried costs one of `budget.left`, and an exhausted budget answers `null`.
 * Every path consumes a character at least every second token (runs collapse),
 * so the recursion is no deeper than twice the name.
 */
function globTokensMatch(
  pattern: { tokens: readonly GlobToken[]; closes: readonly number[] },
  name: string,
  prefix: boolean,
  budget: { left: number },
): boolean | null {
  const { tokens, closes } = pattern;
  // The whole name folded before it is matched: a fold may change its length.
  // Exact as spelled, as bash matches a pattern without nocaseglob.
  const text = foldNameExact(name);
  const memo = new Map<number, boolean>();
  let exhausted = false;
  const match = (ti: number, si: number): boolean => {
    if (exhausted) return false;
    if (si === text.length && prefix) return true;
    if (ti === tokens.length) return si === text.length;
    const key = ti * (text.length + 1) + si;
    const seen = memo.get(key);
    if (seen !== undefined) return seen;
    if ((budget.left -= 1) < 0) {
      exhausted = true;
      return false;
    }
    const token = tokens[ti] as GlobToken;
    const ch = text[si];
    let result = false;
    switch (token.kind) {
      case "lit":
        result = ch === token.ch && match(ti + 1, si + 1);
        break;
      case "one":
        result = ch !== undefined && match(ti + 1, si + 1);
        break;
      case "run":
        result = match(ti + 1, si) || (ch !== undefined && match(ti, si + 1));
        break;
      case "rest":
        result = true;
        break;
      case "set":
        result = match(ti + 1, si) || (ch !== undefined && token.chars.includes(ch) && match(ti, si + 1));
        break;
      case "bracket":
        if (ch === undefined) break;
        if (ch === "[" && match(ti + 1, si + 1)) {
          result = true;
          break;
        }
        for (const end of closes) {
          if (end <= ti) continue;
          if ((budget.left -= 1) < 0) {
            exhausted = true;
            break;
          }
          if (match(end + 1, si + 1)) {
            result = true;
            break;
          }
        }
        break;
    }
    memo.set(key, result);
    return result;
  };
  const found = match(0, 0);
  return exhausted ? null : found;
}

/**
 * The strictest protected class a write-target pattern could reach, or `null`
 * when no guarded path is within its reach (`out/*.log`). FAIL CLOSED.
 *
 * The reading is brace-expanded first ({@link braceCandidates}; a group too
 * large to expand is `policy.core`, as {@link protectedPathClass} answers it).
 * A `~` after the first character may be zsh's exclusion, which drops the rest
 * of the pattern, so the reading cut there is judged as well. Each expansion is
 * split into segments, and each segment stands for a set of names:
 *
 * - a segment with no construct: itself, and any guarded name equal to it with
 *   case folded (a case-folding volume, `nocaseglob`);
 * - a segment holding a variable and no construct: itself, as
 *   {@link protectedPathClass} reads every variable;
 * - a pattern segment: itself, and every guarded name or prefix
 *   ({@link GLOB_GUARD_NAMES}, {@link GLOB_GUARD_PREFIXES}, and the segments of
 *   the policy's own entries) its tokens could match;
 * - a segment that may stand for SEVERAL directories (a whole `**` or `***`
 *   component; a variable beside a construct, whose value may hold a `/`; a
 *   `braceccl` range over `/`): nothing, any one name, or any two names.
 *
 * Every combination is a candidate path, judged by {@link protectedPathClass};
 * the strictest answers. More combinations than
 * {@link GLOB_GUARD_CANDIDATE_CAP}, more segments than
 * {@link GLOB_GUARD_SEGMENTS_CAP}, more matcher steps than
 * {@link GLOB_GUARD_STEP_CAP} (one budget over every reading of a word), a reading that already holds
 * {@link PARAMETER_MARK}, or a placeholder that cannot be restored, is the
 * strictest class there is, `log.mutate`: a pattern that wide could name the
 * log.
 */
function globGuardClass(
  word: string,
  protectedPaths: readonly ProtectedPathEntry[],
  budget: { left: number } = { left: GLOB_GUARD_STEP_CAP },
  options = false,
  disk?: GlobDisk,
): string | null {
  // zsh's extendedglob forms (`#`, `^`, the `~` exclusion) and braceccl need an
  // option; with none possibly set on the line they are literal text (lead
  // ruling L60846; review-b S2: `rm -f *~` is the files ending in `~`).
  if (word.includes(PARAMETER_MARK)) return "log.mutate";
  const extraNames = protectedPaths.flatMap((entry) => parseProtectedEntry(entry)?.segments ?? []);
  const names = [...new Set([...GLOB_GUARD_NAMES, ...extraNames])];
  const words = [word];
  if (options) for (let at = 1; at < word.length; at += 1) if (word[at] === "~") words.push(word.slice(0, at));
  let strictest: string | null = null;
  const consider = (surface: string | null): boolean => {
    if (surface !== null && (strictest === null || protectedRank(surface) < protectedRank(strictest))) strictest = surface;
    return strictest === "log.mutate";
  };
  for (const each of words) {
    const expansions = braceCandidates(each);
    if (expansions === null) {
      if (consider("policy.core")) return strictest;
      continue;
    }
    for (const expansion of expansions) {
      const masked = maskParameters(expansion);
      let lost = false;
      const unmask = (path: string): string =>
        path.replace(new RegExp(`\\$${PARAMETER_MARK}(\\d+)${PARAMETER_MARK}`, "gu"), (_, index: string) => {
          const held = masked.held[Number(index)];
          if (held === undefined) lost = true;
          return held ?? "";
        });
      const segments = masked.text.split("/");
      if (segments.length > GLOB_GUARD_SEGMENTS_CAP) return "log.mutate";
      // The caller's listing of the directory a prefix names, or `undefined`.
      const listingFor = (prefix: readonly string[]): readonly string[] | undefined => {
        if (disk === undefined || disk.listingsOk === false) return undefined;
        const dir = globListingDir(prefix, disk);
        if (dir === null) return undefined;
        disk.collect?.add(dir);
        return diskListing(disk, dir, true);
      };
      // Dot matching (lead ruling, CLAIMS L61492 and L61497): bash's dotglob
      // and zsh's globdots may be set in the user's own profile, where no
      // setter on the line shows, so a pattern is read with dot-names matched
      // as well as hidden, and the stricter reading answers. Matched, a `*`,
      // `?` or class at a segment's start reaches every dot-name but `.` and
      // `..`, which no option lets them match; an explicit leading `.` (or a
      // leading group or `.` class) reaches those too, as does any segment on
      // a line that may set options (as before). The dot-matched reading
      // holds every candidate the hidden one does, so it alone is judged.
      const notDots = names.filter((name) => name !== "." && name !== "..");
      const spanning = (segment: string, dotted: boolean): string[][] => {
        const pool = dotted ? names : notDots;
        const out: string[][] = [[], [segment]];
        for (const first of pool) {
          out.push([first]);
          for (const second of pool) out.push([first, second]);
        }
        return out;
      };
      let exhausted = false;
      // GLOB-WRITE (L61167): the first component holding a construct is matched
      // against what is THERE when the caller listed its directory.
      let firstGlobSeen = false;
      const choices: string[][][] = segments.map((segment, index) => {
        const listing = firstGlobSeen || !hasGlobConstruct(segment) ? undefined : listingFor(segments.slice(0, index));
        if (hasGlobConstruct(segment)) firstGlobSeen = true;
        if (segment.length === 0) return [[segment]];
        // globstar and zsh's `**/` descend into dot-directories only with dot
        // matching on; a variable's value and a braceccl range are literal text,
        // which may hold a dot-name.
        if (segment === "**" || segment === "***") return spanning(segment, options);
        const glob = hasGlobConstruct(segment.split(PARAMETER_MARK).join(""));
        if (segment.includes("$")) return glob ? spanning(segment, true) : [[segment]];
        const pattern = globSegmentTokens(segment, options);
        if (pattern.spans) return spanning(segment, true);
        // An explicit leading `.`, a leading group (zsh `(.a|b)`, bash
        // extglob `!(x)`, which matches a dot-name), or a leading braceccl
        // class holding `.` may reach a dot-name with no option set.
        const first = pattern.tokens[0];
        const dotted =
          options ||
          /^[.(]|^[!@?*+]\(/u.test(segment) ||
          (first?.kind === "set" && first.chars.includes("."));
        const test = (name: string, prefix: boolean): boolean => {
          const hit = globTokensMatch(pattern, name, prefix, budget);
          if (hit === null) exhausted = true;
          return hit !== false;
        };
        if (listing !== undefined) {
          // The names the directory holds that the pattern could match, each
          // also under any guarded spelling equal to it with case folded
          // (`apprOVAL.MD` is the policy file on a case-insensitive volume).
          // No match: the pattern names no file there, so no candidate.
          const listed: string[][] = [];
          // A listing never holds `.` or `..`; every name in it is read, dot-names too.
          const present = dotted ? [...listing, ".", ".."] : listing;
          for (const name of present) {
            if (!test(name, false)) continue;
            listed.push([name]);
            for (const guard of names) if (guard !== name && sameGuardedName(guard, name)) listed.push([guard]);
          }
          return listed;
        }
        const out: string[][] = [[segment]];
        for (const name of dotted ? names : notDots) if (name !== segment && test(name, false)) out.push([name]);
        for (const name of GLOB_GUARD_PREFIXES) if (test(name, true)) out.push([name]);
        return out;
      });
      if (exhausted) return "log.mutate";
      let total = 1;
      for (const choice of choices) total *= choice.length;
      if (total > GLOB_GUARD_CANDIDATE_CAP) return "log.mutate";
      const walk = (index: number, parts: string[]): boolean => {
        if (index === choices.length) {
          const path = unmask(parts.join("/"));
          if (lost) return consider("log.mutate");
          return consider(protectedPathClass(path, protectedPaths));
        }
        for (const choice of choices[index] as string[][]) {
          if (walk(index + 1, [...parts, ...choice])) return true;
        }
        return false;
      };
      if (walk(0, [])) return strictest;
    }
  }
  return strictest;
}

/**
 * The rules whose commands RUN CODE THIS RUNTIME DID NOT AUTHOR (APRV-193).
 *
 * Rule ids rather than classes, because the class does not separate them: `npm
 * test`, `node build.mjs`, `tsc` and `mkdir` all resolve to
 * `files.write.workspace`, and only the first three execute a file an agent may
 * have written a minute ago. That is the whole distinction laundering turns on
 * — the command's NAME stops describing its effect exactly when the effect is
 * in a file the name does not mention — so it is drawn here, once, where a
 * future rule's author will see it.
 *
 * Read by `APPROVAL_HOOK_REQUIRE_SANDBOX` (`src/cli/hook.ts`) and by nothing
 * else. It grants nothing and denies nothing on its own: it says which commands
 * the hook may be asked to require a sandbox for, and the requirement is off
 * unless an operator turns it on.
 */
export const CODE_EXECUTING_RULES: readonly string[] = [
  /** `npm test`, `npm run <script>`, `npm exec` and the pnpm/yarn/bun spellings. */
  "npm-script",
  /** `node <script>` — the plainest spelling of "run what I just wrote". */
  "node-script",
  /**
   * `bun` / `python3` / `node` running `skills/<skill>/scripts/<file>`
   * (APRV-502). A skill script is a file in the workspace an agent may have
   * written a minute ago, exactly as `node x.mjs` is.
   */
  SKILL_SCRIPT_RULE,
  NODE_SKILL_SCRIPT_RULE,
  /**
   * `python3 -c`, `node -e` and kin, and an interpreter running a file that is
   * not a skill script, once a policy opens `exec.code` (APRV-510).
   */
  EXEC_CODE_INLINE_RULE,
  EXEC_CODE_FILE_RULE,
  /** `npx`, `tsx`, `tsc`, `vitest`, `jest`, `make`, and kin. */
  "workspace-tool",
  /**
   * `npm pack` and `npm init <initializer>` (APRV-397).
   *
   * Both run code the runtime did not author, for different reasons. `npm pack`
   * runs the package's own `prepack` and `prepare` scripts, which are files in
   * the workspace an agent may have written a minute ago, exactly as `npm test`
   * is. `npm init <pkg>` downloads an initializer and runs it, which is
   * `npm exec` wearing another name. A bare `npm init` writes `package.json` and
   * runs nothing, so it is absent.
   */
  "npm-pack",
  "npm-init-create",
  /**
   * Launching an agent harness, and probing one (APRV-354).
   *
   * Every spelling is here, the probe included. A launch hands control to a
   * whole second agent, which is the most complete form of "code the runtime
   * did not author"; a probe still executes the same binary. The list is
   * matched against a segment's RULE, so the generated launch ids and the two
   * ids a refinement can return on its own — the probe and the Muse
   * contributor id — all have to be named, or `npx @openai/codex` would have
   * quietly stopped requiring a sandbox by gaining a better class.
   */
  ...HARNESS_RULES.map((rule) => rule.id),
  HARNESS_PROBE_RULE,
  MUSE_CONTRIBUTOR_RULE,
];

/**
 * Every class the table can emit, for docs and for the dogfood test.
 *
 * Fixed, and it does not include the `policy.edit` sub-classes (APRV-266): a
 * routed class is emitted only because a particular policy named it, so the set
 * of them is a property of that file rather than of this table. A reader
 * asking "can the classifier ever emit this class?" of a routed name must ask
 * it WITH the policy in hand — {@link emittableClass} is that question.
 */
export const CLASSIFIER_CLASSES: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const rule of COMMAND_RULES) {
    seen.add(rule.class);
    for (const extra of rule.emits ?? []) seen.add(extra);
  }
  // Emitted outside the binary table: the three protected-path classes
  // (APRV-198), the credential overrides (APRV-194: a credential path named by
  // a binary the table does not know, a secret-named variable expansion, a
  // bare `env`), the redirect-write override, and the bare-assignment segment.
  for (const surface of PROTECTED_PRECEDENCE) seen.add(surface);
  seen.add(CREDENTIAL_CLASS);
  seen.add("files.write.workspace");
  seen.add("read.shell");
  // APRV-347: emitted from `classifySegment`'s tail rather than from a row of
  // the table, because it is a refinement of `read.shell` against roots the
  // CALLER resolved and no binary implies it on its own.
  seen.add(READ_OUT_OF_SCOPE_CLASS);
  return [...seen].sort();
})();

/**
 * The class the DAEMON's own cadence advance is gated as (APRV-382).
 *
 * The sub-class exists because the policy grammar has no actor condition and
 * this repository wanted one: an advance publishes records the log already
 * holds, so the daemon may make it unattended, while the same act from a
 * session in a worktree or a human terminal stays supervised. Two classes are
 * how that is written down, and which of them a cycle asks under is decided by
 * `core/advance-cycle.ts` from the running process, never from an argument.
 *
 * NO COMMAND SPELLS IT, on purpose. `approval log advance` classifies
 * `log.advance` whoever types it, so the looser line is unreachable from a
 * shell an agent can drive: it is reached only from inside the daemon process,
 * which an agent cannot become without a `gate.self` command this policy holds
 * at the manual default.
 */
export const ADVANCE_DAEMON_CLASS = "log.advance.daemon";

/**
 * Classes this RUNTIME emits for its own gated actions, which no command spells.
 *
 * Separate from {@link CLASSIFIER_CLASSES}, which is the binary table's own set
 * and is what `docs/claude-code-hook.md` documents row by row. A class here is
 * emitted by a runtime cycle that registers and requests it directly — the
 * daemon's advance is the first — so a policy declaring it is declaring a line
 * that CAN fire, and the reachability check `core/policy-expectations.ts` runs
 * at the amendment ceremony must say so. Without this list that ceremony would
 * refuse the line `unreachable`, which is a true statement about the command
 * classifier and a false one about the runtime.
 *
 * Adding a name here is a claim that some path in this codebase asks the gate
 * for that class, and widening it is a reviewable diff.
 */
export const RUNTIME_CLASSES: readonly string[] = [ADVANCE_DAEMON_CLASS];

/**
 * Can the classifier emit `actionClass` for a project whose policy carries
 * these `protected_paths`? (APRV-266.)
 *
 * {@link CLASSIFIER_CLASSES} answers for the binary table, which is fixed. A
 * routed class is not in that table and never will be: it exists because one
 * policy wrote it beside one path, and the same name in another project's
 * policy would be a different class over different files. So the reachability
 * question — the one `core/policy-expectations.ts` asks of every class a policy
 * declares, so that a policy line nobody can ever fire is caught at the
 * ceremony rather than believed for a year — takes the policy's own entries.
 *
 * A routed name is reachable exactly when some entry routes to it. A
 * `policy.edit.spec` rule in a policy whose `protected_paths` routes nothing to
 * it is a line that will never fire, and saying so is the whole point.
 *
 * {@link RUNTIME_CLASSES} is the third answer (APRV-382): a class no command
 * spells and a runtime cycle asks for directly is reachable in every project,
 * with no policy entry needed, because the path that emits it is in this
 * codebase rather than in the operator's file.
 */
export function emittableClass(
  actionClass: string,
  protectedPaths: readonly ProtectedPathEntry[] = [],
): boolean {
  if (CLASSIFIER_CLASSES.includes(actionClass)) return true;
  if (RUNTIME_CLASSES.includes(actionClass)) return true;
  if (!POLICY_EDIT_SUBCLASS.test(actionClass)) return false;
  return protectedPaths.some((entry) => parseProtectedEntry(entry)?.routed === actionClass);
}

// ---------------------------------------------------------------------------
// Sandbox wrappers (APRV-193)
// ---------------------------------------------------------------------------

/** How many nested wrappers are unwrapped before the classifier gives up. */
const SANDBOX_WRAPPER_DEPTH = 4;

type SandboxWrapperFound =
  | { kind: "wrapper"; skip: number; wrapper: SandboxWrapper }
  | { kind: "unreadable"; detail: string };

/**
 * `sandbox-exec [-f <profile>]… [--] <argv…>`.
 *
 * Only `-f` is modelled. `-p` takes a profile inline, `-n` names a built-in
 * one, `-D` binds a parameter the profile reads: each changes what the room
 * allows, and a rule that skipped them would be reading past the part that
 * matters. So they are `unreadable` rather than guessed at, which denies.
 */
function seatbeltWrapper(words: readonly string[], start: number): SandboxWrapperFound {
  let index = start + 1;
  while (index < words.length) {
    const word = words[index] as string;
    if (word === "--") {
      index += 1;
      break;
    }
    if (word === "-f") {
      if (words[index + 1] === undefined) {
        return { kind: "unreadable", detail: "sandbox-exec -f names no profile" };
      }
      index += 2;
      continue;
    }
    if (!isFlag(word)) break;
    return {
      kind: "unreadable",
      detail: `sandbox-exec flag ${word} is not modelled; only -f <profile> is read, because -p, -n and -D change what the profile allows`,
    };
  }
  if (words[index] === undefined) {
    return { kind: "unreadable", detail: "sandbox-exec runs no command" };
  }
  return { kind: "wrapper", skip: index - start, wrapper: "external" };
}

/**
 * `approval [flags…] sandbox [flags…] -- <argv…>`, and its `node cli.js`
 * spelling.
 *
 * The word `sandbox` is looked for anywhere before the separator rather than
 * only in the first position, because `approval --log x sandbox -- curl …`
 * would otherwise keep the pass-through `gate.self` class and BE the laundering
 * device this whole rule exists to remove. Over-matching is safe in a way
 * under-matching is not: unwrapping can only move a segment off `gate.self`
 * (the permissive pseudo-class) and onto the inner command's real one.
 *
 * No separator means nothing runs — `approval sandbox --help` prints text — so
 * that falls through to the ordinary `approval` row rather than refusing.
 */
function approvalSandboxWrapper(
  words: readonly string[],
  from: number,
  start: number,
): SandboxWrapperFound | null {
  const separator = words.indexOf("--", from);
  if (separator === -1) return null;
  if (!words.slice(from, separator).includes("sandbox")) return null;
  if (words[separator + 1] === undefined) return null;
  return { kind: "wrapper", skip: separator + 1 - start, wrapper: "runtime" };
}

/** The wrapper standing at `start`, if any. */
function sandboxWrapper(words: readonly string[], start: number): SandboxWrapperFound | null {
  const bin = words[start];
  if (bin === undefined) return null;
  const base = pathSegments(bin).slice(-1)[0] ?? bin;
  if (base === "sandbox-exec") return seatbeltWrapper(words, start);
  if (base === "approval") return approvalSandboxWrapper(words, start + 1, start);
  if (base === "node") {
    const script = words[start + 1];
    if (script === undefined || !isGateEntrypoint(script)) return null;
    return approvalSandboxWrapper(words, start + 2, start);
  }
  // bwrap and unshare are deliberately absent: this build has no Linux
  // mechanism, so a rule for their wrappers would read commands nothing here
  // can produce (`docs/sandboxed-exec.md`, and APRV-193's Linux follow-up).
  return null;
}

/**
 * Does this `NAME=value` set a variable that steers which program runs, what
 * it loads, which file it reads as a zone, locale or converter, or where `cd`
 * goes? (APRV-508 refutation S1; `HOME` and `CDPATH` from the recheck.)
 */
function isSteeringAssignment(word: string): boolean {
  const name = assignedName(word);
  if (["TZ", "TZDIR", "PATH", "LOCPATH", "GCONV_PATH", "LANG", "LANGUAGE", "HOME", "CDPATH"].includes(name)) {
    return true;
  }
  // APRV-518's `GIT_CONFIG_GLOBAL=/tmp/g; git push origin` (a configuration
  // the hook never read) and `XDG_CONFIG_HOME=/tmp/x; git push` (git's user
  // config moved) are refused by APRV-521's bare-assignment rule below
  // ({@link isGitInheritedName}, less {@link isHarmlessGitAssignment}) and by
  // its line scan ({@link gitEnvironmentWrite}), not here: naming every
  // `GIT_*` here would also refuse the harmless `GIT_PAGER=cat` APRV-521 admits.
  return name.startsWith("LC_") || name.startsWith("LD_");
}

/**
 * The directories a shape row's binary (APRV-508) and an `exec.code`
 * interpreter (APRV-510, {@link isExecCodeInterpreter}) may be spelled from,
 * besides a bare name. The classifier's one system-bin list.
 */
const SYSTEM_BIN_DIRS: readonly string[] = ["/bin/", "/usr/bin/", "/usr/local/bin/", "/sbin/", "/usr/sbin/"];

/**
 * Is this command word the system's binary rather than a file the agent can
 * place? A bare name is looked up on PATH; a path in a system directory names
 * that file. `./date` or `/tmp/x/date` is whatever program sits there, and a
 * shape row (APRV-508) does not vouch for it.
 *
 * Only a word whose `text` is the bytes bash runs can be judged by its text
 * (APRV-523 fix round 2, review-b S1-R and N6). A word that is not
 * {@link LexWord.exact} still changes under expansion, and bash may then see a
 * slash this text does not show; a backslash in `text` is a path separator to
 * {@link pathSegments} but a plain character to bash, so the basename read
 * from it is not the program's name. Either is refused here, before the bare
 * name is admitted. Callers holding only a string pass no flag: theirs is
 * already exact ({@link isExecCodeInterpreter} runs on the exact-only shape).
 */
function isSystemBinWord(word: string, exact = true): boolean {
  if (!exact || word.includes("\\")) return false;
  if (!word.includes("/")) return true;
  if (word.includes("..") || word.includes("//")) return false;
  return SYSTEM_BIN_DIRS.some((dir) => word.startsWith(dir) && !word.slice(dir.length).includes("/"));
}

/**
 * Find the first table row matching this binary, subcommand and argv.
 *
 * The argv is read for two purposes only: a `probe` row matches an argv that
 * is nothing but version or help flags (APRV-397), and a `skillScript` row
 * matches an argv that runs a skill script (APRV-502). No other row reads it.
 *
 * `substituted` and `assigned` are read by the `skillScript` row alone: a
 * substituted word is a hole in the text, and an assignment prefix is a flag
 * spelled through the environment (`BUN_OPTIONS='--cwd ../x'` makes bun read
 * a different directory's file), so either one means the shape is not matched
 * and the segment keeps the answer it had before (fail closed).
 *
 * A `shape` row (APRV-508) reads the argv through its own predicate, which is
 * handed the assignment words so it can admit the harmless ones (`TZ=Zone`)
 * and decline the rest; a substituted word declines it outright.
 */
function matchRule(
  bin: string,
  sub: string | null,
  args: readonly string[],
  substituted = false,
  assigned = false,
  assignments: readonly string[] = [],
  binWord: string = bin,
  /**
   * Did the caller open `exec.code` AND does this segment have the shape?
   * (APRV-510.) Computed by `classifySegment`, which holds the words.
   */
  execShaped = false,
  /** Is `binWord` the bytes bash runs ({@link LexWord.exact})? (APRV-523 fix round 2, review-b N6.) */
  binExact = true,
): CommandRule | null {
  for (const rule of COMMAND_RULES) {
    if (!rule.bins.includes(bin)) continue;
    if (rule.probe === true && !isVersionProbe(args)) continue;
    if (
      rule.shape !== undefined &&
      (substituted || !isSystemBinWord(binWord, binExact) || !rule.shape(args, assignments))
    ) {
      continue;
    }
    if (rule.execCode === true && !execShaped) continue;
    // APRV-502: see the doc comment above; any of the three declines the row.
    if (
      rule.skillScript === true &&
      (substituted || assigned || skillScriptArg(bin, args) === null)
    ) {
      continue;
    }
    if (rule.subs !== undefined) {
      if (sub === null || !rule.subs.includes(sub)) continue;
    }
    return rule;
  }
  return null;
}

type SegmentOutcome =
  | {
      ok: true;
      class: string;
      rule: string;
      path?: string;
      sandbox?: SandboxWrapper;
      /**
       * A credential touch the segment ALSO makes, beside a protected class
       * that outranks it in the classifier's own precedence (APRV-503 recheck,
       * SHOULD-FIX-R1). Reported as a second classified segment over the same
       * text, so the command's `classes` carries both and a policy that holds
       * `account.credential` stricter than `policy.core` or `log.mutate` still
       * sees it: the hook refuses when ANY class is human-only.
       */
      also?: CredentialOutcome;
      /**
       * The plain (text-only) class of a segment a write-target pattern raised,
       * where it differs (review-b S1): the raised class answers and this rides
       * beside it as a second segment, so no class is taken away.
       */
      patternAlso?: CredentialOutcome;
      /**
       * The segment's class without the parents rule (lead ruling L61587),
       * where the rule changed it: it rides beside the parent's class as one
       * more segment, ordinary classes too, so the rule never takes away the
       * class main gives the line (review-b A686-FOLD5 M1's bar).
       */
      parentAlso?: CredentialOutcome;
      /** The program an `exec.code` answer runs (APRV-510). */
      execCode?: ExecCodeSource;
    }
  | {
      ok: false;
      code: ClassifierFailureCode;
      detail: string;
      noRule?: true;
      /**
       * The segment failed ONLY because no built-in rule names its binary (the
       * `matchRule` miss), guarded or not. Read by {@link tailReachesRule}: a
       * tail of a no-rule segment that fails any other way (opaque, a refusal
       * of its own) is a command the table has an opinion on.
       */
      ruleless?: true;
    };

/**
 * Ordinary classes this per-segment join leaves to the seam: main's answer
 * for the whole line, these classes included, joins every line a GLOB-WRITE
 * rule fired on ({@link classifyCommandAsRead}, lead ruling L61926).
 */
function ordinaryPlainClass(cls: string): boolean {
  return cls === "files.write.workspace" || cls === "files.delete.out_of_scope" || cls.startsWith("read.");
}

/**
 * The raised outcome with the plain one beside it (review-b S1). A refusal on
 * the plain pass stands (a refusal is the stricter answer under every policy);
 * a plain class that differs and is not an ordinary write or read rides beside
 * the raised class as `patternAlso`, so `.approval/*` is `log.mutate` AND
 * `policy.core`, and `$'\x2e'g?t/config` is `log.mutate` AND
 * `vcs.history.rewrite`. The ordinary ones ride beside through the seam.
 */
function besidePlain(raised: SegmentOutcome, plain: SegmentOutcome): SegmentOutcome {
  if (!plain.ok) return plain;
  if (!raised.ok) return raised;
  if (plain.class === raised.class || ordinaryPlainClass(plain.class)) return raised;
  return {
    ...raised,
    patternAlso: { class: plain.class, rule: plain.rule, ...(plain.path === undefined ? {} : { path: plain.path }) },
  };
}

/**
 * The outcome with the parents rule, and the class the segment takes without
 * it beside (lead ruling L61587). A refusal without the rule stands; a class
 * that differs rides beside, ordinary classes included.
 */
function besideParent(withRule: SegmentOutcome, without: SegmentOutcome): SegmentOutcome {
  if (!without.ok) return without;
  if (!withRule.ok) return withRule;
  if (without.class === withRule.class) return withRule;
  return { ...withRule, parentAlso: { class: without.class, rule: without.rule, ...(without.path === undefined ? {} : { path: without.path }) } };
}

function classifySegment(
  segment: LexSegment,
  protectedPaths: readonly ProtectedPathEntry[],
  context: ClassifierContext,
): SegmentOutcome {
  // This segment's own release, not one around it (a substitution is a segment too).
  const outerVerbs = organVerbs;
  organVerbs = true;
  try {
    return classifySegmentWithVerb(segment, protectedPaths, context);
  } finally {
    organVerbs = outerVerbs;
  }
}

function classifySegmentWithVerb(
  segment: LexSegment,
  protectedPaths: readonly ProtectedPathEntry[],
  context: ClassifierContext,
): SegmentOutcome {
  if (segment.opaque !== null) {
    return { ok: false, code: "opaque", detail: segment.opaque };
  }

  // `$(…)` is classified recursively. A substitution that only reads is inert;
  // anything else taints the segment, because its effect happens before the
  // outer command even starts and the outer class would not describe it.
  //
  // Redirection targets are words too, and the shell expands them the same
  // way (APRV-508 recheck M-R1): `cat a < "x$(rm -rf y)"` runs the `rm` before
  // `cat` opens anything. Until this loop read them, a substitution in a
  // target ran with no class of its own, under `read.shell` for a `<` and
  // under the write class for a `>`, on 0.4.3 as well.
  const expanded = [
    ...segment.words,
    ...segment.redirects.map((redirect) => redirect.target),
    // APRV-504: the `$(…)` of an unquoted heredoc body run when it is read.
    { text: "", quoted: false, substitutions: segment.bodySubstitutions, splits: false, expands: false },
  ];
  // APRV-522 (S2): the first read inside a substitution that the read scope
  // places outside every root. A substitution that only reads is inert, and its
  // out-of-scope read used to vanish with it, and the outer segment was
  // `read.shell`. It tightens a `read.shell` answer below, as a named target
  // would.
  let substitutedEscape: { path: string; rule: string } | null = null;
  // Review of the substitution fold, M1: a body the line's reading already
  // went through, on a line that spells no `.git`, is not read again.
  const bodyAlreadyRead = context.lineNamesGit === false && context.spelledSegments?.has(segment) === true;
  const substitutionDepth = (context.substitutionDepth ?? 0) + 1;
  for (const word of expanded) {
    for (const inner of word.substitutions) {
      // Review of the substitution fold: past this depth the recursion is
      // refused, not run until the call stack gives out (which it did near
      // 1,250 levels, on main too, with a thrown error instead of an answer).
      if (substitutionDepth > SUBSTITUTION_NESTING_LIMIT) {
        return {
          ok: false,
          code: "opaque",
          detail: `command substitutions nested more than ${String(SUBSTITUTION_NESTING_LIMIT)} deep are not read by this classifier`,
        };
      }
      // A substitution keeps today's refusal: the no-rule stand-in is for the
      // command's own segments only.
      const nested = classifyCommandAsRead(inner, protectedPaths, {
        ...context,
        ...(context.noRuleSegments === true ? { noRuleSegments: false } : {}),
        bodyAlreadyRead,
        substitutionDepth,
      });
      if (!nested.ok) {
        return {
          ok: false,
          code: nested.code === "unparseable" ? "unparseable" : nested.code,
          detail: `command substitution $(${inner}): ${nested.detail}`,
        };
      }
      const effectful = nested.classes.filter((cls) => !cls.startsWith("read."));
      if (effectful.length > 0) {
        return {
          ok: false,
          code: "opaque",
          detail: `command substitution $(${inner}) is ${effectful.join(", ")}; only read.* substitutions run unattended`,
        };
      }
      if (substitutedEscape === null) {
        const escaped = nested.segments.find((found) => found.class === READ_OUT_OF_SCOPE_CLASS);
        if (escaped !== undefined) {
          substitutedEscape = { path: escaped.path ?? inner, rule: escaped.rule };
        }
      }
    }
  }

  const words = segment.words.map((word) => word.text);
  let cursor = 0;
  while (cursor < words.length && ASSIGNMENT.test(words[cursor] as string)) cursor += 1;
  // APRV-502: read by the skill-script shape only ({@link matchRule}).
  const assigned = cursor > 0;
  // APRV-508: the same words, for a `shape` row that admits some.
  const assignments = words.slice(0, cursor);
  // APRV-521 (review-b M1): the word after the assignments, before a sandbox
  // wrapper moves the cursor. Judged below the protected-redirect answer.
  const afterAssignments = words[cursor];

  // APRV-193. A sandbox wrapper is not a command: it is a room, and what
  // matters is what runs inside it. `approval sandbox -- npm install` is
  // `deps.add`, and it has to be, in both directions.
  //
  // If the wrapper kept a class of its own it would be a laundering device —
  // wrap anything, get `gate.self`, run unapproved. And if it stayed
  // unclassified (which is where `sandbox-exec` sat until this task) the hook
  // would DENY the safe spelling of a command it allows unwrapped, which is a
  // gate that punishes protection. So the cursor is advanced past the wrapper
  // and everything below decides on the inner argv, rule id included.
  //
  // A wrapper this rule cannot read in full is `unclassified`: it never softens
  // anything, and a flag the rule does not model could change what runs.
  let sandbox: SandboxWrapper | null = null;
  for (let depth = 0; depth < SANDBOX_WRAPPER_DEPTH; depth += 1) {
    const found = sandboxWrapper(words, cursor);
    if (found === null) break;
    if (found.kind === "unreadable") {
      return { ok: false, code: "unclassified", detail: found.detail };
    }
    // The strictest marker wins over nesting: an `approval sandbox` inside a
    // hand-written `sandbox-exec` is still, at the outermost layer, a profile
    // this runtime did not write.
    if (sandbox === null) sandbox = found.wrapper;
    cursor += found.skip;
  }

  const writeTargets = segment.redirects
    .filter((redirect) => redirect.op !== "<")
    .map((redirect) => redirect.target.text)
    // APRV-283: a redirection to a discard device creates nothing, so it is not
    // a write. `2>/dev/null` is the suffix an agent writes on half its reads,
    // and until this it turned every one of them into `files.write.workspace`.
    .filter((target) => !isDiscardTarget(target));
  // APRV-503: the paths this segment READS through `<`, at any descriptor. They
  // are judged where a named argument is judged, below: a credential target is
  // `account.credential` and a protected one joins the effectful scan.
  const readTargets = segment.redirects
    .filter((redirect) => redirect.op === "<")
    .map((redirect) => redirect.target.text);
  const redirectTargets = segment.redirects.map((redirect) => redirect.target.text);
  // A redirection onto a protected path is a write to that path, whatever the
  // command in front of it was going to do. The CLASS says which surface was
  // aimed at (APRV-198); the RULE stays `redirect-protected`, because the
  // mechanism is unchanged and the hook's tiers and the channel's protected-path
  // view are keyed on the rule.
  //
  // GLOB-WRITE (22 Nov 2026): a target the shell may still glob is judged by
  // every guarded path its pattern could match ({@link strictestProtectedWrite}),
  // so `> ~/.hermes/[!Z]uth.json` is the organ write `> ~/.hermes/auth.json` is.
  // `inexact` reads the lexer's own verdict: a word whose text is exactly what
  // the shell hands over (`exact`) is never a pattern or a `${…}` default; any
  // other word may be, and a text only contained in one (an option's attached
  // value) counts with it.
  // zsh's `#` and `^` leave a word `exact` to the lexer; where the line may set
  // options they are pattern characters, so such a word is not exact here.
  const lineOptions = context.lineSetsDotglob === true;
  const inexactWords = [...segment.words, ...segment.redirects.map((redirect) => redirect.target)]
    .filter((word) => !word.exact || (lineOptions && word.zshGlob !== false))
    .map((word) => word.text);
  const inexact = containedInAny(inexactWords);
  // Only an UNQUOTED glob character, or an unquoted `$` whose value or `${…}`
  // default the shell may still glob, makes a word a pattern: `"exit-$?.txt"`
  // and `'a*'` are their text (the #683 gate M3 spellings in double quotes).
  // zsh's `#`, `^` and `~` count only where the line may set options.
  const liveWords = [...segment.words, ...segment.redirects.map((redirect) => redirect.target)]
    .filter((word) => word.splits || word.expands || (lineOptions && word.zshGlob !== false))
    .map((word) => word.text);
  const namedWords = new Set(
    [...segment.words, ...segment.redirects.map((redirect) => redirect.target)].filter((word) => word.paramNames === true).map((word) => word.text),
  );
  const glob: GlobReading = {
    live: containedInAny(liveWords),
    names: (text: string): boolean => namedWords.has(text),
    options: context.lineSetsDotglob === true,
    ...(context.globDisk === undefined ? {} : { disk: context.globDisk }),
    budget: context.globBudget ?? { left: GLOB_GUARD_STEP_CAP },
    off: context.globPatternsOff === true,
    ...(context.globTracker === undefined ? {} : { tracker: context.globTracker }),
  };
  const redirected = strictestProtectedWrite(writeTargets, protectedPaths, inexact, false, glob);
  const bin = words[cursor];
  if (redirected !== null) {
    // APRV-503 recheck (SHOULD-FIX-R1): a segment that writes a protected path
    // AND reads credential material (`cat .approval/env > APPROVAL.md`, `cat <
    // ~/.hermes/.env > APPROVAL.md`) carries both classes. The protected class
    // still answers the segment; the credential touch rides beside it.
    const writerArgs = bin === undefined ? [] : words.slice(cursor + 1);
    const writer = bin === undefined ? null : (pathSegments(bin).slice(-1)[0] ?? bin);
    const touched =
      (writer === null
        ? null
        : credentialTouch(writer, writerArgs)) ??
      redirectCredentialTouch(readTargets, redirectTargets);
    return {
      ok: true,
      class: redirected.surface,
      rule: "redirect-protected",
      path: redirected.path,
      ...(touched === null ? {} : { also: touched }),
    };
  }

  // APRV-521 (review-b M1). Every spelling of bash's assignment word is read
  // past by the cursor above ({@link ASSIGNMENT}), and only the plain one is
  // judged by the rules below. An append (`NAME+=v`) or a subscripted write
  // (`NAME[i]=v`) leaves the segment `unclassified`, in front of git or any
  // other program and on its own: its text does not say what value the
  // command inherits. So does a command word that opens like a subscripted
  // assignment the grammar cannot read in full ({@link ASSIGNMENT_LIKE}).
  //
  // APRV-523. The cursor above reads past every assignment-SHAPED word, judged
  // on its dequoted text. bash reads past only the words it accepts as
  // assignments as written ({@link LexWord.assignment}): a word whose name is
  // quoted or escaped is the program bash runs, named by the whole word, and
  // the word after it is that program's argument. Where the two stop at
  // different words this classifier would judge a program that does not run,
  // so the segment is `unclassified`. No program this table admits is named
  // like an assignment, so the word is refused, not resolved.
  const bashCursor = bashAssignmentCount(segment.words);
  if (bashCursor !== assignments.length) {
    const runs = words[Math.min(bashCursor, assignments.length)] as string;
    return {
      ok: false,
      code: "unclassified",
      detail: `no rule for ${assignmentHead(runs)}…: a word whose name is quoted or escaped is a command word to bash, not an assignment`,
    };
  }
  const unplain = assignments.find((word) => !PLAIN_ASSIGNMENT.test(word));
  if (unplain !== undefined) {
    return {
      ok: false,
      code: "unclassified",
      detail: `no rule for ${assignmentHead(unplain)}…: an append or subscripted assignment, whose value the text does not settle`,
    };
  }
  if (afterAssignments !== undefined && ASSIGNMENT_LIKE.test(afterAssignments)) {
    return {
      ok: false,
      code: "unclassified",
      detail: `no rule for ${afterAssignments.slice(0, afterAssignments.indexOf("[") + 1)}…: a subscripted assignment this classifier cannot read in full`,
    };
  }

  if (bin === undefined) {
    // A bare input redirection opens its target, and inside `$(…)` it IS the
    // read: `$(< ~/.hermes/.env)` is bash for "the file's contents" (APRV-503).
    // Nothing here can outrank it: there are no positionals, and a protected
    // write target has already answered above, so the precedence rule the
    // binary path applies below has nothing to defer to.
    const bareCredential = redirectCredentialTouch(readTargets, redirectTargets);
    if (bareCredential !== null) return { ok: true, ...bareCredential };
    // APRV-508 refutation S1: an assignment on its own sets a shell variable,
    // and when that variable is already exported (PATH and LANG always are)
    // the new value reaches every later command on the line. `TZ=/etc/x;
    // date` opens the file the date row refuses to let `TZ=/etc/x date`
    // open, and `PATH=/tmp/x; cat f` runs whatever `cat` sits there. So the
    // variables that pick which program runs, which libraries it loads, or
    // which file it reads as a zone, a locale or a charset converter are not
    // answered as reads.
    // APRV-521: a variable git or its pager, editor, ssh or hooks read joins
    // them, unless the word is one git(1) shows to be harmless.
    const steering =
      assignments.find((word) => isSteeringAssignment(word)) ??
      segment.words
        .slice(0, cursor)
        .find((word) => isGitInheritedName(assignedName(word.text)) && !isHarmlessGitAssignment(word))
        ?.text;
    if (steering !== undefined) {
      return {
        ok: false,
        code: "unclassified",
        detail: `no rule for the assignment ${assignmentHead(steering)}…: it steers which program or file later commands use`,
      };
    }
    // `VAR=value` alone, or a bare redirection. `> file` truncates, so it is a
    // write; an assignment on its own touches nothing. A bare redirection into
    // `.git` or a git configuration file is that write (APRV-518, S1).
    if (writeTargets.length > 0) {
      const gitWrite = gitWriteRefinement(writeTargets, [], context.shellDir, true, context.lineNamesGit === true, (word) =>
        dotGlobNamesGit(word, inexact, glob),
      );
      if (gitWrite !== null) return { ok: true, ...gitWrite };
      return { ok: true, class: "files.write.workspace", rule: "redirect-write" };
    }
    // APRV-522 (S2): inside a substitution, a bare `<` redirection IS the
    // read, and an assignment reads through its substitution, so both take
    // the read scope a named target takes.
    const bareEscape =
      (context.readRoots ?? []).length > 0
        ? (redirectReadEscape(readTargets, context.readRoots ?? []) ?? substitutedEscape)
        : null;
    if (bareEscape !== null) {
      return { ok: true, class: READ_OUT_OF_SCOPE_CLASS, rule: bareEscape.rule, path: bareEscape.path };
    }
    return { ok: true, class: "read.shell", rule: "assignment" };
  }

  const basename = pathSegments(bin).slice(-1)[0] ?? bin;
  const args = words.slice(cursor + 1);

  // `env` with nothing to run prints the whole environment, secrets included,
  // and it is checked HERE, above the opaque table, because `env <command>` is
  // opaque for a different reason (it re-launches something else with a
  // modified environment) and the dump would otherwise be denied as
  // unreadable rather than named for what it is (APRV-194).
  if (basename === "env" && args.filter((arg) => !isFlag(arg)).length === 0) {
    return { ok: true, class: CREDENTIAL_CLASS, rule: "env-dump" };
  }

  const opaqueReason = OPAQUE_BINS[basename];
  if (opaqueReason !== undefined) {
    return { ok: false, code: "opaque", detail: `${basename} ${opaqueReason}` };
  }

  // APRV-510. The `exec.code` shape, read only when the caller opened the
  // class, and declined by anything that would make the hashed words differ
  // from the program that runs: an assignment prefix (`PYTHONSTARTUP`,
  // `NODE_OPTIONS`), a substitution anywhere in the segment, a heredoc, any
  // redirection other than a write to a discard device (stdin is a second
  // program, a write target is a second effect), a segment inside a subshell
  // (a redirection after its `)` feeds the program's stdin; refuter rS2), an
  // interpreter spelled by a relative path, or a source word the shell would
  // still change.
  const execWords = segment.words.slice(cursor + 1);
  const execShape =
    context.execCode === true &&
    !assigned &&
    !segment.heredoc &&
    !segment.stdinFed &&
    !segment.subshell &&
    segment.words.every((word) => word.substitutions.length === 0) &&
    segment.redirects.every((redirect) => redirect.op !== "<" && isDiscardTarget(redirect.target.text)) &&
    (segment.words[cursor]?.exact ?? false) &&
    isExecCodeInterpreter(bin)
      ? execCodeShape(basename, args, execWords)
      : null;

  const inlineFlags = INLINE_SOURCE_BINS[basename];
  if (inlineFlags !== undefined && hasFlag(args, inlineFlags) && execShape === null) {
    return { ok: false, code: "opaque", detail: `${basename} runs inline source` };
  }

  const positionals = args.filter((arg) => !isFlag(arg));
  // Lead ruling L62013 (S2), fail closed: the organ-directory rule holds for
  // every command but the release list (redirects above were judged with it).
  organVerbs = !releasedFromOrganRule(segment);

  // APRV-520: a git global option that takes a value, or one this table does
  // not know, leaves the segment unclassified ({@link gitGlobalRefusal}). It is
  // checked before the credential and table reads below, because the first
  // positional they would read may be the option's value rather than the
  // subcommand, and refused rather than parsed so no spelling of it can turn
  // into an answer.
  //
  // APRV-521: so does an environment assignment in front of git that is not on
  // the closed list git(1) shows to be harmless ({@link gitAssignmentRefusal};
  // the words before a sandbox wrapper count, since the wrapper passes the
  // environment on), and a variable git could inherit that the line's own
  // shell sets ({@link gitEnvironmentWrite}). `GIT_PAGER=<cmd> git log` runs
  // `<cmd>`, and `GIT_DIR=x git status` reads another repository.
  if (basename === "git") {
    const assignmentRefusal = gitAssignmentRefusal(segment.words.slice(0, assignments.length));
    if (assignmentRefusal !== null) return { ok: false, code: "unclassified", detail: assignmentRefusal };
    if (context.shellEnvWrite !== undefined) {
      return {
        ok: false,
        code: "unclassified",
        detail: `no rule for git after ${context.shellEnvWrite} is set on the same command line: git and the programs it starts inherit the shell's exported environment`,
      };
    }
    const refusal = gitGlobalRefusal(args);
    if (refusal !== null) return { ok: false, code: "unclassified", detail: refusal };
  }

  // APRV-508 recheck S-R1: `printf -v NAME` assigns NAME, so `printf -v PATH
  // %s /tmp/x; cat f` is the bare `PATH=/tmp/x` the assignment rule above
  // refuses, spelled through a builtin. A steering NAME (a subscript stripped:
  // `PATH[0]` is PATH), or a NAME the text cannot read, is refused.
  if (basename === "printf") {
    for (let at = 0; at < args.length; at += 1) {
      const arg = args[at] as string;
      if (arg === "--") break;
      const name = arg === "-v" ? args[at + 1] : arg.startsWith("-v") ? arg.slice(2) : undefined;
      if (name === undefined) continue;
      const bare = name.replace(/\[.*$/su, "");
      if (/[$`]/u.test(name) || isSteeringAssignment(`${bare}=`)) {
        return {
          ok: false,
          code: "unclassified",
          detail: `no rule for printf -v ${name}: it sets a variable that steers which program or file later commands use`,
        };
      }
    }
  }

  // APRV-508 refutation S3: `test -v 'a[$(id)]'` evaluates the subscript as
  // arithmetic, and bash expands a `$(…)` inside it, so the operand runs a
  // command. `[` is `test`; both refuse a `-v`/`-R` operand carrying `[`, and
  // an unquoted substitution, whose output the shell would split into words
  // (a `-v` and a subscript among them) that this text never shows.
  if (basename === "test" || basename === "[") {
    const operandWords = segment.words.slice(cursor + 1);
    const probe = args.findIndex(
      (arg, at) => (arg === "-v" || arg === "-R") && (args[at + 1] ?? "").includes("["),
    );
    if (probe !== -1 || operandWords.some((word) => word.substitutions.length > 0 && !word.quoted)) {
      return {
        ok: false,
        code: "unclassified",
        detail: `no rule for ${basename} with an array subscript or an unquoted substitution: the shell may evaluate it as a command`,
      };
    }
  }

  // Credential material, below the opaque checks so `sudo cat .approval/env`
  // stays opaque (a refusal) rather than being softened into a request, and
  // above the binary table so a reader the table does not know (`base64`,
  // `xxd`, `less`) is named rather than answered `unclassified` (APRV-194).
  // APRV-503: the same tier read from the redirection targets, at the same
  // place in the order (`sudo cat < .approval/env` stays a refusal, and `less
  // < .approval/env` is named rather than `unclassified`).
  //
  // A credential path, named or redirected, never lowers a `log.mutate` or
  // `policy.core` answer (APRV-503 refutation, BLOCKING-1 and its named-argument
  // twin). Both classes outrank `account.credential` ({@link
  // outranksCredential}), and the open window refuses `log.mutate` with no
  // policy consulted while it bypasses `account.credential` under a policy that
  // does not load: `rm -rf .approval/log < .approval/env` and `cp .approval/env
  // .approval/log/events.jsonl` were both relabelled `account.credential` by an
  // early return here, and so both reached the log through a window. So the
  // credential answer is taken HERE only when the segment names no protected
  // path that outranks it. When one is named the answer is DEFERRED: the
  // segment goes on through the table and the protected scan exactly as it
  // would without the credential word, a protected class or a refusal stands,
  // and the credential class answers only where that walk ends on an answer it
  // is stricter than (a read, `gate.self`). Where the walk ends on the
  // protected class, the credential touch is carried beside it as a second
  // class of the command (`also`), never dropped. Write targets need no check
  // here: a protected one has already answered above, carrying it the same way.
  //
  // Fix round 4 (M(L5f-1)): the file a curl or wget upload or request-body
  // option reads is judged with the positionals, so `--upload-file=F`, `-TF`,
  // `--data=@F`, `-Ff=@F`, wget `--post-file=F`, `--body-file=F` and
  // `--input-file=F` take the class `-T F` and `--data @F` take (a credential
  // file `account.credential`, an organ its class). An embedded value whose
  // file the text cannot read is a credential read of an unknown file. The
  // upload's answer never displaces a download output that outranks the
  // credential class (`policy.core`, `fetch-output-unknown`): those answer below.
  const argFlags: ArgExpansion[] = segment.words
    .slice(cursor + 1)
    .map((word) => ({ splits: word.splits, expands: word.expands }));
  const fetched = fetchOutputs(basename, args, argFlags);
  const judged = fetched.sources.length === 0 ? positionals : [...positionals, ...fetched.sources];
  const fetchedOutputProtected = strictestProtected(
    [...fetched.files, ...fetched.directories.filter((directory) => directory !== ".")],
    protectedPaths,
  );
  const fetchOutranksCredential =
    fetched.unknown !== null || (fetchedOutputProtected !== null && outranksCredential(fetchedOutputProtected.surface));
  const uploadCredential = fetchOutranksCredential ? null : uploadCredentialTouch(fetched.sources, fetched.sourceUnknown);
  // Merge of APRV-511 and APRV-522: APRV-522's credential read words (option
  // and redirect targets, git's readers) and APRV-511's upload sources. An
  // upload option word APRV-522 also reads is named by the file it sends, as
  // APRV-511 names it; a positional or an environment reference keeps its own.
  const argCredential = credentialTouch(basename, args);
  const credential =
    argCredential === null
      ? uploadCredential
      : uploadCredential !== null && argCredential.path !== undefined && !positionals.includes(argCredential.path)
        ? uploadCredential
        : argCredential;
  const redirectCredential = redirectCredentialTouch(readTargets, redirectTargets);
  const outranking =
    credential === null && redirectCredential === null
      ? null
      : outrankingProtected(
          judged,
          readTargets,
          credentialWritesOnly(basename, args) || credentialProtectedScanKeeps(basename),
          protectedPaths,
        );
  // Merge of APRV-511 and APRV-522: APRV-522's credential read words include
  // an upload's option words, so a credential answer is deferred, never taken
  // here, while a download output outranks it (`policy.core`,
  // `fetch-output-unknown` answer below), as APRV-511 keeps the upload's own.
  if (outranking === null && !fetchOutranksCredential) {
    if (credential !== null) return { ok: true, ...credential };
    if (redirectCredential !== null) return { ok: true, ...redirectCredential };
  }
  const deferredCredential = credential ?? redirectCredential;
  const sub = positionals[0] ?? null;
  const substituted = segment.words
    .slice(cursor + 1)
    .some((word) => word.substitutions.length > 0);
  const binExact = (segment.words[cursor] as LexWord).exact;
  const rule = matchRule(basename, sub, args, substituted, assigned, assignments, bin, execShape !== null, binExact);
  if (rule === null) {
    // `defaults.unclassified_command: abstain` (ClassifierContext.noRuleSegments).
    // FAIL CLOSED. The segment stands in as no-rule only when no word of it
    // (the binary, assignments, flags with their dashes stripped, positionals,
    // redirect targets) looks like a path or carries anything the shell would
    // still change: no `/`, no leading `~` or `.`, no glob or brace character,
    // no `$`, no `=` or `:`, no substitution, no single-dash word longer than
    // two characters; when it has no heredoc, here-string or other stdin-fed
    // body; when no cwd it is judged from is inside a dot-directory, a
    // protected path or a credential home; and when no word, as written or
    // resolved against each of those cwds, names a protected path or a
    // credential. Anything else keeps the refusal.
    const lexWords = [...segment.words, ...segment.redirects.map((redirect) => redirect.target)];
    const cwds = (context.noRuleCwds ?? []).map((dir) => dir.replace(/\/+$/u, ""));
    const resolvedWords = lexWords.flatMap((word) => cwds.map((dir) => `${dir}/${word.text}`));
    const cwdRefused = cwds.some(
      (dir) =>
        dir.split("/").some((part) => part.startsWith(".")) ||
        strictestProtected([dir, `${dir}/`], protectedPaths) !== null ||
        isCredentialPathAsRead(dir) ||
        isCredentialPathAsRead(`${dir}/`),
    );
    const guarded =
      cwdRefused ||
      segment.heredoc ||
      segment.stdinFed ||
      segment.bodySubstitutions.length > 0 ||
      segment.redirects.some((redirect) => redirect.op === "<") ||
      lexWords.some((word) => !word.exact || word.substitutions.length > 0 || noRuleWordRefused(word.text)) ||
      deferredCredential !== null ||
      fetched.unknown !== null ||
      fetchedOutputProtected !== null ||
      strictestProtected([...lexWords.map((word) => word.text), ...resolvedWords], protectedPaths) !== null ||
      [...lexWords.map((word) => word.text), ...resolvedWords].some((word) => isCredentialPathAsRead(word)) ||
      // F-12 fold (review-b N2): APFS and the default macOS volume are case-
      // insensitive, so `>> approval.md` is the policy file. Fail closed: a bare
      // word that names a protected file or a credential in ANY case refuses.
      lexWords.some((word) => protectedNameFolded(word.text, protectedPaths) || isCredentialPathAsRead(foldNameLower(word.text))) ||
      // F-12 fold (review-b M1, laundering): a known command behind a word the
      // table does not know (`uv run npm publish`, `caffeinate -i npm publish`,
      // `su x -c 'npm publish'`) is not a no-rule segment. Last, so it runs
      // only for a segment every other guard let through.
      // F-12 fold (SEC-4): a binary the rule table KNOWS, with a subcommand no
      // row lists (`npm pub`, a git or gh alias, `make <target>`), is a miss on
      // a known program, not a no-rule segment: today's deny.
      knownRuleBin(basename) ||
      // F-12 fold round 2 (review-b CS2): a harness name or an alias of one
      // (`claude-bountify`, `claude-b1`, `claude-edge`, `claude-crash`) is
      // never a no-rule segment: today's deny.
      harnessNamed(basename) ||
      // F-12 fold (SEC-2, SEC-3): APFS folds case and Unicode, so `NPM
      // publish`, `ｎｐｍ publish` or a lookalike letter may run a real binary.
      // An ALLOWLIST: the command word and every later word (each is read as a
      // command by the tail check below) must be lower-case ASCII.
      (context.noRuleSegments === true && segment.words.slice(cursor).some((word) => !NO_RULE_COMMAND_WORD.test(word.text))) ||
      (context.noRuleSegments === true && tailReachesRule(segment, protectedPaths, context, 0));
    return {
      ok: false,
      code: "unclassified",
      // SEC-4: only a binary no row names is a plain no-rule miss for the tail check
      // (CS2: nor is a harness name, so `frobnicate claude-b1 -p hi` keeps the deny).
      ...(knownRuleBin(basename) || harnessNamed(basename) ? {} : { ruleless: true as const }),
      ...(guarded ? {} : { noRule: true as const }),
      detail:
        sub === null
          ? `no rule for ${basename}`
          : `no rule for ${basename} ${sub}`,
    };
  }

  const ctx: RuleContext = { bin: basename, args, positionals, sub, substituted, assigned, assignments, context };
  const refined = rule.refine === undefined ? null : rule.refine(ctx);
  if (rule.refine !== undefined && refined === null) {
    return { ok: false, code: "opaque", detail: `${basename} runs inline source` };
  }
  // APRV-283: a refinement that carries its own reason for being unreadable.
  if (refined !== null && "opaque" in refined) {
    return { ok: false, code: "opaque", detail: refined.opaque };
  }
  let cls = refined === null ? rule.class : refined.class;
  let ruleId = refined === null ? rule.id : refined.rule;
  // The value a refinement bound, when one did (APRV-352). Same field and same
  // meaning as the protected-path binding above: the words the classifier
  // matched, verbatim, so an approver is told WHICH refs a deletion names
  // rather than being handed a class and left to re-read the command.
  const boundPath = refined !== null && "path" in refined ? refined.path : undefined;

  // APRV-511 refuter S1: a download's output file is a write target, whatever
  // class the fetch earned (`curl -o ~/.hermes/plugins/x/__init__.py URL` is
  // `read.web` by its method). A protected output answers with its class, as a
  // redirection onto it would.
  // Refuter S3: the destination directory a copy, move, link or install names
  // in a flag (`-t<dir>`, `--target-directory=<dir>`) is a write target too;
  // `-t <dir>` already reaches the positional scan below.
  const copyFamily = ["cp", "mv", "ln", "install"].includes(basename);
  // GLOB-WRITE: the words this command writes through, read as the shell may
  // still read them ({@link globWriteOperands}).
  // Review of 039b840a (finding 2): a copy tool's argv read by its option
  // table, so an option's value is never taken for the destination.
  const plan = copyPlan(basename, args);
  // Lead ruling L61587: a recursive delete, move or chmod of a PARENT of an
  // organ directory (`rm -rf .`, `mv "$PWD" ../x`, `chmod -R 000 ~`), decided
  // by the hook's listing of it ({@link organParentClass}).
  // Review of e6b7bf97 (1): with no destination read, or an implied one,
  // every positional is judged, as main judged them.
  const writtenOperands =
    plan !== null && ["cp", "ln", "install"].includes(basename)
      ? plan.unknown !== null
        ? [...plan.operands, ...plan.dests]
        : plan.dests.length === 0 || plan.implicitDest === true
          ? [...positionals, ...plan.dests]
          : plan.dests
      : globWriteOperands(basename, positionals);
  // Lead ruling L62013 (S2): the parents rule reads the operands of the
  // commands that remove, move or change access to everything below them
  // ({@link organParentOperands}); a released plain `mkdir` or `touch` has none.
  // Not every command's: an operand the text cannot place is `policy.core`
  // here, fail closed, so reading every command's operands would make
  // `git push origin $BRANCH` and `rm ../sibling/file` policy.core.
  const parentOperands = organVerbs ? organParentOperands(basename, args, positionals, plan, segment.words.slice(0, cursor)) : [];
  const organParent =
    context.organParentsOff === true || mainRulesOnly
      ? { named: null, git: new Set<string>() }
      : organParentClass(parentOperands, segment.words, protectedPaths, glob.disk);
  if (organParent.named !== null || organParent.git.size > 0) {
    // A GLOB-WRITE-family rule (main has none): the main pass joins the line
    // (lead ruling L61926), as it does for #686's rules.
    markGlobWriteFired();
    if (glob.tracker !== undefined) glob.tracker.parent = true;
  }
  // A set, not a scan per word (review A686-FOLD2, M2): the same answer.
  const writtenSet = new Set(writtenOperands);
  const writtenInexact = (text: string): boolean => writtenSet.has(text) && inexact(text);
  const targetDirectories = copyFamily ? copyTargetDirectories(args) : [];
  // Fix round 3 (S(open)): what the shell may still do to each argv word
  // (`argFlags`, and `fetched` from it, are read above the credential tier).
  // A directory a download writes server-chosen names into is judged as the
  // directory: an organ directory, or the home root, is an organ write.
  const fetchedDirectories = fetched.directories.filter((directory) => directory !== ".");
  const fetchedProtected = strictestProtectedWrite(
    [...fetched.files, ...targetDirectories, ...fetchedDirectories],
    protectedPaths,
    inexact,
    false,
    glob,
  );
  if (fetchedProtected !== null) {
    return { ok: true, class: fetchedProtected.surface, rule: "protected-path", path: fetchedProtected.path };
  }
  // APRV-511 review: a download whose output this table cannot know (an
  // option it does not know, an ambiguous prefix, a config file or string) is
  // a write to an unknown target, and an unknown target may be an organ.
  if (fetched.unknown !== null) {
    return { ok: true, class: "policy.core", rule: "fetch-output-unknown", path: fetched.unknown };
  }
  // Fix round 3 (S(open)): a copy, move or link argv word the shell may still
  // turn into an option (`cp $X f`, `cp *.md d/`, `mv {-t,DIR} f`) may name
  // the destination, so the destination is unknown: `policy.core`, unless a
  // named path already earns a class at least as strict (the log).
  const copyUnknown = copyFamily ? copyArgvUnknown(args, argFlags) : null;
  if (copyUnknown !== null) {
    const named = strictestProtectedWrite([...positionals, ...readTargets], protectedPaths, writtenInexact, false, glob);
    if (named !== null && protectedRank(named.surface) <= protectedRank("policy.core")) {
      return { ok: true, class: named.surface, rule: "protected-path", path: named.path };
    }
    return { ok: true, class: "policy.core", rule: "copy-target-unknown", path: copyUnknown };
  }

  // GLOB-WRITE: a read-class command that writes a file through its own words
  // (`sort -o F`, `uniq in F`, sed's `w F`; {@link readWriteTargets}) writes
  // that file, so a protected one, spelled plainly, by a pattern or by a
  // `${…}` default, takes its class as a redirection onto it would.
  if (cls.startsWith("read.") && !mainRulesOnly) {
    const written = strictestProtectedWrite(readWriteTargets(basename, args), protectedPaths, inexact, false, glob);
    if (written !== null) {
      markGlobWriteFired();
      return { ok: true, class: written.surface, rule: "protected-path", path: written.path };
    }
  }

  // A protected path anywhere in an effectful segment takes that path's class:
  // the command is editing the gate, whatever else it is doing. Every
  // positional is scanned, source and destination alike, so `cp` stays
  // direction-blind — a copy OUT of the policy directory is as gated as a copy
  // into it, because the classifier cannot tell which argument the binary will
  // treat as the destination and guessing would be the ungated direction.
  //
  // This is the ONE scan that skips prose (APRV-409, `skipProse`): a positional
  // is whatever the author quoted, and an acceptance criterion that opens with
  // a directory path is a sentence rather than a file. Redirection targets
  // above, and the apply-patch and file-tool paths elsewhere, are paths by
  // construction and are not offered the skip.
  //
  // APRV-503: an INPUT redirection's target is scanned here too, as the named
  // argument it stands in for (`node x.js < APPROVAL.md` is `node x.js
  // APPROVAL.md` with the file on stdin), and without the prose skip, because a
  // redirection target is a path by construction. Its direction is known to be a
  // read, so this is the stricter of two defensible answers, which is the one
  // the protected tier takes everywhere else. A read segment keeps `read.*`
  // either way: `cat < APPROVAL.md` reads the policy as `cat APPROVAL.md` does.
  //
  // The rule, stated exactly. The strictest surface among the positionals and
  // the `<` targets answers; on equal rank the positional's path is the one
  // bound. So a `<` target can move an effectful segment only to a STRICTER
  // protected class than its positionals earned (`node CLAUDE.md < APPROVAL.md`
  // is `policy.core`), never to a looser one, and a segment whose positionals
  // earn no protected class can only move from its own class to a protected one.
  if (!cls.startsWith("read.") && cls !== GATE_SELF_CLASS) {
    // A deferred credential answer (above) names the path that outranked it,
    // which is the strictest protected path among the words that are not the
    // credential read itself: the segment's answer without that word.
    //
    // The credential touch is NOT dropped (APRV-503 recheck, SHOULD-FIX-R1): it
    // rides beside the protected class as a second class of the command, so
    // the precedence above decides what the segment is called and never what a
    // policy gets to see. A policy holding `account.credential` stricter than
    // `policy.core` still refuses `cp .approval/env APPROVAL.md`, and SPEC.md
    // §7's "a copy is classified `account.credential` in either direction"
    // holds as written.
    if (deferredCredential !== null && outranking !== null) {
      return {
        ok: true,
        class: outranking.surface,
        rule: "protected-path",
        path: outranking.path,
        also: deferredCredential,
      };
    }
    // GLOB-WRITE: a word the command WRITES that the shell may still glob, or
    // fill from a `${…}` default, is judged by every guarded path it could name
    // ({@link globWriteOperands}).
    const operandNamed = strictestProtectedWrite(judged, protectedPaths, writtenInexact, true, glob);
    // Lead ruling L61195 (b): a copy, move, link or install into a DIRECTORY
    // writes `<dir>/<basename of each source>`, so that file is judged too
    // (`cp evil/settings.json .claude/` is `.claude/settings.json`).
    const landed = plan === null ? null : copyLandings(plan, inexact, glob);
    // Review of b402adec (M2): a destination any name may land in that is a
    // guarded directory or under one, and a source landing AS one
    // (`cp -r evil/.claude .`). The ancestor rule is the follow-up's (L61320).
    const organDest = [
      // A destination is a path by construction, whitespace and all (review of 8e1e84ae, 4).
      ...(plan?.anyName ?? []).map((dest) => organDestination(dest, inexact, glob)),
      ...(landed?.plain ?? []).map((path) => organDestination(path, () => false, glob)),
      // A landing the shell may still glob (`ln -s ../evil/.git?ub`), as a pattern.
      ...(landed?.patterns ?? []).map((path) =>
        organDestination(path, () => true, {
          options: glob.options,
          budget: glob.budget,
          off: glob.off,
          ...(glob.tracker === undefined ? {} : { tracker: glob.tracker }),
        }),
      ),
      ...(plan?.files.length ? [strictestProtectedWrite(plan.files, protectedPaths, inexact, false, glob)] : []),
    ].reduce<{ surface: string; path: string } | null>(
        (best, hit) => (hit !== null && (best === null || protectedRank(hit.surface) < protectedRank(best.surface)) ? hit : best),
        null,
      );
    const landedNamed =
      landed === null
        ? organDest
        : (() => {
            // Landings are paths by construction, judged after lexical normalisation.
            const plainText = strictestProtected(
              landed.plain.map((path) => {
                const { absolute, parts } = lexicalParts(path);
                return (absolute ? "/" : "") + parts.join("/");
              }),
              protectedPaths,
              false,
            );
            const plainHit =
              organDest !== null && (plainText === null || protectedRank(organDest.surface) < protectedRank(plainText.surface)) ? organDest : plainText;
            const patternHit = strictestProtectedWrite(landed.patterns, protectedPaths, () => true, false, {
              options: glob.options,
              budget: glob.budget,
              off: glob.off,
              ...(glob.tracker === undefined ? {} : { tracker: glob.tracker }),
            });
            return plainHit === null || (patternHit !== null && protectedRank(patternHit.surface) < protectedRank(plainHit.surface)) ? patternHit : plainHit;
          })();
    const namedOperand =
      landedNamed !== null && (operandNamed === null || protectedRank(landedNamed.surface) < protectedRank(operandNamed.surface))
        ? landedNamed
        : operandNamed;
    const parentNamed = organParent.named;
    const named =
      parentNamed !== null && (namedOperand === null || protectedRank(parentNamed.surface) < protectedRank(namedOperand.surface))
        ? parentNamed
        : namedOperand;
    const fed = strictestProtected(readTargets, protectedPaths);
    const touched =
      fed === null || (named !== null && protectedRank(named.surface) <= protectedRank(fed.surface))
        ? named
        : fed;
    if (touched !== null) {
      return { ok: true, class: touched.surface, rule: "protected-path", path: touched.path };
    }
  }

  // APRV-503: a credential answer deferred above, because the segment also
  // names a protected path that outranks it. The walk did not end on that
  // protected class (a reader, or the gate's own CLI, is not scanned), so it
  // ended on an answer the credential class is stricter than, and the credential
  // class answers: `cat .approval/log/events.jsonl < .approval/env` reads the
  // environment map. A named credential is reported ahead of a redirected one.
  if (deferredCredential !== null) return { ok: true, ...deferredCredential };

  // A read command with a write redirection writes. `ls > out.txt` creates a
  // file, and the class has to say so.
  const readBeforeRedirect = cls.startsWith("read.") && basename !== "curl" && basename !== "wget" && basename !== "git";
  if (cls.startsWith("read.") && writeTargets.length > 0) {
    cls = "files.write.workspace";
    ruleId = "redirect-write";
  }

  // APRV-518. A write into a git directory can arm a push: `printf '[remote
  // "origin"]\n\tpush = :refs/heads/lane\n' >> .git/config && git push origin`
  // deleted `lane` on git 2.50.1 while it read as a workspace write and an
  // implicit trunk push. The configuration is `.git/config`, and a hook under
  // `.git/hooks/` runs on the next push, so ANY write whose target has a
  // `.git` segment (any case: `.GIT/config` is the same file on a
  // case-insensitive filesystem) takes the class of the strictest push it can
  // arm. Redirection targets always; positionals (and `--flag=value` values)
  // of a segment that is not a read, since the text cannot say which one the
  // binary writes, except `git`'s own. A word with whitespace in it is prose,
  // not a path.
  // `curl -o` / `wget -O` write a file while reading as `read.web`, so their
  // words are scanned too.
  // Follow-up, item B: a read-class command that writes a file through one
  // of its own words (`sort -o`, `uniq in out`, sed's `w`).
  const readOutputs = readWriteTargets(basename, args);
  if (
    (!cls.startsWith("read.") || basename === "curl" || basename === "wget" || basename === "git" || readOutputs.length > 0) &&
    cls !== GATE_SELF_CLASS
  ) {
    const flagValues = args
      .filter((arg) => isFlag(arg) && arg.includes("="))
      .map((arg) => arg.slice(arg.indexOf("=") + 1));
    // `git`'s own words are not file writes: `--git-dir=x/.git` names the
    // repository it runs against, and the git rows classify what git writes
    // (a `git config` write has no row and stays refused).
    // S2: an attached short option's value (`-o.git/config`, `-t.git/hooks`,
    // `-C.git`) and an operand's `key=value` value (`dd of=.git/config`) name
    // where the binary writes as surely as a separate word does.
    const attached = args.flatMap(attachedOptionValues);
    const operandValues = args
      .filter((arg) => !isFlag(arg) && arg.includes("="))
      .map((arg) => arg.slice(arg.indexOf("=") + 1));
    // Second review, S2: git's own words are judged only where git writes a
    // file through them ({@link gitWriteTargets}).
    // Follow-up, item A: a read whose only write is its redirection writes
    // nothing through its own words (`cat .git/HEAD > /tmp/x` reads `.git`
    // and writes `/tmp/x`), so only the redirection targets and the outputs
    // the read names itself (item B) are judged.
    // A sed name is judged BOTH ways, a hit from either counting: as its
    // literal text, since sed expands nothing in a `w` name
    // ({@link sedLiteralGitWrite}), and as a shell word, since the shell
    // expands an unquoted script word before sed sees it (`-e
    // w.g{i,}t/config` reaches sed as `w.git/config`).
    const sedLiteral = basename === "sed" && readBeforeRedirect;
    const named =
      basename === "git"
        ? gitWriteTargets(args)
        : readBeforeRedirect
          ? sedLiteral
            ? []
            : readOutputs
          : [...positionals, ...flagValues, ...attached, ...operandValues];
    const gitWrite =
      gitWriteRefinement(writeTargets, named, context.shellDir, true, context.lineNamesGit === true, (word) =>
        // Lead ruling L61587: a parent whose listing holds `.git`.
        organParent.git.has(word) || dotGlobNamesGit(word, inexact, glob),
      ) ??
      (sedLiteral
        ? (sedLiteralGitWrite(readOutputs, context.shellDir, context.lineNamesGit === true) ??
          gitWriteRefinement([], readOutputs, context.shellDir, true, context.lineNamesGit === true))
        : null);
    if (gitWrite !== null) {
      return { ok: true, ...gitWrite, ...(sandbox === null ? {} : { sandbox }) };
    }
  }

  // APRV-347, last because it is the narrowest: a read whose target the TEXT
  // places outside every root the caller named. Only `read.shell` is scoped —
  // `read.web` reaches no file, and a segment that has already taken a
  // protected, credential or write class is not a read at all. The relative
  // and symlinked cases are deliberately NOT decided here; they are left at
  // `read.shell` for the hook's disk pass, which tightens and never loosens.
  if (cls === "read.shell" && (context.readRoots ?? []).length > 0) {
    // APRV-522 (S2): a `<` target is opened for reading whatever the binary
    // is, so it is scoped for every binary, and a substitution's escaped read
    // counts as the segment's own.
    const escaped =
      escapedReadTarget(basename, positionals, args, context.readRoots ?? []) ??
      redirectReadEscape(readTargets, context.readRoots ?? []) ??
      substitutedEscape;
    if (escaped !== null) {
      return {
        ok: true,
        class: READ_OUT_OF_SCOPE_CLASS,
        rule: escaped.rule,
        path: escaped.path,
        ...(sandbox === null ? {} : { sandbox }),
      };
    }
  }

  // APRV-510: the program, for the hook to hash. Attached only when the
  // segment's FINAL class is `exec.code`: a protected or credential answer
  // above has already replaced it, and carries no program.
  const execCode: ExecCodeSource | null =
    cls === EXEC_CODE_CLASS && rule.id === EXEC_CODE_ROW && execShape !== null
      ? {
          interpreter: basename,
          mode: execShape.mode,
          source: args[execShape.index] as string,
          argv: words.slice(cursor),
          sourceIndex: execShape.index + 1,
        }
      : null;

  return {
    ok: true,
    class: cls,
    rule: ruleId,
    ...(boundPath === undefined ? {} : { path: boundPath }),
    ...(sandbox === null ? {} : { sandbox }),
    ...(execCode === null ? {} : { execCode }),
  };
}

/**
 * Classify a shell command line into the classes it would produce.
 *
 * Every segment must classify: one unreadable segment refuses the whole
 * command, because a command line's effect is the union of its parts and a
 * partial answer would authorize the parts we happened to understand.
 *
 * `protectedPaths` is `policy.protected_paths` (APRV-107), added to the
 * built-in protected set rather than replacing it. Omitting it classifies
 * against the built-ins alone, which is the strictly narrower answer, so a
 * caller that forgets it under-reports the protected classes rather than inventing an
 * authorization; every enforcement path passes the loaded policy's list.
 *
 * Since APRV-266 an entry may be `{path, class}`, routing that path family to a
 * `policy.edit` sub-class. The classifier stays what it was: the entry's class
 * is DATA it copies out of the policy, matched by the same segment matcher as
 * every other entry, so this resolves no autonomy at all.
 *
 * `context` (APRV-267) carries the machine facts a caller has resolved: today
 * only `scratchRoots`. It behaves exactly as `protectedPaths` does: omitting it
 * yields the strictly narrower answer, because every rule that reads it can only
 * ever LOOSEN a class, and no rule reads it to loosen a protected or credential
 * one.
 */
/**
 * A word a no-rule stand-in may not carry (`defaults.unclassified_command:
 * abstain`): anything that looks like a path or that the shell would still
 * change. `/`, `$`, `=`, `:`, a glob or brace character anywhere, or a leading
 * `~` or `.` once a flag's dashes are stripped.
 */
function noRuleWordRefused(text: string): boolean {
  const bare = text.replace(/^-+/u, "");
  const joinedShortFlag = text.startsWith("-") && !text.startsWith("--") && text.length > 2;
  return joinedShortFlag || /[/$=:*?[\]{}]/u.test(text) || bare.startsWith("~") || bare.startsWith(".");
}

/**
 * The command words that change the shell's directory: bash's three and zsh's
 * `chdir` (F-12 fold, review-b M2b: Claude Code runs Bash commands in $SHELL,
 * zsh on macOS). No other bash, zsh, dash or ksh builtin changes it; an alias,
 * a function or `AUTO_CD` can (Known limits).
 */
const DIRECTORY_VERBS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"]);

/**
 * The only spelling a word the no-rule guard reads as a command may have (F-12
 * fold, SEC-2/SEC-3): lower-case ASCII letters, digits and `_ . + / -`. An
 * allowlist, because APFS folds case and Unicode (`NPM`, `ｎｐｍ`, a letter with
 * a diacritic, a Cyrillic lookalike may all reach a real binary).
 */
const NO_RULE_COMMAND_WORD = /^[a-z0-9_.+/-]+$/u;

/** Every binary some row of {@link COMMAND_RULES} names (F-12 fold, SEC-4). */
let KNOWN_RULE_BINS: ReadonlySet<string> | null = null;
function knownRuleBin(basename: string): boolean {
  KNOWN_RULE_BINS ??= new Set(COMMAND_RULES.flatMap((rule) => rule.bins));
  return KNOWN_RULE_BINS.has(basename);
}

/**
 * A command word that names an agent harness or an alias of one (F-12 fold
 * round 2, review-b CS2): `claude`, `codex`, `hermes`, `cursor`, `muse`,
 * `grok`, alone or followed by `-` or `_` and anything (`claude-bountify`,
 * `claude-b1`, `claude-edge`, `claude-crash`, `cursor-agent`). Claude Code's
 * Bash tool keeps the user's shell aliases, and a text classifier cannot see
 * an alias, so such a word never stands in as a no-rule segment: today's deny.
 */
const HARNESS_NAMED = /^(?:claude|codex|hermes|cursor|muse|grok)(?:[-_].*)?$/u;
function harnessNamed(basename: string): boolean {
  return HARNESS_NAMED.test(basename);
}

/** Words past which the no-rule tail check refuses outright (fail closed). */
const NO_RULE_TAIL_WORDS = 64;
/** Nesting of quoted scripts the tail check reads before it refuses. */
const NO_RULE_TAIL_DEPTH = 3;

/**
 * Does a no-rule segment hand any of its later words to a command the rule
 * table knows (F-12 fold, review-b M1: laundering)? Every tail `words[i..]`
 * (i >= `from`) is classified as a segment of its own with the stand-in OFF;
 * any answer other than the plain no-rule miss (a class, an opaque or any
 * other refusal) answers yes. This is also where `command` and `builtin` are
 * TRANSPARENT, as bash reads them: `command npm publish` runs `npm publish`,
 * so its tail is classified and the segment keeps today's deny. Deliberately
 * not a classified answer for the whole segment: the classifier without the
 * key stays as it was, and a runner never earns an allow its bare form would
 * need a policy row for. A word carrying a space or a shell operator
 * (`su x -c 'npm publish'`, `osascript -e 'do shell script "…"'`) is read as
 * the script a runner may hand to a shell: it must lex, and each of its
 * segments is judged the same way from its first word. Fail closed: too many
 * words, too deep a nesting, a script that does not lex or carries an opaque
 * construct answers yes.
 */
function tailReachesRule(
  segment: LexSegment,
  protectedPaths: readonly ProtectedPathEntry[],
  context: ClassifierContext,
  depth: number,
  from = 1,
): boolean {
  if (depth > NO_RULE_TAIL_DEPTH || segment.words.length > NO_RULE_TAIL_WORDS) return true;
  const off: ClassifierContext = { ...context, noRuleSegments: false, execCode: false };
  for (let at = from; at < segment.words.length; at += 1) {
    const words = segment.words.slice(at);
    // SEC-2/SEC-3: a word read as a command is lower-case ASCII or refused.
    if (!NO_RULE_COMMAND_WORD.test((words[0] as LexWord).text)) return true;
    const outcome = classifySegment({ ...segment, words }, protectedPaths, off);
    if (outcome.ok || outcome.ruleless !== true) return true;
  }
  for (const word of segment.words) {
    if (!/[\s;&|<>()`'"\\]/u.test(word.text)) continue;
    if (quotedScriptRefused(word.text, protectedPaths, context, depth)) return true;
  }
  return false;
}

/**
 * SEC-1: a quoted script stands in only as ONE plain segment that passes the
 * no-rule guard itself; anything else is today's deny. Defence in depth (F-12
 * fold round 2, review-b CN1): through {@link classifyCommand} every word that
 * carries a space or a quote is refused first by the SEC-3 allowlist, so this
 * check is reached today only by its unit test (tests/cli-hook-abstain.test.ts
 * (z7)). It stays so that a later widening of the allowlist cannot open it.
 */
export function quotedScriptRefused(
  script: string,
  protectedPaths: readonly ProtectedPathEntry[],
  context: ClassifierContext,
  depth: number,
): boolean {
  const inner = lex(script);
  if (!inner.ok || inner.segments.length !== 1) return true;
  const part = inner.segments[0] as LexSegment;
  return innerPartRefused(part, protectedPaths) || tailReachesRule(part, protectedPaths, context, depth + 1, 0);
}

/**
 * The no-rule guard applied to a script lexed out of a quoted word (F-12 fold,
 * SEC-1): no redirection, heredoc, stdin feed, subshell, substitution or
 * opaque construct; no word that is not a literal, looks like a path, changes
 * directory, or names a protected file or a credential in any case; and a
 * command word of lower-case ASCII only (SEC-2, SEC-3).
 */
function innerPartRefused(part: LexSegment, protectedPaths: readonly ProtectedPathEntry[]): boolean {
  return (
    part.opaque !== null ||
    part.heredoc ||
    part.stdinFed ||
    part.subshell ||
    part.redirects.length > 0 ||
    part.bodySubstitutions.length > 0 ||
    !NO_RULE_COMMAND_WORD.test(part.words[0]?.text ?? "") ||
    part.words.some(
      (word) =>
        !word.exact ||
        word.substitutions.length > 0 ||
        noRuleWordRefused(word.text) ||
        DIRECTORY_VERBS.has(word.text.split("/").pop() ?? "") ||
        protectedNameFolded(word.text, protectedPaths) ||
        strictestProtected([word.text], protectedPaths) !== null ||
        isCredentialPathAsRead(word.text) ||
        isCredentialPathAsRead(foldNameLower(word.text)),
    )
  );
}

/**
 * Does `text`, compared without case, name a protected file by its basename
 * (F-12 fold, review-b N2)? The built-in names and the policy's own entries.
 * Read only by the no-rule guard, where rule (1) has already refused any word
 * with a `/` or a leading `.`, so a bare name is the whole question.
 */
function protectedNameFolded(text: string, protectedPaths: readonly ProtectedPathEntry[]): boolean {
  const folded = foldNameLower(text);
  if (folded.length === 0) return false;
  const names = [
    ...CORE_FILENAMES,
    ...PROTECTED_FILENAMES,
    ...protectedPaths.map((entry) => (typeof entry === "string" ? entry : entry.path)),
  ];
  return names.some((name) => foldNameLower(name.split("/").filter((part) => part.length > 0).pop() ?? "") === folded);
}

/**
 * May any segment change the shell's directory (`defaults.unclassified_command:
 * abstain`)? Judged from the LEXED words, every word of every segment (so a
 * runner, `builtin`, a shell keyword like `if`, `while` or `!` in front of it
 * changes nothing): any word whose dequoted basename is `cd`, `pushd` or `popd`
 * answers yes. Every substitution body (in a word, a redirection or a heredoc
 * body) is lexed and judged the same way. Fail closed: a command word (the
 * first after the assignments) that is not a literal, or a body that does not
 * lex, answers yes.
 */
function segmentsMayChangeDirectory(segments: readonly LexSegment[], depth = 0): boolean {
  if (depth > 8) return true;
  for (const segment of segments) {
    const bodies = [
      ...segment.bodySubstitutions,
      ...segment.words.flatMap((word) => word.substitutions),
      ...segment.redirects.flatMap((redirect) => redirect.target.substitutions),
    ];
    for (const body of bodies) {
      const inner = lex(body);
      if (!inner.ok || segmentsMayChangeDirectory(inner.segments, depth + 1)) return true;
    }
    const commandWord = segment.words.find((word) => !word.assignment);
    if (commandWord !== undefined && !commandWord.exact) return true;
    if (segment.words.some((word) => DIRECTORY_VERBS.has(word.text.split("/").pop() ?? ""))) return true;
  }
  return false;
}

/**
 * Classify a command line, in both name readings (`name-fold.ts`).
 *
 * The line is classified with guarded names folded (how APFS opens them), and
 * again as spelled (how every guard read names before they folded) whenever
 * the two readings can differ. The answer is the folded one, plus every class
 * the as-spelled answer gives a segment that the folded answer for the same
 * segment text lacks, as its own entry over that text (the shape a pipeline
 * and APRV-503's `also` entry already have), so a reader of `segments` and
 * `classes` judges both without learning a new field. A refusal in either
 * reading refuses the line, the folded one first. So the classes this
 * returns always contain the classes the as-spelled reading alone returns,
 * and a policy that judges each class cannot answer a folded spelling more
 * lightly than it answered that spelling before names folded.
 */
export function classifyCommand(
  command: string,
  protectedPaths: readonly ProtectedPathEntry[] = [],
  context: ClassifierContext = {},
): CommandClassification {
  return unionNameReadings(eachNameReading(() => classifyCommandAsRead(command, protectedPaths, context)));
}

/**
 * {@link classifyCommand} in the CURRENT name reading only. For a caller that
 * runs a larger chain in both readings and joins them with
 * {@link unionNameReadings} itself (the hook's `classifyForHook`); anything
 * else asks {@link classifyCommand}.
 */
export function classifyCommandInThisReading(
  command: string,
  protectedPaths: readonly ProtectedPathEntry[] = [],
  context: ClassifierContext = {},
): CommandClassification {
  return classifyCommandAsRead(command, protectedPaths, context);
}

/**
 * Join a classification's name readings (`[folded]`, `[folded, asSpelled]`,
 * or the folded answer once per equal claim and then the as-spelled one) as
 * {@link classifyCommand} states: the folded answer, then each later
 * reading's segment whose class the answer so far lacks for that segment
 * text; a refusal in any reading refuses, the folded one first.
 */
export function unionNameReadings(readings: readonly CommandClassification[]): CommandClassification {
  const [folded, ...others] = readings;
  if (folded === undefined) throw new TypeError("unionNameReadings needs the folded reading");
  if (!folded.ok) return folded;
  for (const other of others) if (!other.ok) return other;
  if (others.length === 0) return folded;
  const segments = [...folded.segments];
  const classes = [...folded.classes];
  // Keyed, so a line of many segments joins in linear time.
  const key = (segment: ClassifiedSegment): string => `${segment.class}\u0000${segment.text}`;
  const have = new Set(segments.map(key));
  const known = new Set(classes);
  for (const other of others) {
    if (!other.ok) continue;
    for (const segment of other.segments) {
      if (have.has(key(segment))) continue;
      have.add(key(segment));
      segments.push({ ...segment });
      if (!known.has(segment.class)) {
        known.add(segment.class);
        classes.push(segment.class);
      }
    }
  }
  return { ok: true, segments, classes };
}

function classifyCommandAsRead(
  command: string,
  protectedPaths: readonly ProtectedPathEntry[],
  context: ClassifierContext,
): CommandClassification {
  if (mainRulesOnly) return classifyCommandAsReadWithRules(command, protectedPaths, context);
  // THE SEAM (lead ruling L61926): where a GLOB-WRITE rule fired, main's
  // answer for the line joins this one; a refusal in it refuses.
  const outer = globWriteFired;
  globWriteFired = false;
  try {
    const result = classifyCommandAsReadWithRules(command, protectedPaths, context);
    if (!globWriteFired) return result;
    const main = withMainRules(() => classifyCommandAsReadWithRules(command, protectedPaths, context));
    return unionNameReadings([result, main]);
  } finally {
    globWriteFired = outer;
  }
}

function classifyCommandAsReadWithRules(
  command: string,
  protectedPaths: readonly ProtectedPathEntry[],
  context: ClassifierContext,
): CommandClassification {
  const lexed = lex(command);
  if (!lexed.ok) {
    return { ok: false, code: "unparseable", segment: command.trim(), detail: lexed.detail };
  }
  if (lexed.segments.length === 0) {
    return { ok: false, code: "unclassified", segment: command.trim(), detail: "empty command" };
  }

  // APRV-521: a variable git could inherit, set by this line's own shell,
  // reaches every git segment on the line and in its substitutions.
  const shellEnvWrite = context.shellEnvWrite ?? gitEnvironmentWrite(lexed.segments) ?? undefined;
  if (shellEnvWrite !== undefined) context = { ...context, shellEnvWrite };

  const segments: ClassifiedSegment[] = [];
  const classes: string[] = [];
  // APRV-510 (security review, finding 1): once a segment may have changed
  // what a bare name resolves to, `exec.code` is closed for the rest of the
  // line, so a later `python3 -c` keeps its pre-APRV-510 refusal.
  let execContext = context;
  // `defaults.unclassified_command: abstain`: a command that changes directory
  // anywhere, judged from its lexed command words (subshells and every
  // substitution body included, fail closed on a word that is not a literal),
  // moves where a no-rule segment's words land, so no segment of it stands in.
  const movesDirectory = context.noRuleSegments === true && segmentsMayChangeDirectory(lexed.segments);
  // APRV-518 (S1): where the line's literal `cd`s have moved the shell, so a
  // relative write after `cd .git` is judged where it lands.
  let shellDir: ShellDir | null = context.shellDir === undefined ? SHELL_DIR_START : context.shellDir;
  // Second review, S3: the line may carry `.git` to a write through a variable
  // or a substitution it sets itself. An inner script (`bash -c '…'`, a
  // substitution body) reads its own text too, on top of what its line
  // spells: a spelling inside single quotes is no substitution to the outer
  // line, and is one to the script (substitution fold).
  // A substitution body the line's reading already went through is not read
  // again (review of the substitution fold, M1): that reading found nothing,
  // and this one would find the same.
  const lineNamesGit =
    context.lineNamesGit === true || (context.bodyAlreadyRead !== true && lineSpellsGitIndirectly(lexed.segments));
  const spelledSegments = new WeakSet<LexSegment>(lexed.segments);
  // GLOB-WRITE (lead ruling L60846): an option this line (or a script inside
  // it) may set is read. Dot matching set earlier or in a profile is read on
  // every line (L61492, L61497).
  const lineSetsDotglob = context.lineSetsDotglob === true || lineMaySetDotglob(command);
  // GLOB-WRITE (L61167): a relative pattern is placed by the caller's cwd only
  // on a line that cannot move the shell first.
  // Review of 6e3cbc9e: listings are used only on a line where nothing else
  // can create, move, link or extract a file before or beside the pattern
  // (M2), and a `~` prefix only on a line that names no `HOME` (M3).
  const globDisk =
    context.globDisk === undefined
      ? undefined
      : {
          ...context.globDisk,
          relativeOk: context.globDisk.relativeOk !== false && !segmentsMayChangeDirectory(lexed.segments),
          homeOk: context.globDisk.homeOk !== false && !command.includes("HOME"),
          listingsOk: context.globDisk.listingsOk !== false && lineListingSafe(command, lexed.segments),
          singleSegment: context.globDisk.singleSegment !== false && lexed.segments.length === 1,
        };
  const diskField = {
    ...(globDisk === undefined ? {} : { globDisk }),
    // Review-b M1: ONE matcher budget for the whole line and every script read inside it.
    globBudget: context.globBudget ?? { left: GLOB_GUARD_STEP_CAP },
  };
  context = { ...context, lineNamesGit, lineSetsDotglob, ...diskField, spelledSegments, bodyAlreadyRead: false };
  execContext = { ...execContext, lineNamesGit, lineSetsDotglob, ...diskField, spelledSegments, bodyAlreadyRead: false };
  for (const segment of lexed.segments) {
    if (execContext.execCode === true && movesNameResolution(segment)) {
      execContext = { ...execContext, execCode: false };
    }
    execContext = { ...execContext, shellDir };
    shellDir = nextShellDir(segment, shellDir);
    // APRV-380. A LOGIN-SHELL WRAPPER is classified by the script it runs.
    // `loginShellScript` states the exact shape and why this is not the second
    // parser `OPAQUE_BINS` refuses; the inner classification is run with
    // `unwrapShell: false`, so a shell nested inside the script stays opaque
    // and the recursion is one level deep by construction.
    const script = context.unwrapShell === false ? null : loginShellScript(segment);
    if (script !== null) {
      // APRV-510: and with `exec.code` closed. `bash -c` and `sh -c` stay out of
      // the class's scope, so a program inside an unwrapped shell script keeps
      // the refusal it had before the class existed.
      // F-12 fold (review-b M2a): the inner script runs in the directory the
      // OUTER command moved to, which the inner scan cannot see, so after an
      // outer cd/pushd/popd/chdir no inner segment stands in.
      const inner = classifyCommandAsRead(script, protectedPaths, {
        ...context,
        shellDir: execContext.shellDir ?? null,
        unwrapShell: false,
        execCode: false,
        noRuleSegments: context.noRuleSegments === true && !movesDirectory,
      });
      if (!inner.ok) {
        // The refusal is the INNER one, reported against the inner segment: an
        // operator told `hook-opaque` for `zsh` learns nothing, and one told
        // which part of their script could not be read can rewrite it.
        return inner;
      }
      // Spliced rather than collapsed into one segment: a script is a command
      // line and its parts have their own classes, which is the thing a
      // one-class answer would lose.
      for (const found of inner.segments) {
        segments.push(found);
        if (!classes.includes(found.class)) classes.push(found.class);
      }
      continue;
    }
    // Review-b S1: a pattern reading never takes a class AWAY. Where it raised
    // the segment, the plain (text-only) answer is classified too, and a
    // different one rides beside the raised class (`patternAlso`), so a policy
    // that prices the plain class stricter than the raised one still sees it.
    const tracker: { raised: boolean; parent?: boolean } = { raised: false };
    const raisedOutcome = classifySegment(segment, protectedPaths, { ...execContext, globTracker: tracker });
    const patterned = tracker.raised
      ? besidePlain(raisedOutcome, classifySegment(segment, protectedPaths, { ...execContext, globPatternsOff: true }))
      : raisedOutcome;
    // Lead ruling L61587: the parents rule adds its class and never takes one
    // away. Where it fired, the segment is classified without it too, and that
    // class (an ordinary write included) rides beside: under a policy that
    // holds files.write.workspace stricter than policy.edit, `chmod -R 000 .`
    // in a tree holding `.github` keeps main's answer.
    const outcome = tracker.parent === true ? besideParent(patterned, classifySegment(segment, protectedPaths, { ...execContext, organParentsOff: true })) : patterned;
    if (!outcome.ok && outcome.noRule === true && context.noRuleSegments === true && !movesDirectory) {
      segments.push({ text: segment.text, class: NO_RULE_CLASS, rule: "no-rule", noRule: outcome.detail });
      if (!classes.includes(NO_RULE_CLASS)) classes.push(NO_RULE_CLASS);
      continue;
    }
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, segment: segment.text, detail: outcome.detail };
    }
    segments.push({
      text: segment.text,
      class: outcome.class,
      rule: outcome.rule,
      ...(outcome.path === undefined ? {} : { path: outcome.path }),
      ...(outcome.sandbox === undefined ? {} : { sandbox: outcome.sandbox }),
      ...(outcome.execCode === undefined ? {} : { execCode: outcome.execCode }),
    });
    if (!classes.includes(outcome.class)) classes.push(outcome.class);
    // APRV-503 recheck: the credential touch a protected answer outranked, as
    // its own entry over the same segment text. The shape a pipeline already
    // has (one entry per class-bearing part), so every reader of `segments`
    // and `classes` sees it without learning a new field.
    if (outcome.also !== undefined) {
      segments.push({
        text: segment.text,
        class: outcome.also.class,
        rule: outcome.also.rule,
        ...(outcome.also.path === undefined ? {} : { path: outcome.also.path }),
      });
      if (!classes.includes(outcome.also.class)) classes.push(outcome.also.class);
    }
    if (outcome.patternAlso !== undefined) {
      segments.push({
        text: segment.text,
        class: outcome.patternAlso.class,
        rule: outcome.patternAlso.rule,
        ...(outcome.patternAlso.path === undefined ? {} : { path: outcome.patternAlso.path }),
      });
      if (!classes.includes(outcome.patternAlso.class)) classes.push(outcome.patternAlso.class);
    }
    if (outcome.parentAlso !== undefined && outcome.parentAlso.class !== outcome.class && outcome.parentAlso.class !== outcome.patternAlso?.class) {
      segments.push({
        text: segment.text,
        class: outcome.parentAlso.class,
        rule: outcome.parentAlso.rule,
        ...(outcome.parentAlso.path === undefined ? {} : { path: outcome.parentAlso.path }),
      });
      if (!classes.includes(outcome.parentAlso.class)) classes.push(outcome.parentAlso.class);
    }
  }
  return { ok: true, segments, classes };
}

// ===========================================================================
// Segment words (APRV-144)
// ===========================================================================

/** One segment's words, as the classifier's own tokenizer read them. */
export interface CommandSegmentWords {
  /** The segment's source text, as written. */
  text: string;
  /** The binary, `VAR=value` prefixes already skipped, quotes already removed. */
  bin: string;
  /** Every word after the binary, flags included, in order. */
  args: string[];
}

/**
 * The words of each segment, from the SAME parse {@link classifyCommand} uses.
 *
 * Exported for the channel-side command breakdown (APRV-144): a prompt that
 * says what a compound command does needs the verb and the arguments of each
 * segment, and a display layer that re-split the string itself would be a
 * second tokenizer, free to disagree with the one that chose the class. This
 * runs {@link lex} — the tokenizer — and applies the same assignment-prefix
 * skip `classifySegment` applies, and stops there: it classifies nothing and
 * decides nothing.
 *
 * `null` when the tokenizer refuses the string, which is the same input
 * `classifyCommand` answers `unparseable` for. Segments carrying no binary (a
 * bare assignment, a lone redirection) are omitted: they have no verb to show.
 */
/**
 * The paths each segment WRITES through a redirection, from the same parse
 * (APRV-445). `<` is a read and is left out, as are the discard devices.
 * `null` when the tokenizer refuses the string.
 */
export function commandSegmentWriteTargets(command: string): string[][] | null {
  const lexed = lex(command);
  if (!lexed.ok) return null;
  return lexed.segments.map((segment) =>
    segment.redirects
      .filter((redirect) => redirect.op !== "<")
      .map((redirect) => redirect.target.text)
      .filter((target) => !isDiscardTarget(target)),
  );
}

/**
 * How many words open the segment that bash takes as assignments, judged on
 * each word as written ({@link LexWord.assignment}, APRV-523). The word after
 * them is the program bash runs: a word whose name is quoted or escaped is
 * that program, not an assignment, so the shapes below name it as the binary.
 * On a line the classifier answers the count equals its own cursor's, because
 * {@link classifySegment} refuses any segment where the two differ.
 */
function bashAssignmentCount(words: readonly LexWord[]): number {
  let cursor = 0;
  while (cursor < words.length && (words[cursor] as LexWord).assignment) cursor += 1;
  return cursor;
}

/**
 * Every segment of `command` with its binary (or `null`), its arguments and the
 * paths it writes through a redirection, from ONE lex of the whole command
 * (APRV-445 recheck). Lexing a segment's text on its own fails for a heredoc,
 * whose body lives outside the segment's text; this keeps the body attached.
 */
export interface CommandSegmentShape {
  text: string;
  bin: string | null;
  args: string[];
  /** What the shell may still do to each of `args` (APRV-511 fix round 3). */
  argFlags: ArgExpansion[];
  writes: string[];
  /** Paths read through `<` (APRV-445 recheck 3, SF3c). */
  reads: string[];
  /**
   * Could the shell make a write target, or a word after the binary, into
   * text this shape does not show (a `$`, a backtick, or a `$(…)` whose text
   * the lexer set aside)? Read by the push-repository pass (APRV-518).
   */
  expands: { writes: boolean; args: boolean };
  /** Is this segment's stdin the previous segment's output? (APRV-522.) */
  stdinFed: boolean;
  /**
   * The inner text of every `$(…)` this segment expands: in its words, its
   * redirection targets and an unquoted heredoc's body (APRV-522), so the
   * hook's disk pass judges the reads a substitution makes.
   */
  substitutions: string[];
  /**
   * The `NAME=value` words before the binary (APRV-522 fix round 1, M-B): a
   * prefix such as `CDPATH=` or `HOME=` steers where a `cd` lands.
   */
  assignments: string[];
  /**
   * The script of a login-shell wrapper, exactly as {@link loginShellScript}
   * reads it for `classifyCommand` (APRV-522 fix round 1, M-A), or `null`.
   */
  script: string | null;
  /**
   * A known shell handed an inline-script flag in a shape
   * {@link loginShellScript} does not unwrap (APRV-522 fix round 1, M-A): what
   * its script reads cannot be judged, so the hook's disk pass fails closed.
   */
  opaqueShell: boolean;
}

export function commandSegmentShapes(command: string): CommandSegmentShape[] | null {
  const lexed = lex(command);
  if (!lexed.ok) return null;
  const expands = (word: LexWord): boolean => word.substitutions.length > 0 || /[$`]/u.test(word.text);
  return lexed.segments.map((segment) => {
    const words = segment.words.map((word) => word.text);
    const cursor = bashAssignmentCount(segment.words);
    const script = loginShellScript(segment);
    return {
      expands: {
        writes: segment.redirects.some((redirect) => redirect.op !== "<" && expands(redirect.target)),
        args: segment.words.slice(cursor + 1).some(expands),
      },
      text: segment.text,
      bin: words[cursor] ?? null,
      args: words.slice(cursor + 1),
      argFlags: segment.words.slice(cursor + 1).map((word) => ({ splits: word.splits, expands: word.expands })),
      writes: segment.redirects
        .filter((redirect) => redirect.op !== "<")
        .map((redirect) => redirect.target.text)
        .filter((target) => !isDiscardTarget(target)),
      reads: segment.redirects
        .filter((redirect) => redirect.op === "<")
        .map((redirect) => redirect.target.text),
      stdinFed: segment.stdinFed,
      substitutions: [
        ...segment.words.flatMap((word) => word.substitutions),
        ...segment.redirects.flatMap((redirect) => redirect.target.substitutions),
        ...segment.bodySubstitutions,
      ],
      assignments: words.slice(0, cursor),
      script,
      opaqueShell: script === null && inlineShellFlagged(words[cursor] ?? null, words.slice(cursor + 1)),
    };
  });
}

/**
 * Is this a known shell handed an inline-script flag anywhere in its argv?
 * (APRV-522 fix round 1, M-A.) Broader than {@link INLINE_SCRIPT_FLAG} on
 * purpose: any short bundle carrying `c` counts, wherever it sits.
 */
function inlineShellFlagged(bin: string | null, args: readonly string[]): boolean {
  if (bin === null) return false;
  const base = pathSegments(bin).slice(-1)[0] ?? bin;
  if (!UNWRAPPABLE_SHELLS.has(base)) return false;
  return args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg) || arg === "--command");
}

export function commandSegmentWords(command: string): CommandSegmentWords[] | null {
  const lexed = lex(command);
  if (!lexed.ok) return null;

  const out: CommandSegmentWords[] = [];
  for (const segment of lexed.segments) {
    const words = segment.words.map((word) => word.text);
    const cursor = bashAssignmentCount(segment.words);
    const bin = words[cursor];
    if (bin === undefined) continue;
    out.push({ text: segment.text, bin, args: words.slice(cursor + 1) });
  }
  return out;
}
