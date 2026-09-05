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
 */

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
}

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
 * Files whose edit is `policy.core` wherever they sit: the policy itself,
 * under either spelling.
 */
const CORE_FILENAMES: readonly string[] = ["APPROVAL.md", "APPROVALS.md"];

/**
 * Files whose edit is `policy.edit` wherever they sit: the agent instructions
 * that carry the policy's authority in prose, and the release configuration.
 */
const PROTECTED_FILENAMES: readonly string[] = ["CLAUDE.md", "AGENTS.md", ".npmrc"];

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
}

/**
 * Read one `policy.protected_paths` entry, or `null` when it names nothing.
 *
 * The schema already rejects globs, absolute paths and `..` segments; this
 * repeats the structural half of that check so a caller that skipped
 * validation gets an entry that matches nothing rather than an entry that
 * matches surprisingly. Pure, like everything else here: no resolution against
 * a checkout, no disk.
 */
function parseProtectedEntry(entry: string): ProtectedEntry | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;
  const directory = /[/\\]$/u.test(trimmed);
  const segments = pathSegments(trimmed);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  return { segments, directory };
}

/** Does `segments` match one parsed entry? */
function matchesEntry(segments: readonly string[], entry: ProtectedEntry): boolean {
  const want = entry.segments;
  if (want.length > segments.length) return false;
  if (entry.directory) {
    // A directory prefix matches wherever its segments appear as a contiguous
    // run, exactly as the built-in `.approval/` and `.github/workflows/` do.
    for (let start = 0; start + want.length <= segments.length; start += 1) {
      if (want.every((segment, offset) => segment === segments[start + offset])) return true;
    }
    return false;
  }
  // An exact path matches when the candidate ENDS with it: `docs/x.md` matches
  // `/repo/docs/x.md` and `./docs/x.md`, and a bare filename (a one-segment
  // entry) matches that filename in any directory, which is how the built-in
  // filenames have always behaved.
  const offset = segments.length - want.length;
  return want.every((segment, index) => segment === segments[offset + index]);
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
 * path it adds lands on `policy.edit` — the reviewable class — because a
 * policy widening its own surface is naming prose and configuration, not
 * minting authority over the gate's organs. Still pure: the caller loads the
 * policy, this function only matches segments.
 */
export function protectedPathClass(
  candidate: string,
  extra: readonly string[] = [],
): ProtectedPathClass | null {
  if (candidate.length === 0) return null;
  const segments = pathSegments(candidate);

  // 1. The log directory, before anything else that would call it a policy file.
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === ".approval" && segments[index + 1] === "log") return "log.mutate";
  }

  // 2. The gate's own organs.
  const last = segments[segments.length - 1];
  if (last !== undefined && CORE_FILENAMES.includes(last)) return "policy.core";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // The rest of the approval home: payload store, vault, keys, environment
    // map, queue. The bare `.approval` directory itself lands here too.
    if (segment === ".approval") return "policy.core";
    // The harness's own settings, which is where a hook is installed or removed.
    if (segment === ".claude") {
      const next = segments[index + 1];
      if (next !== undefined && next.startsWith("settings")) return "policy.core";
    }
    // Cursor's equivalent surface: the hook install file, hook scripts, and
    // custom-agent prompts. An agent that could write those could write itself
    // out of the gate (APRV-133), which is the `policy.core` property and not
    // the prose one.
    if (segment === ".cursor") {
      const next = segments[index + 1];
      if (next === "hooks.json" || next === "hooks" || next === "agents") return "policy.core";
    }
  }

  // 3. The prose and configuration about the gate.
  if (last !== undefined && PROTECTED_FILENAMES.includes(last)) return "policy.edit";
  for (let index = 0; index < segments.length; index += 1) {
    // CI configuration.
    if (segments[index] === ".github" && segments[index + 1] === "workflows") return "policy.edit";
  }

  for (const raw of extra) {
    const entry = parseProtectedEntry(raw);
    if (entry !== null && matchesEntry(segments, entry)) return "policy.edit";
  }
  return null;
}

/**
 * Does this path name something only a human may write?
 *
 * The boolean face of {@link protectedPathClass}, kept because two callers
 * (`core/wysiwys.ts`'s protected-path view and the hook's file-tool gate) ask
 * whether a path is protected at all before they ask which surface it is.
 */
export function isProtectedPath(candidate: string, extra: readonly string[] = []): boolean {
  return protectedPathClass(candidate, extra) !== null;
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
 */
function isCredentialPath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  const segments = pathSegments(candidate);
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== ".approval") continue;
    const next = segments[index + 1];
    if (next === undefined) return false;
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
 */
const CREDENTIAL_WRITE_BINS: readonly string[] = [
  "rm",
  "mv",
  "tee",
  "truncate",
  "chmod",
  "chown",
  "ln",
  "touch",
  "mkdir",
  "rmdir",
  "git",
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
function credentialTouch(
  basename: string,
  args: readonly string[],
  positionals: readonly string[],
): CredentialOutcome | null {
  const inPlaceSed =
    basename === "sed" &&
    (hasFlag(args, ["--in-place"]) ||
      args.some((arg) => arg.startsWith("-i") && !arg.startsWith("--")));
  const writesOnly = CREDENTIAL_WRITE_BINS.includes(basename) || inPlaceSed;
  if (!writesOnly) {
    const named = positionals.find((arg) => isCredentialPath(arg));
    if (named !== undefined) {
      return { class: CREDENTIAL_CLASS, rule: "credential-path", path: named };
    }
  }

  for (const word of args) {
    if (secretEnvReference(word) !== null) {
      return { class: CREDENTIAL_CLASS, rule: "credential-env" };
    }
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
  /** Set when the segment contains a construct whose effect cannot be read. */
  opaque: string | null;
}

type LexResult =
  | { ok: true; segments: LexSegment[] }
  | { ok: false; detail: string };

const OPERATOR_CHARS = new Set(["&", "|", ";", "(", ")", "<", ">", "\n"]);

/** A pending `<<TERMINATOR` whose body is skipped at the next newline. */
interface PendingHeredoc {
  terminator: string;
  stripTabs: boolean;
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
 */
function lex(command: string): LexResult {
  const segments: LexSegment[] = [];
  let words: LexWord[] = [];
  let redirects: LexRedirect[] = [];
  let opaque: string | null = null;
  let segmentStart = 0;
  let index = 0;
  const pending: PendingHeredoc[] = [];

  const flush = (end: number): void => {
    if (words.length > 0 || redirects.length > 0 || opaque !== null) {
      segments.push({
        text: command.slice(segmentStart, end).trim(),
        words,
        redirects,
        opaque,
      });
    }
    words = [];
    redirects = [];
    opaque = null;
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
    const substitutions: string[] = [];
    const start = index;

    for (; index < command.length; index += 1) {
      const ch = command[index] as string;

      if (ch === " " || ch === "\t") break;
      if (OPERATOR_CHARS.has(ch)) break;

      if (ch === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
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
        index = scan.end;
        continue;
      }

      text += ch;
    }

    // Nothing consumed means the caller was at a delimiter: no word here. A
    // word that consumed characters and produced no text is still a word (`''`,
    // or a backtick substitution that only set the opaque flag).
    if (index === start) return null;
    return { text, quoted, substitutions };
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
      // consumed here and never classified. A body is data, not commands.
      while (pending.length > 0) {
        const heredoc = pending.shift() as PendingHeredoc;
        const consumed = skipHeredocBody(command, index, heredoc);
        if (consumed === null) {
          return { ok: false, detail: `heredoc <<${heredoc.terminator} is never terminated` };
        }
        index = consumed;
      }
      flush(boundary);
      segmentStart = index;
      continue;
    }

    // Redirections, including the fd-prefixed and dup forms.
    const redirect = /^(\d*)(>>|>&|>\||>|<<-|<<|<&|<)/u.exec(command.slice(index));
    if (redirect !== null) {
      const op = redirect[2] as string;
      index += (redirect[0] as string).length;
      if (op === "<<" || op === "<<-") {
        while (command[index] === " " || command[index] === "\t") index += 1;
        const terminator = readWord();
        if (terminator === null) {
          return { ok: false, detail: "heredoc has no terminator word" };
        }
        pending.push({ terminator: terminator.text, stripTabs: op === "<<-" });
        continue;
      }
      if (op === ">&" || op === "<&") {
        // `2>&1` and friends: a file descriptor dup, no path involved.
        while (index < command.length && /[\d-]/u.test(command[index] as string)) index += 1;
        continue;
      }
      while (command[index] === " " || command[index] === "\t") index += 1;
      const target = readWord();
      if (target === null) {
        return { ok: false, detail: `redirection ${op} has no target` };
      }
      redirects.push({ op: op === ">>" ? ">>" : op === "<" ? "<" : ">", target });
      continue;
    }

    if (ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      const boundary = index;
      index += ch === "&" && command[index + 1] === "&" ? 2 : ch === "|" && command[index + 1] === "|" ? 2 : 1;
      flush(boundary);
      segmentStart = index;
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

/** Scan a double-quoted string starting at the opening quote. */
function readDoubleQuoted(
  command: string,
  start: number,
): { text: string; end: number; substitutions: string[]; opaque: string | null } | null {
  let text = "";
  const substitutions: string[] = [];
  let opaque: string | null = null;
  let index = start + 1;

  for (; index < command.length; index += 1) {
    const ch = command[index] as string;
    if (ch === '"') return { text, end: index, substitutions, opaque };
    if (ch === "\\") {
      const next = command[index + 1];
      if (next === undefined) break;
      if (next !== "\n") text += next;
      index += 1;
      continue;
    }
    if (ch === "`") {
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
      index = scan.end;
      continue;
    }
    text += ch;
  }
  return null;
}

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
  /** What the caller knows about the machine (APRV-267). Never read from here. */
  context: ClassifierContext;
}

/** A refinement's answer: a class and the rule id that chose it. */
interface Refinement {
  class: string;
  rule: string;
}

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

/** `git push` — the three push classes turn on flags and refspecs. */
function refineGitPush(ctx: RuleContext): Refinement {
  const args = ctx.args.slice(1);
  if (hasFlag(args, ["--force", "-f", "--force-with-lease", "--force-if-includes"])) {
    return { class: "vcs.history.rewrite", rule: "git-push-force" };
  }
  const positionals = args.filter((arg) => !isFlag(arg));
  // A deletion, or a push with no refspec at all: the destination is either the
  // trunk or unknown, and unknown resolves to the stricter class.
  if (hasFlag(args, ["--delete", "-d"])) {
    return { class: "vcs.push.main", rule: "git-push-delete" };
  }
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    return { class: "vcs.push.main", rule: "git-push-implicit" };
  }
  let sawMain = false;
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) {
      return { class: "vcs.history.rewrite", rule: "git-push-force" };
    }
    const colon = refspec.indexOf(":");
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
    // `:branch` (empty source) and `src:` (empty destination) both delete a
    // remote ref. A deletion is destructive whatever it names, so it takes the
    // stricter class rather than the branch one.
    if (destination.length === 0 || (colon !== -1 && refspec.slice(0, colon).length === 0)) {
      return { class: "vcs.push.main", rule: "git-push-delete" };
    }
    if (isUnknownValue(destination)) {
      sawMain = true;
      continue;
    }
    const branch = destination.replace(/^refs\/heads\//u, "");
    if (branch === "main" || branch === "master") sawMain = true;
  }
  return sawMain
    ? { class: "vcs.push.main", rule: "git-push-main" }
    : { class: "vcs.push.branch", rule: "git-push-branch" };
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

/** `sed -i` edits in place; every other `sed` reads. */
function refineSed(ctx: RuleContext): Refinement {
  const inPlace =
    hasFlag(ctx.args, ["--in-place"]) ||
    ctx.args.some((arg) => arg.startsWith("-i") && !arg.startsWith("--"));
  return inPlace
    ? { class: "files.write.workspace", rule: "sed-in-place" }
    : { class: "read.shell", rule: "sed-read" };
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
 * `positionals` is read rather than `args`, so a flag between the words cannot
 * hide the verb: `approval --json log sync` is the same invocation.
 */
function refineApprovalVerb(positionals: readonly string[]): Refinement | null {
  const verb = positionals[0];
  const sub = positionals[1];
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
    return null;
  }
  if (verb === "gate") {
    if (sub === "open") return { class: "policy.core", rule: "approval-gate-open" };
    if (sub === "close") return { class: "policy.core", rule: "approval-gate-close" };
    return null;
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
  return refineApprovalVerb(ctx.positionals) ?? { class: GATE_SELF_CLASS, rule: "approval" };
}

/**
 * `node` — an inline script is opaque, the gate's own entry point is
 * pass-through, and anything else is a workspace script.
 */
function refineNode(ctx: RuleContext): Refinement | null {
  if (hasFlag(ctx.args, ["-e", "--eval", "-p", "--print"])) return null;
  const script = ctx.positionals[0];
  if (script !== undefined && isGateEntrypoint(script)) {
    // `node cli.js log sync` is `approval log sync` spelled the long way, and
    // it must classify identically or the classification is a spelling test.
    return (
      refineApprovalVerb(ctx.positionals.slice(1)) ?? {
        class: GATE_SELF_CLASS,
        rule: "node-approval-cli",
      }
    );
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
    emits: ["vcs.push.branch", "vcs.push.main", "vcs.history.rewrite"],
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
  { id: "git-tag", bins: ["git"], subs: ["tag"], class: "release.publish" },
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
  { id: "npm-publish", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["publish", "version", "deprecate", "dist-tag", "unpublish"], class: "release.publish" },
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
  { id: "harness-update", bins: ["claude", "codex", "gemini"], subs: ["update"], class: "deps.upgrade" },
  { id: "harness-updater", bins: ["uca"], class: "deps.upgrade" },

  // -- workspace tools -----------------------------------------------------
  {
    id: "node",
    bins: ["node"],
    class: "files.write.workspace",
    emits: [GATE_SELF_CLASS, "log.sync", "log.advance", "policy.core"],
    refine: refineNode,
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
  {
    id: "read-shell",
    bins: [
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
      "find",
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
 * the shell's, so these refuse instead. `bash -c "…"`, `eval`, `xargs` and the
 * `-e` interpreters can express anything at all; `sudo` and `env` re-launch
 * something else with different authority.
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

/** `VAR=value` prefixes, which are not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

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
 * The strictest protected surface named by these words, with the word itself.
 *
 * `null` when none of them is protected. The word is returned verbatim, which
 * is what {@link ClassifiedSegment.path} carries to the approver.
 */
function strictestProtected(
  words: readonly string[],
  protectedPaths: readonly string[],
): { surface: ProtectedPathClass; path: string } | null {
  let best: { surface: ProtectedPathClass; path: string } | null = null;
  for (const word of words) {
    const surface = protectedPathClass(word, protectedPaths);
    if (surface === null) continue;
    if (
      best === null ||
      PROTECTED_PRECEDENCE.indexOf(surface) < PROTECTED_PRECEDENCE.indexOf(best.surface)
    ) {
      best = { surface, path: word };
    }
  }
  return best;
}

/** Every class the table can emit, for docs and for the dogfood test. */
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
  return [...seen].sort();
})();

/** Find the first table row matching this binary and subcommand. */
function matchRule(bin: string, sub: string | null): CommandRule | null {
  for (const rule of COMMAND_RULES) {
    if (!rule.bins.includes(bin)) continue;
    if (rule.subs !== undefined) {
      if (sub === null || !rule.subs.includes(sub)) continue;
    }
    return rule;
  }
  return null;
}

type SegmentOutcome =
  | { ok: true; class: string; rule: string; path?: string }
  | { ok: false; code: ClassifierFailureCode; detail: string };

function classifySegment(
  segment: LexSegment,
  protectedPaths: readonly string[],
  context: ClassifierContext,
): SegmentOutcome {
  if (segment.opaque !== null) {
    return { ok: false, code: "opaque", detail: segment.opaque };
  }

  // `$(…)` is classified recursively. A substitution that only reads is inert;
  // anything else taints the segment, because its effect happens before the
  // outer command even starts and the outer class would not describe it.
  for (const word of segment.words) {
    for (const inner of word.substitutions) {
      const nested = classifyCommand(inner, protectedPaths, context);
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
    }
  }

  const words = segment.words.map((word) => word.text);
  let cursor = 0;
  while (cursor < words.length && ASSIGNMENT.test(words[cursor] as string)) cursor += 1;

  const writeTargets = segment.redirects
    .filter((redirect) => redirect.op !== "<")
    .map((redirect) => redirect.target.text);
  // A redirection onto a protected path is a write to that path, whatever the
  // command in front of it was going to do. The CLASS says which surface was
  // aimed at (APRV-198); the RULE stays `redirect-protected`, because the
  // mechanism is unchanged and the hook's tiers and the channel's protected-path
  // view are keyed on the rule.
  const redirected = strictestProtected(writeTargets, protectedPaths);
  if (redirected !== null) {
    return {
      ok: true,
      class: redirected.surface,
      rule: "redirect-protected",
      path: redirected.path,
    };
  }

  const bin = words[cursor];
  if (bin === undefined) {
    // `VAR=value` alone, or a bare redirection. `> file` truncates, so it is a
    // write; an assignment on its own touches nothing.
    return writeTargets.length > 0
      ? { ok: true, class: "files.write.workspace", rule: "redirect-write" }
      : { ok: true, class: "read.shell", rule: "assignment" };
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

  const inlineFlags = INLINE_SOURCE_BINS[basename];
  if (inlineFlags !== undefined && hasFlag(args, inlineFlags)) {
    return { ok: false, code: "opaque", detail: `${basename} runs inline source` };
  }

  const positionals = args.filter((arg) => !isFlag(arg));

  // Credential material, below the opaque checks so `sudo cat .approval/env`
  // stays opaque (a refusal) rather than being softened into a request, and
  // above the binary table so a reader the table does not know (`base64`,
  // `xxd`, `less`) is named rather than answered `unclassified` (APRV-194).
  const credential = credentialTouch(basename, args, positionals);
  if (credential !== null) return { ok: true, ...credential };
  const sub = positionals[0] ?? null;
  const rule = matchRule(basename, sub);
  if (rule === null) {
    return {
      ok: false,
      code: "unclassified",
      detail:
        sub === null
          ? `no rule for ${basename}`
          : `no rule for ${basename} ${sub}`,
    };
  }

  const substituted = segment.words
    .slice(cursor + 1)
    .some((word) => word.substitutions.length > 0);
  const ctx: RuleContext = { bin: basename, args, positionals, sub, substituted, context };
  const refined = rule.refine === undefined ? null : rule.refine(ctx);
  if (rule.refine !== undefined && refined === null) {
    return { ok: false, code: "opaque", detail: `${basename} runs inline source` };
  }
  let cls = refined === null ? rule.class : refined.class;
  let ruleId = refined === null ? rule.id : refined.rule;

  // A protected path anywhere in an effectful segment takes that path's class:
  // the command is editing the gate, whatever else it is doing. Every
  // positional is scanned, source and destination alike, so `cp` stays
  // direction-blind — a copy OUT of the policy directory is as gated as a copy
  // into it, because the classifier cannot tell which argument the binary will
  // treat as the destination and guessing would be the ungated direction.
  if (!cls.startsWith("read.") && cls !== GATE_SELF_CLASS) {
    const named = strictestProtected(positionals, protectedPaths);
    if (named !== null) {
      return { ok: true, class: named.surface, rule: "protected-path", path: named.path };
    }
  }

  // A read command with a write redirection writes. `ls > out.txt` creates a
  // file, and the class has to say so.
  if (cls.startsWith("read.") && writeTargets.length > 0) {
    cls = "files.write.workspace";
    ruleId = "redirect-write";
  }

  return { ok: true, class: cls, rule: ruleId };
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
 * `context` (APRV-267) carries the machine facts a caller has resolved: today
 * only `scratchRoots`. It behaves exactly as `protectedPaths` does — omitting
 * it yields the strictly narrower answer, because every rule that reads it can
 * only ever LOOSEN a class, and no rule reads it to loosen a protected or
 * credential one.
 */
export function classifyCommand(
  command: string,
  protectedPaths: readonly string[] = [],
  context: ClassifierContext = {},
): CommandClassification {
  const lexed = lex(command);
  if (!lexed.ok) {
    return { ok: false, code: "unparseable", segment: command.trim(), detail: lexed.detail };
  }
  if (lexed.segments.length === 0) {
    return { ok: false, code: "unclassified", segment: command.trim(), detail: "empty command" };
  }

  const segments: ClassifiedSegment[] = [];
  const classes: string[] = [];
  for (const segment of lexed.segments) {
    const outcome = classifySegment(segment, protectedPaths, context);
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, segment: segment.text, detail: outcome.detail };
    }
    segments.push({
      text: segment.text,
      class: outcome.class,
      rule: outcome.rule,
      ...(outcome.path === undefined ? {} : { path: outcome.path }),
    });
    if (!classes.includes(outcome.class)) classes.push(outcome.class);
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
export function commandSegmentWords(command: string): CommandSegmentWords[] | null {
  const lexed = lex(command);
  if (!lexed.ok) return null;

  const out: CommandSegmentWords[] = [];
  for (const segment of lexed.segments) {
    const words = segment.words.map((word) => word.text);
    let cursor = 0;
    while (cursor < words.length && ASSIGNMENT.test(words[cursor] as string)) cursor += 1;
    const bin = words[cursor];
    if (bin === undefined) continue;
    out.push({ text: segment.text, bin, args: words.slice(cursor + 1) });
  }
  return out;
}
