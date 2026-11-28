/**
 * Readers that run a program the line names (finding readers-run-code).
 *
 * On main, five commands the classifier reads as plain reads take a word that
 * names a program they then run, so the program ran classed `read.shell` (or
 * `read.vcs.remote`) alone:
 *
 * - `sort --compress-program=<prog>`: sort runs it once it spills to temp
 *   files;
 * - `rg --pre <prog>` and `rg --hostname-bin <prog>`, and the flag file
 *   `RIPGREP_CONFIG_PATH` names, which may hold either;
 * - `git grep -O<prog>` / `--open-files-in-pager[=<prog>]`;
 * - GNU sed's `e` command and the `e` flag of `s`, and a script from `-f`,
 *   which this classifier cannot read;
 * - `git ls-remote` / `git fetch --upload-pack=<prog>` (`ls-remote -u`), which
 *   git runs as a shell command for a local repository;
 * - `openssl dgst -engine` / `-provider` / `-provider-path`, and
 *   `OPENSSL_CONF`, each of which loads a module into the digest.
 *
 * Each now takes the answer `find -exec` and `xargs` take: refused as
 * `opaque`, because what runs is not in the words the classifier reads. The
 * controls are the same tools without those words, whose answers must not
 * move, and the lines main already asked or refused, which must stay so.
 *
 * Every line goes through the pure classifier and through the built hook
 * (`hook claude-code`, spawned) under a policy whose default and `read.*` are
 * autonomous: there a refusal is the only thing that stops the program.
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

/** Every line here names a program the reader runs: refused as opaque. */
const RUNS: readonly string[] = [
  // sort --compress-program: any prefix GNU getopt_long takes, either spelling,
  // in a cluster's company, after an operand (GNU permutes), and after `-o --`,
  // where `--` is -o's value and not the end of the options.
  "sort --compress-program=./x README.md",
  "sort --compress-program ./x README.md",
  "sort -S1M --compress-program ./x README.md",
  "sort -S 1M --compress-program=./x README.md",
  "sort --compress-prog=./x README.md",
  "sort --co=./x README.md",
  'sort "--compress-program=./x" README.md',
  "sort '--compress-program' './x' README.md",
  "sort --compress-program='./x' README.md",
  "sort --compress\\-program=./x README.md",
  "sort README.md --compress-program=./x",
  "sort -o -- --compress-program=./x README.md",
  "/usr/bin/sort --compress-program=./x README.md",
  "sort --compress-program=./x README.md | head",
  "cat README.md && sort --compress-program=./x README.md",
  // rg --pre, --hostname-bin, and the flag file
  "rg --pre ./x pattern",
  "rg --pre=./x pattern",
  "rg -i --pre ./x pattern",
  "rg --pre-glob '*.pdf' --pre ./x pattern",
  "rg pattern --pre=./x",
  'rg "--pre=./x" pattern',
  "rg --hostname-bin ./x --hyperlink-format default pattern",
  "rg --hostname-bin=./x pattern",
  "RIPGREP_CONFIG_PATH=./rgrc rg pattern",
  // git grep -O, its long name and git's prefixes of it, in a cluster
  "git grep -O./x pattern",
  "git grep -O pattern",
  "git grep -iO./x pattern",
  "git grep -nO'./x' pattern",
  "git grep --open-files-in-pager=./x pattern",
  "git grep --open-files-in-pager pattern",
  "git grep --open-files=./x pattern",
  "git grep --open=./x pattern",
  "git --no-pager grep -O./x pattern",
  // git ls-remote / fetch --upload-pack (ls-remote's -u)
  "git ls-remote --upload-pack=./x origin",
  "git ls-remote --upload-pack ./x origin",
  "git ls-remote --upload=./x origin",
  "git ls-remote -u ./x origin",
  "git ls-remote -u./x origin",
  "git ls-remote -qu./x origin",
  "git fetch --upload-pack=./x origin",
  "git fetch --upload-pack ./x origin",
  "git fetch --upl=./x origin",
  // sed: the e command, after any address, and the e flag of s
  "sed '1e ./x' README.md",
  "sed 's/x/touch y/e' README.md",
  "sed -n '1e touch .claude/settings.json' README.md",
  "sed -e 'e ./x' README.md",
  "sed --expression='e ./x' README.md",
  "sed --expr='e ./x' README.md",
  "sed --e 'e ./x' README.md",
  "sed -ne 'e ./x' README.md",
  "sed -n -e p -e 'e ./x' README.md",
  "sed -l 5 'e ./x' README.md",
  "sed --line-length=5 'e ./x' README.md",
  "sed 's/a/b/ge' README.md",
  "sed 's/a/b/2e' README.md",
  "sed 's|a|b|e' README.md",
  "sed 's/a\\/b/c/e' README.md",
  "sed '/x/e' README.md",
  "sed '/x/ e' README.md",
  "sed '$!e ./x' README.md",
  "sed '1,/y/!e ./x' README.md",
  "sed 'p;e ./x' README.md",
  "sed '/x/{p;e ./x\n}' README.md",
  "sed 'y/abc/xyz/;e' README.md",
  "sed ':a;e ./x' README.md",
  "sed 'b end;e ./x' README.md",
  // a one-line text, a file name and a comment each end at the newline
  "sed 'a hello\ne ./x' README.md",
  "sed 'w out.txt\ne ./x' README.md",
  "sed '# a comment\ne ./x' README.md",
  "sed -i 'e ./x' README.md",
  // a script this classifier cannot read
  "sed -f script.sed README.md",
  "sed -nf script.sed README.md",
  "sed --file=script.sed README.md",
  "sed --fi=script.sed README.md",
  "sed --posix 's/x/y/' README.md",
  "POSIXLY_CORRECT=1 sed 's/x/y/' README.md",
  // In a double-byte locale (Big5) a byte of `あ` takes the backslash after
  // it, so GNU sed reads `s/あ\/x/e;#/` as `s/あ\/x/` with the e flag.
  "LC_ALL=zh_TW.BIG5 sed 's/あ\\/x/e;#/' README.md",
  // openssl's digest readers loading a module
  "openssl dgst -sha256 -engine ./x.so README.md",
  "openssl dgst --engine=./x.so README.md",
  "openssl sha256 -provider-path . -provider x README.md",
  "openssl dgst -provider ./x.so README.md",
  "OPENSSL_CONF=./c.cnf openssl dgst -sha256 README.md",
];

/**
 * The same tools without a program word, and lines main already refused or
 * asked: each answer is main's (7b3cf86c and #715's head), pinned whole.
 */
const CONTROLS: readonly (readonly [string, string])[] = [
  ["sort README.md", "read.shell read-shell"],
  ["sort -k2 README.md", "read.shell read-shell"],
  ["sort -T /tmp README.md", "read.shell read-shell"],
  ["sort -S 1M -o out.txt README.md", "read.shell read-shell"],
  ["sort --check README.md", "read.shell read-shell"],
  ["sort --batch-size=4 README.md", "read.shell read-shell"],
  ["rg pattern", "read.shell read-shell"],
  // --pre-glob without --pre runs nothing: it only says which files --pre takes.
  ["rg --pre-glob '*.pdf' pattern", "read.shell read-shell"],
  ["rg --no-pre pattern", "read.shell read-shell"],
  ["rg --hyperlink-format default pattern", "read.shell read-shell"],
  ["rg -z pattern", "read.shell read-shell"],
  ["git grep pattern", "read.shell git-read"],
  ["git grep -e FOO", "read.shell git-read"],
  ["git grep -eFOO", "read.shell git-read"],
  ["git grep -n -i pattern", "read.shell git-read"],
  ["git grep -C3 pattern", "read.shell git-read"],
  ["git grep -o pattern", "read.shell git-read"],
  ["git grep -e a --or -e b", "read.shell git-read"],
  ["git grep --no-open-files-in-pager pattern", "read.shell git-read"],
  ["git log -p", "read.shell git-read"],
  ["git diff --ext-diff", "read.shell git-read"],
  ["git show --textconv HEAD", "read.shell git-read"],
  ["git ls-remote origin", "read.vcs.remote git-remote-read"],
  ["git ls-remote --heads origin", "read.vcs.remote git-remote-read"],
  ["git ls-remote -q origin", "read.vcs.remote git-remote-read"],
  ["git fetch origin", "read.vcs.remote git-remote-read"],
  ["git fetch -u origin", "read.vcs.remote git-remote-read"],
  ["git fetch --unshallow origin", "read.vcs.remote git-remote-read"],
  ["git fetch --update-shallow origin", "read.vcs.remote git-remote-read"],
  ["git remote -v", "read.vcs.remote git-remote-read"],
  ["sed -n 1,5p README.md", "read.shell sed-read"],
  ["sed 's/a/b/' README.md", "read.shell sed-read"],
  // The letter e inside a regex, a replacement or an address is not the command.
  ["sed -e 's/e/x/' README.md", "read.shell sed-read"],
  ["sed --expression='s/e/x/' README.md", "read.shell sed-read"],
  ["sed -ne 's/e/x/p' README.md", "read.shell sed-read"],
  ["sed 's/hello/world/g' README.md", "read.shell sed-read"],
  ["sed 's/e$/E/' README.md", "read.shell sed-read"],
  ["sed -n '/start/,/end/p' README.md", "read.shell sed-read"],
  ["sed -n '/e/p' README.md", "read.shell sed-read"],
  ["sed '/e/d' README.md", "read.shell sed-read"],
  ["sed ':a;N;$!ba;s/\\n/ /g' README.md", "read.shell sed-read"],
  ["sed '1i\\header' README.md", "read.shell sed-read"],
  ["sed '/x/a appended text' README.md", "read.shell sed-read"],
  ["sed 'y/abc/xyz/' README.md", "read.shell sed-read"],
  ["sed 's#a#b#g' README.md", "read.shell sed-read"],
  ["sed '\\#x#d' README.md", "read.shell sed-read"],
  ["sed '1~2d' README.md", "read.shell sed-read"],
  ["sed '0,/re/d' README.md", "read.shell sed-read"],
  ["sed '/x/I,+2d' README.md", "read.shell sed-read"],
  ["sed -E 's/(a|b)+/x/' README.md", "read.shell sed-read"],
  ["sed '$d' README.md", "read.shell sed-read"],
  ["sed '/^#/d' README.md", "read.shell sed-read"],
  ["sed -n l README.md", "read.shell sed-read"],
  ["sed '/x/{p;d}' README.md", "read.shell sed-read"],
  ["sed \"s/'/\\\"/g\" README.md", "read.shell sed-read"],
  ["sed 's/x/y/w out.txt' README.md", "read.shell sed-read"],
  ["sed 'w out.txt' README.md", "read.shell sed-read"],
  ["sed -n -l 5 l README.md", "read.shell sed-read"],
  ["sed 's/é/e/' README.md", "read.shell sed-read"],
  ["LC_ALL=C sed 's/x/y/' README.md", "read.shell sed-read"],
  ["sed -i 's/a/b/' README.md", "files.write.workspace sed-in-place"],
  ["sed -i.bak 's/a/b/' README.md", "files.write.workspace sed-in-place"],
  ["sed 'w .claude/settings.json' README.md", "policy.core protected-path | read.shell sed-read"],
  ["sed --expression 'w .claude/settings.json' README.md", "policy.core protected-path | read.shell sed-read"],
  ["openssl dgst -sha256 README.md", "read.shell openssl-digest"],
  ["openssl sha256 -r README.md", "read.shell openssl-digest"],
  ["openssl dgst -sha256 -out out.txt README.md", "files.write.workspace openssl-digest-out"],
  ["tar --to-command=./x -xf a.tar", "files.write.workspace tar-extract"],
  ["tar --checkpoint-action=exec=./x -tf a.tar", "read.shell tar-list"],
  ["find . -exec ./x {} \\;", "refused opaque"],
  ["xargs ./x", "refused opaque"],
  ["less README.md", "refused unclassified"],
  ["man -P ./x ls", "refused unclassified"],
];

/**
 * A sed `w` into a protected file, spelled with an option main's script
 * reader skipped (a `--expression` prefix, `-l`'s value): main read each as a
 * plain read. The `-e` and operand spellings already carry the protected
 * class, and so do these now.
 */
const WRITES: readonly (readonly [string, string])[] = [
  ["sed --expr='w .claude/settings.json' README.md", "policy.core protected-path | read.shell sed-read"],
  ["sed -l 5 'w .claude/settings.json' README.md", "policy.core protected-path | read.shell sed-read"],
];

/** Every segment as `class rule`, joined; a refusal as `refused <code>`. */
function answer(command: string): string {
  const result = classifyCommand(command);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`).join(" | ") : `refused ${result.code}`;
}

for (const command of RUNS) {
  test(`runs a program, opaque: ${command}`, () => {
    assert.equal(answer(command), "refused opaque", command);
  });
}

for (const [command, expected] of CONTROLS) {
  test(`unmoved: ${command}`, () => {
    assert.equal(answer(command), expected, command);
  });
}

for (const [command, expected] of WRITES) {
  test(`sed w target read through the option: ${command}`, () => {
    assert.equal(answer(command), expected, command);
  });
}

// ---------------------------------------------------------------------------
// The built hook
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-readers-run-program-")));
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

/** A gate root whose default and `read.*` are autonomous: only a refusal stops a line. */
function gateRoot(): string {
  const dir = join(scratch, "gate");
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

/** The hook's answer for one Bash call: `allow`, or `deny <code>`. */
function hookVerdict(dir: string, command: string): string {
  calls += 1;
  const body = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "readers-run-program",
    tool_use_id: `rrp-${String(calls)}`,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  // A line the gate ASKS about waits this long for an answer nobody gives.
  const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir, "--timeout", "1s"], dir, body);
  assert.equal(run.code, 0, run.stderr);
  const nested = (JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
  const permission = String(nested["permissionDecision"]);
  if (permission !== "deny") return permission;
  const reason = String(nested["permissionDecisionReason"]);
  return `deny ${reason.slice(0, reason.indexOf(":"))}`;
}

/**
 * The hook's answer for each control under this policy, pinned whole: main's
 * answer through the same spawned hook. `tar` with a program reaches
 * `files.write.guarded` in the hook's disk pass, a class with a built-in
 * minimum above this policy's default, so it is asked and times out.
 */
const CONTROL_VERDICTS: Readonly<Record<string, string>> = {
  "sed 'w .claude/settings.json' README.md": "deny hook-class-human-only",
  "sed --expression 'w .claude/settings.json' README.md": "deny hook-class-human-only",
  "tar --to-command=./x -xf a.tar": "deny hook-timeout",
  "tar --checkpoint-action=exec=./x -tf a.tar": "deny hook-timeout",
  "find . -exec ./x {} \\;": "deny hook-opaque",
  "xargs ./x": "deny hook-opaque",
  "less README.md": "deny hook-unclassified",
  "man -P ./x ls": "deny hook-unclassified",
};

test("the built hook refuses every program-running reader as opaque, and answers each control as main did", () => {
  const dir = gateRoot();
  const wrong: string[] = [];
  for (const command of RUNS) {
    const verdict = hookVerdict(dir, command);
    if (verdict !== "deny hook-opaque") wrong.push(`${command}: ${verdict}`);
  }
  for (const [command] of CONTROLS) {
    const verdict = hookVerdict(dir, command);
    const expected = CONTROL_VERDICTS[command] ?? "allow";
    if (verdict !== expected) wrong.push(`${command}: ${verdict}, expected ${expected}`);
  }
  for (const [command] of WRITES) {
    const verdict = hookVerdict(dir, command);
    if (verdict !== "deny hook-class-human-only") wrong.push(`${command}: ${verdict}`);
  }
  assert.deepEqual(wrong, []);
});

// ---------------------------------------------------------------------------
// Cost: every new reading is one pass over the words
// ---------------------------------------------------------------------------

/**
 * The most CPU seconds one of these lines may take, before the runner's
 * factor. Each line is about 100,000 characters; main classifies the slowest
 * of them in about 0.15 s on a laptop, and the bound is ten times that.
 */
const COST_BOUND = 1.5;

const COST_LINES: readonly (readonly [string, string])[] = [
  ["sed, 20,000 commands", `sed '${"s/a/b/;".repeat(20_000)}' README.md`],
  ["sed, 20,000 one-line texts ending in an escaped backslash", `sed '${"a x\\\\\n".repeat(20_000)}' README.md`],
  ["sed, one regex of 50,000 escaped slashes", `sed 's/${"\\/".repeat(50_000)}/x/' README.md`],
  ["sed, 20,000 labels", `sed '${":a;".repeat(20_000)}' README.md`],
  ["sed, 20,000 -e scripts", `sed ${"-e p ".repeat(20_000)}README.md`],
  ["sed, 20,000 addresses", `sed '${"/a/I,+2!".repeat(10_000)}p' README.md`],
  ["sort, 25,000 options", `sort ${"-k1 ".repeat(25_000)}README.md`],
  ["rg, 30,000 options", `rg ${"-i ".repeat(30_000)}pattern`],
  ["git grep, one cluster of 100,000 letters", `git grep -${"i".repeat(100_000)} pattern`],
  ["git grep, 30,000 options", `git grep ${"-i ".repeat(30_000)}pattern`],
  ["git ls-remote, one cluster of 100,000 letters", `git ls-remote -${"q".repeat(100_000)} origin`],
  ["openssl dgst, 30,000 options", `openssl dgst -sha256 ${"-r ".repeat(30_000)}README.md`],
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
