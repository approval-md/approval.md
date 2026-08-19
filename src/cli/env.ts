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
  envFilePathFor,
  resolveEnvironment,
  type EnvFileRefusal,
  type ResolvedVariable,
} from "../core/env-file.js";
import { loadPolicy } from "../core/policy-load.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { ENV_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";
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
    streams.err(`approval: ${refusal.code}: ${refusal.message}\n`);
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

  if (check) return emitCheck(streams, resolved.path, resolved.present, resolved.variables, unmet);
  return emitExports(streams, resolved.path, resolved.present, resolved.variables);
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
  path: string,
  present: boolean,
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
      streams.out(`export ${entry.name}=${shellSingleQuote(entry.value)}  # already set\n`);
      continue;
    }
    streams.out(`export ${entry.name}=${shellSingleQuote(entry.value)}\n`);
  }

  return EXIT_OK;
}
