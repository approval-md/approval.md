/**
 * `approval gate open|close|status` — the open window's CLI (APRV-214, amended
 * SPEC.md §5.2).
 *
 * As everywhere else in this CLI, no logic lives here. Deriving the window,
 * checking the actor, the cap and the window state, and every append are
 * `core/gate-window.ts`; this file resolves paths and identity, runs the
 * ceremony, chooses an exit code, and formats output.
 *
 * ## The ceremony, and why it is shaped like this
 *
 * `open` suspends the harness gate's policy for every tool call under the root.
 * Three locks stand between an agent and that, and they are independent:
 *
 *  1. **The class.** `approval gate open` classifies `policy.core`
 *     (`core/command-class.ts`), which APPROVAL.md holds human-only, so the
 *     harness hook denies the command before it ever runs.
 *  2. **The terminal.** `createPrompter` returns `null` unless `process.stdin`
 *     is a TTY, and a harness shell tool has no TTY. `--json` refuses for the
 *     same reason: a machine-readable answer implies a machine asking.
 *  3. **The word.** One line is read and only exactly `understood` proceeds.
 *     There is deliberately NO `--yes` and no `--force`: a flag that answers
 *     the question is a way for something that cannot type to type.
 *
 * `close` has none of it beyond the human actor, because closing only ever
 * tightens, and a ceremony guarding the safe direction is one people learn to
 * type past. `status` decides nothing and writes nothing.
 */

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import {
  closeWindow,
  DEFAULT_WINDOW,
  MAX_WINDOW_MS,
  openGateWindow,
  openWindow,
  remainingMs,
  type GateWindowRefusal,
  type OpenWindow,
} from "../core/gate-window.js";
import { parseDuration } from "../core/policy-load.js";
import { readVerifiedRecords } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { GATE_WINDOW_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { createPrompter, type Prompter } from "./prompt.js";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

/** The one answer that opens a window. Trimmed, never case-folded. */
const CONFIRMATION = "understood";

const FLAGS: Record<string, FlagKind> = {
  "--for": "string",
  "--reason": "string",
  "--note": "string",
  "--as": "string",
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * Injected seams. `prompter` is the terminal, exactly as `commandSetup`'s is:
 * a test passes a scripted one and asserts on what was asked as well as on what
 * was done, and passing `null` is how "there is no terminal" becomes a test
 * rather than a claim.
 */
export interface GateWindowDeps {
  prompter?: Prompter | null;
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, GATE_WINDOW_HELP));
  return EXIT_USAGE;
}

/**
 * Map a refusal onto the frozen exit table.
 *
 * Everything this verb DECIDED is {@link EXIT_INTEGRITY} — the command was
 * well-formed, the runtime understood it, and the answer is no. Only facts
 * about the filesystem are {@link EXIT_IO}, and only a crashed write is
 * {@link EXIT_TORN_TAIL}: the same split every other verb draws.
 */
function refusalExitCode(refusal: GateWindowRefusal): number {
  switch (refusal.code) {
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    case "append-failed":
      switch (refusal.append?.code) {
        case "corrupt-tail":
          return EXIT_TORN_TAIL;
        case "io":
        case "lock-timeout":
          return EXIT_IO;
        default:
          return EXIT_INTEGRITY;
      }
    default:
      return EXIT_INTEGRITY;
  }
}

function emitRefusal(streams: Streams, json: boolean, refusal: GateWindowRefusal): number {
  if (json) {
    const error: Record<string, unknown> = { code: refusal.code, message: refusal.message };
    if (refusal.append !== undefined) error["append"] = refusal.append.code;
    streams.err(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    streams.err(`${renderRefusal(style({ json }), refusal.code, refusal.message)}\n`);
  }
  return refusalExitCode(refusal);
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/** A refusal built here rather than in core, in core's own shape. */
function refuse(code: GateWindowRefusal["code"], message: string): GateWindowRefusal {
  return { ok: false, code, message };
}

/** How a window is reported, in text and in `--json`, from one place. */
function windowJson(window: OpenWindow, now: number): Record<string, unknown> {
  return {
    seq: window.seq,
    opened_at: window.openedAt,
    opened_by: window.openedBy,
    reason: window.reason,
    expires_at: window.expiresAt,
    remaining_ms: remainingMs(window, now),
    bypassed: window.bypassCount,
    scope: "hook",
  };
}

/** `1h 05m`, `4m 12s`: enough for a person to decide whether to close it. */
function humanRemaining(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// The statement a person reads before typing
// ---------------------------------------------------------------------------

/**
 * What is about to happen, in plain sentences, before one word is read.
 *
 * It states the consequences AND the limits, because a person who believes the
 * window is narrower than it is will open one carelessly, and a person who
 * believes it is wider than it is will hand-edit the hook out of the harness
 * instead — which is the ungated, unrecorded session this whole verb exists to
 * replace.
 */
function statement(
  root: string,
  durationText: string,
  expiresAt: string,
  reason: string,
  actor: string,
): string {
  return [
    "approval gate open — a human-only ceremony (SPEC.md §5.2, \"The open window\")",
    "",
    `You are about to open the harness gate in ${root} for ${durationText}, until ${expiresAt}.`,
    "Until it closes:",
    "  - every hook-gated shell command and file edit an agent makes under that root is",
    "    ALLOWED without approval, whatever APPROVAL.md says about it;",
    "  - each one appends a `gate.bypassed` record (tool, classes, summary);",
    "  - nothing is charged to a budget and nothing enters the retrospective sample;",
    "  - `approval status` reports UNHEALTHY while the window is open;",
    "  - what STAYS denied: writes aimed at .approval/log/ (`log.mutate`), every",
    "    `human-only` class, and any command the classifier cannot read;",
    "  - a log the hook cannot read or verify still denies.",
    "",
    `  reason:    ${reason}`,
    `  opened by: ${actor}`,
    "",
    "Close it early with `approval gate close`. It lapses at the time above; nothing",
    "is appended then.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// approval gate
// ---------------------------------------------------------------------------

export function commandGate(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: GateWindowDeps = {},
): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${GATE_WINDOW_HELP}\n`);
    return EXIT_OK;
  }

  const sub = parsed.positionals[0];
  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand: open, close or status");
  }
  const extra = parsed.positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }
  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);

  switch (sub) {
    case "open":
      return gateOpen(parsed.flags, streams, cwd, logPath, json, deps);
    case "close":
      return gateClose(parsed.flags, streams, logPath, json);
    case "status":
      return gateStatus(streams, logPath, json);
    default:
      return usageError(
        streams,
        json,
        `unknown subcommand ${JSON.stringify(sub)}: expected open, close or status`,
      );
  }
}

function gateOpen(
  flags: Record<string, string | boolean>,
  streams: Streams,
  cwd: string,
  logPath: string,
  json: boolean,
  deps: GateWindowDeps,
): number {
  // 1. Usage first, so a typo costs nothing and reaches no ceremony.
  const durationText = stringFlag(flags, "--for") ?? DEFAULT_WINDOW;
  const durationMs = parseDuration(durationText);
  if (durationMs === null) {
    return usageError(
      streams,
      json,
      `--for expects a duration like 5m, 30m, 2h, got ${JSON.stringify(durationText)}`,
    );
  }
  const reasonFlag = stringFlag(flags, "--reason");
  if (reasonFlag === null) {
    return usageError(
      streams,
      json,
      "--reason is required: a bypass nobody stated a reason for is a bypass nobody can review",
    );
  }

  // 2. The refusals the verb decides, in the order SPEC.md §11.2 lists them.
  if (reasonFlag.trim().length === 0) {
    return emitRefusal(
      streams,
      json,
      refuse("gate-reason-required", "--reason was empty; say what the window is for"),
    );
  }
  if (durationMs > MAX_WINDOW_MS) {
    return emitRefusal(
      streams,
      json,
      refuse(
        "gate-duration-too-long",
        `--for ${JSON.stringify(durationText)} is longer than the 24h cap: a bypass that outlives the attention of the person who opened it is a bypass nobody is watching`,
      ),
    );
  }
  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return emitRefusal(
      streams,
      json,
      refuse(
        "actor-not-human",
        `opening the gate requires a human identity: pass --as human:<id> or set ${HUMAN_ACTOR_ENV}. This is the one act that suspends the policy, so an agent identity is refused here as well as in the log's own schema`,
      ),
    );
  }

  // 3. The terminal. `--json` is refused for the same reason a pipe is: an
  //    answer shaped for a machine implies a machine asking the question, and
  //    what this asks for is a person's assent.
  if (json) {
    return emitRefusal(
      streams,
      json,
      refuse(
        "gate-stdin-not-tty",
        "`gate open` has no --json form: it is a ceremony a person performs at a terminal, and a machine-readable answer would imply a machine asking. Run it in a terminal with no --json",
      ),
    );
  }
  const prompter = deps.prompter === undefined ? createPrompter(streams) : deps.prompter;
  if (prompter === null) {
    return emitRefusal(
      streams,
      json,
      refuse(
        "gate-stdin-not-tty",
        "stdin is not a terminal, so nobody can be asked. There is deliberately no --yes and no --force: a flag that answers this question is a way for something that cannot type to type. Run it from a terminal",
      ),
    );
  }

  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  streams.out(statement(cwd, durationText, expiresAt, reasonFlag.trim(), actor));
  const answer = prompter.readLine(
    `Type \`${CONFIRMATION}\` to open the window, anything else to abort: `,
  );
  // `null` is EOF (Ctrl-D, or the terminal going away), and it aborts like any
  // other answer that is not the word.
  if (answer === null || answer.trim() !== CONFIRMATION) {
    return emitRefusal(
      streams,
      json,
      refuse(
        "gate-confirmation-mismatch",
        `the window was not opened: the answer must be exactly \`${CONFIRMATION}\`. Nothing was appended`,
      ),
    );
  }

  const result = openWindow(
    logPath,
    { durationText, durationMs, reason: reasonFlag.trim() },
    actor,
    {},
  );
  if (!result.ok) return emitRefusal(streams, json, result);

  streams.out(
    `gate OPEN at seq ${String(result.record.seq)} until ${result.window.expiresAt} (${durationText}), opened by ${actor}\n` +
      "every gated tool call under this root is now allowed without approval and recorded as gate.bypassed;\n" +
      "`approval status` reports unhealthy until it closes. Close it with `approval gate close`.\n",
  );
  return EXIT_OK;
}

function gateClose(
  flags: Record<string, string | boolean>,
  streams: Streams,
  logPath: string,
  json: boolean,
): number {
  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return emitRefusal(
      streams,
      json,
      refuse(
        "actor-not-human",
        `closing the gate requires a human identity: pass --as human:<id> or set ${HUMAN_ACTOR_ENV}. The pair is one ceremony and both halves are the human's`,
      ),
    );
  }

  const note = stringFlag(flags, "--note");
  const result = closeWindow(logPath, actor, note === null ? {} : { note });
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      seq: result.record.seq,
      opened_seq: result.closed.seq,
      actor,
      bypassed: result.closed.bypassCount,
    });
  } else {
    streams.out(
      `gate CLOSED at seq ${String(result.record.seq)}: the window opened at seq ${String(result.closed.seq)} by ${result.closed.openedBy} is over, after ${String(result.closed.bypassCount)} bypassed call(s)\n`,
    );
  }
  return EXIT_OK;
}

function gateStatus(streams: Streams, logPath: string, json: boolean): number {
  const read = readVerifiedRecords(logPath);
  if (!read.ok) return emitRefusal(streams, json, refuse(read.code, read.message));

  const now = Date.now();
  const window = openGateWindow(read.records, now);

  if (json) {
    emitJson(streams, {
      ok: true,
      open: window !== null,
      window: window === null ? null : windowJson(window, now),
    });
    return EXIT_OK;
  }

  const st = style({ json });
  if (window === null) {
    streams.out(`gate: ${st.ok("closed")} — the policy decides every gated tool call\n`);
    return EXIT_OK;
  }
  streams.out(
    `gate: ${st.warn("OPEN")} until ${window.expiresAt} (${humanRemaining(remainingMs(window, now))} left)\n` +
      `  opened by ${window.openedBy} at seq ${String(window.seq)} (${window.openedAt})\n` +
      `  reason:   ${window.reason}\n` +
      `  bypassed: ${String(window.bypassCount)} call(s) so far\n` +
      "  close it with `approval gate close`\n",
  );
  return EXIT_OK;
}
