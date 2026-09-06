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
import { readdirSync, rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, checkAttestation, resolveHumanActor } from "../core/attest.js";
import {
  RESOLVE_DANGLING_COMMAND,
  proveDanglingAdvances,
} from "../core/advance-cycle.js";
import { openObligations } from "../core/audit.js";
import { evaluateBudgets, type BudgetVerdict } from "../core/budgets.js";
import { declaredCredentialsForClass } from "../adapters/registry.js";
import { childEnvironment, type ChildEnvironment } from "../core/child-env.js";
import { coverageReport } from "../core/coverage.js";
import {
  credentialPathsFor,
  detectSandbox,
  resolveExecutable,
  sandboxPosture,
  sandboxRequired,
  wrapForSandbox,
  type SandboxMechanism,
  type WrappedSpawn,
} from "../core/sandbox.js";
import {
  DEFAULT_TRUNK_REF,
  defaultRange,
  observeGit,
} from "../core/coverage-sources/git.js";
import {
  danglingExecutions,
  findDeclaration,
  finishExecution,
  indexDeclarations,
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
import { harnessLoopEscalation, harnessOutcomeCoverage, loopClearance } from "../core/loop.js";
import { isPayloadHash, runPayloadHash } from "../core/payload.js";
import { payloadStoreCensus } from "../core/payload-census.js";
import { payloadStoreDirFor } from "../core/payload-store.js";
import { withdraw } from "../core/gate.js";
import { openGateWindow } from "../core/gate-window.js";
import { keyStoreDirFor } from "../core/seal.js";
import { readVerifiedRecords, requestState } from "../core/state.js";
import { deliveredToken } from "../core/token.js";
import { passphraseEnvFor } from "../core/vault.js";
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
import { repoRoot } from "./git-scope.js";
import { publishedState } from "./log-advance.js";
import { confirmUntil, createPrompter, type Prompter } from "./prompt.js";
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

/**
 * The environment the granted child gets, and the count of what was withheld
 * (APRV-205).
 *
 * Three inputs, none of them a flag. The policy names the passphrase variable
 * (`vault.passphrase_env`); the credential-bearing prefixes and their allowlist
 * come from the classifier's own list (APRV-194, exported for this); and the
 * pass-through set is whatever adapter serves the DECLARED class of this action
 * named in its `requiredCredentials` (APRV-169). The declaration is read from
 * verified records — SPEC.md §11.1's first invariant, and the reason this is a
 * second read of the log rather than a peek at the task file.
 *
 * A log this cannot read yields the empty pass-through set and a scrub that
 * removes more, which is the fail-closed direction: `startExecution` is about to
 * refuse the same read anyway, and if it somehow does not, the child is starved
 * rather than fed.
 */
function childEnvFor(
  logPath: string,
  actionKey: string,
  flags: Record<string, string | boolean>,
  cwd: string,
): ChildEnvironment {
  const location = policyLocation(flags, cwd);
  const load = loadPolicy(
    location.file === undefined ? { dir: location.dir ?? cwd } : { file: location.file },
  );
  const read = readVerifiedRecords(logPath);
  const declared = read.ok ? findDeclaration(read.records, actionKey) : null;
  return childEnvironment({
    passphraseEnv: passphraseEnvFor(load),
    declaredCredentials:
      declared === null ? [] : declaredCredentialsForClass(declared.class),
  });
}

/**
 * The wrapped spawn for a child that must not reach the network (APRV-193), or
 * `null` when there is nothing to wrap.
 *
 * The allowance is the runtime's, not the caller's: outbound network denied,
 * loopback with it (the gate's IPC is a file, so there is no socket to except),
 * and the credential material beside the log unreadable. No flag widens it.
 * `--no-sandbox` is all or nothing, and it is recorded.
 */
function wrapExecutable(
  mechanism: SandboxMechanism,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  logPath: string,
): WrappedSpawn | null {
  const resolved = resolveExecutable(command, env);
  if (resolved === null) return null;
  return wrapForSandbox(mechanism, resolved, args, {
    loopback: false,
    denyRead: credentialPathsFor(logPath),
  });
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
      "--no-sandbox": "boolean",
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

  // APRV-205. The child's environment is built BEFORE `execution.started`,
  // because the count of what was withheld is recorded on that event and a
  // number written after the fact would be a number nobody measured. The child
  // gets everything the session holds except the credential-bearing names: see
  // `core/child-env.ts` for the three rules and for what this deliberately does
  // NOT do (it is a scrub, not the sandbox APRV-193 designs).
  const childEnv = childEnvFor(logPath, actionKey, flags, cwd);

  // APRV-193. The room the child runs in, decided BEFORE `execution.started`
  // for the same reason the count above is: the record says what happened, and
  // a value written after the fact would be a value nobody measured.
  //
  // `granted` is the presence of a token, and it is the whole class test this
  // verb needs. The manual path is a human's grant over these exact bytes, and
  // `approval run` on a grant is the one door to the world the design leaves
  // open (the registry for `deps.add`, the API host for `network.call`). Every
  // other path — autonomous, and supervised-sampled — is one nobody was asked
  // about, and that is where the child is starved. Reading the token rather
  // than re-resolving the class keeps this decision on THIS side of the append,
  // and it widens nothing an agent can reach on its own: a token that does not
  // verify runs no command at all, so the loosening needs something a human
  // minted (SPEC.md §11.1 invariant 4).
  const posture = sandboxPosture({
    optedOut: boolFlag(flags, "--no-sandbox"),
    granted: stringFlag(flags, "--token") !== null,
    detection: detectSandbox(),
    ...(sandboxRequired() ? { requireSupported: true } : {}),
  });
  if (posture.kind === "refuse") {
    // Fail closed, and BEFORE anything is appended: a machine that cannot
    // protect an execution costs no authority, so the same token still spends
    // once the mechanism works. Not one of `EXECUTE_REFUSAL_CODES` — adding
    // `sandbox-unavailable` to that union widens frozen public API (§11.1
    // invariant 6), which is a human's decision and is drafted for sign-off in
    // `docs/proposals/aprv-193-amendments.md`. Until then this is what it is:
    // the executor declining to run something it cannot put in the room it
    // promised, with the exit code that already means "the command did not run".
    streams.err(
      `approval: the egress sandbox is unavailable (${posture.reason}); the command was NOT run and nothing was appended. Fix the sandbox, or take the recorded opt-out with \`--no-sandbox\` (docs/sandboxed-exec.md).\n`,
    );
    return EXIT_COMMAND_NOT_RUN;
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
      envStripped: childEnv.stripped,
      sandbox: posture.state,
    },
    actor,
  );
  if (!started.ok) return emitRefusal(streams, json, started);

  // APRV-193. The wrapper is built here and not inside `core/sandbox.ts`'s own
  // spawn, because this verb's spawn is the one place the payload binding, the
  // starved environment and the stdio contract already meet: a second spawn
  // site would be a second place for them to drift.
  //
  // The command is resolved to an absolute path first. `sandbox-exec` execs
  // through `execvp`, so the lookup would still happen — but a lookup that
  // FAILS exits 71, and 71 recorded as the child's exit code is a lie about a
  // command that never ran. A command that does not resolve is left unwrapped
  // and fails as the ENOENT it is.
  const wrapped =
    posture.kind === "apply"
      ? wrapExecutable(posture.mechanism, command, childArgv.slice(1), childEnv.env, logPath)
      : null;
  const child = spawnSync(
    wrapped?.command ?? command,
    wrapped?.args ?? childArgv.slice(1),
    {
      cwd,
      stdio: childIo.stdio,
      encoding: "utf8",
      env: childEnv.env,
    },
  );
  if (wrapped !== null) rmSync(wrapped.cleanup, { recursive: true, force: true });
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
  /**
   * The raw execution token, when sealed delivery put one within this process's
   * reach (APRV-105). Present ONLY in `--json`: the human render is a terminal,
   * and a token printed there is the paste this feature exists to remove.
   * Absent under the default `token_delivery: manual`, absent on a machine that
   * did not open the request, and absent once the token has been spent.
   */
  token?: string;
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
      // APRV-105. The token, when this machine can open it: the grant sealed it
      // to the ephemeral public key this action's request published, and the
      // private half is in the key store beside the log. Attached only to a
      // GRANTED action, and only in `--json` below — a `null` on every other
      // state would be a field consumers have to ignore, and a token on a
      // rejected action would be a value with nothing behind it.
      const token =
        json && derivation.state === "granted"
          ? deliveredToken(read.records, key, keyStoreDirFor(logPath))
          : null;
      actions.push({
        action_key: key,
        state: derivation.state,
        seq: derivation.decisionSeq ?? derivation.requestSeq,
        ...(token === null ? {} : { token }),
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
  /** Canonical decimal USD string (APRV-121), as the record spells it. */
  est_cost_usd: string | null;
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
    { class: "", est_cost_usd: "0" },
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

/** The `git coverage` row's state: what git witnessed, and what the log says. */
interface GitCoverageSummary {
  available: boolean;
  reason: string | null;
  observed: number;
  covered: number;
}

/**
 * The informational git-coverage line of `approval status` (APRV-245).
 *
 * The range is the CURRENT BRANCH's own commits: `defaultRange` takes the merge
 * base with `origin/main`, so what this counts is what this branch added and not
 * the whole history. Two states are reported instead of a count, because in
 * neither of them would a count mean anything: a directory that is not a git
 * checkout, and a checkout where `origin/main` does not resolve. The second is
 * NOT quietly swapped for the last twenty commits here — `approval coverage`
 * announces that fallback in its own output where there is room to say so, and
 * a one-line summary that silently changed what it measured would be worse than
 * one that says it cannot measure.
 *
 * Informational, exactly as `harness outcomes` beside it is (APRV-145): it is a
 * coverage measurement rather than an integrity verdict, so it is deliberately
 * outside `healthy` and outside the exit code. A gap here is a question for a
 * person ("was that commit ever declared?"), and questions with legitimate
 * answers must not turn a `status` run red.
 */
function gitCoverageSummary(
  records: readonly EventRecord[],
  flags: Record<string, string | boolean>,
  cwd: string,
): GitCoverageSummary {
  const empty = (reason: string): GitCoverageSummary => ({
    available: false,
    reason,
    observed: 0,
    covered: 0,
  });
  const root = repoRoot(cwd);
  if (root === null) return empty("not a git checkout");
  const range = defaultRange(root, DEFAULT_TRUNK_REF);
  if (range.note !== undefined) return empty(`${DEFAULT_TRUNK_REF} absent`);

  const location = policyLocation(flags, cwd);
  const load = loadPolicy(
    location.file === undefined ? { dir: location.dir ?? cwd } : { file: location.file },
  );
  const seen = observeGit(root, {
    base: range.base,
    head: range.head,
    policyProtectedPaths: load.ok ? (load.policy.protected_paths ?? []) : [],
  });
  if (!seen.available) return empty(seen.reason ?? "git could not be asked");
  const report = coverageReport(seen.effects, records);
  return {
    available: true,
    reason: seen.reason ?? null,
    observed: report.observed,
    covered: report.covered,
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
  // APRV-145. Three streaks now, one shape. The per-task streak of SPEC.md
  // §10.2 keeps its `task` field and its meaning; the two harness scopes of the
  // amended §10.2 report their scope KEY in that same field, so it stays a
  // non-empty string an operator can grep the log for and every pre-existing
  // consumer reads the three fields it always read. `scope` is the additive
  // field that says which derivation produced the key.
  //
  // APRV-280 adds `clears`, additively: an escalated scope is a repository state
  // an operator has to get OUT of, and a row that names the scope without naming
  // the exit is a row that sends them to the source. The sentence is
  // `core/loop.ts`'s own, so `status`, the gate's refusals and the hook's denies
  // cannot come to disagree about what recovery is.
  const escalations = [
    ...loopEscalation(records)
      .filter((state) => state.escalated)
      .map((state) => ({
        task: state.task,
        scope: "task",
        consecutive_failures: state.consecutiveFailures,
        escalated: true,
        clears: loopClearance("task", state.task),
      })),
    ...harnessLoopEscalation(records)
      .filter((state) => state.escalated)
      .map((state) => ({
        task: state.key,
        scope: state.scope,
        consecutive_failures: state.consecutiveFailures,
        escalated: true,
        clears: loopClearance(state.scope, state.key),
      })),
  ];
  // Informational, and deliberately outside `healthy` and the exit code, for the
  // reason the timestamp anomalies below are: this is a coverage measurement,
  // not an integrity verdict. A persistently high `unreported` is how an
  // operator learns the post-execution hook is not installed or not firing.
  const harnessOutcomes = harnessOutcomeCoverage(records);
  // APRV-245, and informational for the reason directly above: the same rule,
  // applied to a witness this project does not write. `harness outcomes` counts
  // the tool calls the runtime was told about; this counts the commits git saw
  // whether or not anybody told the runtime anything.
  const coverage = gitCoverageSummary(records, flags, cwd);
  // APRV-127. The reconciliation backlog: obligations opened by a retrospective
  // DENIAL and not yet discharged by a person. It counts toward `healthy` for
  // the same reason a dangling execution does — an unreconciled denial is a "no"
  // that has so far changed nothing, and a "no" nobody can see is the failure
  // the whole retrospective path exists to prevent. Quiet here would mean a
  // human said an action should not have happened and the system moved on.
  const obligations = openObligations(records).map((item) => ({
    seq: item.seq,
    ts: item.ts,
    action_key: item.actionKey,
    task: item.task,
    class: item.class,
    obligation: item.obligation,
    review_seq: item.reviewSeq,
  }));
  // APRV-214, amended SPEC.md §5.2. An open window is a suspension of the
  // policy for every gated tool call under this root, so it belongs in the one
  // report an operator reads to answer "is this repository in a normal state".
  // It counts toward `healthy` DELIBERATELY: a CI check or a `doctor` run keyed
  // on `healthy` should go red while a bypass stands, and a window nobody
  // noticed was left open is the failure mode of the whole feature.
  const gateWindow = openGateWindow(records);
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
    // established the fate of, and a repo carrying one is not healthy; an open
    // reconciliation obligation is a denial nobody has answered for yet.
    indeterminate.length === 0 &&
    escalations.length === 0 &&
    obligations.length === 0 &&
    gateWindow === null;

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
      harness_outcomes: harnessOutcomes,
      // APRV-245. Always present, so every consumer sees the same four keys
      // whether or not this directory is a checkout, and outside `healthy` and
      // the exit code for the APRV-145 reason stated where it is computed.
      coverage: {
        available: coverage.available,
        reason: coverage.reason,
        observed: coverage.observed,
        covered: coverage.covered,
      },
      reconciliation: obligations,
      payload_store: payloadStore,
      ...(anomalies.length === 0 ? {} : { anomalies }),
      // Present only while a window stands, exactly as `anomalies` and
      // `indeterminate` are: a repository with no window emits the object it
      // has always emitted, byte for byte.
      ...(gateWindow === null
        ? {}
        : {
            gate_window: {
              seq: gateWindow.seq,
              opened_at: gateWindow.openedAt,
              opened_by: gateWindow.openedBy,
              reason: gateWindow.reason,
              expires_at: gateWindow.expiresAt,
              bypassed: gateWindow.bypassCount,
            },
          }),
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
              // APRV-280: the scope, then the way out. The clearing sentence is
              // long and it earns its line — an operator reading this row is
              // looking at a repository where a floor is routing everything to a
              // phone, and the next thing they need is what ends that.
              under: escalations.flatMap((entry) => [
                entry.scope === "task"
                  ? `${entry.task} (${entry.consecutive_failures} consecutive failed side-effecting executions, task) — escalated to manual`
                  : `${entry.task} (${entry.consecutive_failures} consecutive failed side-effecting tool calls, ${entry.scope}) — escalated to manual`,
                st.muted(`  clears: ${entry.clears}`),
              ]),
            }),
      },
      {
        // APRV-145. Its own INFORMATIONAL row, because the append-nothing rule
        // of the counterpart is otherwise invisible: a harness start with no
        // outcome is not debris, it is a tool call nobody reported on, and the
        // number is how an operator sees that the post-execution hook is dark.
        left: "harness outcomes",
        right: st.muted(
          `${harnessOutcomes.started} started, ${harnessOutcomes.reported} reported, ${harnessOutcomes.unreported} unreported`,
        ),
      },
      {
        // APRV-245, and INFORMATIONAL for the APRV-145 reason the row above is:
        // a coverage measurement is not an integrity verdict, so it moves
        // neither `healthy` nor the exit code. What it counts is this branch's
        // own commits, as git recorded them, against the verified log. The full
        // report, `gh` and the adapters included, is `approval coverage`.
        left: "git coverage",
        right: st.muted(
          coverage.available
            ? `${String(coverage.covered)} of ${String(coverage.observed)} effects carry evidence`
            : (coverage.reason ?? "unavailable"),
        ),
      },
      {
        // APRV-214. Its own row and not a footnote: while this says OPEN, the
        // policy is deciding nothing for the harness, and the person reading
        // this report is the person who can end that.
        left: "gate window",
        right:
          gateWindow === null
            ? st.muted("closed")
            : st.warn(
                `OPEN until ${gateWindow.expiresAt}, opened by ${gateWindow.openedBy}, ${String(gateWindow.bypassCount)} call(s) bypassed`,
              ),
        ...(gateWindow === null
          ? {}
          : {
              under: [
                `seq ${String(gateWindow.seq)}  reason: ${gateWindow.reason}`,
                "every gated tool call under this root is allowed without approval — `approval gate close`",
              ],
            }),
      },
      {
        left: "reconciliation",
        right:
          obligations.length === 0
            ? st.muted("none open")
            : st.fail(`${obligations.length} UNRECONCILED DENIAL(S)`),
        ...(obligations.length === 0
          ? {}
          : {
              under: obligations.map(
                (item) =>
                  `seq ${item.seq}  ${item.action_key}  ${item.class}  ${item.obligation} — close with \`approval audit reconcile ${item.seq}\``,
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
 * Injected seams for `execution resolve`. `prompter` is the terminal, exactly
 * as `gate open`'s is: a test passes a scripted one and asserts on what was
 * asked as well as on what was done, and passing `null` is how "there is no
 * terminal" becomes a test rather than a claim.
 */
export interface ResolveDeps {
  prompter?: Prompter | null;
}

/** One dangling execution as `--dangling` lists it. */
interface DanglingCandidate {
  actionKey: string;
  task: string | null;
  ts: string;
  seq: number;
  /** The declared class, from `task.registered` and never from a payload claim. */
  cls: string | null;
  /** The ref that carries the seq this key names, or `null`. */
  provenBy: string | null;
  /** The seq the key names, when it is one of the daemon's advance keys. */
  toSeq: number | null;
}

/** The manual command for a key nothing can prove, spelled once. */
function manualResolveCommand(actionKey: string): string {
  return `approval execution resolve ${actionKey} --outcome completed|failed --note "<what you observed>"`;
}

/**
 * The note a bulk resolution writes, which is the evidence and not a summary.
 *
 * It names the ref, the seq that ref carries, and the fact that the operator
 * confirmed it after being shown exactly that. A human-attested record whose
 * note said only "closed in bulk" would be the unexplained attestation the
 * single form refuses, arriving five at a time.
 */
function sweptNote(entry: DanglingCandidate): string {
  return `${entry.actionKey} named seq ${String(entry.toSeq)}, which ${String(
    entry.provenBy,
  )} carries in this checkout, so the action it was authorized for completed. Confirmed against that evidence and closed with \`${RESOLVE_DANGLING_COMMAND}\`.`;
}

/**
 * `approval execution resolve --dangling [--class <class>] [--yes] [--json]`
 *
 * The bulk form, and the manual step it removes (APRV-264). On 2026-09-05
 * `approval status` listed five dangling daemon advance executions left by the
 * 2026-09-02 loop; the daemon refused one advance per tick naming one key each,
 * and Carter closed all five by hand with five near-identical commands in a
 * second terminal window. The cadence exists to remove taps, and this was five
 * of them for one fact.
 *
 * What it does NOT do is decide anything the single form would not. Every rule
 * of `resolve` is intact: human-only, one `execution.completed` per key through
 * {@link resolveExecution}'s own compare-and-append, `exit_code: null`,
 * `attested_by_human: true`, and a mandatory non-empty note — generated here
 * rather than typed, because what it has to say is the evidence the runtime
 * showed the operator and the operator agreed with, which is a sentence a
 * person retyping it five times would only ever get less exact.
 *
 * The evidence is the trunk. A key is provable when it is one of the daemon's
 * own advance keys and a ref in this checkout carries the seq that key names
 * (`core/advance-cycle.ts`'s rule, read through the same `publishedState` the
 * daemon and the doctor row read). Everything else is UNPROVABLE and is left
 * exactly alone, listed with the one-line manual command: an outcome nobody can
 * demonstrate is a person's to go and look at, and a bulk verb that guessed at
 * one would be writing five guesses instead of one.
 *
 * One confirmation, on a terminal. Without a terminal it refuses
 * (`dangling-stdin-not-tty`) unless `--yes` is passed, which is the flag a
 * runbook uses after it has read the same list with `--json`. `--json` on its
 * own still asks, because the list and the question are the whole of what makes
 * this safe.
 */
function resolveDangling(
  streams: Streams,
  cwd: string,
  front_: Front,
  actor: string,
  deps: ResolveDeps,
): number {
  const { flags, json, logPath } = front_;

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);
  const read = readVerifiedRecords(logPath);
  if (!read.ok) return emitRefusal(streams, json, read);

  const classFilter = stringFlag(flags, "--class");
  const index = indexDeclarations(read.records);
  // The LOG's repository, exactly as the `log-advance-cadence` doctor row asks
  // it: the refs that can prove anything about an advance are the ones in the
  // checkout the log lives in, which is not necessarily where the operator is
  // standing when they run this.
  const root = repoRoot(dirname(logPath)) ?? repoRoot(cwd);
  // The git read, once, for the whole list. `null` when this is not a git
  // checkout at all, in which case nothing is provable and every key is listed
  // as a person's — the fail-closed direction, and the honest one.
  const published =
    root === null
      ? { publishedSeq: 0, publishedRev: null }
      : publishedState(
          root,
          logPath,
          read.records,
          { remote: "origin", base: null },
          now(),
        );
  const proved = new Map(
    proveDanglingAdvances(read.records, published).map((entry) => [entry.actionKey, entry]),
  );

  const candidates: DanglingCandidate[] = danglingExecutions([...read.records])
    .map((entry) => {
      const advance = proved.get(entry.actionKey);
      return {
        actionKey: entry.actionKey,
        task: entry.task,
        ts: entry.ts,
        seq: entry.seq,
        cls: index.declarations.get(entry.actionKey)?.class ?? null,
        provenBy: advance?.provenBy ?? null,
        toSeq: advance?.toSeq ?? null,
      };
    })
    .filter((entry) => classFilter === null || entry.cls === classFilter);

  const provable = candidates.filter((entry) => entry.provenBy !== null);
  const unprovable = candidates.filter((entry) => entry.provenBy === null);

  const listed = candidates.map((entry) => ({
    action_key: entry.actionKey,
    task: entry.task,
    class: entry.cls,
    seq: entry.seq,
    ts: entry.ts,
    provable: entry.provenBy !== null,
    proven_by: entry.provenBy,
    proven_seq: entry.provenBy === null ? null : entry.toSeq,
    ...(entry.provenBy === null ? { fix: manualResolveCommand(entry.actionKey) } : {}),
  }));

  // Nothing to do is exit 0 and says so: an empty list is a healthy log, and a
  // repair verb that failed when there was nothing to repair would be a repair
  // verb nobody could put in a runbook.
  if (candidates.length === 0) {
    if (json) emitJson(streams, { ok: true, dangling: [], resolved: [], unresolved: [], actor });
    else {
      streams.out(
        classFilter === null
          ? "no dangling executions: every execution in this log has an outcome\n"
          : `no dangling executions in class ${classFilter}\n`,
      );
    }
    return EXIT_OK;
  }

  const st = style({ json });
  if (!json) streams.out(renderDanglingList(st, candidates));

  // The confirmation. `--yes` is the runbook's answer to it and the ONLY way
  // past it without a terminal: a prompter that fell back to a pipe would let
  // anything that can write bytes attest, on a record whose whole content is
  // that a person looked.
  if (!boolFlag(flags, "--yes")) {
    const prompter = deps.prompter === undefined ? createPrompter(streams) : deps.prompter;
    if (prompter === null) {
      return emitRefusal(
        streams,
        json,
        {
          ok: false,
          code: "dangling-stdin-not-tty",
          message: `stdin is not a terminal, so nobody can be asked to attest. ${String(
            provable.length,
          )} execution(s) would be closed as completed on this checkout's own evidence, and a human-attested outcome nobody was asked about is not an attestation. Re-run it from a terminal, or pass --yes after reading the list (\`${RESOLVE_DANGLING_COMMAND} --json\`)`,
        },
      );
    }
    if (provable.length === 0) {
      // There is nothing to confirm: the whole list is a person's to go and
      // look at, and asking a yes/no question about zero records would train an
      // operator to say yes to this prompt.
      if (json) emitJson(streams, { ok: true, dangling: listed, resolved: [], unresolved: listed.map((entry) => entry.action_key), actor });
      return EXIT_OK;
    }
    const agreed = confirmUntil(
      streams,
      prompter,
      `Close ${String(provable.length)} execution(s) as completed, attested by ${actor}?`,
      false,
    );
    if (!agreed) {
      return emitRefusal(streams, json, {
        ok: false,
        code: "dangling-declined",
        message: "nothing was appended: the confirmation was declined",
      });
    }
  }

  const resolved: { action_key: string; seq: number; proven_by: string | null }[] = [];
  const failed: { action_key: string; code: string; message: string }[] = [];
  for (const entry of provable) {
    const result = resolveExecution(logPath, entry.actionKey, "completed", sweptNote(entry), actor, {
      policy: policyLocation(flags, cwd),
    });
    if (result.ok) {
      resolved.push({
        action_key: entry.actionKey,
        seq: result.record.seq,
        proven_by: entry.provenBy,
      });
      continue;
    }
    // One refusal does not stop the sweep: the keys are independent, and a
    // fourth that cannot be closed is no reason to leave the fifth open. Every
    // refusal is reported by code, and the exit code below says some of them
    // were refused.
    failed.push({ action_key: entry.actionKey, code: result.code, message: result.message });
  }

  if (json) {
    emitJson(streams, {
      ok: failed.length === 0,
      dangling: listed,
      resolved,
      unresolved: [
        ...unprovable.map((entry) => entry.actionKey),
        ...failed.map((entry) => entry.action_key),
      ],
      ...(failed.length === 0 ? {} : { failed }),
      attested_by_human: true,
      actor,
    });
  } else {
    for (const entry of resolved) {
      streams.out(
        `resolved ${entry.action_key} as completed at seq ${String(entry.seq)} by ${actor} (human-attested, no exit code; ${String(entry.proven_by)})\n`,
      );
    }
    for (const entry of failed) {
      streams.err(`${renderRefusal(st, entry.code, `${entry.action_key}: ${entry.message}`)}\n`);
    }
    if (unprovable.length > 0) {
      streams.out(
        `${String(unprovable.length)} execution(s) were left alone: nothing in this checkout can prove how they ended, and only a person who goes and looks may say. Close each with its own command, listed above.\n`,
      );
    }
  }
  return failed.length === 0 ? EXIT_OK : EXIT_INTEGRITY;
}

/** The list, as a person reads it: what is provable, by what, and what is not. */
function renderDanglingList(st: Style, candidates: readonly DanglingCandidate[]): string {
  const rows: TableRow[] = candidates.map((entry) => ({
    left: entry.actionKey,
    right:
      entry.provenBy === null
        ? st.fail("nothing proves how it ended")
        : st.ok(`${entry.provenBy} carries seq ${String(entry.toSeq)}`),
    under: [
      `seq ${String(entry.seq)}  ${entry.ts}  ${entry.cls ?? "class undeclared"}${
        entry.task === null ? "" : `  ${entry.task}`
      }`,
      ...(entry.provenBy === null ? [manualResolveCommand(entry.actionKey)] : []),
    ],
  }));
  return `${st.table(rows)}\n`;
}

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
 *
 * `--dangling` is the bulk form of the same verb ({@link resolveDangling}): the
 * whole list, one confirmation, one record per key the checkout can prove.
 */
export function commandResolve(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: ResolveDeps = {},
): number {
  const outcomeFront = front(
    argv,
    {
      ...COMMON_FLAGS,
      "--outcome": "string",
      "--note": "string",
      "--as": "string",
      "--dangling": "boolean",
      "--class": "string",
      "--yes": "boolean",
    },
    RESOLVE_HELP,
    streams,
    cwd,
  );
  if (outcomeFront.kind === "handled") return outcomeFront.code;
  const { flags, positionals, json, logPath } = outcomeFront;

  // The actor is settled before the two forms diverge: both write a
  // human-attested record and neither may be performed by an agent.
  const asFlag0 = stringFlag(flags, "--as");
  const actor0 = resolveHumanActor(asFlag0 === null ? {} : { actor: asFlag0 });

  const bulk = boolFlag(flags, "--dangling");
  const actionKey = positionals[0];
  if (bulk) {
    if (actionKey !== undefined) {
      return usageError(
        streams,
        json,
        `--dangling takes no <action-key>: it acts on every dangling execution the log holds, and naming one is the single form (drop --dangling). Got ${JSON.stringify(actionKey)}`,
        RESOLVE_HELP,
      );
    }
    if (stringFlag(flags, "--outcome") !== null || stringFlag(flags, "--note") !== null) {
      return usageError(
        streams,
        json,
        "--dangling takes neither --outcome nor --note: it records `completed` for exactly the keys this checkout can prove completed, and writes each note from that evidence. Nothing is inferred for a key nothing proves — those are listed and left alone",
        RESOLVE_HELP,
      );
    }
    if (actor0 === null) {
      return usageError(
        streams,
        json,
        asFlag0 === null
          ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
          : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag0)}; resolve records what a person observed and an agent: or system: actor cannot perform it`,
        RESOLVE_HELP,
      );
    }
    return resolveDangling(streams, cwd, outcomeFront, actor0, deps);
  }
  if (stringFlag(flags, "--class") !== null || boolFlag(flags, "--yes")) {
    return usageError(
      streams,
      json,
      "--class and --yes belong to the bulk form: they select and confirm a LIST, and the single form already names its one key and takes its one note. Add --dangling, or drop them",
      RESOLVE_HELP,
    );
  }

  if (actionKey === undefined) {
    return usageError(
      streams,
      json,
      "missing <action-key> argument (or --dangling for every dangling execution at once)",
      RESOLVE_HELP,
    );
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
export function commandExecution(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: ResolveDeps = {},
): number {
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
  if (sub === "resolve") return commandResolve(rest, streams, cwd, deps);
  if (sub === "reconcile") return commandReconcile(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval execution\``,
    EXECUTION_HELP,
  );
}
