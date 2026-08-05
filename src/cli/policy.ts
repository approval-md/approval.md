/**
 * `approval policy check|test <class>` (SPEC.md §10.1) — print the decision
 * trace for a hypothetical action class.
 *
 * As everywhere else in the CLI, this file holds no policy logic: loading lives
 * in `core/policy-load.ts`, matching in `core/policy-match.ts`, and the trace in
 * `core/policy-explain.ts`. What is decided *here* is the exit code, and one
 * choice in that mapping is load-bearing enough to state plainly.
 *
 * ## A broken policy is an answer, not an error (exit 0)
 *
 * The question this command answers is "what would policy do with this class".
 * When `APPROVAL.md` is missing, unparseable, or schema-invalid, that question
 * still has a complete and correct answer: **manual, everything, because the
 * policy failed to load**. Reporting that as a non-zero exit would push every
 * caller into treating a fail-closed answer as "no answer", and the predictable
 * repair is a caller that retries, falls back, or skips the check — i.e. that
 * routes around the safest possible outcome because the exit code called it a
 * failure. So the fail-closed answer exits 0 like any other, carrying
 * `provenance: "fail-closed"` and `manualBecause: "load-failure"` for callers
 * that need to distinguish a deliberate manual from a broken file. Agents must
 * branch on those fields, never on the exit code.
 *
 * Exit 4 is reserved for its usual meaning: a path that exists and cannot be
 * read. That is a fact about the filesystem, not about the policy, and — as in
 * `paths.ts` — its messages never use the word "corrupt".
 */

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import { explain, isActionClass, type Explanation } from "../core/policy-explain.js";
import { loadPolicy, POLICY_FILENAMES, type LoadPolicyOptions } from "../core/policy-load.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { commandPolicyAttest } from "./attest.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { POLICY_CHECK_HELP, POLICY_HELP, POLICY_TEST_HELP } from "./help.js";
import type { Streams } from "./main.js";

/**
 * `--reversible` takes an explicit `true|false` rather than being a bare
 * boolean, because this command has three distinct states and a bare flag can
 * only express two. "The caller did not say whether this is reversible"
 * (`reversible: null`, no floor — the policy answers on its own terms) is not
 * the same claim as "the caller says it is reversible", and neither is
 * `--reversible false`, which is the only way to ask the question that matters:
 * what does policy do with an action that cannot be undone? A bare `--reversible`
 * would leave the SPEC §7 floor unreachable from the CLI.
 */
const FLAGS: Record<string, FlagKind> = {
  "--reversible": "string",
  "--policy": "string",
  "--dir": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/**
 * Readability preflight for a policy path.
 *
 * Absent is deliberately **not** an I/O error: a missing policy file is the
 * fail-closed answer, delivered by `loadPolicy` as `file-missing`. A path that
 * exists but cannot be read (permission bit, or a directory where a file
 * belongs) is a filesystem problem, and reporting it as "manual, policy
 * missing" would tell an operator their policy is absent when it is merely
 * locked.
 */
function preflightPolicyFile(path: string): { ok: true } | { ok: false; message: string } {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, message: `policy ${path} could not be opened: ${detail(cause)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, message: `policy ${path} is a directory, not a policy file` };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch (cause) {
    return { ok: false, message: `policy ${path} is not readable: ${detail(cause)}` };
  }
  return { ok: true };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The final human line: the answer, plus the marker that qualifies it. */
function finalLine(explanation: Explanation): string {
  const autonomy = explanation.outcome.autonomy;
  if (explanation.loadFailure !== null) {
    return `-> ${autonomy} (fail-closed: ${explanation.loadFailure.code})`;
  }
  if (explanation.overridden !== null) {
    const source = explanation.overridden.pattern ?? "defaults.autonomy";
    return `-> ${autonomy} (floor applied over ${source}: ${explanation.overridden.autonomy})`;
  }
  return `-> ${autonomy}`;
}

/** One verb's worth of work; `check` and `test` differ only in their help text. */
function runVerb(argv: string[], streams: Streams, cwd: string, helpText: string): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, helpText);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${helpText}\n`);
    return EXIT_OK;
  }

  const actionClass = parsed.positionals[0];
  if (actionClass === undefined) {
    return usageError(streams, json, "missing <class> argument", helpText);
  }
  const extra = parsed.positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, helpText);
  }
  if (!isActionClass(actionClass)) {
    return usageError(
      streams,
      json,
      `${JSON.stringify(actionClass)} is not a valid action class (lowercase dot-separated segments, no wildcards)`,
      helpText,
    );
  }

  const reversibleFlag = stringFlag(parsed.flags, "--reversible");
  if (reversibleFlag !== null && reversibleFlag !== "true" && reversibleFlag !== "false") {
    return usageError(
      streams,
      json,
      `--reversible expects true or false, got ${JSON.stringify(reversibleFlag)}`,
      helpText,
    );
  }

  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);

  // `--policy` wins over discovery, exactly as `loadPolicy` treats `file` vs
  // `dir`; the preflight follows the same precedence so the path reported as
  // unreadable is the path that would have been read.
  const options: LoadPolicyOptions =
    policyFlag === null ? { dir } : { file: absolute(policyFlag, cwd) };

  const probes =
    options.file === undefined
      ? POLICY_FILENAMES.map((filename) => join(dir, filename))
      : [options.file];
  for (const probe of probes) {
    const check = preflightPolicyFile(probe);
    if (!check.ok) return ioError(streams, json, check.message);
  }

  const explanation = explain(
    loadPolicy(options),
    actionClass,
    reversibleFlag === null ? {} : { reversible: reversibleFlag === "true" },
  );

  if (json) {
    streams.out(`${JSON.stringify(explanation)}\n`);
  } else {
    for (const line of explanation.decisionPath) streams.out(`${line}\n`);
    streams.out(`${finalLine(explanation)}\n`);
  }
  return EXIT_OK;
}

/** `approval policy …` — dispatch to `check` / `test`, or print the help. */
export function commandPolicy(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined) {
    return usageError(
      streams,
      wantsJson(argv),
      "missing subcommand for `approval policy`",
      POLICY_HELP,
    );
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${POLICY_HELP}\n`);
    return EXIT_OK;
  }

  switch (sub) {
    case "check":
      return runVerb(rest, streams, cwd, POLICY_CHECK_HELP);
    case "test":
      return runVerb(rest, streams, cwd, POLICY_TEST_HELP);
    // The one policy verb that writes: it lives in `attest.ts` because nothing
    // it does — hashing, identity, appending — belongs to the explain path.
    case "attest":
      return commandPolicyAttest(rest, streams, cwd);
    default:
      return usageError(
        streams,
        wantsJson(argv),
        `unknown subcommand ${JSON.stringify(sub)} for \`approval policy\``,
        POLICY_HELP,
      );
  }
}
