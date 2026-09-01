/**
 * `.approval/env` — the environment SOURCE MAP (SPEC.md §5.2, §11; APRV-73).
 *
 * Every secret this runtime touches is named by the policy and held in an
 * environment variable: `channels.telegram.token_env` (§5.1), the chat id
 * beside it, `audit.sampling_secret_env` (§5.2), `vault.passphrase_env` (§5.2),
 * and `APPROVAL_HUMAN`, which is human identity itself (§11). The policy carries
 * NAMES and never values, which is the right boundary and leaves an operator
 * with five variables to get into a shell before any gate operation works, and
 * no written-down place to say where they come from.
 *
 * This module is that written-down place. `.approval/env` is a source map, not
 * a secret store: `KEY=VALUE` lines whose VALUE says WHERE the value lives.
 *
 * ```
 * # one line per variable; # comments and blank lines are ignored
 * APPROVAL_HUMAN=human:alice
 * APPROVAL_TG_TOKEN=keychain:approval-telegram-token
 * APPROVAL_VAULT_PASSPHRASE=secret-service:vault-passphrase
 * APPROVAL_AUDIT_SECRET=env:
 * ```
 *
 * Four value forms, and one of them is deliberately unpleasant:
 *
 * - `keychain:<service>` — macOS, `security find-generic-password -a "$USER"
 *   -s <service> -w`. The value comes back on stdout and is never in an argv.
 * - `secret-service:<label>` — Linux desktop, `secret-tool lookup approval
 *   <label>`. Same property.
 * - `env:` — inherited from the ambient environment. A documentation form: it
 *   asserts "this one comes from the shell that launched you", and resolves to
 *   nothing on its own.
 * - a bare literal — permitted, and ALWAYS reported as plaintext. A rule people
 *   route around is not a control: an operator who is told plainly that their
 *   token is sitting in a file in the working tree can decide to accept that,
 *   and an operator who is forbidden from writing it there writes it into their
 *   shell profile instead, where nothing in this runtime can see it to say so.
 *
 * A value carrying some OTHER `word:` prefix is a literal, not an error, because
 * `APPROVAL_HUMAN=human:alice` is the commonest line this file will ever hold.
 * Near misses of the real schemes are reserved by name and refused rather than
 * silently exported as text; see {@link RESERVED_SCHEMES}.
 *
 * ## THE LOAD-BEARING RULE: nothing loads this file implicitly
 *
 * No verb in this runtime reads `.approval/env` into its own environment. One
 * verb, `approval env`, resolves it and prints an export block for a shell to
 * evaluate; every other command sees only the environment the human who
 * launched it had already established.
 *
 * The reason is `APPROVAL_HUMAN`. SPEC.md §11 states that human identity in v0.1
 * is config-declared and that "the trust boundary is the local machine, and
 * anyone who can set that configuration and write to the log is inside it". A
 * working-tree file that could set `APPROVAL_HUMAN` would move that boundary to
 * "anyone who can write a file in the repository": an agent that can edit source
 * — which every agent working in a repository can — would thereby be able to
 * attest a policy, grant its own request, and set a vault credential, on every
 * invocation, as the human. The whole human-only gate would be one `echo >>`
 * away from being nobody's gate.
 *
 * So the file is inert. A human evaluates `approval env` in their own shell,
 * sees the export block that is about to run (or checks it value-free first with
 * `--check`), and the process that performs a gate operation inherits an
 * environment a human established. This is SPEC.md §11.1 invariant 7, and
 * `tests/cli-env.test.ts` pins it by spawning `doctor`, `policy attest` and
 * `channel telegram health` in a directory holding a complete `.approval/env`
 * and asserting that none of them saw a byte of it.
 *
 * ## Mode 0600
 *
 * A file that may hold a literal secret is refused unless its mode is exactly
 * `0600`, and the refusal prints the `chmod`. This is a lock on a door whose
 * wall is missing (the same session can chmod it back), and it is worth having
 * for the reason `umask` is worth having: the common failure is a
 * world-readable file nobody looked at, not an adversary in the room.
 *
 * ## Determinism, and the one place it stops
 *
 * Parsing is a pure function of the bytes. Resolution is not: it shells out to
 * helper binaries, which is why {@link SourceRunner} exists as an injectable
 * seam and why the tests drive stub `security` / `secret-tool` scripts through
 * PATH rather than touching a real Keychain.
 *
 * Nothing here throws. Every failure is a `{ ok: false, code, message }` from
 * the frozen union {@link ENV_FILE_REFUSAL_CODES}. No credential VALUE appears
 * in a refusal, a message, or a `source` label on any path.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

import { HUMAN_ACTOR_ENV } from "./attest.js";
import { telegramChatEnvFor, telegramTokenEnvFor } from "./telegram-config.js";
import type { PolicyLoadResult } from "./policy-load.js";
import { passphraseEnvFor } from "./vault.js";

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** The source map's filename, beside the log's home: `.approval/env`. */
export const ENV_FILENAME = "env";

/**
 * The env file for a given log path — derived exactly as `vaultPathFor` derives
 * the vault, so the log, the payload store, the vault and this file stay under
 * one home: SPEC.md §9 fixes the log at `<home>/log/events.jsonl`, so the source
 * map is `<home>/env`, a sibling of the log DIRECTORY and never inside it.
 */
export function envFilePathFor(logPath: string): string {
  const logDir = dirname(logPath);
  const home = basename(logDir) === "log" ? dirname(logDir) : logDir;
  return join(home, ENV_FILENAME);
}

/** The mode the file must have. Anything else is refused. */
export const ENV_FILE_REQUIRED_MODE = 0o600;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Everything this module can refuse. Frozen public API, per SPEC.md §11.1(6).
 *
 * Each code names a different repair, which is the test of whether a code earns
 * its place. The three helper codes are separate for exactly that reason: "you
 * are on a machine without `secret-tool`", "the item is not in your keychain",
 * and "the helper ran and failed" are three different mornings.
 */
export const ENV_FILE_REFUSAL_CODES = [
  /** The file's mode is not 0600. The refusal carries the `chmod` to run. */
  "env-file-mode",
  /**
   * The file exists and could not be read, stat'd, or (APRV-74) written. A
   * filesystem fact in every case, with a filesystem repair, which is why the
   * write path reuses this code rather than adding a fourth I/O name to a
   * frozen union: "the directory is read-only" and "the file is unreadable"
   * are the same morning and the same exit code.
   */
  "env-file-io",
  /** A line is neither blank, nor a comment, nor `KEY=VALUE`. */
  "env-file-syntax",
  /** A KEY does not match `[A-Z_][A-Z0-9_]*`. No `export ` prefix is accepted. */
  "env-file-key-invalid",
  /** The same KEY appears twice. Which one wins is not a thing to guess at. */
  "env-file-duplicate-key",
  /** A VALUE carries a `scheme:` prefix this build does not implement. */
  "env-file-unknown-scheme",
  /** A KEY with an empty VALUE. An empty secret is a configuration error. */
  "env-file-empty-value",
  /** The helper binary for a scheme is not on PATH. Not the operator's fault. */
  "helper-binary-missing",
  /** The helper ran and the named item is not there. Store it, or fix the name. */
  "helper-item-missing",
  /** The helper ran and failed for some other reason (locked keyring, …). */
  "helper-failed",
  /**
   * A policy declared an `_env` NAME that is not a usable shell variable name.
   * Never emitted as an `export` line: the export block is evaluated by a shell,
   * and a name carrying a space or a `;` would be a policy file executing code.
   */
  "invalid-variable-name",
] as const;

export type EnvFileRefusalCode = (typeof ENV_FILE_REFUSAL_CODES)[number];

/** A whole-file failure. Nothing here throws. */
export interface EnvFileRefusal {
  ok: false;
  code: EnvFileRefusalCode;
  message: string;
  /** The file the refusal is about. */
  path: string;
  /** 1-based line number, for the parse refusals that have one. */
  line?: number;
}

function refuse(
  code: EnvFileRefusalCode,
  path: string,
  message: string,
  line?: number,
): EnvFileRefusal {
  return line === undefined
    ? { ok: false, code, message, path }
    : { ok: false, code, message, path, line };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The four value forms. `literal` is the fallback and the explicit escape. */
export type EnvSourceKind = "keychain" | "secret-service" | "env" | "literal";

/** One `KEY=VALUE` line, parsed. */
export interface EnvFileEntry {
  key: string;
  kind: EnvSourceKind;
  /**
   * The service name, the label, or the literal value. Empty for `env:`.
   *
   * For `literal` this IS the secret, so it is never put in a message, a
   * `source` label, or a refusal by anything in this module.
   */
  argument: string;
  /** 1-based line number, so a diagnostic can point at the line. */
  line: number;
}

/** `[A-Z_][A-Z0-9_]*` — the shape of an environment variable name. */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * A shell-safe variable name. Deliberately laxer than {@link KEY_PATTERN}
 * (lower case is legal in a shell) and still a closed character set, because
 * these names arrive from a policy file and are emitted into an `export` line.
 */
const SHELL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * A `scheme:` prefix. Lower-case letters only, so a bare literal that happens to
 * contain a colon (`7654321:AA…`, a Telegram token, is the case that matters) is
 * a literal and not a mystery scheme.
 */
const SCHEME_PATTERN = /^([a-z][a-z0-9-]*):(.*)$/su;

/** The schemes this build implements. */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  "keychain",
  "secret-service",
  "env",
  "literal",
]);

/**
 * The scheme namespace is a CLOSED, RESERVED LIST, and a `word:` prefix outside
 * it is a literal rather than an error.
 *
 * The rule earns its complexity from one line, which is the commonest line this
 * file will ever hold:
 *
 * ```
 * APPROVAL_HUMAN=human:alice
 * ```
 *
 * `human:<id>` is the actor syntax of SPEC.md §8. A parser that treated every
 * `word:` prefix as a scheme would refuse the identity line every operator
 * writes first and send them to `literal:human:alice`, which nobody would ever
 * guess and nobody should have to.
 *
 * A silent literal reading is still wrong for a MISTYPED source, though:
 * `keyring:approval-token` would export the eleven characters "keyring:app…" as
 * a bot token, and the failure would surface as a 401 from Telegram hours later.
 * So the near misses and the plausible future schemes are reserved by name and
 * refused, and everything else is a literal. Adding a scheme later means moving
 * a string from this set to {@link KNOWN_SCHEMES}, which is a reviewable diff
 * and never a change in meaning for an existing file: a reserved prefix has
 * never been readable as a literal.
 */
const RESERVED_SCHEMES: ReadonlySet<string> = new Set([
  // Misspellings and near neighbours of the two implemented helpers.
  "keyring",
  "keychains",
  "keychain-service",
  "secret_service",
  "secretservice",
  "secret-tool",
  "secrettool",
  "secrets",
  // Words that could only be meant as a source.
  "environment",
  "plaintext",
  "plain",
  "file",
  "exec",
  "command",
  "shell",
  // Credential managers a future scheme would plausibly be named after.
  "pass",
  "gopass",
  "op",
  "onepassword",
  "bitwarden",
  "lastpass",
  "vault",
  "wincred",
]);

/**
 * Parse the file's text. No interpolation, no quote stripping, no `export `
 * prefix, no line continuations: this is a source map, not a shell script, and
 * every one of those features is a way for a file to mean something other than
 * what it looks like.
 *
 * Quotes are NOT stripped, which is worth saying out loud because `.env` files
 * elsewhere do strip them: here `A="b"` is the five-character literal `"b"`.
 */
export function parseEnvFile(
  text: string,
  path: string,
): { ok: true; entries: EnvFileEntry[] } | EnvFileRefusal {
  const entries: EnvFileEntry[] = [];
  const seen = new Map<string, number>();

  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("export ")) {
      return refuse(
        "env-file-syntax",
        path,
        `line ${String(line)} begins with \`export \`: this file is a source map read by \`approval env\`, not a shell script, and every line is \`KEY=VALUE\`. Drop the \`export \`.`,
        line,
      );
    }

    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      return refuse(
        "env-file-syntax",
        path,
        `line ${String(line)} is neither blank, a # comment, nor KEY=VALUE`,
        line,
      );
    }

    const key = trimmed.slice(0, equals);
    const value = trimmed.slice(equals + 1);

    if (!KEY_PATTERN.test(key)) {
      return refuse(
        "env-file-key-invalid",
        path,
        `line ${String(line)}: ${JSON.stringify(key)} is not an environment variable name (it must match [A-Z_][A-Z0-9_]*)`,
        line,
      );
    }
    const first = seen.get(key);
    if (first !== undefined) {
      return refuse(
        "env-file-duplicate-key",
        path,
        `${key} is set twice, on lines ${String(first)} and ${String(line)}; which one wins is not something a runtime should guess`,
        line,
      );
    }
    seen.set(key, line);

    if (value.length === 0) {
      return refuse(
        "env-file-empty-value",
        path,
        `line ${String(line)}: ${key} has an empty value. Use \`${key}=env:\` to say it is inherited from the shell, or delete the line.`,
        line,
      );
    }

    const scheme = SCHEME_PATTERN.exec(value);
    if (scheme === null) {
      entries.push({ key, kind: "literal", argument: value, line });
      continue;
    }
    const name = scheme[1] as string;
    const argument = scheme[2] as string;
    if (!KNOWN_SCHEMES.has(name)) {
      if (!RESERVED_SCHEMES.has(name)) {
        // Not a scheme at all: `human:alice` and every other value that merely
        // contains a colon. See RESERVED_SCHEMES for why this is the default.
        entries.push({ key, kind: "literal", argument: value, line });
        continue;
      }
      return refuse(
        "env-file-unknown-scheme",
        path,
        `line ${String(line)}: ${key} names the source scheme ${JSON.stringify(`${name}:`)}, which is reserved and which this build does not implement. Implemented: keychain:<service>, secret-service:<label>, env: (inherited), literal:<value>, or a bare value (a plaintext literal). If you really meant the literal text, write \`${key}=literal:${name}:…\` — a reserved prefix is never read as a literal by accident.`,
        line,
      );
    }
    if (name === "literal") {
      if (argument.length === 0) {
        return refuse(
          "env-file-empty-value",
          path,
          `line ${String(line)}: ${key} is \`literal:\` with nothing after it`,
          line,
        );
      }
      entries.push({ key, kind: "literal", argument, line });
      continue;
    }
    if (name === "env") {
      // `env:whatever` is not a rename facility; the ambient variable is the
      // one with this KEY, and anything after the colon would be a second,
      // silent naming convention.
      if (argument.length > 0) {
        return refuse(
          "env-file-syntax",
          path,
          `line ${String(line)}: \`env:\` takes nothing after the colon — it means "${key} is inherited from the shell that launched the process", and there is deliberately no way to inherit one variable under another's name`,
          line,
        );
      }
      entries.push({ key, kind: "env", argument: "", line });
      continue;
    }
    if (argument.length === 0) {
      return refuse(
        "env-file-syntax",
        path,
        `line ${String(line)}: \`${name}:\` needs ${name === "keychain" ? "a service name" : "a label"} after the colon`,
        line,
      );
    }
    entries.push({ key, kind: name as EnvSourceKind, argument, line });
  }

  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The file's contents, or the fact that there is no file. */
export type EnvFileRead =
  | { ok: true; present: false; path: string; entries: [] }
  | { ok: true; present: true; path: string; entries: EnvFileEntry[] }
  | EnvFileRefusal;

/**
 * Read and parse the source map.
 *
 * **An absent file is not an error.** Nobody has written one, which is the state
 * of every working directory that keeps its variables in a shell profile, and it
 * is the state `approval init` leaves behind. Every variable then falls to
 * "inherited from the environment" or "unset", which is exactly the world
 * before this file existed.
 */
export function readEnvFile(path: string): EnvFileRead {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, present: false, path, entries: [] };
    }
    return refuse("env-file-io", path, `${path} could not be stat'd: ${detail(cause)}`);
  }

  if (!stats.isFile()) {
    return refuse("env-file-io", path, `${path} is not a regular file`);
  }

  const mode = stats.mode & 0o777;
  if (mode !== ENV_FILE_REQUIRED_MODE) {
    return refuse(
      "env-file-mode",
      path,
      `${path} has mode ${mode.toString(8).padStart(4, "0")}, and this file may carry a plaintext secret, so it is read only at 0600. Run:\n  chmod 600 ${path}`,
    );
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    return refuse("env-file-io", path, `${path} could not be read: ${detail(cause)}`);
  }

  const parsed = parseEnvFile(text, path);
  if (!parsed.ok) return parsed;
  return { ok: true, present: true, path, entries: parsed.entries };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What one upserted KEY did to the file. */
export interface EnvFileChange {
  key: string;
  /** The line as it will now read: `KEY=VALUE`. Never a secret — see below. */
  value: string;
  /**
   * The VALUE that was on the line before, or `null` when the key was added.
   *
   * This CAN be a plaintext secret, if the operator had written one as a bare
   * literal, so it exists for a caller that needs to decide whether it is
   * REPLACING something, and no caller in this repository prints it. The
   * boolean below is what the CLI reports on.
   */
  previous: string | null;
  /** The value is unchanged: the line already said exactly this. */
  unchanged: boolean;
}

/** A successful write. */
export interface EnvFileWrite {
  ok: true;
  path: string;
  /** The file did not exist and was created at 0600. */
  created: boolean;
  changes: EnvFileChange[];
}

/**
 * Add or replace `KEY=VALUE` lines, preserving everything else in the file.
 *
 * **Line-oriented, not a rewrite.** The file is read as text, the line whose
 * KEY matches is replaced IN PLACE, and a key that is not present is appended
 * at the end. Comments, blank lines, ordering, and every entry this call was
 * not asked about survive byte for byte. A writer that reparsed and re-emitted
 * would be simpler and would quietly delete the operator's own comments the
 * first time `approval setup channel telegram` ran — this file is one a human edits by
 * hand, and round-trip fidelity for a hand-edited file is the same requirement
 * the Backlog.md task files carry.
 *
 * The file is validated before it is touched: {@link readEnvFile}'s mode check
 * and full parse both run, so `setup` never appends a line to a file it could
 * not have read, and never lands a valid line in a file whose earlier line is a
 * syntax error. A file that does not exist is created at 0600, along with its
 * directory.
 *
 * Callers pass values, and a value here is a SOURCE (`keychain:<service>`), a
 * chat id, or an identity — never a credential, except on the one path where an
 * operator explicitly chose a plaintext literal after being told what it means.
 * Nothing in this function prints anything.
 */
export function upsertEnvFileEntries(
  path: string,
  entries: ReadonlyArray<{ key: string; value: string }>,
): EnvFileWrite | EnvFileRefusal {
  const existing = readEnvFile(path);
  if (!existing.ok) return existing;

  for (const entry of entries) {
    if (!KEY_PATTERN.test(entry.key)) {
      return refuse(
        "env-file-key-invalid",
        path,
        `${JSON.stringify(entry.key)} is not an environment variable name (it must match [A-Z_][A-Z0-9_]*), so no line was written`,
      );
    }
    if (entry.value.length === 0) {
      return refuse(
        "env-file-empty-value",
        path,
        `${entry.key} would be written with an empty value, which is not a source; nothing was written`,
      );
    }
    if (entry.value.includes("\n")) {
      return refuse(
        "env-file-syntax",
        path,
        `the value for ${entry.key} contains a newline, and one line is one variable; nothing was written`,
      );
    }
  }

  let text = "";
  if (existing.present) {
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      return refuse("env-file-io", path, `${path} could not be re-read: ${detail(cause)}`);
    }
  }

  // Split into lines WITHOUT the trailing terminator, so an append lands on its
  // own line and the file ends with exactly one newline whichever state it was
  // in. An empty (or absent) file is zero lines, not one empty one.
  const lines =
    text.length === 0 ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

  const changes: EnvFileChange[] = [];
  for (const entry of entries) {
    const line = `${entry.key}=${entry.value}`;
    const index = lines.findIndex((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed.startsWith("#")) return false;
      const equals = trimmed.indexOf("=");
      return equals !== -1 && trimmed.slice(0, equals) === entry.key;
    });
    if (index === -1) {
      lines.push(line);
      changes.push({ key: entry.key, value: entry.value, previous: null, unchanged: false });
      continue;
    }
    const before = (lines[index] as string).trim();
    const previous = before.slice(before.indexOf("=") + 1);
    lines[index] = line;
    changes.push({
      key: entry.key,
      value: entry.value,
      previous,
      unchanged: previous === entry.value,
    });
  }

  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;

  try {
    mkdirSync(dirname(path), { recursive: true });
    // 0600 at creation, and re-asserted after: `writeFileSync`'s mode argument
    // is a request against the umask on creation and is ignored entirely for an
    // existing file, so the explicit chmod is what actually holds the guarantee
    // the reader depends on.
    writeFileSync(path, body, { encoding: "utf8", mode: ENV_FILE_REQUIRED_MODE });
    chmodSync(path, ENV_FILE_REQUIRED_MODE);
  } catch (cause) {
    return refuse("env-file-io", path, `${path} could not be written: ${detail(cause)}`);
  }

  return { ok: true, path, created: !existing.present, changes };
}

// ---------------------------------------------------------------------------
// The resolver seam
// ---------------------------------------------------------------------------

/** What a helper lookup produced. The value, or a distinct reason it did not. */
export type SourceOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      code: "helper-binary-missing" | "helper-item-missing" | "helper-failed";
      message: string;
    };

/**
 * The two helper lookups, injectable.
 *
 * A seam rather than a direct `spawnSync` because the alternative is a test
 * suite that reads the machine's real Keychain, and there is no version of that
 * which is acceptable: it would prompt, it would depend on the developer's own
 * secrets, and on the wrong day it would print one. Tests pass a fake here, and
 * the ONE test that exercises {@link defaultSourceRunner} does it by putting
 * stub `security` / `secret-tool` scripts on the child process's PATH — a real
 * PATH lookup of a real command name, with no test-only flag in the runtime.
 */
export interface SourceRunner {
  keychain(service: string): SourceOutcome;
  secretService(label: string): SourceOutcome;
}

/** One trailing newline, and nothing else, is removed. `security -w` adds one. */
function stripOneNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * `security find-generic-password -a "$USER" -s <service> -w` and
 * `secret-tool lookup approval <label>`.
 *
 * THE VALUE IS NEVER IN AN ARGV, in either direction: the argv carries a service
 * name or a label, and the secret comes back on stdout. An argv is world-readable
 * in `ps` for the length of the call, which is the whole reason `approval vault
 * set` has no `--value` flag either.
 *
 * The exit-status readings are documented heuristics, not contracts. `security`
 * exits 44 (`errSecItemNotFound`) for a missing item; `secret-tool` exits 0 with
 * empty output when the lookup matches nothing. Anything else is
 * {@link "helper-failed"}, which is the honest answer for a locked keyring or a
 * D-Bus that is not running: the repair is not "store the item".
 */
/**
 * The prefix a deferred lookup carries. See {@link NON_RESOLVING_RUNNER}.
 */
export const KEYSTORE_DEFERRED = "not resolved by doctor";

/**
 * A {@link SourceRunner} that looks nothing up (moved here by APRV-178).
 *
 * `security find-generic-password -w` can raise a keychain-unlock or ACL dialog
 * and `secret-tool lookup` can block on a keyring prompt. Either would hang a
 * command run over ssh or from CI, and a command that pops a keychain prompt
 * also TEACHES people to click through keychain prompts. So the diagnostics —
 * `approval doctor`, and `approval up`'s cross-instance report — resolve
 * keystore-backed variables not at all: they report the scheme and the service
 * name, which `.approval/env` already carries in the open, and leave the actual
 * lookup to `approval env --check`, which a human runs deliberately and watches.
 *
 * It lives beside {@link defaultSourceRunner} rather than in one of its callers
 * because two of them now need it and a second copy would be a second set of
 * words for the same refusal.
 */
export const NON_RESOLVING_RUNNER: SourceRunner = {
  keychain(service: string): SourceOutcome {
    return {
      ok: false,
      code: "helper-failed",
      message: `${KEYSTORE_DEFERRED}: keychain:${service} is declared here and looked up by \`approval env --check\`. \`security find-generic-password -w\` can block on a keychain-unlock or ACL prompt, and a diagnostic must never hang or ask a human for a password`,
    };
  },
  secretService(label: string): SourceOutcome {
    return {
      ok: false,
      code: "helper-failed",
      message: `${KEYSTORE_DEFERRED}: secret-service:${label} is declared here and looked up by \`approval env --check\`. \`secret-tool lookup\` can block on a keyring-unlock prompt, and a diagnostic must never hang or ask a human for a password`,
    };
  },
};

export const defaultSourceRunner: SourceRunner = {
  keychain(service: string): SourceOutcome {
    const account = process.env["USER"] ?? userInfo().username;
    const result = spawnSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { encoding: "utf8" },
    );
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          code: "helper-binary-missing",
          message:
            "`security` is not on PATH — keychain: sources are macOS-only; on Linux use secret-service:<label>",
        };
      }
      return { ok: false, code: "helper-failed", message: `security could not be run: ${detail(result.error)}` };
    }
    if (result.status === 0) {
      return { ok: true, value: stripOneNewline(result.stdout) };
    }
    if (result.status === 44) {
      return {
        ok: false,
        code: "helper-item-missing",
        message: `no generic password for service ${JSON.stringify(service)} and account ${JSON.stringify(account)} in the login keychain`,
      };
    }
    return {
      ok: false,
      code: "helper-failed",
      message: `security exited ${String(result.status)} looking up service ${JSON.stringify(service)}`,
    };
  },

  secretService(label: string): SourceOutcome {
    const result = spawnSync("secret-tool", ["lookup", "approval", label], { encoding: "utf8" });
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          code: "helper-binary-missing",
          message:
            "`secret-tool` is not on PATH — install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch); on macOS use keychain:<service>",
        };
      }
      return {
        ok: false,
        code: "helper-failed",
        message: `secret-tool could not be run: ${detail(result.error)}`,
      };
    }
    if (result.status === 0) {
      const value = stripOneNewline(result.stdout);
      if (value.length === 0) {
        return {
          ok: false,
          code: "helper-item-missing",
          message: `no secret-service item with attribute approval=${JSON.stringify(label)}`,
        };
      }
      return { ok: true, value };
    }
    if (result.status === 1) {
      return {
        ok: false,
        code: "helper-item-missing",
        message: `no secret-service item with attribute approval=${JSON.stringify(label)}`,
      };
    }
    return {
      ok: false,
      code: "helper-failed",
      message: `secret-tool exited ${String(result.status)} looking up ${JSON.stringify(label)}`,
    };
  },
};

// ---------------------------------------------------------------------------
// The variable set
// ---------------------------------------------------------------------------

/** Where a resolved value came from, as a closed set. */
export type EnvVariableStatus =
  | "set-in-environment"
  | "resolved-from-keychain"
  | "resolved-from-secret-service"
  | "resolved-literal"
  | "unset";

/** One variable, resolved. */
export interface ResolvedVariable {
  /** The variable's NAME, as the policy or the runtime default gave it. */
  name: string;
  status: EnvVariableStatus;
  /** The value, present only when the status is not `unset`. */
  value?: string;
  /**
   * Where it came from, in words, and NEVER a value: `the environment`,
   * `keychain:approval-tg-token`, `literal (plaintext in .approval/env)`,
   * `unset`.
   */
  source: string;
  /**
   * The value is sitting in plaintext in the working tree: a secret-bearing
   * variable resolved from a bare literal.
   *
   * `APPROVAL_HUMAN` and the Telegram chat id are literals in most real files
   * and are not secrets, so they are `false` — but note the `source` label says
   * "literal (plaintext in .approval/env)" for EVERY literal regardless, because
   * the reader deciding whether a file may be committed wants to see all of
   * them.
   */
  plaintext: boolean;
  /** What to do about an `unset`. Absent when there is nothing to do. */
  fix?: string;
  /** Why a resolution failed, when one did. Distinct and machine-readable. */
  refusal?: { code: EnvFileRefusalCode; message: string };
  /**
   * The policy NAMED this variable (rather than the runtime defaulting it).
   * `approval env --check` fails on an unresolved declared variable and not on
   * an unresolved defaulted one: a policy that asked for something is a promise;
   * a default the operator never mentioned is an offer.
   */
  declared: boolean;
  /** The value would be a secret if it had one: token, passphrase, sampling. */
  secretBearing: boolean;
  /**
   * What the INSTANCE's own `.approval/env` says about this variable, whether
   * or not that is where the value came from (APRV-178).
   *
   * The ambient environment wins over the file and the file is then not even
   * consulted, which is correct and is invariant 7 — but it is also how a
   * production bot token exported in a shell profile silently became a demo
   * instance's channel credential. Nothing could report that, because the
   * resolution discarded the file entry it had ignored. It is kept here so
   * `approval env --check`, `approval doctor` and `approval up` can say "this
   * value is not the one your instance's file names".
   *
   * Value-free by construction: {@link DeclaredSource.service} is filled only
   * for the two keystore schemes, whose argument is a service name the file
   * carries in the open. A `literal` entry's argument IS the secret, so only
   * its KIND is recorded.
   */
  fileSource?: DeclaredSource;
}

/** A `.approval/env` line, reduced to what may be printed. */
export interface DeclaredSource {
  kind: EnvSourceKind;
  /** The service name or label, for `keychain:` and `secret-service:` only. */
  service?: string;
  /** 1-based line number in `.approval/env`. */
  line: number;
}

/** The declared source of an entry, with a literal's value dropped. */
function declaredSourceOf(entry: EnvFileEntry): DeclaredSource {
  return entry.kind === "keychain" || entry.kind === "secret-service"
    ? { kind: entry.kind, service: entry.argument, line: entry.line }
    : { kind: entry.kind, line: entry.line };
}

/** A declared source in words, and never a value. */
export function describeDeclaredSource(source: DeclaredSource): string {
  if (source.kind === "literal") return LITERAL_SOURCE;
  if (source.kind === "env") return "env: (inherited)";
  return `${source.kind}:${source.service ?? ""}`;
}

/** The whole answer. */
export interface EnvResolution {
  ok: true;
  /** Was there a file at all? */
  present: boolean;
  path: string;
  variables: ResolvedVariable[];
}

interface Wanted {
  name: string;
  declared: boolean;
  secretBearing: boolean;
  /** The repair for an unset one. */
  fix: string;
}

/** `approval setup <thing>`, or the generic advice for a policy-invented name. */
function setupFix(thing: string | null, name: string): string {
  return thing === null
    ? `no setup verb knows this variable: export ${name}=… in your shell, or add a \`${name}=…\` line to .approval/env`
    : `run \`approval setup ${thing}\` (APRV-74), or add a \`${name}=…\` line to .approval/env`;
}

/**
 * Walk the loaded policy for every string-valued key whose name ends in `_env`.
 *
 * Depth-unbounded and key-name-driven on purpose. `_env` is this project's whole
 * naming convention for "the policy carries a NAME" (§5.1 `token_env`,
 * `chat_id_env`; §5.2 `sampling_secret_env`, `vault.passphrase_env`), and a
 * future key that follows the convention should appear in `approval env` on the
 * day it is added to the schema, not on the day someone remembers to add it
 * here. The four known keys above are added by name first and win the dedupe, so
 * this walk contributes only the ones nothing else knows about.
 *
 * Arrays are walked; non-string values under an `_env` key are skipped, because
 * `token_env: 42` is a schema problem and not a variable name.
 */
function walkEnvNames(node: unknown, found: Map<string, true>): void {
  if (Array.isArray(node)) {
    for (const item of node) walkEnvNames(item, found);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.endsWith("_env") && typeof value === "string" && value.length > 0) {
      found.set(value, true);
      continue;
    }
    walkEnvNames(value, found);
  }
}

/**
 * The variables `approval env` answers for, in a stable order.
 *
 * Five by name — human identity, the Telegram token and chat id, the vault
 * passphrase, and the sampling secret — plus whatever else the policy names by
 * the `_env` convention.
 *
 * The sampling secret is the one conditional member: `audit.sampling_secret_env`
 * has NO default (an unnamed one disables sampling, SPEC.md §5.2), so listing a
 * made-up variable for it would invent configuration the operator never chose.
 * The other four all have defaults and are always listed.
 */
export function wantedVariables(load: PolicyLoadResult): Wanted[] {
  const policy = load.ok ? load.policy : null;
  const declaredTelegram = (key: string): boolean => {
    const telegram = policy?.channels?.["telegram"];
    const value = telegram === undefined ? undefined : telegram[key];
    return typeof value === "string" && value.length > 0;
  };

  const wanted: Wanted[] = [
    {
      name: HUMAN_ACTOR_ENV,
      declared: false,
      secretBearing: false,
      fix: setupFix("identity", HUMAN_ACTOR_ENV),
    },
    {
      name: telegramTokenEnvFor(load),
      declared: declaredTelegram("token_env"),
      secretBearing: true,
      fix: setupFix("channel telegram", telegramTokenEnvFor(load)),
    },
    {
      name: telegramChatEnvFor(load),
      declared: declaredTelegram("chat_id_env"),
      secretBearing: false,
      fix: setupFix("channel telegram", telegramChatEnvFor(load)),
    },
    {
      name: passphraseEnvFor(load),
      declared:
        typeof policy?.vault?.passphrase_env === "string" &&
        policy.vault.passphrase_env.length > 0,
      secretBearing: true,
      fix: setupFix("vault", passphraseEnvFor(load)),
    },
  ];

  const samplingEnv = policy?.audit?.sampling_secret_env;
  if (typeof samplingEnv === "string" && samplingEnv.length > 0) {
    wanted.push({
      name: samplingEnv,
      declared: true,
      secretBearing: true,
      fix: setupFix("sampling", samplingEnv),
    });
  }

  const taken = new Set(wanted.map((entry) => entry.name));
  const walked = new Map<string, true>();
  if (policy !== null) walkEnvNames(policy, walked);
  for (const name of [...walked.keys()].sort()) {
    if (taken.has(name)) continue;
    taken.add(name);
    wanted.push({
      // A name nothing in this build understands. Treated as secret-bearing,
      // which is the stricter reading and the right default for a variable
      // whose whole purpose, by the `_env` convention, is to hold a value the
      // policy refused to write down.
      name,
      declared: true,
      secretBearing: true,
      fix: setupFix(null, name),
    });
  }

  return wanted;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const LITERAL_SOURCE = "literal (plaintext in .approval/env)";

/**
 * Resolve every variable the policy implies, against the ambient environment
 * first and the source map second.
 *
 * **The ambient environment always wins.** A variable already exported in the
 * calling shell is reported `set-in-environment` and its file entry is not even
 * consulted: the human's shell is the authority (that is invariant 7's whole
 * point), and a file that could override an exported value would be a file that
 * silently redirects a gate operation's credentials.
 *
 * A whole-file refusal (bad mode, unreadable, unparseable) is returned as-is:
 * partial resolution of a file the runtime cannot fully read is how a typo turns
 * into a half-configured environment.
 */
export function resolveEnvironment(
  load: PolicyLoadResult,
  envFilePath: string,
  runner: SourceRunner = defaultSourceRunner,
  ambientEnv: NodeJS.ProcessEnv = process.env,
): EnvResolution | EnvFileRefusal {
  const file = readEnvFile(envFilePath);
  if (!file.ok) return file;

  const byKey = new Map<string, EnvFileEntry>();
  for (const entry of file.entries) byKey.set(entry.key, entry);

  const variables: ResolvedVariable[] = [];
  for (const want of wantedVariables(load)) {
    variables.push(resolveOne(want, byKey.get(want.name), runner, ambientEnv));
  }

  return { ok: true, present: file.present, path: file.path, variables };
}

function resolveOne(
  want: Wanted,
  entry: EnvFileEntry | undefined,
  runner: SourceRunner,
  ambientEnv: NodeJS.ProcessEnv,
): ResolvedVariable {
  const base = {
    name: want.name,
    declared: want.declared,
    secretBearing: want.secretBearing,
    ...(entry === undefined ? {} : { fileSource: declaredSourceOf(entry) }),
  };

  if (!SHELL_NAME_PATTERN.test(want.name)) {
    return {
      ...base,
      status: "unset",
      source: "unusable name",
      plaintext: false,
      fix: `the policy declares this as an environment variable NAME and it is not one; fix the _env key in APPROVAL.md`,
      refusal: {
        code: "invalid-variable-name",
        message: `${JSON.stringify(want.name)} is not a usable shell variable name, so no export line is emitted for it (a name carrying a space or a ; would make a policy file executable)`,
      },
    };
  }

  const ambient = ambientEnv[want.name];
  if (typeof ambient === "string" && ambient.length > 0) {
    return {
      ...base,
      status: "set-in-environment",
      value: ambient,
      source: "the environment (already exported; the file was not consulted)",
      plaintext: false,
    };
  }

  if (entry === undefined) {
    return { ...base, status: "unset", source: "unset", plaintext: false, fix: want.fix };
  }

  if (entry.kind === "literal") {
    return {
      ...base,
      status: "resolved-literal",
      value: entry.argument,
      source: LITERAL_SOURCE,
      plaintext: want.secretBearing,
    };
  }

  if (entry.kind === "env") {
    return {
      ...base,
      status: "unset",
      source: "env: (inherited) — and it is not set in this environment",
      plaintext: false,
      fix: want.fix,
    };
  }

  const outcome =
    entry.kind === "keychain"
      ? runner.keychain(entry.argument)
      : runner.secretService(entry.argument);
  const label = `${entry.kind}:${entry.argument}`;

  if (!outcome.ok) {
    return {
      ...base,
      status: "unset",
      source: label,
      plaintext: false,
      fix: want.fix,
      refusal: { code: outcome.code, message: outcome.message },
    };
  }
  if (outcome.value.length === 0) {
    return {
      ...base,
      status: "unset",
      source: label,
      plaintext: false,
      fix: want.fix,
      refusal: {
        code: "helper-item-missing",
        message: `${label} resolved to an empty value, which is not a credential`,
      },
    };
  }

  return {
    ...base,
    status: entry.kind === "keychain" ? "resolved-from-keychain" : "resolved-from-secret-service",
    value: outcome.value,
    source: label,
    plaintext: false,
  };
}
