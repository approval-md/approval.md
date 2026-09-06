/**
 * The Agent SDK shim (APRV-242) — the shapes, pinned.
 *
 * An application built on `claude-agent-sdk` is not a harness with a settings
 * file, so it reaches the gate through a shim: a Python `HookMatcher` callback
 * that spawns `approval hook claude-code`, writes the event to its stdin and
 * returns what it prints. `docs/agent-sdk-hook.py` is that shim and
 * `docs/agent-sdk-hook.md` is its argument.
 *
 * NO PYTHON RUNS HERE, and none runs in CI: `claude-agent-sdk` is not a
 * dependency of this repository and the recipe is documentation. What this
 * file can still hold to the wall is every claim the recipe makes about THIS
 * runtime, which is most of them:
 *
 *   1. the CLI, spawned for real on the pinned stdin, still prints the objects
 *      the fixtures say a callback returns (allow, and deny with its reason);
 *   2. the pinned stdin is the SDK's event plus exactly one added key, so the
 *      one difference between the two shapes stays one difference;
 *   3. the recipe embedded in the doc is byte-identical to the file, so the
 *      copy a reader takes is the copy that was reviewed;
 *   4. the recipe's fail-closed paths return a verdict and never the empty
 *      dict, and its refusal vocabulary stays disjoint from the runtime's.
 *
 * (3) and (4) read the Python as text. That is worth doing rather than
 * skipping: an unexecuted recipe with a silently permissive branch is worse
 * than no recipe, and the branch is exactly the sort of thing a later edit
 * introduces without noticing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { HOOK_DENY_CODES } from "../src/cli/hook.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "agent-sdk");

const RECIPE = readFileSync(join(REPO_ROOT, "docs", "agent-sdk-hook.py"), "utf8");
const DOC = readFileSync(join(REPO_ROOT, "docs", "agent-sdk-hook.md"), "utf8");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-agent-sdk-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
}

/**
 * The policy the two verdict fixtures were recorded under: `read.*` autonomous
 * so an allow needs nobody, everything else manual so a misclassification
 * cannot silently become one.
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

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A scratch repository with an attested policy and a log to append to. */
function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

/** The pinned stdin, with one command swapped in. */
function stdinFor(command: string): string {
  const pinned = fixture("hook-stdin");
  const toolInput = { ...(pinned["tool_input"] as Record<string, unknown>), command };
  return JSON.stringify({ ...pinned, tool_input: toolInput });
}

function envelopeOf(value: Record<string, unknown>): Record<string, unknown> {
  const specific = value["hookSpecificOutput"];
  assert.equal(typeof specific, "object", "a PreToolUse return carries hookSpecificOutput");
  assert.notEqual(specific, null);
  return specific as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. The event: what the SDK gives, what the CLI reads
// ---------------------------------------------------------------------------

test("the shim's stdin is the SDK's event plus tool_use_id, and nothing else", () => {
  const sdk = fixture("pretooluse-input");
  const stdin = fixture("hook-stdin");

  assert.equal(
    sdk["tool_use_id"],
    undefined,
    "the SDK passes tool_use_id as a positional argument, never inside the event",
  );
  assert.equal(typeof stdin["tool_use_id"], "string");
  assert.notEqual(stdin["tool_use_id"], "");

  const added = Object.keys(stdin).filter((key) => !(key in sdk));
  assert.deepEqual(added, ["tool_use_id"], "the shim adds exactly one key");
  for (const key of Object.keys(sdk)) {
    assert.deepEqual(stdin[key], sdk[key], `the shim must not rewrite ${key}`);
  }
});

test("the fields the gate requires are the fields the SDK's event carries", () => {
  const sdk = fixture("pretooluse-input");
  // `tool_name` is required and `tool_input.command` is required for Bash;
  // everything else the hook reads is optional (see parseHookInput).
  assert.equal(sdk["tool_name"], "Bash");
  const toolInput = sdk["tool_input"] as Record<string, unknown>;
  assert.equal(typeof toolInput["command"], "string");
  assert.equal(sdk["hook_event_name"], "PreToolUse");
});

// ---------------------------------------------------------------------------
// 2. The verdict: the CLI's stdout IS the SDK's return value
// ---------------------------------------------------------------------------

test("an allow round-trips onto the pinned SDK return shape", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, stdinFor("ls -la"));
  assert.equal(run.code, 0, `a verdict is always exit 0: ${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout) as unknown, fixture("sdk-return-allow"));
});

test("a deny round-trips onto the pinned SDK return shape, reason included", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, stdinFor("bash -c 'git push --force'"));
  assert.equal(run.code, 0, `a deny is a verdict, not an error exit: ${run.stderr}`);
  const printed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(printed, fixture("sdk-return-deny"));
  const reason = String(envelopeOf(printed)["permissionDecisionReason"]);
  assert.match(reason, /^hook-opaque: /u, "the gate's own code reaches the SDK unflattened");
});

test("both verdicts wear the envelope a PreToolUse callback returns", () => {
  const keys = ["hookEventName", "permissionDecision", "permissionDecisionReason"];
  for (const name of ["sdk-return-allow", "sdk-return-deny", "sdk-return-unreachable"]) {
    const envelope = envelopeOf(fixture(name));
    assert.deepEqual(Object.keys(envelope).sort(), [...keys].sort(), `${name} envelope keys`);
    assert.equal(envelope["hookEventName"], "PreToolUse");
    assert.deepEqual(Object.keys(fixture(name)), ["hookSpecificOutput"], `${name} carries one key`);
    assert.match(String(envelope["permissionDecision"]), /^(allow|deny)$/u, "never `ask`");
  }
});

// ---------------------------------------------------------------------------
// 3. The recipe, read as text
// ---------------------------------------------------------------------------

test("the doc embeds the recipe file verbatim", () => {
  // The doc holds a second, deliberately different python block (the wiring
  // example), so the recipe is found by its own first line rather than by
  // being the only one.
  const opening = RECIPE.slice(0, RECIPE.indexOf("\n"));
  const blocks = [...DOC.matchAll(/```python\n([\s\S]*?)```/gu)]
    .map((match) => match[1] ?? "")
    .filter((block) => block.startsWith(opening));
  assert.equal(blocks.length, 1, "one embedded recipe, so there is one copy to keep honest");
  assert.equal(blocks[0], RECIPE, "docs/agent-sdk-hook.md has drifted from docs/agent-sdk-hook.py");
});

/** The body of one `async def` in the recipe, up to the next top-level `def`. */
function recipeFunction(name: string): string {
  const start = RECIPE.indexOf(`async def ${name}(`);
  assert.notEqual(start, -1, `the recipe defines ${name}`);
  const rest = RECIPE.slice(start + 1);
  const end = rest.search(/\n(?:async )?def /u);
  return end === -1 ? rest : rest.slice(0, end);
}

test("every PreToolUse path returns a verdict, and never the empty dict", () => {
  const body = recipeFunction("approval_gate");
  const returns = [...body.matchAll(/^\s*return (.*)$/gmu)].map((match) => match[1] ?? "");
  assert.ok(returns.length >= 5, `expected the fail-closed branches, saw ${returns.length}`);
  for (const returned of returns) {
    assert.match(
      returned,
      /^_(?:deny|verdict)\(/u,
      `a PreToolUse path returns \`${returned}\`, which is not a verdict`,
    );
  }
  // The post-execution path is the one place an empty return is right: there
  // is no permission question to answer, so "no decision" is the answer.
  assert.match(recipeFunction("approval_report"), /return \{\}/u);
});

test("the shim's refusal vocabulary is disjoint from the runtime's", () => {
  const prefix = "agent-sdk-shim";
  const codes = [...RECIPE.matchAll(/_deny\("([a-z-]+)"/gu)].map((match) => match[1] ?? "");
  assert.ok(codes.length >= 4, `expected the shim's own codes, saw ${codes.join(", ")}`);

  for (const code of HOOK_DENY_CODES) {
    assert.ok(!code.startsWith(prefix), `${code} would be ambiguous with a shim-side deny`);
    assert.ok(!codes.includes(code), `${code} is the runtime's to emit, not the shim's`);
  }

  // Every code the recipe can emit is documented in the fail-closed table.
  for (const code of new Set(codes)) {
    assert.ok(DOC.includes(`${prefix}-${code}`), `docs/agent-sdk-hook.md never names ${code}`);
  }

  const unreachable = String(envelopeOf(fixture("sdk-return-unreachable"))["permissionDecisionReason"]);
  assert.match(unreachable, /^agent-sdk-shim-unreachable: /u);
  assert.equal(
    HOOK_DENY_CODES.some((code) => unreachable.startsWith(`${code}:`)),
    false,
    "a shim-side deny must never read as a gate-side one",
  );
});

test("the Claude Code hook doc links the sibling recipe", () => {
  const hookDoc = readFileSync(join(REPO_ROOT, "docs", "claude-code-hook.md"), "utf8");
  assert.ok(
    hookDoc.includes("docs/agent-sdk-hook.md"),
    "docs/claude-code-hook.md must point at the Agent SDK recipe",
  );
});
