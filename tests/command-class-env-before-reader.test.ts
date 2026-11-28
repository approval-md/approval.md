/**
 * Environment assignments in front of a reader (APRV-540, finding
 * env-before-reader).
 *
 * On 0.4.9 the classifier read past every `NAME=value` word in front of a
 * command and classified the command by its verb alone, except in front of
 * `git` (APRV-521). So an assignment that changes which program runs, or what
 * it loads, rode a plain read unasked:
 *
 * - `PATH=. cat README.md` runs `./cat`; `LD_PRELOAD`, `LD_LIBRARY_PATH`,
 *   `LD_AUDIT` and every `DYLD_*` load a library the line names into the
 *   reader;
 * - `GH_PAGER=./x gh pr diff 1` and `BROWSER=./x gh pr view --web` run `./x`;
 * - `IFS`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `PS4` steer a shell the reader
 *   starts, `HOME` and `XDG_CONFIG_HOME` repoint the configuration that names
 *   a pager or a browser, and `TAR_OPTIONS`, `PERL5OPT`, `NODE_OPTIONS` hand
 *   a tool options or code (`NODE_OPTIONS=--require=./x npm --version`).
 *
 * The lead's ruling: classify by the assignment, not only the verb, over a
 * closed list. In front of a command whose class is a read, an assignment is
 * admitted only from a named list of words that cannot change which program
 * runs or what it loads; any other assignment, named as steering or unknown,
 * leaves the segment `unclassified`, the answer git's rule gives. A bare
 * assignment of a steering name earlier on the line (`IFS=x; cat f`,
 * `GH_PAGER=./x && gh pr diff 1`, `printf -v GH_PAGER`) reaches the reader
 * when the name is exported, and refuses it the same way.
 *
 * Every line goes through the pure classifier and through the built hook
 * (`hook claude-code`, spawned) under a policy whose default and `read.*` are
 * autonomous, and again with `defaults.unclassified_command: abstain`: the
 * refusal is a deny under both, never an allow and never an abstain.
 * Hermetic: a scratch gate root, no line is run.
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

/**
 * A steering name in front of a reader: each was a plain read on 0.4.9 and is
 * `unclassified` now. One line per name, with a reader it plausibly steers.
 */
const STEERING: readonly string[] = [
  // which program runs, and what it loads
  "PATH=. cat README.md",
  "PATH=/usr/bin:/bin cat README.md",
  "PATH=. ls",
  "PATH=. grep foo README.md",
  "PATH=. jq . package.json",
  "PATH=. head -5 README.md",
  "PATH=. echo hi",
  "PATH=. curl https://example.com",
  "PATH=. gh api repos/a/b",
  "LD_PRELOAD=./x.so cat README.md",
  "LD_LIBRARY_PATH=. cat README.md",
  "LD_AUDIT=./x.so cat README.md",
  "DYLD_INSERT_LIBRARIES=./x.dylib cat README.md",
  "DYLD_LIBRARY_PATH=. cat README.md",
  "DYLD_FRAMEWORK_PATH=. cat README.md",
  "DYLD_FALLBACK_LIBRARY_PATH=. cat README.md",
  // a shell the reader starts
  "IFS=x cat README.md",
  "BASH_ENV=./x cat README.md",
  "ENV=./x cat README.md",
  "CDPATH=. cat README.md",
  "SHELLOPTS=xtrace cat README.md",
  "BASHOPTS=extdebug cat README.md",
  "PS4='$(./x)' cat README.md",
  "PROMPT_COMMAND=./x cat README.md",
  "ZDOTDIR=. cat README.md",
  "SHELL=./x cat README.md",
  // configuration that names a program
  "HOME=. gh pr view 1",
  "XDG_CONFIG_HOME=. gh pr view 1",
  "GH_CONFIG_DIR=. gh pr view 1",
  "CURL_HOME=. curl https://example.com",
  "WGETRC=./w wget -q -O- https://example.com",
  "TMPDIR=. sort README.md",
  // pagers, editors, browsers, askpass helpers
  "PAGER=./x gh pr diff 1",
  "PAGER=less gh pr diff 1",
  "GH_PAGER=./x gh pr diff 1",
  "GH_PAGER=less gh pr diff 1",
  "BROWSER=./x gh pr view --web",
  "GH_BROWSER=./x gh pr view --web",
  "GH_EDITOR=./x gh pr view 1",
  "EDITOR=./x gh pr view 1",
  "VISUAL=./x gh pr view 1",
  "MANPAGER=./x cat README.md",
  "MANOPT=-P./x cat README.md",
  "SUDO_ASKPASS=./x cat README.md",
  "SSH_ASKPASS=./x gh pr view 1",
  "LESS=+!./x gh pr diff 1",
  "LESSOPEN='|./x %s' gh pr diff 1",
  "LESSCLOSE='./x %s %s' gh pr diff 1",
  // git's variables in front of a program that is not git (gh runs git)
  "GIT_PAGER=./x gh pr view 1",
  "GIT_EDITOR=./x gh pr view 1",
  "GIT_SSH_COMMAND=./x gh repo view",
  "GIT_CONFIG_GLOBAL=./c gh repo view",
  "GIT_EXEC_PATH=. gh repo view",
  // options and code handed to a tool or an interpreter
  "GREP_OPTIONS=--color=always grep foo README.md",
  "GZIP=-v gunzip -c a.gz",
  "TAR_OPTIONS=--to-command=./x tar -tf a.tar",
  "POSIXLY_CORRECT=1 sort README.md",
  "PERL5OPT=-Mx shasum README.md",
  "PERL5LIB=. shasum README.md",
  "PERLLIB=. shasum README.md",
  "NODE_OPTIONS=--require=./x npm --version",
  "NODE_PATH=. npm --version",
  "npm_config_node_options=--require=./x npm --version",
  "PYTHONSTARTUP=./x cat README.md",
  "PYTHONPATH=. cat README.md",
  "RUBYOPT=-rx cat README.md",
  "RUBYLIB=. cat README.md",
  "JAVA_TOOL_OPTIONS=-javaagent:x.jar cat README.md",
  "BUN_OPTIONS=--preload=./x cat README.md",
  // the C library's own files
  "LANGUAGE=x cat README.md",
  "LOCPATH=. cat README.md",
  "GCONV_PATH=. cat README.md",
  "NLSPATH=./x cat README.md",
  "TERMINFO=. cat README.md",
  // a harmless name with a value it does not admit
  "LC_ALL=/tmp/x cat README.md",
  "LANG=../x cat README.md",
  "TZ=/tmp/x ls",
  "TERM=../x cat README.md",
  "COLUMNS=abc gh pr list",
  "GH_REPO=evil.example/o/r gh pr view 1",
  "NO_COLOR=$HOME cat README.md",
];

/**
 * A name on neither list in front of a reader: the default is the same
 * refusal (the hook has no ask for a segment it cannot classify).
 */
const UNKNOWN: readonly string[] = [
  "FOO=1 cat README.md",
  "NODE_ENV=test cat README.md",
  "DEBUG=1 cat README.md",
  "GH_HOST=evil.example gh api user",
  "GH_TOKEN=x gh pr view 1",
  "HTTPS_PROXY=http://h:1 curl https://example.com",
  "http_proxy=http://h:1 curl http://example.com",
  "NO_PROXY=* curl https://example.com",
  "SSL_CERT_FILE=./c.pem curl https://example.com",
  "FOO=$(cat README.md) cat README.md",
];

/** Several assignments, and the other forms a segment takes: any one decides. */
const FORMS: readonly string[] = [
  "A=1 B=2 cat README.md",
  "LC_ALL=C PATH=. cat README.md",
  "PATH=. LC_ALL=C cat README.md",
  "NO_COLOR=1 FOO=1 cat README.md",
  "GH_PAGER=cat GH_BROWSER=./x gh pr view --web",
  "PATH=. cat README.md | head",
  "cat README.md | PATH=. head",
  "(PATH=. cat README.md)",
  "echo $(PATH=. cat README.md)",
  "cat README.md && PATH=. cat README.md",
  "PATH=. cat README.md > out.txt",
  "PATH=. cat README.md 2>/dev/null",
  "PATH=. sort -o out.txt README.md",
  "PATH=. cat .git/HEAD",
  "GH_PAGER=./x approval sandbox -- gh pr diff 1",
  // A steering name set earlier on the line by a bare assignment (the value
  // reaches the reader when the name is exported, and PAGER usually is).
  "IFS=x; cat README.md",
  "IFS=x && cat README.md",
  "GH_PAGER=./x; gh pr diff 1",
  "GH_PAGER=./x && gh pr diff 1",
  "PAGER=./x; gh pr diff 1",
  "cat README.md; GH_PAGER=./x; gh pr diff 1",
  "printf -v GH_PAGER %s ./x; gh pr diff 1",
  "TAR_OPTIONS=--to-command=./x; tar -tf a.tar",
  "PS4='$(./x)'; git log",
  "BROWSER=./x; gh pr view --web",
  "echo $(GH_PAGER=./x; gh pr diff 1)",
];

/** Every line here was a read on 0.4.9 and is `unclassified` now. */
const REFUSED: readonly string[] = [...STEERING, ...UNKNOWN, ...FORMS];

/**
 * Lines that keep their answer, pinned whole: the admitted assignments, the
 * same readers with no assignment, and the forms 0.4.9 already refused.
 */
const KEPT: readonly (readonly [string, string])[] = [
  // the admitted list
  ["LC_ALL=C cat README.md", "read.shell read-shell"],
  ["LC_ALL=C sort README.md", "read.shell read-shell"],
  ["LANG=C grep foo README.md", "read.shell read-shell"],
  ["LANG=en_US.UTF-8 cat README.md", "read.shell read-shell"],
  ["LC_CTYPE=C.UTF-8 cat README.md", "read.shell read-shell"],
  ["TZ=UTC date", "read.shell date-read"],
  ["TZ=America/Los_Angeles ls -l", "read.shell read-shell"],
  ["NO_COLOR=1 gh pr view 1", "read.vcs.remote gh-read"],
  ["NO_COLOR= cat README.md", "read.shell read-shell"],
  ["CLICOLOR=0 ls", "read.shell read-shell"],
  ["CLICOLOR_FORCE=1 ls", "read.shell read-shell"],
  ["FORCE_COLOR=0 cat README.md", "read.shell read-shell"],
  ["CI=true cat README.md", "read.shell read-shell"],
  ["TERM=dumb cat README.md", "read.shell read-shell"],
  ["TERM=xterm-256color cat README.md", "read.shell read-shell"],
  ["COLUMNS=200 gh pr list", "read.vcs.remote gh-read"],
  ["LINES=50 cat README.md", "read.shell read-shell"],
  ["GH_PAGER=cat gh pr diff 1", "read.vcs.remote gh-read"],
  ["GH_PAGER= gh pr diff 1", "read.vcs.remote gh-read"],
  ["PAGER=cat gh pr diff 1", "read.vcs.remote gh-read"],
  ["GH_REPO=approval-md/approval.md gh pr view 1", "read.vcs.remote gh-read"],
  ["GH_PROMPT_DISABLED=1 gh pr view 1", "read.vcs.remote gh-read"],
  ["GH_NO_UPDATE_NOTIFIER=1 gh pr view 1", "read.vcs.remote gh-read"],
  ["GH_SPINNER_DISABLED=1 gh pr checks 1", "read.vcs.remote gh-read"],
  ["GIT_TERMINAL_PROMPT=0 gh pr view 1", "read.vcs.remote gh-read"],
  ["EDITOR=true gh pr view 1", "read.vcs.remote gh-read"],
  ["GIT_PAGER=cat git log", "read.shell git-read"],
  ["NO_COLOR=1 LC_ALL=C cat README.md", "read.shell read-shell"],
  ["GH_PAGER=cat NO_COLOR=1 gh pr diff 1", "read.vcs.remote gh-read"],
  ["GH_PAGER=cat; gh pr diff 1", "read.shell assignment | read.vcs.remote gh-read"],
  // An unknown name set bare reaches the reader only if it is already
  // exported; the line scan reads the named steering list, as git's does.
  ["FOO=bar; cat README.md", "read.shell assignment | read.shell read-shell"],
  ["f=README.md; cat \"$f\"", "read.shell assignment | read.shell read-shell"],
  // An assignment alone runs nothing.
  ["IFS=x", "read.shell assignment"],
  ["GH_PAGER=./x", "read.shell assignment"],
  ["X=y", "read.shell assignment"],
  // the same readers with nothing in front
  ["cat README.md", "read.shell read-shell"],
  ["gh pr diff 1", "read.vcs.remote gh-read"],
  ["gh pr view 1 --web", "read.vcs.remote gh-read"],
  ["tar -tf a.tar", "read.shell tar-list"],
  ["curl -s https://example.com", "read.web web-read"],
  ["shasum README.md", "read.shell read-shell"],
  ["npm --version", "read.shell npm-version"],
  ["cat README.md > out.txt", "files.write.workspace redirect-write"],
  // what 0.4.9 already refused, or classed as something other than a read
  ["PAGER=./x git log", "refused unclassified"],
  ["FOO=1 git log", "refused unclassified"],
  ["BASH_ENV=./x bash -c true", "refused opaque"],
  ["RIPGREP_CONFIG_PATH=./rgrc rg pattern", "refused opaque"],
  ["OPENSSL_CONF=./c.cnf openssl dgst -sha256 README.md", "refused opaque"],
  ["env X=y cat README.md", "refused opaque"],
  ["env -i cat README.md", "refused opaque"],
  ["env PATH=. cat README.md", "refused opaque"],
  ["time PATH=. cat README.md", "refused opaque"],
  ["PATH=. exec cat README.md", "refused opaque"],
  ["PATH=. command cat README.md", "refused unclassified"],
  ["export PATH=.; cat README.md", "refused unclassified"],
  ["export X=y; cat README.md", "refused unclassified"],
  ["declare -x GH_PAGER=./x; gh pr diff 1", "refused unclassified"],
  ["PATH=.; cat README.md", "refused unclassified"],
  ["LD_PRELOAD=./x.so; cat README.md", "refused unclassified"],
  ["PATH=. cat .approval/env", "account.credential credential-path"],
  ["PATH=. touch x", "files.write.workspace workspace-write"],
  // `cd` is left to its own rules: an intrinsic that runs nothing, whose
  // CDPATH and HOME the landing rules already model.
  ["CDPATH=/ cd ./build", "read.shell read-shell"],
  ["HOME=/tmp cd", "read.shell read-shell"],
  ["PATH=. cd foo", "read.shell read-shell"],
  ["IFS=x; cd foo", "read.shell assignment | read.shell read-shell"],
];

/** Every segment as `class rule`, joined; a refusal as `refused <code>`. */
function answer(command: string): string {
  const result = classifyCommand(command);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`).join(" | ") : `refused ${result.code}`;
}

for (const command of REFUSED) {
  test(`an assignment in front of a reader is unclassified: ${command}`, () => {
    assert.equal(answer(command), "refused unclassified", command);
  });
}

for (const [command, expected] of KEPT) {
  test(`unmoved: ${command}`, () => {
    assert.equal(answer(command), expected, command);
  });
}

test("the refusal names the assignment and the reader, in git's wording", () => {
  const steering = classifyCommand("GH_PAGER=./x gh pr diff 1");
  assert.equal(steering.ok, false);
  if (!steering.ok) {
    assert.equal(
      steering.detail,
      "no rule for GH_PAGER=… in front of gh: an environment assignment can run a program, change what it loads, or repoint its configuration",
    );
  }
  const unknown = classifyCommand("FOO=1 cat README.md");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(
      unknown.detail,
      "no rule for FOO=… in front of cat: an environment assignment this classifier does not know may change which program runs or what it loads",
    );
  }
  const line = classifyCommand("IFS=x; cat README.md");
  assert.equal(line.ok, false);
  if (!line.ok) {
    assert.equal(
      line.detail,
      "no rule for cat after IFS is set on the same command line: a reader and the programs it starts inherit the shell's exported environment",
    );
  }
});

// ---------------------------------------------------------------------------
// The built hook
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-env-before-reader-")));
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

/**
 * A gate root whose default and `read.*` are autonomous: only a refusal stops
 * a line. With `abstain`, a no-rule segment would get no verdict, so a line
 * that abstained here would reach Claude Code's own permission prompt.
 */
function gateRoot(name: string, abstain: boolean): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const policy = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: autonomous",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    ...(abstain ? ["  unclassified_command: abstain"] : []),
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  files.write.workspace:",
    "    autonomy: autonomous",
    "  policy.core:",
    "    autonomy: human-only",
    "  log.mutate:",
    "    autonomy: human-only",
    "  account.credential:",
    "    autonomy: human-only",
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
    session_id: "env-before-reader",
    tool_use_id: `ebr-${String(calls)}`,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  // A line the gate ASKS about waits this long for an answer nobody gives.
  const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir, "--timeout", "1s"], dir, body);
  assert.equal(run.code, 0, run.stderr);
  if (run.stdout === "") return "abstain";
  const nested = (JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
  const permission = String(nested["permissionDecision"]);
  if (permission !== "deny") return permission;
  const reason = String(nested["permissionDecisionReason"]);
  return `deny ${reason.slice(0, reason.indexOf(":"))}`;
}

/**
 * One line of each kind through the hook, both policies. The admitted ones are
 * allowed (the read is autonomous), the refused ones denied, and none abstains.
 */
const HOOK_REFUSED: readonly string[] = [
  "PATH=. cat README.md",
  "LD_PRELOAD=./x.so cat README.md",
  "DYLD_INSERT_LIBRARIES=./x.dylib cat README.md",
  "IFS=x cat README.md",
  "GH_PAGER=./x gh pr diff 1",
  "BROWSER=./x gh pr view --web",
  "TAR_OPTIONS=--to-command=./x tar -tf a.tar",
  "NODE_OPTIONS=--require=./x npm --version",
  "HOME=. gh pr view 1",
  "FOO=1 cat README.md",
  "HTTPS_PROXY=http://h:1 curl https://example.com",
  "A=1 B=2 cat README.md",
  "IFS=x; cat README.md",
  "GH_PAGER=./x && gh pr diff 1",
  "PATH=. cat README.md > out.txt",
];

const HOOK_ALLOWED: readonly string[] = [
  "cat README.md",
  "LC_ALL=C cat README.md",
  "TZ=UTC date",
  "NO_COLOR=1 gh pr view 1",
  "GH_PAGER=cat gh pr diff 1",
  "PAGER=cat gh pr diff 1",
  "COLUMNS=200 gh pr list",
  "GH_REPO=approval-md/approval.md gh pr view 1",
  "GIT_PAGER=cat git log",
  "FOO=bar; cat README.md",
];

for (const abstain of [false, true]) {
  test(`the built hook denies every steering or unknown assignment in front of a reader and allows the admitted ones (abstain: ${String(abstain)})`, () => {
    const dir = gateRoot(abstain ? "abstain" : "deny", abstain);
    const wrong: string[] = [];
    for (const command of HOOK_REFUSED) {
      const verdict = hookVerdict(dir, command);
      if (verdict !== "deny hook-unclassified") wrong.push(`${command}: ${verdict}`);
    }
    for (const command of HOOK_ALLOWED) {
      const verdict = hookVerdict(dir, command);
      if (verdict !== "allow") wrong.push(`${command}: ${verdict}, expected allow`);
    }
    assert.deepEqual(wrong, []);
  });
}

// ---------------------------------------------------------------------------
// Cost: the assignments are read once, and the line scan is one pass
// ---------------------------------------------------------------------------

/**
 * The most CPU seconds one of these lines may take, before the runner's
 * factor: the bound the readers-run-program lines hold. Each line is about
 * 100,000 to 300,000 characters.
 */
const COST_BOUND = 1.5;

const COST_LINES: readonly (readonly [string, string])[] = [
  ["20,000 admitted assignments in front of cat", `${"LC_ALL=C ".repeat(20_000)}cat README.md`],
  ["20,000 admitted assignments, then one steering one", `${"NO_COLOR=1 ".repeat(20_000)}PATH=. cat README.md`],
  ["20,000 unknown assignments in front of cat", `${"A=1 ".repeat(20_000)}cat README.md`],
  ["20,000 admitted assignments in front of gh", `${"GH_PAGER=cat ".repeat(20_000)}gh pr diff 1`],
  ["one assignment of a 100,000-character value", `NO_COLOR=${"1".repeat(100_000)} cat README.md`],
  ["5,000 bare assignments, then a reader", `${"f=x; ".repeat(5_000)}cat README.md`],
  ["5,000 bare steering assignments, then a reader", `${"GH_PAGER=cat; ".repeat(5_000)}gh pr diff 1`],
  ["2,000 readers after one steering assignment", `IFS=x; ${"cat README.md; ".repeat(2_000)}true`],
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
