/**
 * zsh's clobber redirections (`>!`, `>>!`, `>&!`) are refused.
 *
 * In zsh each of these is ONE operator and the word after it is the file:
 * `echo x >! APPROVAL.md` writes the policy file. bash reads the same text as
 * a redirection onto a file named `!`, with the next word an argument. The
 * lexer read bash's, so under zsh (the shell Claude Code's Bash tool runs on
 * macOS) the line that overwrites a protected file was an ordinary workspace
 * write. Neither reading holds for both shells, so the form is refused
 * `unparseable`, and the refusal names what to write instead.
 *
 * Unmoved: `>|`, the clobber operator both shells share, and a file really
 * named `!` when it is quoted, escaped or set apart, which both shells read
 * alike.
 *
 * The last test runs each form in a real zsh and a real bash, so the premise
 * is checked where both are installed. It is skipped, with the reason
 * printed, where zsh is not.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

function classesOf(command: string): string[] | string {
  const result = classifyCommand(command);
  return result.ok ? result.classes : `refused:${result.code}`;
}

/** Every operator zsh reads as "clobber, the next word is the file". */
const ZSH_ONLY = [">!", ">>!", ">&!", "2>!", "1>>!", "2>&!", "&>!", "&>>!"] as const;

for (const op of ZSH_ONLY) {
  test(`zsh clobber: ${op} is refused, spaced or joined to its target`, () => {
    for (const tail of [" APPROVAL.md", "APPROVAL.md", " out.txt", "out.txt", " ~/.zshrc", ""]) {
      const command = `echo x ${op}${tail}`;
      const result = classifyCommand(command);
      assert.equal(result.ok, false, command);
      if (result.ok) continue;
      assert.equal(result.code, "unparseable", command);
      assert.match(result.detail, /zsh writes the word after it and bash a file named "!"/u, command);
      assert.match(result.detail, />\|/u, `${command}: the detail names the form to write instead`);
    }
  });
}

test("zsh clobber: refused wherever the line carries it", () => {
  for (const command of [
    "ls; echo x >! APPROVAL.md",
    "ls && cat a >! b",
    "git status | tee >! APPROVAL.md",
    "echo a>!b",
    "echo x 2>&1 >! f",
    "echo x >! APPROVAL.md # a comment",
    'echo "$(echo x >! APPROVAL.md)"',
    "printf '%s' $(date >>! log)",
    "bash -c 'echo x >! APPROVAL.md'",
    "zsh -c 'echo x >! APPROVAL.md'",
    "sh -c 'echo x >>! .approval/policy.yml'",
  ]) {
    assert.equal(classesOf(command), "refused:unparseable", command);
  }
});

test("zsh clobber: >| is the operator both shells share, and it is unmoved", () => {
  assert.deepEqual(classesOf("echo x >| APPROVAL.md"), ["policy.core"]);
  assert.deepEqual(classesOf("echo x >|APPROVAL.md"), ["policy.core"]);
  assert.deepEqual(classesOf("echo x 2>| APPROVAL.md"), ["policy.core"]);
  assert.deepEqual(classesOf("echo x >| out.txt"), ["files.write.workspace"]);
  // After `>|` a `!` is the file's first character in both shells.
  assert.deepEqual(classesOf("echo x >|!f"), ["files.write.workspace"]);
  assert.deepEqual(classesOf("echo x >| !"), ["files.write.workspace"]);
});

test("zsh clobber: a file really named ! is read as before when quoted, escaped or set apart", () => {
  for (const command of [
    "echo x > !",
    "echo x > ! APPROVAL.md",
    "echo x >'!' APPROVAL.md",
    'echo x >"!" APPROVAL.md',
    "echo x >\\! APPROVAL.md",
    "echo x >$'!' APPROVAL.md",
    "echo x >> ! APPROVAL.md",
    "echo x >& ! APPROVAL.md",
  ]) {
    assert.deepEqual(classesOf(command), ["files.write.workspace"], command);
  }
});

test("zsh clobber: the characters as data are not a redirection", () => {
  for (const command of ["echo 'x >! y'", 'echo "x >! y"', "echo x \\>! y", "echo x # >! f", "cat <<'EOF'\nx >! y\nEOF"]) {
    assert.deepEqual(classesOf(command), ["read.shell"], command);
  }
});

test("zsh clobber: the plain redirections are unmoved", () => {
  assert.deepEqual(classesOf("echo x > APPROVAL.md"), ["policy.core"]);
  assert.deepEqual(classesOf("echo x >> APPROVAL.md"), ["policy.core"]);
  assert.deepEqual(classesOf("echo x >& APPROVAL.md"), ["policy.core"]);
  assert.deepEqual(classesOf("echo x > out.txt"), ["files.write.workspace"]);
  assert.deepEqual(classesOf("ls 2>&1"), ["read.shell"]);
  assert.deepEqual(classesOf("ls >&2"), ["read.shell"]);
});

// -- the hook -----------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-zsh-clobber-")));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env: childEnv, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A policy under which a workspace write runs on its own: the reading the hole gave these lines. */
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
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

function verdict(dir: string, command: string, id: string): { permission: string; reason: string } {
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "cc-sess-zsh-clobber",
    tool_use_id: id,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> };
  const out = parsed.hookSpecificOutput ?? {};
  return { permission: String(out["permissionDecision"]), reason: String(out["permissionDecisionReason"]) };
}

test("zsh clobber: the hook denies the line where a workspace write runs on its own", () => {
  const dir = join(scratch, "hook");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const log = join(dir, ".approval", "log", "events.jsonl");
  const attested = runCli(["policy", "attest", "--dir", dir, "--log", log, "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  // The control: an ordinary workspace write is allowed under this policy.
  assert.equal(verdict(dir, "echo x > notes.txt", "t-control").permission, "allow");

  let n = 0;
  for (const command of ["echo x >! APPROVAL.md", "echo x >>! APPROVAL.md", "echo x >&! APPROVAL.md", "echo x >!APPROVAL.md", "echo x &>! APPROVAL.md"]) {
    n += 1;
    const v = verdict(dir, command, `t-${String(n)}`);
    assert.equal(v.permission, "deny", command);
    assert.match(v.reason, /^hook-unparseable: redirection /u, command);
  }
});

// -- the premise, in the real shells ----------------------------------------------

/** The files a shell leaves behind after running `command` in a fresh directory. */
function writes(shell: string, flags: readonly string[], command: string, label: string): string[] {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  spawnSync(shell, [...flags, command], { cwd: dir, encoding: "utf8", timeout: 10_000 });
  return readdirSync(dir).sort();
}

const ZSH_FLAGS = ["-f", "-c"] as const;
const BASH_FLAGS = ["--noprofile", "--norc", "-c"] as const;
const hasZsh = spawnSync("zsh", [...ZSH_FLAGS, "exit 0"], { timeout: 10_000 }).status === 0;
const hasBash = spawnSync("bash", [...BASH_FLAGS, "exit 0"], { timeout: 10_000 }).status === 0;

test(
  "zsh clobber: zsh writes the word after the operator, bash a file named !",
  { skip: hasZsh && hasBash ? false : "zsh or bash is not installed here, so the premise is not run" },
  () => {
    let n = 0;
    // Each refused form: the two shells write DIFFERENT files.
    for (const [command, bashFile] of [
      ["echo z >! f", "!"],
      ["echo z >>! f", "!"],
      ["echo z >&! f", "!"],
      ["echo z 2>! f", "!"],
      ["echo z 1>>! f", "!"],
      ["echo z &>! f", "!"],
      ["echo z >!f", "!f"],
      ["echo z >>!f", "!f"],
    ] as const) {
      n += 1;
      assert.equal(classesOf(command), "refused:unparseable", command);
      assert.deepEqual(writes("zsh", ZSH_FLAGS, command, `zsh-${String(n)}`), ["f"], `zsh: ${command}`);
      assert.deepEqual(writes("bash", BASH_FLAGS, command, `bash-${String(n)}`), [bashFile], `bash: ${command}`);
    }
    // Each form left alone: the two shells write the SAME file.
    for (const [command, file] of [
      ["echo z >'!' f", "!"],
      ["echo z > ! f", "!"],
      ["echo z >\\! f", "!"],
      ["echo z >| f", "f"],
      ["echo z >|!f", "!f"],
    ] as const) {
      n += 1;
      assert.deepEqual(classesOf(command), ["files.write.workspace"], command);
      assert.deepEqual(writes("zsh", ZSH_FLAGS, command, `zsh-${String(n)}`), [file], `zsh: ${command}`);
      assert.deepEqual(writes("bash", BASH_FLAGS, command, `bash-${String(n)}`), [file], `bash: ${command}`);
    }
  },
);
