/**
 * The history-rewrite refinement (amended SPEC.md §7, APRV-433; replaces
 * APRV-108's downgrade).
 *
 * The text classifier answers the bare `vcs.history.rewrite` for every rewrite
 * spelling and says which spelling it saw through its rule id. This step, which
 * may read the repository, maps every such segment to exactly one member:
 *
 * - `vcs.history.rewrite.local` when it PROVED, from local refs and without the
 *   network, that no commit of the rewrite's lost range is shared, that the ref
 *   it moves is not a default branch, and that the command moves no ref other
 *   than the one it names; never for a step that resumes a rebase in
 *   progress (`--continue`, `--skip`, `--abort`, `--quit`), whose target lives
 *   in state files anyone who can write the checkout can forge;
 * - `vcs.history.rewrite.shared` otherwise, including every case where a check
 *   could not run, timed out, or answered ambiguously (fail closed: a wrong
 *   `local` takes a human out of a decision that needed one, a wrong `shared`
 *   costs one prompt).
 *
 * It also promotes two spellings the text cannot show are rewrites: a bare
 * `git pull` whose configuration rebases, and a refspec-less `git push` whose
 * remote configuration forces.
 *
 * A commit is SHARED when it is reachable from a remote-tracking ref, from the
 * configured upstream of any local branch, from a pull-request ref present
 * locally (`refs/pull/*`), or from a default branch (`main`, `master`, and the
 * branch `refs/remotes/origin/HEAD` names). Every non-fast-forward update of a
 * REMOTE ref needs a push-side spelling, and every push-side spelling is
 * `.shared` unconditionally, so a wrong `local` verdict from stale local refs
 * can mislabel a rewrite in this checkout and never move a ref someone else
 * holds without the shared class.
 *
 * Each refined segment carries `history_rewrite`: the evidence the log records
 * (`reach`, `basis`, `ref`, `old_tip`, `base`, `lost`, `lost_shared`,
 * `witness`) plus `legacy_class`, the class the pre-split runtime answered for
 * the same segment in the same checkout (APRV-108's downgrade included), which
 * is what a policy with no own line of the split resolves it under.
 *
 * IMPURE by design: every git call runs in the directory the hook resolves,
 * through the credential-stripped environment the caller passes, under one
 * wall-clock budget for the whole command, and uses plumbing only.
 */

import { spawnSync } from "node:child_process";
import {
  commandLineShape,
  gitInvocationShape,
  pullRebaseMode,
  rebaseRunsStrategy,
  type ClassifiedSegment,
  type CommandClassification,
  type GitInvocationShape,
} from "../core/command-class.js";
import {
  HISTORY_REWRITE_CLASS,
  HISTORY_REWRITE_LOCAL,
  HISTORY_REWRITE_SHARED,
  type HistoryRewriteBasis,
  type HistoryRewriteSegmentEvidence,
} from "../core/policy-match.js";

/** The wall-clock budget for every git query one command needs. */
export const HISTORY_CHECK_BUDGET_MS = 1500;

/** The largest lost range counted; a larger one is shared, `range-too-large`. */
export const HISTORY_RANGE_CAP = 1000;

/** The class a segment had before the split, for the legacy fallback. */
const COMMIT_BRANCH_CLASS = "vcs.commit.branch";
const PUSH_MAIN_CLASS = "vcs.push.main";

/** Global options that change nothing about which repository git reads. */
const INERT_GLOBAL_OPTIONS: readonly string[] = [
  "--no-pager",
  "--no-optional-locks",
  "-p",
  "--paginate",
];

/**
 * Does this `NAME=value` word point git at configuration or a repository
 * other than the one the check reads? Used only for the two promoted
 * spellings; a segment the text already calls a rewrite is shared on ANY
 * assignment.
 */
function steersConfiguration(assignment: string): boolean {
  const name = assignment.slice(0, assignment.indexOf("="));
  if (name === "HOME" || name === "XDG_CONFIG_HOME") return true;
  return (
    [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_CONFIG",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
    ].includes(name) ||
    name.startsWith("GIT_CONFIG_KEY_") ||
    name.startsWith("GIT_CONFIG_VALUE_")
  );
}

/**
 * `NAME=value` words a rewrite segment may carry and still be judged local: a
 * CLOSED list, exact values only. Each one only silences a prompt or a pager
 * (`GIT_EDITOR=true git commit --amend` keeps the message without a
 * terminal); none points git at another repository, other
 * configuration, another program search path or a sequence editor. Any other
 * assignment is shared, basis `env-assignment`.
 */
const HARMLESS_ASSIGNMENTS: readonly string[] = [
  "GIT_EDITOR=true",
  "GIT_EDITOR=:",
  "EDITOR=true",
  "EDITOR=:",
  "VISUAL=true",
  "VISUAL=:",
  "GIT_TERMINAL_PROMPT=0",
  "GIT_PAGER=cat",
  "PAGER=cat",
];

/**
 * The git subcommands an EARLIER segment of the same command line may run and
 * leave a later rewrite segment judgeable: a CLOSED list. Each changes only the
 * index or the work tree, never a ref, the working directory, the environment
 * or a file under the git directory, as in `git add <file> && git commit
 * --amend`. Any other earlier segment (a `cd`,
 * an `export`, a redirect into `.git`, a script that might run git) makes the
 * rewrite shared, basis `compound-state`, because the check reads the state
 * before the command line runs.
 */
const HARMLESS_EARLIER_GIT_SUBS: readonly string[] = ["add", "rm", "status"];

/**
 * The options a plain `git rebase` may carry and still be judged local: a
 * CLOSED list, exact spellings only (APRV-433 build). git accepts any
 * unambiguous prefix of a long option, so `--inter` is `--interactive` and
 * `--exe` is `--exec`; a list of the flags to refuse would miss those, a list
 * of the flags to accept cannot. A flag outside it is shared, basis
 * `option-unvetted`. `--update-refs` is absent on purpose: it moves every
 * other branch that points into the range.
 */
const REBASE_PLAIN_FLAGS: readonly string[] = [
  "--keep-base",
  "--no-keep-base",
  "--fork-point",
  "--no-fork-point",
  "--autosquash",
  "--no-autosquash",
  "--no-update-refs",
  "--verify",
  "--no-verify",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--stat",
  "-n",
  "--no-stat",
  "--signoff",
  "--committer-date-is-author-date",
  "--ignore-date",
  "--reset-author-date",
  "--ignore-whitespace",
  "--autostash",
  "--no-autostash",
  "--reapply-cherry-picks",
  "--no-reapply-cherry-picks",
  "--keep-empty",
  "--no-keep-empty",
  "--allow-empty-message",
  "--no-ff",
  "-f",
  "--force-rebase",
  "--rerere-autoupdate",
  "--no-rerere-autoupdate",
  "-m",
  "--merge",
  "--apply",
  "--root",
  "--no-gpg-sign",
  "--gpg-sign",
  "-S",
  "--no-rebase-merges",
  "--no-reschedule-failed-exec",
];

/** Plain-rebase options whose value is the NEXT word. */
const REBASE_SEPARATE_VALUE_FLAGS: readonly string[] = [
  "--onto",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "-C",
  "--whitespace",
  "--empty",
];

/** Plain-rebase long options whose value is attached with `=`. */
const REBASE_ATTACHED_LONG: readonly string[] = [
  "--onto=",
  "--strategy=",
  "--strategy-option=",
  "--whitespace=",
  "--empty=",
  "--gpg-sign=",
];

/** Plain-rebase short options whose value is attached (`-Xtheirs`, `-C4`, `-sort`, `-Skey`). */
const REBASE_ATTACHED_SHORT: readonly string[] = ["-X", "-C", "-s", "-S"];

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A git query that could not be answered at all; the segment is shared. */
class ProbeFailure extends Error {
  constructor(readonly basis: "check-timeout" | "git-unavailable") {
    super(basis);
  }
}

/** One git invocation's outcome; `status` is the exit code. */
interface GitAnswer {
  status: number;
  stdout: string;
}

/** Runs plumbing under the shared budget. */
class Git {
  private readonly deadline: number;
  constructor(
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    budgetMs: number,
    private readonly now: () => number,
  ) {
    this.deadline = now() + budgetMs;
  }

  /** Run `git <args>`; throws {@link ProbeFailure} when it cannot answer at all. */
  run(args: readonly string[], input?: string): GitAnswer {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) throw new ProbeFailure("check-timeout");
    const result = spawnSync("git", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
      env: this.env,
      timeout: remaining,
      ...(input === undefined ? {} : { input }),
    });
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      throw new ProbeFailure(code === "ETIMEDOUT" ? "check-timeout" : "git-unavailable");
    }
    if (result.status === null) throw new ProbeFailure("check-timeout");
    return { status: result.status, stdout: result.stdout };
  }

  /** Trimmed stdout of a run that exited 0, or `null` for any other exit. */
  output(args: readonly string[], input?: string): string | null {
    const answer = this.run(args, input);
    return answer.status === 0 ? answer.stdout.trim() : null;
  }

  /** Is there budget left for a best-effort query? */
  hasBudget(): boolean {
    return this.deadline - this.now() > 0;
  }
}

/** One local branch as `for-each-ref` reports it. */
interface BranchFacts {
  /** Full name of the configured upstream, or `null` when none is configured. */
  upstream: string | null;
  /** The configured upstream no longer resolves (`[gone]`). */
  gone: boolean;
}

/** What C1 and C2 establish about the repository, once per command. */
interface RepoFacts {
  /** Full ref HEAD names (`refs/heads/x`), or `null` when detached. */
  head: string | null;
  branches: Map<string, BranchFacts>;
  /** The local branch name `refs/remotes/origin/HEAD` points at, or `null`. */
  originDefault: string | null;
}

/**
 * C1 + C2: current ref, upstream map, origin default. No rebase state file is
 * read (see `judgeResume`).
 */
function readRepoFacts(git: Git): RepoFacts {
  const c1 = git.run(["rev-parse", "--symbolic-full-name", "HEAD", "--absolute-git-dir"]);
  if (c1.status !== 0) throw new ProbeFailure("git-unavailable");
  const lines = c1.stdout.split("\n").map((line) => line.trim());
  const [headLine, gitDirLine] = lines;
  if (headLine === undefined || gitDirLine === undefined) throw new ProbeFailure("git-unavailable");

  const c2 = git.run([
    "for-each-ref",
    "--format=%(refname)%00%(upstream)%00%(upstream:track)%00%(symref)",
    "refs/heads",
    "refs/remotes/origin/HEAD",
  ]);
  if (c2.status !== 0) throw new ProbeFailure("git-unavailable");
  const branches = new Map<string, BranchFacts>();
  let originDefault: string | null = null;
  for (const line of c2.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [refname, upstream, track, symref] = line.split("\0");
    if (refname === undefined) continue;
    if (refname === "refs/remotes/origin/HEAD") {
      if (symref !== undefined && symref.startsWith("refs/remotes/origin/")) {
        originDefault = symref.slice("refs/remotes/origin/".length);
      }
      continue;
    }
    if (!refname.startsWith("refs/heads/")) continue;
    branches.set(refname, {
      upstream: upstream === undefined || upstream.length === 0 ? null : upstream,
      gone: track === "[gone]",
    });
  }
  return {
    head: headLine.startsWith("refs/heads/") ? headLine : null,
    branches,
    originDefault,
  };
}

/** Is `ref` (a full `refs/heads/` name) one of the default branches? */
function isDefaultRef(facts: RepoFacts, ref: string): boolean {
  const name = ref.slice("refs/heads/".length);
  if (name === "main" || name === "master") return true;
  return facts.originDefault !== null && facts.originDefault === name;
}

/**
 * The shared refs as `rev-list --stdin` exclusions: default branches that
 * exist locally, and every local branch's configured upstream that is itself a
 * local branch (`remote = .`). Remote-tracking refs and `refs/pull/*` are named
 * on the command line with `--remotes` and `--glob`.
 */
function sharedStdinTips(facts: RepoFacts): string[] {
  const tips = new Set<string>();
  for (const name of ["main", "master", facts.originDefault]) {
    if (name === null) continue;
    const ref = `refs/heads/${name}`;
    if (facts.branches.has(ref)) tips.add(ref);
  }
  for (const branch of facts.branches.values()) {
    if (branch.upstream === null || branch.gone) continue;
    if (branch.upstream.startsWith("refs/heads/")) tips.add(branch.upstream);
  }
  return [...tips];
}

/** C3: resolve one revision the text names to a commit id, or `null`. */
function resolveCommit(git: Git, rev: string): string | null {
  const out = git.output(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return out !== null && OBJECT_ID.test(out) ? out : null;
}

/** The evidence and pre-split class for one segment. */
type Judged = HistoryRewriteSegmentEvidence;

/** The range a rewrite would lose, before it is counted. */
interface LostRange {
  ref: string;
  oldTip: string;
  bases: string[];
  /** The basis a local verdict carries. */
  localBasis: HistoryRewriteBasis;
}

/** Shared evidence with nothing counted. */
function sharedOf(basis: HistoryRewriteBasis, legacy: string, ref: string | null = null): Judged {
  return {
    reach: "shared",
    basis,
    ref,
    old_tip: null,
    base: null,
    lost: null,
    lost_shared: null,
    witness: null,
    legacy_class: legacy,
  };
}

/** C5, C6 (with C7), and C8 on the shared path. */
function judgeRange(git: Git, facts: RepoFacts, range: LostRange, legacy: string): Judged {
  const base = range.bases[0] ?? null;
  const counted = git.output([
    "rev-list",
    "--count",
    `--max-count=${String(HISTORY_RANGE_CAP + 1)}`,
    range.oldTip,
    ...(range.bases.length === 0 ? [] : ["--not", ...range.bases]),
  ]);
  const lost = counted === null ? Number.NaN : Number.parseInt(counted, 10);
  if (!Number.isInteger(lost) || lost < 0) throw new ProbeFailure("git-unavailable");
  const evidence = (
    reach: "shared" | "local",
    basis: HistoryRewriteBasis,
    lostCount: number | null,
    lostShared: number | null,
    witness: string | null,
  ): Judged => ({
    reach,
    basis,
    ref: range.ref,
    old_tip: range.oldTip,
    base,
    lost: lostCount,
    lost_shared: lostShared,
    witness,
    legacy_class: legacy,
  });
  if (lost > HISTORY_RANGE_CAP) return evidence("shared", "range-too-large", null, null, null);
  if (lost === 0) {
    return evidence(
      "local",
  "no-commits-lost",
      0,
      0,
      null,
    );
  }

  // C7 (SHOULD): every tip the moved ref's upstream has had, so a commit that
  // was published once and rewritten out of the upstream since still counts.
  const upstream = facts.branches.get(range.ref)?.upstream ?? null;
  const exclusions = sharedStdinTips(facts).map((ref) => `^${ref}`);
  if (upstream !== null) {
    const reflog = git.run(["reflog", "show", "--format=%H", upstream, "--"]);
    if (reflog.status === 0) {
      const seen = new Set<string>();
      for (const line of reflog.stdout.split("\n")) {
        const id = line.trim();
        if (!OBJECT_ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        exclusions.push(`^${id}`);
        if (seen.size >= HISTORY_RANGE_CAP) break;
      }
    }
  }

  // C6: commits of R that no shared ref reaches. `--not` covers every
  // revision after it on the command line, `--remotes` and `--glob` included;
  // the stdin lines carry their own `^`.
  const unsharedOut = git.output(
    [
      "rev-list",
      "--count",
      range.oldTip,
      "--not",
      ...range.bases,
      "--remotes",
      "--glob=refs/pull/*",
      "--stdin",
    ],
    exclusions.length === 0 ? "" : `${exclusions.join("\n")}\n`,
  );
  const unshared = unsharedOut === null ? Number.NaN : Number.parseInt(unsharedOut, 10);
  if (!Number.isInteger(unshared) || unshared < 0 || unshared > lost) {
    throw new ProbeFailure("git-unavailable");
  }
  if (unshared === lost) return evidence("local", range.localBasis, lost, 0, null);
  return evidence("shared", "shared-commit", lost, lost - unshared, witnessOf(git, facts, range));
}

/** C8, best effort: one shared ref holding the oldest lost commit. */
function witnessOf(git: Git, facts: RepoFacts, range: LostRange): string | null {
  try {
    if (!git.hasBudget()) return null;
    const listed = git.output([
      "rev-list",
      "--reverse",
      range.oldTip,
      ...(range.bases.length === 0 ? [] : ["--not", ...range.bases]),
    ]);
    const oldest = listed?.split("\n")[0]?.trim();
    if (oldest === undefined || !OBJECT_ID.test(oldest)) return null;
    const patterns = ["refs/remotes", "refs/pull", ...sharedStdinTips(facts)];
    const found = git.output([
      "for-each-ref",
      "--count=64",
      `--contains=${oldest}`,
      "--format=%(refname)",
      ...patterns,
    ]);
    if (found === null) return null;
    // `for-each-ref` sorts by name, which puts `refs/heads/main` before any
    // remote-tracking ref. The remote's own copy is the more telling witness
    // (it is what someone else holds), so it is preferred.
    const refs = found.split("\n").filter((ref) => ref.length > 0 && !ref.endsWith("/HEAD"));
    return (
      refs.find((ref) => ref.startsWith("refs/remotes/")) ??
      refs.find((ref) => ref.startsWith("refs/pull/")) ??
      refs[0] ??
      null
    );
  } catch {
    // A witness changes no verdict, and the verdict is already shared.
    return null;
  }
}

/**
 * What APRV-108 answered for this segment: `vcs.commit.branch` for a branch
 * with no upstream, and for an amend whose HEAD is not on its upstream;
 * `vcs.history.rewrite` for everything else, every unanswerable case included.
 */
function aprv108Legacy(git: Git, facts: RepoFacts | null, rule: string): string {
  if (facts === null || facts.head === null) return HISTORY_REWRITE_CLASS;
  if (isDefaultRef(facts, facts.head)) return HISTORY_REWRITE_CLASS;
  const branch = facts.branches.get(facts.head);
  if (branch === undefined) return HISTORY_REWRITE_CLASS;
  if (branch.upstream === null) return COMMIT_BRANCH_CLASS;
  if (rule !== "git-commit-amend" || branch.gone) return HISTORY_REWRITE_CLASS;
  try {
    const answer = git.run(["merge-base", "--is-ancestor", "HEAD", branch.upstream]);
    return answer.status === 1 ? COMMIT_BRANCH_CLASS : HISTORY_REWRITE_CLASS;
  } catch {
    return HISTORY_REWRITE_CLASS;
  }
}

/** The rule ids APRV-108 refined (its `LOCAL_REWRITE_RULES`, `git-rewrite` split). */
const APRV108_RULES: readonly string[] = [
  "git-commit-amend",
  "git-reset-hard",
  "git-rebase",
  "git-rebase-interactive",
  "git-rebase-exec",
  "git-rebase-continue",
  "git-rebase-abort",
  "git-filter",
];

/** Positional words of a rebase argv, and the flags whose value is a revision. */
interface RebaseArgs {
  positionals: { word: string; unreadable: boolean }[];
  onto: { word: string; unreadable: boolean } | null;
  root: boolean;
  /** `true` for `--update-refs`, `false` for `--no-update-refs`, `null` when neither. */
  updateRefs: boolean | null;
  /** `--no-rebase-merges` was given, so `rebase.rebaseMerges` does not apply. */
  noRebaseMerges: boolean;
  /** The first option outside the closed list, or `null`. */
  unvetted: string | null;
}

function parseRebaseArgs(shape: GitInvocationShape): RebaseArgs {
  const positionals: { word: string; unreadable: boolean }[] = [];
  let onto: { word: string; unreadable: boolean } | null = null;
  let root = false;
  let updateRefs: boolean | null = null;
  let noRebaseMerges = false;
  let unvetted: string | null = null;
  let endOfOptions = false;
  for (let at = 0; at < shape.args.length; at += 1) {
    const word = shape.args[at] as string;
    const unreadable = shape.unreadable[at] === true;
    if (endOfOptions || !word.startsWith("-") || word === "-") {
      positionals.push({ word, unreadable });
      continue;
    }
    if (word === "--") {
      endOfOptions = true;
      continue;
    }
    if (word === "--root") root = true;
    if (word === "--update-refs") {
      updateRefs = true;
      continue;
    }
    if (word === "--no-update-refs") updateRefs = false;
    if (word === "--no-rebase-merges") noRebaseMerges = true;
    if (REBASE_PLAIN_FLAGS.includes(word)) continue;
    if (word.startsWith("--onto=")) {
      onto = { word: word.slice("--onto=".length), unreadable };
      continue;
    }
    if (REBASE_ATTACHED_LONG.some((prefix) => word.startsWith(prefix))) continue;
    if (REBASE_SEPARATE_VALUE_FLAGS.includes(word)) {
      const value = shape.args[at + 1];
      if (value === undefined) {
        unvetted ??= word;
        continue;
      }
      if (word === "--onto") onto = { word: value, unreadable: shape.unreadable[at + 1] === true };
      at += 1;
      continue;
    }
    if (REBASE_ATTACHED_SHORT.some((flag) => word.startsWith(flag) && word.length > flag.length)) continue;
    unvetted ??= word;
  }
  return { positionals, onto, root, updateRefs, noRebaseMerges, unvetted };
}

/**
 * Is an EARLIER segment of the command line one the check may look past?
 * Only a git invocation from {@link HARMLESS_EARLIER_GIT_SUBS}, with no
 * assignment, no global option beyond the inert ones, no word the shell could
 * change, no construct the lexer cannot read, and no write redirect other than
 * to `/dev/null`. Everything else is assumed to move the state the check reads.
 */
function harmlessBefore(text: string): boolean {
  const shape = gitInvocationShape(text);
  if (shape === null || shape.opaque) return false;
  if (shape.assignments.length > 0) return false;
  if (shape.globalOptions.some((option) => !INERT_GLOBAL_OPTIONS.includes(option))) return false;
  if (shape.sub === null || !HARMLESS_EARLIER_GIT_SUBS.includes(shape.sub)) return false;
  if (shape.unreadable.some((flag) => flag)) return false;
  return shape.writeTargets.every((target) => target === "/dev/null");
}

/**
 * The repository configuration that turns a rebase into more than a replay of
 * the range it names (APRV-433 build): `rebase.updateRefs` moves every other
 * branch pointing into the range, and `rebase.rebaseMerges` makes the rebase
 * a `--rebase-merges` one. `null` when neither applies. A configuration git
 * cannot read is shared.
 */
function rebaseConfigBlock(
  git: Git,
  explicitUpdateRefs: boolean | null,
  noRebaseMerges: boolean,
): HistoryRewriteBasis | null {
  const config = readConfig(git, "^rebase\\.(updaterefs|rebasemerges)$");
  if (config === null) throw new ProbeFailure("git-unavailable");
  const truthy = (value: string | undefined): boolean =>
    value !== undefined && !["false", "no", "off", "0"].includes(value.trim().toLowerCase());
  if (explicitUpdateRefs === null && truthy(config.get("rebase.updaterefs"))) return "updates-other-refs";
  if (!noRebaseMerges && truthy(config.get("rebase.rebasemerges"))) return "interactive";
  return null;
}

/** The rebase mode git's configuration gives a bare `git pull` on `branch`. */
function configPullMode(
  entries: Map<string, string>,
  branch: string | null,
): "rebase" | "interactive" | "merges" | null {
  const read = (value: string | undefined): "rebase" | "interactive" | "merges" | null | undefined => {
    if (value === undefined) return undefined;
    const v = value.toLowerCase();
    if (v === "false" || v === "no" || v === "off" || v === "0") return null;
    if (v === "interactive" || v === "i") return "interactive";
    if (v === "merges" || v === "m") return "merges";
    return "rebase";
  };
  const own = branch === null ? undefined : read(entries.get(`branch.${branch}.rebase`));
  if (own !== undefined) return own;
  return read(entries.get("pull.rebase")) ?? null;
}

/** `git config --get-regexp` as a map; `null` when the configuration cannot be read. */
function readConfig(git: Git, pattern: string): Map<string, string> | null {
  const answer = git.run(["config", "--get-regexp", pattern]);
  if (answer.status !== 0 && answer.status !== 1) return null;
  const entries = new Map<string, string>();
  for (const line of answer.stdout.split("\n")) {
    if (line.length === 0) continue;
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "true" : line.slice(space + 1);
    entries.set(key, value);
  }
  return entries;
}

/** A refined classification plus one note per refined segment. */
export interface HistoryRefinement {
  result: CommandClassification;
  notes: string[];
}

/** Options for {@link refineHistoryRewrite}; the defaults are the production values. */
export interface HistoryRefineOptions {
  env: Record<string, string>;
  budgetMs?: number;
  now?: () => number;
  /**
   * The whole command line, as the classifier read it. Without it a command
   * line of more than one segment cannot be shown to run its segments one
   * after another, so every rewrite segment in it is shared (`compound-state`).
   */
  command?: string;
}

/**
 * Map every rewrite segment to a member, and promote the two config-driven
 * spellings. Segments outside the family are returned untouched, and a command
 * with no such segment runs no git at all.
 */
export function refineHistoryRewrite(
  result: CommandClassification,
  cwd: string,
  options: HistoryRefineOptions,
): HistoryRefinement {
  if (!result.ok) return { result, notes: [] };
  const candidate = (segment: ClassifiedSegment): boolean =>
    segment.class === HISTORY_REWRITE_CLASS ||
    segment.rule === "git-push-implicit" ||
    (segment.rule === "git-write" && gitInvocationShape(segment.text)?.sub === "pull");
  if (!result.segments.some(candidate)) return { result, notes: [] };

  const git = new Git(cwd, options.env, options.budgetMs ?? HISTORY_CHECK_BUDGET_MS, options.now ?? Date.now);
  let facts: RepoFacts | null | undefined;
  let factsFailure: ProbeFailure | null = null;
  /** C1 + C2, once; a failure is remembered so every segment reports it. */
  const repo = (): RepoFacts => {
    if (facts === undefined) {
      try {
        facts = readRepoFacts(git);
      } catch (cause) {
        facts = null;
        factsFailure = cause instanceof ProbeFailure ? cause : new ProbeFailure("git-unavailable");
      }
    }
    if (facts === null) throw factsFailure ?? new ProbeFailure("git-unavailable");
    return facts;
  };
  const repoOrNull = (): RepoFacts | null => {
    try {
      return repo();
    } catch {
      return null;
    }
  };

  // A pipe or a background `&` runs segments at the same time, so a LATER
  // segment can change what the check reads while git reads it. And a line
  // whose classified segments do not line up one-for-one with the lexer's (a
  // wrapper spliced open, a doubled entry) cannot be shown to be sequential.
  const line = options.command === undefined ? null : commandLineShape(options.command);
  const concurrent =
    result.segments.length > 1 &&
    (line === null || line.concurrent || line.segments !== result.segments.length);

  const notes: string[] = [];
  const segments = result.segments.map((segment, index) => {
    if (!candidate(segment)) return segment;
    const judged = judgeSegment(segment, index, result.segments, concurrent, git, repo, repoOrNull);
    if (judged === null) return segment;
    notes.push(noteFor(segment, judged));
    return {
      ...segment,
      class: judged.reach === "local" ? HISTORY_REWRITE_LOCAL : HISTORY_REWRITE_SHARED,
      history_rewrite: judged,
    };
  });
  if (notes.length === 0) return { result, notes };
  const classes: string[] = [];
  for (const segment of segments) {
    if (!classes.includes(segment.class)) classes.push(segment.class);
  }
  return { result: { ok: true, segments, classes }, notes };
}

/** The evidence for one candidate segment, or `null` when it stays outside the family. */
function judgeSegment(
  segment: ClassifiedSegment,
  index: number,
  all: readonly ClassifiedSegment[],
  concurrent: boolean,
  git: Git,
  repo: () => RepoFacts,
  repoOrNull: () => RepoFacts | null,
): Judged | null {
  const shape = gitInvocationShape(segment.text);
  const promotable = segment.rule === "git-push-implicit" || segment.rule === "git-write";

  // The pre-split class. Computed before anything can fail, from APRV-108's own
  // facts, so a segment the split calls shared still resolves exactly as it
  // did under a policy that has not adopted the split.
  const legacyOf = (): string => {
    if (segment.rule === "git-push-implicit") return PUSH_MAIN_CLASS;
    if (segment.rule === "git-write" || segment.rule === "git-pull-rebase") return COMMIT_BRANCH_CLASS;
    if (!APRV108_RULES.includes(segment.rule)) return HISTORY_REWRITE_CLASS;
    return aprv108Legacy(git, repoOrNull(), segment.rule);
  };

  // Cross-cutting MUSTs (SPEC §7, APRV-433 4.4): the check reads this hook's
  // environment and this directory's repository, so a segment that names
  // another one, or whose state an earlier segment can change, is shared.
  const precheck = (): HistoryRewriteBasis | null => {
    if (shape === null) return "global-option";
    if (shape.globalOptions.some((option) => !INERT_GLOBAL_OPTIONS.includes(option))) {
      return "global-option";
    }
    if (shape.assignments.some((assignment) => !HARMLESS_ASSIGNMENTS.includes(assignment))) {
      return "env-assignment";
    }
    if (concurrent) return "compound-state";
    if (!all.slice(0, index).every((earlier) => harmlessBefore(earlier.text))) return "compound-state";
    return null;
  };

  try {
    if (promotable) {
      // A spelling the TEXT says is not a rewrite is promoted only on what the
      // configuration says, so what blocks the reading is narrower here: an
      // assignment that can point git at other configuration or another
      // repository, or a global option. `GIT_TERMINAL_PROMPT=0 git push`
      // reads the same configuration this check reads, and stays where the
      // text put it unless that configuration forces.
      const blocked =
        shape === null ||
        shape.globalOptions.some((option) => !INERT_GLOBAL_OPTIONS.includes(option)) ||
        shape.assignments.some(steersConfiguration);
      if (segment.rule === "git-push-implicit") {
        // C9: a forced refspec or a mirror in remote configuration is a force
        // push the text cannot show. Unreadable configuration leaves the
        // segment where the text put it, which is already the trunk class.
        if (blocked) return sharedOf(precheck() ?? "global-option", legacyOf());
        const config = readConfig(git, "^remote\\..*\\.(push|mirror)$");
        if (config === null) return null;
        const forced = [...config].some(
          ([key, value]) =>
            (key.endsWith(".push") && value.trim().startsWith("+")) ||
            (key.endsWith(".mirror") && value.trim().toLowerCase() === "true"),
        );
        return forced ? sharedOf("push-side", legacyOf()) : null;
      }
      // A merging `git pull`: does configuration make it a rebase?
      if (shape !== null && /--no-rebase|--rebase=(?:false|no|off|0)\b/u.test(shape.args.join(" "))) {
        return null;
      }
      if (blocked) return sharedOf(precheck() ?? "global-option", legacyOf());
      const config = readConfig(git, "^(branch\\..*\\.rebase|pull\\.rebase)$");
      if (config === null) return null;
      const anyRebase = [...config.values()].some(
        (value) => !["false", "no", "off", "0"].includes(value.toLowerCase()),
      );
      if (!anyRebase) return null;
      const facts = repo();
      const branch = facts.head === null ? null : facts.head.slice("refs/heads/".length);
      const blockedBy = precheck();
      if (blockedBy !== null) return sharedOf(blockedBy, legacyOf());
      const mode = configPullMode(config, branch);
      if (mode === null) return null;
      if (mode === "interactive" || mode === "merges") return sharedOf("interactive", legacyOf());
      return judgePullRebase(git, facts, shape as GitInvocationShape, legacyOf());
    }

    const blockedBy = precheck();
    if (blockedBy !== null) return sharedOf(blockedBy, legacyOf());
    const live = shape as GitInvocationShape;

    switch (segment.rule) {
      case "git-push-force":
        return sharedOf("push-side", legacyOf());
      case "git-filter":
        return sharedOf("whole-history", legacyOf());
      case "git-rebase-interactive":
        return sharedOf("interactive", legacyOf());
      case "git-rebase-exec":
        return sharedOf("runs-commands", legacyOf());
      case "git-rebase-abort":
        return judgeResume(legacyOf());
      case "git-pull-rebase": {
        const mode = pullRebaseMode(live.args);
        if (mode === "interactive" || mode === "merges") return sharedOf("interactive", legacyOf());
        return judgePullRebase(git, repo(), live, legacyOf());
      }
      case "git-commit-amend":
        return judgeAmend(git, repo(), legacyOf());
      case "git-reset-hard":
        return judgeResetHard(git, repo(), live, legacyOf());
      case "git-rebase":
        return judgeRebase(git, repo(), live, legacyOf());
      case "git-rebase-continue":
        return judgeResume(legacyOf());
      default:
        // A rewrite spelling this step does not know: shared, and named.
        return sharedOf("unreadable-target", legacyOf());
    }
  } catch (cause) {
    const basis = cause instanceof ProbeFailure ? cause.basis : "git-unavailable";
    let legacy: string;
    try {
      legacy = legacyOf();
    } catch {
      legacy = HISTORY_REWRITE_CLASS;
    }
    return sharedOf(basis, legacy);
  }
}

/** Shared for a moved ref that is a default branch or whose upstream is gone. */
function refGate(facts: RepoFacts, ref: string, legacy: string): Judged | null {
  if (isDefaultRef(facts, ref)) return sharedOf("default-branch", legacy, ref);
  if (facts.branches.get(ref)?.gone === true) return sharedOf("upstream-gone", legacy, ref);
  return null;
}

/** `git commit --amend`: R is HEAD alone. */
function judgeAmend(git: Git, facts: RepoFacts, legacy: string): Judged {
  if (facts.head === null) return sharedOf("detached-head", legacy);
  const gated = refGate(facts, facts.head, legacy);
  if (gated !== null) return gated;
  // Fixed literals, so no `--end-of-options` (which, without `--verify`,
  // rev-parse echoes back as an output line).
  const out = git.output(["rev-parse", "HEAD^{commit}", "HEAD^@"]);
  const ids = out?.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) ?? [];
  const [head, ...parents] = ids;
  if (head === undefined || !OBJECT_ID.test(head) || !parents.every((id) => OBJECT_ID.test(id))) {
    return sharedOf("unreadable-target", legacy, facts.head);
  }
  return judgeRange(git, facts, { ref: facts.head, oldTip: head, bases: parents, localBasis: "range-unpublished" }, legacy);
}

/** `git reset --hard [<rev>]`: R = HEAD --not <rev>. */
function judgeResetHard(git: Git, facts: RepoFacts, shape: GitInvocationShape, legacy: string): Judged {
  let rev = "HEAD";
  for (let at = 0; at < shape.args.length; at += 1) {
    const word = shape.args[at] as string;
    if (word === "--") break;
    if (word.startsWith("-")) continue;
    if (shape.unreadable[at] === true) return sharedOf("unreadable-target", legacy, facts.head);
    rev = word;
    break;
  }
  if (facts.head === null) return sharedOf("detached-head", legacy);
  const gated = refGate(facts, facts.head, legacy);
  if (gated !== null) return gated;
  const oldTip = resolveCommit(git, "HEAD");
  const base = resolveCommit(git, rev);
  if (oldTip === null || base === null) return sharedOf("unreadable-target", legacy, facts.head);
  return judgeRange(git, facts, { ref: facts.head, oldTip, bases: [base], localBasis: "range-unpublished" }, legacy);
}

/** `git rebase [--onto <x>] [<upstream> [<branch>]]`. */
function judgeRebase(git: Git, facts: RepoFacts, shape: GitInvocationShape, legacy: string): Judged {
  const parsed = parseRebaseArgs(shape);
  if (parsed.unvetted !== null) return sharedOf("option-unvetted", legacy, facts.head);
  if (parsed.updateRefs === true) return sharedOf("updates-other-refs", legacy, facts.head);
  const [upstreamWord, branchWord, extra] = parsed.positionals;
  if (extra !== undefined) return sharedOf("unreadable-target", legacy, facts.head);
  if (
    upstreamWord?.unreadable === true ||
    branchWord?.unreadable === true ||
    parsed.onto?.unreadable === true
  ) {
    return sharedOf("unreadable-target", legacy, facts.head);
  }
  let ref: string;
  if (branchWord !== undefined) {
    ref = `refs/heads/${branchWord.word}`;
    // A <branch> that is not a local branch makes git rebase a detached HEAD.
    if (!facts.branches.has(ref)) return sharedOf("unreadable-target", legacy);
  } else {
    if (facts.head === null) return sharedOf("detached-head", legacy);
    ref = facts.head;
  }
  const gated = refGate(facts, ref, legacy);
  if (gated !== null) return gated;
  const configured = rebaseConfigBlock(git, parsed.updateRefs, parsed.noRebaseMerges);
  if (configured !== null) return sharedOf(configured, legacy, ref);
  const oldTip = resolveCommit(git, ref);
  if (oldTip === null) return sharedOf("unreadable-target", legacy, ref);

  let bases: string[] = [];
  if (!parsed.root) {
    let upstream: string | null;
    if (upstreamWord !== undefined) {
      upstream = resolveCommit(git, upstreamWord.word);
    } else {
      const configured = facts.branches.get(ref)?.upstream ?? null;
      upstream = configured === null ? null : resolveCommit(git, configured);
    }
    if (upstream === null) return sharedOf("unreadable-target", legacy, ref);
    if (parsed.onto !== null) {
      const onto = resolveCommit(git, parsed.onto.word);
      if (onto === null) return sharedOf("unreadable-target", legacy, ref);
      // C4: the union base. Commits replayed AND commits dropped are in R.
      const merged = git.output(["merge-base", "--all", onto, upstream]);
      bases = merged?.split("\n").map((line) => line.trim()).filter((id) => OBJECT_ID.test(id)) ?? [];
      if (bases.length === 0) return sharedOf("unreadable-target", legacy, ref);
    } else {
      bases = [upstream];
    }
  }
  return judgeRange(git, facts, { ref, oldTip, bases, localBasis: "range-unpublished" }, legacy);
}

/**
 * `git rebase --continue`, `--skip`, `--abort` and `--quit`: always shared
 * (APRV-648 fix round 2, a deliberate departure from the D-6 spec text).
 *
 * Each of them acts on a rebase in progress, and git reads what it will do
 * from plain files under the git directory: which directory is the rebase
 * (`rebase-apply` before `rebase-merge`), the branch to move (`head-name`),
 * the commit to move it to (`orig-head`, of which git parses only the first
 * object-id-length characters), a pending amend of HEAD (`amend`), the steps
 * left (`git-rebase-todo`, `done`), a root to rebuild from (`squash-onto`) and
 * the refs to delete when the state is removed (`refs-to-delete`, which
 * `--quit` and `--abort` honour too). Anything that can write a file in the
 * checkout can write every one of them, and HEAD and the refs with them, so no
 * fact git uses for a resume is one the check could prove the way git reads
 * it. Two rounds of holes in reading that state (APRV-648 M1, S1, M-A, M-B)
 * are why the check no longer tries: it reads no rebase state at all.
 *
 * The starting `git rebase` is still judged (see `judgeRebase`), from refs
 * and configuration only; it never reads a state file, and git refuses to
 * start a rebase while one is in progress.
 */
function judgeResume(legacy: string): Judged {
  return sharedOf("unreadable-target", legacy);
}

/** `git pull --rebase` (or a pull configuration rebases): R = HEAD --not <upstream before the fetch>. */
function judgePullRebase(git: Git, facts: RepoFacts, shape: GitInvocationShape, legacy: string): Judged {
  if (facts.head === null) return sharedOf("detached-head", legacy);
  const gated = refGate(facts, facts.head, legacy);
  if (gated !== null) return gated;
  // `-s <name>` reaches the rebase the pull runs, and so does the rebase
  // configuration.
  if (rebaseRunsStrategy(shape.args)) return sharedOf("runs-commands", legacy, facts.head);
  const configured = rebaseConfigBlock(git, null, false);
  if (configured !== null) return sharedOf(configured, legacy, facts.head);
  const positionals: { word: string; unreadable: boolean }[] = [];
  for (let at = 0; at < shape.args.length; at += 1) {
    const word = shape.args[at] as string;
    if (word.startsWith("-")) continue;
    positionals.push({ word, unreadable: shape.unreadable[at] === true });
  }
  if (positionals.some((p) => p.unreadable) || positionals.length > 2) {
    return sharedOf("unreadable-target", legacy, facts.head);
  }
  const [remote, branch] = positionals;
  let upstream: string | null;
  if (remote !== undefined && branch !== undefined) {
    upstream = resolveCommit(git, `refs/remotes/${remote.word}/${branch.word}`);
  } else {
    const configured = facts.branches.get(facts.head)?.upstream ?? null;
    upstream = configured === null ? null : resolveCommit(git, configured);
  }
  const oldTip = resolveCommit(git, "HEAD");
  if (upstream === null || oldTip === null) return sharedOf("unreadable-target", legacy, facts.head);
  return judgeRange(git, facts, { ref: facts.head, oldTip, bases: [upstream], localBasis: "range-unpublished" }, legacy);
}

/** What a refined segment says in the hook's reason. */
const BASIS_TEXT: Readonly<Record<HistoryRewriteBasis, string>> = {
  "range-unpublished": "no commit it removes is on a shared ref",
  "no-commits-lost": "it removes no commit",
  // Never emitted since APRV-648 fix round 2 (every resume step is shared);
  // kept because the event schema still lists them.
  "rebase-in-progress-unpublished": "the rebase in progress removes no commit that is on a shared ref",
  "abort-restores": "it restores or keeps the pre-rebase branch",
  "push-side": "a push-side rewrite moves a ref other people hold, whatever this checkout says",
  "default-branch": "the ref it moves is a default branch",
  "shared-commit": "it removes a commit a shared ref holds",
  "upstream-gone": "the branch's upstream was pushed and then pruned",
  "detached-head": "HEAD is detached, so no branch can be checked",
  interactive: "an interactive rebase can reach outside the range it names",
  "runs-commands": "it runs a command of the caller's choosing",
  "todo-unvetted": "the rebase todo carries a command other than pick, edit, squash, fixup or drop",
  "whole-history": "it rewrites whole histories and runs filter code",
  "unreadable-target": "the text names a target the check cannot resolve, or the step resumes a rebase in progress, whose target git reads from state files under the git directory that the check does not trust",
  "global-option": "a global option or a wrapper points git somewhere the check does not read",
  "env-assignment": "an environment assignment points git somewhere the check does not read",
  "compound-state": "an earlier part of the command line can change the state the check reads",
  "range-too-large": `it would remove more than ${String(HISTORY_RANGE_CAP)} commits`,
  "check-timeout": `the repository did not answer within ${String(HISTORY_CHECK_BUDGET_MS)} ms`,
  "git-unavailable": "git could not answer for this directory",
  "option-unvetted": "it carries an option outside the closed list the check understands (git also accepts abbreviations, so the list names what is accepted)",
  "updates-other-refs": "it would also move other branches that point into the range (--update-refs or rebase.updateRefs)",
};

/** One note per refined segment: `rewrite-local: …` or `rewrite-shared: …`. */
function noteFor(segment: ClassifiedSegment, judged: Judged): string {
  const counted =
    judged.lost === null
      ? ""
      : ` (${String(judged.lost)} commit(s) of ${judged.ref ?? "HEAD"}, ${String(judged.lost_shared ?? 0)} on a shared ref)`;
  const witness = judged.witness === null ? "" : `, witness ${judged.witness}`;
  return `rewrite-${judged.reach}: ${judged.basis}${witness}: \`${segment.text}\` ${BASIS_TEXT[judged.basis]}${counted}; pre-split class ${judged.legacy_class} (APRV-433)`;
}
