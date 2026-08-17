/**
 * Layering guard (APRV-59) — the CLI calls the core, not the daemon.
 *
 * `src/daemon/` is a *caller* of the core: it loops, reads a clock, and appends.
 * A CLI verb that imports from it inverts the direction, and the inversion is
 * the kind that arrives one convenient function at a time. `approval doctor` and
 * `approval status` reached into `daemon/prune.ts` for the payload-store census
 * (APRV-41) because that is where the counts happened to be written; the numbers
 * were right and the dependency was backwards, which meant a reporting verb
 * pulled in the pruner's module graph to print four integers.
 *
 * The one legitimate exception is `src/cli/daemon.ts`, whose whole subject is
 * the daemon: `approval daemon` starts it, so importing it is the verb working.
 *
 * The check reads the checked-in source rather than any build output, and names
 * the offending file when it fails, so a future violation arrives as "this file,
 * this import" and not as a puzzle. Shared code a CLI verb needs belongs in
 * `src/core/`; move it there rather than adding a name to the exception list.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_DIR = join(REPO_ROOT, "src", "cli");

/**
 * CLI modules allowed to import from `src/daemon/`, pinned as a list so that
 * widening the exception is itself a reviewable diff.
 */
const DAEMON_IMPORTERS_ALLOWED: readonly string[] = ["daemon.ts"];

/** `import ... from "<specifier>"` and `export ... from "<specifier>"`, static form. */
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/gu;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

const CLI_FILES = readdirSync(CLI_DIR)
  .filter((entry) => entry.endsWith(".ts"))
  .sort();

test("the CLI directory is readable and holds modules to check", () => {
  assert.ok(CLI_FILES.length > 0, `no *.ts files found in ${CLI_DIR}`);
});

test("no CLI module imports from src/daemon/ except the daemon verb (APRV-59)", () => {
  const offenders: string[] = [];
  for (const file of CLI_FILES) {
    if (DAEMON_IMPORTERS_ALLOWED.includes(file)) continue;
    const source = readFileSync(join(CLI_DIR, file), "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith("../daemon/")) {
        offenders.push(`src/cli/${file} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `CLI modules must not depend on src/daemon/; move the shared code into src/core/:\n${offenders.join("\n")}`,
  );
});

test("the exception list names only files that exist and do import the daemon", () => {
  for (const file of DAEMON_IMPORTERS_ALLOWED) {
    assert.ok(
      CLI_FILES.includes(file),
      `exception list names src/cli/${file}, which does not exist`,
    );
    const source = readFileSync(join(CLI_DIR, file), "utf8");
    assert.ok(
      specifiersOf(source).some((specifier) => specifier.startsWith("../daemon/")),
      `src/cli/${file} is excepted from the layering rule but imports nothing from src/daemon/: drop it from the list`,
    );
  }
});
