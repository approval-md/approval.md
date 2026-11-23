/**
 * A negated class on a credential path is a credential read, through the
 * real hook (review-b's FINDING on #682 at 8c91e702, equal on main and 0.4.8).
 *
 * The hook's glob reader took `[!x]` and `[^x]` as the literal members `!`,
 * `^` and `x`, so `cat ~/.hermes/[!x]uth.json` was `read.file.out_of_scope`
 * while bash and zsh expand it to `~/.hermes/auth.json`, which is
 * `account.credential` (human-only). The reader now negates `[!...]` as every
 * shell does, reads `[^...]` as any one character (dash takes `^` as a
 * member), and reads any form it does not model as matching any name (the
 * lead's ruling L60812: strict where it cannot decide).
 *
 * Every credential file here is synthetic, in a scratch directory, and HOME
 * points into that directory: nothing reads a real one. Spawn the compiled
 * CLI; never hand-write log lines.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook, joinContinuations } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-negation-")));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: autonomous",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  policy.core:",
  "    autonomy: human-only",
  "  vcs.history.rewrite:",
  "    autonomy: human-only",
  "  account.credential:",
  "    autonomy: human-only",
  "```",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, home: string, input = ""): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of ["APPROVAL_HUMAN", "HERMES_HOME", "APPROVAL_HERMES_HOME", "CDPATH"]) delete env[name];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A gate with a synthetic approval home and a synthetic Hermes home under HOME. */
const lab = ((): { dir: string; home: string } => {
  const dir = join(scratch, "proj");
  const home = join(scratch, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir, home);
  assert.equal(attested.code, 0, attested.stderr);
  mkdirSync(join(dir, ".approval"), { recursive: true });
  for (const name of ["env", "env.local"]) writeFileSync(join(dir, ".approval", name), "SYNTHETIC=1\n", "utf8");
  for (const name of ["auth.json", ".env", ".env.local", ".op.env"]) writeFileSync(join(home, ".hermes", name), "SYNTHETIC=1\n", "utf8");
  mkdirSync(join(home, ".hermes", "hermes-agent"), { recursive: true });
  mkdirSync(join(home, ".hermes", "profiles", "p1"), { recursive: true });
  writeFileSync(join(home, ".hermes", "hermes-agent", ".env"), "SYNTHETIC=1\n", "utf8");
  for (const name of ["auth.json", ".env"]) writeFileSync(join(home, ".hermes", "profiles", "p1", name), "SYNTHETIC=1\n", "utf8");
  mkdirSync(join(dir, ".approval", "keys"), { recursive: true });
  for (const name of ["vault.enc", "keys/k1"]) writeFileSync(join(dir, ".approval", name), "SYNTHETIC=1\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
  return { dir, home };
})();

/** The same gate under `defaults.unclassified_command: abstain`: a no-rule segment is a stand-in, not a refusal. */
const abstainLab = ((): { dir: string; home: string } => {
  const dir = join(scratch, "proj-abstain");
  mkdirSync(join(dir, ".approval"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY.replace('  on_expiry: reject\n', '  on_expiry: reject\n  unclassified_command: abstain\n'), "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir, lab.home);
  assert.equal(attested.code, 0, attested.stderr);
  writeFileSync(join(dir, ".approval", "env"), "SYNTHETIC=1\n", "utf8");
  return { dir, home: lab.home };
})();

/** The same gate under a policy that holds `log.mutate` human-only, beside `lab`, whose policy leaves it at the autonomous default. */
const logLab = ((): { dir: string; home: string } => {
  const dir = join(scratch, "proj-log");
  mkdirSync(join(dir, ".approval"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY.replace("classes:\n", "classes:\n  log.mutate:\n    autonomy: human-only\n"), "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir, lab.home);
  assert.equal(attested.code, 0, attested.stderr);
  writeFileSync(join(dir, ".approval", "env"), "SYNTHETIC=1\n", "utf8");
  return { dir, home: lab.home };
})();

/** The decision the Claude Code hook gives a Bash command, and its reason; `abstain` when it prints none. */
function claude(command: string, at: { dir: string; home: string } = lab): string {
  const run = runCli(
    ["hook", "claude-code", "--as", "agent:cc"],
    at.dir,
    at.home,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "glob-negation",
      tool_use_id: `cc-${String(Math.random()).slice(2)}`,
      cwd: at.dir,
      tool_name: "Bash",
      tool_input: { command },
      transcript_path: "/dev/null",
      permission_mode: "default",
    }),
  );
  assert.equal(run.code, 0, run.stderr);
  if (run.stdout.trim() === "") return "abstain";
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  const output = parsed.hookSpecificOutput ?? {};
  return `${output.permissionDecision ?? "?"}: ${output.permissionDecisionReason ?? ""}`;
}

/** The classes the hook's classification gives a command, in process (HOME pointed at the lab). */
function classes(command: string, abstain = false): string[] {
  const saved = process.env["HOME"];
  process.env["HOME"] = lab.home;
  try {
    const judged = classifyForHook(command, [], lab.dir, [], false, [lab.dir], abstain) as {
      result: { ok: boolean; classes?: string[]; code?: string };
    };
    return judged.result.ok ? (judged.result.classes ?? []) : [`refused:${judged.result.code ?? "?"}`];
  } finally {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
  }
}

test("FINDING: each credential path, spelled with [!x] or [^x], is denied through the real hook as the plain path is", () => {
  // At 8c91e702 (and on main and 0.4.8) every negated spelling here was
  // allowed as read.file.out_of_scope.
  for (const [plain, spellings] of [
    ["cat ~/.hermes/auth.json", ["cat ~/.hermes/[!x]uth.json", "cat ~/.hermes/[^x]uth.json", "cat ~/.hermes/[!b]uth.json"]],
    ["cat .approval/env", ["cat .approval/[!x]nv", "cat .approval/[^x]nv"]],
  ] as const) {
    const expected = claude(plain);
    assert.match(expected, /^deny: .*account\.credential/u, `${plain}: ${expected}`);
    for (const command of spellings) {
      const decision = claude(command);
      assert.match(decision, /^deny: .*account\.credential/u, `${command}: ${decision}`);
    }
  }
});

test("FINDING: more negated spellings of the credential paths are credential reads", () => {
  for (const command of [
    "cat ~/.hermes/[!b-z]uth.json",
    "cat ~/.hermes/[![:upper:]]uth.json",
    "cat ~/.hermes/[!]x]uth.json",
    "cat ~/.hermes/[!x][!x][!x][!x].json",
    "cat ~/.hermes/.[!x]nv",
    "cat ~/.hermes/.env[!x]local",
    "cat ~/.hermes/[^a]uth.json", // dash reads `^` and `a` as members
    "cat .approval/[!a-d]nv",
    "cat .approval/e[!x]v.local",
    "cat < .approval/[!x]nv",
  ]) {
    assert.ok(classes(command).includes("account.credential"), `${command}: ${JSON.stringify(classes(command))}`);
  }
});

test("ruling L60812: a form the reader does not model, on a credential path, is a credential read or refused", () => {
  for (const command of [
    "cat ~/.hermes/[![:foo:]]uth.json", // an unknown class (zsh matches every character)
    "cat ~/.hermes/[!A-c]uth.json", // across groups: bash 3.2 under en_US.UTF-8 opens auth.json
    "cat ~/.hermes/[!z-a]uth.json", // reversed
    "cat ~/.hermes/[![=a=]]uth.json",
    "cat ~/.hermes/[!a[]uth.json", // a bracket inside a class
    "cat ~/.hermes/[!xuth.json", // unclosed
    "cat ~/.hermes/[^]x]uth.json", // the shells close it in different places
    "cat ~/.hermes/[a[]uth.json",
    "cat ~/.hermes/aut[A-H].json", // bash 3.2 under en_US.UTF-8 reads h into [A-H]
    "cat ~/.hermes/.env[_-a]local", // and . into [_-a]
    "cat ~/.hermes/[a\\]uth.json", // a backslash inside a class
    "cat ~/.hermes/^x*", // zsh extended glob
    "cat ~/.hermes/*~x",
    "cat ~/.hermes/a#uth.js?",
    "cat ~/.hermes/@(a)uth.json", // bash extglob
    "cat ~/.hermes/!(x)uth.json",
    "cat .approval/[!a-]]nv",
    "cat .approval/e[?]v",
  ]) {
    const judged = classes(command);
    assert.ok(
      judged.includes("account.credential") || judged.some((each) => each.startsWith("refused:")),
      `${command}: ${JSON.stringify(judged)}`,
    );
  }
});

test("an escaped or quoted `!` is a member to the shell, and the lexer drops the escape: any one character", () => {
  // `[\\!a]` reaches the reader as `[!a]`; bash, zsh and dash all expand
  // `~/.hermes/[\\!a]uth.json` to auth.json. So `[!a]` is any one character.
  for (const command of ["cat ~/.hermes/[\\!a]uth.json", "cat ~/.hermes/[\"!\"a]uth.json", "cat ~/.hermes/[!a]uth.json", "cat .approval/[\\!e]nv"]) {
    assert.ok(classes(command).includes("account.credential"), `${command}: ${JSON.stringify(classes(command))}`);
  }
  // A pattern naming no credential stays ordinary.
  for (const command of ["cat README.m[!x]", "cat README.m[^x]", "cat ~/.hermes/[!a]uth.json.bak", "ls src/*.ts"]) {
    assert.equal(classes(command).includes("account.credential"), false, `${command}: ${JSON.stringify(classes(command))}`);
  }
});

/**
 * Rows of build-2's glob shell-truth sweep (CLAIMS L60842) that were LOOSER
 * at 8c91e702 and on main: a shell expands the word to a credential file and
 * the hook allowed `cat <word>`. Ten of each group where it has ten.
 */
const SWEEP_ROWS: Record<string, readonly string[]> = {
  // (1) negated classes (233 rows on 8c91e702).
  negated: [
    "~/.[!Z]ermes/auth.json",
    "~/.[!A-Z]ermes/.env",
    "~/.[!Z][!Z]rmes/.env.local",
    "~/.[!!]ermes/.op.env",
    "~/.hermes/*[!Z]ermes-agent/.env",
    "~/.hermes/[!Z][!Z]ofiles/p1/auth.json",
    "~/.hermes/[^A-Z]rofiles/p1/.env",
    ".approval/[^A-Z]nv",
    ".approval/*[!Z]nv.local",
    ".approval/[!Z]eys/k1",
  ],
  // (2) bash 3.2 under en_US.UTF-8 reads [A-Z] as holding lower case (19 rows).
  upperRange: [
    "~/.[A-Z]ermes/auth.json",
    "~/.[A-Z]ermes/.env",
    "~/.hermes/.[A-Z]nv",
    "~/.[A-Z]ermes/.env.local",
    "~/.hermes/.[A-Z]nv.local",
    "~/.[A-Z]ermes/.op.env",
    "~/.hermes/.[A-Z]p.env",
    "~/.[A-Z]ermes/hermes-agent/.env",
    "~/.hermes/[A-Z]ermes-agent/.env",
    "~/.hermes/hermes-agent/.[A-Z]nv",
  ],
  // (3) zsh numeric globs, which bash's parse (and the hook's) reads as a redirect (4 rows).
  zshNumeric: [
    "~/.hermes/profiles/p<->/auth.json",
    "~/.hermes/profiles/p<0-9>/auth.json",
    "~/.hermes/profiles/p<->/.env",
    "~/.hermes/profiles/p<0-9>/.env",
  ],
};

test("sweep L60842: the looser rows of the three option-free groups are credential reads", () => {
  for (const [group, words] of Object.entries(SWEEP_ROWS)) {
    for (const word of words) {
      const judged = classes(`cat ${word}`);
      assert.ok(judged.includes("account.credential"), `${group}: cat ${word}: ${JSON.stringify(judged)}`);
    }
  }
  // Through the real hook, one of each.
  for (const word of ["~/.[!Z]ermes/auth.json", "~/.[A-Z]ermes/auth.json", "~/.hermes/profiles/p<->/auth.json"]) {
    const decision = claude(`cat ${word}`);
    assert.match(decision, /^deny: .*account\.credential/u, `cat ${word}: ${decision}`);
  }
});

test("sweep L60842 group (4): after a shell option set in the same command, every glob matches any name", () => {
  // The classifier refuses `shopt` and `setopt` (unclassified) under the
  // default policy; under `defaults.unclassified_command: abstain` they are
  // stand-ins and the read beside them was read.shell at 8c91e702.
  for (const [setup, word] of [
    ["shopt -s nocaseglob", "~/.[A-Z]ermes/auth.json"],
    ["setopt extendedglob globdots", "~/.hermes/^zz"],
    ["setopt extendedglob", "~/.h##ermes/.env.local"],
    ["setopt extendedglob", "~/(#a1).Zermes/.op.env"],
    ["setopt extendedglob", "~/(#i).HERMES/hermes-agent/.env"],
    ["setopt extendedglob", "~/.h##ermes/profiles/p1/auth.json"],
    ["setopt extendedglob globdots", "~/.hermes/profiles/p1/^zz"],
    ["shopt -s nocaseglob", ".approval/[A-Z]nv"],
    ["setopt extendedglob", ".a^Z/env.local"],
    ["setopt extendedglob", ".approval/v##ault.enc"],
    ["setopt extendedglob", "(#i).APPROVAL/env"],
    ["set -o extendedglob", "~/.Z#hermes/auth.json"],
    ["bash -O extglob -c true", "~/.[A-Z]ermes/auth.json"],
  ] as const) {
    for (const command of [`${setup}\ncat ${word}`, `${setup}; cat ${word}`, `${setup} && cat ${word}`]) {
      const judged = classes(command, true);
      assert.ok(
        judged.includes("account.credential") || judged.some((each) => each.startsWith("refused:")),
        `${JSON.stringify(command)}: ${JSON.stringify(judged)}`,
      );
    }
  }
  // nocaseglob without the option line: a letter matches either case anyway.
  assert.ok(classes("cat ~/.?ERMES/auth.json").includes("account.credential"));
  // No option line, no change: an ordinary glob stays ordinary.
  assert.equal(classes("cat ~/.hermes/notes*", true).includes("account.credential"), false);
});

test("security review of d0288514: a group inside a word, which zsh globs with no option, is judged as zsh reads it", () => {
  // zsh -f opens auth.json and .approval/env for these; bash and dash refuse
  // them as syntax errors. Under the abstain policy the hook abstained on
  // both at 591f461b (a read.shell and a no-rule stand-in).
  for (const command of ["cat ~/.hermes/a(u)th.json", "cat .approval/e(n)v"]) {
    const decision = claude(command, abstainLab);
    assert.match(decision, /^deny: /u, `${command}: ${decision}`);
    assert.ok(classes(command, true).includes("account.credential"), `${command}: ${JSON.stringify(classes(command, true))}`);
  }
});

test("security review of d0288514: ordinary lines with parentheses keep their verdict", () => {
  // Each as at 591f461b, under the abstain policy.
  for (const [command, expected] of [
    ["f() { echo hi; }; f", /^deny: hook-unclassified/u],
    ["(cd x && ls)", /^allow: /u],
    ["echo (x)", /^abstain$/u],
  ] as const) {
    const decision = claude(command, abstainLab);
    assert.match(decision, expected, `${command}: ${decision}`);
  }
});

test("codex on 83f30bdc: quoted setters, nested groups and composed readings are judged as zsh reads them", () => {
  // zsh opens the credential for each (made-up files). Under the abstain
  // policy the hook abstained on the first five at 83f30bdc, and the class of
  // the last lacked account.credential.
  for (const command of [
    'set "-o" extendedglob; cat ~/.hermes/.Z#env',
    "s'et' -o extendedglob; cat ~/.hermes/.Z#env",
    "set -'o' extendedglob; cat ~/.hermes/.Z#env",
    "cat ~/.hermes/a((u))th.json",
    "cat ~/.hermes/a(((u)))th.json",
    "cat ~/.hermes/profiles/p<->/a(u)th.json",
    // review-b's M-B on 83f30bdc: more quoted setters, and nested groups.
    "'set' -o extendedglob; cat ~/.hermes/.Z#env",
    "set \\-o extendedglob; cat ~/.hermes/.Z#env",
    "se\\t -o extendedglob; cat ~/.hermes/au#th.json",
    'builtin set "-o" extendedglob; cat ~/.hermes/.Z#env',
    'set "-o" braceccl; cat ~/.hermes/{a-b}uth.json',
    "cat ~/.hermes/(a(u))th.json",
    "cat .approval/(e(n))v",
    "cat .approval/e((n))v",
  ]) {
    assert.ok(classes(command, true).includes("account.credential"), `${command}: ${JSON.stringify(classes(command, true))}`);
  }
  for (const command of ['set "-o" extendedglob; cat ~/.hermes/.Z#env', "cat ~/.hermes/a((u))th.json", "cat .approval/(e(n))v"]) {
    const decision = claude(command, abstainLab);
    assert.match(decision, /^deny: /u, `${command}: ${decision}`);
  }
  // A reversed range was the old fallback (any name): through the real hook,
  // as the plain read of the directory's credential is.
  for (const command of ["cat ~/.hermes/[!z-a]", "cat ~/.hermes/[^z-a]"]) {
    const decision = claude(command);
    assert.match(decision, /^deny: .*account\.credential/u, `${command}: ${decision}`);
  }
});

test("review-b's M-A on 83f30bdc: a write through an escaped, quoted or plain negated class into .git is the .git write it is", () => {
  // bash 3.2, zsh -f and dash all expand each of these to .git/config (or
  // .git): the lexer hands the .git reader `[!t]` for `[\\!t]`, which every
  // shell reads as the members `!` and `t`. At 83f30bdc each was allowed as
  // files.write.workspace, while `echo x > .git/config` was denied.
  const plain = claude("echo x > .git/config");
  assert.match(plain, /^deny: .*vcs\.history\.rewrite/u, plain);
  for (const command of [
    "echo x > .gi[\\!t]/config",
    'echo x > .gi["!"t]/config',
    "echo x > .gi[!t]/config",
    "echo x > .gi[^t]/config",
    "echo x > .g[\\!i]t/config",
    "touch .gi[\\!t]/hooks/pre-commit",
  ]) {
    const decision = claude(command);
    assert.match(decision, /^deny: .*vcs\.history\.rewrite/u, `${command}: ${decision}`);
  }
});

test("build-2's sweep v3 on 83f30bdc: a write through a glob that names the Hermes home or one of its organs is the organ write", () => {
  // bash 3.2 and zsh -f write ~/.hermes/auth.json for each (dash for the
  // copies). Claude Code states no per-call directory, so the hook's disk
  // pass does not run and the classifier's protected rows answer; at 83f30bdc
  // (and on main) each was allowed as files.write.workspace under both
  // policies, while `echo x > ~/.hermes/auth.json` was denied as policy.core.
  for (const at of [lab, abstainLab]) {
    const plain = claude("echo x > ~/.hermes/auth.json", at);
    assert.match(plain, /^deny: .*policy\.core/u, plain);
    for (const command of [
      "echo x > ~/.[\\!h]ermes/auth.json",
      'echo x > ~/.herme["!"s]/auth.json',
      "echo x > ~/.[!Z]ermes/auth.json",
      "echo x > ~/.h?rmes/auth.json",
      "echo x > ~/.hermes/a*h.json",
      "cp README.md ~/.herme[\\!s]/auth.json",
      "cp README.md ~/.[!Z]ermes/auth.json",
    ]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: .*policy\.core/u, `${command}: ${decision}`);
    }
  }
  // ksh reads `@(e)` with no option set, so each opens the credential; under
  // the abstain policy the hook abstained on each at 83f30bdc, the group
  // reading keeping the `@` (`.@*nv`).
  for (const command of ["ksh -c 'cat ~/.hermes/.@(e)nv'", "ksh -c 'cat ~/.hermes/.@(o)p.env'", "ksh -c 'cat ~/.hermes/.!(x)nv'"]) {
    const decision = claude(command, abstainLab);
    assert.match(decision, /^deny: /u, `${command}: ${decision}`);
    assert.ok(classes(command, true).includes("account.credential"), command);
  }
  // A glob that can name no organ stays the workspace write it was.
  for (const command of ["echo x > *.md", "echo x > build/*.json", "cp README.md docs/?.md"]) {
    assert.deepEqual(classes(command), ["files.write.workspace"], command);
  }
});

test("security review of 54624872: a glob last segment that names a top-level gate file is that file's write", () => {
  // bash 3.2 and zsh -f write APPROVAL.md (or CLAUDE.md, AGENTS.md, .npmrc)
  // for each where it is the one match. At 54624872, and on main 21fc5fdc,
  // each was allowed as files.write.workspace under both policies.
  for (const at of [lab, abstainLab]) {
    for (const command of ["echo x > APPROVA?.md", "echo x > APPROV[A]L.md", "echo x > APPROVAL.m?", "cp README.md APPROVA*.md", "echo x > *L.md"]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: .*policy\.core/u, `${command}: ${decision}`);
    }
  }
  for (const command of ["echo x > CL?UDE.md", "echo x > CLAUDE.m[d]", "echo x > [A]GENTS.md", "echo x > .npmr?"]) {
    assert.deepEqual(classes(command), ["policy.edit"], command);
  }
  // `*` alone and `*` with an extension keep main's answer exactly.
  for (const command of ["echo x > *.md", "echo x > *", "cp src/* out/", "echo x > docs/*.md"]) {
    assert.deepEqual(classes(command), ["files.write.workspace"], command);
  }
});

test("security review of 54624872: an ANSI-C or locale quoted setter, or one from a parameter, is refused under both policies", () => {
  // Not looser at 54624872 or on main 21fc5fdc: the classifier refuses each
  // such word outright, so this pins the refusal.
  for (const at of [lab, abstainLab]) {
    for (const command of [
      "$'\\x73etopt' extendedglob; cat ~/.hermes/au#th.json",
      "$'set' -o extendedglob; cat ~/.hermes/au#th.json",
      'set $"-o" extendedglob; cat ~/.hermes/au#th.json',
      "set -$'o' braceccl; cat ~/.hermes/{a-b}uth.json",
      "builtin $'setopt' extendedglob; cat ~/.hermes/au#th.json",
      "shopt $'-s' nocaseglob; cat ~/.hermes/AUTH.json",
      "$S extendedglob; cat ~/.hermes/au#th.json",
      "builtin ${S} -o extendedglob; cat ~/.hermes/au#th.json",
    ]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: /u, `${command}: ${decision}`);
    }
  }
});

test("review-b's M-C at bcb1be08: a line continuation before or inside a group is removed before any reader, as the shell removes it", () => {
  // zsh -f opens the credential for each. Under the abstain policy the hook
  // abstained on each at bcb1be08 (and on main 21fc5fdc): the group reader
  // took the newline of `\`+newline for a separator.
  for (const command of [
    "cat ~/.hermes/a\\\n(u)th.json",
    "cat ~/.hermes/a\\\n((u))th.json",
    "cat ~/.hermes/au\\\n(t)h.json",
    "cat .approval/e\\\n(n)v",
    "cat ~/.hermes/(a\\\nu)th.json",
    "cat ~/.hermes/a(\\\nu)th.json",
    "cat ~/.hermes/a(u\\\n)th.json",
  ]) {
    for (const at of [lab, abstainLab]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: /u, `${JSON.stringify(command)}: ${decision}`);
    }
  }
  // The shell's own rules: kept inside single and ANSI-C quotes and in a
  // comment, removed outside quotes and inside double quotes, and `\\` then a
  // newline is an escaped backslash and a newline.
  assert.equal(joinContinuations("a\\\nb \"c\\\nd\""), "ab \"cd\"");
  assert.equal(joinContinuations("a '\\\n' $'\\\n'"), "a '\\\n' $'\\\n'");
  assert.equal(joinContinuations("x # c \\\ny"), "x # c \\\ny");
  assert.equal(joinContinuations("x#\\\ny"), "x#y");
  assert.equal(joinContinuations("a\\\\\nb"), "a\\\\\nb");
  assert.equal(joinContinuations("plain line"), "plain line");
  // A comment's last `\` does not hide the next line from the readers.
  assert.match(claude("echo hi # x \\\ncat ~/.hermes/a(u)th.json", abstainLab), /^deny: /u);
});

test("review-b's N1 and codex's M1 at bcb1be08: each class a word's readings name is judged by the policy, the cap's too", () => {
  // `.approval/*` names the approval home (policy.core) and its log
  // (log.mutate); past a glob cap the word's own class and policy.core both
  // stand. `lab`'s policy leaves log.mutate at the autonomous default, where
  // picking log.mutate by precedence alone allowed `rm -rf .approval/*` at
  // bcb1be08 (main denied it as policy.core); `logLab` holds it human-only.
  for (const command of [
    "rm -rf .approval/*",
    "cp README.md .approval/*",
    // codex's HOLD at d24f98ab: a credential read beside the glob (the
    // deferral path) keeps every class the readings named.
    "rm -rf .approval/* < .approval/env",
    "cp .approval/* /tmp/x < .approval/env",
    "echo x > .approval/log/*/*",
    `echo x > .approval/log/${"b*/".repeat(65)}x`,
  ]) {
    for (const at of [lab, logLab]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: .*(policy\.core|log\.mutate)/u, `${command}: ${decision}`);
    }
    const judged = classes(command);
    assert.ok(judged.includes("policy.core") && judged.includes("log.mutate"), `${command}: ${judged.join(", ")}`);
  }
  // An explicit log path with no glob keeps its one class.
  assert.deepEqual(classes("echo x > .approval/log/x"), ["log.mutate"]);
});

test("review-b's N3 at bcb1be08: a group nested in an attached group is read through its parent", () => {
  // zsh -f opens auth.json for each; the parent is written whole, so the
  // nested group needs no attachment of its own (the clause f3 turned off is
  // gone).
  for (const command of ["cat ~/.hermes/a((u))th.json", "cat ~/.hermes/((a))uth.json", "cat ~/.hermes/a(((u)))th.json", "cat .approval/e((n))v"]) {
    assert.ok(classes(command, true).includes("account.credential"), command);
    assert.match(claude(command, abstainLab), /^deny: /u, command);
  }
});

test("security review of ec416318: a quoted heredoc keeps its backslash-newline, so a command after its real end is still read", () => {
  // In `<<'EOF'` the body is literal: `x\<newline>EOF` ends the heredoc at
  // the second line, and `rm -rf ~/x` runs. Removing the continuation would
  // join `xEOF` and read the rm as heredoc text. The text as written is read
  // too wherever a heredoc or a nested substitution is present.
  const own = classes("rm -rf ~/x");
  for (const command of [
    "cat <<'EOF'\nx\\\nEOF\nrm -rf ~/x\nEOF",
    'cat <<"EOF"\nx\\\nEOF\nrm -rf ~/x\nEOF',
    "cat <<\\EOF\nx\\\nEOF\nrm -rf ~/x\nEOF",
    "cat <<'EOF'\nx\\\nEOF\nrm -rf ~/x",
    'cat <<"EOF"\nx\\\nEOF\nrm -rf ~/x',
  ]) {
    // A refusal (the trailing `EOF` line has no rule) is a deny, stricter still.
    const judged = classes(command);
    if (judged.length === 1 && judged[0]?.startsWith("refused:") === true) continue;
    for (const cls of own) assert.ok(judged.includes(cls), `${JSON.stringify(command)}: ${judged.join(", ")} lacks ${cls}`);
  }
});

test("lead's ruling L61492: every word is read as zsh reads it under extendedglob and braceccl too, no setter needed", () => {
  // The user's own zshrc may set either option, so these open what they name
  // with no setter in the command. At ec416318 each read was allowed under
  // both policies (the 198 earlier-call rows of sweep v3) and each write
  // was a workspace write.
  const reads = [
    "cat ~/^zz/auth.json", // ^ (extendedglob; globdots for the dot name)
    "cat ~/.hermes/^zz",
    "cat ~/.h^Z/auth.json",
    "cat ~/.hermes/a^Z",
    "cat ~/.Z#hermes/auth.json", // X# zero or more
    "cat ~/.hermes/Z#auth.json",
    "cat ~/.h##ermes/auth.json", // X## one or more
    "cat ~/.hermes/a##uth.json",
    "cat ~/(#a1).Zermes/auth.json", // (#a1) approximation
    "cat ~/.hermes/(#a1)Zuth.json",
    "cat ~/.{hZ}ermes/auth.json", // braceccl
    "cat ~/.hermes/{a-z}uth.json",
    "cat ~/.hermes/auth.json~zz", // ~ exclusion
    "cat .approval/e#nv",
    "cat .{a}pproval/env",
  ];
  for (const command of reads) {
    for (const at of [lab, abstainLab]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: /u, `${command}: ${decision}`);
    }
    assert.ok(classes(command).includes("account.credential") || classes(command).includes("policy.core"), command);
  }
  // Guarded files written through each form: the gate's files, its home and
  // the git directory.
  for (const [command, cls] of [
    ["echo x > APPROVA{L}.md", "policy.core"],
    ["echo x > A##PPROVAL.md", "policy.core"],
    ["echo x > APPROV^Z", "policy.core"],
    ["echo x > APPROVAL.md~zz", "policy.core"],
    ["echo x > .a^Z/env", "policy.core"],
    ["echo x > .a##pproval/env", "policy.core"],
    ["echo x > .{a}pproval/env", "policy.core"],
    ["echo x > ~/.h^Z/auth.json", "policy.core"],
    ["echo x > .g##it/config", "vcs.history.rewrite"],
    ["echo x > .{g}it/config", "vcs.history.rewrite"],
    ["echo x > .g^Z/config", "vcs.history.rewrite"],
  ] as const) {
    assert.ok(classes(command).includes(cls), `${command}: ${classes(command).join(", ")}`);
    assert.match(claude(command), /^deny: /u, command);
  }
  // Ordinary words stay ordinary. `dist/^keep` is `dist/*` to zsh: no guarded
  // class. The rest answer as their plain spellings do (quoted text is not a
  // glob to zsh).
  const GUARDED = /^(policy\.|log\.mutate|vcs\.history\.rewrite|account\.credential)/u;
  for (const command of ["rm -rf dist/^keep", "echo x > dist/^keep", "ls dist/{a}"]) {
    assert.ok(!classes(command).some((cls) => GUARDED.test(cls)), `${command}: ${classes(command).join(", ")}`);
  }
  for (const [command, plain] of [
    ["cat notes#1.md", "cat notes1.md"],
    ["git log HEAD^", "git log HEAD"],
    ["git diff HEAD~1", "git diff HEAD"],
    ["grep -r '^import' src", "grep -r 'import' src"],
    ["sed -n '/^x/p' README.md", "sed -n '/x/p' README.md"],
    ["echo x > build/{a}.txt", "echo x > build/a.txt"],
    ["cp README.md backup~", "cp README.md backup"],
  ] as const) {
    assert.deepEqual(classes(command), classes(plain), `${command} vs ${plain}`);
  }
});
