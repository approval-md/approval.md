/**
 * `approval doctor`'s two harness-hook rows, read off a real checkout
 * (APRV-408).
 *
 * Separate from `tests/cli-doctor.test.ts` for one reason: every case here
 * needs a directory `git rev-parse` will answer for, because the fact under
 * test is which checkout the registered handler binds to, and the doctor suite
 * next door is built on scratch homes that are deliberately not repositories.
 * So each case is its own `git init`, and nothing here shares a fixture with
 * anything there.
 *
 * What is asserted is the SHAPE of each verdict and the fact each line names,
 * never the wording, with one exception per criterion where the wording IS the
 * point (the read tools are "by design", an unresolved binding is "never a
 * pass"). The doctor suite's own convention.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { HARNESS_ADAPTERS } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-doctor-wiring-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ADAPTER = HARNESS_ADAPTERS["claude-code"];
const GATED = [ADAPTER.shellTool, ...ADAPTER.fileTools];
const FULL_MATCHER = GATED.join("|");

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
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the built CLI with the ambient gate environment scrubbed. */
function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_ENV_PROVENANCE",
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A git checkout carrying a policy and the `hooks` block `build` returns.
 *
 * `build` receives the directory, because the fact most of these cases turn on
 * is whether the handler's `--dir` is this checkout, and the path is not known
 * until the directory exists.
 */
function checkout(build: (dir: string) => unknown): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const init = spawnSync("git", ["init", "--quiet"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({ hooks: build(dir) }, null, 2),
    "utf8",
  );
  return dir;
}

interface DoctorRow {
  check: string;
  status: string;
  detail: string;
  fix?: string;
}

/** One doctor row, from a real run in `dir`. */
function rowOf(dir: string, name: string): DoctorRow {
  const run = runCli(
    ["doctor", "--json", "--dir", dir, "--log", join(dir, ".approval", "log", "events.jsonl")],
    dir,
  );
  const body = JSON.parse(run.stdout) as { checks: DoctorRow[] };
  const found = body.checks.find((row) => row.check === name);
  assert.ok(found !== undefined, `no ${name} row in ${run.stdout}${run.stderr}`);
  return found;
}

/** A `PreToolUse` (and optionally `PostToolUse`) hooks block. */
function hooksWith(
  matcher: string,
  command: string,
  post: string | null = null,
): Record<string, unknown> {
  const group = (cmd: string): unknown => ({
    matcher,
    hooks: [{ type: "command", command: cmd }],
  });
  return {
    PreToolUse: [group(command)],
    ...(post === null ? {} : { PostToolUse: [group(post)] }),
  };
}

const handler = (dir: string): string => `approval hook claude-code --dir ${dir}`;

// ---------------------------------------------------------------------------
// AC1 — the roster is the adapter's
// ---------------------------------------------------------------------------

test("wiring: the gated roster comes from the Claude adapter, not from a hand list", () => {
  // The drift this criterion exists for: the hand list was Edit, Write, Bash,
  // so this exact matcher passed while a MultiEdit reached the file system
  // unclassified.
  const drifted = checkout((dir) => hooksWith("Bash|Edit|Write", handler(dir)));
  const short = rowOf(drifted, "harness-hook-wiring");
  assert.equal(short.status, "skip");
  assert.match(short.detail, /NOT WIRED for every tool/u);
  assert.match(short.detail, /does not cover MultiEdit, NotebookEdit/u);
  assert.match(short.fix ?? "", /^approval /u);

  const dir = checkout((where) => hooksWith(FULL_MATCHER, handler(where)));
  const full = rowOf(dir, "harness-hook-wiring");
  // Every tool the adapter gates is named, and the roster is read from the
  // adapter here exactly as the row reads it: a tool added there and nowhere
  // else fails this assertion rather than passing unnoticed.
  for (const tool of GATED) assert.ok(full.detail.includes(tool), `${tool} unnamed: ${full.detail}`);
  assert.doesNotMatch(full.detail, /NOT WIRED for every tool/u);
});

// ---------------------------------------------------------------------------
// AC2 — the held read tools
// ---------------------------------------------------------------------------

test("wiring: the read tools the matcher leaves out are named, and never fail the row", () => {
  const dir = checkout((where) => hooksWith(FULL_MATCHER, handler(where)));
  const held = rowOf(dir, "harness-hook-wiring");
  for (const tool of ADAPTER.readTools) {
    assert.ok(held.detail.includes(tool), `${tool} unnamed: ${held.detail}`);
  }
  assert.match(held.detail, /READ TOOLS HELD BY DESIGN/u);
  assert.match(held.detail, /documented default rather than a gap/u);
  assert.match(held.detail, /never fails this row/u);
  // It points the reader at the documented matcher line rather than restating
  // the reasoning: the decision lives in the doc, and a second copy would be a
  // second thing to keep true.
  assert.match(held.detail, /docs\/claude-code-hook\.md/u);
  assert.notEqual(held.status, "fail");

  // Registering the three tools removes the line entirely.
  const wide = checkout((where) =>
    hooksWith(`${FULL_MATCHER}|${ADAPTER.readTools.join("|")}`, handler(where)),
  );
  const widened = rowOf(wide, "harness-hook-wiring");
  assert.doesNotMatch(widened.detail, /READ TOOLS HELD BY DESIGN/u);
  assert.equal(widened.status, "pass", widened.detail);
});

// ---------------------------------------------------------------------------
// AC3 — a matcher tool the adapter does not handle
// ---------------------------------------------------------------------------

test("wiring: a matched tool the adapter does not handle is reported as an unclassified allow", () => {
  const dir = checkout((where) => hooksWith(`${FULL_MATCHER}|WebFetch`, handler(where)));
  const row = rowOf(dir, "harness-hook-wiring");
  assert.match(row.detail, /MATCHED AND NOT CLASSIFIED/u);
  assert.match(row.detail, /WebFetch/u);
  // The hook's own words for what such a call receives, so an operator reading
  // this row and an operator reading a hook transcript see the same sentence.
  assert.match(row.detail, /is not a gated tool/u);
  assert.notEqual(row.status, "fail");
});

// ---------------------------------------------------------------------------
// AC4 — the handler is parsed, and the binding is checked
// ---------------------------------------------------------------------------

test("wiring: a handler bound to another checkout fails, and names both paths", () => {
  const elsewhere = checkout((where) => hooksWith(FULL_MATCHER, handler(where)));
  const dir = checkout(() => hooksWith(FULL_MATCHER, handler(elsewhere)));
  const row = rowOf(dir, "harness-hook-wiring");
  assert.equal(row.status, "fail");
  assert.match(row.detail, /MISBOUND/u);
  assert.ok(row.detail.includes(elsewhere), `the --dir is unnamed: ${row.detail}`);
  assert.ok(row.detail.includes(dir), `the primary root is unnamed: ${row.detail}`);
  assert.match(row.fix ?? "", /^approval /u);
});

test("wiring: a handler bound to this checkout passes and says so", () => {
  // The flags in an order the committed file does not use, to pin that the
  // parse is tolerant of order and strict only about the three facts that
  // decide the binding: the executable, the verb, and `--dir`.
  const dir = checkout((where) =>
    hooksWith(
      FULL_MATCHER,
      `approval hook claude-code --timeout 9m --as agent:claude-code --dir ${where}`,
    ),
  );
  const row = rowOf(dir, "harness-hook-wiring");
  assert.equal(row.status, "pass", row.detail);
  assert.match(row.detail, /BOUND to /u);
  assert.ok(row.detail.includes(dir));
  assert.equal(row.fix, undefined);
  // APRV-151's sentence survives, because the limit is still the point.
  assert.match(row.detail, /NOT proof this session loaded it/u);
});

test("wiring: an absent or relative --dir is reported and is not a pass", () => {
  const absent = rowOf(
    checkout(() => hooksWith(FULL_MATCHER, "approval hook claude-code --as agent:claude-code")),
    "harness-hook-wiring",
  );
  assert.equal(absent.status, "skip");
  assert.match(absent.detail, /BINDING UNSTATED/u);

  const relative = rowOf(
    checkout(() => hooksWith(FULL_MATCHER, "approval hook claude-code --dir ../elsewhere")),
    "harness-hook-wiring",
  );
  assert.equal(relative.status, "skip");
  assert.match(relative.detail, /BINDING RELATIVE/u);
});

test("wiring: a command the parse cannot read is unresolved, and unresolved is never a pass", () => {
  for (const command of [
    // A wrapper: the verb is in there, and what runs is a shell's business.
    'bash -lc "approval hook claude-code --dir /tmp/wherever"',
    // A substitution: the executable is not knowable from the file.
    "$(which approval) hook claude-code --dir /tmp/wherever",
    // A shell function by another name, with the verb buried in its arguments.
    "gate-wrapper approval hook claude-code --dir /tmp/wherever",
  ]) {
    const row = rowOf(checkout(() => hooksWith(FULL_MATCHER, command)), "harness-hook-wiring");
    assert.equal(row.status, "skip", `${command}: ${row.detail}`);
    assert.match(row.detail, /BINDING UNRESOLVED/u, `${command}: ${row.detail}`);
    assert.match(row.detail, /never a pass/u, `${command}: ${row.detail}`);
  }
});

// ---------------------------------------------------------------------------
// AC5 — matchers are split on `|` and never evaluated
// ---------------------------------------------------------------------------

test("wiring: a matcher that is not a plain tool list resolves no coverage, hostile or not", () => {
  // A nested quantifier over a rejecting suffix is the classic catastrophic
  // backtracker. It is never compiled here, so the only thing it costs is one
  // anchored character-class test.
  for (const pattern of ["(a+)+$", "Bash|Edit|(x+x+)+y", "", ".*"]) {
    const row = rowOf(
      checkout((where) => hooksWith(pattern, handler(where))),
      "harness-hook-wiring",
    );
    assert.equal(row.status, "skip", `${pattern}: ${row.detail}`);
    assert.match(row.detail, /MATCHED BY PATTERN/u);
    assert.match(row.detail, /not resolved here/u);
    // No coverage claim is made either way from a pattern.
    assert.doesNotMatch(row.detail, /READ TOOLS HELD BY DESIGN/u);
    assert.doesNotMatch(row.detail, /NOT WIRED for every tool/u);
  }
});

// ---------------------------------------------------------------------------
// AC6 — both rows read the same entries
// ---------------------------------------------------------------------------

test("outcomes: another harness's entry in this file is not a Claude Code reporter", () => {
  // Before APRV-408 this row matched the substring `approval hook`, so a
  // `cursor` entry parked in Claude Code's settings file read as the
  // post-execution reporter that Claude Code does not have here.
  const foreign = checkout((where) =>
    hooksWith(FULL_MATCHER, handler(where), "approval hook cursor --dir /tmp/x"),
  );
  const row = rowOf(foreign, "harness-hook-outcomes");
  assert.equal(row.status, "fail");
  assert.match(row.detail, /PreToolUse and not for PostToolUse/u);

  // An entry of OURS that the parse cannot read still counts as registered:
  // it names the verb, and a command this file cannot read is a reason to
  // report less confidently rather than to report that nothing is registered.
  const wrapped = checkout((where) =>
    hooksWith(FULL_MATCHER, handler(where), 'bash -lc "approval hook claude-code --dir /tmp/x"'),
  );
  assert.equal(rowOf(wrapped, "harness-hook-outcomes").status, "pass");
});
