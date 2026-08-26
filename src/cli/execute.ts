/**
 * The execution verbs of SPEC.md §10.1: `approval run`, `approval wait`,
 * `approval status`, and `approval queue`.
 *
 * As everywhere else in this CLI, **no logic lives here.** Authorization,
 * budgets, loop safety, and the appends are `core/execute.ts`; state derivation
 * is `core/gate.ts`; chain verification is `core/verify.ts`. This file splits
 * argv, resolves paths and identity, spawns the child, chooses an exit code, and
 * formats output.
 *
 * Four choices are load-bearing enough to state plainly.
 *
 * **`approval run` is transparent.** Its own exit code is the CHILD's exit code
 * — a wrapper that swallowed it would break every `make`, every CI step, and
 * every `&&` that ever wrapped a command. run's own refusals are the only thing
 * that can produce a different code, and they all happen *before* the child is
 * spawned: 5 when no valid token was presented, 2 for a usage error, 4 for a
 * filesystem fact, 3 for a torn tail, 1 for any other gate refusal.
 *
 * **Exit 5 is new, and it is only here.** The human-settled design (2026-08-06)
 * asked for a distinct code when `run` refuses for want of a token, and
 * `exit-codes.ts` defines it as an addition to the frozen table rather than a
 * redefinition of anything in it. `approval wait` likewise adds 6 for timeout.
 * No other command emits either.
 *
 * **The child owns stdout.** `run` inherits stdio, so the child's output is not
 * captured, buffered, or interleaved with ours. That leaves `--json` nowhere
 * safe to print on stdout, so run's own JSON summary goes to **stderr** — the
 * one place we can write without corrupting a stream the child is entitled to.
 * This is stated in `--help` because it is the single place this CLI departs
 * from "one JSON object on stdout".
 *
 * **`run` and the adapter contract are two callers of one core path.** A command
 * is an adapter whose `act` is a spawn, whose payload is SPEC.md §6.2's `{argv,
 * cwd}`, and whose credentials are the ambient environment.
 * `src/adapters/contract.ts` wraps the same `startExecution` / `finishExecution`
 * pair for adapters that are objects rather than processes; `run` calls the core
 * verbs directly because its stdio inheritance, exit-code transparency, and `--`
 * argv split are CLI concerns with nothing to do with adapters. What both must
 * obey belongs in `core/execute.ts`, where both already read it; a rule added to
 * the adapter contract alone protects adapters and not this verb.
 *
 * **`status` and `queue` answer different questions.** `queue` is the pending
 * decision inbox and nothing else: requests awaiting a human, inside their TTL.
 * `status` is system health: attestation, dangling executions, budget headroom,
 * the latest verification, loop escalations. A dangling execution appears in
 * `status` and never in `queue` — nobody is being asked to decide it, and
 * putting operational debris in a human's approval inbox is how inboxes get
 * ignored.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, checkAttestation, resolveHumanActor } from "../core/attest.js";
import { evaluateBudgets, type BudgetVerdict } from "../core/budgets.js";
import {
  danglingExecutions,
  finishExecution,
  indeterminateExecutions,
  isReconcileResolution,
  loopEscalation,
  reconcileExecution,
  resolveExecution,
  startExecution,
  type ExecuteOptions,
  type ExecuteRefusal,
  type ResolveOutcome,
} from "../core/execute.js";
import { isPayloadHash, runPayloadHash } from "../core/payload.js";
import { payloadStoreCensus } from "../core/payload-census.js";
import { payloadStoreDirFor } from "../core/payload-store.js";
import { withdraw } from "../core/gate.js";
import { readVerifiedRecords, requestState } from "../core/state.js";
import type { EventRecord } from "../core/log.js";
import { loadPolicy, parseDuration, POLICY_FILENAMES } from "../core/policy-load.js";
import { verify } from "../core/verify.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_NO_TOKEN,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import {
  EXECUTION_HELP,
  QUEUE_HELP,
  RECONCILE_HELP,
  RESOLVE_HELP,
  RUN_HELP,
  STATUS_HELP,
  WAIT_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import {
  refusal as renderRefusal,
  relPath,
  style,
  table,
  type Role,
  type Style,
  type TableRow,
} from "./style.js";
import { usageErrorText } from "./usage.js";

/** Identity accepted by `run`: a person or an agent, never the runtime. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

/** Poll interval for `approval wait`, in milliseconds. */
const DEFAULT_WAIT_INTERVAL_MS = 500;

/** Exit code recorded when the command itself could not be spawned. */
const EXIT_COMMAND_NOT_RUN = 127;

const COMMON_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const POLICY_FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, helpText));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/** The clock is read here, at the edge, and handed to core. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Map an execution refusal onto the exit table.
 *
 * `token-required` is the one addition: exit 5, and only `run` can produce it.
 * Everything else follows the split the gate and token verbs already draw —
 * filesystem facts are 4, a crashed write is 3, and every decision the runtime
 * itself made is 1.
 *
 * Exported because `approval adapter` (APRV-69) is the second caller of the core
 * execution path and must map its refusals identically. Two copies of this
 * switch would drift the first time a code was added, and an agent's retry logic
 * keys on the difference between 5 and 1.
 */
export function executeRefusalExitCode(refusal: ExecuteRefusal): number {
  switch (refusal.code) {
    case "token-required":
      return EXIT_NO_TOKEN;
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

function emitRefusal(streams: Streams, json: boolean, refusal: ExecuteRefusal): number {
  if (json) {
    const error: Record<string, unknown> = { code: refusal.code, message: refusal.message };
    if (refusal.detail !== undefined) error["detail"] = refusal.detail;
    if (refusal.verdicts !== undefined) error["verdicts"] = refusal.verdicts;
    if (refusal.seq !== undefined) error["seq"] = refusal.seq;
    if (refusal.record !== undefined) error["event_seq"] = refusal.record.seq;
    streams.err(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    // APRV-102: the one refusal shape — glyph, machine-readable code, message,
    // and never a help page after it. No `fix:` line is invented: an execution
    // refusal names a STATE (no token, already started, budget exhausted) and
    // the repair depends on which, so a guessed command would be wrong more
    // often than right. Argument and payload refusals, which DO have one
    // command each, keep theirs.
    streams.err(`${renderRefusal(style({ json }), refusal.code, refusal.message)}\n`);
  }
  return executeRefusalExitCode(refusal);
}

/** Where policy lives, from `--policy` / `--dir`, with the CLI's cwd default. */
function policyLocation(
  flags: Record<string, string | boolean>,
  cwd: string,
): { dir?: string; file?: string } {
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  if (policyFlag !== null) return { file: absolute(policyFlag, cwd) };
  return { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
}

function executeOptions(
  flags: Record<string, string | boolean>,
  cwd: string,
  token: string | null,
): ExecuteOptions {
  return {
    policy: policyLocation(flags, cwd),
    ...(token === null ? {} : { token }),
  };
}

/** `defaults.approval_ttl` in force, or `null` when the policy declares none. */
function ttlOf(flags: Record<string, string | boolean>, cwd: string): number | null {
  const location = policyLocation(flags, cwd);
  const load = loadPolicy(
    location.file === undefined ? { dir: location.dir ?? cwd } : { file: location.file },
  );
  return load.ok ? load.durations.approvalTtlMs : null;
}

interface Front {
  flags: Record<string, string | boolean>;
  positionals: string[];
  json: boolean;
  logPath: string;
}

type FrontOutcome = { kind: "handled"; code: number } | ({ kind: "run" } & Front);

function front(
  argv: string[],
  spec: Record<string, FlagKind>,
  helpText: string,
  streams: Streams,
  cwd: string,
): FrontOutcome {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) {
    return { kind: "handled", code: usageError(streams, json, parsed.message, helpText) };
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${helpText}\n`);
    return { kind: "handled", code: EXIT_OK };
  }
  return {
    kind: "run",
    flags: parsed.flags,
    positionals: parsed.positionals,
    json,
    logPath: resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd),
  };
}

// ===========================================================================
// approval run
// ===========================================================================

/**
 * The exit code a child's outcome reduces to.
 *
 * A child killed by a signal has no exit code, so the shell convention is used:
 * `128 + signal number` (SIGKILL → 137, SIGTERM → 143). It is recorded in the
 * `execution.failed` payload as that number, and `run` exits with it, so a
 * killed execution reads identically from the log and from the shell.
 */
function childExitCode(status: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) {
    const numbers = osConstants.signals as unknown as Record<string, number | undefined>;
    const number = numbers[signal];
    return 128 + (number ?? 0);
  }
  return status ?? EXIT_COMMAND_NOT_RUN;
}

/**
 * Where the child's stdio goes.
 *
 * The default is the CLI's own behaviour and the one the module header
 * describes: `inherit`, so the child owns the terminal and `run` is transparent.
 * It is an option only because a caller can exist whose own stdout is not a
 * terminal but a protocol — the MCP wrapper of SPEC.md §10.5 speaks JSON-RPC on
 * fd 1, and a child that inherited it would write into the wire. Such a caller
 * pipes instead and receives what the child said through {@link onOutput}.
 *
 * This is a seam, not a second implementation: everything before and after the
 * spawn — the identity check, the payload binding, `execution.started`, the exit
 * code, `execution.completed` / `execution.failed` — is the one path, and no
 * caller can reach it without going through all of it.
 */
export interface RunChildIo {
  /** Passed straight to `spawnSync`. Default `"inherit"`. */
  readonly stdio: "inherit" | ["ignore", "pipe", "pipe"];
  /** Called with the child's captured output when {@link stdio} pipes it. */
  readonly onOutput?: (captured: { stdout: string; stderr: string }) => void;
}

const INHERIT_CHILD_IO: RunChildIo = { stdio: "inherit" };

export function commandRun(
  argv: string[],
  streams: Streams,
  cwd: string,
  childIo: RunChildIo = INHERIT_CHILD_IO,
): number {
  // `--` separates our flags from the child's argv, and the child's argv may
  // legitimately contain anything at all — including flags this CLI knows. So
  // the split happens on the RAW argv, before any parsing, and everything to the
  // right of the first `--` is handed to the child untouched.
  const separator = argv.indexOf("--");
  const ours = separator === -1 ? argv : argv.slice(0, separator);
  const childArgv = separator === -1 ? [] : argv.slice(separator + 1);

  const outcome = front(
    ours,
    {
      ...COMMON_FLAGS,
      ...POLICY_FLAGS,
      "--token": "string",
      "--as": "string",
      "--payload-hash": "string",
    },
    RUN_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", RUN_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}; the command to run goes after \`--\``,
      RUN_HELP,
    );
  }
  const command = childArgv[0];
  if (command === undefined) {
    return usageError(
      streams,
      json,
      "missing command: `approval run <action-key> [--token <t>] -- <cmd…>`",
      RUN_HELP,
    );
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = asFlag === null ? resolveHumanActor() : asFlag;
  if (actor === null || !PRINCIPAL_ACTOR.test(actor)) {
    if (asFlag !== null) {
      return usageError(
        streams,
        json,
        `--as expects human:<id> or agent:<id>, got ${JSON.stringify(asFlag)}`,
        RUN_HELP,
      );
    }
    return usageError(
      streams,
      json,
      `no identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id> | agent:<id>`,
      RUN_HELP,
    );
  }

  // Content binding (amended SPEC.md §6.2, §10.4). §6.2 defines `approval run`'s
  // payload as "the argv array and cwd", so run computes the hash itself from
  // the command it is about to spawn — an executor that had to be *told* what it
  // was running could be told wrong.
  //
  // APRV-140 (red-team F3) closes the door that used to be here. `--payload-hash`
  // was an OVERRIDE: when it was present the computation was skipped entirely,
  // so presenting the grant's own hash while spawning arbitrary argv spent the
  // token and ran something nobody approved. Adapters whose real payload is
  // something else (a message body, a proposed record) were the reason, but they
  // do not need this door: `src/adapters/contract.ts` hashes the bytes and calls
  // core directly, and `approval consume` spends a token for a payload this
  // process is not spawning. Neither is a plain `approval run` invocation, which
  // is what an agent has.
  //
  // So the flag survives as a CHECK, never a substitute: run always recomputes,
  // and a supplied value must equal what will actually spawn. The refusal is
  // `payload-mismatch` — the same code the manual path already emits for the
  // same fact, because an agent's response to it is the same either way — and it
  // happens before `startExecution`, so nothing is appended and no token moves.
  const hashFlag = stringFlag(flags, "--payload-hash");
  if (hashFlag !== null && !isPayloadHash(hashFlag)) {
    return usageError(
      streams,
      json,
      `--payload-hash expects 64 lowercase hex characters (SHA-256 over the RFC 8785 canonical serialization of the payload), got ${JSON.stringify(hashFlag)}`,
      RUN_HELP,
    );
  }
  const payloadHash = runPayloadHash(childArgv, cwd);
  if (hashFlag !== null && hashFlag !== payloadHash) {
    return emitRefusal(streams, json, {
      ok: false,
      code: "payload-mismatch",
      message: `--payload-hash ${hashFlag} is not the hash of the command this would spawn: ${JSON.stringify(childArgv[0])} and ${childArgv.length - 1} argument(s) in ${cwd} hash to ${payloadHash}. \`approval run\` recomputes the binding from the argv and cwd it is about to spawn and never accepts a caller's substitute for it (amended SPEC.md §10.4, APRV-140); the flag states what you believe you are running, and this is a refusal to run something else. Nothing was appended.`,
    });
  }

  // execution.started is appended HERE, before the child exists. A crash from
  // this line until the finish below leaves a dangling execution, which
  // `approval status` reports and nothing repairs on its own.
  const started = startExecution(
    logPath,
    actionKey,
    {
      ...executeOptions(flags, cwd, stringFlag(flags, "--token")),
      presentedPayloadHash: payloadHash,
    },
    actor,
  );
  if (!started.ok) return emitRefusal(streams, json, started);

  const child = spawnSync(command, childArgv.slice(1), {
    cwd,
    stdio: childIo.stdio,
    encoding: "utf8",
  });
  if (childIo.onOutput !== undefined) {
    childIo.onOutput({ stdout: child.stdout ?? "", stderr: child.stderr ?? "" });
  }
  const exitCode =
    child.error === undefined
      ? childExitCode(child.status, child.signal)
      : EXIT_COMMAND_NOT_RUN;
  if (child.error !== undefined) {
    streams.err(
      `approval: the command could not be run (${child.error.message}); recording execution.failed with exit_code ${EXIT_COMMAND_NOT_RUN}\n`,
    );
  }

  const finished = finishExecution(logPath, actionKey, exitCode, actor);
  if (!finished.ok) {
    const code = emitRefusal(streams, json, finished);
    // The child's code is the more important fact when the child itself failed;
    // when it succeeded, a failure to RECORD that success must not read as one.
    return exitCode === 0 ? code : exitCode;
  }

  if (json) {
    // stderr, not stdout: stdout belongs to the child. See the module header.
    streams.err(
      `${JSON.stringify({
        ok: true,
        action_key: actionKey,
        task: started.task,
        class: started.class,
        autonomy: started.autonomy,
        started_seq: started.record.seq,
        outcome: finished.event,
        outcome_seq: finished.record.seq,
        exit_code: exitCode,
        payload_hash: payloadHash,
      })}\n`,
    );
  }
  return exitCode;
}

// ===========================================================================
// approval wait
// ===========================================================================

/** Synchronous sleep with no dependency and no busy-spin. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface WaitedAction {
  action_key: string;
  state: string;
  seq: number | null;
}

/**
 * The role a decision state wears. Colour is redundant here: the word is
 * printed beside the glyph, so a pipe (or a colour-blind reader) loses nothing.
 */
function stateRole(state: string): Role {
  if (state === "granted") return "ok";
  if (state === "expired" || state === "requested" || state === "withdrawn") return "warn";
  return "fail";
}

/**
 * `approval wait`'s human answer: the verdict, then one aligned row per action.
 *
 * Action keys are copyable, so the left column opts out of `key` styling
 * (`plainLeft`) and the state beside it carries the colour instead.
 */
export function renderWaitHuman(
  task: string,
  status: string,
  actions: readonly WaitedAction[],
  st: Style = style(),
): string {
  const glyph =
    status === "granted" ? "ok" : status === "expired" || status === "withdrawn" ? "skip" : "fail";
  const head = `${st.glyph(glyph)} ${st.key(task)}  ${st.paint(stateRole(status), status)}`;
  if (actions.length === 0) return `${head}\n`;
  const rows: TableRow[] = actions.map((action) => ({
    left: action.action_key,
    right: st.paint(stateRole(action.state), action.state),
    plainLeft: true,
  }));
  return `${head}\n${st.table(rows, { indent: 2 })}\n`;
}

/** Every action key of `task` that ever carried an `approval.requested`. */
function requestedKeysOf(records: EventRecord[], task: string): string[] {
  const keys: string[] = [];
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    if (record.task !== task) continue;
    const key = record.action_key;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function commandWait(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    {
      ...COMMON_FLAGS,
      ...POLICY_FLAGS,
      "--timeout": "string",
      "--interval": "string",
      "--withdraw-on-timeout": "boolean",
      "--as": "string",
    },
    WAIT_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const task = positionals[0];
  if (task === undefined) return usageError(streams, json, "missing <task> argument", WAIT_HELP);
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, WAIT_HELP);
  }

  const timeoutText = stringFlag(flags, "--timeout");
  if (timeoutText === null) {
    return usageError(streams, json, "missing --timeout <duration>", WAIT_HELP);
  }
  const timeoutMs = parseDuration(timeoutText);
  if (timeoutMs === null) {
    return usageError(
      streams,
      json,
      `--timeout expects a duration like 30s, 10m, 6h, got ${JSON.stringify(timeoutText)}`,
      WAIT_HELP,
    );
  }
  const intervalText = stringFlag(flags, "--interval");
  const intervalMs = intervalText === null ? DEFAULT_WAIT_INTERVAL_MS : parseDuration(intervalText);
  if (intervalMs === null) {
    return usageError(
      streams,
      json,
      `--interval expects a duration like 500ms, 2s, got ${JSON.stringify(intervalText)}`,
      WAIT_HELP,
    );
  }

  // APRV-106. OFF by default, and it is the only thing that makes `wait` a
  // writer: a caller that merely stopped waiting has not necessarily stopped
  // wanting an answer (a supervisor may wait again), so the retraction is
  // opt-in. When it is on, the actor is required up front — resolving identity
  // after a nine-minute wait, and failing then, would leave exactly the stale
  // request the flag exists to prevent.
  const withdrawOnTimeout = boolFlag(flags, "--withdraw-on-timeout");
  const asFlag = stringFlag(flags, "--as");
  const withdrawActor = asFlag ?? resolveHumanActor();
  if (withdrawOnTimeout && (withdrawActor === null || !PRINCIPAL_ACTOR.test(withdrawActor))) {
    return usageError(
      streams,
      json,
      `--withdraw-on-timeout needs an identity: pass --as human:<id> | agent:<id>, or set ${HUMAN_ACTOR_ENV}. Only the actor that opened a request may withdraw it, so there is no default.`,
      WAIT_HELP,
    );
  }

  const ttlMs = ttlOf(flags, cwd);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const read = readVerifiedRecords(logPath);
    if (!read.ok) {
      return emitRefusal(streams, json, {
        ok: false,
        code: read.code === "log-torn-tail" ? "log-torn-tail" : "log-unreadable",
        message: read.message,
      });
    }

    const ts = now();
    const actions: WaitedAction[] = [];
    let pending = false;
    for (const key of requestedKeysOf(read.records, task)) {
      const derivation = requestState(read.records, key, ts, ttlMs);
      actions.push({
        action_key: key,
        state: derivation.state,
        seq: derivation.decisionSeq ?? derivation.requestSeq,
      });
      if (derivation.state === "requested") pending = true;
    }

    if (!pending) {
      // Precedence, documented in --help: a human's "no" outranks a lapse, and
      // both outrank "everything was granted". A task with no requests at all
      // has nothing to wait for and is granted vacuously.
      //
      // APRV-106 puts `withdrawn` between the two, and REUSES exit 1 rather
      // than adding a code. The table in `cli/exit-codes.ts` is frozen public
      // API — adding a number is a spec change, and agents already branch on
      // these seven — while the fact an agent needs is the one exit 1 already
      // carries: this action is NOT authorized and no retry of the same request
      // will change that. The distinction lives where a distinction can be
      // added without breaking anyone, in `status`, which is `"withdrawn"` in
      // the JSON and printed beside the action in the human render.
      const rejected = actions.some(
        (action) => action.state === "rejected" || action.state === "revoked",
      );
      const withdrawn = actions.some((action) => action.state === "withdrawn");
      const expired = actions.some((action) => action.state === "expired");
      const status = rejected
        ? "rejected"
        : withdrawn
          ? "withdrawn"
          : expired
            ? "expired"
            : "granted";
      const code = rejected || withdrawn ? EXIT_INTEGRITY : expired ? EXIT_TORN_TAIL : EXIT_OK;
      if (json) emitJson(streams, { ok: true, task, status, actions });
      else streams.out(renderWaitHuman(task, status, actions, style({ json })));
      return code;
    }

    if (Date.now() >= deadline) {
      // APRV-106. Best effort, and never fatal: the exit code is still 6, which
      // is what the caller branches on. A withdrawal that itself fails leaves
      // the request live — the pre-APRV-106 behaviour — and says so on stderr
      // rather than converting a timeout into a different outcome.
      const withdrawn: string[] = [];
      if (withdrawOnTimeout && withdrawActor !== null) {
        for (const action of actions) {
          if (action.state !== "requested") continue;
          const result = withdraw(logPath, action.action_key, withdrawActor, {
            policy: policyLocation(flags, cwd),
            reason: "timeout",
            note: `the waiting process stopped waiting after ${timeoutText}; a decision on this request can no longer be consumed`,
          });
          if (result.ok) withdrawn.push(action.action_key);
          else {
            streams.err(
              `approval: could not withdraw ${action.action_key} on timeout (${result.code}): ${result.message}\n`,
            );
          }
        }
      }
      if (json) {
        // `withdrawn` appears only when the flag asked for it. The default
        // timeout object is the shape callers already parse, and adding an
        // always-empty array to it would be a breaking change bought for
        // nothing.
        streams.err(
          `${JSON.stringify({
            ok: false,
            task,
            status: "timeout",
            actions,
            ...(withdrawOnTimeout ? { withdrawn } : {}),
          })}\n`,
        );
      } else {
        streams.err(
          withdrawn.length === 0
            ? `approval: timeout: ${task} still has undecided request(s) after ${timeoutText}; nothing was appended and the request(s) remain live\n`
            : `approval: timeout: ${task} was undecided after ${timeoutText}; withdrew ${withdrawn.length} request(s) so no one is asked a question this process can no longer answer to: ${withdrawn.join(", ")}\n`,
        );
      }
      return EXIT_TIMEOUT;
    }

    sleepSync(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

// ===========================================================================
// approval queue
// ===========================================================================

interface QueueEntry {
  action_key: string;
  task: string | null;
  class: string | null;
  est_cost_usd: number | null;
  requested_ts: string | null;
  seq: number | null;
  /** Milliseconds until the TTL lapses, or `null` when the policy sets none. */
  ttl_remaining_ms: number | null;
}

/** The live inbox: requests inside their TTL, awaiting a human decision. */
function pendingRequests(
  records: EventRecord[],
  ts: string,
  ttlMs: number | null,
): QueueEntry[] {
  const keys: string[] = [];
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    const key = record.action_key;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!keys.includes(key)) keys.push(key);
  }

  const entries: QueueEntry[] = [];
  for (const key of keys) {
    const derivation = requestState(records, key, ts, ttlMs);
    if (derivation.state !== "requested") continue;
    const requestedAt = Date.parse(derivation.requestTs ?? "");
    const asked = Date.parse(ts);
    const remaining =
      ttlMs === null || Number.isNaN(requestedAt) || Number.isNaN(asked)
        ? null
        : requestedAt + ttlMs - asked;
    entries.push({
      action_key: key,
      task: derivation.task,
      class: derivation.declared.class,
      est_cost_usd: derivation.declared.est_cost_usd,
      requested_ts: derivation.requestTs,
      seq: derivation.requestSeq,
      ttl_remaining_ms: remaining,
    });
  }
  return entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** `23h 58m left`, `45s left`, `lapsed` — the TTL column's text. */
function ttlText(remainingMs: number | null): string {
  if (remainingMs === null) return "no TTL";
  const seconds = Math.max(0, Math.round(remainingMs / 1000));
  if (seconds === 0) return "lapsed";
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

/**
 * The TTL column's role, by the fraction of the window still standing:
 * comfortable above half, worth noticing above a tenth, urgent below it.
 */
function ttlRole(remainingMs: number | null, ttlMs: number | null): Role {
  if (remainingMs === null || ttlMs === null || ttlMs <= 0) return "muted";
  const fraction = remainingMs / ttlMs;
  if (fraction > 0.5) return "ok";
  if (fraction > 0.1) return "warn";
  return "fail";
}

/**
 * The live inbox as an aligned table (APRV-91 #9).
 *
 * The old shape was tab-separated, which lines up only when every field happens
 * to be the same width, and a queue's fields never are. The alignment is
 * `style.table`'s (APRV-102 replaced a hand-rolled copy of it here), so widths
 * are measured on the UNDRESSED cells and the coloured render is the plain one
 * with escapes inserted.
 *
 * The TTL is the only dressed cell. The request timestamp was `muted` until
 * APRV-102 and is not any more: a timestamp is a value an operator copies into
 * a `grep` or a bug report, and rule 3 of `style.ts` does not have a "but this
 * one is only dim" exception.
 */
export function renderQueueHuman(
  pending: readonly QueueEntry[],
  ttlMs: number | null,
  st: Style = style(),
): string {
  const rows = pending.map((entry) => [
    entry.action_key,
    entry.task ?? "-",
    entry.class ?? "-",
    `$${String(entry.est_cost_usd ?? 0)}`,
    entry.requested_ts ?? "-",
    { text: ttlText(entry.ttl_remaining_ms), role: ttlRole(entry.ttl_remaining_ms, ttlMs) },
  ]);
  return `${table(st, rows, {
    header: ["action", "task", "class", "cost", "requested", "ttl"],
  })}\n`;
}

export function commandQueue(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(argv, { ...COMMON_FLAGS, ...POLICY_FLAGS }, QUEUE_HELP, streams, cwd);
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const extra = positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, QUEUE_HELP);
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    return emitRefusal(streams, json, {
      ok: false,
      // The read refusal's code is already one of this command's codes
      // (`log-unreadable`, `log-torn-tail`, `log-corrupt`); it is surfaced
      // unchanged so a corrupt log is reported as corruption, not as I/O.
      code: read.code,
      message: read.message,
    });
  }

  // ONE read of the policy: `ttlOf` loads and parses it, and calling it twice
  // (as this did before APRV-102) risks the two halves of one render disagreeing
  // about the TTL if the file changes underneath, on top of the wasted work.
  const ttlMs = ttlOf(flags, cwd);
  const pending = pendingRequests(read.records, now(), ttlMs);

  if (json) {
    emitJson(streams, { ok: true, pending });
  } else if (pending.length === 0) {
    streams.out("queue: empty — no requests awaiting a decision\n");
  } else {
    streams.out(renderQueueHuman(pending, ttlMs, style({ json })));
  }
  // An empty inbox is a healthy inbox: queue never exits non-zero for having
  // nothing (or something) in it. Only the filesystem and a torn log can.
  return EXIT_OK;
}

// ===========================================================================
// approval status
// ===========================================================================

/** The policy file whose bytes attestation is judged against. */
function policyPathFor(flags: Record<string, string | boolean>, cwd: string): string {
  const location = policyLocation(flags, cwd);
  if (location.file !== undefined) return location.file;
  const dir = location.dir ?? cwd;
  return resolvePathSegments(dir, POLICY_FILENAMES[0] ?? "APPROVAL.md");
}

function budgetHeadroom(
  records: EventRecord[],
  flags: Record<string, string | boolean>,
  cwd: string,
  ts: string,
): BudgetVerdict[] {
  const location = policyLocation(flags, cwd);
  const load = loadPolicy(
    location.file === undefined ? { dir: location.dir ?? cwd } : { file: location.file },
  );
  // A ZERO-COST PROBE: the hypothetical next action, declaring $0 and no class.
  // Only the global budgets are evaluated (class limits need a matched rule and
  // therefore a specific action, which status does not have). `remaining` is
  // consequently headroom AFTER that probe — which for daily_actions means one
  // action is already subtracted, because every authorization counts as one.
  // Stated here and in --help rather than quietly adjusted: the number a reader
  // sees is the number the evaluator would produce for the next action.
  return evaluateBudgets(
    records,
    {
      classLimits: null,
      classPattern: null,
      globalBudgets: load.ok ? load.policy.budgets ?? null : null,
    },
    { class: "", est_cost_usd: 0 },
    ts,
  ).verdicts;
}

/**
 * The one warning `status` exists to keep in front of an operator: the payload
 * store is the only thing under `.approval/` that a rebuild cannot recreate.
 *
 * QUEUE.md regenerates and `index.sqlite` reindexes, both from the log. The
 * store does not: the log records the *hash* a request bound to, never the
 * bytes, so bytes deleted from `.approval/payloads/` are gone. What survives is
 * the binding, which is why the loss is visible rather than silent: every
 * manual request whose material went with it renders `payload-unavailable`
 * (`channels/tagging.ts`) instead of showing an approver something no hash ever
 * bound.
 */
const PAYLOAD_STORE_NOTE =
  "the payload store holds the bytes approvals bind to, keyed by their hash; " +
  "it is the one cache that cannot be rebuilt from the log, and losing it leaves " +
  "manual requests rendering as payload-unavailable rather than showing bytes no hash bound";

/**
 * How many payloads are stored, whether the store exists, and what the log says
 * about the ones that are gone (APRV-41).
 *
 * `pruned` counts distinct hashes named by a `payload.pruned` event: retention
 * removes bytes and leaves that record behind on purpose, so a reader can tell
 * "this store never held it" from "this store held it and the daemon let it go".
 * `orphans` counts files no record binds — head-moved residue, which the daemon
 * removes once `payload_retention` is set and which nothing removes while it is
 * absent. Both are facts, never health inputs.
 */
function payloadStoreSummary(
  logPath: string,
  records: EventRecord[],
): {
  present: boolean;
  files: number;
  pruned: number;
  orphans: number;
  note: string;
} {
  let files = 0;
  let present = true;
  try {
    for (const entry of readdirSync(payloadStoreDirFor(logPath), { withFileTypes: true })) {
      // `<hash>.json` and nothing else. Temp files from an interrupted atomic
      // write start with a dot and are not payloads anybody can read.
      if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(".")) {
        files += 1;
      }
    }
  } catch {
    // Unreadable and absent are reported the same way on purpose: `status` is
    // not the environment diagnostic. `approval doctor` distinguishes them, and
    // an unwritable store is a failure there.
    present = false;
    files = 0;
  }
  const census = payloadStoreCensus(records, payloadStoreDirFor(logPath));
  return {
    present,
    files,
    pruned: census.pruned,
    orphans: census.orphans,
    note: PAYLOAD_STORE_NOTE,
  };
}

export function commandStatus(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, ...POLICY_FLAGS, "--verbose": "boolean" },
    STATUS_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const extra = positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, STATUS_HELP);
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  // The policy is read here for one number, the skew tolerance of amended
  // SPEC.md §8 (APRV-58), and it reaches only which anomalies are reported. The
  // verdict, the health line and the exit code below are unmoved by it.
  const verification = verify(logPath, { policy: policyLocation(flags, cwd) });
  const read = readVerifiedRecords(logPath);
  // A log that cannot be read at all is an I/O fact, not a health report.
  if (!read.ok && read.code === "log-unreadable") {
    return ioError(streams, json, read.message);
  }
  // A torn or corrupt log still produces a health report — that *is* the report,
  // and `verification` below names the damage. Projections over an unverifiable
  // log are simply empty: `status` describes the log, it never authorizes
  // anything from one.
  const records = read.ok ? read.records : [];

  const attestation = checkAttestation(records, policyPathFor(flags, cwd));
  // APRV-120. `dangling` is now the `open` custody state only: a harness
  // execution is terminal by design and never gains an outcome, so listing it
  // as debris trained operators to ignore this list (the reference repository's
  // own log carried dozens). Indeterminate outcomes are reported beside it
  // rather than inside it, because the two ask a person for different things:
  // look at what our runtime did, against establish whether the far side
  // committed.
  const dangling = danglingExecutions(records).map((entry) => ({
    action_key: entry.actionKey,
    task: entry.task,
    ts: entry.ts,
    seq: entry.seq,
  }));
  const indeterminate = indeterminateExecutions(records).map((entry) => ({
    action_key: entry.actionKey,
    task: entry.task,
    ts: entry.ts,
    seq: entry.indeterminateSeq,
    reason: entry.reason,
  }));
  const escalations = loopEscalation(records)
    .filter((state) => state.escalated)
    .map((state) => ({
      task: state.task,
      consecutive_failures: state.consecutiveFailures,
      escalated: true,
    }));
  const budgets = budgetHeadroom(records, flags, cwd, now());
  // Informational: the store's state never moves `healthy` or the exit code.
  // A repo that has never made a `--payload` request has no store, and an
  // operator is being told what it is, not that anything is wrong.
  const payloadStore = payloadStoreSummary(logPath, records);

  const verificationSummary = {
    status: verification.status,
    records: verification.status === "corrupt" ? null : verification.records,
  };

  // APRV-40. Timestamp anomalies (SPEC.md §8) are informational and deliberately
  // outside `healthy`: they are a judgment, not an integrity verdict. `verify`
  // already declined to refuse on them, and `status` does not get to overrule it
  // by flipping a health bit an operator reads as "something is broken". The
  // field is present only when there is something to report, so every existing
  // `--json` consumer sees a byte-identical object on a log with no anomaly.
  //
  // The sampler's own state is NOT reported here: `status --json` is a frozen
  // shape, and the configuration fact belongs to `approval audit list`, which
  // reports it beside the backlog it explains.
  const anomalies = verification.anomalies.map((anomaly) => ({
    kind: anomaly.kind,
    seq: anomaly.seq,
    previous_seq: anomaly.previousSeq,
    skew_ms: anomaly.skewMs,
    message: anomaly.message,
  }));

  const healthy =
    attestation.status === "attested" &&
    verification.status === "clean" &&
    dangling.length === 0 &&
    // An unreconciled indeterminate outcome is a side effect nobody has
    // established the fate of, and a repo carrying one is not healthy.
    indeterminate.length === 0 &&
    escalations.length === 0;

  if (json) {
    emitJson(streams, {
      ok: true,
      healthy,
      attestation: {
        state: attestation.status,
        seq:
          attestation.status === "attested" || attestation.status === "hash-mismatch"
            ? attestation.seq
            : null,
      },
      verification: verificationSummary,
      dangling,
      // Present only when there is something to report, exactly as `anomalies`
      // is: every existing consumer sees a byte-identical object on a log that
      // carries no indeterminate outcome.
      ...(indeterminate.length === 0 ? {} : { indeterminate }),
      budgets,
      loop_escalations: escalations,
      payload_store: payloadStore,
      ...(anomalies.length === 0 ? {} : { anomalies }),
    });
  } else {
    const st = style({ json });
    const verbose = boolFlag(flags, "--verbose");
    const rows: TableRow[] = [
      {
        left: "health",
        right: healthy ? st.ok("ok") : st.warn("attention"),
      },
      {
        left: "attestation",
        // The seq is a value: an operator pastes it into `approval log tail` or
        // a bug report, so APRV-102 took the `muted` dressing off it. The state
        // beside it still carries the colour.
        right: `${st.paint(attestation.status === "attested" ? "ok" : "warn", attestation.status)}${
          attestation.status === "attested" || attestation.status === "hash-mismatch"
            ? ` (seq ${attestation.seq})`
            : ""
        }`,
      },
      {
        left: "verification",
        right: `${st.paint(verificationSummary.status === "clean" ? "ok" : "fail", verificationSummary.status)}${
          verificationSummary.records === null
            ? ""
            : ` ${st.muted(`(${verificationSummary.records} record(s))`)}`
        }`,
      },
      {
        left: "timestamp anomalies",
        right:
          anomalies.length === 0
            ? st.muted("none")
            : st.warn(
                `${anomalies.length} (reported, NOT refused — the chain verifies and health is unaffected)`,
              ),
        ...(anomalies.length === 0
          ? {}
          : {
              under: anomalies.map(
                (anomaly) =>
                  `${anomaly.kind}  seq ${anomaly.seq}  ${anomaly.skew_ms}ms before seq ${anomaly.previous_seq}`,
              ),
            }),
      },
      {
        left: "dangling executions",
        right: dangling.length === 0 ? st.muted("none") : st.fail(String(dangling.length)),
        ...(dangling.length === 0
          ? {}
          : {
              under: dangling.map(
                (entry) => `${entry.action_key}  started ${entry.ts}  seq ${entry.seq}`,
              ),
            }),
      },
      {
        // Its own row, never folded into the one above: the repair is a
        // different verb answering a different question (APRV-120).
        left: "indeterminate executions",
        right:
          indeterminate.length === 0 ? st.muted("none") : st.fail(String(indeterminate.length)),
        ...(indeterminate.length === 0
          ? {}
          : {
              under: indeterminate.map(
                (entry) =>
                  `${entry.action_key}  ${entry.reason ?? "unknown reason"}  seq ${String(entry.seq)} — outcome unknown; \`approval execution reconcile\``,
              ),
            }),
      },
      ...(budgets.length === 0
        ? [{ left: "budgets", right: st.muted("none configured") }]
        : budgets.map((verdict) => ({
            left: `budget ${verdict.limit}`,
            right: `consumed ${verdict.consumed}, remaining ${verdict.remaining}`,
          }))),
      {
        // APRV-91: the two-line sentence that used to live here is the store's
        // rationale, not its state. The state is three numbers, and the
        // rationale is one `--json` field (`payload_store.note`) and a
        // paragraph in `docs/` away.
        left: "payload store",
        right: `${
          payloadStore.present ? `${payloadStore.files} file(s)` : "not created yet"
        }, ${payloadStore.pruned} pruned, ${payloadStore.orphans} unbound`,
        // …and `--verbose` puts it back (APRV-102). The sentence is the one
        // thing here a first-time reader cannot reconstruct from the numbers,
        // so it is one flag away rather than gone.
        ...(verbose ? { under: [st.muted(payloadStore.note)] } : {}),
      },
      {
        left: "loop escalations",
        right: escalations.length === 0 ? st.muted("none") : st.fail(String(escalations.length)),
        ...(escalations.length === 0
          ? {}
          : {
              under: escalations.map(
                (entry) =>
                  `${entry.task} (${entry.consecutive_failures} consecutive execution.failed) — escalated to manual`,
              ),
            }),
      },
      { left: "log", right: relPath(logPath, cwd) },
    ];
    streams.out(`${st.table(rows)}\n`);
  }

  return healthy ? EXIT_OK : EXIT_INTEGRITY;
}

// ===========================================================================
// approval execution resolve
// ===========================================================================

/**
 * `approval execution resolve <action-key> --outcome completed|failed --note …`
 *
 * The human recovery verb for a dangling execution: the runtime died between
 * `execution.started` and its outcome, `approval status` has been reporting the
 * gap ever since, and a person went and looked. This records what they saw.
 *
 * Three rules, enforced here as usage errors before core is called at all, so
 * the log is untouched by a malformed invocation:
 *
 * - `--outcome` is `completed` or `failed`. Nothing is inferred.
 * - `--note` is MANDATORY and non-empty. The event's whole value is the
 *   observation behind it.
 * - The actor must be a human (`--as human:<id>` or `APPROVAL_HUMAN`). An agent
 *   closing its own dangling execution is the executing party reporting on
 *   itself.
 *
 * No attestation is required, and the help text says why: resolve records a
 * fact a human observed; it exercises no policy authority, so it does not
 * require an attested policy.
 */
export function commandResolve(argv: string[], streams: Streams, cwd: string): number {
  const outcomeFront = front(
    argv,
    { ...COMMON_FLAGS, "--outcome": "string", "--note": "string", "--as": "string" },
    RESOLVE_HELP,
    streams,
    cwd,
  );
  if (outcomeFront.kind === "handled") return outcomeFront.code;
  const { flags, positionals, json, logPath } = outcomeFront;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", RESOLVE_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, RESOLVE_HELP);
  }

  const outcomeFlag = stringFlag(flags, "--outcome");
  if (outcomeFlag === null) {
    return usageError(streams, json, "missing --outcome completed|failed", RESOLVE_HELP);
  }
  if (outcomeFlag !== "completed" && outcomeFlag !== "failed") {
    return usageError(
      streams,
      json,
      `--outcome expects completed or failed, got ${JSON.stringify(outcomeFlag)}; nothing is inferred from a dangling execution`,
      RESOLVE_HELP,
    );
  }
  const outcome: ResolveOutcome = outcomeFlag;

  const note = stringFlag(flags, "--note");
  if (note === null || note.trim().length === 0) {
    return usageError(
      streams,
      json,
      note === null
        ? "missing --note \"<what you observed>\": resolve records a human observation, and an unexplained attested outcome cannot be told apart from a guess"
        : "--note must not be empty: resolve records a human observation, and an unexplained attested outcome cannot be told apart from a guess",
      RESOLVE_HELP,
    );
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    if (asFlag !== null) {
      return usageError(
        streams,
        json,
        `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; resolve records what a person observed and an agent: or system: actor cannot perform it`,
        RESOLVE_HELP,
      );
    }
    return usageError(
      streams,
      json,
      `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`,
      RESOLVE_HELP,
    );
  }

  const result = resolveExecution(logPath, actionKey, outcome, note, actor, {
    policy: policyLocation(flags, cwd),
  });
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      action_key: actionKey,
      task: result.task,
      event: result.event,
      outcome: result.outcome,
      seq: result.record.seq,
      attested_by_human: true,
      actor,
    });
  } else {
    streams.out(
      `resolved ${actionKey} as ${result.outcome} at seq ${result.record.seq} by ${actor} (human-attested, no exit code)\n`,
    );
  }
  return EXIT_OK;
}

// ===========================================================================
// approval execution reconcile
// ===========================================================================

/**
 * `approval execution reconcile <action-key> --resolution executed|not-executed
 * --note …`
 *
 * The human resolution of an INDETERMINATE execution (APRV-120): the side
 * effect was attempted, the runtime could not tell whether it committed, and a
 * person went and looked at the far side.
 *
 * It is a separate verb from `resolve` rather than a third `--outcome` value,
 * because the two answer different questions from different evidence. `resolve`
 * asks "what did our runtime do?" and is answered from this machine. This asks
 * "did the provider commit?" and is answered from the provider's own console,
 * inbox or ledger. An operator who reached for the wrong one is told so
 * (`not-indeterminate`, `already-finished`) rather than quietly writing the
 * wrong record into an append-only log.
 *
 * The same three rules `resolve` enforces, enforced here before core is called:
 * the resolution is one of two closed values and nothing is inferred, the note
 * is mandatory and non-empty because it is the evidence, and the actor must be
 * a human — the daemon never auto-resolves, and an agent reconciling its own
 * unknown outcome is the executing party reporting on itself.
 */
export function commandReconcile(argv: string[], streams: Streams, cwd: string): number {
  const outcomeFront = front(
    argv,
    { ...COMMON_FLAGS, "--resolution": "string", "--note": "string", "--as": "string" },
    RECONCILE_HELP,
    streams,
    cwd,
  );
  if (outcomeFront.kind === "handled") return outcomeFront.code;
  const { flags, positionals, json, logPath } = outcomeFront;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", RECONCILE_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      RECONCILE_HELP,
    );
  }

  const resolutionFlag = stringFlag(flags, "--resolution");
  if (resolutionFlag === null) {
    return usageError(
      streams,
      json,
      "missing --resolution executed|not-executed",
      RECONCILE_HELP,
    );
  }
  if (!isReconcileResolution(resolutionFlag)) {
    return usageError(
      streams,
      json,
      `--resolution expects executed or not-executed, got ${JSON.stringify(resolutionFlag)}; nothing is inferred about an outcome the runtime could not observe`,
      RECONCILE_HELP,
    );
  }

  const note = stringFlag(flags, "--note");
  if (note === null || note.trim().length === 0) {
    return usageError(
      streams,
      json,
      note === null
        ? 'missing --note "<the evidence>": reconcile records what a person established about an unknown outcome, and an unexplained resolution cannot be told apart from a guess'
        : "--note must not be empty: reconcile records what a person established about an unknown outcome, and an unexplained resolution cannot be told apart from a guess",
      RECONCILE_HELP,
    );
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    if (asFlag !== null) {
      return usageError(
        streams,
        json,
        `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; reconcile records what a person established and an agent: or system: actor cannot perform it`,
        RECONCILE_HELP,
      );
    }
    return usageError(
      streams,
      json,
      `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`,
      RECONCILE_HELP,
    );
  }

  const result = reconcileExecution(logPath, actionKey, resolutionFlag, note, actor, {
    policy: policyLocation(flags, cwd),
  });
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      action_key: actionKey,
      task: result.task,
      event: "execution.reconciled",
      resolution: result.resolution,
      indeterminate_seq: result.indeterminateSeq,
      seq: result.record.seq,
      attested_by_human: true,
      actor,
    });
  } else {
    streams.out(
      `reconciled ${actionKey} as ${result.resolution} at seq ${result.record.seq} by ${actor}, resolving the indeterminate outcome at seq ${result.indeterminateSeq} (human-attested; the idempotency key stays spent)\n`,
    );
  }
  return EXIT_OK;
}

/** `approval execution <subcommand>`: `resolve` and `reconcile`. */
export function commandExecution(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval execution`", EXECUTION_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${EXECUTION_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "resolve") return commandResolve(rest, streams, cwd);
  if (sub === "reconcile") return commandReconcile(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval execution\``,
    EXECUTION_HELP,
  );
}
