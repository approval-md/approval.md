/**
 * Site version guard (APRV-332, widened by APRV-395): the published pages state
 * the package version in prose, and prose goes stale silently. The landing page
 * said 0.1.0 for a day after 0.2.0 shipped. This test binds every version string
 * on the site to `package.json`, so a version bump that forgets a page fails CI
 * rather than publishing a wrong number.
 *
 * ## Why the strings are a table
 *
 * The first version of this guard bound four of them and left four siblings
 * stating the same fact bound to nothing. The 0.3.0 bump moved all eight: the
 * guarded four because the suite failed otherwise, and the unguarded four by
 * hand, on a ruling, which is exactly the hand step a guard exists to remove
 * (APRV-395). A half-guarded set is worse than an unguarded one, because it
 * reads as covered.
 *
 * So the strings are data, every one of them, and one test walks the table and
 * reports EVERY miss in a single message. A bump that touches `package.json`
 * alone gets the whole list of files still to move rather than the first one.
 *
 * ## Why no page claims a publication any more
 *
 * `llms.txt` used to say "Version X is published on npm" the moment
 * `package.json` read X. That is false for the whole window between the bump
 * merging and the Trusted Publishing run finishing, because the tag and the
 * publish are separate gated acts (APRV-307, APRV-329). A site documenting a
 * project about not making claims you cannot support should not open with one.
 *
 * Both shapes of fix were considered (APRV-395 AC2) and the sentence was
 * reworded rather than keyed to the latest published tag. The reasoning is in
 * the task's implementation notes, and the short form is that a git tag is not
 * a publication either: it records that a release was tagged, and the registry
 * is the only thing that knows what is on the registry. Keying the claim to the
 * tag would have swapped one unsupportable claim for a second one that looks
 * authoritative. The pages now state the version this source tree carries,
 * which is a fact the repository can prove about itself, and they link to npm
 * without asserting what is there.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/* Runs from dist/tests/ after tsc, so the repo root is three levels up. */
const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string };
const version = pkg.version;

/** The version as a regular-expression literal: the dots are dots. */
const escape = (value: string): string => value.replaceAll(".", "\\.");

interface VersionString {
  /** The file a bump has to edit. Named in the failure message. */
  readonly file: string;
  /** What the string is, in the words a person editing the file would use. */
  readonly what: string;
  /** How the string reads when the site is at `value`. */
  readonly pattern: (value: string) => RegExp;
  /** How many times it appears. Exact, so a duplicate is caught too. */
  readonly times: number;
}

/**
 * Every version string on the published site.
 *
 * Adding a version string to a page means adding a row here. That is the
 * whole convention, and it is the one the four unguarded strings of APRV-395
 * were missing.
 */
const STRINGS: readonly VersionString[] = [
  {
    file: "index.html",
    what: "the #pkg-version note",
    pattern: (value) => new RegExp(`id="pkg-version">v${escape(value)}<`, "gu"),
    times: 1,
  },
  {
    file: "index.html",
    what: "the JSON-LD softwareVersion",
    pattern: (value) => new RegExp(`"softwareVersion": "${escape(value)}"`, "gu"),
    times: 1,
  },
  {
    file: "features/index.html",
    what: "the JSON-LD softwareVersion",
    pattern: (value) => new RegExp(`"softwareVersion": "${escape(value)}"`, "gu"),
    times: 1,
  },
  {
    file: "features/index.html",
    what: "the footer's “Feature index for approval-md X” line",
    pattern: (value) => new RegExp(`Feature index for approval-md ${escape(value)}`, "gu"),
    times: 1,
  },
  {
    // Anchored at the line start so it cannot be satisfied by the JSON-LD
    // `"softwareVersion"` above, which ends in the same characters.
    file: "features/index.html",
    what: "the #feature-index JSON version key",
    pattern: (value) => new RegExp(`^  "version": "${escape(value)}",$`, "gmu"),
    times: 1,
  },
  {
    // Twice: the opening paragraph and the npm bullet. One phrase for both, so
    // there is one sentence shape to keep true rather than two.
    file: "llms.txt",
    what: "the two “The current version is X” sentences",
    pattern: (value) => new RegExp(`The current version is ${escape(value)}[.,]`, "gu"),
    times: 2,
  },
  {
    file: "llms-full.txt",
    what: "the bare vX line under the install command",
    pattern: (value) => new RegExp(`^v${escape(value)}\\.`, "gmu"),
    times: 1,
  },
  {
    file: "llms-full.txt",
    what: "the “Feature index: approval-md X” line",
    pattern: (value) => new RegExp(`Feature index: approval-md ${escape(value)}`, "gu"),
    times: 1,
  },
];

/** Every row of {@link STRINGS} that does not read `value`, as a report line. */
function unbound(value: string): string[] {
  const misses: string[] = [];
  for (const row of STRINGS) {
    const found = [...read(row.file).matchAll(row.pattern(value))].length;
    if (found !== row.times) {
      misses.push(
        `${row.file}: ${row.what} should state ${value} ${row.times === 1 ? "once" : `${row.times} times`}, found ${found}`,
      );
    }
  }
  return misses;
}

test("every version string on the site states the package version", () => {
  const misses = unbound(version);
  assert.deepEqual(
    misses,
    [],
    `package.json reads ${version} and the site does not. Still to move:\n  ${misses.join("\n  ")}`,
  );
});

/**
 * The guard's own failure, exercised rather than assumed (APRV-395 AC3).
 *
 * A bump that edits `package.json` and nothing else is the case this file
 * exists for, and a guard that reported only the first stale file would send
 * the next release round the loop eight times. So the report is asserted to
 * name every file, from a version no page can be at.
 */
test("a bump that moves package.json alone is reported against every file", () => {
  const misses = unbound("99.99.99");
  assert.equal(
    misses.length,
    STRINGS.length,
    `the guard found ${misses.length} of ${STRINGS.length} strings stale at a version the site cannot be at:\n  ${misses.join("\n  ")}`,
  );
  for (const file of ["index.html", "features/index.html", "llms.txt", "llms-full.txt"]) {
    assert.ok(
      misses.some((miss) => miss.startsWith(`${file}:`)),
      `the report does not name ${file}, so a bump that forgot it would not be told`,
    );
  }
});

/**
 * The claim the pages may not make (APRV-395 AC2).
 *
 * `package.json` reading X means the source tree is at X. It does not mean X
 * is on npm: the tag and the publish are separate gated acts, and for the
 * window between them the old sentence was simply false. Rewording it fixes
 * nothing if the next edit writes it back, so the sentence shape is banned
 * here rather than only replaced above.
 */
test("no page claims a version is published on npm", () => {
  for (const file of ["index.html", "features/index.html", "llms.txt", "llms-full.txt"]) {
    assert.doesNotMatch(
      read(file),
      /(?:version|v)\s*\d+\.\d+\.\d+\s+is published on npm|published version \d+\.\d+\.\d+/iu,
      `${file} states that a version is published on npm. The repository cannot know that: the bump, the tag and the Trusted Publishing run are separate gated acts, so the claim is false for the whole window between them. State the version this tree carries and link to npm without answering for it.`,
    );
  }
});
