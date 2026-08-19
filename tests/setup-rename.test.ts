/**
 * The rename guard (APRV-79) — `setup telegram` is gone, everywhere.
 *
 * `approval setup telegram` became `approval setup channel telegram`, with no
 * alias: SPEC.md §4 separates channels (which surface requests and collect
 * decisions and hold no state) from adapters (which execute side effects and
 * hold credentials), and the two setup verbs fill different stores — a channel's
 * token goes to the OS keystore and `.approval/env`, an adapter's credentials go
 * to the vault. A rename with no alias is only complete if nothing still prints
 * the old spelling, because every remaining mention is a command that now exits
 * 2 at whoever copies it.
 *
 * So this sweeps the shipped surfaces — `src/`, `docs/`, `examples/`,
 * `README.md`, `SPEC.md` — for the bare phrase, and names the file and line when
 * it finds one. `tests/` is deliberately NOT swept: this file has to say the old
 * phrase to test for it, and so does the case that proves the refusal.
 *
 * ## The one exemption, and how it is spelled
 *
 * The dispatch's refusal must quote the old form to say what changed. That
 * sentence lives in `cli/setup-channel.ts` as a single-line constant named
 * {@link RENAMED_NOTICE}, and the rule below is: a line carrying the phrase is
 * an offence UNLESS the same line also carries the identifier `RENAMED_NOTICE`.
 *
 * One line, one identifier, no path list. A future line that reintroduces the
 * old spelling cannot claim the exemption by being in the right file — it has to
 * name the constant out loud, which is a thing a reviewer sees.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { RENAMED_NOTICE } from "../src/cli/setup-channel.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The shipped surfaces. `tests/` is excluded; see the module doc. */
const DIRECTORIES = ["src", "docs", "examples"] as const;
const FILES = ["README.md", "SPEC.md"] as const;

/**
 * `setup telegram`, except where `channel ` already precedes it.
 *
 * The lookbehind is the whole check: `approval setup channel telegram` contains
 * the substring and is the correct spelling, so a plain `includes` would flag
 * every corrected line in the repository.
 */
const BARE_PHRASE = /(?<!channel )setup telegram/u;

/** The exemption marker: the constant's own name, on the same line. */
const EXEMPT = "RENAMED_NOTICE";

const EXTENSIONS = [".ts", ".md", ".js", ".mjs", ".json", ".html"];

function walk(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
      continue;
    }
    if (EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path);
  }
}

function scannedFiles(): string[] {
  const found: string[] = [];
  for (const dir of DIRECTORIES) walk(join(REPO_ROOT, dir), found);
  for (const file of FILES) found.push(join(REPO_ROOT, file));
  return found.sort();
}

test("nothing shipped still says `setup telegram` (APRV-79)", () => {
  const files = scannedFiles();
  assert.ok(files.length > 0, "the rename sweep found no files to scan");

  const offenders: string[] = [];
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!BARE_PHRASE.test(line)) return;
      if (line.includes(EXEMPT)) return;
      offenders.push(`${relative(REPO_ROOT, path)}:${String(index + 1)}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `\`approval setup telegram\` was renamed to \`approval setup channel telegram\` with NO alias (APRV-79), so each line below prints a command that exits 2 at whoever copies it:\n${offenders.join("\n")}`,
  );
});

test("the exemption exists, is one line, and says what changed", () => {
  const source = readFileSync(
    join(REPO_ROOT, "src", "cli", "setup-channel.ts"),
    "utf8",
  ).split("\n");
  const claiming = source.filter((line) => BARE_PHRASE.test(line) && line.includes(EXEMPT));

  assert.equal(
    claiming.length,
    1,
    "exactly one line in cli/setup-channel.ts may carry the old spelling: the RENAMED_NOTICE constant. A second one means the exemption has become a loophole",
  );
  // And the constant itself is the refusal an operator reads, not a leftover.
  assert.match(RENAMED_NOTICE, /is now `approval setup channel telegram`/u);
  assert.match(RENAMED_NOTICE, /there is no alias/u);
  // APRV-91: the notice states the channel/adapter distinction in operator
  // language. The §4 citation behind it is in `approval setup channel --help`
  // and docs/cli-reference.md#setup, not on a line an operator hits by typo.
  assert.match(RENAMED_NOTICE, /A channel surfaces requests/u);
  assert.doesNotMatch(RENAMED_NOTICE, /SPEC\.md §/u);
});
