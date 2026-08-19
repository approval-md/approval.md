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
import { verify, type ChainAnomaly } from "../core/verify.js";
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
import { commandAudit } from "./audit.js";
import { commandChannel } from "./channel.js";
import { commandDaemon } from "./daemon.js";
import { commandDoctor } from "./doctor.js";
import { commandEnv } from "./env.js";
import { commandHook } from "./hook.js";
import { commandImport } from "./import.js";
import { commandInstructions } from "./instructions.js";
import { commandInit } from "./init.js";
import { commandMcp } from "./mcp.js";
import { commandPayload } from "./payload.js";
import { commandPolicy } from "./policy.js";
import { commandRender } from "./render.js";
import { commandConsume, commandToken } from "./token.js";
import { commandAdapter } from "./adapter.js";
import { commandSetup } from "./setup.js";
import { commandVault } from "./vault.js";
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

/**
 * The `anomalies` field, present only when there is something to report.
 *
 * ADDITIVE, in the strict sense the frozen `--json` shapes require: a consumer
 * written against the pre-APRV-40 shape sees byte-identical output for every log
 * that has no anomaly, and the key appears only when the runtime has something
 * new to say. Omitting the empty case is deliberate rather than lazy — an
 * always-present empty array would change the shape of every existing clean
 * result, and those shapes are what agents parse.
 */
function anomalyField(anomalies: ChainAnomaly[]): Record<string, unknown> {
  return anomalies.length === 0 ? {} : { anomalies };
}

/**
 * Print anomalies to stderr, one line each.
 *
 * stderr rather than stdout, and after the verdict rather than instead of it:
 * the verdict is the answer to the question asked (does this chain verify?), and
 * an anomaly is a note in the margin. The exit code does not move. A clean log
 * with anomalies exits 0, because the chain verifies and skew is a judgment for
 * a human, not a proof the runtime is entitled to enforce.
 */
function reportAnomalies(streams: Streams, anomalies: ChainAnomaly[]): void {
  if (anomalies.length === 0) return;
  streams.err(
    `approval: ${anomalies.length} timestamp anomaly(ies) — the chain verifies and NOTHING is refused; these are reported for a human to weigh (SPEC.md §8)\n`,
  );
  for (const anomaly of anomalies) {
    streams.err(`approval: ${anomaly.kind}: ${anomaly.message}\n`);
  }
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
    if (json) {
      emitJson(streams, {
        status: result.status,
        records: result.records,
        head: result.head,
        ...anomalyField(result.anomalies),
      });
    } else {
      const head =
        result.head === null ? "head none" : `head seq ${result.head.seq} ${result.head.hash}`;
      streams.out(`clean: ${result.records} record(s), ${head}\n`);
      reportAnomalies(streams, result.anomalies);
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
        ...anomalyField(result.anomalies),
      });
    } else {
      reportAnomalies(streams, result.anomalies);
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
    // The self-describing verb (APRV-85). `instructions` prints the agent-facing
    // guide, and `--schemas` prints the verb registry the guide's table is
    // generated from — the one source SPEC.md §10.5's MCP wrapper derives its
    // tool descriptions and input schemas from, so the two surfaces cannot
    // drift. It reads no log, resolves no policy, and writes nothing.
    case "instructions":
      return commandInstructions(rest, streams, cwd);
    // The scaffolding verb (APRV-71). It is the only command that writes files
    // a human has not asked for by name, and it is deliberately the least
    // authoritative one in the CLI: it appends nothing, attests nothing, and
    // overwrites nothing. Everything it creates is inert until a human attests.
    case "init":
      return commandInit(rest, streams, cwd);
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
    // The audit verbs (APRV-40). `audit list` reads the sampled-audit backlog
    // and `audit review` closes one item of it, human-only. There is no
    // `audit sample`: selection is the runtime's, made by the daemon from an
    // operator-held secret, and a caller who could sample could decline to.
    case "audit":
      return commandAudit(rest, streams, cwd);
    case "wait":
      return commandWait(rest, streams, cwd);
    case "queue":
      return commandQueue(rest, streams, cwd);
    case "status":
      return commandStatus(rest, streams, cwd);
    // The diagnostic verb (APRV-31). `doctor` answers for the MACHINE what
    // `status` answers for the system, and it is asynchronous for the same
    // reason `channel` is: two of its checks touch the network stack (a Bot API
    // `getMe`, a loopback bind probe). It writes nothing anywhere.
    case "doctor": {
      const outcome = commandDoctor(rest, streams, cwd);
      if (typeof outcome === "number") return outcome;
      void outcome.then(
        (code) => {
          process.exitCode = code;
        },
        (cause: unknown) => {
          streams.err(
            `approval: doctor failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = EXIT_IO;
        },
      );
      return EXIT_OK;
    }
    // The channel verbs (APRV-23 cli, APRV-26 telegram). `channel cli` renders
    // the pending queue over the plugin contract and, with a terminal, collects
    // decisions through `recordChannelDecision` — the same human-only gate
    // `grant` and `reject` call. `channel telegram listen` is the only
    // LONG-LIVED command in this CLI: it delivers the pending queue and then
    // long-polls until it is interrupted. Every other command answers and
    // exits, so `main` stays synchronous and this one case unwraps a promise —
    // reporting its eventual code through `process.exitCode`, which is what
    // the direct-execution path at the bottom of this file uses anyway.
    // Callers that need the code (tests, embedders) call `commandChannel` and
    // await it directly.
    case "channel": {
      const outcome = commandChannel(rest, streams, cwd);
      if (typeof outcome === "number") return outcome;
      void outcome.then(
        (code) => {
          process.exitCode = code;
        },
        (cause: unknown) => {
          streams.err(
            `approval: channel listener failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = EXIT_IO;
        },
      );
      return EXIT_OK;
    }
    // The daemon verb (APRV-39). `daemon run` is the second LONG-LIVED command
    // in this CLI and is handled exactly like `channel`: it returns a promise,
    // and its eventual code reaches the process through `process.exitCode`. It
    // is the only command that both watches and appends, and the only one whose
    // ordinary ending is a signal (which is exit 0, not a failure).
    case "daemon": {
      const outcome = commandDaemon(rest, streams, cwd);
      if (typeof outcome === "number") return outcome;
      void outcome.then(
        (code) => {
          process.exitCode = code;
        },
        (cause: unknown) => {
          streams.err(
            `approval: daemon failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = EXIT_IO;
        },
      );
      return EXIT_OK;
    }
    // The binding verb (APRV-29). `payload hash` prints the payload_hash of a
    // JSON document through the same core function the gate uses, so nobody has
    // to import an internal module (or reinvent JCS) to fill in a declaration.
    // It reads no log and writes nothing.
    case "payload":
      return commandPayload(rest, streams, cwd);
    // The environment verb (APRV-73). `env` resolves `.approval/env` — the
    // source map naming where each *_env variable's value lives — and prints an
    // export block for a shell to evaluate. IT IS THE ONLY COMMAND IN THIS
    // SWITCH THAT READS THAT FILE, and no command in this switch loads it into
    // its own environment: human identity is one of the variables it can carry,
    // so a file a process read on its own would let anything able to write it
    // act as the human on every human-only verb (SPEC.md §11.1 invariant 7).
    case "env":
      return commandEnv(rest, streams, cwd);
    // The configuration verb (APRV-74) and the only WRITER of .approval/env.
    // It is interactive by construction: every subcommand refuses a
    // non-terminal stdin and --json, because a setup a pipe could drive would
    // be a way for a CI job or an agent to declare a human identity and store
    // a credential. It appends nothing to the log, attests nothing, and edits
    // no policy file. `setup channel telegram` reaches the network, so the dispatch
    // unwraps a promise exactly as `channel`, `daemon` and `adapter` do.
    case "setup": {
      const outcome = commandSetup(rest, streams, cwd);
      if (typeof outcome === "number") return outcome;
      void outcome.then(
        (code) => {
          process.exitCode = code;
        },
        (cause: unknown) => {
          streams.err(
            `approval: setup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = EXIT_IO;
        },
      );
      return EXIT_OK;
    }
    // The credential verbs (APRV-68). `vault set|list|remove` manage the
    // encrypted store adapters read from, and all three are human-only. There
    // is deliberately no `vault get`: a credential's only sanctioned journey is
    // from the vault into an adapter inside the verified-token window, and a
    // verb that printed one would put it in a terminal and a shell history.
    // Nothing under this verb appends to the log.
    case "vault":
      return commandVault(rest, streams, cwd);
    // The side-effect verb (APRV-69). `adapter email` is the first thing in
    // this CLI that reaches the world: it executes one granted action through
    // the adapter contract, which spends the token and writes both execution
    // events around the send. It is asynchronous for the obvious reason (a
    // socket), and is unwrapped exactly as `channel` and `daemon` are.
    case "adapter": {
      const outcome = commandAdapter(rest, streams, cwd);
      void outcome.then(
        (code) => {
          process.exitCode = code;
        },
        (cause: unknown) => {
          streams.err(
            `approval: adapter failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = EXIT_IO;
        },
      );
      return EXIT_OK;
    }
    // The harness verb (APRV-82). `hook claude-code` reads a PreToolUse event
    // on STDIN and answers allow or deny, so a command the harness runs itself
    // cannot skip the gate the way `approval run` cannot. It is the one command
    // whose stdout is a decision object for another program rather than a
    // report for a human, and the one whose exit code is deliberately 0 on a
    // refusal: the harness reads a hook's verdict only on exit 0.
    case "hook":
      return commandHook(rest, streams, cwd);
    // The interoperability verb (APRV-64). `import agents-md` reads permissions
    // PROSE and prints a draft policy block. It is the only verb whose output is
    // a proposal: it writes no policy, appends nothing, and attests nothing —
    // the human's `policy amend` is what puts any of it in force.
    case "import":
      return commandImport(rest, streams, cwd);
    // The wrapper verb (APRV-87). `mcp serve` publishes the agent-facing verbs
    // as MCP tools over stdio (SPEC.md §10.5) and is the third LONG-LIVED
    // command here, unwrapped exactly as `channel` and `daemon` are. It is
    // AGENT-FACING BY CONSTRUCTION: its tool list is the verb registry filtered
    // by human_only, so nothing that records a human's authority is reachable
    // through it, and the identity it runs as is fixed before the transport
    // exists. The verb itself is human-only, because starting one is an
    // operator's act.
    case "mcp": {
      const outcome = commandMcp(rest, streams, cwd);
      if (typeof outcome === "number") return outcome;
      void outcome.then(
        (code) => {
          process.exitCode = code;
        },
        (cause: unknown) => {
          streams.err(
            `approval: MCP server failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exitCode = EXIT_IO;
        },
      );
      return EXIT_OK;
    }
    case "reindex":
      return commandReindex(rest, streams, cwd);
    // The projection verb (APRV-24). `render` writes .approval/QUEUE.md and
    // nothing else; the projection itself is `channels/render-queue.ts`.
    case "render":
      return commandRender(rest, streams, cwd);
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
