/**
 * An unknown assignment in front of a command that runs the workspace's own
 * code keeps the command's class (APRV-541, the lead's ruling on option (a)).
 *
 * "In front of a command whose rule already lets it run the workspace's own
 * code, an UNKNOWN name keeps the command's class; the named steering list is
 * refused everywhere; in front of a reader or a plain writer an unknown name
 * stays refused." `NODE_ENV=test npm test` gains nothing an attacker lacks
 * without it, so a deny there only teaches people to turn the hook off;
 * `cat` and `touch` run no project code, so there an unknown name may be a
 * steering name nobody listed.
 *
 * The rules are a closed list by name ({@link WORKSPACE_CODE_RULES} in
 * command-class.ts): `npm-script` (npm, pnpm, yarn, bun run / run-script /
 * test / start / build / lint / exec), `node-script` (node <file>), and
 * `workspace-tool` for npx, tsx, ts-node, vitest, jest and make only.
 * `TMPDIR` is kept in front of them (it names where temporary files go, and
 * these commands already write anywhere in the workspace); everywhere else it
 * stays a steering name.
 *
 * Hermetic: nothing here runs a command.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/** Every segment as `class rule`, joined; a refusal as `refused <code>`. */
function answer(command: string): string {
  const result = classifyCommand(command);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`).join(" | ") : `refused ${result.code}`;
}

/**
 * Every exact steering name (READER_STEERING_NAMES and git's inherited names
 * that are not shapes), less TMPDIR, which is kept in front of these rules.
 */
const STEERING_EXACT: readonly string[] = [
  "PATH", "IFS", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "ZDOTDIR", "CDPATH", "SHELL", "HOME",
  "CURL_HOME", "WGETRC", "RIPGREP_CONFIG_PATH", "VISUAL", "MANOPT", "GREP_OPTIONS", "GZIP", "BZIP2", "XZ_OPT",
  "XZ_DEFAULTS", "TAR_OPTIONS", "ZIPOPT", "UNZIP", "UNZIPOPT", "POSIXLY_CORRECT", "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "LANG", "LANGUAGE", "TZ", "TZDIR", "LOCPATH", "GCONV_PATH",
  "NLSPATH", "TERMINFO", "TERMINFO_DIRS", "TERMCAP",
  // git's inherited names (isGitInheritedName) that the shapes do not cover
  "PAGER", "EDITOR", "LV", "SSH_ASKPASS", "BASH_ENV", "GNUPGHOME",
];

/** One name per steering prefix and suffix (READER_STEERING_SHAPE). */
const STEERING_SHAPED: readonly string[] = [
  "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_LOADABLES_PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GIT_DIR",
  "OPENSSL_CONF", "LESSOPEN", "LC_ALL", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "NODE_OPTIONS", "npm_config_script_shell",
  "NPM_CONFIG_USERCONFIG", "BUN_OPTIONS", "DENO_DIR",
  // suffixes
  "MANPAGER", "SVN_EDITOR", "BROWSER", "SUDO_ASKPASS",
];

for (const name of [...STEERING_EXACT, ...STEERING_SHAPED]) {
  test(`a steering name is refused in front of npm test: ${name}`, () => {
    assert.equal(answer(`${name}=./x npm test`), "refused unclassified", name);
  });
}

/** Unknown names (and TMPDIR) in front of a workspace-code command keep its answer. */
const KEPT_NAMES: readonly string[] = ["NODE_ENV=test", "PORT=3000", "DEBUG=x", "TMPDIR=/private/tmp", "FOO=1"];
const WORKSPACE_CODE: readonly string[] = [
  "npm test",
  "npm start",
  "npm run build",
  "pnpm test",
  "yarn test",
  "bun test",
  "node script.js",
  "make",
  "npx vitest",
  "tsx x.ts",
  "ts-node x.ts",
  "vitest run",
  "jest",
  "npm test > out.txt",
];

for (const command of WORKSPACE_CODE) {
  test(`unknown names keep the answer of a workspace-code command: ${command}`, () => {
    const bare = answer(command);
    assert.notEqual(bare.startsWith("refused"), true, `${command} is classified bare`);
    for (const name of KEPT_NAMES) assert.equal(answer(`${name} ${command}`), bare, `${name} ${command}`);
    assert.equal(answer(`NODE_ENV=test DEBUG=x ${command}`), bare, `two unknown names, ${command}`);
    // An admitted word beside an unknown one, and a steering one beside it.
    assert.equal(answer(`NO_COLOR=1 FOO=1 ${command}`), bare, `admitted and unknown, ${command}`);
    assert.equal(answer(`FOO=1 PATH=. ${command}`), "refused unclassified", `unknown then steering, ${command}`);
  });
}

/** The same unknown names stay refused in front of a reader, a plain writer, and the rules left off. */
const NOT_WORKSPACE_CODE: readonly string[] = [
  "cat f",
  "touch x",
  "curl https://example.com",
  "gh pr view 1",
  // workspace-tool binaries that run no workspace code, or only a config file
  // when one exists: left off the list
  "tsc",
  "oxlint src",
  "backlog task list",
  "eslint .",
  "prettier --check .",
  // other rules that run code, left off
  "npm pack",
  "npm init vite",
  "npm publish",
  "npm install left-pad",
  // the approval CLI by node
  "node cli.js status",
];

for (const command of NOT_WORKSPACE_CODE) {
  test(`unknown names stay refused in front of: ${command}`, () => {
    for (const name of KEPT_NAMES) assert.equal(answer(`${name} ${command}`), "refused unclassified", `${name} ${command}`);
  });
}

/** Lines pinned whole: the forms around the exemption. */
const PINNED: readonly (readonly [string, string])[] = [
  // A sandbox wrapper is decided by the word right after the assignments
  // (approval), which is not a workspace-code rule.
  ["PATH=. approval sandbox -- npm test", "refused unclassified"],
  ["FOO=1 approval sandbox -- npm test", "refused unclassified"],
  ["approval sandbox -- npm test", "files.write.workspace npm-script"],
  // A protected answer is not the rule's own: refused, stricter than main's
  // policy.core.
  ["FOO=1 npm test > APPROVAL.md", "refused unclassified"],
  // The credential pass is unchanged: a credential read in the value stays
  // refused (opaque) before any assignment is judged.
  ["X=$(cat .approval/env) npm test", "refused opaque"],
  ["TOKEN=$(cat ~/.hermes/.env) npm run x", "refused opaque"],
  ["X=$(cat README.md) npm test", "files.write.workspace npm-script"],
  ["TOKEN=$GH_TOKEN npm run x", "files.write.workspace npm-script"],
  // The same-line steering scan still applies, and a bare TMPDIR is refused by
  // the bare-assignment rule, as on main.
  ["NODE_OPTIONS=--require=./x; npm test", "refused unclassified"],
  ["GH_PAGER=./x && npm test", "refused unclassified"],
  ["export NODE_OPTIONS=x; npm test", "refused unclassified"],
  ["TMPDIR=/x; npm test", "refused unclassified"],
  // Commands with no rule stay refused whatever is in front.
  ["PYTHONPATH=. pytest", "refused unclassified"],
  ["RAILS_ENV=test bundle exec rspec", "refused unclassified"],
  // TMPDIR stays steering in front of everything else.
  ["TMPDIR=/x sort README.md", "refused unclassified"],
  ["TMPDIR=/x touch y", "refused unclassified"],
];

for (const [command, expected] of PINNED) {
  test(`pinned: ${command}`, () => {
    assert.equal(answer(command), expected, command);
  });
}

test("the refusal names the program that follows the assignments, not the command behind a wrapper", () => {
  const result = classifyCommand("FOO=1 approval sandbox -- npm test");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.detail, /^no rule for FOO=… in front of approval: /u);
  const steering = classifyCommand("NODE_OPTIONS=--require=./x npm test");
  assert.equal(steering.ok, false);
  if (!steering.ok) {
    assert.equal(
      steering.detail,
      "no rule for NODE_OPTIONS=… in front of npm: an environment assignment in front of a command can change which program runs or what it loads, and NODE_OPTIONS hands npm options or code. Run npm without the assignment; if it needs NODE_OPTIONS, a person sets NODE_OPTIONS in the environment the session starts from.",
    );
  }
});

// ---------------------------------------------------------------------------
// The built hook, under approval init's class rows
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-env-workspace-code-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

function runCli(args: string[], cwd: string, input = ""): { code: number; stdout: string; stderr: string } {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env: childEnv, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("the built hook under approval init's class rows: unknown names allowed before npm test, steering denied, a plain writer denied", () => {
  const dir = join(scratch, "default");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    [
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
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  const expected: readonly (readonly [string, string])[] = [
    ["NODE_ENV=test npm test", "allow"],
    ["PORT=3000 npm start", "allow"],
    ["TMPDIR=/private/tmp bun test", "allow"],
    ["DEBUG=x node script.js", "allow"],
    ["FOO=bar make", "allow"],
    ["NODE_OPTIONS=--require=./x npm test", "deny hook-unclassified"],
    ["PATH=. npm test", "deny hook-unclassified"],
    ["FOO=1 touch x", "deny hook-unclassified"],
    ["FOO=1 cat README.md", "deny hook-unclassified"],
  ];
  const wrong: string[] = [];
  let calls = 0;
  for (const [command, want] of expected) {
    calls += 1;
    const body = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "env-workspace-code",
      tool_use_id: `ewc-${String(calls)}`,
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command },
    });
    const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir, "--timeout", "1s"], dir, body);
    assert.equal(run.code, 0, run.stderr);
    const nested = (JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
    const permission = String(nested["permissionDecision"]);
    const reason = String(nested["permissionDecisionReason"]);
    const got = permission === "deny" ? `deny ${reason.slice(0, reason.indexOf(":"))}` : permission;
    if (got !== want) wrong.push(`${command}: ${got}, expected ${want}`);
  }
  assert.deepEqual(wrong, []);
});

// ---------------------------------------------------------------------------
// Cost: the exemption reads each word once
// ---------------------------------------------------------------------------

const COST_LINES: readonly (readonly [string, string])[] = [
  ["20,000 unknown assignments in front of npm test", `${"A=1 ".repeat(20_000)}npm test`],
  ["20,000 unknown assignments, then NODE_OPTIONS, in front of npm test", `${"A=1 ".repeat(20_000)}NODE_OPTIONS=x npm test`],
];

for (const [label, command] of COST_LINES) {
  test(`cost: ${label}`, () => {
    const bound = scaledBound(1.5);
    let result = "";
    const seconds = cpuSeconds(() => {
      result = answer(command);
    });
    assert.ok(seconds < bound, `${label}: ${seconds.toFixed(3)} CPU s, bound ${bound.toFixed(2)} (${runner().line})`);
    assert.notEqual(result, "", label);
  });
}
