/**
 * `approval hook` — the harness adapter of SPEC.md §10.5's neighbourhood
 * (APRV-82): a Claude Code PreToolUse hook that puts the gate in front of the
 * commands an agent's harness runs directly.
 *
 * The problem it closes. Until this verb, the runtime gated what went through
 * `approval run`. Everything the harness executed on its own — `git push`, `gh
 * pr create`, `npm install`, `curl` — bypassed APPROVAL.md entirely, so the
 * enforcement of those classes was the prose in CLAUDE.md and an agent's
 * willingness to read it. That is exactly the AGENTS.md failure SPEC.md §2
 * critiques, reproduced inside the repository that critiques it.
 *
 * As everywhere else in this CLI, **no logic lives here.** Classification is
 * `core/command-class.ts` (pure, fixture-tested); registration, policy
 * resolution and intake are `core/gate.ts`; the decision is derived from the
 * verified log by `core/state.ts`. This file reads one JSON object from stdin,
 * calls those, and prints one JSON object back.
 *
 * Four choices are load-bearing enough to state plainly.
 *
 * **It exits 0 with a verdict, or 2 with nothing.** Claude Code reads a hook's
 * stdout as a decision only on exit 0; a hook that exits 2 is a *block* with the
 * stderr text as the reason, and any other non-zero code is a non-blocking
 * error. So every classified or decided outcome — allow and deny alike — is an
 * exit 0 with `hookSpecificOutput` on stdout, and the only exit 2 is a
 * misconfigured hook (an unknown flag, a bad identity), where blocking is the
 * correct failure mode. No new exit code is added to the frozen table.
 *
 * **Never `ask`.** The permission decision vocabulary includes `ask`, which
 * hands the question to the harness's own prompt. Using it would answer an
 * approval question outside the log: no request, no record, no audit trail, and
 * a human deciding in a UI the policy never named. The hook allows or denies,
 * and every deny carries a machine-readable code.
 *
 * **Fail closed on every axis.** An unreadable policy, an unreachable log, a
 * command the classifier cannot read, a wait that times out: all deny. A hook
 * that fell back to allow when it could not reach the gate would be worst
 * precisely when it mattered.
 *
 * **The harness executes, not the runtime.** The hook decides *before* the tool
 * runs and never spawns anything, so there is no `execution.started` /
 * `execution.completed` pair to write here — the runtime did not execute the
 * command and must not claim it did. What the log records is the approval
 * lifecycle: `task.registered`, `approval.requested`, and the human's decision.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import {
  classifyCommand,
  GATE_SELF_CLASS,
  isProtectedPath,
  type CommandClassification,
} from "../core/command-class.js";
import { register, request, type GateOptions } from "../core/gate.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy, parseDuration } from "../core/policy-load.js";
import { resolve as resolvePolicy } from "../core/policy-match.js";
import { readVerifiedRecords, requestState } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { HOOK_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";

/** Identity accepted for the proposing side: a person or an agent. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

/** Default wait, chosen to sit inside Claude Code's own 60s hook default. */
const DEFAULT_TIMEOUT = "55s";

/** Poll interval for the decision wait. */
const DEFAULT_INTERVAL_MS = 1_000;

/** How much of the command line goes in the (claimed) summary field. */
const SUMMARY_LIMIT = 160;

/**
 * The closed set of hook denial codes, frozen in the sense
 * `GATE_REFUSAL_CODES` is: the reason string a human reads and an agent
 * branches on starts with one of these.
 *
 * `hook-gate-refused` is a family: the emitted code is
 * `hook-gate-refused:<gate refusal code>`, so the gate's own frozen vocabulary
 * reaches the caller unflattened.
 */
export const HOOK_DENY_CODES = [
  /** No rule covers some segment of the command line. */
  "hook-unclassified",
  /** A construct whose effect cannot be read off the text (`bash -c`, `eval`). */
  "hook-opaque",
  /** The command line could not be tokenized at all. */
  "hook-unparseable",
  /** A human rejected the request. */
  "hook-rejected",
  /** A previously granted request was withdrawn. */
  "hook-revoked",
  /** The request's TTL lapsed before a decision. */
  "hook-expired",
  /** The wait elapsed with the request still undecided. */
  "hook-timeout",
  /** The gate refused intake; the gate's own code follows a colon. */
  "hook-gate-refused",
  /** The policy could not be loaded, so no class can be resolved. */
  "hook-policy-unavailable",
  /** Malformed hook input, or a log/filesystem fact that stopped the check. */
  "hook-io",
] as const;

export type HookDenyCode = (typeof HOOK_DENY_CODES)[number];

/** Tools whose input names a file rather than a command line. */
const FILE_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const COMMON_FLAGS: Record<string, FlagKind> = {
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

function usageError(streams: Streams, message: string): number {
  streams.err(`approval: ${message}\n\n${HOOK_HELP}\n`);
  return EXIT_USAGE;
}

/** Where policy lives, from `--policy` / `--dir`, with the CLI's cwd default. */
function gateOptions(flags: Record<string, string | boolean>, cwd: string): GateOptions {
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  if (policyFlag !== null) return { policy: { file: absolute(policyFlag, cwd) } };
  return { policy: { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) } };
}

// ===========================================================================
// Hook output
// ===========================================================================

type Permission = "allow" | "deny";

/**
 * The PreToolUse decision object Claude Code reads from stdout.
 *
 * One shape, one place: the hook's whole contract with the harness is this
 * object plus exit 0, and a second construction site is a second thing to keep
 * in step with the harness's schema.
 */
function decision(permission: Permission, reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: permission,
      permissionDecisionReason: reason,
    },
  })}\n`;
}

function allow(streams: Streams, reason: string): number {
  streams.out(decision("allow", reason));
  return EXIT_OK;
}

function deny(streams: Streams, code: string, detail: string): number {
  streams.out(decision("deny", `${code}: ${detail}`));
  return EXIT_OK;
}

// ===========================================================================
// Hook input
// ===========================================================================

interface HookInput {
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

type ParsedInput = { ok: true; input: HookInput } | { ok: false; detail: string };

/**
 * Parse the PreToolUse JSON.
 *
 * Deliberately tolerant about fields the decision does not depend on and strict
 * about the two it does (`tool_name`, and `tool_input.command` for Bash). The
 * `description` field is NEVER read: it is authored by the agent being gated,
 * and a gate that read the subject's own account of its intent would be letting
 * a self-reported field reduce scrutiny (SPEC.md §11.1).
 */
function parseHookInput(raw: string): ParsedInput {
  if (raw.trim().length === 0) return { ok: false, detail: "hook stdin was empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    return {
      ok: false,
      detail: `hook stdin is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: "hook stdin is not a JSON object" };
  }
  const fields = parsed as Record<string, unknown>;
  const toolName = readString(fields, "tool_name");
  if (toolName === null) return { ok: false, detail: "hook input has no tool_name" };
  const toolInputValue = fields["tool_input"];
  const toolInput =
    typeof toolInputValue === "object" && toolInputValue !== null && !Array.isArray(toolInputValue)
      ? (toolInputValue as Record<string, unknown>)
      : {};
  return {
    ok: true,
    input: {
      sessionId: readString(fields, "session_id") ?? "unknown-session",
      cwd: readString(fields, "cwd") ?? "",
      toolName,
      toolInput,
      toolUseId: readString(fields, "tool_use_id"),
    },
  };
}

// ===========================================================================
// hook classify
// ===========================================================================

function renderClassification(result: CommandClassification, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  if (!result.ok) {
    return `${result.code}: ${result.detail}\n  segment: ${result.segment}\n`;
  }
  const lines = result.segments.map(
    (segment) => `${segment.class}\t${segment.rule}\t${segment.text}`,
  );
  lines.push(`classes: ${result.classes.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `approval hook classify <command…>` — what the classifier makes of a command.
 *
 * Everything after `--` is the command verbatim, which is how a command with
 * its own flags is passed without this parser claiming them.
 */
function commandClassify(argv: string[], streams: Streams): number {
  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator + 1);

  const parsed = parseFlags(head, { ...COMMON_FLAGS, "--json": "boolean" });
  if (!parsed.ok) {
    return usageError(
      streams,
      `${parsed.message}; flags belonging to the command being classified must follow \`--\``,
    );
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${HOOK_HELP}\n`);
    return EXIT_OK;
  }

  const command = [...parsed.positionals, ...tail].join(" ").trim();
  if (command.length === 0) {
    return usageError(streams, "missing <command> argument for `approval hook classify`");
  }

  streams.out(renderClassification(classifyCommand(command), boolFlag(parsed.flags, "--json")));
  return EXIT_OK;
}

// ===========================================================================
// hook claude-code
// ===========================================================================

/** What the gate was asked about: one class, one action key. */
interface GatedAction {
  cls: string;
  actionKey: string;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * The class a non-Bash tool call carries, or `null` when it is pass-through.
 *
 * Only one thing about a file edit is a gate question at v0.1: whether the file
 * is one only a human may write. Everything else the harness edits is
 * `files.write.workspace`, which this repository's policy makes autonomous, and
 * routing every keystroke of ordinary editing through a gate check would spend
 * latency to reach a foregone conclusion.
 */
function fileToolClass(toolInput: Record<string, unknown>): string | null {
  const path = readString(toolInput, "file_path") ?? readString(toolInput, "notebook_path");
  if (path === null) return null;
  return isProtectedPath(path) ? "policy.edit" : null;
}

interface HookRun {
  logPath: string;
  options: GateOptions;
  actor: string;
  timeoutMs: number;
  intervalMs: number;
  /** `defaults.approval_ttl`, or `null` when the policy declares none. */
  ttlMs: number | null;
}

/**
 * The gated half: register one envelope, request every class, wait for the
 * decisions. Returns the exit code of whatever verdict it printed.
 */
function gateAndWait(
  streams: Streams,
  run: HookRun,
  input: HookInput,
  classes: string[],
  command: string,
): number {
  const nonce = input.toolUseId ?? randomBytes(8).toString("hex");
  const task = `hook:${input.sessionId}:${nonce}`;
  const payload = { command, cwd: input.cwd };
  const hash = payloadHash(payload);
  const summary = truncate(command, SUMMARY_LIMIT);

  const actions: GatedAction[] = classes.map((cls) => ({
    cls,
    actionKey: `${task}:${cls}`,
  }));

  const envelope = {
    origin: { app: "claude-code-hook", created_by: run.actor },
    state: "proposed",
    actions: actions.map((action) => ({
      class: action.cls,
      summary,
      idempotency_key: action.actionKey,
      payload_hash: hash,
    })),
  };

  const registered = register(run.logPath, { task, envelope }, run.actor, run.options);
  if (!registered.ok) {
    return deny(streams, `hook-gate-refused:${registered.code}`, registered.message);
  }

  const pendingKeys: string[] = [];
  for (const action of actions) {
    const result = request(
      run.logPath,
      {
        task,
        actionKey: action.actionKey,
        cls: action.cls,
        summary,
        payload_hash: hash,
        payload: { value: payload },
      },
      run.actor,
      run.options,
    );
    if (!result.ok) {
      return deny(streams, `hook-gate-refused:${result.code}`, result.message);
    }
    if (result.record !== null) pendingKeys.push(action.actionKey);
  }

  if (pendingKeys.length === 0) {
    // Every class resolved supervised: intake recorded no request (amended
    // SPEC.md §6.3), so there is nothing to wait for.
    return allow(streams, `granted: ${classes.join(", ")} needs no approval under this policy`);
  }

  const deadline = Date.now() + run.timeoutMs;

  for (;;) {
    const read = readVerifiedRecords(run.logPath);
    if (!read.ok) return deny(streams, "hook-io", read.message);

    const ts = new Date().toISOString();
    // Only the keys this invocation requested count. Deriving the set from
    // the log again would let an empty or foreign result read as "nothing
    // pending" and fall through to allow; the verified log must show every
    // one of our keys granted before the hook says yes.
    const states = pendingKeys.map(
      (key) => requestState(read.records, key, ts, run.ttlMs).state,
    );

    if (!states.includes("requested")) {
      // Precedence, as `approval wait` fixes it: a human's "no" outranks a
      // lapse, and both outrank "everything was granted".
      if (states.includes("rejected")) {
        return deny(streams, "hook-rejected", `a human rejected ${task}`);
      }
      if (states.includes("revoked")) {
        return deny(streams, "hook-revoked", `approval for ${task} was withdrawn`);
      }
      if (states.includes("expired")) {
        return deny(streams, "hook-expired", `the request for ${task} lapsed before a decision`);
      }
      if (states.every((state) => state === "granted")) {
        return allow(streams, `granted: ${task} (${classes.join(", ")})`);
      }
      return deny(
        streams,
        "hook-io",
        `the verified log does not show every request for ${task} as granted (states: ${states.join(", ")})`,
      );
    }

    if (Date.now() >= deadline) {
      return deny(
        streams,
        "hook-timeout",
        `no decision on ${task} within the hook's wait; the request stays live until its TTL, but a retried tool call is a new request, so a late grant on this one authorizes nothing`,
      );
    }
    sleepSync(Math.min(run.intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/** The verb body, wrapped by {@link commandHookClaudeCode}'s try/catch. */
function runClaudeCodeHook(
  argv: string[],
  streams: Streams,
  cwd: string,
  readStdin: () => string,
): number {
  const parsed = parseFlags(argv, {
    ...COMMON_FLAGS,
    ...POLICY_FLAGS,
    "--log": "string",
    "--as": "string",
    "--timeout": "string",
    "--interval": "string",
  });
  if (!parsed.ok) return usageError(streams, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${HOOK_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const asFlag = stringFlag(parsed.flags, "--as");
  const actor = asFlag ?? "agent:claude-code";
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return usageError(
      streams,
      `--as expects agent:<id> or human:<id>, got ${JSON.stringify(asFlag)}`,
    );
  }

  const timeoutText = stringFlag(parsed.flags, "--timeout") ?? DEFAULT_TIMEOUT;
  const timeoutMs = parseDuration(timeoutText);
  if (timeoutMs === null) {
    return usageError(
      streams,
      `--timeout expects a duration like 30s, 9m (SPEC.md §5.2 grammar), got ${JSON.stringify(timeoutText)}`,
    );
  }
  const intervalText = stringFlag(parsed.flags, "--interval");
  const intervalMs = intervalText === null ? DEFAULT_INTERVAL_MS : parseDuration(intervalText);
  if (intervalMs === null) {
    return usageError(
      streams,
      `--interval expects a duration like 500ms, 2s, got ${JSON.stringify(intervalText)}`,
    );
  }

  const parsedInput = parseHookInput(readStdin());
  if (!parsedInput.ok) return deny(streams, "hook-io", parsedInput.detail);
  const input = parsedInput.input;

  // What is being asked for, as one or more classes.
  let classes: string[];
  let command: string;
  if (input.toolName === "Bash") {
    const raw = readString(input.toolInput, "command");
    if (raw === null) {
      return deny(streams, "hook-io", "Bash tool_input carries no command string");
    }
    command = raw;
    const classified = classifyCommand(raw);
    if (!classified.ok) {
      return deny(
        streams,
        `hook-${classified.code}`,
        `${classified.detail} (segment: ${classified.segment}). Rewrite it as a command the classifier can read, or run the effect through \`approval run\` with a granted token.`,
      );
    }
    classes = classified.classes.filter((cls) => cls !== GATE_SELF_CLASS);
  } else if (FILE_TOOLS.includes(input.toolName)) {
    const cls = fileToolClass(input.toolInput);
    if (cls === null) return allow(streams, `${input.toolName} is not a gated edit`);
    classes = [cls];
    command = `${input.toolName} ${readString(input.toolInput, "file_path") ?? readString(input.toolInput, "notebook_path") ?? ""}`;
  } else {
    return allow(streams, `${input.toolName} is not a gated tool`);
  }

  if (classes.length === 0) {
    return allow(streams, "the approval CLI is the gate itself and is not gated by it");
  }

  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const options = gateOptions(parsed.flags, cwd);

  // An unloadable policy resolves everything to manual, and a manual request
  // needs a log this hook may not be pointed at. Fail closed and say so, rather
  // than opening a request nobody configured a channel for.
  const load = loadPolicy(
    options.policy?.file === undefined
      ? { dir: options.policy?.dir ?? cwd }
      : { file: options.policy.file },
  );
  if (!load.ok) {
    return deny(
      streams,
      "hook-policy-unavailable",
      `${load.code}: ${load.message}; every class resolves to manual and the hook cannot verify a decision`,
    );
  }

  const autonomous = classes.every(
    (cls) => resolvePolicy(load, cls).autonomy === "autonomous",
  );
  if (autonomous) {
    // Nothing is appended: an autonomous action has no approval lifecycle
    // (amended SPEC.md §6.3), and writing one here would fill the log with the
    // agent's every `ls`.
    return allow(streams, `autonomous: ${classes.join(", ")}`);
  }

  return gateAndWait(
    streams,
    { logPath, options, actor, timeoutMs, intervalMs, ttlMs: load.durations.approvalTtlMs },
    input,
    classes,
    command,
  );
}

function commandHookClaudeCode(
  argv: string[],
  streams: Streams,
  cwd: string,
  readStdin: () => string,
): number {
  try {
    return runClaudeCodeHook(argv, streams, cwd, readStdin);
  } catch (cause) {
    // A hook that throws is a hook Claude Code treats as a non-blocking error,
    // which would let the command through. Every unexpected failure becomes an
    // ordinary deny instead.
    return deny(
      streams,
      "hook-io",
      `the hook failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

// ===========================================================================
// Dispatch
// ===========================================================================

/** Read the whole of stdin, synchronously. */
function defaultStdin(): string {
  return readFileSync(0, "utf8");
}

export function commandHook(
  argv: string[],
  streams: Streams,
  cwd: string,
  readStdin: () => string = defaultStdin,
): number {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined) {
    return usageError(streams, "missing subcommand for `approval hook`");
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${HOOK_HELP}\n`);
    return EXIT_OK;
  }

  switch (sub) {
    case "claude-code":
      return commandHookClaudeCode(rest, streams, cwd, readStdin);
    case "classify":
      return commandClassify(rest, streams);
    default:
      return usageError(streams, `unknown subcommand ${JSON.stringify(sub)} for \`approval hook\``);
  }
}
