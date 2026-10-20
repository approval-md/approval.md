/**
 * 0.4.7 (EDGEOS-BLOCK): the `fetch-output-unknown` refusal names its remedy
 * when a `$`-first word in curl's or wget's option slot caused it.
 *
 * Core 0.4.6 (APRV-511) classes `curl -H "…" "${EDGEOS_API_BASE:-https://…}/events"`
 * `policy.core` by rule `fetch-output-unknown`: the quoted word is one argv
 * word, but the variable could hold `-o <organ path>`, so the download's output
 * is unknowable. A policy that reserves `policy.core` (the overlay template
 * does) denies it with `hook-class-human-only`, and the agent was told the
 * class and nothing about the shape that runs. 0.4.7 adds one fixed line,
 * {@link FETCH_DOLLAR_WORD_REMEDY}, to that refusal and to no other.
 *
 * What this file pins, mutant by mutant:
 * - the class, the rule and the bound word are byte for byte 0.4.6's for every
 *   `$`-first shape (`"$X/path"`, `$X`, `"${X:-https://h}/p"`) and for
 *   `-K "$C"`: no shape that 0.4.6 held is let through;
 * - the hook still DENIES each of them with `hook-class-human-only`;
 * - the remedy line rides the refusal for the `$`-first shapes only, and every
 *   other cause of the rule (a config source, an unknown option, an ambiguous
 *   prefix, an output value a variable decides) keeps 0.4.6's refusal, which
 *   ends at "The gate's own code for this fact is `class-human-only`.";
 * - the remedy's own shape (`--url "$X/path"`) is the one that runs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook, FETCH_DOLLAR_WORD_REMEDY, fetchOutputRemedy } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-fetch-remedy-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The shapes 0.4.6 holds because a `$`-first word sits in an option slot. */
const DOLLAR_FIRST: { command: string; word: string }[] = [
  { command: 'curl -s "$X/path"', word: "$X/path" },
  { command: "curl -s $X", word: "$X" },
  { command: 'curl -s "${X:-https://h}/p"', word: "${X:-https://h}/p" },
  {
    // The EdgeOS recipe shape that EDGEOS-BLOCK was, verbatim but for the path.
    command:
      'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events"',
    word: "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events",
  },
  { command: 'curl -s "$X/path" | jq .', word: "$X/path" },
  { command: 'wget -q "$X/path"', word: "$X/path" },
];

/** Other causes of the same rule, each with the word 0.4.6 binds. None carries the remedy. */
const OTHER_CAUSES: { command: string; word: string }[] = [
  { command: 'curl -K "$C" https://h/p', word: "-K" },
  { command: "curl -K cfg https://h/p", word: "-K" },
  { command: "curl --frobnicate https://h/p", word: "--frobnicate" },
  { command: "curl --outp=x https://h/p", word: "--outp=x" },
  { command: 'curl -o "$OUT" https://h/p', word: "-o" },
  { command: "wget -e output_document=x https://h/p", word: "-e" },
  // A variable that does not START the word splits it, and that is a different cause.
  { command: "curl https://h/$ID", word: "https://h/$ID" },
];

function only(command: string): { cls: string; rule: string; path: string | undefined } {
  const result = classifyForHook(command, [], scratch, []).result;
  assert.ok(result.ok, `${command}: ${JSON.stringify(result)}`);
  const held = result.segments.filter((segment) => segment.rule === "fetch-output-unknown");
  assert.equal(held.length, 1, `${command}: ${JSON.stringify(result.segments)}`);
  const segment = held[0]!;
  return { cls: segment.class, rule: segment.rule, path: segment.path };
}

test("classifier: every $-first shape and -K \"$C\" keep 0.4.6's class, rule and bound word", () => {
  for (const { command, word } of [...DOLLAR_FIRST, ...OTHER_CAUSES]) {
    assert.deepEqual(only(command), { cls: "policy.core", rule: "fetch-output-unknown", path: word }, command);
  }
});

test("classifier: the remedy's own shape, the same word as --url's value, is no write", () => {
  for (const command of [
    'curl -s --url "$X/path"',
    'curl -s --url "${X:-https://h}/p"',
    'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events"',
  ]) {
    const result = classifyForHook(command, [], scratch, []).result;
    assert.ok(result.ok, command);
    assert.ok(!result.classes.includes("policy.core"), `${command}: ${result.classes.join(",")}`);
    assert.ok(!result.segments.some((segment) => segment.rule === "fetch-output-unknown"), command);
  }
  // The remedy is quoted on purpose: an unquoted `$X` splits, and `--url $X` stays held.
  assert.ok(classifyForHook("curl -s --url $X", [], scratch, []).result.ok);
  const unquoted = classifyForHook("curl -s --url $X", [], scratch, []).result;
  assert.ok(unquoted.ok && unquoted.classes.includes("policy.core"));
});

test("fetchOutputRemedy: fires on a $-first bound word of the reserved class only", () => {
  const seg = (path: string | undefined, cls = "policy.core", rule = "fetch-output-unknown") => ({
    text: "curl",
    class: cls,
    rule,
    ...(path === undefined ? {} : { path }),
  });
  assert.equal(fetchOutputRemedy([seg("$X/path")], "policy.core"), ` ${FETCH_DOLLAR_WORD_REMEDY}`);
  assert.equal(fetchOutputRemedy([seg("${X:-https://h}/p")], "policy.core"), ` ${FETCH_DOLLAR_WORD_REMEDY}`);
  // Mutants of the predicate: each one alone must not fire.
  assert.equal(fetchOutputRemedy([seg("-K")], "policy.core"), "");
  assert.equal(fetchOutputRemedy([seg("https://h/$ID")], "policy.core"), "");
  assert.equal(fetchOutputRemedy([seg(undefined)], "policy.core"), "");
  assert.equal(fetchOutputRemedy([seg("$X/path", "policy.core", "protected-path")], "policy.core"), "");
  assert.equal(fetchOutputRemedy([seg("$X/path", "policy.edit")], "policy.core"), "");
  assert.equal(fetchOutputRemedy(undefined, "policy.core"), "");
  assert.equal(fetchOutputRemedy([], "policy.core"), "");
  // One line: no newline inside it, and it names both the curl shape and wget's way out.
  assert.ok(!FETCH_DOLLAR_WORD_REMEDY.includes("\n"));
  assert.ok(FETCH_DOLLAR_WORD_REMEDY.includes('`curl --url "$VAR/..."`'));
  assert.ok(FETCH_DOLLAR_WORD_REMEDY.includes("wget has no `--url`, so use `curl --url` instead"));
});

// ---------------------------------------------------------------------------
// The hook end to end, under a policy that reserves policy.core as the
// overlay template does.
// ---------------------------------------------------------------------------

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
  "  network.call:",
  "    autonomy: autonomous",
  "  policy.core:",
  "    autonomy: human-only",
  "  log.mutate:",
  "    autonomy: human-only",
  "```",
  "",
].join("\n");

function runCli(args: string[], cwd: string, input = ""): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function ready(): string {
  const dir = join(scratch, "gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const gate = ready();
let calls = 0;

function hook(command: string): { permission: string; reason: string } {
  calls += 1;
  const event = JSON.stringify({
    session_id: "sess-fetch",
    transcript_path: "/dev/null",
    cwd: gate,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "fetch the events" },
    tool_use_id: `tu-fetch-${calls}`,
  });
  const run = runCli(["hook", "claude-code", "--timeout", "200ms", "--interval", "50ms"], gate, event);
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, unknown>>)["hookSpecificOutput"];
  assert.ok(output !== undefined, "hookSpecificOutput is present");
  return { permission: String(output["permissionDecision"]), reason: String(output["permissionDecisionReason"]) };
}

const ZERO_FOUR_SIX_TAIL = "The gate's own code for this fact is `class-human-only`.";

test("hook: each $-first shape is still denied human-only, and the refusal ends with the remedy line", () => {
  for (const { command } of DOLLAR_FIRST) {
    const verdict = hook(command);
    assert.equal(verdict.permission, "deny", `${command}: ${verdict.reason}`);
    assert.match(verdict.reason, /^hook-class-human-only: class policy\.core resolves to human-only/u, command);
    assert.ok(
      verdict.reason.endsWith(`${ZERO_FOUR_SIX_TAIL} ${FETCH_DOLLAR_WORD_REMEDY}`),
      `${command}: ${verdict.reason}`,
    );
    assert.equal(verdict.reason.split(FETCH_DOLLAR_WORD_REMEDY).length, 2, `${command}: the line appears once`);
  }
});

test("hook: every other cause of fetch-output-unknown keeps 0.4.6's refusal, with no remedy line", () => {
  for (const { command } of OTHER_CAUSES) {
    const verdict = hook(command);
    assert.equal(verdict.permission, "deny", `${command}: ${verdict.reason}`);
    assert.match(verdict.reason, /^hook-class-human-only: class policy\.core resolves to human-only/u, command);
    assert.ok(verdict.reason.endsWith(ZERO_FOUR_SIX_TAIL), `${command}: ${verdict.reason}`);
    assert.ok(!verdict.reason.includes("Remedy:"), command);
  }
});

test("hook: a $-first word beside an earlier -K reports the -K (first cause wins), so no remedy", () => {
  const verdict = hook('curl -K "$C" "$X/path"');
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.ok(verdict.reason.endsWith(ZERO_FOUR_SIX_TAIL), verdict.reason);
});

test("hook: the remedy's shape runs (the EdgeOS recipe with --url is allowed unasked)", () => {
  const verdict = hook(
    'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events"',
  );
  assert.equal(verdict.permission, "allow", verdict.reason);
});
