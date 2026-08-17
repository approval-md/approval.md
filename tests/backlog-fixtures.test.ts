/**
 * The Backlog.md format corpus and the pinned-CLI drift guard (APRV-65).
 *
 * approval.md extends the Backlog.md file convention and never forks it
 * (SPEC.md principle 6, §12). That makes the *bytes* the Backlog.md CLI writes
 * into task files a dependency of this repository, and one that
 * `package-lock.json` cannot pin: Backlog.md is not an npm dependency here, it
 * is a file format our parser reads (`src/core/frontmatter.ts`) and M6's writer
 * must round-trip. APRV-52 pinned the CLI version in prose and recorded the gap
 * that no test enforced it. This suite closes it.
 *
 * Two halves, deliberately separated by what they need:
 *
 *   1. **The corpus parses.** Every committed fixture goes through this repo's
 *      own frontmatter parser and must come out the way the corpus says it
 *      should. Pure file reads: runs on every machine, every CI runner, always.
 *
 *   2. **The corpus is current.** When the pinned CLI is installed, regenerate
 *      into a temp directory and compare byte for byte. Absent the CLI — or on
 *      a different version — the guard *skips with the reason stated*, because
 *      a check that silently degrades into a pass is worse than no check: it
 *      launders "we could not look" into "we looked and it was fine".
 *
 * Normalisation is not duplicated here. The regeneration script owns the rule
 * list and applies it on the way out, so both sides of the comparison are
 * normalised by the same lines of code and cannot drift apart. The corpus
 * README documents the rule; a test below asserts the committed bytes actually
 * carry the sentinel, so a hand-edited fixture that skipped the script is
 * caught even when the drift guard is skipped.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseFrontmatter } from "../src/core/frontmatter.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CORPUS = join(REPO_ROOT, "tests", "fixtures", "backlog");
const SCRIPT = join(REPO_ROOT, "scripts", "regen-backlog-fixtures.mjs");
const PIN_DOC = join(REPO_ROOT, "docs", "backlog-md-pin.md");

/** The sentinel the regeneration script rewrites every timestamp to. */
const DATE_SENTINEL = "2000-01-01 00:00";

/**
 * The scenarios the corpus must contain, and whether the captured task file
 * still carries an `approval:` envelope.
 *
 * This list is the corpus's contract, restated independently of the script
 * that writes it. A regeneration that quietly stops producing a scenario would
 * pass a directory-to-directory comparison (both sides would lack it); it fails
 * here.
 */
const SCENARIOS: ReadonlyArray<{ name: string; envelope: boolean }> = [
  { name: "init", envelope: false },
  { name: "create", envelope: false },
  { name: "edit-status-assignee", envelope: false },
  { name: "check-ac", envelope: false },
  { name: "append-notes", envelope: false },
  { name: "final-summary", envelope: false },
  { name: "milestone-assign", envelope: false },
  { name: "subtask", envelope: false },
  { name: "dependency", envelope: false },
  { name: "envelope-edit-before", envelope: true },
  // Not a typo, and not an aspiration: at the pinned version the CLI drops the
  // key it does not know. See the corpus README and the test below.
  { name: "envelope-edit-after", envelope: false },
];

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function corpusFiles(): string[] {
  return walk(CORPUS);
}

/** The CLI version the committed corpus was produced by. */
function corpusVersion(): string {
  return readFileSync(join(CORPUS, "VERSION"), "utf8").trim();
}

// ---------------------------------------------------------------------------
// The corpus itself — runs everywhere
// ---------------------------------------------------------------------------

test("the committed corpus contains every scenario", () => {
  const present = readdirSync(CORPUS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    present,
    SCENARIOS.map((scenario) => scenario.name).sort(),
    "the fixture corpus no longer holds exactly the scenarios this suite knows about; " +
      "regenerate with `node scripts/regen-backlog-fixtures.mjs` and update SCENARIOS here in the same change",
  );
  for (const { name } of SCENARIOS) {
    const files = walk(join(CORPUS, name));
    assert.ok(files.length > 0, `scenario ${name} captured no files`);
  }
});

test("the corpus records the CLI version, and it is the documented pin", () => {
  const version = corpusVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/u, `tests/fixtures/backlog/VERSION is not a version string: ${version}`);
  const pinDoc = readFileSync(PIN_DOC, "utf8");
  assert.ok(
    pinDoc.includes(version),
    `the corpus was generated by Backlog.md ${version}, which docs/backlog-md-pin.md does not mention. ` +
      "Bumping the pin regenerates the corpus in the same commit; a pin and a corpus that disagree mean " +
      "the format under test is not the format the project claims to support.",
  );
  assert.ok(
    readFileSync(join(CORPUS, "README.md"), "utf8").includes(version),
    "the corpus README no longer names the CLI version it was generated from",
  );
});

test("every committed fixture markdown file parses through core/frontmatter", () => {
  const markdown = corpusFiles().filter((file) => file.endsWith(".md") && file !== "README.md");
  assert.ok(markdown.length >= SCENARIOS.length - 1, "the corpus holds implausibly few markdown fixtures");
  for (const file of markdown) {
    const text = readFileSync(join(CORPUS, file), "utf8");
    const parsed = parseFrontmatter(text);
    assert.ok(
      parsed.ok,
      `${file} does not parse: ${parsed.ok ? "" : `${parsed.code}: ${parsed.message}`}. ` +
        "This is real output from the pinned Backlog.md CLI, so a failure here is our parser refusing a file " +
        "a user's board tool will hand it.",
    );
    assert.equal(typeof parsed.data["id"], "string", `${file} has no string id in frontmatter`);
    assert.equal(typeof parsed.data["title"], "string", `${file} has no string title in frontmatter`);
  }
});

test("only the before-edit envelope fixture carries an approval key", () => {
  for (const { name, envelope } of SCENARIOS) {
    for (const file of walk(join(CORPUS, name))) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseFrontmatter(readFileSync(join(CORPUS, name, file), "utf8"));
      assert.ok(parsed.ok, `${name}/${file} does not parse`);
      const has = Object.hasOwn(parsed.data, "approval");
      assert.equal(
        has,
        envelope,
        envelope
          ? `${name}/${file} was expected to carry an approval envelope and does not`
          : `${name}/${file} carries an approval envelope and was not expected to`,
      );
    }
  }
});

test("the pinned CLI drops the approval envelope on edit, and the corpus says so", () => {
  // The APRV-60 reproduction, frozen. SPEC.md §6 requires implementations to
  // preserve unknown frontmatter keys when rewriting task files; Backlog.md
  // 1.49.3 does not, which is why envelope-loss detection (APRV-63) has to
  // exist at all. This asserts the *observed* behaviour, so that a future CLI
  // that starts preserving the key fails here and gets adopted deliberately
  // rather than noticed by accident.
  const before = parseFrontmatter(
    readFileSync(join(CORPUS, "envelope-edit-before", walk(join(CORPUS, "envelope-edit-before"))[0] as string), "utf8"),
  );
  const after = parseFrontmatter(
    readFileSync(join(CORPUS, "envelope-edit-after", walk(join(CORPUS, "envelope-edit-after"))[0] as string), "utf8"),
  );
  assert.ok(before.ok && after.ok, "the envelope fixtures must parse");

  const envelope = before.data["approval"];
  assert.ok(
    typeof envelope === "object" && envelope !== null && !Array.isArray(envelope),
    "the before fixture's approval key is not a mapping; it should be a SPEC §6.1-shaped envelope",
  );
  for (const key of ["origin", "route", "state", "actions", "budget"]) {
    assert.ok(
      Object.hasOwn(envelope as Record<string, unknown>, key),
      `the before fixture's envelope is missing \`${key}\`; it must be SPEC §6.1-shaped to be a fair test`,
    );
  }

  assert.ok(
    !Object.hasOwn(after.data, "approval"),
    "Backlog.md now preserves the `approval:` key through `task edit`. That is good news and a deliberate " +
      "change: bump the pin, regenerate the corpus, flip this assertion and the corpus README's envelope note " +
      "in the same commit, and say so in the task's implementation notes.",
  );
  // The rest of the file must be intact: the drop is scoped to the unknown key,
  // not a wholesale rewrite. Status is the field the edit actually changed.
  assert.equal(before.data["id"], after.data["id"]);
  assert.equal(before.data["title"], after.data["title"]);
  assert.equal(after.data["status"], "In Progress");

  assert.ok(
    readFileSync(join(CORPUS, "README.md"), "utf8").includes("drops the `approval:` key"),
    "the corpus README no longer states what the envelope-edit scenarios observed",
  );
});

test("every committed fixture timestamp is the normalisation sentinel", () => {
  // Cheap, and it runs on machines with no CLI: a fixture committed by hand,
  // or by a script whose normaliser was bypassed, still carries a real
  // wall-clock stamp and is caught here rather than at the next unrelated
  // regeneration.
  for (const file of corpusFiles()) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(join(CORPUS, file), "utf8");
    for (const match of text.matchAll(/^(created_date|updated_date):\s*(.+)$/gmu)) {
      assert.equal(
        match[2],
        `'${DATE_SENTINEL}'`,
        `${file} carries a non-normalised ${match[1] ?? ""} (${match[2] ?? ""}). ` +
          "Fixtures are generated: run `node scripts/regen-backlog-fixtures.mjs`.",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The drift guard — needs the pinned CLI, skips loudly without it
// ---------------------------------------------------------------------------

/** The installed CLI version, or null when `backlog` is not on PATH. */
function installedVersion(): string | null {
  const result = spawnSync("backlog", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.trim();
}

const PINNED = corpusVersion();
const INSTALLED = installedVersion();
const SKIP_REASON =
  INSTALLED === null
    ? `backlog CLI absent; drift guard not run (pinned ${PINNED}; see docs/backlog-md-pin.md)`
    : INSTALLED === PINNED
      ? false
      : `backlog CLI version ${INSTALLED} != pinned ${PINNED}; drift guard not run`;

test(
  "a fresh regeneration is byte-identical to the committed corpus",
  { skip: SKIP_REASON },
  () => {
    const out = mkdtempSync(join(tmpdir(), "approval-md-drift-"));
    try {
      const fresh = join(out, "backlog");
      const run = spawnSync(process.execPath, [SCRIPT, "--out", fresh], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      assert.equal(
        run.status,
        0,
        `regen-backlog-fixtures.mjs exited ${String(run.status)}:\n${run.stdout}\n${run.stderr}`,
      );

      const committed = corpusFiles();
      const regenerated = walk(fresh);

      const missing = committed.filter((file) => !regenerated.includes(file));
      const extra = regenerated.filter((file) => !committed.includes(file));
      const differing: string[] = [];
      for (const file of committed) {
        if (!regenerated.includes(file)) continue;
        const left = readFileSync(join(CORPUS, file), "utf8");
        const right = readFileSync(join(fresh, file), "utf8");
        if (left !== right) differing.push(`${file}: ${firstDifference(left, right)}`);
      }

      const problems = [
        ...missing.map((file) => `only in the committed corpus: ${file}`),
        ...extra.map((file) => `only in the regeneration: ${file}`),
        ...differing,
      ];
      assert.deepEqual(
        problems,
        [],
        `the committed Backlog.md fixture corpus differs from what CLI ${String(INSTALLED)} produces now:\n` +
          problems.map((line) => `  - ${line}`).join("\n") +
          "\n\nEither the CLI changed its task-file format (read the upstream changelog, decide whether our " +
          "parser and the M6 writer still hold, then regenerate deliberately), or the corpus was hand-edited. " +
          `Regenerate with: node ${relative(REPO_ROOT, SCRIPT)}`,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
);

/** A one-line summary of where two texts first diverge. */
function firstDifference(left: string, right: string): string {
  const a = left.split("\n");
  const b = right.split("\n");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return `line ${index + 1}: committed ${JSON.stringify(a[index] ?? "<eof>")} vs regenerated ${JSON.stringify(b[index] ?? "<eof>")}`;
    }
  }
  return "identical line-wise but not byte-wise (line-ending or trailing-byte difference)";
}

test("the regeneration script refuses a CLI version other than the pin", () => {
  // The guard that keeps an accidental upgrade from rewriting the corpus into
  // whatever the new version writes. Asserted from the script's source rather
  // than by running it, because provoking it needs a second CLI install.
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(
    source.includes(`export const PINNED_VERSION = "${PINNED}"`),
    `scripts/regen-backlog-fixtures.mjs no longer pins ${PINNED}, which is what tests/fixtures/backlog/VERSION records`,
  );
  assert.ok(
    source.includes("version !== PINNED_VERSION && !allowMismatch"),
    "the regeneration script no longer refuses to run against an unpinned CLI version",
  );
});

test("the corpus directory is reachable and not empty", () => {
  assert.ok(statSync(CORPUS).isDirectory(), "tests/fixtures/backlog is missing");
  assert.ok(corpusFiles().length > SCENARIOS.length, "the corpus holds fewer files than it has scenarios");
});
