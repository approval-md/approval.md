/**
 * What a pass-through hook invocation loads (APRV-209).
 *
 * The hook is a PreToolUse gate, so a session pays its start-up on EVERY
 * command it runs, including the reads that never touch the log. Before this
 * task `src/cli/main.ts` imported all thirty-odd verb modules statically, which
 * meant answering `cat README.md` first loaded `better-sqlite3` (a native addon,
 * reached through the reindexer) and the whole `src/channels/` family. None of
 * that is on the path from a PreToolUse event to an `allow`.
 *
 * The claim asserted here is STRUCTURAL rather than a timing bound: a named set
 * of modules is absent from the loaded-module list of a cold, real invocation.
 * A latency number would be a flake on a loaded box; "the native addon was never
 * opened" is true or false regardless of what else the machine is doing.
 *
 * How the list is collected: an ESM loader (`module.register`, Node 20.6+)
 * records the URL of every module the child resolves, written from the loader
 * thread to a file the test reads back. The loader is generated into the scratch
 * directory rather than shipped in `tests/`, because `tsc` does not copy `.mjs`
 * helpers into `dist/` and this file runs from there.
 *
 * The fixture is a 10k-record log built through the real append path, because
 * the point of the measurement is a cold invocation against a log the size of a
 * working repository's. Nothing here writes a log line by hand: the policy is
 * attested through `core/attest.ts` and the filler goes through `core/log.ts`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { appendEvent } from "../src/core/log.js";
import { attest, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

/** dist/tests/hook-module-graph.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = scratchRoot("hook-module-graph");

after(() => {
  scratch.cleanup();
});

/**
 * A policy shaped like this repository's: reads run unattended, so the command
 * under measurement is answered without a gate round trip.
 */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

const FIXTURE_RECORDS = 10_000;

/** A log of `size` records: the attestation, then filler through `appendEvent`. */
function fixture(size: number): Scenario {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  const already = readFileSync(unit.logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0).length;
  for (let index = already; index < size; index += 1) {
    const appended = appendEvent(unit.logPath, {
      ts: T0,
      event: "task.registered",
      actor: "agent:planner",
      task: `filler-${String(index).padStart(6, "0")}`,
      channel: "cli",
      payload: { title: `filler ${String(index)}` },
    });
    assert.ok(appended.ok, `filler append failed: ${JSON.stringify(appended)}`);
  }
  return unit;
}

/** One PreToolUse event, as the harness sends it. */
function bashEvent(command: string): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "module-graph probe" },
  });
}

/**
 * The loader that records what the child loads, written into the scratch root.
 *
 * Failures inside the probe are swallowed on purpose: it watches a run whose
 * verdict the test also asserts, and a probe that could change that verdict
 * would be measuring itself.
 */
function writeProbe(): { preload: string; list: string } {
  const list = join(scratch.root, "modules.txt");
  const loader = join(scratch.root, "probe-loader.mjs");
  const preload = join(scratch.root, "probe-preload.mjs");
  writeFileSync(list, "", "utf8");
  writeFileSync(
    loader,
    [
      'import { appendFileSync } from "node:fs";',
      'let out = "";',
      "export async function initialize(data) { out = data.out; }",
      "export async function load(url, ctx, next) {",
      "  const result = await next(url, ctx);",
      "  try { appendFileSync(out, `${url}\\n`); } catch {}",
      "  return result;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    preload,
    [
      'import { register } from "node:module";',
      'register(new URL("./probe-loader.mjs", import.meta.url).href, {',
      "  parentURL: import.meta.url,",
      "  data: { out: process.env['APPROVAL_MODULE_LIST'] },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return { preload, list };
}

/**
 * The modules a pass-through hook must not load, by the substring that names
 * each in a module URL.
 *
 * `@modelcontextprotocol` was already absent before APRV-209 (`cli/mcp.ts` has
 * reached the server through a dynamic import since APRV-87, pinned by
 * `tests/layering.test.ts`), and it is listed anyway: the acceptance criterion
 * names it, and a future static import from any verb would put it back.
 */
const FORBIDDEN: readonly { readonly label: string; readonly needle: string }[] = [
  { label: "the MCP SDK", needle: "@modelcontextprotocol" },
  { label: "better-sqlite3", needle: "better-sqlite3" },
  { label: "the channel modules", needle: "/src/channels/" },
];

test("a cold pass-through hook loads neither the MCP SDK, better-sqlite3, nor the channels (APRV-209)", () => {
  const unit = fixture(FIXTURE_RECORDS);
  const probe = writeProbe();

  // The child's environment is cleaned of APPROVAL_HUMAN, as in every hook
  // suite: a developer who exports it must not be able to change what this run
  // does.
  const env: NodeJS.ProcessEnv = { ...process.env, APPROVAL_MODULE_LIST: probe.list };
  delete env["APPROVAL_HUMAN"];
  const run = spawnSync(
    process.execPath,
    ["--import", probe.preload, CLI_ENTRY, "hook", "claude-code"],
    { cwd: unit.dir, encoding: "utf8", env, input: bashEvent("cat README.md") },
  );

  assert.equal(run.status, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const verdict = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  assert.equal(
    verdict.hookSpecificOutput?.permissionDecision,
    "allow",
    "the fixture policy runs reads unattended, so this is the pass-through case",
  );

  const loaded = readFileSync(probe.list, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  assert.ok(
    loaded.some((url) => url.includes("/src/cli/hook.js")),
    `the probe recorded nothing useful (${String(loaded.length)} modules); it must at least see the hook itself`,
  );

  for (const { label, needle } of FORBIDDEN) {
    const offenders = loaded.filter((url) => url.includes(needle));
    assert.deepEqual(
      offenders,
      [],
      `a pass-through hook loaded ${label}; every verb is reached through a dynamic import in src/cli/main.ts, and something imported it statically again:\n${offenders.join("\n")}`,
    );
  }
});
