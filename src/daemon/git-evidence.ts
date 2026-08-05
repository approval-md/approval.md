/**
 * Per-event git commits — SPEC.md §8's optional hardening (APRV-42).
 *
 * > "Optionally, the log directory is a git repo and the daemon commits per
 * > event with its own identity, giving signed, distributed tamper evidence for
 * > free."
 *
 * The chain in `events.jsonl` already detects mutation and truncation on its
 * own. What a git repository adds is a *second, independent* record of the same
 * bytes: a mutation that is plausible against one layer has to be plausible
 * against the other at the same time, and the second layer is one an operator
 * can clone, mirror, and diff from somewhere the tamperer does not control.
 * Neither layer is trusted to police the other, which is the point of having
 * two: `approval log verify` never consults git, and nothing here ever reads a
 * verdict out of a commit.
 *
 * ## Opt-in, and only for a standalone log deployment
 *
 * This is off unless the operator asks for it, and refuses to turn on unless the
 * log's own directory is a repository *root*. The two layouts do not mix:
 *
 * - **Standalone log deployment.** The log home (`.approval/`, or whatever
 *   directory holds the log when it is not under a `log/` folder) is its own git
 *   repository, containing the log, the payload store, and nothing else. Enable
 *   the opt-in here.
 * - **Nested project layout** — this repository's own dogfood arrangement, where
 *   `.approval/` is committed as part of a larger project repo. Perfectly valid,
 *   and the opt-in is REFUSED for it.
 *
 * Why refuse the nested case rather than make it work? Because a hash chain does
 * not survive a merge. Two branches that each append independently produce a
 * chain that is corrupt by construction, and no merge strategy repairs the
 * semantics. An outer repository's ordinary history operations — rebase, amend,
 * squash, force-push, `filter-branch` — rewrite the very bytes the evidence is
 * made of, and a daemon committing into someone else's branch would be a second
 * writer to a history the project's humans also write. Evidence that the subject
 * of the investigation can rewrite is not evidence. So the runtime does not try
 * to be clever about it: own-root repository, or no git evidence at all.
 *
 * ## What it does, precisely
 *
 * After every tick in which the log moved, the daemon calls {@link
 * GitEvidenceRecorder.commit} with the verified head it just read. The recorder
 * stages the log file and the payload store, and commits with a message naming
 * the head's `(seq, hash)`. Batching is **one commit per tick**, not literally
 * one per event: ticks are the only moment the daemon has a verified head in
 * hand, and a commit is only meaningful against a head that verified. A tick
 * that observed three appends produces one commit naming the new head and the
 * number of records it covers — the intermediate states are still fully
 * recoverable from the log itself, which is the artifact being witnessed.
 *
 * ## What it deliberately does not do
 *
 * It never pushes, never fetches, never creates or moves a branch by name, never
 * touches a remote, and never writes to any git config outside the single
 * `git commit` invocation (identity is passed with `-c`, per command, so the
 * operator's `user.name` is neither read into the commit nor overwritten on
 * disk). Commits are local, to the log's own repository, authored by the daemon
 * as itself. A failure to commit is a warning, never a stop: git evidence is
 * hardening on top of the chain, and a daemon that halted approvals because a
 * disk was full of git objects would have converted a redundancy into a
 * dependency.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { LogHead } from "../core/log.js";
import { PAYLOAD_STORE_DIRNAME } from "../core/payload-store.js";

/**
 * The daemon's own git identity. Never the operator's: a commit that says a
 * human made it is a false statement about who wrote the evidence, and the whole
 * value of the second layer is that its authorship is unambiguous.
 *
 * The version is pinned to `package.json` by a test rather than read at runtime,
 * because a module that resolves its own package root differs between the source
 * tree and the build output for no benefit at all.
 */
export const APPROVALD_VERSION = "0.0.1";

/** `user.name` on every commit this module makes. */
export const GIT_EVIDENCE_AUTHOR_NAME = `approvald ${APPROVALD_VERSION}`;

/** `user.email` on every commit: fixed, and deliberately undeliverable. */
export const GIT_EVIDENCE_AUTHOR_EMAIL = "approvald@noreply.approval.md";

/**
 * Why enabling git evidence was refused. **Frozen union**, additive-only, in the
 * same sense as every other refusal vocabulary in this codebase (SPEC.md §11.1
 * invariant 6: refusals are machine-readable and distinct). An operator's
 * supervisor branches on these to tell "install git" apart from "your layout is
 * wrong", and the repair differs for every one of them.
 */
export const GIT_EVIDENCE_REFUSAL_CODES = [
  /** No usable `git` on PATH. The daemon runs fine without the opt-in. */
  "git-unavailable",
  /** The directory that would hold the evidence repository does not exist. */
  "log-dir-missing",
  /** It exists and is not a git repository. The repair is `git init` there. */
  "log-dir-not-repo",
  /**
   * It is inside a working tree it does not own — either some outer repository
   * tracks it, or it is a repository whose root is somewhere above. Hash chains
   * do not survive merges and an outer history rewrites evidence.
   */
  "log-dir-nested",
] as const;

export type GitEvidenceRefusalCode = (typeof GIT_EVIDENCE_REFUSAL_CODES)[number];

export interface GitEvidenceRefusal {
  ok: false;
  code: GitEvidenceRefusalCode;
  message: string;
}

/**
 * One line of git-evidence output. Its own frozen shape, reported through the
 * callback the CLI supplies, so that `daemon/daemon.ts`'s event union stays
 * exactly as it was: the hardening layer speaks for itself and the loop's
 * contract is untouched.
 */
export type GitEvidenceEvent =
  | {
      event: "git_evidence";
      /** The abbreviated commit this tick produced. */
      commit: string;
      /** The verified head the commit witnesses. */
      seq: number;
      hash: string;
      /**
       * Log lines added since the commit this one builds on — the batch size.
       * The log is append-only, so a line is a record. `null` only when git
       * declined to say, which is a reporting gap and never a correctness one.
       */
      records: number | null;
    }
  | {
      event: "git_evidence_failed";
      /** The git invocation that failed, as a bare subcommand name. */
      step: string;
      message: string;
    };

/** Where git-evidence output goes. Injected, so this module writes to nothing. */
export type GitEvidenceSink = (event: GitEvidenceEvent) => void;

/**
 * The hook the daemon calls. One method, taking the verified head of the log it
 * just read, so that the loop's edit is a single line and no scheduling
 * knowledge leaks into this file.
 */
export interface GitEvidenceRecorder {
  commit(head: LogHead | null): void;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The directory that must be the evidence repository's root, for a given log.
 *
 * The same rule `payloadStoreDirFor` uses, for the same reason: SPEC.md §9 fixes
 * the log at `<home>/log/events.jsonl` and the payload store at
 * `<home>/payloads/`, so the only directory that contains *both* is `<home>`.
 * Rooting the repository at the log's immediate directory would leave every
 * payload file outside the evidence, which is precisely where a tamperer would
 * then work. When a caller points `--log` somewhere flatter, the log's own
 * directory is the home and the rule still holds.
 */
export function evidenceRootFor(logPath: string): string {
  const logDir = dirname(logPath);
  return basename(logDir) === "log" ? dirname(logDir) : logDir;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One git invocation, non-interactive.
 *
 * `GIT_TERMINAL_PROMPT=0` and an emptied `GIT_DIR`/`GIT_WORK_TREE` keep an
 * inherited environment from redirecting the command at some other repository,
 * and nothing here ever prompts: a daemon blocked on a credential prompt is a
 * daemon that has silently stopped.
 */
function git(args: string[], cwd: string): GitResult {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detail(result.error ?? "git did not run") };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A path with symlinks resolved, or the path itself when it cannot be. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The working tree root containing `dir`, or `null` when there is none. */
function topLevel(dir: string): string | null {
  const result = git(["rev-parse", "--show-toplevel"], dir);
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root.length === 0 ? null : root;
}

// ---------------------------------------------------------------------------
// Enabling
// ---------------------------------------------------------------------------

export type EnableGitEvidenceResult =
  | { ok: true; root: string; recorder: GitEvidenceRecorder }
  | GitEvidenceRefusal;

/**
 * Check every precondition and, when they all hold, build the recorder.
 *
 * Fail closed and fail *loudly*: each refusal is distinct, names the directory
 * it judged, and states the repair. An operator who mistyped `--log` and an
 * operator whose log lives inside a project repository need different sentences,
 * and a single "git evidence unavailable" would have sent both of them looking
 * in the wrong place.
 */
export function enableGitEvidence(logPath: string, sink: GitEvidenceSink): EnableGitEvidenceResult {
  const root = evidenceRootFor(logPath);

  const version = git(["--version"], process.cwd());
  if (!version.ok) {
    return {
      ok: false,
      code: "git-unavailable",
      message: `--git-evidence needs a working \`git\` on PATH and none ran (${version.stderr.trim()}); install git, or drop the flag — the daemon's hash chain is unaffected either way`,
    };
  }

  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      ok: false,
      code: "log-dir-missing",
      message: `--git-evidence would commit into ${root}, which is not a directory; create the log's home first (the evidence repository is rooted where the log and its payload store both live)`,
    };
  }

  const own = topLevel(root);
  if (own === null) {
    return {
      ok: false,
      code: "log-dir-not-repo",
      message: `--git-evidence requires ${root} to be a git repository of its own and it is not one; run \`git init\` in ${root} and re-run. It must be its OWN root: a log tracked by some outer repository is evidence that repository's history operations can rewrite`,
    };
  }
  if (real(own) !== real(root)) {
    return {
      ok: false,
      code: "log-dir-nested",
      message: `--git-evidence requires ${root} to be its own repository root, and it sits inside the working tree rooted at ${own}. Refused: a hash chain does not survive a merge (two branches appending independently produce a corrupt chain by construction, and no merge strategy repairs it), and an outer repository's rebases, amends and force-pushes rewrite the bytes the evidence is made of. Either run \`git init\` in ${root} so the log deployment stands alone, or run without --git-evidence — the nested layout is fully valid, it just gets its tamper evidence from the chain alone`,
    };
  }

  // An own-root repository can still be *contained* by an outer working tree
  // (a nested repo inside a project checkout, this repository's own dogfood
  // shape if someone ran `git init` in `.approval/`). The parent directory is
  // the only place that shows it, and containment is exactly the hazard: the
  // outer repo's operations move the directory these commits live in.
  const parent = dirname(root);
  if (parent !== root && existsSync(parent)) {
    const outer = topLevel(parent);
    if (outer !== null) {
      return {
        ok: false,
        code: "log-dir-nested",
        message: `--git-evidence requires a standalone log deployment, and ${root} — though a repository root itself — is nested inside the working tree rooted at ${outer}. Refused: the outer repository's history operations rewrite or relocate the directory these commits witness, and a hash chain does not survive a merge. Move the log outside that working tree, or run without --git-evidence (the nested layout is valid; it relies on the chain alone)`,
      };
    }
  }

  return { ok: true, root, recorder: new GitEvidence(root, logPath, sink) };
}

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/**
 * The recorder proper: stateless except for the last head it committed, which
 * exists only so a tick with nothing new does no git work at all.
 */
class GitEvidence implements GitEvidenceRecorder {
  private readonly root: string;
  private readonly logPath: string;
  private readonly sink: GitEvidenceSink;
  private lastSeq: number | null = null;

  constructor(root: string, logPath: string, sink: GitEvidenceSink) {
    this.root = root;
    this.logPath = logPath;
    this.sink = sink;
  }

  commit(head: LogHead | null): void {
    // An empty log has nothing to witness, and a head that has not moved since
    // the last commit has already been witnessed. Payload files land with the
    // event that references them, so the head is a sound trigger for both.
    if (head === null) return;
    if (this.lastSeq !== null && head.seq <= this.lastSeq) return;

    const paths = [this.logPath];
    const payloads = join(this.root, PAYLOAD_STORE_DIRNAME);
    if (existsSync(payloads)) paths.push(payloads);

    const staged = this.run(["add", "--", ...paths], "add");
    if (!staged) return;

    // Nothing staged means the log on disk is byte-identical to the committed
    // one. That is not a failure and it is not silence worth reporting: it is
    // the ordinary case for a tick whose appends were already committed.
    const pending = git(["diff", "--cached", "--quiet"], this.root);
    if (pending.ok) {
      this.lastSeq = head.seq;
      return;
    }

    // The batch size, taken from git rather than from a remembered sequence
    // number: the log is append-only, so staged added lines *are* the records
    // this commit covers, and the count stays right across a daemon restart
    // that has no memory of the previous commit at all.
    const records = this.stagedRecords();
    const committed = this.run(
      [
        "-c",
        `user.name=${GIT_EVIDENCE_AUTHOR_NAME}`,
        "-c",
        `user.email=${GIT_EVIDENCE_AUTHOR_EMAIL}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "--quiet",
        "-m",
        message(head, records),
      ],
      "commit",
    );
    if (!committed) return;

    const sha = git(["rev-parse", "--short", "HEAD"], this.root);
    this.lastSeq = head.seq;
    this.sink({
      event: "git_evidence",
      commit: sha.ok ? sha.stdout.trim() : "unknown",
      seq: head.seq,
      hash: head.hash,
      records,
    });
  }

  /** Staged added lines of the log file, or `null` when git would not say. */
  private stagedRecords(): number | null {
    const numstat = git(["diff", "--cached", "--numstat", "--", this.logPath], this.root);
    if (!numstat.ok) return null;
    const added = numstat.stdout.trim().split("\n")[0]?.split("\t")[0];
    if (added === undefined) return null;
    const count = Number(added);
    return Number.isInteger(count) ? count : null;
  }

  /** One git step, reporting a failure as a warning and never throwing. */
  private run(args: string[], step: string): boolean {
    const result = git(args, this.root);
    if (result.ok) return true;
    this.sink({
      event: "git_evidence_failed",
      step,
      message: `git ${step} in ${this.root} failed: ${
        (result.stderr.trim() || result.stdout.trim()) === ""
          ? "no output"
          : result.stderr.trim() || result.stdout.trim()
      }; the log itself is untouched and its hash chain is the primary evidence`,
    });
    return false;
  }
}

/**
 * The commit message: the head's `(seq, hash)` on the subject line, so a reader
 * of `git log --oneline` can check a commit against the chain without opening
 * anything, and the batch size in the body so the per-tick batching is visible
 * rather than inferred.
 */
export function message(head: LogHead, records: number | null): string {
  const subject = `seq ${String(head.seq)} sha256:${head.hash}`;
  const covered =
    records === null
      ? "record count unavailable"
      : `${String(records)} record(s) since the previous commit`;
  return `${subject}\n\napprovald ${APPROVALD_VERSION} tamper evidence: ${covered}.\nOne commit per daemon tick, witnessing the verified head named above.\n`;
}
