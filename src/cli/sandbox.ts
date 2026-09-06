/**
 * `approval sandbox` — run a command with no way out to the network (APRV-193).
 *
 * ## Why a verb, when `approval run` already sandboxes
 *
 * `approval run` covers the actions the gate SEES: it holds a grant or it does
 * not, it appends `execution.started`, and since APRV-193 it puts an ungranted
 * child in a room with no doors. It does not cover the commands the harness
 * runs on its own — `npm test`, `node scripts/whatever.mjs` — which the hook
 * classifies `files.write.workspace`, allows, and then never touches again,
 * because the hook DECIDES and the harness EXECUTES. Those are the commands that
 * run code an agent wrote a minute ago, and they are the whole of the
 * laundering hole this task exists to close.
 *
 * The hook cannot close it: a `PreToolUse` verdict is allow or deny, and it
 * cannot rewrite the command into a wrapper. So the wrapper is a verb the
 * command is written with, `approval sandbox -- npm test`, and two things make
 * that more than a convention an agent could simply not type:
 *
 * 1. `core/command-class.ts` classifies the wrapper as its INNER argv, so
 *    running something safely is no longer punished with `hook-unclassified`
 *    (before this task, `sandbox-exec …` was denied while the bare command was
 *    allowed — the hook actively penalised the safe spelling), and the wrapper
 *    cannot launder anything either, because the class the hook resolves is the
 *    inner command's own.
 * 2. `APPROVAL_HOOK_REQUIRE_SANDBOX=1` makes the hook DENY an allowed-class
 *    exec that is not written this way, with a message naming the spelling that
 *    works. It is off by default and turning it on can only ever refuse more,
 *    which is why an environment variable is an acceptable home for it.
 *
 * ## What it does
 *
 * Builds the profile (`core/sandbox.ts`), scrubs the credential-bearing
 * variables out of the child's environment (`core/child-env.ts`, APRV-205),
 * spawns, and exits with the child's own exit code. It appends NOTHING: this
 * verb removes a capability, it does not authorize anything, and a log entry
 * per `npm test` would be the transparency log inheriting a database's problem
 * (SPEC.md §2, and the reason gate-routed editing was rejected on this task).
 *
 * ## What it fails at, stated plainly
 *
 * An agent HARNESS cannot run under this. `claude` and `cursor-agent` talk to a
 * model over the network, and this verb denies exactly that, so
 * `approval sandbox -- claude` is a session that cannot think. Sandboxing a
 * whole session needs an egress allowlist reaching one host, which Seatbelt
 * cannot express by hostname and which the prior art (Claude Code's own sandbox
 * mode) solves with a local proxy. That is a follow-up, and until it exists the
 * unit this verb protects is the COMMAND rather than the session.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { constants as osConstants } from "node:os";

import { childEnvironment } from "../core/child-env.js";
import { loadPolicy } from "../core/policy-load.js";
import {
  credentialPathsFor,
  detectSandbox,
  resolveExecutable,
  wrapForSandbox,
} from "../core/sandbox.js";
import { passphraseEnvFor } from "../core/vault.js";
import { parseFlags, boolFlag, stringFlag, type FlagKind } from "./args.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { SANDBOX_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH } from "./paths.js";
import { usageErrorText } from "./usage.js";

/** Shell convention, and `approval run`'s own: the command did not run. */
const EXIT_COMMAND_NOT_RUN = 127;

const FLAGS: Record<string, FlagKind> = {
  "--allow-loopback": "boolean",
  "--log": "string",
  "--long": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

export function commandSandbox(argv: string[], streams: Streams, cwd: string): number {
  // The split happens on the RAW argv, before any parsing: everything to the
  // right of the first `--` is the child's and may contain any flag this CLI
  // knows. `approval run` splits the same way for the same reason.
  const separator = argv.indexOf("--");
  const ours = separator === -1 ? argv : argv.slice(0, separator);
  const childArgv = separator === -1 ? [] : argv.slice(separator + 1);

  const parsed = parseFlags(ours, FLAGS);
  if (!parsed.ok) {
    streams.err(usageErrorText(parsed.message, SANDBOX_HELP));
    return EXIT_USAGE;
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    // `--long` is intercepted in `main.ts` for every verb at once, so it never
    // reaches here; the flag is in the spec only so it is not an unknown-flag
    // usage error on the way past.
    streams.out(`${SANDBOX_HELP}\n`);
    return EXIT_OK;
  }
  const unexpected = parsed.positionals[0];
  if (unexpected !== undefined) {
    return usage(
      streams,
      `unexpected argument ${JSON.stringify(unexpected)}; the command to run goes after \`--\``,
    );
  }
  const command = childArgv[0];
  if (command === undefined) {
    return usage(streams, "missing command: `approval sandbox [--allow-loopback] -- <cmd…>`");
  }

  // Fail closed, on BOTH branches, and this is the one place that is stricter
  // than `approval run`. `run` on a platform with no mechanism proceeds and
  // records `sandbox: "unsupported"`, because refusing there would take the
  // whole execution path away from every operator not on macOS. This verb makes
  // one promise and has nothing else to offer: a command it ran anyway would be
  // a command an operator believes is starved and is not.
  const detection = detectSandbox();
  if (!detection.available || detection.mechanism === null) {
    streams.err(
      `approval: no egress sandbox on this machine (${detection.reason}); the command was NOT run. See docs/sandboxed-exec.md.\n`,
    );
    return EXIT_COMMAND_NOT_RUN;
  }

  const logPath = stringFlag(parsed.flags, "--log") ?? DEFAULT_LOG_PATH;
  const child = childEnvironment({ passphraseEnv: passphraseEnvFor(loadPolicy({ dir: cwd })) });
  const resolved = resolveExecutable(command, child.env);
  if (resolved === null) {
    // Resolved HERE rather than left to the wrapper: `sandbox-exec` execs
    // through `execvp` and a failed lookup exits 71, which an operator would
    // read as the command's own answer.
    streams.err(`approval: ${JSON.stringify(command)} is not on PATH; the command was NOT run.\n`);
    return EXIT_COMMAND_NOT_RUN;
  }

  const wrapped = wrapForSandbox(detection.mechanism, resolved, childArgv.slice(1), {
    loopback: boolFlag(parsed.flags, "--allow-loopback"),
    denyRead: credentialPathsFor(logPath),
  });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, {
      cwd,
      stdio: "inherit",
      env: child.env,
    });
    if (result.error !== undefined) {
      streams.err(`approval: the command could not be run (${result.error.message}).\n`);
      return EXIT_COMMAND_NOT_RUN;
    }
    if (result.signal !== null) {
      // The shell's own convention, and `approval run`'s: a child killed by a
      // signal reports 128 + the signal number rather than pretending to an
      // exit code it never produced.
      const numbers = osConstants.signals as unknown as Record<string, number | undefined>;
      return 128 + (numbers[result.signal] ?? 0);
    }
    return result.status ?? EXIT_COMMAND_NOT_RUN;
  } finally {
    rmSync(wrapped.cleanup, { recursive: true, force: true });
  }
}

function usage(streams: Streams, message: string): number {
  streams.err(usageErrorText(message, SANDBOX_HELP));
  return EXIT_USAGE;
}
