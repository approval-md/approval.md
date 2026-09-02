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
 * Read git, and at most two writes: a `--ff-only` merge, and `npm run build`.
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
 * Three codes, evaluated in this order, each firing for exactly one condition:
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

import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve as resolvePathSegments } from "node:path";
import { fileURLToPath } from "node:url";

import type { DoctorCheck } from "./doctor.js";
import {
  currentBranch,
  failureText,
  fetchBase,
  git,
  repoPath,
  repoRoot,
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
] as const;

export type PreflightRefusalCode = (typeof PREFLIGHT_REFUSAL_CODES)[number];

/** The facts, exactly as they are carried on the `--json` stream. */
export interface PreflightFacts {
  behind_by: number;
  ahead_by: number;
  log_touched: boolean;
  dist_stale: boolean;
  action: PreflightAction;
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
  | { ok: true; facts: PreflightFacts; detail: string; warning: string | null }
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
  if (facts.action === "skipped" || facts.action === "fetch-failed" || facts.action === "none") {
    return { ok: true, facts, detail: report.detail, warning: report.warning };
  }

  if (facts.behind_by > 0 && report.root !== null && report.target !== null) {
    const merged = git(["merge", "--ff-only", report.target], report.root);
    if (!merged.ok) {
      return {
        ok: false,
        facts: { ...facts, action: "refused" },
        failed: { step: "git merge --ff-only", message: failureText(merged) },
      };
    }
  }

  // Built in the INSTALLATION root, which is the tree whose `dist/` was dated —
  // not in the repository root, which is where the fast-forward happened. In the
  // primary checkout they are the same directory; anywhere they are not, dating
  // one tree and compiling another would be the preflight lying about its work.
  if (facts.dist_stale) {
    const built = spawnBuild(input.root);
    if (!built.ok) {
      return {
        ok: false,
        facts: { ...facts, action: "refused" },
        failed: { step: "npm run build", message: built.message },
      };
    }
  }

  return { ok: true, facts, detail: report.detail, warning: report.warning };
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
  return { text: `up: preflight — ${did[event.action]}${running}`, stderr: false };
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
export function startupPreflight(input: StartupPreflightInput): { ok: boolean } {
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
    return { ok: false };
  }
  if (outcome.warning !== null) {
    input.emit({ event: "preflight_warning", message: outcome.warning });
  }
  input.emit({
    event: "preflight",
    commit: headCommit(input.logPath),
    detail: outcome.detail,
    ...outcome.facts,
  });
  return { ok: true };
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
