/**
 * `approval hook` — harness adapters that put the gate in front of the commands
 * an agent's harness runs directly (APRV-82 Claude Code, APRV-133 Cursor).
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
 * precisely when it mattered. Since APRV-139 that includes an unattested
 * policy: a verdict nobody is asked about is checked against the verified log
 * first, exactly as `core/execute.ts` checks one (see `unattendedGuard`).
 *
 * **The harness executes, not the runtime.** The hook decides *before* the tool
 * runs and never spawns anything, so it never writes an `execution.completed`
 * or `execution.failed`: the runtime does not run the command and never learns
 * how it went. It does write one `execution.started`, and only where a verdict
 * of `allow` rests on a human's grant — that record is the *consumption* of the
 * grant (APRV-117), which a harness request needs because it mints no token
 * that could be spent instead. `core/gate.ts`'s `consumeHarnessGrant` is where
 * that lives and why. What the log records is otherwise the approval lifecycle:
 * `task.registered`, `approval.requested`, and the human's decision.
 *
 * **A decision outlives the invocation that asked for it (APRV-117).** Requests
 * are matched by the payload hash of `{command, cwd}`, so the answer to "may I
 * run these bytes, here" belongs to the bytes rather than to one tool-use id.
 * A retry while the question is pending adopts it instead of asking twice; a
 * retry after a grant lands proceeds on it, once, inside the TTL. That is why
 * the wait no longer ends in a withdrawal: a late tap now authorizes something.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePathSegments,
  sep,
} from "node:path";

import { attestationRefusal, checkAttestation } from "../core/attest.js";
import {
  classifyCommand,
  GATE_SELF_CLASS,
  isProtectedPath,
  type CommandClassification,
} from "../core/command-class.js";
import {
  consumeHarnessGrant,
  findHarnessCarry,
  register,
  request,
  startHarnessExecution,
  withdraw,
  type GateOptions,
} from "../core/gate.js";
import { isLoopEscalated } from "../core/loop.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy, parseDuration } from "../core/policy-load.js";
import { resolve as resolvePolicy } from "../core/policy-match.js";
import { readVerifiedRecords, requestState, type WithdrawReason } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { primaryRoot as resolvePrimaryRoot } from "./git-scope.js";
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

/**
 * How much of the command line goes in the (claimed) summary field.
 *
 * A HEADLINE, and only that (APRV-124). What the approver is bound to is the
 * payload, which carries the whole command (or the whole change) and is never
 * shortened; this is the one-line label above it. Exported because the tests
 * pin the distinction.
 */
export const SUMMARY_LIMIT = 160;

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
  /**
   * The request was withdrawn before a decision landed (APRV-106). Since
   * APRV-117 the timeout no longer produces this: what does is a session that
   * ended mid-wait (signal or failure) and an operator's `approval withdraw`.
   * Terminal, and not a refusal by anyone.
   */
  "hook-withdrawn",
  /**
   * The wait elapsed with the request still undecided. The request STAYS OPEN
   * until the policy's TTL (APRV-117): a decision inside that window authorizes
   * a retry of the identical command in the identical directory, once.
   */
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
 *
 * APRV-125 gave the resolution two more callers (`log sync` and `log advance`,
 * which refuse outside the primary rather than falling back), so the
 * implementation moved to `cli/git-scope.ts`. This alias keeps the hook reading
 * the same answer they read.
 */
const primaryRoot = resolvePrimaryRoot;

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

/** Which harness JSON envelope to print. Never `ask`. */
type HarnessKind = "claude-code" | "cursor";

interface HarnessAdapter {
  kind: HarnessKind;
  originApp: string;
  defaultActor: string;
  shellTool: string;
  fileTools: readonly string[];
}

const CLAUDE_ADAPTER: HarnessAdapter = {
  kind: "claude-code",
  originApp: "claude-code-hook",
  defaultActor: "agent:claude-code",
  shellTool: "Bash",
  fileTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
};

const CURSOR_ADAPTER: HarnessAdapter = {
  kind: "cursor",
  originApp: "cursor-hook",
  defaultActor: "agent:cursor",
  shellTool: "Shell",
  fileTools: ["Write", "Delete"],
};

/**
 * The decision object the harness reads from stdout.
 *
 * Claude Code wants the nested PreToolUse envelope. Cursor native hooks want
 * `{permission, user_message, agent_message}`. One construction site per
 * harness, still never `ask`.
 */
function decision(permission: Permission, reason: string, harness: HarnessKind): string {
  if (harness === "cursor") {
    return `${JSON.stringify({
      permission,
      user_message: reason,
      agent_message: reason,
    })}\n`;
  }
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: permission,
      permissionDecisionReason: reason,
    },
  })}\n`;
}

function allow(streams: Streams, reason: string, harness: HarnessKind): number {
  streams.out(decision("allow", reason, harness));
  return EXIT_OK;
}

function deny(streams: Streams, code: string, detail: string, harness: HarnessKind): number {
  streams.out(decision("deny", `${code}: ${detail}`, harness));
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
// History-rewrite refinement (APRV-108)
// ===========================================================================

/*
 * Rewriting history nobody else holds is a commit.
 *
 * `vcs.history.rewrite` exists to guard SHARED history: a force push, a rebase
 * of a branch other people have pulled, an amend of a commit that is already on
 * the remote. An agent amending its own unpublished worktree branch destroys
 * nothing anyone can observe, and pricing that at a human's attention spends the
 * audit budget SPEC.md §11 asks to protect on a non-event.
 *
 * The classifier cannot answer this, and deliberately does not try: it is pure,
 * and "is this branch published" is a fact about a checkout, not about a string.
 * So the refinement lives HERE, in the impure layer that already runs git
 * (`primaryRoot`, APRV-101), and is applied to the classifier's output rather
 * than folded into it. `classifyCommand` keeps returning `vcs.history.rewrite`
 * for these verbs, its fixture table keeps meaning what it says, and everything
 * environment-dependent is in one named step a reader can audit.
 *
 * What downgrades, and only this:
 *
 *  - the branch has NO upstream at all — nothing was ever published from it, so
 *    no rewrite of it can reach anyone else; or
 *  - the command is `git commit --amend` and HEAD is not reachable from the
 *    upstream — the one commit an amend rewrites has not been pushed.
 *
 * What never downgrades: anything push-side (`git push --force` and friends),
 * a detached HEAD, the repository's default branch, a rebase or reset whose
 * target the text does not name (a `git reset --hard HEAD~5` on a branch with an
 * upstream may well be rewriting published commits, and the text cannot say), and
 * every case where git declines to answer. Fail closed on each: a wrong
 * downgrade removes a human from a decision that needed one, and a wrong
 * `rewrite` costs one approval prompt.
 */

/**
 * Classifier rules whose rewrite is LOCAL, and so can be refined.
 *
 * `git-push-force` is deliberately absent: a push is a rewrite of the remote by
 * construction, whatever this checkout's branch state is.
 */
const LOCAL_REWRITE_RULES: readonly string[] = [
  /** `git commit --amend`. */
  "git-commit-amend",
  /** `git reset --hard`. */
  "git-reset-hard",
  /** `git rebase` / `filter-branch` / `filter-repo` (the table row's own id). */
  "git-rewrite",
];

/** The one rule whose rewritten commit is exactly HEAD. */
const AMEND_RULE = "git-commit-amend";

/** The rule name a refined segment reports, in `hook classify` and in tests. */
const REWRITE_UNPUBLISHED_RULE = "rewrite-unpublished";

const REWRITE_CLASS = "vcs.history.rewrite";
const UNPUBLISHED_CLASS = "vcs.commit.branch";

/** Trimmed stdout of a successful git command, or `null` for any failure. */
function gitOutput(cwd: string, args: readonly string[]): string | null {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * `git merge-base --is-ancestor` as three values, not two.
 *
 * Exit 0 is yes and exit 1 is no; every other exit (a missing ref, a broken
 * repository, no git at all) is `null`, which the caller reads as "stay a
 * rewrite" rather than as "no".
 */
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean | null {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    encoding: "utf8",
  });
  if (result.error !== undefined) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/**
 * Is this the branch a rewrite must never be quiet about?
 *
 * `main` and `master` always count, whatever the remote says, so a local-only
 * repository (and a branch someone named `main` in a scratch checkout) is
 * covered. `refs/remotes/origin/HEAD` adds the remote's own answer when it is
 * set, which is how a repository whose trunk is `develop` or `trunk` is read.
 */
function isDefaultBranch(cwd: string, branch: string): boolean {
  if (branch === "main" || branch === "master") return true;
  const head = gitOutput(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (head === null || head.length === 0) return false;
  return head.replace(/^refs\/remotes\/origin\//u, "") === branch;
}

/** How far the current branch has been published. */
type RewriteReach =
  /** Published, unreadable, default, or detached: no refinement. */
  | { kind: "shared" }
  /** The branch tracks nothing; nothing on it was ever published. */
  | { kind: "no-upstream"; branch: string }
  /** The branch tracks `upstream`, but HEAD has not reached it. */
  | { kind: "head-unpushed"; branch: string; upstream: string };

/**
 * Ask git how far the checkout at `cwd` has been published.
 *
 * Every step that cannot be answered returns `shared`, which refines nothing.
 * `for-each-ref` rather than `@{u}` on purpose: `rev-parse @{u}` exits non-zero
 * both when there is no upstream and when the repository cannot be read, and
 * those two must not collapse — one downgrades, the other must not.
 */
function rewriteReach(cwd: string): RewriteReach {
  const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // No git, not a repository, or a detached HEAD (which prints `HEAD`): a
  // detached rewrite has no branch whose publication could be checked.
  if (branch === null || branch.length === 0 || branch === "HEAD") return { kind: "shared" };
  if (isDefaultBranch(cwd, branch)) return { kind: "shared" };

  // Exits 0 and prints an empty line when the branch tracks nothing, so an
  // empty result is a real answer and a failure is not.
  const upstream = gitOutput(cwd, [
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  ]);
  if (upstream === null) return { kind: "shared" };
  if (upstream.length === 0) return { kind: "no-upstream", branch };

  // An upstream is configured. HEAD reachable from it (or unanswerable, e.g. a
  // tracking ref that was never fetched) stays a rewrite.
  return isAncestor(cwd, "HEAD", upstream) === false
    ? { kind: "head-unpushed", branch, upstream }
    : { kind: "shared" };
}

/** A classification plus a human-readable note for every segment refined. */
export interface RefinedClassification {
  result: CommandClassification;
  /** One line per downgraded segment; empty when nothing was refined. */
  notes: string[];
}

/**
 * Downgrade local rewrites of unpublished history to `vcs.commit.branch`.
 *
 * IMPURE by design and by contract: it runs git in `cwd`. Both callers pass the
 * same directory the hook itself resolves from, so what `hook classify` prints
 * is what `hook claude-code` decides.
 */
export function refineRewrite(result: CommandClassification, cwd: string): RefinedClassification {
  if (!result.ok) return { result, notes: [] };
  const refinable = result.segments.some(
    (segment) => segment.class === REWRITE_CLASS && LOCAL_REWRITE_RULES.includes(segment.rule),
  );
  if (!refinable) return { result, notes: [] };

  const reach = rewriteReach(cwd);
  if (reach.kind === "shared") return { result, notes: [] };

  const notes: string[] = [];
  const segments = result.segments.map((segment) => {
    if (segment.class !== REWRITE_CLASS || !LOCAL_REWRITE_RULES.includes(segment.rule)) {
      return segment;
    }
    // With an upstream, only an amend is narrow enough to be sure: it rewrites
    // HEAD and nothing else. A rebase or reset names a base the text cannot
    // resolve, so it may reach commits that ARE on the upstream.
    if (reach.kind === "head-unpushed" && segment.rule !== AMEND_RULE) return segment;
    notes.push(
      reach.kind === "no-upstream"
        ? `${REWRITE_UNPUBLISHED_RULE}: branch ${reach.branch} has no upstream, so \`${segment.text}\` rewrites only unpublished history`
        : `${REWRITE_UNPUBLISHED_RULE}: HEAD is not yet on ${reach.upstream}, so \`${segment.text}\` amends only unpublished history`,
    );
    return { ...segment, class: UNPUBLISHED_CLASS, rule: REWRITE_UNPUBLISHED_RULE };
  });
  if (notes.length === 0) return { result, notes };

  const classes: string[] = [];
  for (const segment of segments) {
    if (!classes.includes(segment.class)) classes.push(segment.class);
  }
  return { result: { ok: true, segments, classes }, notes };
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
 *
 * It reads the policy for the same reason `hook claude-code` does (APRV-107):
 * `policy.protected_paths` widens what counts as `policy.edit`, and an explainer
 * that answered from the built-ins alone would tell an agent a gated file is
 * ungated. `--dir` / `--policy` scope it exactly as they scope the hook. This
 * verb decides nothing and writes nothing, so an unreadable policy is not a
 * refusal here: it classifies against the built-ins and says on stderr that the
 * answer is the narrow one.
 */
function commandClassify(argv: string[], streams: Streams, cwd: string): number {
  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator + 1);

  const parsed = parseFlags(head, { ...COMMON_FLAGS, ...POLICY_FLAGS, "--json": "boolean" });
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

  const { options } = hookScope(parsed.flags, cwd);
  const load = loadPolicy(
    options.policy?.file === undefined
      ? { dir: options.policy?.dir ?? cwd }
      : { file: options.policy.file },
  );
  if (!load.ok) {
    streams.err(
      `note: no policy read (${load.code}: ${load.message}); classifying against the built-in protected paths only\n`,
    );
  }
  const protectedPaths = load.ok ? (load.policy.protected_paths ?? []) : [];

  // The same impure refinement `hook claude-code` applies (APRV-108), run
  // against the same directory: an explainer that printed the pure class where
  // the hook decides a refined one would be explaining a different program.
  streams.out(
    renderClassification(
      refineRewrite(classifyCommand(command, protectedPaths), cwd).result,
      boolFlag(parsed.flags, "--json"),
    ),
  );
  return EXIT_OK;
}

// ===========================================================================
// hook claude-code
// ===========================================================================

/**
 * What the gate was asked about: one class, one action key, and where that
 * key's authorization comes from (APRV-117).
 */
interface GatedAction {
  cls: string;
  actionKey: string;
  /**
   * `new` — this invocation opened the request.
   * `adopted` — an earlier invocation asked the same question about the same
   * bytes and it is still pending; this one waits out the remainder.
   * `carried` — an earlier invocation's question was answered `grant`, inside
   * the TTL, and nothing has spent it yet.
   */
  origin: "new" | "adopted" | "carried";
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

// ===========================================================================
// File tools: the change, and which checkout it lands in (APRV-124)
// ===========================================================================

/**
 * The rule a protected-path file touch reports, on the SAME class.
 *
 * Two tiers, one class. A `policy.edit` inside an agent worktree is a branch
 * PROPOSAL: the file it writes is a copy on a branch, and the merge that makes
 * it real is separately gated (`vcs.push.main`, `gh pr merge`). A `policy.edit`
 * in the live checkout is the file itself. The approver was being told the same
 * thing about both, which is the "truthful label" half of this task.
 *
 * The distinction is deliberately NOT a class and NOT an autonomy: policy
 * semantics are untouched here, both tiers resolve exactly as `policy.edit`
 * resolves today, and APRV-127 is where sampling may hang off the difference.
 * What changes is what the human reads.
 */
const PROTECTED_PATH_RULE = "protected-path";
const PROTECTED_PATH_PROPOSAL_RULE = "protected-path-proposal";

/** Where agent worktrees live, relative to the primary root. */
const WORKTREE_DIR = [".claude", "worktrees"] as const;

/** `realpathSync`, as a value. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * `path` with every existing ancestor resolved through its symlinks.
 *
 * A `Write` names a file that need not exist yet, and a comparison of an
 * unresolved path against a resolved root answers "no" for the wrong reason on
 * any machine where the checkout sits under a symlink (`/tmp` on macOS, every
 * home directory behind an automounter). So the deepest existing ancestor is
 * resolved and the remainder is joined back on.
 */
function resolveExisting(path: string): string | null {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    const real = realOrNull(current);
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(current);
    if (parent === current) return null;
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The agent worktree `target` sits inside, or `null` for everything else.
 *
 * FAIL CLOSED, on every axis: anything not *provably* inside
 * `<primary>/.claude/worktrees/<name>/…` is live-tier, because a wrong
 * "proposal" tells a human their APPROVAL.md edit is a branch copy when it is
 * the live file, and a wrong "live" costs nothing but a sterner sentence.
 *
 * The primary root comes from `primaryRoot`, i.e. from git run in the hook's
 * OWN process directory (APRV-108's discipline). The harness-supplied `cwd`
 * field is never consulted: it is authored by the party under oversight, and a
 * tier that could be chosen by the subject of the gate is not a tier.
 */
function proposalWorktree(target: string, cwd: string): string | null {
  const root = primaryRoot(cwd);
  if (root === null) return null;
  const base = resolveExisting(join(root, ...WORKTREE_DIR));
  if (base === null) return null;
  const file = resolveExisting(target);
  if (file === null || !file.startsWith(`${base}${sep}`)) return null;
  const rest = file.slice(base.length + 1).split(sep);
  // `rest[0]` is the worktree; a target that IS the worktrees directory or a
  // worktree root names no file inside one and stays live-tier.
  const name = rest[0];
  return name === undefined || name.length === 0 || rest.length < 2 ? null : name;
}

/** What a gated file tool call asks for: one class, its bytes, its headline. */
interface FileGate {
  cls: string;
  rule: string;
  /** The target, absolute and resolved from the hook's own directory. */
  file: string;
  /** The worktree this proposal lands in, or `null` for a live edit. */
  worktree: string | null;
  /** The binding bytes: the change, not the touch. */
  payload: Record<string, unknown>;
  summary: string;
}

/**
 * What a non-Bash tool call asks for, or `null` when it is pass-through.
 *
 * Only one thing about a file edit is a gate question at v0.1: whether the file
 * is one only a human may write. Everything else the harness edits is
 * `files.write.workspace`, which this repository's policy makes autonomous, and
 * routing every keystroke of ordinary editing through a gate check would spend
 * latency to reach a foregone conclusion.
 *
 * ## The payload is the change (APRV-124)
 *
 * It used to be `{command: "Edit <path>", cwd}` — the *touch*. A human reading
 * that was asked to approve "an edit to CI config", with no way to tell a typo
 * fix from a disabled test job; the observed complaint (2026-08-20) is exactly
 * "I don't know what the actual CI edit is". The PreToolUse event carries the
 * whole change, so the payload does too:
 *
 * - `Edit` → `{tool, rule, file, before, after}` (plus `replace_all` when the
 *   call sets it, because "replace every occurrence" is part of what is being
 *   approved and two calls differing only in it are two different questions);
 * - `Write` → `{tool, rule, file, content}`;
 * - every other file tool → the same head plus its `tool_input` verbatim under
 *   `input`, which renders as JSON rather than as a diff but hides nothing.
 *
 * Those bytes are what `payload_hash` binds, so the grant binds to the edit.
 * They are also what APRV-117's carryover keys on: an identical retry of the
 * identical edit hashes identically and adopts or carries the same question, a
 * changed edit is a new question, and a proposal-tier grant cannot be spent on
 * the live file because the absolute `file` differs.
 *
 * `description` is dropped on the way in: it is the agent's account of its own
 * intent, and it has no business in the bytes a human is bound to.
 */
function fileToolGate(
  toolName: string,
  toolInput: Record<string, unknown>,
  protectedPaths: readonly string[],
  cwd: string,
): FileGate | null {
  const declared =
    readString(toolInput, "file_path") ??
    readString(toolInput, "notebook_path") ??
    readString(toolInput, "path");
  if (declared === null) return null;
  if (!isProtectedPath(declared, protectedPaths)) return null;

  const file = absolute(declared, cwd);
  const worktree = proposalWorktree(file, cwd);
  const rule = worktree === null ? PROTECTED_PATH_RULE : PROTECTED_PATH_PROPOSAL_RULE;

  const head = { tool: toolName, rule, file };
  const before = toolInput["old_string"];
  const after = toolInput["new_string"];
  const content = toolInput["content"] ?? toolInput["contents"];
  const replaceAll = toolInput["replace_all"];

  let payload: Record<string, unknown>;
  if (typeof before === "string" && typeof after === "string") {
    payload =
      typeof replaceAll === "boolean"
        ? { ...head, replace_all: replaceAll, before, after }
        : { ...head, before, after };
  } else if (typeof content === "string") {
    payload = { ...head, content };
  } else {
    const input: Record<string, unknown> = { ...toolInput };
    delete input["description"];
    payload = { ...head, input };
  }

  return {
    cls: "policy.edit",
    rule,
    file,
    worktree,
    payload,
    // The tier leads the headline rather than trailing it: a summary is
    // truncated from the right, and the qualifier is the last thing that may
    // be ellipsized away (a long path is not — the payload carries it whole).
    summary:
      worktree === null
        ? `${toolName} ${file}`
        : `branch proposal (worktree ${worktree}): ${toolName} ${file}`,
  };
}

interface HookRun {
  logPath: string;
  options: GateOptions;
  actor: string;
  timeoutMs: number;
  intervalMs: number;
  /** `defaults.approval_ttl`, or `null` when the policy declares none. */
  ttlMs: number | null;
  harness: HarnessKind;
  originApp: string;
}

/**
 * Withdraw every still-pending key this invocation OPENED (APRV-106, narrowed
 * by APRV-117).
 *
 * BEST EFFORT, always. The caller has already decided what verdict it is
 * printing; this only decides whether a human is still going to be asked about
 * it. A withdrawal that refuses is reported on stderr and changes nothing —
 * including the case that matters most, `already-decided`, which means a human
 * answered while this was running and their answer must not be touched.
 *
 * Two things narrowed under APRV-117, and both are load-bearing.
 *
 * **The timeout no longer calls this.** A request keyed by payload hash can be
 * adopted by the retry, so an answer that lands after this process gave up
 * still authorizes something; retracting it would be throwing away the very
 * decision the human is about to make. What still calls this is every path
 * where nothing will retry: a signal, a thrown failure, an intake refusal that
 * dooms the whole command.
 *
 * **Only keys this invocation opened.** An ADOPTED key was requested by another
 * process, and `withdraw` is requester-only by design (APRV-106 rule 1): taking
 * back a question somebody else asked is exactly the queue-clearing the gate
 * refuses. So adopted keys are never passed here.
 *
 * Returns the keys actually withdrawn, for the deny reason.
 */
function withdrawPending(
  run: HookRun,
  streams: Streams,
  keys: readonly string[],
  why: string,
  reason: WithdrawReason = "cancelled",
): string[] {
  const withdrawn: string[] = [];
  for (const key of keys) {
    const result = withdraw(run.logPath, key, run.actor, {
      ...run.options,
      reason,
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
 * Spend every grant this verdict rests on, once each (APRV-117).
 *
 * A harness grant mints no token, so the record that it was used has to be
 * written deliberately: `consumeHarnessGrant` appends one `execution.started`
 * per key, through compare-and-append, and refuses `already-executed` if
 * anything spent it first. Called ONLY immediately before an `allow`, so a
 * verdict of deny spends nothing.
 *
 * Returns `null` on success, or the refusal that stopped it. A multi-class
 * command can consume its first key and fail on its second; the result is a
 * DENY with the first grant spent, which costs one extra prompt on the retry
 * and authorizes nothing. The reverse ordering — allow first, record later —
 * would trade that for a grant the harness used and the log never saw, so the
 * cheap failure is the correct one.
 *
 * `hash` is the binding the caller already computed over the bytes this verdict
 * is about (APRV-146). The gate requires it and compares it against what the
 * human answered: the same value keyed the carryover that found these grants, so
 * presenting it states, at the spend, the fact the match was made on.
 */
function consumeGrants(
  run: HookRun,
  keys: readonly string[],
  hash: string,
): { code: string; message: string } | null {
  for (const key of keys) {
    const spent = consumeHarnessGrant(run.logPath, key, run.actor, {
      ...run.options,
      presentedPayloadHash: hash,
    });
    if (!spent.ok) return { code: spent.code, message: `${key}: ${spent.message}` };
  }
  return null;
}

/** A refusal the unattended guard raises, shaped like every other hook deny. */
interface UnattendedRefusal {
  code: string;
  detail: string;
}

/**
 * What the runtime must establish from the VERIFIED log before the hook lets a
 * command run with no human anywhere in the loop (APRV-139).
 *
 * The hole this closes. Until this check the hook's autonomous verdict was
 * computed from the on-disk policy alone: `loadPolicy`, `resolve`, allow. No
 * attestation, no loop-escalation, nothing appended, nothing read. Because the
 * harness — not this runtime — executes the tool call on an allow,
 * `core/execute.ts`'s own guards were never reached either, so whoever could
 * write APPROVAL.md (a merge, a second agent, a branch checkout) could
 * reclassify any class to `autonomous` and the hook would let the command
 * through. SPEC.md §11.1 says the opposite: an edited policy is inoperative
 * until a human re-attests it, and the hook is an enforcement surface like any
 * other.
 *
 * The two facts checked here are exactly the two `core/execute.ts`'s
 * supervised/autonomous branch checks before it starts one, and they are
 * checked in the same order, against a log read the same way:
 *
 *  1. the live policy bytes match the latest attestation (`core/attest.ts`);
 *  2. the task is not loop-escalated (SPEC.md §10.2, `core/loop.ts`).
 *
 * **Where a failure lands.** Both refusals are the gate's own frozen codes,
 * emitted through the `hook-gate-refused:` family, and they are the verdict the
 * gated path would have printed for these classes anyway: `core/gate.ts`'s
 * `request` checks attestation before it resolves anything, and refuses a
 * non-manual class for an escalated task. Checking here rather than there means
 * the deny costs no `task.registered` — under an unattested policy every
 * autonomous command an agent runs would otherwise append one, which is a log
 * full of registrations written under rules nobody is enforcing.
 *
 * **Only where nobody is asked.** The caller runs this when EVERY class resolves
 * non-manual. A command with a manual class keeps its existing path: escalation
 * escalates *to* manual rather than closing the task (`core/loop.ts`), and
 * refusing the human's question too would leave an escalated task with no way
 * back.
 */
function unattendedGuard(
  logPath: string,
  policyPath: string,
  task: string,
): UnattendedRefusal | null {
  // The VERIFIED log, as every enforcement path reads it (SPEC.md §11.1): an
  // attestation or a failure streak read off unverified bytes is whatever the
  // last writer of the file wanted it to be.
  const read = readVerifiedRecords(logPath);
  if (!read.ok) return { code: "hook-io", detail: read.message };

  const refusal = attestationRefusal(checkAttestation(read.records, policyPath));
  if (refusal !== null) {
    return {
      code: `hook-gate-refused:${refusal.code}`,
      detail: `${refusal.message}. Until then the hook decides nothing unattended: this command would have run with no human in the loop under rules no human has vouched for.`,
    };
  }

  if (isLoopEscalated(read.records, task)) {
    return {
      code: "hook-gate-refused:loop-escalated",
      detail: `task ${task} has three consecutive execution.failed events and is escalated to manual (SPEC.md §10.2), so its unattended classes may not run. The escalation clears when an execution.completed for the task lands.`,
    };
  }

  return null;
}

/**
 * Charge and record every class of an unattended allow (APRV-141).
 *
 * One `execution.started` per class, through `core/gate.ts`, before the allow
 * is printed. Until this, a supervised or autonomous harness verdict appended
 * nothing at all, so `core/budgets.ts` charged it nothing (`daily_actions`
 * included) and `core/audit.ts` could never sample it — under Claude Code, on
 * the path that carries most of the traffic. The comment that path used to
 * carry was right that a record per agent action fills the log; APRV-141's
 * recorded decision is that an uncharged, unsampleable majority is the worse
 * of the two, and the record is kept as small as the contract allows.
 *
 * **The order is record-then-allow, and the failure is a deny.** A verdict
 * printed before the charge landed is a command that ran outside every budget,
 * which is the hole this closes. A refusal here (a budget ceiling, a head that
 * moved) therefore denies, and reaches the caller as the gate's own code.
 *
 * The autonomous classes are recorded with no `task.registered` behind them,
 * deliberately: `core/audit.ts` samples supervised executions only, so a
 * declaration would buy no oversight and would double the volume of exactly the
 * traffic this is trying not to drown the log in. The supervised classes are
 * registered already, by the caller, which is what makes them sampleable.
 */
function recordUnattended(
  run: HookRun,
  task: string,
  classes: readonly string[],
  hash: string,
): { code: string; message: string } | null {
  for (const cls of classes) {
    const started = startHarnessExecution(
      run.logPath,
      { task, actionKey: `${task}:${cls}`, cls, payload_hash: hash },
      run.actor,
      run.options,
    );
    if (!started.ok) return { code: started.code, message: `${cls}: ${started.message}` };
  }
  return null;
}

/**
 * The gated half: find what is already open for these bytes, request whatever
 * is not, wait for the decisions, spend the grants. Returns the exit code of
 * whatever verdict it printed.
 *
 * ## Requests are keyed by bytes, not by invocation (APRV-117)
 *
 * The action key is still `hook:<session>:<tool-use id>:<class>` and is still
 * unique per invocation — what changed is that intake LOOKS for an earlier
 * request about the same `{command, cwd}` before opening a new one, matching on
 * the `payload_hash` recorded on `approval.requested`. Three outcomes per class,
 * decided by `core/gate.ts`'s `findHarnessCarry`:
 *
 *  - nothing to carry: register and request, exactly as before;
 *  - a pending request: **adopt** it — wait out the remainder of this
 *    invocation's window on somebody else's key, opening nothing. The approver's
 *    phone never shows two prompts for one command, because there is only ever
 *    one question;
 *  - an unspent grant inside the TTL: **carry** it — no wait, no prompt, and
 *    the grant is spent (once) before the allow is printed.
 *
 * ## Why the wait no longer ends in a withdrawal (APRV-106, revised)
 *
 * APRV-106 retracted the request when the wait elapsed, because a retried tool
 * call was a new request with a new key and a late tap therefore authorized
 * nothing: the human spent attention on a question whose asker had left. The
 * carryover above removes the premise. A late tap now authorizes the retry, so
 * the request stays open for the policy's TTL and the timeout says so.
 *
 * What still withdraws is every path where nothing can adopt the question: a
 * SIGTERM or SIGINT (the session is going away), a thrown failure, and an intake
 * refusal partway through a multi-class command (the command cannot proceed on
 * any retry, so the classes already opened are noise in a human's queue). The
 * signal handlers are installed for the duration of the wait ONLY, and removed
 * in `finally`: a hook process is short-lived and borrowing the harness's
 * signal disposition for longer than the loop would be a side effect nobody
 * asked for.
 */
function gateAndWait(
  streams: Streams,
  run: HookRun,
  classes: string[],
  /**
   * The bytes the grant binds to: `{command, cwd}` for a Bash call, the change
   * itself for a file tool (APRV-124). Whatever this is, it is what reaches the
   * approver's FULL PAYLOAD block, complete — the summary below is a headline
   * and is the only thing here that may be shortened.
   */
  payload: unknown,
  headline: string,
  /**
   * The task id this invocation acts under, minted once by the caller
   * (APRV-139) so the loop-escalation check and the registration it may lead to
   * name the same task. Deriving it twice would mint two ids whenever
   * `tool_use_id` is absent and the random fallback runs.
   */
  task: string,
  /** The history-rewrite refinement's own words, or `""` (APRV-108). */
  note = "",
): number {
  const hash = payloadHash(payload);
  const summary = truncate(headline, SUMMARY_LIMIT);
  const sayAllow = (reason: string): number => allow(streams, reason, run.harness);
  const sayDeny = (code: string, detail: string): number =>
    deny(streams, code, detail, run.harness);

  // Intake reads the VERIFIED log, once, before anything is written: an
  // enforcement path reads nothing else (SPEC.md §11.1), and a carry decided
  // from unverified bytes would be a grant invented by whoever could write the
  // file.
  const intake = readVerifiedRecords(run.logPath);
  if (!intake.ok) return sayDeny("hook-io", intake.message);
  const intakeTs = new Date().toISOString();

  const actions: GatedAction[] = classes.map((cls) => {
    const carry = findHarnessCarry(intake.records, hash, cls, intakeTs, run.ttlMs);
    if (carry === null) return { cls, actionKey: `${task}:${cls}`, origin: "new" as const };
    return {
      cls,
      actionKey: carry.actionKey,
      origin: carry.kind === "granted" ? ("carried" as const) : ("adopted" as const),
    };
  });

  const fresh = actions.filter((action) => action.origin === "new");
  const adopted = actions.filter((action) => action.origin === "adopted");
  const carried = actions.filter((action) => action.origin === "carried");

  // Only the classes that need a new question are registered. A retry whose
  // every class carries or adopts registers no task at all — the envelope it
  // would declare already exists, under the key it is about to wait on.
  if (fresh.length > 0) {
    const envelope = {
      origin: { app: run.originApp, created_by: run.actor },
      state: "proposed",
      actions: fresh.map((action) => ({
        class: action.cls,
        summary,
        idempotency_key: action.actionKey,
        payload_hash: hash,
      })),
    };

    const registered = register(run.logPath, { task, envelope }, run.actor, run.options);
    if (!registered.ok) {
      return sayDeny(`hook-gate-refused:${registered.code}`, registered.message);
    }
  }

  // `execution: "harness"` says a grant here mints no execution token. The hook
  // answers allow/deny and Claude Code runs the command; nothing ever calls
  // `approval run`, so a minted token would be a live credential with no
  // spender. It removes capability from the requester and grants none.
  //
  // APRV-106's companion field, `wait_until`, is deliberately NOT declared any
  // more. It rendered as "requester waits until 09:23 UTC" on the approver's
  // phone, and under carryover that sentence is false: an answer after this
  // invocation stops waiting authorizes the retry. With no `wait_until` the
  // channel's own line falls back to the deadline that does govern — "expires
  // HH:MM UTC", the policy's TTL — which is now exactly the truth.
  const ownKeys: string[] = [];
  for (const action of fresh) {
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
      },
      run.actor,
      run.options,
    );
    if (!result.ok) {
      // Whatever this invocation opened is retracted before the deny: a refusal
      // on the third class dooms the command on every retry too, so the first
      // two must not stand in a queue that nothing will ever adopt.
      withdrawPending(
        run,
        streams,
        ownKeys,
        `intake refused ${action.actionKey}; this command cannot proceed, so the classes already opened for it are questions nobody needs to answer`,
      );
      return sayDeny(`hook-gate-refused:${result.code}`, result.message);
    }
    if (result.record !== null) ownKeys.push(action.actionKey);
  }

  /** Every key that must be granted before this hook says yes. */
  const waitKeys = [...adopted.map((action) => action.actionKey), ...ownKeys];
  /** Every key whose grant this verdict would spend. */
  const spendKeys = [...carried.map((action) => action.actionKey), ...waitKeys];

  /** How the allow line describes where its authorization came from. */
  const provenance =
    carried.length === 0
      ? ""
      : ` (carried: ${carried.map((action) => action.actionKey).join(", ")})`;

  if (waitKeys.length === 0) {
    if (spendKeys.length === 0) {
      // Every class resolved supervised: intake recorded no request (amended
      // SPEC.md §6.3), so there is nothing to wait for and nothing to spend.
      // What there is, since APRV-141, is something to charge: the start event
      // is this execution's authorization, and the registration `fresh` just
      // wrote is what makes it a sampleable one.
      const charged = recordUnattended(run, task, classes, hash);
      if (charged !== null) {
        return sayDeny(`hook-gate-refused:${charged.code}`, charged.message);
      }
      return sayAllow(
        `granted: ${classes.join(", ")} needs no approval under this policy${note}`,
      );
    }
    // Every gated class carried an unspent grant: a human already answered this
    // exact question about these exact bytes, and nobody is asked again.
    const failed = consumeGrants(run, spendKeys, hash);
    if (failed !== null) {
      return sayDeny(`hook-gate-refused:${failed.code}`, failed.message);
    }
    return sayAllow(`granted: ${classes.join(", ")}${provenance}${note}`);
  }

  const deadline = Date.now() + run.timeoutMs;

  // A signal arriving mid-wait means the session is going away: nothing will
  // retry this command, so the question this invocation opened is retracted.
  // `process.exit` is deliberate and immediate: the default disposition for
  // these signals is to die, and a handler that only withdrew would leave the
  // hook wedged in its poll loop with the harness waiting on it.
  const onSignal = (signal: NodeJS.Signals): void => {
    withdrawPending(
      run,
      streams,
      ownKeys,
      `the requesting hook process received ${signal} while waiting; the session is ending, so no retry will adopt this request`,
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
        withdrawPending(
          run,
          streams,
          ownKeys,
          `the hook could not read the log while waiting on ${task}`,
        );
        return sayDeny("hook-io", read.message);
      }

      const ts = new Date().toISOString();
      // Only the keys this invocation is waiting on count. Deriving the set
      // from the log again would let an empty or foreign result read as
      // "nothing pending" and fall through to allow; the verified log must show
      // every one of these keys granted before the hook says yes.
      const states = waitKeys.map((key) => requestState(read.records, key, ts, run.ttlMs).state);

      if (!states.includes("requested")) {
        // Precedence, as `approval wait` fixes it: a human's "no" outranks a
        // lapse, and both outrank "everything was granted". A withdrawal sits
        // with the refusals: it is not a decision, but it is terminal, and it
        // means this key will never be granted.
        if (states.includes("rejected")) {
          return sayDeny("hook-rejected", `a human rejected ${task}`);
        }
        if (states.includes("revoked")) {
          return sayDeny("hook-revoked", `approval for ${task} was withdrawn`);
        }
        if (states.includes("withdrawn")) {
          return sayDeny(
            "hook-withdrawn",
            `the request for ${task} was withdrawn before a decision; nothing is pending and nothing was authorized`,
          );
        }
        if (states.includes("expired")) {
          return sayDeny("hook-expired", `the request for ${task} lapsed before a decision`);
        }
        if (states.every((state) => state === "granted")) {
          // The grants are spent before the allow is printed, so this exact
          // command cannot ride the same authorization twice.
          const failed = consumeGrants(run, spendKeys, hash);
          if (failed !== null) {
            return sayDeny(`hook-gate-refused:${failed.code}`, failed.message);
          }
          return sayAllow(`granted: ${task} (${classes.join(", ")})${provenance}${note}`);
        }
        // Not a wait outcome: the log disagrees with itself about keys this
        // process is waiting on. Nothing is retracted, because the state that
        // would justify retracting is the state that could not be established.
        return sayDeny(
          "hook-io",
          `the verified log does not show every request for ${task} as granted (states: ${states.join(", ")})`,
        );
      }

      if (Date.now() >= deadline) {
        // APRV-117, the behaviour APRV-106 had to get wrong for want of
        // carryover. The request STAYS OPEN: a decision inside the policy's TTL
        // authorizes the retry of this exact command in this exact directory,
        // once. Withdrawing here would discard the answer the human is about to
        // give.
        return sayDeny(
          "hook-timeout",
          `no decision on ${waitKeys.join(", ")} within the hook's ${String(run.timeoutMs)}ms wait. This tool call is denied and NOTHING WAS WITHDRAWN: the request(s) stay open until the policy's approval TTL, and a decision inside that window authorizes a retry of this exact command in this exact directory, once. Retry it after the approver answers; the retry adopts the same question rather than asking a second one.`,
        );
      }
      sleepSync(Math.min(run.intervalMs, Math.max(0, deadline - Date.now())));
    }
  } catch (cause) {
    // The thrown path. `commandHarnessHook` turns this into an ordinary
    // deny. Unlike the timeout, this process cannot say what state it left
    // behind, so the question it opened is retracted rather than left standing
    // on a failure nobody diagnosed.
    withdrawPending(
      run,
      streams,
      ownKeys,
      `the requesting hook process failed while waiting (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    throw cause;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

/** The verb body, wrapped by {@link commandHarnessHook}'s try/catch. */
function runHarnessHook(
  argv: string[],
  streams: Streams,
  cwd: string,
  readStdin: () => string,
  adapter: HarnessAdapter,
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
  const actor = asFlag ?? adapter.defaultActor;
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
  if (!parsedInput.ok) return deny(streams, "hook-io", parsedInput.detail, adapter.kind);
  const input = parsedInput.input;

  if (input.toolName !== adapter.shellTool && !adapter.fileTools.includes(input.toolName)) {
    return allow(streams, `${input.toolName} is not a gated tool`, adapter.kind);
  }

  const { logPath, root, options } = hookScope(parsed.flags, cwd);

  // The policy is read BEFORE the command is classified (APRV-107): the
  // protected-path set is built-ins plus `policy.protected_paths`, so what
  // counts as `policy.edit` is a policy question and the classifier cannot be
  // asked it without the answer in hand.
  //
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
      adapter.kind,
    );
  }
  const protectedPaths = load.policy.protected_paths ?? [];

  // What is being asked for, as one or more classes.
  let classes: string[];
  /** The binding bytes, and the headline the approver's summary line carries. */
  let payload: unknown;
  let headline: string;
  /** What the history-rewrite refinement did, for the decision reason. */
  let notes: string[] = [];
  if (input.toolName === adapter.shellTool) {
    const raw = readString(input.toolInput, "command");
    if (raw === null) {
      return deny(
        streams,
        "hook-io",
        `${adapter.shellTool} tool_input carries no command string`,
        adapter.kind,
      );
    }
    // Unchanged since APRV-117, deliberately: the payload is the WHOLE command
    // and the directory it runs in, so the FULL PAYLOAD block on the phone
    // carries every byte the harness will execute. Only `summary` is shortened.
    payload = { command: raw, cwd: input.cwd };
    headline = raw;
    const classified = classifyCommand(raw, protectedPaths);
    if (!classified.ok) {
      return deny(
        streams,
        `hook-${classified.code}`,
        `${classified.detail} (segment: ${classified.segment}). Rewrite it as a command the classifier can read, or run the effect through \`approval run\` with a granted token.`,
        adapter.kind,
      );
    }
    // APRV-108: a local rewrite of history this checkout never published is a
    // commit. Runs in the hook's own cwd, after classification and never inside
    // it, and downgrades nothing it cannot establish from git.
    const refined = refineRewrite(classified, cwd);
    notes = refined.notes;
    const answer = refined.result.ok ? refined.result : classified;
    classes = answer.classes.filter((cls) => cls !== GATE_SELF_CLASS);
  } else {
    const gated = fileToolGate(input.toolName, input.toolInput, protectedPaths, cwd);
    if (gated === null) {
      return allow(streams, `${input.toolName} is not a gated edit`, adapter.kind);
    }
    classes = [gated.cls];
    payload = gated.payload;
    headline = gated.summary;
    // The tier rides in the verdict's note as well as in the payload, so an
    // `allow` says which checkout it authorized (APRV-124).
    notes = [
      gated.worktree === null
        ? `${gated.rule}: ${gated.file} is the LIVE checkout's copy`
        : `${gated.rule}: ${gated.file} is inside agent worktree ${gated.worktree}, so this is a branch proposal and the merge to the live checkout is gated separately`,
    ];
  }

  if (classes.length === 0) {
    return allow(
      streams,
      "the approval CLI is the gate itself and is not gated by it",
      adapter.kind,
    );
  }

  /** Appended to every verdict this invocation prints, when it refined one. */
  const note = notes.length === 0 ? "" : ` (${notes.join("; ")})`;

  // Every path from here needs the log, the fast paths included (APRV-139):
  // attestation and loop-escalation are facts about the log, so the
  // log-unreachable deny now sits above the autonomous verdict rather than
  // below it. A hook that could not reach the log used to allow whatever the
  // on-disk policy called autonomous; it now denies, which is the same answer
  // it already gave every other class.
  if (!existsSync(logPath) && !existsSync(dirname(logPath))) {
    return deny(
      streams,
      "hook-log-unreachable",
      `no log at ${logPath}; the hook writes to an existing log and never creates one. Run \`approval init\` (then \`approval policy attest\`) in ${root}, or pass --log <path> to point the hook at the log that already exists`,
      adapter.kind,
    );
  }

  // Minted once, here, and carried into `gateAndWait`: the loop-escalation
  // check below and any registration that follows must name the same task.
  const task = `hook:${input.sessionId}:${input.toolUseId ?? randomBytes(8).toString("hex")}`;

  const run: HookRun = {
    logPath,
    options,
    actor,
    timeoutMs,
    intervalMs,
    ttlMs: load.durations.approvalTtlMs,
    harness: adapter.kind,
    originApp: adapter.originApp,
  };

  const autonomies = classes.map((cls) => resolvePolicy(load, cls).autonomy);
  /** No class here needs a human, so nothing downstream will ask for one. */
  const unattended = autonomies.every((autonomy) => autonomy !== "manual");
  if (unattended) {
    const refused = unattendedGuard(logPath, load.source.path, task);
    if (refused !== null) return deny(streams, refused.code, refused.detail, adapter.kind);
  }

  if (autonomies.every((autonomy) => autonomy === "autonomous")) {
    // No approval lifecycle: an autonomous action has none (amended SPEC.md
    // §6.3), so nothing is requested, decided or granted here. What IS appended
    // since APRV-141 is the execution record itself — the moment the policy
    // authorized this command — because a budget the busiest path does not
    // charge is not a budget. See `recordUnattended`.
    const charged = recordUnattended(run, task, classes, payloadHash(payload));
    if (charged !== null) {
      return deny(streams, `hook-gate-refused:${charged.code}`, charged.message, adapter.kind);
    }
    return allow(streams, `autonomous: ${classes.join(", ")}${note}`, adapter.kind);
  }

  // Past here the hook appends. It writes to a log that already exists and
  // creates none: a log the hook scaffolded where it happened to be standing
  // would be a second chain, forked from the real one's tail, and hash chains
  // do not survive a merge. An initialized-but-empty `.approval/log/` counts as
  // reachable — an audit trail that has recorded nothing is an empty log, not a
  // missing one (see `preflightLog`) — and `register` appends the first line.
  return gateAndWait(
    streams,
    run,
    classes,
    payload,
    headline,
    task,
    note,
  );
}

function commandHarnessHook(
  argv: string[],
  streams: Streams,
  cwd: string,
  readStdin: () => string,
  adapter: HarnessAdapter,
): number {
  try {
    return runHarnessHook(argv, streams, cwd, readStdin, adapter);
  } catch (cause) {
    // A hook that throws is a hook the harness treats as a non-blocking error,
    // which would let the command through. Every unexpected failure becomes an
    // ordinary deny instead. Cursor additionally needs failClosed on the
    // hooks.json entry so a crash of this process still blocks.
    return deny(
      streams,
      "hook-io",
      `the hook failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      adapter.kind,
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
      return commandHarnessHook(rest, streams, cwd, readStdin, CLAUDE_ADAPTER);
    case "cursor":
      return commandHarnessHook(rest, streams, cwd, readStdin, CURSOR_ADAPTER);
    case "classify":
      return commandClassify(rest, streams, cwd);
    default:
      return usageError(streams, `unknown subcommand ${JSON.stringify(sub)} for \`approval hook\``);
  }
}
