/**
 * `approval` CLI entry point — the commands of SPEC.md §10.1: the log-facing
 * `approval log verify | tail | export` and `approval reindex`, the policy
 * verbs, and the gate verbs `register`, `request`, `grant`, `reject`, `revoke`,
 * and `expire`.
 *
 * **The CLI holds no logic.** Chain verification lives in `core/verify.ts`, the
 * projection in `core/reindex.ts`, and appends in `core/log.ts`. Everything
 * here is argument parsing, path resolution, output formatting, and the mapping
 * from a core result to an exit code. That boundary is deliberate: the rules
 * about what counts as a clean log must have exactly one implementation, and it
 * is not this one.
 *
 * **Two things are frozen public API**, because agents depend on them
 * mechanically: the exit codes (see `exit-codes.ts`) and the `--json` shapes
 * (documented in every `--help`). Both are pinned by tests.
 *
 * **I/O is not integrity.** `verify()` cannot tell an unreadable log from a
 * broken one, so this layer stats and access-checks the path *first* and
 * reports filesystem problems as {@link EXIT_IO} with a message that never uses
 * the word "corrupt". Absent files are exempt: an empty log is clean.
 *
 * Nothing in this file writes to the log, and no command repairs a torn tail.
 * The gate verbs do append — through `core/gate.ts`, which appends through
 * `core/log.ts` — and their exit-code mapping lives in `gate.ts` beside them: a
 * gate refusal is {@link EXIT_INTEGRITY}, because the command was well-formed
 * and the runtime's answer was no.
 */

import { pathToFileURL } from "node:url";

import { reindex } from "../core/reindex.js";
import { verify } from "../core/verify.js";
import { boolFlag, countFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import {
  EXPORT_HELP,
  LOG_HELP,
  REINDEX_HELP,
  ROOT_HELP,
  TAIL_HELP,
  VERIFY_HELP,
} from "./help.js";
import {
  commandDecide,
  commandExpire,
  commandRegister,
  commandRequest,
} from "./gate.js";
import {
  commandExecution,
  commandQueue,
  commandRun,
  commandStatus,
  commandWait,
} from "./execute.js";
import { commandChannel } from "./channel.js";
import { commandPolicy } from "./policy.js";
import { commandConsume, commandToken } from "./token.js";
import {
  DEFAULT_INDEX_PATH,
  DEFAULT_LOG_PATH,
  preflightLog,
  resolvePath,
} from "./paths.js";
import { parseLines, readCompleteLines } from "./records.js";

/** Output sinks, injectable so the command layer stays testable in-process. */
export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

export interface MainOptions {
  cwd?: string;
  streams?: Streams;
}

const DEFAULT_TAIL_COUNT = 10;

const HELP_FLAGS: Record<string, FlagKind> = { "--help": "boolean", "-h": "boolean" };

function defaultStreams(): Streams {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  };
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

function emitJsonError(
  streams: Streams,
  code: "usage" | "io" | "integrity",
  message: string,
): void {
  streams.err(`${JSON.stringify({ error: { code, message } })}\n`);
}

function usageError(
  streams: Streams,
  json: boolean,
  message: string,
  helpText: string,
): number {
  if (json) emitJsonError(streams, "usage", message);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) emitJsonError(streams, "io", message);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function integrityError(streams: Streams, json: boolean, message: string): number {
  if (json) emitJsonError(streams, "integrity", message);
  else streams.err(`approval: ${message}\n`);
  return EXIT_INTEGRITY;
}

/** `--json` as seen before parsing, so parse failures can still answer in JSON. */
function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

/** One human-readable line per record: seq, ts, event, actor, task. */
function formatRecord(record: unknown): string {
  const fields = (record ?? {}) as Record<string, unknown>;
  const cell = (value: unknown): string =>
    value === undefined || value === null ? "-" : String(value);
  return [
    cell(fields["seq"]),
    cell(fields["ts"]),
    cell(fields["event"]),
    cell(fields["actor"]),
    cell(fields["task"]),
  ].join("\t");
}

/** Shared front half of every command: flags, --help, and the log path. */
type Prelude =
  | { kind: "handled"; code: number }
  | { kind: "run"; flags: Record<string, string | boolean>; logPath: string; json: boolean };

function prelude(
  argv: string[],
  spec: Record<string, FlagKind>,
  helpText: string,
  streams: Streams,
  cwd: string,
): Prelude {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, { ...spec, ...HELP_FLAGS });
  if (!parsed.ok) {
    return { kind: "handled", code: usageError(streams, json, parsed.message, helpText) };
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${helpText}\n`);
    return { kind: "handled", code: EXIT_OK };
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return {
      kind: "handled",
      code: usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, helpText),
    };
  }
  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  return { kind: "run", flags: parsed.flags, logPath, json };
}

function commandVerify(argv: string[], streams: Streams, cwd: string): number {
  const front = prelude(
    argv,
    { "--log": "string", "--json": "boolean" },
    VERIFY_HELP,
    streams,
    cwd,
  );
  if (front.kind === "handled") return front.code;
  const { logPath, json } = front;

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const result = verify(logPath);

  if (result.status === "clean") {
    if (json) emitJson(streams, { status: result.status, records: result.records, head: result.head });
    else {
      const head =
        result.head === null ? "head none" : `head seq ${result.head.seq} ${result.head.hash}`;
      streams.out(`clean: ${result.records} record(s), ${head}\n`);
    }
    return EXIT_OK;
  }

  if (result.status === "torn-tail") {
    if (json) {
      emitJson(streams, {
        status: result.status,
        records: result.records,
        head: null,
        intactThroughSeq: result.intactThroughSeq,
        message: result.message,
      });
    } else {
      streams.out(
        `torn-tail: ${result.records} record(s), intact through seq ${result.intactThroughSeq}\n`,
      );
      streams.err(`approval: ${result.message}\n`);
    }
    return EXIT_TORN_TAIL;
  }

  if (json) {
    emitJson(streams, {
      status: result.status,
      records: null,
      head: null,
      firstBadSeq: result.firstBadSeq,
      reason: result.reason,
      message: result.message,
    });
  } else {
    const where = result.firstBadSeq === null ? "unknown seq" : `seq ${result.firstBadSeq}`;
    streams.err(`approval: corrupt: ${result.reason} at ${where}\n`);
    streams.err(`approval: ${result.message}\n`);
  }
  return EXIT_INTEGRITY;
}

/**
 * `tail` and `export` share everything but the slice and the rendering, so they
 * share the verify → read → refuse-or-print sequence too.
 */
function readForOutput(
  logPath: string,
  streams: Streams,
  json: boolean,
): { code: number } | { lines: string[]; warning: string | null } {
  const result = verify(logPath);

  if (result.status === "corrupt") {
    return {
      code: integrityError(
        streams,
        json,
        `log ${logPath} failed chain verification (${result.reason}); refusing to print records from a tampered log: ${result.message}`,
      ),
    };
  }

  const read = readCompleteLines(logPath, result.records);
  if (!read.ok) return { code: ioError(streams, json, read.message) };

  return {
    lines: read.lines,
    warning:
      result.status === "torn-tail"
        ? `log ${logPath} ends with a torn line (an unterminated final record, the signature of a crashed write); the ${result.records} intact record(s) are shown and the log is left exactly as it is — nothing was repaired or truncated`
        : null,
  };
}

function commandTail(argv: string[], streams: Streams, cwd: string): number {
  const front = prelude(
    argv,
    { "--log": "string", "--json": "boolean", "-n": "string" },
    TAIL_HELP,
    streams,
    cwd,
  );
  if (front.kind === "handled") return front.code;
  const { flags, logPath, json } = front;

  const count = countFlag(flags, "-n");
  if (!count.ok) return usageError(streams, json, count.message, TAIL_HELP);
  const limit = count.value ?? DEFAULT_TAIL_COUNT;

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const outcome = readForOutput(logPath, streams, json);
  if ("code" in outcome) return outcome.code;

  const selected = limit === 0 ? [] : outcome.lines.slice(-limit);
  const parsed = parseLines(logPath, selected);
  if (!parsed.ok) return ioError(streams, json, parsed.message);

  if (json) {
    const status = outcome.warning === null ? "ok" : "torn-tail";
    emitJson(
      streams,
      outcome.warning === null
        ? { status, records: parsed.records }
        : { status, records: parsed.records, warning: outcome.warning },
    );
  } else {
    for (const record of parsed.records) streams.out(`${formatRecord(record)}\n`);
  }
  if (outcome.warning !== null && !json) streams.err(`approval: ${outcome.warning}\n`);
  return EXIT_OK;
}

function commandExport(argv: string[], streams: Streams, cwd: string): number {
  const front = prelude(
    argv,
    { "--log": "string", "--json": "boolean" },
    EXPORT_HELP,
    streams,
    cwd,
  );
  if (front.kind === "handled") return front.code;
  const { logPath, json } = front;

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const outcome = readForOutput(logPath, streams, json);
  if ("code" in outcome) return outcome.code;

  if (json) {
    const parsed = parseLines(logPath, outcome.lines);
    if (!parsed.ok) return ioError(streams, json, parsed.message);
    emitJson(
      streams,
      outcome.warning === null
        ? { records: parsed.records }
        : { records: parsed.records, warning: outcome.warning },
    );
  } else {
    // Verbatim: the stored line plus the newline that terminated it. No parse,
    // no re-serialization — export of a clean log is a byte-for-byte copy.
    for (const line of outcome.lines) streams.out(`${line}\n`);
  }
  if (outcome.warning !== null && !json) streams.err(`approval: ${outcome.warning}\n`);
  return EXIT_OK;
}

function commandReindex(argv: string[], streams: Streams, cwd: string): number {
  const front = prelude(
    argv,
    {
      "--log": "string",
      "--index": "string",
      "--force": "boolean",
      "--json": "boolean",
    },
    REINDEX_HELP,
    streams,
    cwd,
  );
  if (front.kind === "handled") return front.code;
  const { flags, logPath, json } = front;

  const indexPath = resolvePath(stringFlag(flags, "--index"), DEFAULT_INDEX_PATH, cwd);

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const result = reindex(logPath, indexPath, boolFlag(flags, "--force") ? { force: true } : {});

  if (result.ok) {
    if (json) {
      emitJson(streams, {
        ok: true,
        records: result.records,
        head: result.head,
        truncated: result.truncated,
      });
    } else {
      const head =
        result.head === null ? "head none" : `head seq ${result.head.seq} ${result.head.hash}`;
      streams.out(
        `indexed ${result.records} record(s) into ${indexPath}: ${head}, truncated ${result.truncated}\n`,
      );
    }
    return EXIT_OK;
  }

  if (json) {
    emitJson(streams, {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    });
  } else {
    streams.err(`approval: ${result.error.message}\n`);
  }
  switch (result.error.code) {
    case "not-clean":
      return EXIT_INTEGRITY;
    case "torn-tail":
      return EXIT_TORN_TAIL;
    default:
      return EXIT_IO;
  }
}

function commandLog(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined) {
    return usageError(streams, wantsJson(argv), "missing subcommand for `approval log`", LOG_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${LOG_HELP}\n`);
    return EXIT_OK;
  }

  switch (sub) {
    case "verify":
      return commandVerify(rest, streams, cwd);
    case "tail":
      return commandTail(rest, streams, cwd);
    case "export":
      return commandExport(rest, streams, cwd);
    default:
      return usageError(
        streams,
        wantsJson(argv),
        `unknown subcommand ${JSON.stringify(sub)} for \`approval log\``,
        LOG_HELP,
      );
  }
}

/**
 * Run the CLI. Returns the process exit code rather than calling
 * `process.exit`, so buffered stdout is flushed by the normal exit path — a
 * truncated JSON object would be worse than no output at all.
 */
export function main(argv: string[], options: MainOptions = {}): number {
  const streams = options.streams ?? defaultStreams();
  const cwd = options.cwd ?? process.cwd();

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined) {
    return usageError(streams, false, "no command given", ROOT_HELP);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    streams.out(`${ROOT_HELP}\n`);
    return EXIT_OK;
  }

  switch (command) {
    case "log":
      return commandLog(rest, streams, cwd);
    case "policy":
      return commandPolicy(rest, streams, cwd);
    // The gate verbs (APRV-16). grant/reject/revoke are human-only and expire
    // is the system verb; the enforcement lives in core, not in this dispatch.
    case "register":
      return commandRegister(rest, streams, cwd);
    case "request":
      return commandRequest(rest, streams, cwd);
    case "grant":
      return commandDecide("grant", rest, streams, cwd);
    case "reject":
      return commandDecide("reject", rest, streams, cwd);
    case "revoke":
      return commandDecide("revoke", rest, streams, cwd);
    case "expire":
      return commandExpire(rest, streams, cwd);
    // The token verbs (APRV-17). `token` reports status and writes nothing;
    // `consume` is internal plumbing for APRV-18's `approval run` and is the
    // only sanctioned appender of execution.started on the manual path.
    case "token":
      return commandToken(rest, streams, cwd);
    case "consume":
      return commandConsume(rest, streams, cwd);
    // The execution verbs (APRV-18). `run` is the only command that spawns
    // anything and the only one that can exit 5; `wait` the only one that can
    // exit 6. `queue` is the pending-decision inbox and `status` is system
    // health — deliberately two verbs, because they answer to two different
    // people (the human who decides, the operator who repairs).
    case "run":
      return commandRun(rest, streams, cwd);
    // The recovery verb (APRV-20 pass two). `execution resolve` is the only
    // sanctioned way to close a dangling execution, and it is human-only,
    // note-mandatory, and records no invented exit code.
    case "execution":
      return commandExecution(rest, streams, cwd);
    case "wait":
      return commandWait(rest, streams, cwd);
    case "queue":
      return commandQueue(rest, streams, cwd);
    // The channel verbs (APRV-23). `channel cli` renders the pending queue over
    // the plugin contract and, with a terminal, collects decisions — through
    // `recordChannelDecision`, which is the same human-only gate `grant` and
    // `reject` call. Its interactive path is asynchronous and assigns its own
    // exit code to `process.exitCode`; see `channel.ts`'s header.
    case "channel":
      return commandChannel(rest, streams, cwd);
    case "status":
      return commandStatus(rest, streams, cwd);
    case "reindex":
      return commandReindex(rest, streams, cwd);
    default:
      return usageError(
        streams,
        wantsJson(argv),
        `unknown command ${JSON.stringify(command)}`,
        ROOT_HELP,
      );
  }
}

// Direct execution: `node dist/src/cli/main.js …` behaves exactly like the
// `approval` bin, which is a thin loader around this module.
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = main(process.argv.slice(2));
}
