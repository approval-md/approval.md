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

/**
 * The `setup` family's own direction (APRV-79).
 *
 * `cli/setup.ts` dispatches to `setup-adapter.ts` and `setup-channel.ts`, so an
 * import back from either of them is a cycle — and a cycle in ESM is not a
 * compile error, it is a `const` that is `undefined` in one direction on the day
 * an initialisation order changes. `setup-adapter.ts` HAD one (it reached back
 * for `front` and `requireHuman`), which is why `setup-common.ts` exists: the
 * shared code moved there, and this test is the thing that keeps it there.
 */
const SETUP_DISPATCHED = ["setup-adapter.ts", "setup-channel.ts"] as const;

test("the setup subcommand modules do not import the file that dispatches them (APRV-79)", () => {
  const offenders: string[] = [];
  for (const file of SETUP_DISPATCHED) {
    assert.ok(CLI_FILES.includes(file), `src/cli/${file} does not exist`);
    const source = readFileSync(join(CLI_DIR, file), "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier === "./setup.js") {
        offenders.push(`src/cli/${file} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `cli/setup.ts dispatches these modules; an import back from one of them is an ESM cycle. Shared code belongs in cli/setup-common.ts:\n${offenders.join("\n")}`,
  );
});

test("setup-common.ts imports from neither the dispatcher nor the dispatched (APRV-79)", () => {
  const source = readFileSync(join(CLI_DIR, "setup-common.ts"), "utf8");
  const forbidden = ["./setup.js", "./setup-adapter.js", "./setup-channel.js"];
  const offenders = specifiersOf(source).filter((specifier) => forbidden.includes(specifier));
  assert.deepEqual(
    offenders,
    [],
    `cli/setup-common.ts is the bottom of the setup family: everything else imports IT. It must import none of ${forbidden.join(", ")}, and it imported ${offenders.join(", ")}`,
  );
});

/**
 * The MCP wrapper's direction (APRV-87).
 *
 * `src/mcp/` is a *caller* of the CLI, the way `src/daemon/` is a caller of the
 * core: SPEC.md §10.5 says the wrapper "shares the CLI's code paths", so it
 * imports them and the CLI does not import it back — except from `cli/mcp.ts`,
 * whose whole subject is the server, and which reaches it through a DYNAMIC
 * import so the circle `main.ts -> cli/mcp.ts -> mcp/server.ts -> main.ts` is
 * never closed statically. An ESM cycle is not a compile error; it is a binding
 * that is `undefined` in one direction on the day initialisation order changes.
 *
 * The wrapper is also held to the same daemon rule as the CLI: it publishes
 * verbs, and a verb that needed the pruner's module graph would be the APRV-59
 * mistake in a new directory.
 */
const MCP_DIR = join(REPO_ROOT, "src", "mcp");

const MCP_FILES = readdirSync(MCP_DIR)
  .filter((entry) => entry.endsWith(".ts"))
  .sort();

test("src/mcp/ exists and holds modules to check (APRV-87)", () => {
  assert.ok(MCP_FILES.length > 0, `no *.ts files found in ${MCP_DIR}`);
});

test("no CLI module statically imports src/mcp/ (APRV-87)", () => {
  const offenders: string[] = [];
  for (const file of CLI_FILES) {
    const source = readFileSync(join(CLI_DIR, file), "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith("../mcp/")) {
        offenders.push(`src/cli/${file} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `src/mcp/ imports the CLI, so a static import back is a cycle. cli/mcp.ts is the one file allowed to reach the server and it must do so with a dynamic import():\n${offenders.join("\n")}`,
  );
});

test("cli/mcp.ts is the only CLI module that reaches the server at all (APRV-87)", () => {
  const reaching = CLI_FILES.filter((file) =>
    readFileSync(join(CLI_DIR, file), "utf8").includes("../mcp/server.js"),
  );
  assert.deepEqual(
    reaching,
    ["mcp.ts"],
    "only src/cli/mcp.ts may reach src/mcp/server.ts; every other verb is reached BY it",
  );
});

test("src/mcp/ imports neither src/daemon/ nor a test helper (APRV-87)", () => {
  const offenders: string[] = [];
  for (const file of MCP_FILES) {
    const source = readFileSync(join(MCP_DIR, file), "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith("../daemon/") || specifier.includes("../../tests/")) {
        offenders.push(`src/mcp/${file} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `src/mcp/ may import src/cli/ and src/core/ and nothing else in this repository:\n${offenders.join("\n")}`,
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
