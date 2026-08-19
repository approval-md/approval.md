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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import {
  classifyCommand,
  GATE_SELF_CLASS,
  isProtectedPath,
  type CommandClassification,
} from "../core/command-class.js";
import { register, request, withdraw, type GateOptions } from "../core/gate.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy, parseDuration } from "../core/policy-load.js";
import { resolve as resolvePolicy } from "../core/policy-match.js";
import { readVerifiedRecords, requestState } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { HOOK_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH } from "./paths.js";
import { refusal as renderRefusal, style, table, type Style } from "./style.js";
import { usageErrorText } from "./usage.js";

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
  /**
   * No log exists where the hook was pointed. The hook is a WRITER to an
   * existing log, never an initializer: creating one where it happens to stand
   * (an agent worktree, say) forks a chain off the real log's tail, and git
   * merges do not reconcile hash chains (APRV-101).
   */
  "hook-log-unreachable",
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
  streams.err(usageErrorText(message, HOOK_HELP));
  return EXIT_USAGE;
}

/**
 * The primary checkout containing `cwd`, or `null` when git cannot say.
 *
 * `git rev-parse --git-common-dir` names the SHARED git directory: in a linked
 * worktree it is the primary checkout's `.git`, in a plain checkout it is this
 * checkout's own (printed as bare `.git` at the top level, absolute from a
 * subdirectory). Either way the primary root is its parent, so a plain checkout
 * resolves to itself.
 *
 * Run exactly as `amend.ts` runs git: `spawnSync`, no shell, and every failure
 * is a value. When git is absent, or `cwd` is not a repository at all, this
 * returns `null` and the caller falls back to `cwd` — today's behaviour, which
 * is what a non-git deployment of the hook has always relied on.
 */
function primaryRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  const common = result.stdout.trim();
  if (common.length === 0) return null;
  return dirname(absolute(common, cwd));
}

/** Where the hook reads policy from and appends to, resolved together. */
interface HookScope {
  logPath: string;
  /** The directory `logPath` sits under, named in the unreachable-log detail. */
  root: string;
  options: GateOptions;
}

/**
 * Policy and log, resolved from the same root (APRV-101).
 *
 * Before this, `--dir` scoped only the policy and the log was resolved from the
 * process cwd, so a hook invoked with `--dir <primary>` from an agent worktree
 * read the primary's policy and wrote the worktree's copy of the log: a
 * dead-end chain that forks from the real one. Explicit flags still win
 * (`--policy` for the policy, `--log` for the log); otherwise both follow
 * `--dir`, and with no flags at all both follow the primary checkout.
 */
function hookScope(flags: Record<string, string | boolean>, cwd: string): HookScope {
  const policyFlag = stringFlag(flags, "--policy");
  const logFlag = stringFlag(flags, "--log");
  const dirFlag = stringFlag(flags, "--dir");

  const root =
    dirFlag !== null ? absolute(dirFlag, cwd) : (primaryRoot(cwd) ?? cwd);
  const options: GateOptions =
    policyFlag === null
      ? { policy: { dir: root } }
      : { policy: { file: absolute(policyFlag, cwd) } };
  const logPath = logFlag === null ? join(root, DEFAULT_LOG_PATH) : absolute(logFlag, cwd);
  return { logPath, root, options };
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

/**
 * What the classifier made of a command (APRV-91 #9).
 *
 * Human output is an aligned three-column table under a `key` header row; the
 * command text and the rule name are copyable and stay undressed. `--json`
 * emits the classification object unchanged, and asks for the style FIRST so
 * that the `json` veto on colour is the answer this process memoizes.
 */
export function renderClassification(
  result: CommandClassification,
  json: boolean,
  st: Style = style({ json }),
): string {
  if (json) return `${JSON.stringify(result)}\n`;
  if (!result.ok) {
    // APRV-102: the shared refusal shape rather than a second copy of it. The
    // segment is a copyable value on its own line, which is what `refusal`'s
    // optional second line is for.
    return `${renderRefusal(st, result.code, result.detail)}\n  ${st.key("segment:")} ${result.segment}\n`;
  }

  const rows = result.segments.map((segment) => [segment.class, segment.rule, segment.text]);
  return `${table(st, rows, { header: ["class", "rule", "command"] })}\n\n${st.key(
    "classes:",
  )} ${result.classes.join(", ")}\n`;
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
 * Withdraw every still-pending key this invocation opened (APRV-106).
 *
 * BEST EFFORT, always. The caller has already decided what verdict it is
 * printing; this only decides whether a human is still going to be asked about
 * it. A withdrawal that refuses is reported on stderr and changes nothing —
 * including the case that matters most, `already-decided`, which means a human
 * answered while this was running and their answer must not be touched.
 *
 * The `requested` filter is not an optimization. `withdraw` refuses a decided
 * request anyway, so re-checking here is belt and braces; what it buys is a
 * quiet stderr in the ordinary "the human already answered" race.
 *
 * Returns the keys actually withdrawn, for the deny reason.
 */
function withdrawPending(run: HookRun, streams: Streams, keys: readonly string[], why: string): string[] {
  const withdrawn: string[] = [];
  for (const key of keys) {
    const result = withdraw(run.logPath, key, run.actor, {
      ...run.options,
      reason: "timeout",
      note: why,
    });
    if (result.ok) {
      withdrawn.push(key);
      continue;
    }
    if (result.code === "already-decided" || result.code === "request-withdrawn") continue;
    streams.err(
      `approval: the hook could not withdraw ${key} (${result.code}): ${result.message}\n`,
    );
  }
  return withdrawn;
}

/**
 * The gated half: register one envelope, request every class, wait for the
 * decisions. Returns the exit code of whatever verdict it printed.
 *
 * ## Why the wait ends in a withdrawal (APRV-106)
 *
 * Before this, a wait that elapsed left the request pending for the policy's
 * whole TTL. That is what produced the 2026-08-19 incident: the hook denied a
 * `git commit --amend` after nine minutes, the request sat in the queue for
 * twenty-four hours, the human was pinged half an hour later and approved it,
 * and the grant authorized nothing at all — a retried tool call is a new
 * request with a new key, so there was no longer any process that could consume
 * the answer. Human attention is the audit budget (SPEC.md §11), and it was
 * spent on a question whose asker had left.
 *
 * So every path out of the wait that is not a decision retracts the request
 * first: the timeout, the thrown error, and a SIGTERM or SIGINT arriving
 * mid-wait. The signal handlers are installed for the duration of the wait
 * ONLY, and removed in `finally`: a hook process is short-lived and borrowing
 * the harness's signal disposition for longer than the loop would be a
 * side effect nobody asked for.
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

  // APRV-106. Both fields are recorded on every request this verb opens, and
  // both are about what happens AFTER the human looks at their phone.
  //
  // `wait_until` is the deadline a channel shows the approver: "requester waits
  // until 09:23 UTC". It is claimed, display-only, and gates nothing.
  //
  // `execution: "harness"` says a grant here mints no execution token. The hook
  // answers allow/deny and Claude Code runs the command; nothing ever calls
  // `approval run`, so a minted token would be a live credential with no
  // spender. It removes capability from the requester and grants none.
  const waitUntil = new Date(Date.now() + run.timeoutMs).toISOString();

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
        execution: "harness",
        wait_until: waitUntil,
      },
      run.actor,
      run.options,
    );
    if (!result.ok) {
      // Whatever was already opened is retracted before the deny: a refusal on
      // the third class must not leave the first two standing in a queue that
      // no process is waiting on any more.
      withdrawPending(run, streams, pendingKeys, `intake refused ${action.actionKey}; this invocation is not waiting for a decision`);
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

  // A signal arriving mid-wait is the same fact as the timeout — this process
  // is going away and will consume no decision — so it is answered the same
  // way. `process.exit` is deliberate and immediate: the default disposition
  // for these signals is to die, and a handler that only withdrew would leave
  // the hook wedged in its poll loop with the harness waiting on it.
  const onSignal = (signal: NodeJS.Signals): void => {
    withdrawPending(
      run,
      streams,
      pendingKeys,
      `the requesting hook process received ${signal} while waiting; it can no longer consume a decision`,
    );
    process.exit(EXIT_USAGE);
  };
  const onTerm = (): void => onSignal("SIGTERM");
  const onInt = (): void => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  try {
    for (;;) {
      const read = readVerifiedRecords(run.logPath);
      if (!read.ok) {
        withdrawPending(run, streams, pendingKeys, `the hook could not read the log while waiting on ${task}`);
        return deny(streams, "hook-io", read.message);
      }

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
        // lapse, and both outrank "everything was granted". A withdrawal sits
        // with the refusals: it is not a decision, but it is terminal, and it
        // means this key will never be granted.
        if (states.includes("rejected")) {
          return deny(streams, "hook-rejected", `a human rejected ${task}`);
        }
        if (states.includes("revoked")) {
          return deny(streams, "hook-revoked", `approval for ${task} was withdrawn`);
        }
        if (states.includes("withdrawn")) {
          return deny(
            streams,
            "hook-withdrawn",
            `the request for ${task} was withdrawn before a decision; nothing is pending and nothing was authorized`,
          );
        }
        if (states.includes("expired")) {
          return deny(streams, "hook-expired", `the request for ${task} lapsed before a decision`);
        }
        if (states.every((state) => state === "granted")) {
          return allow(streams, `granted: ${task} (${classes.join(", ")})`);
        }
        // Not a wait outcome: the log disagrees with itself about keys this
        // process opened. Nothing is retracted, because the state that would
        // justify retracting is the state that could not be established.
        return deny(
          streams,
          "hook-io",
          `the verified log does not show every request for ${task} as granted (states: ${states.join(", ")})`,
        );
      }

      if (Date.now() >= deadline) {
        // APRV-106, the whole point of the task. The deny is returned either
        // way; what changes is whether a human is woken up for a question this
        // process has already answered for itself.
        const withdrawn = withdrawPending(
          run,
          streams,
          pendingKeys,
          `the hook's ${String(run.timeoutMs)}ms wait elapsed; this tool call was denied and a retried one is a new request, so a decision here can no longer authorize anything`,
        );
        return deny(
          streams,
          "hook-timeout",
          withdrawn.length === pendingKeys.length
            ? `no decision on ${task} within the hook's wait. The request(s) were WITHDRAWN, so nobody will be asked about a tool call this hook has already denied; a retried tool call is a new request and gets a fresh one.`
            : `no decision on ${task} within the hook's wait, and ${String(pendingKeys.length - withdrawn.length)} request(s) could not be withdrawn — they stay live until their TTL, and a late grant on one authorizes nothing, because a retried tool call is a new request`,
        );
      }
      sleepSync(Math.min(run.intervalMs, Math.max(0, deadline - Date.now())));
    }
  } catch (cause) {
    // The thrown path. `commandHookClaudeCode` turns this into an ordinary
    // deny, so from the human's side it is the timeout case with a different
    // reason: this process is not going to consume a decision, and it says so
    // before it stops.
    withdrawPending(
      run,
      streams,
      pendingKeys,
      `the requesting hook process failed while waiting (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    throw cause;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
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
      `--timeout expects a duration like 30s, 9m, got ${JSON.stringify(timeoutText)}`,
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

  const { logPath, root, options } = hookScope(parsed.flags, cwd);

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

  // Past here the hook appends. It writes to a log that already exists and
  // creates none: a log the hook scaffolded where it happened to be standing
  // would be a second chain, forked from the real one's tail, and hash chains
  // do not survive a merge. An initialized-but-empty `.approval/log/` counts as
  // reachable — an audit trail that has recorded nothing is an empty log, not a
  // missing one (see `preflightLog`) — and `register` appends the first line.
  if (!existsSync(logPath) && !existsSync(dirname(logPath))) {
    return deny(
      streams,
      "hook-log-unreachable",
      `no log at ${logPath}; the hook writes to an existing log and never creates one. Run \`approval init\` (then \`approval policy attest\`) in ${root}, or pass --log <path> to point the hook at the log that already exists`,
    );
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
