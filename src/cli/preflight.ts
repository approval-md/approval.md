/**
 * The startup preflight (APRV-215): is the code about to run the code that is
 * on origin, and is the build behind it the one the sources describe?
 *
 * ## The four manual steps this replaces
 *
 * Deploying the APRV-212 fix in the primary checkout took `git fetch`, a
 * judgment call about whether the ten upstream commits touched
 * `.approval/log/events.jsonl` while the working log was dirty, `git pull
 * --ff-only`, and `npm run build`. Three of those are typing; the second is the
 * one a human cannot make from `git status` alone, because `git status` does not
 * say what the *upstream range* changed. Carter's standing view is that manual
 * git steps for the human are a defect rather than a runbook, so the judgment
 * moves here and the typing moves with it.
 *
 * ## What it is allowed to do
 *
 * Read git, and at most three writes: a `--ff-only` merge, `npm run build`,
 * and, when the merge refused over an untracked file under `backlog/tasks/`
 * that main already contains, clearing that file out of the way (APRV-300, and
 * the rules it obeys are in {@link reconcileUntrackedTaskFiles}).
 *
 * It never resets, never stashes, never checks anything out, and never touches
 * the working log. That list is not conservatism for its own sake — it is fork 2
 * of 2026-08-20 (APRV-104's notes, and the reason `approval log sync` exists at
 * all): a working `events.jsonl` rewound through git underneath a live appender
 * is two chains where there was one. `--ff-only` cannot rewind a file that
 * upstream did not change, and when upstream DID change it while the working
 * copy is dirty, this module refuses and names `approval log sync`, which is the
 * verb that knows how to do it safely.
 *
 * ## Refusals, not repairs
 *
 * Four codes, each firing for exactly one condition. The first three are
 * evaluated in this order, before anything is written:
 *
 * - `up-preflight-behind-ahead` — `origin/<branch>..HEAD` is non-empty. Local
 *   commits exist that the remote does not have. A fast-forward is not the
 *   operation for that state, and guessing which side to keep is a decision.
 * - `up-preflight-log-diverged` — the upstream range changes the working log or
 *   the queue projection, and the working copy has uncommitted changes to them.
 *   This is the case the human could not judge by eye, and it is `approval log
 *   sync`'s whole subject.
 * - `up-preflight-dirty-protected` — some OTHER path the upstream range changes
 *   is locally modified, so `git merge --ff-only` would refuse to overwrite it.
 *   Named separately because the repair is different: look at the edit and
 *   decide, or start on the current build with `--no-preflight`.
 *
 * The fourth is answered after the merge has already refused, and only for the
 * one path shape where two checkouts routinely author one file (APRV-300):
 *
 * - `up-preflight-task-file-conflict` — an untracked file under
 *   `backlog/tasks/` stopped the fast-forward, and it holds lines the incoming
 *   copy does not. See {@link reconcileUntrackedTaskFiles} for what happens
 *   when it holds none, and why that is a claim rather than an assumption.
 *
 * `git reset --hard` appears in none of them, and never will: it is the command
 * that turns "your checkout is confusing" into "your work is gone".
 *
 * ## A fetch that fails is weather
 *
 * A laptop on a train has no origin to compare against. That is not a reason to
 * refuse to run a gate — the log is local, the policy is local, and the human is
 * holding the phone. A failed fetch is reported as a warning and the runtime
 * starts on the build it has, saying so.
 *
 * ## Two callers, one judgment
 *
 * `approval up` (and therefore `approval daemon run --with-channels`) acts on
 * it; `approval doctor`'s `main-behind-origin` row reports it. Doctor passes
 * `fetch: false`, because a report is not allowed to make a network call the
 * operator did not ask for, and says out loud that its answer is only as fresh
 * as the last fetch.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve as resolvePathSegments } from "node:path";
import { fileURLToPath } from "node:url";

import type { DoctorCheck } from "./doctor.js";
import { EXIT_IO, EXIT_OK } from "./exit-codes.js";
import {
  currentBranch,
  failureText,
  fetchBase,
  git,
  repoPath,
  repoRoot,
  showBlob,
} from "./git-scope.js";
import { runbook, style, type RunbookStep } from "./style.js";

// ---------------------------------------------------------------------------
// Build freshness (moved here from cli/doctor.ts, APRV-215)
// ---------------------------------------------------------------------------

/**
 * The installation root: the directory holding `cli.js`, `src/`, `dist/`.
 *
 * Derived from this module's own location rather than from `cwd`, because the
 * question is "is the code I am running stale", and the answer must not change
 * when the operator runs the CLI from somewhere else. Compiled, this file is
 * `<root>/dist/src/cli/preflight.js`, hence three levels up.
 */
export function installationRoot(): string {
  return resolvePathSegments(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Thrown out of the source walk so a real I/O denial can become exit 4. */
export class ScanError extends Error {}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Newest mtime under `dir`, or `null` when `dir` does not exist.
 *
 * ENOENT anywhere in the walk is "not there", which is an answer. Anything else
 * — a permission bit, a vanished mount — is the caller failing to look, and is
 * raised so it can report an I/O error rather than quietly reporting a build as
 * fresh because half the tree was invisible.
 */
function newestMtime(path: string): number | null {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ScanError(`${path} could not be stat'd: ${detailOf(cause)}`);
  }
  if (!stats.isDirectory()) return stats.mtimeMs;

  let newest = stats.mtimeMs;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return newest;
    throw new ScanError(`${path} could not be listed: ${detailOf(cause)}`);
  }
  for (const entry of entries) {
    const child = newestMtime(join(path, entry.name));
    if (child !== null && child > newest) newest = child;
  }
  return newest;
}

/**
 * Is the built CLI at least as new as the sources it was built from?
 *
 * The marker is `dist/src/cli/main.js` — the exact file `cli.js` loads, so the
 * thing being timestamped is the thing that will actually run. It is compared
 * against the newest mtime under `src/` and of `tsconfig.json` (a compiler
 * option change invalidates a build as surely as an edit does).
 *
 * Three shapes are distinguished because their repairs differ:
 *
 * - `cli.js` present, `dist/` absent — the placeholder-binary shape from the
 *   ceremony. The loader exists, so the checkout *looks* installed; nothing
 *   behind it does.
 * - marker older than sources — the stale-checkout shape. Verbs that exist in
 *   `src/` are missing from the binary.
 * - no `src/` at all — a published install, where freshness is not a question
 *   that can be asked. `skip`, not a silent pass.
 *
 * Note the self-reference: doctor itself runs *from* `dist`, so a completely
 * absent `dist` means `cli.js` already refused and this code never ran. The
 * check is still implemented for that shape because `--root` can point it at
 * another tree, and because "the binary you ran is not the tree you edited" is
 * exactly the confusion it exists to name.
 */
export function checkBuildFreshness(root: string): DoctorCheck {
  const loader = join(root, "cli.js");
  const marker = join(root, "dist", "src", "cli", "main.js");
  const sources = join(root, "src");
  const tsconfig = join(root, "tsconfig.json");

  const loaderMtime = newestMtime(loader);
  const markerMtime = newestMtime(marker);

  if (markerMtime === null) {
    return {
      check: "build-freshness",
      status: "fail",
      detail:
        loaderMtime === null
          ? `neither ${loader} nor ${marker} exists — ${root} is not an approval.md installation`
          : `${loader} exists but ${marker} does not: this is an unbuilt checkout, a bin loader with no build behind it`,
      fix: 'npm run build — in this checkout; if you are not sure this is the checkout you meant, `node -p "process.argv[1]"` names the one you just ran',
    };
  }

  if (loaderMtime === null) {
    return {
      check: "build-freshness",
      status: "fail",
      detail: `${marker} exists but the bin loader ${loader} does not: \`approval\` on PATH cannot reach this build`,
      fix: "node dist/src/cli/main.js — invoke the build directly, or reinstall the package so `approval` on PATH reaches it",
    };
  }

  const sourceMtime = newestMtime(sources);
  if (sourceMtime === null) {
    return {
      check: "build-freshness",
      status: "skip",
      detail: `${sources} is absent (a published install carries no sources), so the build cannot be dated against them; ${marker} is present`,
    };
  }

  const configMtime = newestMtime(tsconfig) ?? 0;
  const newestSource = Math.max(sourceMtime, configMtime);

  if (newestSource > markerMtime) {
    return {
      check: "build-freshness",
      status: "fail",
      detail: `${marker} is older than the source tree (build ${new Date(markerMtime).toISOString()}, newest source ${new Date(newestSource).toISOString()}): you are running a STALE BUILD, and verbs added since it was compiled are simply absent`,
      fix: "npm run build",
    };
  }

  return {
    check: "build-freshness",
    status: "pass",
    detail: `${marker} built ${new Date(markerMtime).toISOString()}, not older than the source tree`,
  };
}

/**
 * Is `root`'s build older than `root`'s sources?
 *
 * `null` when the question does not apply — a published install with no `src/`,
 * or a tree that is not an installation at all. A caller that wants the full
 * three-way answer asks {@link checkBuildFreshness}; this is the boolean the
 * preflight acts on, and "cannot tell" must not read as "stale" or the preflight
 * would rebuild a tree it has no business compiling.
 */
export function distStale(root: string): boolean | null {
  let loader: number | null;
  let marker: number | null;
  let sources: number | null;
  let config: number | null;
  try {
    loader = newestMtime(join(root, "cli.js"));
    marker = newestMtime(join(root, "dist", "src", "cli", "main.js"));
    sources = newestMtime(join(root, "src"));
    config = newestMtime(join(root, "tsconfig.json"));
  } catch (cause) {
    if (cause instanceof ScanError) return null;
    throw cause;
  }
  // No sources to date the build against — a published install, or a tree that
  // is not an installation at all. Either way "stale" is not a claim that can
  // be made, and a preflight that read "cannot tell" as "stale" would compile a
  // directory nobody asked it to compile.
  if (sources === null) return null;
  if (loader === null && marker === null) return null;
  // A loader with no build behind it: the placeholder-binary shape. `npm run
  // build` is exactly the repair.
  if (marker === null) return true;
  return Math.max(sources, config ?? 0) > marker;
}

// ---------------------------------------------------------------------------
// The git judgment
// ---------------------------------------------------------------------------

/** What the preflight did, or would have done. Frozen: it is a `--json` field. */
export type PreflightAction =
  /** Already at the remote tip with a build no older than the sources. */
  | "none"
  /** Only the build was behind. */
  | "rebuild"
  /** Only the checkout was behind. */
  | "fast-forward"
  /** Both. The ordinary shape after a few days away. */
  | "fast-forward+rebuild"
  /** A refusal: nothing was touched. */
  | "refused"
  /** `--no-preflight`, or a checkout git cannot answer questions about. */
  | "skipped"
  /** The fetch did not reach the remote. Weather, not a fault. */
  | "fetch-failed";

/** The machine-readable refusal codes. Frozen public API, distinct by repair. */
export const PREFLIGHT_REFUSAL_CODES = [
  "up-preflight-behind-ahead",
  "up-preflight-log-diverged",
  "up-preflight-dirty-protected",
  "up-preflight-task-file-conflict",
] as const;

export type PreflightRefusalCode = (typeof PREFLIGHT_REFUSAL_CODES)[number];

/** The facts, exactly as they are carried on the `--json` stream. */
export interface PreflightFacts {
  behind_by: number;
  ahead_by: number;
  log_touched: boolean;
  dist_stale: boolean;
  action: PreflightAction;
  /**
   * True when the preflight rebuilt and the runtime therefore re-executed into
   * the fresh build rather than carrying on in the process that dated it.
   *
   * Always false from {@link inspectPreflight}: inspection builds nothing, so
   * it can never be the reason a process was replaced. Doctor's row reads that
   * answer and never this one.
   */
  reexec: boolean;
}

/** A refusal, in the APRV-129 runbook's own vocabulary. */
export interface PreflightRefusal {
  code: PreflightRefusalCode;
  headline: string;
  state: string[];
  steps: RunbookStep[];
  footer: string[];
  /** The one command a machine caller should run next, unadorned. */
  next: string;
}

/** What {@link inspectPreflight} answers. */
export type PreflightReport =
  | {
      ok: true;
      facts: PreflightFacts;
      /** One sentence, for the human line and for doctor's `detail`. */
      detail: string;
      /** A fetch that did not reach the remote, or `null`. */
      warning: string | null;
      /** The commit a fast-forward would move to, when there is one. */
      target: string | null;
      /** Where the judgment was made. `null` when there was no repository. */
      root: string | null;
    }
  | { ok: false; facts: PreflightFacts; refusal: PreflightRefusal; root: string };

export interface PreflightInput {
  /** The working log, which also names the repository (as doctor's log-drift does). */
  logPath: string;
  /** The queue projection, the second path a fast-forward must not clobber. */
  queuePath: string;
  /** The installation whose `dist/` is dated against its `src/`. */
  root: string;
  /** Ask the remote, or judge against the last fetch. Doctor passes `false`. */
  fetch: boolean;
  /** Defaults to `origin`. */
  remote?: string;
  /** Defaults to the checked-out branch, or `main` on a detached HEAD. */
  branch?: string;
}

const ZERO: Omit<PreflightFacts, "action"> = {
  behind_by: 0,
  ahead_by: 0,
  log_touched: false,
  dist_stale: false,
  reexec: false,
};

/** `git status --porcelain -uno` as a set of repo-relative paths. */
function dirtyPaths(root: string): Set<string> {
  const run = git(["status", "--porcelain", "-uno"], root);
  const paths = new Set<string>();
  if (!run.ok) return paths;
  for (const line of run.stdout.split("\n")) {
    if (line.length < 4) continue;
    // "XY <path>", and for a rename "XY <old> -> <new>". Both sides count: a
    // rename in flight is a local modification of two paths.
    const body = line.slice(3);
    for (const part of body.split(" -> ")) {
      const trimmed = part.trim().replace(/^"|"$/gu, "");
      if (trimmed.length > 0) paths.add(trimmed);
    }
  }
  return paths;
}

/** The repo-relative paths the range `from..to` changes. */
function changedPaths(root: string, from: string, to: string): Set<string> {
  const run = git(["diff", "--name-only", `${from}..${to}`], root);
  const paths = new Set<string>();
  if (!run.ok) return paths;
  for (const line of run.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) paths.add(trimmed);
  }
  return paths;
}

/** `behind\tahead` from one `rev-list`, or `null` when git would not say. */
function counts(root: string, base: string): { behind: number; ahead: number } | null {
  const run = git(["rev-list", "--left-right", "--count", `${base}...HEAD`], root);
  if (!run.ok) return null;
  const parts = run.stdout.trim().split(/\s+/u);
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return null;
  return { behind, ahead };
}

function skipped(detail: string, root: string | null): PreflightReport {
  return { ok: true, facts: { ...ZERO, action: "skipped" }, detail, warning: null, target: null, root };
}

/**
 * The whole judgment, and not one byte of action.
 *
 * Every write the preflight is allowed to make lives in {@link runPreflight};
 * this function reads. That split is what lets doctor report the same facts
 * without any risk of doctor repairing something, which doctor has never done.
 */
export function inspectPreflight(input: PreflightInput): PreflightReport {
  const root = repoRoot(dirname(input.logPath));
  if (root === null) {
    return skipped(
      `${input.logPath} is not inside a git repository, so there is no origin to be behind`,
      null,
    );
  }

  const remote = input.remote ?? "origin";
  const branch = input.branch ?? currentBranch(root) ?? "main";

  let base: string;
  let warning: string | null = null;
  if (input.fetch) {
    // A repository with no remote configured is not an unreachable remote. It
    // is a repository that has no origin to be behind — a local evidence repo,
    // a fixture, a checkout somebody made with `git init` — and reporting
    // "could not reach the remote" there would be a warning about a question
    // nobody asked. Skipped, and therefore silent.
    const configured = git(["remote", "get-url", remote], root);
    if (!configured.ok) {
      return skipped(`no ${remote} remote is configured in ${root}, so there is nothing to be behind`, root);
    }
    const fetched = fetchBase(root, remote, branch);
    if (!fetched.ok) {
      return {
        ok: true,
        facts: { ...ZERO, action: "fetch-failed" },
        detail: `${remote}/${branch} could not be reached, so this checkout is running on the build it already has`,
        warning: fetched.message,
        target: null,
        root,
      };
    }
    base = fetched.sha;
  } else {
    const ref = `refs/remotes/${remote}/${branch}`;
    const resolved = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
    const sha = resolved.stdout.trim();
    if (!resolved.ok || sha.length === 0) {
      return skipped(
        `this checkout has no ${remote}/${branch} remote-tracking ref, so there is nothing to compare HEAD against (${failureText(resolved)})`,
        root,
      );
    }
    base = sha;
    warning = `judged against the last fetch of ${remote}/${branch}, not a fresh one`;
  }

  const counted = counts(root, base);
  if (counted === null) {
    return skipped(`git could not count the commits between HEAD and ${remote}/${branch}`, root);
  }

  const logRelative = repoPath(root, input.logPath);
  const queueRelative = repoPath(root, input.queuePath);
  const protectedPaths = new Set([logRelative, queueRelative]);

  const upstream = counted.behind === 0 ? new Set<string>() : changedPaths(root, "HEAD", base);
  const logTouched = [...protectedPaths].some((path) => upstream.has(path));
  const stale = distStale(input.root) ?? false;

  const facts = (action: PreflightAction): PreflightFacts => ({
    behind_by: counted.behind,
    ahead_by: counted.ahead,
    log_touched: logTouched,
    dist_stale: stale,
    action,
    reexec: false,
  });

  // 1. Ahead. Nothing else is worth judging: whatever the upstream range holds,
  //    a fast-forward is not the operation for a checkout carrying commits the
  //    remote has never seen, and choosing a side is a decision.
  if (counted.ahead > 0) {
    return {
      ok: false,
      root,
      facts: facts("refused"),
      refusal: {
        code: "up-preflight-behind-ahead",
        headline: `this checkout has ${plural(counted.ahead, "commit")} ${remote}/${branch} does not`,
        state: [
          `on ${branch} in ${root}`,
          `${plural(counted.ahead, "commit")} ahead, ${plural(counted.behind, "commit")} behind ${remote}/${branch}`,
          "nothing was fetched into the working tree, and nothing was rebuilt",
        ],
        steps: [
          {
            command: `git log --oneline ${remote}/${branch}..HEAD`,
            note: "what this checkout is carrying",
          },
          {
            command: `git push ${remote} HEAD:${branch}`,
            note: "if those commits are meant to ship, this is the way out",
          },
          {
            command: `git reset --keep ${remote}/${branch}`,
            note: "ONLY once you have looked: this drops the local commits above",
          },
        ],
        footer: [
          "--keep is the softest of the three: it refuses outright rather than overwriting an uncommitted change",
          "why the runtime will not choose for you: docs/cli-reference.md#up",
        ],
        next: `git log --oneline ${remote}/${branch}..HEAD`,
      },
    };
  }

  if (counted.behind === 0) {
    return {
      ok: true,
      root,
      target: base,
      warning,
      facts: facts(stale ? "rebuild" : "none"),
      detail: stale
        ? `up to date with ${remote}/${branch}, and the build is older than the sources`
        : `up to date with ${remote}/${branch}, on a build no older than the sources`,
    };
  }

  const dirty = dirtyPaths(root);

  // 2. The judgment the human could not make from `git status`: the upstream
  //    range rewrites the log or the queue, and the working copy has its own
  //    uncommitted version of one of them. `approval log sync` is the verb that
  //    does this — snapshot, baseline, fast-forward, reconcile, rebuild the
  //    projections — and this module deliberately does not reimplement it.
  const collidingProtected = [...protectedPaths].filter(
    (path) => upstream.has(path) && dirty.has(path),
  );
  if (collidingProtected.length > 0) {
    return {
      ok: false,
      root,
      facts: facts("refused"),
      refusal: {
        code: "up-preflight-log-diverged",
        headline: `${remote}/${branch} changed ${collidingProtected.join(" and ")} and so did this working copy`,
        state: [
          `${plural(counted.behind, "commit")} behind ${remote}/${branch}`,
          `changed on both sides: ${collidingProtected.join(", ")}`,
          "the working log was not read, moved, or rewound",
        ],
        steps: [
          {
            command: "approval log sync",
            note: "snapshots the working log, fast-forwards, reconciles the chain",
          },
          { command: "approval up", note: "again, once sync reports clean" },
        ],
        footer: [
          "a fast-forward over a log another process is appending to is how one chain becomes two",
          "the ritual and what it refuses: docs/cli-reference.md#log-sync",
        ],
        next: "approval log sync",
      },
    };
  }

  // 3. Any other local modification in the fast-forward's way. `--ff-only` would
  //    refuse rather than clobber it, so the refusal is reported here, where it
  //    can say which file and what the two ways out are.
  const colliding = [...upstream].filter((path) => dirty.has(path)).sort();
  if (colliding.length > 0) {
    return {
      ok: false,
      root,
      facts: facts("refused"),
      refusal: {
        code: "up-preflight-dirty-protected",
        headline: `${plural(colliding.length, "file")} the fast-forward would overwrite ${colliding.length === 1 ? "is" : "are"} locally modified`,
        state: [
          `${plural(counted.behind, "commit")} behind ${remote}/${branch}`,
          `modified here and upstream: ${colliding.slice(0, 5).join(", ")}${colliding.length > 5 ? ", …" : ""}`,
          "nothing was merged and nothing was rebuilt",
        ],
        steps: [
          { command: `git diff -- ${colliding[0] ?? ""}`, note: "what this checkout changed" },
          {
            command: "approval up --no-preflight",
            note: "start on the current build and deal with the edit afterwards",
          },
        ],
        footer: [
          "the preflight commits nothing and discards nothing: the edit is yours to land or drop",
          "what the preflight will and will not do: docs/cli-reference.md#up",
        ],
        next: `git diff -- ${colliding[0] ?? ""}`,
      },
    };
  }

  return {
    ok: true,
    root,
    target: base,
    warning,
    facts: facts(stale ? "fast-forward+rebuild" : "fast-forward"),
    detail: `${plural(counted.behind, "commit")} behind ${remote}/${branch}, and the upstream range is safe to fast-forward${stale ? "; the build is older than the sources" : ""}`,
  };
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Acting on it
// ---------------------------------------------------------------------------

/** What {@link runPreflight} did, with the facts as they ended up. */
export type PreflightOutcome =
  | {
      ok: true;
      facts: PreflightFacts;
      detail: string;
      warning: string | null;
      /** Present when a rebuild happened: the caller must become this child. */
      reexec?: ReexecPlan;
    }
  | { ok: false; facts: PreflightFacts; refusal: PreflightRefusal }
  /** A write the preflight attempted and could not complete. Also a refusal. */
  | { ok: false; facts: PreflightFacts; failed: { step: string; message: string } };

/**
 * Inspect, then perform at most a fast-forward and a build.
 *
 * `npm run build` is spawned rather than shelled, with the checkout as its cwd,
 * so nothing here depends on the operator's shell or on `npm` being on a
 * particular PATH entry. Its output is discarded and its exit status is the
 * whole answer: a build that fails is a failed preflight, and the runtime does
 * not start on a half-compiled tree.
 */
export function runPreflight(
  input: PreflightInput,
  spawnBuild: (root: string) => { ok: boolean; message: string } = npmBuild,
): PreflightOutcome {
  const report = inspectPreflight(input);
  if (!report.ok) return { ok: false, facts: report.facts, refusal: report.refusal };

  const { facts } = report;
  if (facts.action === "skipped" || facts.action === "fetch-failed") {
    return { ok: true, facts, detail: report.detail, warning: report.warning };
  }

  // What the task-file reconciliation below cleared, or `null` when it had
  // nothing to do. It rides out on the warning line so the aside directory is
  // printed where the operator is already looking.
  let cleared: string | null = null;

  if (facts.behind_by > 0 && report.root !== null && report.target !== null) {
    const root = report.root;
    const target = report.target;
    let merged = git(["merge", "--ff-only", target], root);
    if (!merged.ok) {
      const reconciled = reconcileUntrackedTaskFiles(root, target, failureText(merged));
      if (reconciled.kind === "refused") {
        return { ok: false, facts: { ...facts, action: "refused" }, refusal: reconciled.refusal };
      }
      if (reconciled.kind === "failed") {
        return {
          ok: false,
          facts: { ...facts, action: "refused" },
          failed: { step: reconciled.step, message: reconciled.message },
        };
      }
      if (reconciled.kind === "cleared") {
        cleared = reconciled.note;
        // Once. A second failure is a different failure — the merge was asked
        // again only because the thing that stopped it is provably gone.
        merged = git(["merge", "--ff-only", target], root);
      }
    }
    if (!merged.ok) {
      return {
        ok: false,
        facts: { ...facts, action: "refused" },
        failed: { step: "git merge --ff-only", message: failureText(merged) },
      };
    }
  }

  // Staleness is asked AGAIN, after the merge, and the second answer is the one
  // that counts. `inspectPreflight` dated `dist/` against the sources as they
  // were BEFORE the fast-forward; a fast-forward that lands three days of `src/`
  // is precisely what makes a build stale, and reporting the pre-merge answer
  // would leave the operator running a binary older than the code just pulled.
  // Doctor's row keeps the pre-merge answer because doctor merges nothing.
  const stale = (report.root === null ? facts.dist_stale : distStale(input.root)) ?? facts.dist_stale;
  const settled: PreflightFacts = {
    ...facts,
    dist_stale: stale,
    action:
      facts.behind_by > 0
        ? stale
          ? "fast-forward+rebuild"
          : "fast-forward"
        : stale
          ? "rebuild"
          : "none",
  };

  // Built in the INSTALLATION root, which is the tree whose `dist/` was dated —
  // not in the repository root, which is where the fast-forward happened. In the
  // primary checkout they are the same directory; anywhere they are not, dating
  // one tree and compiling another would be the preflight lying about its work.
  if (stale) {
    const built = spawnBuild(input.root);
    if (!built.ok) {
      return {
        ok: false,
        facts: { ...settled, action: "refused" },
        failed: { step: "npm run build", message: built.message },
      };
    }
  }

  // A rebuild means the process that ran the preflight is no longer the build
  // the preflight produced (APRV-215, coordinator's amendment). Node has already
  // loaded this module tree, so continuing here would start the writer on the
  // code the operator was trying to leave behind — which is the exact defect
  // this task exists to remove. Hand the caller a plan to re-exec into the
  // fresh build instead. See {@link reexecPlan} for why it is a plan rather
  // than a spawn.
  const plan = stale ? reexecPlan(input.root) : null;
  return {
    ok: true,
    facts: { ...settled, reexec: plan !== null },
    detail: report.detail,
    warning: [report.warning, cleared].filter((part) => part !== null).join("; ") || null,
    ...(plan === null ? {} : { reexec: plan }),
  };
}

// ---------------------------------------------------------------------------
// Untracked task files in the fast-forward's way (APRV-300)
// ---------------------------------------------------------------------------

/**
 * The one directory this reconciliation is allowed to touch.
 *
 * Backlog.md task files are the only path in this repository where the same
 * file is routinely authored in two checkouts at once: a lane files a task on
 * its branch and the primary files it again with `backlog task create`, so the
 * primary holds untracked bytes at a path the incoming commit carries. Nothing
 * else has that shape, and widening the prefix would turn a narrow, provable
 * case into a general licence to move an operator's files.
 */
const TASK_FILE_PREFIX = "backlog/tasks/";

/** Git's own sentence when a fast-forward would clobber an untracked file. */
const UNTRACKED_HEADLINE = "untracked working tree files would be overwritten";

/**
 * The paths out of that message, or `null` when this was some other failure.
 *
 * {@link failureText} has already joined git's lines with ` | `, so the shape
 * parsed here is `error: The following untracked working tree files would be
 * overwritten by merge: | <path> | <path> | Please move or remove them…`. A
 * path git chose to quote (`core.quotePath`, a name with a control byte or a
 * non-ASCII byte) is answered as `null` rather than unquoted by hand: guessing
 * the spelling of a file about to be moved is the one mistake this whole
 * function exists to avoid, and the existing refusal is a fine answer.
 */
function untrackedCollisions(message: string): string[] | null {
  const parts = message.split(" | ").map((part) => part.trim());
  const start = parts.findIndex((part) => part.includes(UNTRACKED_HEADLINE));
  if (start < 0) return null;
  const paths: string[] = [];
  for (const part of parts.slice(start + 1)) {
    if (part.length === 0) continue;
    if (part.startsWith("Please ") || part === "Aborting") break;
    if (part.startsWith('"')) return null;
    paths.push(part);
  }
  return paths.length === 0 ? null : paths;
}

/** What one collision turned out to be, once both copies had been read. */
type TaskVerdict =
  | { kind: "remove"; relative: string }
  | { kind: "aside"; relative: string }
  | { kind: "diverged"; relative: string; only: number };

/** What {@link reconcileUntrackedTaskFiles} decided about the whole set. */
type TaskReconciliation =
  | { kind: "declined" }
  | { kind: "cleared"; note: string }
  | { kind: "refused"; refusal: PreflightRefusal }
  | { kind: "failed"; step: string; message: string };

/**
 * Clear untracked task files out of a fast-forward's way, or refuse saying why.
 *
 * The incident (2026-09-07): a lane filed `backlog/tasks/aprv-299` on its
 * branch and its pull request merged, while the primary checkout held the same
 * path untracked from its own `backlog task create`. `git merge --ff-only`
 * refuses to write over an untracked file, so `approval up` refused, and its
 * next-steps text pointed at `git status`, which cannot say whether the local
 * copy holds anything the incoming one does not. That is the question, and it
 * is answerable, so it is answered here.
 *
 * Three verdicts, in this order, each with a different claim behind it:
 *
 * - **identical bytes** — the local file says nothing the incoming file does
 *   not say. Removing it loses nothing, so it is removed;
 * - **every line also in the incoming copy** — the primary's copy is a subset
 *   of what main now carries (the ordinary shape: a stub filed by hand, then
 *   the lane's copy with a plan and criteria added). Nothing is lost by
 *   letting the incoming copy land, but "nothing is lost" is a judgment about
 *   an operator's file, so the bytes are moved aside rather than deleted and
 *   the destination is printed;
 * - **anything else** — the local copy has lines main lacks. That is a
 *   question about which version is wanted, and no verb here will pick.
 *
 * Two passes, and the order is the safety property, exactly as APRV-225's
 * payload reconciliation in `cli/log-sync.ts`: every file is judged before any
 * file is touched, so a refusal over the last one cannot have already removed
 * the first.
 */
function reconcileUntrackedTaskFiles(
  root: string,
  target: string,
  message: string,
): TaskReconciliation {
  const collisions = untrackedCollisions(message);
  if (collisions === null) return { kind: "declined" };
  // One path outside `backlog/tasks/` and the whole set is declined. A
  // reconciliation that cleared what it understood and then refused anyway
  // would have moved an operator's files for a merge that was never going to
  // run (AC3).
  if (!collisions.every((path) => path.startsWith(TASK_FILE_PREFIX))) return { kind: "declined" };

  const verdicts: TaskVerdict[] = [];
  for (const relative of collisions) {
    let local: Buffer | null;
    try {
      local = readIfPresent(join(root, relative));
    } catch (cause) {
      return {
        kind: "failed",
        step: "reading an untracked task file",
        message: `${relative} stopped the fast-forward and could not be read to judge it: ${detailOf(cause)}. Nothing was moved.`,
      };
    }
    // Gone between the merge's complaint and this read: nothing to clear, and
    // nothing to weigh either. The retry will find out.
    if (local === null) continue;
    const incoming = showBlob(root, target, relative);
    if (incoming === null) {
      return {
        kind: "failed",
        step: `git show ${target}:${relative}`,
        message: `the fast-forward stopped on the untracked ${relative} and git could not read the incoming copy to compare it against. Nothing was moved.`,
      };
    }
    if (incoming.equals(local)) {
      verdicts.push({ kind: "remove", relative });
      continue;
    }
    const only = linesOnlyIn(local, incoming);
    verdicts.push(only === 0 ? { kind: "aside", relative } : { kind: "diverged", relative, only });
  }

  const diverged = verdicts.find((verdict) => verdict.kind === "diverged");
  if (diverged !== undefined) {
    const local = join(root, diverged.relative);
    return {
      kind: "refused",
      refusal: {
        code: "up-preflight-task-file-conflict",
        headline: `the untracked ${diverged.relative} has ${plural(diverged.only, "line")} the incoming copy does not`,
        state: [
          `yours: ${local}`,
          `incoming: ${target.slice(0, 12)}:${diverged.relative}`,
          `${plural(diverged.only, "line")} only yours has`,
          "nothing was merged, nothing was moved, and nothing was rebuilt",
        ],
        steps: [
          {
            command: `git show ${target.slice(0, 12)}:${diverged.relative} | diff - ${JSON.stringify(local)}`,
            note: "the two copies, side by side",
          },
          {
            command: `mv ${JSON.stringify(local)} ${JSON.stringify(`${local}.mine`)}`,
            note: "keep yours out of the way, then run approval up again",
          },
        ],
        footer: [
          "an identical copy is removed and a copy main already contains is moved aside; this one is neither",
          "what the preflight will and will not do: docs/cli-reference.md#up",
        ],
        next: `git show ${target.slice(0, 12)}:${diverged.relative}`,
      },
    };
  }

  const removals = verdicts.filter((verdict) => verdict.kind === "remove");
  const asides = verdicts.filter((verdict) => verdict.kind === "aside");
  if (removals.length === 0 && asides.length === 0) return { kind: "declined" };

  // The moves go first and the removals second, so a failure part-way has
  // preserved every byte it had a reason to preserve. Either way the message
  // names what already moved: a half-finished clearing an operator cannot see
  // is worse than the collision it was clearing.
  const asideRoot = asidePath(root);
  const moved: string[] = [];
  const sofar = (): string =>
    moved.length === 0 ? "" : ` Already moved aside: ${moved.join(", ")}.`;
  for (const verdict of asides) {
    const from = join(root, verdict.relative);
    const to = join(asideRoot, verdict.relative);
    try {
      mkdirSync(dirname(to), { recursive: true });
      moveFile(from, to);
    } catch (cause) {
      return {
        kind: "failed",
        step: "moving an untracked task file aside",
        message: `${verdict.relative} could not be moved to ${to}: ${detailOf(cause)}. Nothing was merged.${sofar()}`,
      };
    }
    moved.push(to);
  }
  for (const verdict of removals) {
    try {
      rmSync(join(root, verdict.relative), { force: true });
    } catch (cause) {
      return {
        kind: "failed",
        step: "removing an untracked task file",
        message: `${verdict.relative} is byte-identical to the incoming copy and could not be removed: ${detailOf(cause)}. Nothing was merged.${sofar()}`,
      };
    }
  }

  const said: string[] = [];
  if (removals.length > 0) {
    said.push(
      `${plural(removals.length, "untracked task file")} byte-identical to the incoming copy ${removals.length === 1 ? "was" : "were"} removed`,
    );
  }
  if (moved.length > 0) {
    said.push(
      `${plural(moved.length, "untracked task file")} whose every line the incoming copy already carries ${moved.length === 1 ? "was" : "were"} moved to ${moved.join(", ")}`,
    );
  }
  return { kind: "cleared", note: `${said.join("; ")}, and the fast-forward was retried` };
}

/**
 * How many lines of `local` do not appear anywhere in `incoming`.
 *
 * A set of the incoming lines rather than a diff, and deliberately: the
 * question is not whether the two files line up, it is whether the local copy
 * holds any *content* main has not got. A task file reordered by the Backlog.md
 * CLI, or one whose sections were rewritten in place, is the same information
 * in a different arrangement, and zero here is exactly the claim that moving
 * the local copy aside loses nothing.
 */
function linesOnlyIn(local: Buffer, incoming: Buffer): number {
  const carried = new Set(incoming.toString("utf8").split("\n"));
  return local
    .toString("utf8")
    .split("\n")
    .filter((line) => !carried.has(line)).length;
}

/**
 * Where a moved-aside file goes: a sibling of the checkout, dated.
 *
 * Outside the repository on purpose. Inside it, the file would still be
 * untracked, `git status` would still show it, and the next fast-forward could
 * collide with it all over again — which is to say the move would have solved
 * nothing. A sibling directory is somewhere `ls ..` finds, the date makes two
 * runs on two days two directories, and nothing here ever removes one: it is
 * the operator's copy, kept until they say otherwise.
 */
function asidePath(root: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(dirname(root), `${basename(root)}-preflight-aside-${day}`);
}

/** `rename`, falling back to copy-and-unlink when the two sit on two devices. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/** The bytes at `path`, or `null` when there is no file there. */
function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ScanError(`${path} could not be read: ${detailOf(cause)}`);
  }
}

/** Where the fresh build lives, and what to run it with. */
export interface ReexecPlan {
  /** `<root>/dist/src/cli/main.js` — resolved from the CHECKOUT, never from `import.meta`. */
  entry: string;
  /** This process's own argv, plus `--no-preflight` so the child cannot loop. */
  argv: string[];
}

/**
 * The plan to re-exec, or `null` when there is nothing to re-exec into.
 *
 * The entry is resolved against the checkout root rather than against this
 * module's own location, and that distinction is the whole point: this module
 * is running FROM the stale build, so `import.meta.url` names exactly the tree
 * being replaced. `<root>/dist/src/cli/main.js` is the file `cli.js` loads and
 * the file `checkBuildFreshness` dates, so it is the one the build just wrote.
 *
 * `process.argv.slice(2)` rather than a reconstruction of the parsed flags: the
 * child must run the command the operator actually typed, including the verb,
 * and a rebuilt argv would be this module's opinion of what they meant.
 * `--no-preflight` is appended so the child cannot preflight again, which is
 * both the loop guard and the honest thing — the checkout is already current.
 */
function reexecPlan(root: string): ReexecPlan | null {
  const entry = join(root, "dist", "src", "cli", "main.js");
  if (!existsSync(entry)) return null;
  const argv = process.argv.slice(2);
  if (argv.includes("--no-preflight")) return null;
  return { entry, argv: [...argv, "--no-preflight"] };
}

/**
 * Run the fresh build in a child process and become its exit code.
 *
 * `stdio: "inherit"` so the child owns the terminal exactly as the parent would
 * have: the daemon's lines, the token panel, a channel's prompts and an
 * operator's ctrl-c all behave as though no re-exec happened. SIGINT and
 * SIGTERM are forwarded rather than handled, because the child is the writer
 * and the shutdown sequence that matters is its own.
 *
 * A child killed by the signal we forwarded exits 0: the operator asked the
 * runtime to stop and it stopped, which is a clean stop under any spelling.
 * Any other signal is reported as an I/O failure, because a writer that
 * vanished is a fact about the machine rather than a decision of the runtime.
 */
export function reexecFreshBuild(plan: ReexecPlan, cwd: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [plan.entry, ...plan.argv], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const done = (code: number): void => {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      resolve(code);
    };
    child.on("error", () => {
      done(EXIT_IO);
    });
    child.on("exit", (code, signal) => {
      if (code !== null) return done(code);
      done(signal === "SIGINT" || signal === "SIGTERM" ? EXIT_OK : EXIT_IO);
    });
  });
}

// ---------------------------------------------------------------------------
// The startup wiring, shared by `approval up` and `approval daemon run`
// ---------------------------------------------------------------------------

/**
 * The preflight's two lines on the event stream.
 *
 * They live here rather than in `cli/up.ts` because `approval daemon run` runs
 * the same preflight and must print the same lines, and `daemon.ts` cannot
 * import `up.ts` (the cycle APRV-110 already routes around with a dynamic
 * import). `UpEvent` includes this union, so the `--json` stream stays one union
 * of additive shapes with no field added to any shape that already existed.
 */
export type PreflightEvent =
  | ({ event: "preflight"; commit: string | null; detail: string } & PreflightFacts)
  | { event: "preflight_warning"; message: string };

/** One preflight line as a human sentence, and where it belongs. */
export function describePreflightEvent(event: PreflightEvent): { text: string; stderr: boolean } {
  if (event.event === "preflight_warning") {
    return { text: `approval: preflight — ${event.message}`, stderr: true };
  }
  const commits = `${String(event.behind_by)} commit${event.behind_by === 1 ? "" : "s"}`;
  const did: Record<PreflightAction, string> = {
    none: "already at the remote tip, on a build no older than the sources",
    rebuild: "rebuilt a stale build",
    "fast-forward": `fast-forwarded ${commits}`,
    "fast-forward+rebuild": `fast-forwarded ${commits} and rebuilt`,
    refused: "refused",
    skipped: "skipped",
    "fetch-failed": "could not reach the remote, so this is the build it already had",
  };
  const running = event.commit === null ? "" : `; now running ${event.commit.slice(0, 12)}`;
  // The re-exec is stated, not implied. An operator watching a foreground
  // process replace itself deserves to be told, and it is the sentence that
  // makes "now running <sha>" a claim about THIS process rather than a wish.
  const handover = event.reexec ? ", in a fresh process on the new build" : "";
  return { text: `up: preflight — ${did[event.action]}${running}${handover}`, stderr: false };
}

/** How a caller emits one line. `up` and `daemon run` route theirs identically. */
export type PreflightEmit = (event: PreflightEvent) => void;

export interface StartupPreflightInput {
  logPath: string;
  queuePath: string;
  /** The installation whose `dist/` is dated. `null` means "ask this build". */
  root: string | null;
  remote: string | null;
  branch: string | null;
  emit: PreflightEmit;
  /** Where a refusal is written. One line under `--json`, a runbook otherwise. */
  refuse: (text: string) => void;
  json: boolean;
}

/**
 * Run the preflight, print what it did, and answer whether the caller may start.
 *
 * `ok: false` carries nothing but the fact: everything a human or a machine
 * needs has already been written by `refuse`, and the caller's only remaining
 * job is to return the exit code.
 */
export function startupPreflight(
  input: StartupPreflightInput,
): { ok: boolean; reexec: ReexecPlan | null } {
  const outcome = runPreflight({
    logPath: input.logPath,
    queuePath: input.queuePath,
    root: input.root ?? installationRoot(),
    fetch: true,
    ...(input.remote === null ? {} : { remote: input.remote }),
    ...(input.branch === null ? {} : { branch: input.branch }),
  });

  if (!outcome.ok) {
    input.refuse(renderPreflightRefusal(outcome, input.json));
    return { ok: false, reexec: null };
  }
  // A preflight with no repository to look at says nothing. The line reports
  // what the preflight DID, and "there is no origin here" is a property of the
  // deployment rather than an event in it: a log-only install outside git would
  // otherwise open every start with a line about a question it cannot ask.
  // Doctor's `main-behind-origin` row is where that state is visible.
  if (outcome.facts.action === "skipped") return { ok: true, reexec: null };

  if (outcome.warning !== null) {
    input.emit({ event: "preflight_warning", message: outcome.warning });
  }
  // Emitted BEFORE the re-exec, and by the parent, because this is the only
  // place the whole story is known: the child runs with `--no-preflight` and
  // has nothing to say about a fast-forward it did not perform. The commit is
  // read after the merge, so the line names the code the child is about to run.
  input.emit({
    event: "preflight",
    commit: headCommit(input.logPath),
    detail: outcome.detail,
    ...outcome.facts,
  });
  return { ok: true, reexec: outcome.reexec ?? null };
}

/** The short sha this checkout is on, or `null` when git will not say. */
function headCommit(logPath: string): string | null {
  const root = repoRoot(dirname(logPath));
  if (root === null) return null;
  const run = git(["rev-parse", "HEAD"], root);
  const sha = run.stdout.trim();
  return run.ok && sha.length > 0 ? sha : null;
}

/**
 * A preflight refusal, on both surfaces (APRV-129).
 *
 * The human surface is the runbook: the code, the state, one runnable command
 * per numbered line, and the rationale compressed into the footer. The machine
 * surface is one object carrying the stable code and the same facts the success
 * path carries, so a supervisor can branch on `error.code` without reading a
 * word of it.
 */
export function renderPreflightRefusal(
  outcome: PreflightOutcome & { ok: false },
  json: boolean,
): string {
  if ("failed" in outcome) {
    const message = `\`${outcome.failed.step}\` failed: ${outcome.failed.message}`;
    if (json) {
      return `${JSON.stringify({
        error: { code: "up-preflight-failed", message },
        preflight: outcome.facts,
      })}\n`;
    }
    return `${runbook(style({ json }), "up-preflight-failed", message, {
      state: ["the preflight stopped part-way; nothing was reset and nothing was stashed"],
      steps: [
        { command: "git status --short", note: "what this checkout looks like now" },
        { command: "approval up --no-preflight", note: "start on the current build" },
      ],
    })}\n`;
  }
  const { refusal } = outcome;
  if (json) {
    return `${JSON.stringify({
      error: { code: refusal.code, message: refusal.headline, next: refusal.next },
      preflight: outcome.facts,
    })}\n`;
  }
  return `${runbook(style({ json }), refusal.code, refusal.headline, {
    state: refusal.state,
    steps: refusal.steps,
    footer: refusal.footer,
  })}\n`;
}

function npmBuild(root: string): { ok: boolean; message: string } {
  const result = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, message: detailOf(result.error ?? "npm did not run") };
  }
  if (result.status === 0) return { ok: true, message: "" };
  const output = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: false, message: output.slice(-3).join(" | ") || "npm run build failed" };
}

// ---------------------------------------------------------------------------
// Doctor's row
// ---------------------------------------------------------------------------

/**
 * `main-behind-origin`, doctor's twenty-first row.
 *
 * It makes no network call (`fetch: false`), for the reason every doctor row
 * makes none it was not asked for: doctor is a report, and a report that reached
 * the network to be more accurate would be doing something on its own account.
 * So the answer is as fresh as the last fetch, and the detail says so.
 *
 * `fix` strings stay inside `FIX_COMMAND_PREFIXES`: they name `approval` verbs,
 * never `git`. That constraint predates this row and is the right one — a repair
 * line telling an operator to reset a branch would be doctor making a decision.
 */
export function checkMainBehindOrigin(logPath: string, queuePath: string, root: string): DoctorCheck {
  const report = inspectPreflight({ logPath, queuePath, root, fetch: false });
  if (!report.ok) {
    return {
      check: "main-behind-origin",
      status: "fail",
      detail: `${report.refusal.code}: ${report.refusal.headline} (as of the last fetch)`,
      fix:
        report.refusal.code === "up-preflight-log-diverged"
          ? "approval log sync — snapshot the working log, fast-forward, reconcile the chain"
          : `approval up — it refuses with the exact next command, which here begins \`${report.refusal.next}\``,
    };
  }
  if (report.facts.action === "skipped") {
    return { check: "main-behind-origin", status: "skip", detail: report.detail };
  }
  const suffix = report.warning === null ? "" : ` (${report.warning})`;
  if (report.facts.behind_by === 0 && !report.facts.dist_stale) {
    return { check: "main-behind-origin", status: "pass", detail: `${report.detail}${suffix}` };
  }
  return {
    check: "main-behind-origin",
    status: "pass",
    detail: `${report.detail}; upstream ${report.facts.log_touched ? "DOES" : "does not"} touch the working log or queue${suffix}`,
    fix: "approval up — fast-forwards and rebuilds when it is safe, and refuses with the next command when it is not",
  };
}
