/**
 * Environment assignments in front of ANY classified command (APRV-541, the
 * lead's ruling on APRV-540: writers get the same rule in 0.4.10, as one rule
 * made general).
 *
 * APRV-540 judged the `NAME=value` words in front of a READER by a closed
 * list. The hole is the same in front of every other command: the program
 * that runs is not the one classified. On the readers branch `PATH=. touch x`
 * and `PATH=. mkdir x` stayed `files.write.workspace` (autonomous under the
 * default policy `approval init` writes) and ran `./touch`; `PATH=. approval
 * status` stayed `gate.self`; `NODE_OPTIONS=--require=./x node --version`
 * stayed `files.write.workspace`; and the asked classes (`deps.add`,
 * `release.publish`, `network.call`, `vcs.pr.open`, `harness.launch.*`) were
 * asked about a line whose program the class did not describe.
 *
 * Now one helper ({@link assignmentRefusal} in command-class.ts) judges the
 * assignments in front of every classified command, whatever its class, with
 * the same three-way table (admitted / steering / unknown) and the same deny
 * (`unclassified`). Git keeps its own admitted list and text through the same
 * helper. A bare `cd` keeps its own rules.
 *
 * Every family is tested through the pure classifier, and the common lines
 * through the built hook under the default policy `approval init` writes
 * (src/cli/scaffold.ts CANONICAL_POLICY, its class rows; no channel).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as commandClass from "../src/core/command-class.js";
import { classifyCommand } from "../src/core/command-class.js";
import { CANONICAL_POLICY } from "../src/cli/scaffold.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/**
 * Lines that were classified on the readers branch (the class beside each)
 * and are `unclassified` now, by class family.
 */
const REFUSED: readonly (readonly [string, string])[] = [
  // files.write.workspace: a fixed program, swapped or loaded into
  ["PATH=. touch x", "files.write.workspace"],
  ["PATH=. mkdir x", "files.write.workspace"],
  ["FOO=1 touch x", "files.write.workspace"],
  ["LD_PRELOAD=./x.so cp a b", "files.write.workspace"],
  ["PATH=. sed -i s/a/b/ f", "files.write.workspace"],
  ["FOO=1 rm x", "files.write.workspace"],
  // files.write.workspace: commands that already run project code
  ["NODE_OPTIONS=--require=./x node --version", "files.write.workspace"],
  ["NODE_ENV=test npm test", "files.write.workspace"],
  ["DEBUG=x node script.js", "files.write.workspace"],
  ["FOO=bar make", "files.write.workspace"],
  ["PORT=3000 npm start", "files.write.workspace"],
  ["TMPDIR=/private/tmp bun test", "files.write.workspace"],
  // gate.self
  ["PATH=. approval status", "gate.self"],
  ["APPROVAL_HUMAN=human:carter approval status", "gate.self"],
  // vcs.*
  ["GH_TOKEN=x gh pr create --title t --body b", "vcs.pr.open"],
  ["PATH=. gh pr create --title t --body b", "vcs.pr.open"],
  // network.call
  ["PATH=. curl -X POST https://example.com", "network.call"],
  // deps.*
  ["PATH=. npm install left-pad", "deps.add"],
  ["NODE_OPTIONS=--require=./x npm ci", "deps.install"],
  // release.publish
  ["PATH=. npm publish", "release.publish"],
  // a protected class
  ["PATH=. rm -rf ../x", "policy.core"],
  ["PATH=. cat f > APPROVAL.md", "policy.core"],
  ["n=5 cat f > APPROVAL.md", "policy.core"],
  ["PATH=. cat .approval/env", "account.credential"],
  // harness.launch.*
  ["PATH=. claude -p hi", "harness.launch.claude"],
  ["CLAUDE_CONFIG_DIR=/tmp/x claude -p hi", "harness.launch.claude"],
  // a steering name set bare earlier on the line
  ["GH_PAGER=./x; npm test", "files.write.workspace"],
  ["IFS=x; touch y", "files.write.workspace"],
  ["NODE_OPTIONS=--require=./x && npm test", "files.write.workspace"],
];

/** Lines that keep the answer they had on the readers branch, pinned whole. */
const KEPT: readonly (readonly [string, string])[] = [
  ["touch x", "files.write.workspace workspace-write"],
  ["npm test", "files.write.workspace npm-script"],
  ["CI=1 npm test", "files.write.workspace npm-script"],
  ["CI=true npm ci", "deps.install npm-ci"],
  ["NO_COLOR=1 npm test", "files.write.workspace npm-script"],
  ["FORCE_COLOR=0 npm test", "files.write.workspace npm-script"],
  ["LC_ALL=C make", "files.write.workspace workspace-tool"],
  ["TZ=UTC touch x", "files.write.workspace workspace-write"],
  ["GIT_PAGER=cat git log", "read.shell git-read"],
  ["GIT_TERMINAL_PROMPT=0 git push origin lane", "vcs.history.rewrite git-push-unreadable"],
  ["FOO=bar; npm test", "read.shell assignment | files.write.workspace npm-script"],
  ["CDPATH=/ cd ./build", "read.shell read-shell"],
  ["approval status", "gate.self approval"],
  // already refused, and not by this rule
  ["PATH=.; npm test", "refused unclassified"],
  ["PYTHONPATH=. pytest", "refused unclassified"],
  ["RAILS_ENV=test bundle exec rspec", "refused unclassified"],
  ["AWS_PROFILE=x aws s3 ls", "refused unclassified"],
  ["DATABASE_URL=postgres://u@h/db psql -c 'select 1'", "refused unclassified"],
  ["export NODE_ENV=test; npm test", "refused unclassified"],
  ["env NODE_ENV=test npm test", "refused opaque"],
];

/** Every segment as `class rule`, joined; a refusal as `refused <code>`. */
function answer(command: string): string {
  const result = classifyCommand(command);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`).join(" | ") : `refused ${result.code}`;
}

for (const [command, was] of REFUSED) {
  test(`an assignment in front of a ${was} command is unclassified: ${command}`, () => {
    assert.equal(answer(command), "refused unclassified", command);
  });
}

for (const [command, expected] of KEPT) {
  test(`unmoved: ${command}`, () => {
    assert.equal(answer(command), expected, command);
  });
}

test("one helper, one text: a writer's refusal reads as a reader's; git's own text is unchanged", () => {
  const detail = (command: string): string => {
    const result = classifyCommand(command);
    assert.equal(result.ok, false, command);
    return result.ok ? "" : result.detail;
  };
  assert.equal(
    detail("PATH=. touch x"),
    "no rule for PATH=… in front of touch: an environment assignment in front of a command can change which program runs or what it loads, and PATH picks which touch runs. Run touch without the assignment; if it needs PATH, a person sets PATH in the environment the session starts from.",
  );
  assert.equal(
    detail("NODE_ENV=test npm test"),
    "no rule for NODE_ENV=… in front of npm: an environment assignment in front of a command can change which program runs or what it loads, and NODE_ENV hands npm options or code. Run npm without the assignment; if it needs NODE_ENV, a person sets NODE_ENV in the environment the session starts from.",
  );
  assert.equal(
    detail("GH_PAGER=./x; npm test"),
    "no rule for npm after GH_PAGER is set on the same command line: an exported variable reaches npm and the programs it starts, and GH_PAGER names a program npm may start. Run the line without setting GH_PAGER; if npm needs it, a person sets GH_PAGER in the environment the session starts from.",
  );
  assert.equal(
    detail("PATH=. git push origin lane"),
    "no rule for PATH=… in front of git: an environment assignment can run a program, repoint the repository or its configuration, or write a file",
  );
});

/**
 * The scope predicate's alternative list is the default policy's own: every
 * class `approval init`'s policy runs without a person (autonomous or
 * supervised-retro), so the lead's one-line switch means what it says.
 */
test("the narrower scope's class list is the default policy's unasked rows", () => {
  const list = (commandClass as Record<string, unknown>)["ASSIGNMENT_RULE_UNASKED_CLASSES"] as readonly string[] | undefined;
  assert.ok(Array.isArray(list), "ASSIGNMENT_RULE_UNASKED_CLASSES is exported");
  const rows = [...CANONICAL_POLICY.matchAll(/^ {2}([a-z.*_]+):\s+\{ autonomy: (autonomous|supervised-retro) \}/gmu)].map((match) => match[1] as string);
  assert.deepEqual([...(list ?? [])].filter((cls) => cls !== "gate.self").sort(), rows.sort());
  assert.ok(list?.includes("gate.self"), "gate.self: the hook drops it and allows");
});

// ---------------------------------------------------------------------------
// The built hook, under the default policy's class rows
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-env-before-any-command-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env: childEnv, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `approval init`'s class rows (src/cli/scaffold.ts), with no channel, so an asked line times out. */
function gateRoot(): string {
  const dir = join(scratch, "default");
  mkdirSync(dir, { recursive: true });
  const policy = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "classes:",
    "  read.*:                       { autonomy: autonomous }",
    "  files.write.workspace:        { autonomy: autonomous }",
    "  files.write.out_of_scope:     { autonomy: supervised-retro }",
    "  calendar.write.own:           { autonomy: supervised-retro }",
    "  communicate.email.draft:      { autonomy: autonomous }",
    "  public.post:                  { autonomy: manual }",
    "  data.delete:                  { autonomy: manual }",
    "  account.auth:                 { autonomy: manual }",
    "```",
    "",
  ].join("\n");
  writeFileSync(join(dir, "APPROVAL.md"), policy, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

let calls = 0;

/** The hook's answer for one Bash call: `allow`, `abstain`, or `deny <code>`. */
function hookVerdict(dir: string, command: string): string {
  calls += 1;
  const body = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "env-before-any-command",
    tool_use_id: `ebac-${String(calls)}`,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir, "--timeout", "1s"], dir, body);
  assert.equal(run.code, 0, run.stderr);
  if (run.stdout === "") return "abstain";
  const nested = (JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
  const permission = String(nested["permissionDecision"]);
  if (permission !== "deny") return permission;
  const reason = String(nested["permissionDecisionReason"]);
  return `deny ${reason.slice(0, reason.indexOf(":"))}`;
}

/** Each line's verdict under the default policy's rows, after this change. */
const HOOK: readonly (readonly [string, string])[] = [
  ["PATH=. touch x", "deny hook-unclassified"],
  ["NODE_OPTIONS=--require=./x node --version", "deny hook-unclassified"],
  ["NODE_ENV=test npm test", "deny hook-unclassified"],
  ["PATH=. approval status", "deny hook-unclassified"],
  ["PATH=. npm install left-pad", "deny hook-unclassified"],
  ["GH_PAGER=./x; npm test", "deny hook-unclassified"],
  ["touch x", "allow"],
  ["npm test", "allow"],
  ["CI=1 npm test", "allow"],
  ["NO_COLOR=1 npm test", "allow"],
];

test("the built hook, under the default policy's rows: the writers and the asked classes are denied, the admitted ones allowed", () => {
  const dir = gateRoot();
  const wrong: string[] = [];
  for (const [command, expected] of HOOK) {
    const verdict = hookVerdict(dir, command);
    if (verdict !== expected) wrong.push(`${command}: ${verdict}, expected ${expected}`);
  }
  assert.deepEqual(wrong, []);
});

// ---------------------------------------------------------------------------
// Cost: one pass over the assignments, whatever the class
// ---------------------------------------------------------------------------

const COST_BOUND = 1.5;

const COST_LINES: readonly (readonly [string, string])[] = [
  ["20,000 admitted assignments in front of touch", `${"LC_ALL=C ".repeat(20_000)}touch x`],
  ["20,000 unknown assignments in front of npm test", `${"A=1 ".repeat(20_000)}npm test`],
  ["20,000 admitted assignments, then PATH, in front of npm publish", `${"NO_COLOR=1 ".repeat(20_000)}PATH=. npm publish`],
  ["5,000 bare assignments, then a writer", `${"f=x; ".repeat(5_000)}touch y`],
  ["2,000 writers after one steering assignment", `IFS=x; ${"touch y; ".repeat(2_000)}true`],
];

for (const [label, command] of COST_LINES) {
  test(`cost: ${label}`, () => {
    const bound = scaledBound(COST_BOUND);
    let result = "";
    const seconds = cpuSeconds(() => {
      result = answer(command);
    });
    assert.ok(seconds < bound, `${label}: ${seconds.toFixed(3)} CPU s, bound ${bound.toFixed(2)} (${runner().line})`);
    assert.notEqual(result, "", label);
  });
}
