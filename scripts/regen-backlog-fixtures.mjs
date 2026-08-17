#!/usr/bin/env node
/**
 * Regenerate the Backlog.md format fixture corpus (APRV-65).
 *
 * approval.md extends the Backlog.md file convention and never forks it
 * (SPEC.md principle 6, §12). Backlog.md is not an npm dependency of this
 * package: the coupling is the *bytes* the pinned CLI writes into task files,
 * which this repo's parser reads (`src/core/frontmatter.ts`) and which M6's
 * writer must round-trip. A dependency that is a file format rather than a
 * package cannot be pinned by `package-lock.json`, so it is pinned here: a
 * committed corpus of real CLI output plus a test that regenerates it and
 * compares byte for byte. Upstream format drift then fails a fixture in this
 * repository instead of silently eating a user's envelope.
 *
 * ## What it does
 *
 * Runs the pinned CLI through a scripted sequence of canonical operations in a
 * throwaway temp directory, snapshotting the produced files after each
 * meaningful step into a named scenario directory. Nothing touches this
 * repository's own `backlog/` tree: the script refuses to run the CLI anywhere
 * inside the repo (see {@link assertOutsideRepo}), and the working project is
 * created under `os.tmpdir()` with `--no-git`.
 *
 * ## Determinism
 *
 * Two runs must produce identical bytes. The CLI stamps exactly two values
 * that vary run to run — `created_date` and `updated_date` — and both are
 * rewritten to a fixed sentinel by {@link normalise}, whose rule list is the
 * single documented source of truth and runs on *both* sides of the drift
 * comparison in `tests/backlog-fixtures.test.ts`. Everything else the CLI
 * writes (ids, ordinals, milestone ids, filenames) is a deterministic function
 * of the operation sequence *given a fixed environment*, which is the second
 * half of the story: the child process gets a replaced env and a throwaway
 * `HOME` (see {@link backlog}), because the CLI writes ambient values such as
 * `$EDITOR` into `config.yml`. If a future CLI introduces another volatile
 * field, the fix is a new rule here, never a looser comparison there.
 *
 * ## Usage
 *
 *   node scripts/regen-backlog-fixtures.mjs                 # rewrite the corpus
 *   node scripts/regen-backlog-fixtures.mjs --out <dir>     # write elsewhere
 *   node scripts/regen-backlog-fixtures.mjs --allow-version-mismatch
 *
 * Bumping the pin (docs/backlog-md-pin.md) means running this and committing
 * the regenerated corpus in the same change.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUT = join(REPO_ROOT, "tests", "fixtures", "backlog");

/**
 * The Backlog.md CLI version this corpus was produced by. Must agree with
 * docs/backlog-md-pin.md; `tests/backlog-fixtures.test.ts` asserts that it
 * does, so a pin bump that forgets the corpus fails everywhere, not only on
 * machines that happen to have the CLI installed.
 */
export const PINNED_VERSION = "1.49.3";

/** The sentinel every volatile timestamp is rewritten to. */
export const DATE_SENTINEL = "2000-01-01 00:00";

/**
 * The normalisation rule list: volatile value → fixed sentinel.
 *
 * Deliberately a short, explicit, line-anchored list. Each entry names the
 * field and matches only that field's value, so a *new* volatile field shows
 * up as a drift failure (which is correct: someone must look at it) rather
 * than being absorbed by a permissive pattern.
 */
export const NORMALISATION_RULES = [
  {
    field: "created_date",
    why: "wall-clock stamp written by the CLI at task creation",
    pattern: /^(created_date:\s*)'[^']*'$/gmu,
    replacement: `$1'${DATE_SENTINEL}'`,
  },
  {
    field: "updated_date",
    why: "wall-clock stamp rewritten by the CLI on every edit",
    pattern: /^(updated_date:\s*)'[^']*'$/gmu,
    replacement: `$1'${DATE_SENTINEL}'`,
  },
];

/** Apply every normalisation rule to one file's text. */
export function normalise(text) {
  let out = text;
  for (const rule of NORMALISATION_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** Refuse to operate on any path inside this repository. */
function assertOutsideRepo(path) {
  const absolute = resolve(path);
  if (absolute === resolve(REPO_ROOT) || absolute.startsWith(resolve(REPO_ROOT) + sep)) {
    throw new Error(
      `refusing to run the Backlog.md CLI at ${absolute}: it is inside this repository. ` +
        "The CLI must never touch backlog/ here (CLAUDE.md); fixtures are generated in a temp project.",
    );
  }
}

/**
 * Run the pinned CLI in `cwd`, failing loudly on a non-zero exit.
 *
 * The environment is **replaced, not extended**. This is not tidiness: the
 * first run of the drift guard under `npm test` failed because npm exports
 * `EDITOR`, which the CLI writes into `config.yml` as `default_editor`. The
 * fixture bytes must be a function of the operation sequence alone, so the
 * child gets a fixed, minimal environment and a throwaway `HOME` (no
 * user-level config, no editor, no locale, no ambient CI flags).
 */
function backlog(cwd, args, home) {
  assertOutsideRepo(cwd);
  const result = spawnSync("backlog", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      // The CLI renders boxes and colour when it thinks it is on a terminal;
      // it is not, here, but say so explicitly so output never depends on how
      // the script was invoked.
      NO_COLOR: "1",
      TERM: "dumb",
      LANG: "C",
      TZ: "UTC",
    },
  });
  if (result.error !== undefined) {
    throw new Error(`backlog ${args.join(" ")} could not be spawned: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `backlog ${args.join(" ")} exited ${String(result.status)}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

/** The installed CLI's version string, or null when it is not on PATH. */
export function installedVersion() {
  const result = spawnSync("backlog", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

// ---------------------------------------------------------------------------
// The envelope, written by hand
// ---------------------------------------------------------------------------

/**
 * A SPEC.md §6.1-shaped envelope, as raw frontmatter lines.
 *
 * Written by us, not by the CLI: `approval:` is precisely the key the CLI has
 * never heard of, and the point of the `envelope-edit-*` scenarios is what the
 * CLI does to a key it did not write.
 */
const ENVELOPE_LINES = `approval:
  origin:
    app: example-capture
    created_by: "human:carter"
  route:
    assignee: "agent:claude-admin"
    confidence: 0.82
    rationale: "templated chaser, known counterparty, no negotiation"
  state: awaiting
  actions:
    - class: communicate.email.external
      summary: "Send deposit chaser to agency@example.co.uk"
      reversible: false
      est_cost_usd: 0.02
      idempotency_key: "task-3:chaser:2026-08-04"
  budget:
    max_cost_usd: 0.50
    max_latency: 6h`.split("\n");

/** Splice `ENVELOPE_LINES` in as the last key of a task file's frontmatter. */
function injectEnvelope(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines[0] !== "---") throw new Error(`${path} does not open with a frontmatter delimiter`);
  const close = lines.indexOf("---", 1);
  if (close === -1) throw new Error(`${path} has unterminated frontmatter`);
  lines.splice(close, 0, ...ENVELOPE_LINES);
  writeFileSync(path, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** The single task file whose name starts with `<prefix> - `, under `dir`. */
function taskFile(project, prefix) {
  const dir = join(project, "backlog", "tasks");
  const matches = readdirSync(dir).filter((name) => name.startsWith(`${prefix} - `));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one task file for ${prefix}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return join(dir, matches[0]);
}

/** The single milestone file, under `dir`. */
function milestoneFile(project) {
  const dir = join(project, "backlog", "milestones");
  const matches = readdirSync(dir).filter((name) => name.endsWith(".md"));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one milestone file, found ${matches.length}`);
  }
  return join(dir, matches[0]);
}

/**
 * Snapshot `sources` into `<out>/<scenario>/`, normalised.
 *
 * `as` renames the captured file when a scenario needs a name the CLI would
 * not produce; otherwise the CLI's own filename is preserved, because the
 * filename is part of the format under test.
 */
function capture(out, scenario, sources) {
  const dir = join(out, scenario);
  mkdirSync(dir, { recursive: true });
  for (const source of sources) {
    const from = typeof source === "string" ? source : source.from;
    const name = typeof source === "string" ? from.split(sep).pop() : source.as;
    writeFileSync(join(dir, name), normalise(readFileSync(from, "utf8")));
  }
}

// ---------------------------------------------------------------------------
// The scenario sequence
// ---------------------------------------------------------------------------

/**
 * Human-readable scenario descriptions, rendered into the corpus README so the
 * corpus explains itself to whoever hits a drift failure.
 */
export const SCENARIOS = [
  ["init", "`backlog init --defaults --no-git`: the project config the CLI writes."],
  ["create", "`task create` with title, `--description`, two `--ac`, `--labels`, `--priority`."],
  ["edit-status-assignee", "`task edit -s 'In Progress' -a '@agent-claude'`: status, assignee, and the first `updated_date`."],
  ["check-ac", "`task edit --check-ac 1`: an acceptance criterion flips to `[x]` in place."],
  ["append-notes", "`task edit --append-notes`: the `## Implementation Notes` section and its `SECTION:NOTES` markers."],
  ["final-summary", "`task edit --final-summary`: the `## Final Summary` section and its markers."],
  ["milestone-assign", "`milestone add` then `task edit -m`: the milestone file, and the `milestone:` key's position in task frontmatter."],
  ["subtask", "`task create -p TASK-1`: the `parent_task_id` key and the `task-1.1` id/filename shape."],
  ["dependency", "`task create --dep TASK-1`: the `dependencies:` sequence."],
  ["envelope-edit-before", "A task with a hand-written SPEC §6.1 `approval:` envelope spliced into its frontmatter, before the CLI touches it."],
  ["envelope-edit-after", "The same file after `task edit -s 'In Progress'`. See the envelope note below: at the pinned version the CLI **drops** the unknown key."],
];

/** Run the whole sequence, writing the corpus to `out`. */
export function regenerate(out) {
  const project = mkdtempSync(join(tmpdir(), "approval-md-backlog-fixtures-"));
  const home = mkdtempSync(join(tmpdir(), "approval-md-backlog-home-"));
  /** The pinned CLI, in the throwaway project, with a throwaway HOME. */
  const cli = (args) => backlog(project, args, home);
  try {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });

    // 1. init
    cli(["init", "Fixture Project", "--defaults", "--no-git", "--integration-mode", "none"]);
    capture(out, "init", [join(project, "backlog", "config.yml")]);

    // 2. create
    cli([
      "task", "create", "Chase deposit refund from letting agency",
      "--description", "Deposit (GBP 1,200) due back since 12 July. One polite chaser sent on 21 July, no reply.",
      "--ac", "Email sent to the agency referencing scheme deadline",
      "--ac", "Reply, if any, filed back onto this task",
      "--labels", "finance,chaser",
      "--priority", "high",
      "--plain",
    ]);
    const one = taskFile(project, "task-1");
    capture(out, "create", [one]);

    // 3. status + assignee
    cli(["task", "edit", "TASK-1", "-s", "In Progress", "-a", "@agent-claude"]);
    capture(out, "edit-status-assignee", [one]);

    // 4. check an acceptance criterion
    cli(["task", "edit", "TASK-1", "--check-ac", "1"]);
    capture(out, "check-ac", [one]);

    // 5. append implementation notes
    cli(["task", "edit", "TASK-1", "--append-notes", "Chaser sent 04 August; awaiting reply."]);
    capture(out, "append-notes", [one]);

    // 6. final summary
    cli(["task", "edit", "TASK-1", "--final-summary", "Refund received in full on 11 August."]);
    capture(out, "final-summary", [one]);

    // 7. milestone add + assign
    cli(["milestone", "add", "Deposit recovery"]);
    cli(["task", "edit", "TASK-1", "-m", "Deposit recovery"]);
    capture(out, "milestone-assign", [one, milestoneFile(project)]);

    // 8. subtask
    cli(["task", "create", "Draft the chaser copy", "-p", "TASK-1", "--plain"]);
    capture(out, "subtask", [taskFile(project, "task-1.1")]);

    // 9. dependency
    cli(["task", "create", "Verify refund landed", "--dep", "TASK-1", "--plain"]);
    capture(out, "dependency", [taskFile(project, "task-2")]);

    // 10. the envelope, before and after the CLI rewrites the file
    cli([
      "task", "create", "Send deposit chaser email",
      "--description", "Firmer follow-up citing the deposit-protection scheme deadline.",
      "--ac", "Email sent",
      "--plain",
    ]);
    const three = taskFile(project, "task-3");
    injectEnvelope(three);
    capture(out, "envelope-edit-before", [three]);
    cli(["task", "edit", "TASK-3", "-s", "In Progress"]);
    capture(out, "envelope-edit-after", [three]);

    // Version + README, generated so they cannot drift from the corpus.
    writeFileSync(join(out, "VERSION"), `${PINNED_VERSION}\n`);
    writeFileSync(join(out, "README.md"), readme());
    return out;
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The corpus README
// ---------------------------------------------------------------------------

function readme() {
  const scenarios = SCENARIOS.map(([name, text]) => `- **\`${name}/\`** — ${text}`).join("\n");
  const rules = NORMALISATION_RULES.map(
    (rule) => `- \`${rule.field}\` (${rule.why}) → \`'${DATE_SENTINEL}'\``,
  ).join("\n");
  return `# Backlog.md format fixtures (APRV-65)

**Generated. Do not hand-edit** — including this file, which
\`scripts/regen-backlog-fixtures.mjs\` writes. Change the script, then
regenerate.

These are real files written by the pinned Backlog.md CLI, captured after each
of a scripted sequence of canonical operations. approval.md extends the
Backlog.md convention and never forks it (SPEC.md principle 6, §12), so the
task-file format is a dependency this repository cannot express in
\`package.json\`. This corpus is how it is pinned: upstream format drift fails
a test here instead of quietly eating a user's envelope.

## Regeneration

\`\`\`bash
node scripts/regen-backlog-fixtures.mjs
\`\`\`

Requires Backlog.md CLI **${PINNED_VERSION}** on \`PATH\` (see
\`docs/backlog-md-pin.md\`). The exact version is recorded in \`VERSION\`
beside this file, and \`tests/backlog-fixtures.test.ts\` asserts it agrees
with the pin recorded in that document.

## Scenarios

${scenarios}

## Normalisation rule

The CLI stamps wall-clock timestamps, so raw capture would never be
reproducible. After capture, and before any comparison, these fields — and
only these — are rewritten:

${rules}

Timestamps are not the only way ambient state leaks in. The CLI copies
environment values such as \`$EDITOR\` into \`config.yml\`, so the script runs
it with a **replaced** environment and a throwaway \`HOME\`: no user config, no
editor, no locale, fixed \`TZ\`. That is why the corpus is reproducible on a
machine whose shell differs from yours.

The rule list lives in \`NORMALISATION_RULES\` in the regeneration script and
runs on **both** sides of the drift comparison. It is line-anchored and names
each field explicitly, so a newly volatile field surfaces as a drift failure
rather than being absorbed. If two regenerations differ, the normaliser is
missing a field: add a rule, never loosen the comparison.

## The envelope scenarios

\`envelope-edit-before/\` holds a task file with a SPEC §6.1 \`approval:\`
envelope spliced into its frontmatter by hand (the CLI has no notion of the
key). \`envelope-edit-after/\` is the same file after \`backlog task edit\`.

**At ${PINNED_VERSION} the CLI drops the \`approval:\` key entirely.** That is
what the fixture records: observed behaviour, not desired behaviour. SPEC.md §6
requires implementations to preserve unknown frontmatter keys; Backlog.md does
not, which is the whole reason envelope-loss detection (APRV-63) exists. A
future CLI version that preserves the key will fail the fixture comparison —
correctly. Flip the fixture deliberately at that point, in the same change that
bumps the pin, and say so in the task notes.

## Upgrading the pin

Bumping the Backlog.md pin regenerates this corpus **in the same commit**. A
version bump whose fixture diff is empty is a bump nobody verified; a version
bump with no fixture diff at all means the corpus was not regenerated.
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(argv) {
  let out = DEFAULT_OUT;
  let allowMismatch = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      out = argv[index + 1];
      if (out === undefined) throw new Error("--out requires a directory argument");
      index += 1;
    } else if (argv[index] === "--allow-version-mismatch") {
      allowMismatch = true;
    } else {
      throw new Error(`unrecognised argument ${argv[index]}`);
    }
  }

  const version = installedVersion();
  if (version === null) {
    throw new Error(
      "the Backlog.md CLI is not on PATH. Install the pinned version " +
        `(npm install -g backlog.md@${PINNED_VERSION}; see docs/backlog-md-pin.md) before regenerating.`,
    );
  }
  if (version !== PINNED_VERSION && !allowMismatch) {
    throw new Error(
      `installed Backlog.md CLI is ${version}, the pin is ${PINNED_VERSION}. ` +
        "Regenerating with an unpinned version would silently adopt whatever that version writes. " +
        "Either install the pin, or bump it deliberately (docs/backlog-md-pin.md and PINNED_VERSION here) " +
        "and regenerate in the same commit. --allow-version-mismatch overrides, for investigation only.",
    );
  }

  mkdirSync(dirname(out), { recursive: true });
  regenerate(out);
  process.stderr.write(`regen-backlog-fixtures: wrote ${SCENARIOS.length} scenarios to ${out} (CLI ${version})\n`);
}

const INVOKED_DIRECTLY =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (INVOKED_DIRECTLY) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`regen-backlog-fixtures: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  }
}
