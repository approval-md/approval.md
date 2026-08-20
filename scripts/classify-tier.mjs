#!/usr/bin/env node
/**
 * Tiered checks: the deterministic path classifier (APRV-36).
 *
 * A change either rides the light tier or it does not, and that verdict is
 * computed here from the set of changed paths. It is never asserted by the
 * author of the change, human or agent. An agent that could say "this one is
 * docs only" would be deciding how much scrutiny its own edit receives, which
 * is the same shape of authority this project exists to take away from agents.
 * So the input is a path list produced by git, and the output is a function of
 * that list alone.
 *
 * The rule is narrow on purpose. A path is light only if it is documentation
 * or example markdown AND matches nothing on the denylist below. Everything
 * else is full, including the empty set, an unreadable git state, and any path
 * shape the matcher does not understand. Ambiguity resolves to full, always.
 *
 * A third tier, `records` (APRV-112), covers the project's own records: the
 * Backlog.md tree and the milestone map those records are checked against. It
 * is chosen only when *every* changed path is a record, and it runs every test
 * that reads records. See {@link RECORDS_ALLOWLIST}.
 *
 * The configuration is this file, deliberately. A tiering config living in its
 * own data file would be a markdown-adjacent thing an edit could plausibly be
 * argued into the light tier; keeping it inline means `scripts/**` on the
 * denylist already protects it, and the test suite asserts that a change to
 * this very file classifies as full.
 *
 * Usage:
 *   node scripts/classify-tier.mjs <path>...        classify explicit paths
 *   node scripts/classify-tier.mjs --working-tree   classify the working tree
 *   node scripts/classify-tier.mjs --base <ref>     classify <ref>...HEAD
 *   ... --json                                      machine-readable verdict
 *   ... --run                                       run the chosen tier
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, from `scripts/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * The only paths eligible for the light tier: prose a reader consumes and no
 * runtime reads. Extensions are checked as well as directories, so a script or
 * fixture that happens to live under `docs/` is still full.
 */
export const LIGHT_ALLOWLIST = Object.freeze([
  "README.md",
  "docs/**/*.md",
  "examples/**/*.md",
]);

/**
 * Paths that force the full tier regardless of extension. Each entry is here
 * because the file is instruction-bearing, frozen, or load-bearing for the
 * checks themselves; a markdown extension does not make any of them prose.
 *
 * `backlog/**` is the subtle one, and APRV-112 narrowed what its presence
 * here means. Backlog task files are markdown, and read like documentation,
 * but their acceptance criteria are commands to future worker agents. Editing
 * a pending task's criteria changes what an agent will later do, which is a
 * behavioral change wearing a documentation extension, so it never rides the
 * light tier: the light tier runs the docs guard, which cannot observe a task
 * file at all. What that argument actually demands is that every test which
 * READS records runs, and that is exactly the records tier below. The
 * protection that mattered here, drift between the records and the guards
 * that read them, is preserved; what is dropped is the 1800-test matrix on
 * two Node majors, none of which can observe a task file.
 */
export const FULL_TIER_DENYLIST = Object.freeze([
  "APPROVAL.md",
  "APPROVALS.md",
  "CLAUDE.md",
  ".claude/**",
  "SPEC.md",
  "schema/**",
  "**/fixtures/**",
  "backlog/**",
  "scripts/**",
  ".github/**",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "cli.js",
]);

/**
 * The records set: the project's own bookkeeping, plus the one file outside
 * `backlog/` that a records-reading guard checks the records against.
 *
 * `MILESTONES.md` is in here because `tests/milestones-guard.test.ts` reads it
 * in the same breath as `backlog/tasks/` and `backlog/milestones/`: the guard
 * asserts the two agree, so the pair is one editable unit and splitting it
 * across tiers would mean half a rename runs the guard and half does not. It
 * was verified by reading the guards: MILESTONES.md has exactly one reader in
 * the repository, and that reader is in the records tier's set.
 *
 * The tier is all-or-nothing. One path outside this list, `README.md`
 * included, and the change escalates exactly as it does today; nothing here
 * can make a mixed change cheaper, only a pure-records change cheaper.
 */
export const RECORDS_ALLOWLIST = Object.freeze([
  "backlog/**",
  "MILESTONES.md",
]);

/** Why a whole change set was forced to the full tier, when no path names it. */
const REASON = Object.freeze({
  EMPTY: "empty-path-set",
  GIT: "git-state-unreadable",
  DENIED: "denylisted-path",
  OUTSIDE: "path-outside-light-allowlist",
  LIGHT: "all-paths-in-light-allowlist",
  RECORDS: "all-paths-in-records-set",
});

/** The marker used when a path is simply not documentation. */
const NOT_ALLOWLISTED = "not-in-light-allowlist";

/**
 * A glob to an anchored regular expression. Supports `**` (any number of path
 * segments), `*` (anything but a separator) and `?`. Deliberately small: an
 * unsupported construct would silently widen the light tier, so the vocabulary
 * is limited to what the two lists above actually use.
 */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `a/**` matches `a/b` and `a/b/c`; `**/x` matches `x` and `a/x`.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`, "u");
}

const ALLOW_RES = LIGHT_ALLOWLIST.map((glob) => [glob, globToRegExp(glob)]);
const DENY_RES = FULL_TIER_DENYLIST.map((glob) => [glob, globToRegExp(glob)]);
const RECORDS_RES = RECORDS_ALLOWLIST.map((glob) => [glob, globToRegExp(glob)]);

/**
 * A repository-relative POSIX path, or `null` if the input is a shape this
 * classifier will not reason about (absolute, escaping, empty). `null` forces
 * the full tier rather than being dropped from the set.
 */
export function normalizePath(raw) {
  if (typeof raw !== "string") return null;
  let path = raw.trim().replaceAll("\\", "/");
  if (path.startsWith('"') && path.endsWith('"') && path.length > 1) {
    // git quotes paths containing unusual bytes; such a path is never prose.
    return null;
  }
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.startsWith("/") || path.startsWith("../")) return null;
  if (path.split("/").includes("..")) return null;
  return path;
}

/**
 * The per-path verdict: `{ path, light, forcedBy }`. `forcedBy` names the
 * denylist entry that decided it, or {@link NOT_ALLOWLISTED} when the path is
 * simply not documentation, or `null` when the path is light.
 */
export function classifyPath(raw) {
  const path = normalizePath(raw);
  if (path === null) {
    return { path: String(raw), light: false, forcedBy: "unparseable-path" };
  }
  for (const [glob, re] of DENY_RES) {
    if (re.test(path)) return { path, light: false, forcedBy: glob };
  }
  const allowed = ALLOW_RES.some(([, re]) => re.test(path));
  return allowed
    ? { path, light: true, forcedBy: null }
    : { path, light: false, forcedBy: NOT_ALLOWLISTED };
}

/** Is this path one of the project's own records? */
export function isRecordPath(raw) {
  const path = normalizePath(raw);
  if (path === null) return false;
  return RECORDS_RES.some(([, re]) => re.test(path));
}

/**
 * The verdict for a whole change set. Light requires a non-empty set in which
 * every path is light; records requires a non-empty set in which every path is
 * a record; every other outcome, including the empty set, is full.
 *
 * Records is tested before the light/full split because `backlog/**` is on the
 * denylist, which is what makes a *mixed* change full. Order matters only for
 * sets that are entirely records, and for those the denylist entry has nothing
 * left to protect: the records tier runs every guard that reads them.
 */
export function classify(rawPaths) {
  const paths = rawPaths.map((raw) => classifyPath(raw));
  if (paths.length === 0) {
    return { tier: "full", reason: REASON.EMPTY, paths: [], forcedBy: [] };
  }
  if (rawPaths.every((raw) => isRecordPath(raw))) {
    return {
      tier: "records",
      reason: REASON.RECORDS,
      paths: paths.map((entry) => entry.path),
      forcedBy: [],
    };
  }
  const forcedBy = paths
    .filter((entry) => !entry.light)
    .map((entry) => ({ path: entry.path, rule: entry.forcedBy }));
  if (forcedBy.length === 0) {
    return {
      tier: "light",
      reason: REASON.LIGHT,
      paths: paths.map((entry) => entry.path),
      forcedBy: [],
    };
  }
  const denied = forcedBy.some((entry) => entry.rule !== NOT_ALLOWLISTED);
  return {
    tier: "full",
    reason: denied ? REASON.DENIED : REASON.OUTSIDE,
    paths: paths.map((entry) => entry.path),
    forcedBy,
  };
}

// ---------------------------------------------------------------------------
// Path sources
// ---------------------------------------------------------------------------

function git(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

/** Changed paths in the working tree, tracked and untracked. `null` on error. */
function workingTreePaths() {
  const out = git(["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (out === null) return null;
  const fields = out.split("\0").filter((field) => field !== "");
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) return null; // not a status line: refuse to guess
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes("R") || status.includes("C")) {
      // A rename emits the source path as the next NUL-delimited field.
      i += 1;
      const source = fields[i];
      if (source !== undefined) paths.push(source);
    }
  }
  return paths;
}

/** Changed paths between `base` and HEAD. `null` on error. */
function basePaths(base) {
  const out = git(["diff", "--name-only", `${base}...HEAD`]);
  if (out === null) return null;
  return out.split("\n").filter((line) => line !== "");
}

// ---------------------------------------------------------------------------
// Running the chosen tier
// ---------------------------------------------------------------------------

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  process.stderr.write(`\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error !== undefined) return 1;
  return result.status === null ? 1 : result.status;
}

/**
 * The light tier runs the documentation guard only. It still compiles, because
 * the guard is TypeScript and imports the frozen tables it checks against; the
 * saving is the ~900 other tests, not the build.
 */
function runLight() {
  const built = run(NPM, ["run", "build"]);
  if (built !== 0) return built;
  return run(process.execPath, ["--test", "dist/tests/docs-guard.test.js"]);
}

/**
 * The tests that read the project's records. This list is the records tier;
 * anything added later that reads `backlog/**` or `MILESTONES.md` belongs
 * here, or the records tier stops being the guard it claims to be.
 *
 *   - milestones-guard: reads `backlog/tasks/`, `backlog/milestones/`, and
 *     `MILESTONES.md`, and asserts they agree.
 *   - backlog-fixtures: the Backlog.md round-trip corpus and its version pin,
 *     the guard behind "preserve unknown frontmatter"; it reads the fixture
 *     tree rather than `backlog/` itself, and it is the check that catches a
 *     record written in a shape the runtime cannot round-trip.
 *   - docs-guard: its retired-name sweep walks the whole tree (excluding
 *     `backlog/`, which it audits by its own rule), so a record can still
 *     trip it.
 */
export const RECORDS_TESTS = Object.freeze([
  "milestones-guard",
  "backlog-fixtures",
  "docs-guard",
]);

/**
 * The records tier: build, then the reading tests only, on this Node. It
 * compiles for the same reason the light tier does, the tests are TypeScript;
 * the saving is the rest of the suite and the second Node major.
 */
function runRecords() {
  const built = run(NPM, ["run", "build"]);
  if (built !== 0) return built;
  return run(process.execPath, [
    "scripts/run-tests.mjs",
    "--only",
    ...RECORDS_TESTS,
  ]);
}

/** The full tier is the standing gate, unchanged. */
function runFull() {
  for (const script of ["test", "lint", "typecheck"]) {
    const code = run(NPM, ["run", script]);
    if (code !== 0) return code;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    json: false,
    run: false,
    workingTree: false,
    base: null,
    paths: [],
    error: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--run") options.run = true;
    else if (arg === "--working-tree") options.workingTree = true;
    else if (arg === "--base") {
      i += 1;
      const value = argv[i];
      if (value === undefined) options.error = "--base requires a ref";
      else options.base = value;
    } else if (arg.startsWith("--base=")) options.base = arg.slice(7);
    else if (arg.startsWith("-")) options.error = `unknown option ${arg}`;
    else options.paths.push(arg);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.error !== null) {
    process.stderr.write(`classify-tier: ${options.error}\n`);
    return 2;
  }

  let verdict;
  if (options.paths.length > 0) {
    verdict = classify(options.paths);
  } else if (options.workingTree || options.base !== null) {
    const collected = options.workingTree
      ? workingTreePaths()
      : basePaths(options.base ?? "origin/main");
    verdict =
      collected === null
        ? { tier: "full", reason: REASON.GIT, paths: [], forcedBy: [] }
        : classify(collected);
  } else {
    verdict = classify([]);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    process.stdout.write(`${verdict.tier}\n`);
  }

  if (!options.run) return 0;
  if (verdict.tier === "light") return runLight();
  if (verdict.tier === "records") return runRecords();
  return runFull();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
