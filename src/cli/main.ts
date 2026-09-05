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

// APRV-209. NOTHING that belongs to a single verb is imported here statically.
// Every `command*` function below is reached through `await import()` inside the
// switch, and `core/verify.ts` and `core/reindex.ts` are reached the same way
// from the log verbs that use them. The reason is latency the harness pays on
// every command a session runs: the hook is a PreToolUse gate, so the CLI's
// whole module graph (better-sqlite3 through the reindexer, the channels, the
// MCP SDK) used to be loaded before a `cat README.md` could be answered. What
// stays static is argument parsing, path resolution, help text, styling and the
// exit-code table — the preamble every verb needs before dispatch.
// The three `import type`s are erased by the compiler and load nothing at
// runtime, so the rule above is intact: `log verify --anchor` (APRV-219)
// reaches `checkLogAnchor` through `await import()` like every other verb.
import type { ChainAnomaly } from "../core/verify.js";
import type { EventRecord } from "../core/log.js";
import type { AnchorCheck } from "./log-anchor.js";
import type { CheckpointCheck } from "../core/checkpoint.js";
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
  DEFAULT_INDEX_PATH,
  DEFAULT_LOG_PATH,
  preflightLog,
  resolvePath,
} from "./paths.js";
import { parseLines, readCompleteLines } from "./records.js";
import { helpFor, longHelp } from "./long-help.js";
import {
  refusal as renderRefusal,
  resetStyle,
  style,
  table,
  type Role,
  type Style,
} from "./style.js";
import { usageErrorText } from "./usage.js";
import { wordmark } from "./wordmark.js";

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
  else streams.err(usageErrorText(message, helpText));
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

/** The role an actor wears in `log tail`: a human decided, a robot did not. */
function actorRole(actor: string): Role | undefined {
  if (actor.startsWith("human:")) return "ok";
  if (actor.startsWith("system:")) return "muted";
  return undefined;
}

/**
 * `approval log tail`'s human rendering (APRV-91 #9, APRV-102).
 *
 * TWO SHAPES, DELIBERATELY, and the piped one is unchanged.
 *
 * In a pipe (and under `NO_COLOR`) this is exactly what it always was:
 * tab-separated fields, one record per line. That shape is pinned by
 * `tests/cli.test.ts`, printed in three `examples/*.md` transcripts, and — the
 * reason that matters more than either — it is what `cut -f2` reads. An aligned
 * table is a nicer thing to look at and a worse thing to pipe, because the
 * separator stops being a character and starts being "however many spaces this
 * particular log needed". A log tail is the surface most likely to be on the
 * left of a pipe, so the plain bytes win there.
 *
 * On a terminal, where nothing is parsing the output, the columns are aligned
 * and the brief's roles apply: the seq right-aligned so the digits line up,
 * the event name in `key`, and the actor coloured by kind (human `ok`, agent
 * undressed, system `muted`). Colour is redundant with the actor prefix printed
 * beside it, as everywhere. The TIMESTAMP is left undressed against the brief's
 * `muted`: APRV-102's rule that a copyable value is never painted outranks it,
 * and this is the surface an operator lifts timestamps out of.
 *
 * Both shapes carry the same fields in the same order, so this is a change of
 * spacing and dressing, never of content.
 */
export function renderTailHuman(records: readonly unknown[], st: Style = style()): string {
  if (!st.enabled) return records.map((record) => `${formatRecord(record)}\n`).join("");

  const cellOf = (value: unknown): string =>
    value === undefined || value === null ? "-" : String(value);
  const rows = records.map((record) => {
    const fields = (record ?? {}) as Record<string, unknown>;
    const actor = cellOf(fields["actor"]);
    const role = actorRole(actor);
    return [
      // Not `value`-roled but genuinely undressed: a seq is the thing an
      // operator retypes into `approval audit review`.
      cellOf(fields["seq"]),
      // The brief marks a timestamp `muted`, and APRV-102's later rule — no
      // colour inside a value a human copies — outranks it. A dim timestamp is
      // exactly as unpasteable as a bold one, and this is the surface an
      // operator lifts timestamps out of. The alignment does the separating.
      cellOf(fields["ts"]),
      { text: cellOf(fields["event"]), role: "key" as Role },
      role === undefined ? actor : { text: actor, role },
      cellOf(fields["task"]),
    ];
  });
  return `${table(st, rows, { align: ["right"] })}\n`;
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
    `approval: ${anomalies.length} timestamp anomaly(ies) — the chain verifies and NOTHING is refused; these are reported for a human to weigh\n`,
  );
  for (const anomaly of anomalies) {
    streams.err(`approval: ${anomaly.kind}: ${anomaly.message}\n`);
  }
}

/**
 * The anchor half of `approval log verify` (APRV-219).
 *
 * Runs only behind `--anchor`, and only on a chain that already verified: the
 * committed copy answers a different question from the one the chain walk
 * answers ("does anybody else hold these records?" rather than "is this file
 * self-consistent?"), and asking it about a log that does not verify would be
 * deciding something from an unverified log.
 *
 * A divergence is an integrity refusal and exits where `corrupt` exits. A skip
 * is a skip: a repository with no committed copy has said nothing about this
 * log, and this verb never reports silence as a pass.
 */
function anchorField(outcome: AnchorCheck): Record<string, unknown> {
  if (outcome.status === "skip") return { anchor: { status: "skip", reason: outcome.reason } };
  return {
    anchor: {
      status: outcome.status,
      rev: outcome.anchor.rev,
      seq: outcome.anchor.head.seq,
      hash: outcome.anchor.head.hash,
      bytes: outcome.anchor.byteLength,
      ...(outcome.status === "diverged" ? { message: outcome.message } : {}),
    },
  };
}

/** The anchor line a human reads, after the chain verdict it qualifies. */
function reportAnchor(outcome: AnchorCheck, streams: Streams): void {
  if (outcome.status === "skip") {
    streams.err(`approval: anchor skipped — ${outcome.reason}\n`);
    return;
  }
  if (outcome.status === "diverged") return;
  streams.out(`anchor ${outcome.anchor.rev}: ${outcome.detail}\n`);
}

/**
 * The anchor block on the checkpoint-refusal path, where there may be none.
 *
 * A separate spelling rather than a nullable {@link anchorField}, so the field
 * stays ADDITIVE in the strict sense the frozen `--json` shapes require: a
 * consumer that never asked for `--anchor` sees no `anchor` key, on this path as
 * on every other.
 */
function anchorField2(outcome: AnchorCheck | null): Record<string, unknown> {
  return outcome === null ? {} : anchorField(outcome);
}

/**
 * The checkpoint half of `approval log verify` (APRV-220).
 *
 * The keys come from the policy, which is where the human wrote them, and an
 * unloadable policy is a SKIP naming that rather than a pass: the check has
 * said nothing about this log, and a verb that reported silence as a verified
 * chain would be a verb that stopped verifying.
 */
async function runCheckpointCheck(
  records: EventRecord[],
  cwd: string,
): Promise<CheckpointCheck> {
  const { checkLogCheckpoints, checkpointPolicyOf } = await import("../core/checkpoint.js");
  const configured = checkpointPolicyOf({ dir: cwd });
  return checkLogCheckpoints({
    records,
    publicKeys: configured.publicKeys,
    checkpointEveryMs: configured.checkpointEveryMs,
    keysUnavailable: configured.unloadable,
  });
}

function checkpointField(outcome: CheckpointCheck): Record<string, unknown> {
  if (outcome.status === "skip") {
    return { checkpoints: { status: "skip", reason: outcome.reason } };
  }
  if (outcome.status === "refused") {
    return {
      checkpoints: {
        status: "refused",
        code: outcome.code,
        at: outcome.at,
        verified: outcome.checkpoints.length,
        message: outcome.message,
      },
    };
  }
  const newest = outcome.checkpoints[outcome.checkpoints.length - 1] ?? null;
  return {
    checkpoints: {
      status: "pass",
      verified: outcome.checkpoints.length,
      keys: outcome.keys,
      unchecked: outcome.unchecked,
      newest: newest === null ? null : { at: newest.at, seq: newest.seq, hash: newest.hash },
      ...(outcome.warning === null ? {} : { warning: outcome.warning }),
    },
  };
}

/** The checkpoint line a human reads, after the chain verdict it qualifies. */
function reportCheckpoints(outcome: CheckpointCheck, streams: Streams): void {
  if (outcome.status === "skip") {
    streams.err(`approval: checkpoints skipped — ${outcome.reason}\n`);
    return;
  }
  if (outcome.status === "refused") return;
  streams.out(`checkpoints: ${outcome.detail}\n`);
  if (outcome.warning !== null) streams.err(`approval: ${outcome.warning}\n`);
}

async function commandVerify(argv: string[], streams: Streams, cwd: string): Promise<number> {
  const front = prelude(
    argv,
    {
      "--log": "string",
      "--json": "boolean",
      // APRV-219. `--anchor` is the default resolution (the newest committed
      // copy this checkout can see); `--anchor-rev` names one and implies it.
      // Two flags rather than one optional-value flag, because this CLI's
      // parser has no optional-value form and inventing one to save a word
      // would make every other flag's shape a special case.
      "--anchor": "boolean",
      "--anchor-rev": "string",
      // APRV-220. The second witness, and a separate flag from `--anchor`
      // because they answer different questions and fail in different
      // directions: the anchor asks whether anybody else holds these bytes, a
      // checkpoint asks whether a key no agent holds signed this head. Asking
      // for one has never implied the other, and neither may be weakened to
      // make the other pass.
      "--checkpoints": "boolean",
    },
    VERIFY_HELP,
    streams,
    cwd,
  );
  if (front.kind === "handled") return front.code;
  const { flags, logPath, json } = front;

  const anchorRev = stringFlag(flags, "--anchor-rev");
  const wantsAnchor = boolFlag(flags, "--anchor") || anchorRev !== null;
  const wantsCheckpoints = boolFlag(flags, "--checkpoints");

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  // The policy is consulted for one number, `audit.skew_tolerance` (APRV-58),
  // and it reaches only which anomalies are reported. The verdict below is a
  // function of the log bytes and the schemas, so a missing or unloadable
  // policy leaves this command's answer exactly as it was.
  // `verifyWithRecords` only when the anchor was asked for (APRV-219): the
  // anchor check compares against records the caller has already verified, and
  // a plain run has no use for them.
  const { verify, verifyWithRecords } = await import("../core/verify.js");
  const walked =
    wantsAnchor || wantsCheckpoints
      ? verifyWithRecords(logPath, { policy: { dir: cwd } })
      : { result: verify(logPath, { policy: { dir: cwd } }), records: [] as EventRecord[] };
  const result = walked.result;

  if (result.status === "clean") {
    // Loaded only when asked for (APRV-209): the anchor check pulls in git-scope
    // and the chain reconciler, and a plain `log verify` has no use for either.
    const anchor = wantsAnchor
      ? (await import("./log-anchor.js")).checkLogAnchor({
          logPath,
          records: walked.records,
          ...(anchorRev === null ? {} : { rev: anchorRev }),
        })
      : null;

    // A divergence replaces the clean verdict rather than qualifying it. The
    // chain walk's answer is still true and it is no longer the answer to the
    // question `--anchor` asked, so printing `clean` beside it would be this
    // verb reporting a pass it does not mean.
    if (anchor !== null && anchor.status === "diverged") {
      if (json) {
        emitJson(streams, {
          status: "anchor-diverged",
          records: result.records,
          head: result.head,
          ...anchorField(anchor),
          message: anchor.message,
        });
      } else {
        streams.err(`${renderRefusal(style({ json }), anchor.code, anchor.message)}\n`);
      }
      return EXIT_INTEGRITY;
    }

    // The second witness (APRV-220), run independently of the first and after
    // it. Independently, because a checkpoint refusal and an anchor divergence
    // are different facts with different repairs, and neither may be softened
    // to let the other report a pass; after it, only so that a log failing both
    // reports the older check's message first.
    const checkpoints = wantsCheckpoints
      ? await runCheckpointCheck(walked.records, cwd)
      : null;

    if (checkpoints !== null && checkpoints.status === "refused") {
      if (json) {
        emitJson(streams, {
          status: "checkpoint-invalid",
          records: result.records,
          head: result.head,
          ...anchorField2(anchor),
          ...checkpointField(checkpoints),
          message: checkpoints.message,
        });
      } else {
        streams.err(`${renderRefusal(style({ json }), checkpoints.code, checkpoints.message)}\n`);
      }
      return EXIT_INTEGRITY;
    }

    if (json) {
      emitJson(streams, {
        status: result.status,
        records: result.records,
        head: result.head,
        ...anomalyField(result.anomalies),
        ...(anchor === null ? {} : anchorField(anchor)),
        ...(checkpoints === null ? {} : checkpointField(checkpoints)),
      });
    } else {
      const head =
        result.head === null ? "head none" : `head seq ${result.head.seq} ${result.head.hash}`;
      streams.out(`clean: ${result.records} record(s), ${head}\n`);
      reportAnomalies(streams, result.anomalies);
      if (anchor !== null) reportAnchor(anchor, streams);
      if (checkpoints !== null) reportCheckpoints(checkpoints, streams);
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
    // APRV-102: the shared refusal shape. `corrupt` is the machine-readable word
    // here (it is `status` in `--json`, which is unchanged), and the reason and
    // the seq are the message.
    streams.err(
      `${renderRefusal(style({ json }), "corrupt", `${result.reason} at ${where}`)}\n`,
    );
    streams.err(`approval: ${result.message}\n`);
  }
  return EXIT_INTEGRITY;
}

/**
 * `tail` and `export` share everything but the slice and the rendering, so they
 * share the verify → read → refuse-or-print sequence too.
 */
async function readForOutput(
  logPath: string,
  streams: Streams,
  json: boolean,
): Promise<{ code: number } | { lines: string[]; warning: string | null }> {
  const { verify } = await import("../core/verify.js");
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

async function commandTail(argv: string[], streams: Streams, cwd: string): Promise<number> {
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

  const outcome = await readForOutput(logPath, streams, json);
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
    streams.out(renderTailHuman(parsed.records, style({ json })));
  }
  if (outcome.warning !== null && !json) streams.err(`approval: ${outcome.warning}\n`);
  return EXIT_OK;
}

async function commandExport(argv: string[], streams: Streams, cwd: string): Promise<number> {
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

  const outcome = await readForOutput(logPath, streams, json);
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

async function commandReindex(argv: string[], streams: Streams, cwd: string): Promise<number> {
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

  // The projection is the only thing in this CLI that loads `better-sqlite3`,
  // and it is loaded here rather than at the top of the file so that the verbs
  // that never touch the index never pay for the native addon (APRV-209).
  const { reindex } = await import("../core/reindex.js");
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

async function commandLog(argv: string[], streams: Streams, cwd: string): Promise<number> {
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
    // APRV-125. The two verbs that move the log FILE rather than reading it: a
    // fast-forward pull with a chain reconcile, and the commit-and-push of what
    // the chain has grown since. Neither appends an event.
    case "sync": {
      const { commandLogSync } = await import("./log-verbs.js");
      return commandLogSync(rest, streams, cwd);
    }
    case "advance": {
      const { commandLogAdvance } = await import("./log-verbs.js");
      return commandLogAdvance(rest, streams, cwd);
    }
    // APRV-220. The one verb here that APPENDS: a human signing the current
    // head with a key no agent process holds. Loaded lazily like the two above,
    // because it reaches the vault and the signing primitives and a plain
    // `approval log tail` has no use for either.
    case "checkpoint": {
      const { commandLogCheckpoint } = await import("./log-checkpoint.js");
      return commandLogCheckpoint(rest, streams, cwd);
    }
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
 * The part of a command line that belongs to `approval` itself.
 *
 * `approval run … -- git push` and `hook classify -- <command…>` hand the tail
 * to a child, and a `--no-color` in THAT half is the child's business. Reading
 * presentation flags only from the near side is what keeps this CLI from
 * quietly editing the command it was asked to run.
 */
function beforeSeparator(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  return separator === -1 ? [...argv] : argv.slice(0, separator);
}

/** Remove `--no-color`, near side only, so no verb needs it in its flag spec. */
function stripNoColor(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  const near = (separator === -1 ? argv : argv.slice(0, separator)).filter(
    (word) => word !== "--no-color",
  );
  return separator === -1 ? near : [...near, ...argv.slice(separator)];
}

/** The five verbs a new operator needs, under the wordmark, and nothing else. */
function splash(theme: ReturnType<typeof style>): string {
  const rows = [
    { left: "init", right: "scaffold APPROVAL.md and .approval/ here" },
    { left: "setup", right: "declare who you are and store credentials" },
    { left: "doctor", right: "can this machine run the system?" },
    { left: "queue", right: "what is waiting for your decision" },
    { left: "--help", right: "every verb, and the exit codes" },
  ];
  return `${wordmark(theme)}\n\n${theme.table(rows, { indent: 2, gap: 3 })}`;
}

/**
 * The help text `--long` was asked for, or null when it was not asked for.
 *
 * `--long` means nothing on its own: it is a modifier on a help request, so it
 * is honoured only alongside `--help`/`-h` or the `help` verb. Anywhere else it
 * falls through to the verb, which will call it an unknown flag, which is the
 * right answer.
 */
function longHelpRequest(argv: readonly string[]): string | null {
  const near = beforeSeparator(argv);
  if (!near.includes("--long")) return null;
  const asking =
    near[0] === "help" || near.includes("--help") || near.includes("-h");
  if (!asking) return null;
  const words = (near[0] === "help" ? near.slice(1) : near).filter(
    (word) => !word.startsWith("-"),
  );
  return (words.length === 0 ? null : helpFor(words)) ?? ROOT_HELP;
}

/**
 * Await a verb that may answer asynchronously, and return its code.
 *
 * Before APRV-209 the arms that call this could not return the code at all:
 * `main()` was synchronous, so an asynchronous verb's promise was dropped into
 * `process.exitCode` and the arm returned {@link EXIT_OK}. Awaiting is now
 * possible, and it also closes a hole the drop had opened: the entry point's own
 * assignment to `process.exitCode` could land after the dropped promise's and
 * overwrite a usage error with a zero.
 *
 * `label` is the phrase that named the verb in the old rejection message
 * ("doctor failed", "MCP server failed"), so those messages are unchanged.
 */
async function settle(
  outcome: number | Promise<number>,
  streams: Streams,
  label: string,
): Promise<number> {
  try {
    return await outcome;
  } catch (cause: unknown) {
    streams.err(
      `approval: ${label}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return EXIT_IO;
  }
}

/**
 * Run the CLI. Resolves to the process exit code rather than calling
 * `process.exit`, so buffered stdout is flushed by the normal exit path — a
 * truncated JSON object would be worse than no output at all.
 *
 * ASYNCHRONOUS since APRV-209, and for one reason: every verb is loaded by
 * `await import()` inside the switch below, and ESM has no synchronous dynamic
 * import. The awaits do not make any verb concurrent — exactly one runs per
 * invocation, the preamble still decides presentation once before any of them
 * can print, and the long-lived verbs (`channel`, `daemon`, `up`, `mcp`) report
 * their eventual code through `process.exitCode` exactly as they did.
 */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const streams = options.streams ?? defaultStreams();
  const cwd = options.cwd ?? process.cwd();

  // Presentation is decided ONCE per invocation, before any verb can print
  // (APRV-91). `--no-color` is answered here and stripped, so no verb has to
  // carry it in its flag spec and none can disagree about it; `--json` is a
  // veto on colour, which is why it is read before the verb parses anything.
  const argvForStyle = beforeSeparator(argv);
  const noColor = argvForStyle.includes("--no-color");
  resetStyle();
  const theme = style({ json: wantsJson(argvForStyle), noColor });
  const cleanArgv = noColor ? stripNoColor(argv) : argv;

  const command = cleanArgv[0];
  const rest = cleanArgv.slice(1);

  // `--help --long` and `approval help <verb> --long` (APRV-91 #16): the short
  // help verbatim, then the reference section its `why:` footer points at.
  // Intercepted HERE rather than in each verb, because the alternative is the
  // same three lines in sixty places and one of them getting it wrong.
  const longRequest = longHelpRequest(cleanArgv);
  if (longRequest !== null) {
    streams.out(`${longHelp(longRequest, { style: theme })}\n`);
    return EXIT_OK;
  }

  if (command === undefined) {
    // The orientation screen (APRV-91 #7/#12). It goes to STDOUT while the
    // refusal stays on stderr with today's exit 2: a bare invocation is still a
    // usage error for anything scripting this CLI, and the human staring at a
    // terminal still gets the wordmark and the five verbs they need.
    streams.out(`${splash(theme)}\n`);
    return usageError(streams, false, "no command given", ROOT_HELP);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    // `approval help <verb>` is the third spelling of `approval <verb> --help`,
    // and the one a person guesses first.
    const words = rest.filter((word) => !word.startsWith("-"));
    const target = words.length === 0 ? null : helpFor(words);
    if (target !== null) {
      streams.out(`${target}\n`);
      return EXIT_OK;
    }
    streams.out(`${wordmark(theme)}\n\n${ROOT_HELP}\n`);
    return EXIT_OK;
  }

  switch (command) {
    // The self-describing verb (APRV-85). `instructions` prints the agent-facing
    // guide, and `--schemas` prints the verb registry the guide's table is
    // generated from — the one source SPEC.md §10.5's MCP wrapper derives its
    // tool descriptions and input schemas from, so the two surfaces cannot
    // drift. It reads no log, resolves no policy, and writes nothing.
    case "instructions": {
      const { commandInstructions } = await import("./instructions.js");
      return commandInstructions(rest, streams, cwd);
    }
    // The scaffolding verb (APRV-71). It is the only command that writes files
    // a human has not asked for by name, and it is deliberately the least
    // authoritative one in the CLI: it appends nothing, attests nothing, and
    // overwrites nothing. Everything it creates is inert until a human attests.
    case "init": {
      const { commandInit } = await import("./init.js");
      return commandInit(rest, streams, cwd);
    }
    case "log":
      return commandLog(rest, streams, cwd);
    case "policy": {
      const { commandPolicy } = await import("./policy.js");
      return commandPolicy(rest, streams, cwd);
    }
    // The gate verbs (APRV-16). grant/reject/revoke are human-only and expire
    // is the system verb; the enforcement lives in core, not in this dispatch.
    case "register": {
      const { commandRegister } = await import("./gate.js");
      return commandRegister(rest, streams, cwd);
    }
    case "request": {
      const { commandRequest } = await import("./gate.js");
      return commandRequest(rest, streams, cwd);
    }
    case "grant":
    case "reject":
    case "revoke": {
      const { commandDecide } = await import("./gate.js");
      return commandDecide(command, rest, streams, cwd);
    }
    // APRV-106. The one terminal gate verb that is NOT human-only: withdrawal
    // is the requester retracting its own question, and the requester is
    // usually an agent. The gate checks the actor against the request record,
    // so the verb cannot be used to clear anyone else's queue.
    case "withdraw": {
      const { commandWithdraw } = await import("./gate.js");
      return commandWithdraw(rest, streams, cwd);
    }
    case "expire": {
      const { commandExpire } = await import("./gate.js");
      return commandExpire(rest, streams, cwd);
    }
    // The token verbs (APRV-17). `token` reports status and writes nothing;
    // `consume` is internal plumbing for APRV-18's `approval run` and is the
    // only sanctioned appender of execution.started on the manual path.
    case "token": {
      const { commandToken } = await import("./token.js");
      return commandToken(rest, streams, cwd);
    }
    case "consume": {
      const { commandConsume } = await import("./token.js");
      return commandConsume(rest, streams, cwd);
    }
    // The execution verbs (APRV-18). `run` is the only command that spawns
    // anything and the only one that can exit 5; `wait` the only one that can
    // exit 6. `queue` is the pending-decision inbox and `status` is system
    // health — deliberately two verbs, because they answer to two different
    // people (the human who decides, the operator who repairs).
    case "run": {
      const { commandRun } = await import("./execute.js");
      return commandRun(rest, streams, cwd);
    }
    // The recovery verb (APRV-20 pass two). `execution resolve` is the only
    // sanctioned way to close a dangling execution, and it is human-only,
    // note-mandatory, and records no invented exit code.
    case "execution": {
      const { commandExecution } = await import("./execute.js");
      return commandExecution(rest, streams, cwd);
    }
    // The audit verbs (APRV-40). `audit list` reads the sampled-audit backlog
    // and `audit review` closes one item of it, human-only. There is no
    // `audit sample`: selection is the runtime's, made by the daemon from an
    // operator-held secret, and a caller who could sample could decline to.
    case "audit": {
      const { commandAudit } = await import("./audit.js");
      return commandAudit(rest, streams, cwd);
    }
    case "wait": {
      const { commandWait } = await import("./execute.js");
      return commandWait(rest, streams, cwd);
    }
    case "queue": {
      const { commandQueue } = await import("./execute.js");
      return commandQueue(rest, streams, cwd);
    }
    // The open window (APRV-214, amended SPEC.md §5.2). `gate open` is the one
    // verb that SUSPENDS the policy for the harness hook, so it is human-only
    // three times over: it classifies `policy.core` (which APPROVAL.md holds
    // human-only, so the hook denies an agent running it), it refuses a stdin
    // that is not a terminal, and it reads the word `understood` with no --yes
    // and no --force. `gate close` only tightens and `gate status` decides
    // nothing. The window's whole state is in the log; no file holds it.
    case "gate": {
      const { commandGate } = await import("./gate-window.js");
      return commandGate(rest, streams, cwd);
    }
    case "status": {
      const { commandStatus } = await import("./execute.js");
      return commandStatus(rest, streams, cwd);
    }
    // The diagnostic verb (APRV-31). `doctor` answers for the MACHINE what
    // `status` answers for the system, and it is asynchronous for the same
    // reason `channel` is: two of its checks touch the network stack (a Bot API
    // `getMe`, a loopback bind probe). It writes nothing anywhere.
    case "doctor": {
      const { commandDoctor } = await import("./doctor.js");
      return settle(commandDoctor(rest, streams, cwd), streams, "doctor failed");
    }
    // The channel verbs (APRV-23 cli, APRV-26 telegram). `channel cli` renders
    // the pending queue over the plugin contract and, with a terminal, collects
    // decisions through `recordChannelDecision` — the same human-only gate
    // `grant` and `reject` call. `channel telegram listen` is the first of the
    // LONG-LIVED commands in this CLI: it delivers the pending queue and then
    // long-polls until it is interrupted. `main` awaits it since APRV-209, so
    // the promise stays pending for as long as the listener runs and its code
    // is returned rather than dropped into `process.exitCode`.
    case "channel": {
      const { commandChannel } = await import("./channel.js");
      return settle(commandChannel(rest, streams, cwd), streams, "channel listener failed");
    }
    // The daemon verb (APRV-39). `daemon run` is the second LONG-LIVED command
    // in this CLI and is handled exactly like `channel`. It is the only command
    // that both watches and appends, and the only one whose ordinary ending is a
    // signal (which is exit 0, not a failure).
    case "daemon": {
      const { commandDaemon } = await import("./daemon.js");
      return settle(commandDaemon(rest, streams, cwd), streams, "daemon failed");
    }
    // The ambient runtime (APRV-110). `approval up` is the daemon loop and every
    // channel the policy configures in ONE supervised process, and it is the
    // fourth LONG-LIVED command here, awaited exactly as `channel` and `daemon`
    // are. `daemon run --with-channels` reaches the same function.
    case "up": {
      const { commandUp } = await import("./up.js");
      return settle(commandUp(rest, streams, cwd), streams, "the ambient runtime failed");
    }
    // The binding verb (APRV-29). `payload hash` prints the payload_hash of a
    // JSON document through the same core function the gate uses, so nobody has
    // to import an internal module (or reinvent JCS) to fill in a declaration.
    // It reads no log and writes nothing.
    // `payload agentmail-draft` (APRV-223) reads one draft over HTTPS, so this
    // verb joins the asynchronous family and is awaited the same way; the
    // `hash` path is still synchronous, and awaiting a number is a number.
    case "payload": {
      const { commandPayload } = await import("./payload.js");
      return settle(commandPayload(rest, streams, cwd), streams, "payload failed");
    }
    // The ungated channel (APRV-195). `journal write` is the one verb in this
    // switch that reaches no policy, no log and no token: it appends free text
    // to a local file so that an agent complying perfectly can still say it
    // thinks something is wrong. Nothing in the runtime reads what it writes,
    // which is what makes leaving it ungated safe (SPEC.md §11.1 invariant 4).
    case "journal": {
      const { commandJournal } = await import("./journal.js");
      return commandJournal(rest, streams, cwd);
    }
    // The human's half of the same pair (APRV-238). `values` prints the
    // optional values block of APPROVAL.md — what the operator values, wants
    // and how they answer — and it is guidance rather than policy: it grants
    // nothing, and no path that computes a verdict, a class, a sample, a budget
    // or a token reads it (SPEC.md §11.1 invariant 10). It resolves no policy
    // rule, reads no log and appends nothing.
    case "values": {
      const { commandValues } = await import("./values.js");
      return commandValues(rest, streams, cwd);
    }
    // The other direction of the same channel (APRV-239). `journal read` is the
    // operator reading what the agents said; this is the agents reading what the
    // operator said about their work. It reads a verified log and writes
    // nothing, and every output form labels what it prints as human-authored
    // GUIDANCE: no enforcement path anywhere in this dispatch reads a reaction
    // (SPEC.md §11.1 invariant 10), so a surface that let one read as a rule
    // would be the only place the invariant could break.
    case "feedback": {
      const { commandFeedback } = await import("./feedback.js");
      return commandFeedback(rest, streams, cwd);
    }
    // The environment verb (APRV-73). `env` resolves `.approval/env` — the
    // source map naming where each *_env variable's value lives — and prints an
    // export block for a shell to evaluate. IT IS THE ONLY COMMAND IN THIS
    // SWITCH THAT READS THAT FILE, and no command in this switch loads it into
    // its own environment: human identity is one of the variables it can carry,
    // so a file a process read on its own would let anything able to write it
    // act as the human on every human-only verb (SPEC.md §11.1 invariant 7).
    case "env": {
      const { commandEnv } = await import("./env.js");
      return commandEnv(rest, streams, cwd);
    }
    // The configuration verb (APRV-74) and the only WRITER of .approval/env.
    // It is interactive by construction: every subcommand refuses a
    // non-terminal stdin and --json, because a setup a pipe could drive would
    // be a way for a CI job or an agent to declare a human identity and store
    // a credential. It appends nothing to the log, attests nothing, and edits
    // no policy file. `setup channel telegram` reaches the network, so the dispatch
    // unwraps a promise exactly as `channel`, `daemon` and `adapter` do.
    case "setup": {
      const { commandSetup } = await import("./setup.js");
      return settle(commandSetup(rest, streams, cwd), streams, "setup failed");
    }
    // The credential verbs (APRV-68). `vault set|list|remove` manage the
    // encrypted store adapters read from, and all three are human-only. There
    // is deliberately no `vault get`: a credential's only sanctioned journey is
    // from the vault into an adapter inside the verified-token window, and a
    // verb that printed one would put it in a terminal and a shell history.
    // Nothing under this verb appends to the log.
    case "vault": {
      const { commandVault } = await import("./vault.js");
      return commandVault(rest, streams, cwd);
    }
    // The side-effect verb (APRV-69). `adapter email` is the first thing in
    // this CLI that reaches the world: it executes one granted action through
    // the adapter contract, which spends the token and writes both execution
    // events around the send. It is asynchronous for the obvious reason (a
    // socket), and is unwrapped exactly as `channel` and `daemon` are.
    case "adapter": {
      const { commandAdapter } = await import("./adapter.js");
      return settle(commandAdapter(rest, streams, cwd), streams, "adapter failed");
    }
    // The harness verbs (APRV-82, APRV-133). `hook claude-code` and
    // `hook cursor` each read a pre-tool event on STDIN and answer allow or
    // deny, so a command the harness runs itself cannot skip the gate the way
    // `approval run` cannot. They are the commands whose stdout is a decision
    // object for another program rather than a report for a human, and whose
    // exit code is deliberately 0 on a refusal: the harness reads a hook's
    // verdict only on exit 0.
    case "hook": {
      // The latency-critical case (APRV-209): a session pays this load on every
      // command it runs, so `hook.ts` and its core dependencies are the only
      // verb graph a pass-through invocation brings in.
      const { commandHook } = await import("./hook.js");
      return commandHook(rest, streams, cwd);
    }
    // The interoperability verb (APRV-64). `import agents-md` reads permissions
    // PROSE and prints a draft policy block. It is the only verb whose output is
    // a proposal: it writes no policy, appends nothing, and attests nothing —
    // the human's `policy amend` is what puts any of it in force.
    case "import": {
      const { commandImport } = await import("./import.js");
      return commandImport(rest, streams, cwd);
    }
    // The wrapper verb (APRV-87). `mcp serve` publishes the agent-facing verbs
    // as MCP tools over stdio (SPEC.md §10.5) and is the third LONG-LIVED
    // command here, unwrapped exactly as `channel` and `daemon` are. It is
    // AGENT-FACING BY CONSTRUCTION: its tool list is the verb registry filtered
    // by human_only, so nothing that records a human's authority is reachable
    // through it, and the identity it runs as is fixed before the transport
    // exists. The verb itself is human-only, because starting one is an
    // operator's act.
    case "mcp": {
      const { commandMcp } = await import("./mcp.js");
      return settle(commandMcp(rest, streams, cwd), streams, "MCP server failed");
    }
    case "reindex":
      return commandReindex(rest, streams, cwd);
    // The projection verb (APRV-24). `render` writes .approval/QUEUE.md and
    // nothing else; the projection itself is `channels/render-queue.ts`.
    case "render": {
      const { commandRender } = await import("./render.js");
      return commandRender(rest, streams, cwd);
    }
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
  // `main` resolves rather than returns since APRV-209; the code still reaches
  // the process through `process.exitCode`, so stdout is flushed by the normal
  // exit path. The rejection is DELIBERATELY not caught: a throw out of the
  // dispatch used to be an uncaught exception (stack trace, exit 1) and it stays
  // one, rather than being dressed up as one of the frozen exit codes.
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
