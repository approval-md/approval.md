/**
 * `approval env` — resolve `.approval/env` and print an export block (APRV-73).
 *
 * **The only verb that reads `.approval/env`.** Nothing else in this runtime
 * consults that file, and the reason is written out in full in
 * `core/env-file.ts` and in SPEC.md §11: `APPROVAL_HUMAN` is human identity in
 * v0.1, so a working-tree file that any process loaded implicitly would let
 * anything able to write that file act as the human on every human-only verb —
 * `policy attest`, `grant`, `vault set`. The file is inert until a human
 * evaluates this command in their own shell:
 *
 * ```sh
 * eval "$(approval env)"          # after reading `approval env --check`
 * ```
 *
 * That is the whole design. The environment a gate operation runs under is
 * always one a human established, and this verb's output is the thing they
 * established it with — visible, inspectable, and evaluated on purpose.
 *
 * **This verb prints secrets, by design, on exactly two paths.** The default
 * output and `--json` carry values, because their entire job is to move a value
 * into a shell or into a caller. `--check` carries none, on any path, ever: it
 * is the path a human runs to look at their configuration with someone standing
 * behind them, and the test suite sweeps every `--check` byte for the fixture
 * secrets. The help text says which is which, because a verb that emits
 * credentials must never be a surprise.
 *
 * **The export block says what it exported** (APRV-278). Alongside the values it
 * emits one `APPROVAL_ENV_PROVENANCE` line carrying a format version, this
 * instance's id, the sha256 of the env file bytes it read, and the NAMES it
 * resolved out of that file. No value is in it. It exists because `approval up`
 * and `approval doctor` report an exported variable whose file line was not
 * consulted, they read no values by design, and without this they could not tell
 * a stranger's export from the one the documented `eval "$(approval env)"` had
 * just made — so they reported the correct ritual as cross-instance bleed. A
 * value that arrived from the calling shell is re-exported by this block and is
 * deliberately NOT listed, so passing a foreign token through one `eval` cannot
 * launder it into "configured by this instance".
 *
 * **Exit 0 even when variables are unresolved**, on the default path. The output
 * is destined for `eval`, and a shell function that failed because the operator
 * has no Telegram configured would be a shell function nobody puts in their
 * profile. Unresolved variables are emitted as comments naming the repair.
 * `--check` is the path with an opinion: it exits 1 when a variable the POLICY
 * NAMED is unresolved, because a policy that asked for a variable is a promise
 * the machine is not keeping. A default nobody mentioned is an offer, and
 * declining it is not a fault.
 */

import {
  defaultSourceRunner,
  describeDeclaredSource,
  envFilePathFor,
  resolveEnvironment,
  type DeclaredSource,
  type EnvFileRefusal,
  type ResolvedVariable,
} from "../core/env-file.js";
import { ENV_PROVENANCE_VAR, formatEnvProvenance, ownEnvExports } from "../core/instance.js";
import { loadPolicy } from "../core/policy-load.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { ENV_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--check": "boolean",
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, ENV_HELP));
  return EXIT_USAGE;
}

/**
 * A refusal onto the frozen exit table. A filesystem fact — including the mode,
 * whose repair is a `chmod` — is 4; a file whose CONTENTS this runtime will not
 * act on is 1, exactly as a vault refusal splits.
 */
function refusalExitCode(refusal: EnvFileRefusal): number {
  return refusal.code === "env-file-io" || refusal.code === "env-file-mode"
    ? EXIT_IO
    : EXIT_INTEGRITY;
}

function emitRefusal(streams: Streams, json: boolean, refusal: EnvFileRefusal): number {
  if (json) {
    streams.err(
      `${JSON.stringify({ ok: false, error: { code: refusal.code, message: refusal.message, path: refusal.path, ...(refusal.line === undefined ? {} : { line: refusal.line }) } })}\n`,
    );
  } else {
    streams.err(`${renderRefusal(style({ json }), refusal.code, refusal.message)}\n`);
  }
  return refusalExitCode(refusal);
}

/**
 * A value inside single quotes, safe for `eval` in any POSIX shell.
 *
 * Single quotes because they are the only quoting a POSIX shell does not
 * interpret at all: `$`, a backtick, `\`, `"` and a newline are all literal
 * inside them, and the one character that cannot appear — the single quote —
 * is closed, escaped, and reopened as `'\''`. Nothing here is escaped
 * character-by-character; there is exactly one substitution, which is why this
 * is auditable at a glance and why `tests/cli-env.test.ts` pins it against a
 * value containing every one of those characters.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** The status column of `--check`, as a word an operator can scan. */
function statusWord(variable: ResolvedVariable): string {
  switch (variable.status) {
    case "set-in-environment":
      return "set";
    case "resolved-from-keychain":
      return "keychain";
    case "resolved-from-secret-service":
      return "secret-service";
    case "resolved-literal":
      return "literal";
    default:
      return "UNSET";
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * The value came from the ambient environment while this instance's file names
 * a source of its own, AND this instance's own `approval env` did not put it
 * there (APRV-178, narrowed by APRV-278).
 *
 * Reported, never failed. The precedence is correct and is invariant 7's whole
 * point; what was missing is that nothing said out loud when the two disagree,
 * and the disagreement is exactly the shape of the incident that produced this
 * check: a production token exported in a shell profile, a demo instance whose
 * `.approval/env` named its own item, and every fresh terminal quietly using
 * the production bot.
 *
 * `eval "$(approval env)"` leaves the same SHAPE behind and is the documented
 * ritual, so the exempt set comes from `ownEnvExports` — the same function
 * `approval up` and `approval doctor` answer this question with, so that the
 * three cannot come to disagree about one shell.
 */
function overriddenByEnvironment(entry: ResolvedVariable, own: ReadonlySet<string>): boolean {
  return (
    entry.status === "set-in-environment" && entry.fileSource !== undefined && !own.has(entry.name)
  );
}

/** Unresolved AND named by the policy: the thing `--check` fails on. */
function failing(variables: ResolvedVariable[]): ResolvedVariable[] {
  return variables.filter((entry) => entry.status === "unset" && entry.declared);
}

/**
 * `approval env [--check] [--json] [--policy <path>] [--dir <path>] [--log <path>]`
 */
export function commandEnv(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${ENV_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const check = boolFlag(parsed.flags, "--check");
  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const envPath = envFilePathFor(logPath);

  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const load = loadPolicy(
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
  );

  const resolved = resolveEnvironment(load, envPath, defaultSourceRunner, process.env);
  if (!resolved.ok) return emitRefusal(streams, json, resolved);

  const unmet = failing(resolved.variables);

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: unmet.length === 0,
        path: resolved.path,
        present: resolved.present,
        variables: resolved.variables.map((entry) => ({
          name: entry.name,
          status: entry.status,
          source: entry.source,
          plaintext: entry.plaintext,
          declared: entry.declared,
          // APRV-178. Value-free on every path, `--check` or not: a keystore
          // service name is what the file carries in the open, and a literal
          // entry contributes its KIND alone.
          ...(entry.fileSource === undefined ? {} : { file_source: entry.fileSource }),
          // --json --check is the value-free machine path, exactly as --check is
          // the value-free human one. The key is omitted rather than nulled: a
          // null would read as "resolved to nothing".
          ...(check || entry.value === undefined ? {} : { value: entry.value }),
          ...(entry.fix === undefined ? {} : { fix: entry.fix }),
          ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
        })),
      })}\n`,
    );
    return check && unmet.length > 0 ? EXIT_INTEGRITY : EXIT_OK;
  }

  if (check) {
    return emitCheck(
      streams,
      resolved.path,
      resolved.present,
      resolved.variables,
      unmet,
      ownEnvExports(logPath, { ambientEnv: process.env, envFileDigest: resolved.digest }),
    );
  }
  return emitExports(
    streams,
    logPath,
    resolved.path,
    resolved.present,
    resolved.digest,
    resolved.variables,
  );
}

/**
 * The value-free table. NO VALUE IS PRINTED ON ANY PATH HERE, including the
 * refusal detail lines: `source` is a scheme and a service label, which is what
 * `.approval/env` already carries in the open.
 */
function emitCheck(
  streams: Streams,
  path: string,
  present: boolean,
  variables: ResolvedVariable[],
  unmet: ResolvedVariable[],
  own: ReadonlySet<string>,
): number {
  streams.out(
    present
      ? `${path}\n`
      : `${path} (no file — every variable below is inherited from this shell or unset)\n`,
  );
  const width = Math.max(4, ...variables.map((entry) => entry.name.length));
  streams.out(`${pad("NAME", width)}  ${pad("STATUS", 14)}  SOURCE\n`);
  for (const entry of variables) {
    streams.out(`${pad(entry.name, width)}  ${pad(statusWord(entry), 14)}  ${entry.source}\n`);
    if (entry.refusal !== undefined) {
      streams.out(`${" ".repeat(width)}  ${pad("", 14)}  ${entry.refusal.code}: ${entry.refusal.message}\n`);
    }
    if (entry.status === "unset" && entry.fix !== undefined) {
      streams.out(`${" ".repeat(width)}  ${pad("", 14)}  fix: ${entry.fix}\n`);
    }
  }

  const plaintext = variables.filter((entry) => entry.plaintext);
  if (plaintext.length > 0) {
    streams.out(
      `\nPLAINTEXT: ${plaintext
        .map((entry) => entry.name)
        .join(", ")} — the value is written literally in ${path}. That is permitted and it is always reported; the file must be mode 0600 and \`approval init\` gitignores it. Move one to your keychain with \`<NAME>=keychain:<service>\` (macOS) or \`<NAME>=secret-service:<label>\` (Linux).\n`,
    );
  }

  const bleeding = variables.filter((entry) => overriddenByEnvironment(entry, own));
  if (bleeding.length > 0) {
    streams.out(
      `\nCROSS-INSTANCE BLEED: ${bleeding
        .map(
          (entry) =>
            `${entry.name} is set in this shell, and ${path} line ${String(entry.fileSource?.line ?? 0)} names ${describeDeclaredSource(entry.fileSource as DeclaredSource)} instead`,
        )
        .join("; ")}. The exported value wins and the file is not consulted, which is deliberate: your shell is the authority. What is reported here is that the export is not one this instance's own \`approval env\` made, so the verbs run from HERE may be using a credential it never configured. That is how a demo gate ends up sending through another instance's bot and eating its approval taps (APRV-178). If that is not what you want, \`unset ${bleeding
        .map((entry) => entry.name)
        .join(" ")}\` and then \`eval "$(approval env)"\` in this shell.\n`,
    );
  }

  streams.out("\nNo value is printed on this path. `approval env` (without --check) emits them.\n");

  if (unmet.length === 0) {
    streams.out("ok: every variable your policy names resolves\n");
    return EXIT_OK;
  }
  streams.err(
    `approval: ${String(unmet.length)} variable(s) your policy NAMES are unresolved: ${unmet
      .map((entry) => entry.name)
      .join(", ")}\n`,
  );
  return EXIT_INTEGRITY;
}

/** The export block. This is the path that emits secrets, on purpose. */
function emitExports(
  streams: Streams,
  logPath: string,
  path: string,
  present: boolean,
  digest: string,
  variables: ResolvedVariable[],
): number {
  streams.out(`# approval env — the environment a gate operation should run under.\n`);
  streams.out(`# Source: ${path}${present ? "" : " (no file; values below are already in this shell)"}\n`);
  streams.out(`#\n`);
  streams.out(
    `# THIS OUTPUT CARRIES SECRETS, deliberately: its job is to put them in your\n# shell. Read it (or run \`approval env --check\`, which prints no values) and\n# then evaluate it yourself:\n#\n#     eval "$(approval env)"\n#\n`,
  );
  streams.out(
    `# No other command reads that file. Human identity lives in one of these\n# variables, so a file a process loaded on its own would let anything able to\n# write it act as you.\n`,
  );
  const unresolved = variables.filter((entry) => entry.status === "unset");
  if (unresolved.length > 0) {
    streams.out(
      `#\n# The \`approval setup\` verbs named below write those lines for you, one\n# secret at a time. Export the variable yourself, or add the line by hand,\n# if you would rather not run them.\n`,
    );
  }
  streams.out(`\n`);

  const fromFile: string[] = [];
  for (const entry of variables) {
    if (entry.status === "unset" || entry.value === undefined) {
      streams.out(`# ${entry.name} unset: ${entry.fix ?? entry.source}\n`);
      continue;
    }
    if (entry.status === "set-in-environment") {
      // Re-exported rather than skipped: `eval "$(approval env)"` in a subshell
      // that later exports nothing else should produce the same environment
      // whichever way each value arrived, and an operator diffing the block
      // against their shell wants every variable in it.
      //
      // Deliberately NOT counted as this instance's own export below (APRV-278).
      // The value arrived from the calling shell and this command did not read
      // the file's line for it, so vouching for it here would be how a foreign
      // token launders itself into "configured by this instance" by passing
      // through one `eval`.
      streams.out(`export ${entry.name}=${shellSingleQuote(entry.value)}  # already set\n`);
      continue;
    }
    fromFile.push(entry.name);
    streams.out(`export ${entry.name}=${shellSingleQuote(entry.value)}\n`);
  }

  // APRV-278. What this block resolved out of the file, so that `approval up`
  // and `approval doctor` can tell the documented ritual from a stranger's
  // export instead of reporting both as cross-instance bleed. Names, an
  // instance id and a file digest; no value, on any path. Omitted entirely when
  // nothing was resolved from the file, because then there is nothing to claim.
  if (fromFile.length > 0) {
    streams.out(
      `\n# What this block took from the file, for \`approval up\` and \`approval doctor\`.\n`,
    );
    streams.out(
      `# Names and hashes only, no value. Why: \`approval env --help --long\`.\n`,
    );
    streams.out(
      `export ${ENV_PROVENANCE_VAR}=${shellSingleQuote(formatEnvProvenance(logPath, digest, fromFile))}\n`,
    );
  }

  return EXIT_OK;
}
