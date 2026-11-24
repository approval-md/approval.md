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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook, joinContinuations, zshOptionCommandReading } from "../src/cli/hook.js";
import {
  classifiedSegmentShapes,
  classifyCommandInThisReading,
  commandSegmentShapes,
  globSegmentMatches,
} from "../src/core/command-class.js";
import { apartFromCallerReading, eachNameReading, foldNameExact, withNamesAsSpelled } from "../src/core/name-fold.js";

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

/**
 * A gate whose policy holds ONLY `cls` human-only (defaults autonomous), with
 * `routes` as its protected_paths, and every guarded file the M2 lines write
 * present (the hook matches a pattern's first globbed component against the
 * listing): build-1's M2 at 64c43399, lead ruling L62483.
 */
function classLab(name: string, cls: string, routes: readonly string[] = []): { dir: string; home: string } {
  const dir = join(scratch, `proj-${name}`);
  mkdirSync(join(dir, ".approval"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  const policy = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: autonomous",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    ...(routes.length === 0 ? [] : ["protected_paths:", ...routes.map((route) => `  - ${route}`)]),
    "classes:",
    `  ${cls}:`,
    "    autonomy: human-only",
    "```",
    "",
  ].join("\n");
  writeFileSync(join(dir, "APPROVAL.md"), policy, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir, lab.home);
  assert.equal(attested.code, 0, attested.stderr);
  for (const file of ["CLAUDE.md", "AGENTS.md", ".npmrc", "SPEC.md", ".github/workflows/ci.yml", "README.md"]) writeFileSync(join(dir, file), "made-up\n", "utf8");
  return { dir, home: lab.home };
}

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
  // A glob that can name no organ stays the workspace write it was. `*.md`
  // can (APPROVAL.md, AGENTS.md: #686's reader, GLOB-WRITE), and keeps main's
  // workspace write beside them (lead ruling L61926).
  for (const command of ["echo x > build/*.json", "cp README.md docs/?.md"]) {
    assert.deepEqual(classes(command), ["files.write.workspace"], command);
  }
  assert.deepEqual(classes("echo x > *.md"), ["policy.core", "policy.edit", "files.write.workspace"]);
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
  // Each also keeps main's workspace write: the glob names a new file when
  // nothing matches it (review-b's M1 at 3774fdd4).
  for (const command of ["echo x > CL?UDE.md", "echo x > CLAUDE.m[d]", "echo x > [A]GENTS.md", "echo x > .npmr?"]) {
    assert.deepEqual(classes(command), ["policy.edit", "files.write.workspace"], command);
  }
  // `*` alone and `*` with an extension: #682 kept main's answer exactly for
  // these; #686's reader (one reader, lead's ruling L62400) reads them too,
  // and main's workspace write stays beside each (lead ruling L61926).
  for (const command of ["echo x > *.md", "echo x > *", "cp src/* out/", "echo x > docs/*.md"]) {
    const judged = classes(command);
    assert.ok(judged.includes("files.write.workspace") && judged.includes("policy.core"), `${command}: ${judged.join(", ")}`);
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
    // deferral path) keeps every class the readings named. With #686's
    // reader the deferral path did not read the pattern at all, and `rm -rf
    // .approval/* < .approval/env` lost `log.mutate` (#682's case, added to
    // #686's reader in classifySegment's deferral branch).
    "rm -rf .approval/* < .approval/env",
    "tee .approval/l* < .approval/env",
  ]) {
    for (const at of [lab, logLab]) {
      const decision = claude(command, at);
      // The credential read beside it may be the class the denial names.
      assert.match(decision, /^deny: .*(policy\.core|log\.mutate|account\.credential)/u, `${command}: ${decision}`);
    }
    const judged = classes(command);
    assert.ok(judged.includes("policy.core") && judged.includes("log.mutate"), `${command}: ${judged.join(", ")}`);
  }
  // A copy READS its sources: `.approval/*` as a source is the approval
  // home's class, as on main, beside the credential read.
  assert.deepEqual([...classes("cp .approval/* /tmp/x < .approval/env")].sort(), ["account.credential", "policy.core"]);
  // Every candidate under the log is the log: no cap demotes or widens it.
  assert.deepEqual(classes("echo x > .approval/log/*/*"), ["log.mutate"]);
  assert.match(claude("echo x > .approval/log/*/*", logLab), /^deny: .*log\.mutate/u);
  // Past #686's caps the word is the log and the gate's organs, and every
  // other guarded name's class (build-1's M2 at 64c43399), each judged.
  const pastCap = `echo x > .approval/log/${"b*/".repeat(65)}x`;
  assert.deepEqual(classes(pastCap), ["log.mutate", "policy.core", "policy.edit", "cron.manage"]);
  for (const at of [lab, logLab]) assert.match(claude(pastCap, at), /^deny: .*(policy\.core|log\.mutate)/u);
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
  // `dist/^keep` is judged as `dist/*` is, whose own reading (#686's,
  // GLOB-WRITE) may name `dist/.approval`: nothing beyond that.
  for (const [command, star] of [
    ["rm -rf dist/^keep", "rm -rf dist/*"],
    ["echo x > dist/^keep", "echo x > dist/*"],
  ] as const) {
    assert.deepEqual([...classes(command)].sort(), [...new Set([...classes(star), ...classes(command.replace("^keep", "keep"))])].sort(), command);
  }
  assert.ok(!classes("ls dist/{a}").some((cls) => GUARDED.test(cls)), classes("ls dist/{a}").join(", "));
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

test("security review of aec23242: no segment skips the zsh reading for its spelling, and quoted parts are literals", () => {
  // zsh -f with extendedglob (and globdots) opens the guarded file for each;
  // at aec23242 each was allowed under both policies (main allows them too).
  for (const command of [
    "echo x > APPROV^1", // a git-revision-like suffix is still zsh's ^
    "cat .approval/e^1",
    "cat ~/^1/auth.json",
    "cat ~/.hermes/a^1",
    "cat ~/.hermes/'a'^x.json", // the quoted part is a literal, the ^ is not
    'cat ~/.hermes/"a"^x.json',
    "cat ~/.hermes/\\a^x.json",
    "cat ~/.h'e'^Z/auth.json",
  ]) {
    for (const at of [lab, abstainLab]) {
      const decision = claude(command, at);
      assert.match(decision, /^deny: /u, `${command}: ${decision}`);
    }
  }
  // A git revision still reads as git spells it where no file matches.
  assert.deepEqual(classes("git diff HEAD~1"), classes("git diff HEAD"));
  assert.deepEqual(classes("git show HEAD^2"), classes("git show HEAD"));
});

test("coordinator on aec23242: a zsh form with no slash names only what the directory it runs in holds", () => {
  // Under extendedglob `^import` matches the entries of the working
  // directory, hidden ones too under globdots (the lead's ruling L61497). In
  // a directory that holds no guarded entry none of these reads a credential
  // (at aec23242 each was refused as account.credential, which main allowed).
  const plainDir = join(scratch, "no-guarded-entries");
  mkdirSync(join(plainDir, "src"), { recursive: true });
  writeFileSync(join(plainDir, "README.md"), "x\n", "utf8");
  for (const command of ["grep -r ^import src", "grep ^foo README.md", "grep -n ^# README.md", "rg ^use src", "git log ^main"]) {
    assert.ok(!classesIn(plainDir, command).includes("account.credential"), `${command}: ${classesIn(plainDir, command).join(", ")}`);
  }
  // Beside `.approval` they name it, and take main's answer for the name as
  // written (`grep x .approval README.md` is account.credential on main).
  assert.ok(classes("grep .approval README.md").includes("account.credential"));
  assert.ok(classes("grep ^foo README.md").includes("account.credential"));
  assert.ok(classes("grep -r ^import src").includes("account.credential"));
  assert.ok(classes("grep -r .^zz src").includes("account.credential"));
  assert.ok(classes("echo x > APPROV^1").includes("policy.core"));
  // Where the directory may move, the plain glob answers (strict).
  assert.ok(classes("cd src; grep -r ^import x").includes("account.credential"));
});

/** {@link classes} for a command run in `dir`, which holds no gate. */
function classesIn(dir: string, command: string): string[] {
  const saved = process.env["HOME"];
  process.env["HOME"] = lab.home;
  try {
    const judged = classifyForHook(command, [], dir, [], false, [dir], false) as {
      result: { ok: boolean; classes?: string[]; code?: string };
    };
    return judged.result.ok ? (judged.result.classes ?? []) : [`refused:${judged.result.code ?? "?"}`];
  } finally {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
  }
}

test("security review of c53565eb: a word is read as the entries it matches only where the directory and what it holds are proven", () => {
  // 1: a change of directory in any spelling before the word. zsh expands
  // `^zz` in the Hermes home, where it names auth.json and .env; at c53565eb
  // the quoted and escaped `cd` kept the listing of the start directory and
  // each line was allowed.
  for (const command of ["'c'd ~/.hermes; cat ^zz", "\\cd ~/.hermes; cat ^zz", "c\\d ~/.hermes; cat ^zz"]) {
    for (const at of [lab, abstainLab]) assert.match(claude(command, at), /^deny: .*account\.credential/u, command);
  }
  // 2: hidden entries count (globdots may be set): at c53565eb `^zz` named
  // no hidden entry, so a recursive read of it missed `.approval/env`.
  for (const at of [lab, abstainLab]) assert.match(claude("grep -r ^zz README.md", at), /^deny: .*account\.credential/u);
  // 3: every word is every entry it matches, as zsh passes it. At c53565eb
  // the second `^zz` stood as its first match alone, so the copy's last
  // word, its target, was `0.txt`; zsh's is APPROVAL.md.
  const two = join(scratch, "two-entries");
  mkdirSync(two, { recursive: true });
  for (const name of ["0.txt", "APPROVAL.md"]) writeFileSync(join(two, name), "x\n", "utf8");
  assert.equal(zshOptionCommandReading("cat ^zz ^zz", [two]), "cat '0.txt' 'APPROVAL.md' '0.txt' 'APPROVAL.md'");
  // A command that may write is not one a listing answers: the plain glob.
  assert.equal(zshOptionCommandReading("cp ^zz ^zz", [two]), "cp * *");
  assert.ok(classesIn(two, "cp ^zz ^zz").includes("policy.core"));
  // 4: a word after a command that can make files is the plain glob, never
  // the word as written: `zq#` is `z*`, as `zq*` is read. At c53565eb it was
  // `zq#` as written (no entry matched when the hook ran), read in scope,
  // where `zq*` is read out of scope.
  const listed = (decision: string): string[] => {
    assert.match(decision, /^allow: autonomous: /u);
    return decision.replace(/^allow: autonomous: /u, "").split(", ");
  };
  for (const maker of ["git checkout other", "tar xf a.tar", "touch zq"]) {
    const plain = listed(claude(`${maker}; cat zq*`));
    const read = listed(claude(`${maker}; cat zq#`));
    for (const cls of plain) assert.ok(read.includes(cls), `${maker}: ${cls} missing from ${read.join(", ")}`);
  }
  // In the first command, with nothing before the word that can move or
  // make anything, the listing answers: `two` holds no credential.
  assert.ok(!classesIn(two, "grep -r ^foo README.md").includes("account.credential"));
});

test("security review of 901a37c6: only one plain read command is answered by a listing, never a reserved word or a group", () => {
  // zsh runs the `cd` in each of these before `^zz` expands, with no `;`,
  // `&`, `|` or `(` before the word (checked with zsh -f -o extendedglob):
  // at 901a37c6 the word was the start directory's entries.
  const two = join(scratch, "two-entries");
  mkdirSync(two, { recursive: true });
  for (const name of ["0.txt", "APPROVAL.md"]) writeFileSync(join(two, name), "x\n", "utf8");
  for (const [command, plain] of [
    ["{ cd ~/.hermes } always { cat ^zz }", "{ cd ~/.hermes } always { cat * }"],
    ["while { cd ~/.hermes } { cat ^zz; break }", "while { cd ~/.hermes } { cat *; break }"],
    ["if cd ~/.hermes; then cat ^zz; fi", "if cd ~/.hermes; then cat *; fi"],
    ["repeat 1 { cd ~/.hermes } ; cat ^zz", "repeat 1 { cd ~/.hermes } ; cat *"],
  ] as const) {
    assert.equal(zshOptionCommandReading(command, [two]), plain, command);
  }
  // The shapes a listing answers, and some it does not.
  for (const [command, listed] of [
    ["grep -r ^foo src", true],
    ["rg ^use src", true],
    ["git log ^main", true],
    ["git show ^main", true],
    ["sed -n ^p README.md", true],
    ["sed -i ^p README.md", false],
    ["sed -ni ^p README.md", false],
    ["awk -f ^p README.md", false],
    ["sed ^w README.md", false],
    ["git -C x log ^main", false],
    ["git push ^main", false],
    ["'c'at ^zz", false],
    ["X=1 cat ^zz", false],
    ["cat ^zz > out", false],
    ["cat ^zz | wc", false],
    ["cat ^zz $(true)", false],
    ["cat ^zz { }", false],
    ["time cat ^zz", false],
  ] as const) {
    const read = zshOptionCommandReading(command, [two]) ?? command;
    assert.equal(read.includes("'0.txt'"), listed, `${command}: ${read}`);
  }
});

/**
 * review-b's policy W2 (approval init's classes with `files.write.workspace`
 * human-only and `policy.edit` autonomous, every other class human-only), the
 * gate's top-level files beside it: a policy that holds a workspace write
 * stricter than an edit of an agent's instructions.
 */
const workspaceLab = ((): { dir: string; home: string } => {
  const dir = join(scratch, "proj-workspace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    POLICY.replace("  autonomy: autonomous\n", "  autonomy: human-only\n").replace(
      "classes:\n",
      "classes:\n  read.*:\n    autonomy: autonomous\n  policy.edit:\n    autonomy: autonomous\n  files.write.workspace:\n    autonomy: human-only\n",
    ),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir, lab.home);
  assert.equal(attested.code, 0, attested.stderr);
  for (const name of ["CLAUDE.md", "AGENTS.md", "README.md", "a.txt"]) writeFileSync(join(dir, name), "made-up\n", "utf8");
  return { dir, home: lab.home };
})();

test("review-b's M1 at 3774fdd4: a glob read as a top-level gate file keeps main's workspace class beside it", () => {
  // bash matches a glob with letter case kept: `CLAUDE.M?` does not name
  // CLAUDE.md, so each of these writes or deletes a new workspace file where
  // nothing matches, and main (324d87dc) denied each under W2 as
  // files.write.workspace / files.delete.out_of_scope. At 3774fdd4 the glob
  // reading's policy.edit replaced that class, and W2 allowed each.
  for (const command of [
    "echo x > CLAUDE.M?",
    "cp a.txt C[L]AUDE.MD",
    "tee cLaUdE.M? < a.txt",
    "echo x > AGENTſ.m?",
    "cat > AGENTS.M? <<'EOF'\nx\nEOF",
    "rm -f ?LAUDE.md",
    "cp README.md C*",
  ]) {
    assert.match(claude(command, workspaceLab), /^deny: .*files\.(write\.workspace|delete)/u, command);
  }
  // A canonical-case glob does name CLAUDE.md: policy.edit, with main's
  // workspace write beside it, since the glob names a new file when nothing
  // matches it.
  assert.deepEqual(classes("echo x > CLAUDE.m?"), ["policy.edit", "files.write.workspace"]);
  assert.match(claude("echo x > CLAUDE.m?", workspaceLab), /^deny: .*files\.write\.workspace/u);
  // The plain file keeps its one class, and W2 lets it through.
  assert.deepEqual(classes("echo x > CLAUDE.md"), ["policy.edit"]);
  assert.match(claude("echo x > CLAUDE.md", workspaceLab), /^allow: /u);
  // The same for `[!g]`, any one character since #682 where main read every
  // character but `g`: the `.git` write, beside main's workspace write.
  for (const command of ["echo x > .[\\!g]it/config", "cp README.md .gi[^t]/config"]) {
    const judged = classes(command);
    assert.ok(judged.includes("vcs.history.rewrite") && judged.includes("files.write.workspace"), `${command}: ${judged.join(", ")}`);
  }
  assert.deepEqual(classes("echo x > .gi[!x]/config"), ["vcs.history.rewrite"]);
});

test("review-b's M1 at 3774fdd4: the as-spelled reading matches a glob with letter case kept, as bash does", () => {
  assert.equal(globSegmentMatches("CLAUDE.M?", "CLAUDE.md"), true);
  // Folded, the case-variant glob may name the file; as spelled it names a
  // new one only. Both readings are judged.
  const asSpelled = (command: string): string[] => {
    const result = withNamesAsSpelled(() => classifyCommandInThisReading(command, []));
    return result.ok ? result.classes : [`refused:${result.code}`];
  };
  assert.deepEqual(asSpelled("echo x > CLAUDE.M?"), ["files.write.workspace"]);
  assert.deepEqual(asSpelled("echo x > CLAUDE.m?"), ["policy.edit", "files.write.workspace"]);
  const folded = classifyCommandInThisReading("echo x > CLAUDE.M?", []);
  assert.deepEqual(folded.ok ? folded.classes : [], ["policy.edit", "files.write.workspace"]);
});

test("review-b's M2 at 3774fdd4: a heredoc written through a glob into .git keeps vcs.history.rewrite", () => {
  // bash and zsh -f replace .git/config with the body. Main denied each under
  // `lab`'s policy (vcs.history.rewrite human-only, policy.edit at the
  // autonomous default); at 3774fdd4 `c*` read as CLAUDE.md made each
  // policy.edit alone, allowed.
  for (const command of [
    "cat > .git/c* <<'EOF'\n[core]\nEOF",
    "cat > .git/c* <<EOF\nx\nEOF",
    "tee .git/c* <<'EOF'\nx\nEOF",
    "echo x > .git/c*",
  ]) {
    assert.match(claude(command, lab), /^deny: .*vcs\.history\.rewrite/u, JSON.stringify(command));
    assert.ok(classes(command).includes("vcs.history.rewrite"), JSON.stringify(command));
  }
});

test("review-b's M2 at 3774fdd4: the git-directory pass reads a heredoc's segment, whose text leaves the body out", () => {
  // The pass lexed each segment's text alone, and a heredoc's segment ends
  // before its body, so it was refused as never terminated and skipped: a
  // heredoc written through a link into .git was a workspace write, on main
  // too, where the same write with `echo` was the git-directory write.
  const repo = join(scratch, "proj-git-link");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "config"), "[core]\n", "utf8");
  writeFileSync(join(repo, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], repo, lab.home);
  assert.equal(attested.code, 0, attested.stderr);
  symlinkSync(join(repo, ".git", "config"), join(repo, "cfg"));
  const at = { dir: repo, home: lab.home };
  for (const command of ["echo x > cfg", "cat > cfg <<'EOF'\nx\nEOF", "cat > cfg <<EOF\nx\nEOF", "tee -a cfg <<'EOF'\nx\nEOF"]) {
    assert.match(claude(command, at), /^deny: .*vcs\.history\.rewrite/u, JSON.stringify(command));
  }
  assert.equal(classifiedSegmentShapes("cat > cfg <<'EOF'")?.[0]?.writes[0], "cfg");
  assert.equal(commandSegmentShapes("cat > cfg <<'EOF'"), null);
  // An ordinary heredoc into the workspace stays what it was.
  assert.match(claude("cat > notes.txt <<'EOF'\nx\nEOF", at), /^allow: /u);
});

test("review-b's N3 at 3774fdd4: a directory pattern the Hermes home cannot list is judged by its folded spelling too", (t) => {
  // Where the home cannot be listed, the pattern alone is judged
  // (globCouldNameCredential): `hermeſ-agen?` and `pro?ileſ` fold to names
  // that reach a credential file, though neither the pattern nor its
  // lowered form matches them. Review-b's plant p4 (the folded pattern taken
  // back to toLowerCase) survived every test file before this one.
  const home = join(scratch, "home-unlistable");
  mkdirSync(join(home, ".hermes", "hermes-agent"), { recursive: true });
  mkdirSync(join(home, ".hermes", "profiles", "p1"), { recursive: true });
  writeFileSync(join(home, ".hermes", "hermes-agent", ".env"), "SYNTHETIC=1\n", "utf8");
  writeFileSync(join(home, ".hermes", "profiles", "p1", "auth.json"), "SYNTHETIC=1\n", "utf8");
  chmodSync(join(home, ".hermes"), 0o000);
  const saved = process.env["HOME"];
  try {
    try {
      readdirSync(join(home, ".hermes"));
      t.skip("this user can list a mode-000 directory");
      return;
    } catch {
      // Unlistable, as intended.
    }
    process.env["HOME"] = home;
    for (const command of ["cat ~/.hermes/hermeſ-agen?/.env", "cat ~/.hermes/pro?ileſ/p1/auth.json", "cat ~/.hermes/hermes‌-agen?/.env"]) {
      const judged = classifyForHook(command, [], lab.dir, [], false, [lab.dir]).result;
      assert.ok(judged.ok && judged.classes.includes("account.credential"), `${command}: ${JSON.stringify(judged)}`);
    }
  } finally {
    chmodSync(join(home, ".hermes"), 0o755);
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
  }
});

test("review-b's N1 at 3774fdd4: a bad pattern and a lone repeat are read as zsh 5.9 reads them under extendedglob", () => {
  // zsh -f -o extendedglob: `^#`, `x^#`, `d/#b` and `##b` are bad patterns,
  // and nothing from that command on runs, so the word is read as written;
  // `b#` and `bb#` name `b` and `bb` only, never APPROVAL.md.
  assert.equal(zshOptionCommandReading("cat a.txt | grep -v ^#", null), null);
  assert.equal(zshOptionCommandReading("cp a.txt b#", null), "cp a.txt b*");
  for (const [command, unwanted] of [
    ["cat a.txt | grep -v ^#", "account.credential"],
    ["cp a.txt b#", "policy.core"],
    ["cp a.txt bb#", "policy.core"],
  ] as const) {
    assert.ok(!classes(command).includes(unwanted), `${command}: ${classes(command).join(", ")}`);
  }
  // The forms that do expand keep their readings.
  assert.equal(zshOptionCommandReading("cat ~/.hermes/au#th.json", null), "cat ~/.hermes/a*th.json");
  assert.equal(zshOptionCommandReading("cat ~/.Z#hermes/auth.json", null), "cat ~/.*hermes/auth.json");
  assert.match(claude("cat ~/.hermes/au#th.json"), /^deny: /u);
});

test("lead's ruling L62400: the write-target cases #682's reader caught and #686's missed, in #686's reader", () => {
  // One reader, #686's (lead's ruling L62400). On main 9122cb3e each line below
  // was ALLOWED through the real hook under `lab`'s policy (policy.core
  // human-only, log.mutate at the autonomous default), though each writes or
  // deletes a gate file in bash and zsh; #682's reader judged each policy.core.
  const deniedAsCore = [
    // 1. A walk stopped at the first candidate naming the log, and the other
    //    candidates' classes were not judged: the log is not the strict
    //    answer under a policy that leaves it autonomous. An ANSI-C quoted
    //    `!` in a class is a member to every shell, so these write
    //    APPROVAL.md and .claude/settings.json; `**` may be the log's folder
    //    or the Hermes home's own.
    "echo x >> [$'!'A]PPROVAL.md",
    "rm -f [$'!'A]PPROVAL.md",
    "echo x >> .[$'!'c]laude/settings.json",
    "echo x > ~/.hermes/**/config.yaml",
    "cp README.md ~/.hermes/**/auth.json",
    // 2. A segment's words stopped at the first word whose answer was
    //    `log.mutate`, and the words after it were not read: `A*.md` is
    //    APPROVAL.md.
    "tee .approval/log/x A*.md",
    "echo x > .approval/log/x > A*.md",
    // 1 again, alone (build-1's N5 at 64c43399): one word whose first
    // expansion is the log and whose next one is the policy file, which the
    // lab holds (the hook matches the pattern against the listing). The walk
    // that stopped at the first candidate naming the log never reached the
    // second expansion; main 74fa1f34 allows each.
    "echo x > {.approval/log/x,A*.md}",
    "rm -f {.approval/log/x,APPROVAL.m?}",
    "tee {.approval/log/x,APPROVAL.m?}",
  ];
  for (const command of deniedAsCore) {
    assert.ok(classes(command).includes("policy.core"), `${command}: ${classes(command).join(", ")}`);
    const decision = claude(command, lab);
    assert.match(decision, /^deny: .*policy\.core/u, `${command}: ${decision}`);
  }
  // 3. Every class a candidate names is judged, not the strictest by the
  //    classifier's rank alone (review-b N1 at bcb1be08; #690): `A*.md` is
  //    AGENTS.md as well as APPROVAL.md, and `~/.hermes/*/.env` may be a
  //    profile's or the cron folder's.
  assert.ok(classes("echo x > A*.md").includes("policy.edit"), classes("echo x > A*.md").join(", "));
  assert.ok(classes("cp -r ~/.hermes/*/.env").includes("cron.manage"), classes("cp -r ~/.hermes/*/.env").join(", "));
  // 4. The deferral path (a credential read beside a protected write) read no
  //    pattern: `log.mutate` was lost (codex's HOLD at d24f98ab).
  for (const command of ["rm -rf .approval/* < .approval/env", "tee .approval/l* < .approval/env"]) {
    const judged = classes(command);
    assert.ok(["log.mutate", "policy.core", "account.credential"].every((cls) => judged.includes(cls)), `${command}: ${judged.join(", ")}`);
    assert.match(claude(command, logLab), /^deny: /u, command);
  }
  // 5. Past #686's caps a pattern was `log.mutate` alone; it is now
  //    GLOB_GUARD_UNKNOWN, the log and the gate's organs, each judged.
  const pastCaps = `echo x > build/${"b*/".repeat(65)}x`;
  assert.ok(classes(pastCaps).includes("policy.core"), classes(pastCaps).join(", "));
  assert.match(claude(pastCaps, lab), /^deny: .*policy\.core/u);
});


test("build-1's M2 at 64c43399 (lead ruling L62483): an expansion past a cap no longer ends the word, and the unknown answer carries every guarded class", () => {
  // Each line was ALLOWED through the real hook at 64c43399 (and on main) in a
  // lab holding only its class human-only: the first expansion, `*/*/*/x`, is
  // past the candidate cap, the reader returned there, and the unknown answer
  // was `log.mutate` and `policy.core` alone, so `CLAUDE.md`, `SPEC.md` and the
  // workflow the second expansion writes were never judged.
  const editLab = classLab("edit", "policy.edit");
  const specLab = classLab("spec", "policy.edit.spec", ['{ path: "SPEC.md", class: policy.edit.spec }']);
  const ciLab = classLab("ci", "policy.edit.ci", ['{ path: ".github/workflows/", class: policy.edit.ci }']);
  for (const [command, at, cls] of [
    ["tee {*/*/*/x,CLAUDE.m?}", editLab, "policy.edit"],
    ["tee {*/*/*/x,AGENTS.m?}", editLab, "policy.edit"],
    ["tee {*/*/*/x,.npmr?}", editLab, "policy.edit"],
    ["tee {*/*/*/x,SPEC.m?}", specLab, "policy.edit.spec"],
    ["tee {*/*/*/x,.g*/workflows/ci.yml}", ciLab, "policy.edit.ci"],
    // A word past the cap on its own: no candidate is judged, so every class
    // a guarded name could carry is (the half that kills a narrow unknown).
    ["tee */*/*/x", editLab, "policy.edit"],
    ["tee */*/*/x", specLab, "policy.edit.spec"],
    ["tee */*/*/x", ciLab, "policy.edit.ci"],
    [`echo x > build/${"b*/".repeat(65)}x`, ciLab, "policy.edit.ci"],
  ] as const) {
    const decision = claude(command, at);
    assert.match(decision, new RegExp(`^deny: .*class ${cls.replaceAll(".", "\\.")} `, "u"), `${command}: ${decision}`);
  }
});

test("build-1's S1 at 64c43399: a brace group the shell expands anyway, beside a parameter, is not any name under zsh's options", () => {
  // The zsh option reading wrote a segment holding a form and a `$` as `*`,
  // which #686's reader takes as every guarded name: these went from allow
  // (main 74fa1f34, c2259a22) to deny under policy.core human-only. braceccl
  // reads only a group that would not otherwise expand, and zsh never globs a
  // parameter's or a substitution's value (zsh -f, braceccl and extendedglob
  // set: `print -r -- file{1..3}$EXT` prints `file1.txt file2.txt file3.txt`).
  for (const command of [
    "touch file{1..3}$EXT",
    "mkdir -p build/{debug,release}$SUFFIX",
    "echo x > out{1,2}$N.log",
    "mkdir -p dist/{css,js}$V",
    "touch log{1,2}.$USER",
    "mkdir -p out/{a,b}_$(date +%s)",
    "mkdir -p {a,b}${SUFFIX}",
    "mkdir -p ~/proj/{src,test}$X",
  ]) {
    assert.equal(zshOptionCommandReading(command, null), null, command);
    assert.match(claude(command), /^allow: autonomous: files\.write\.workspace$/u, command);
  }
  // The guarded twins keep the any-name reading: `{A}` is a braceccl group
  // (`A`), a `^` is a negation, `{1..$N}` is no sequence until the parameter is
  // read, and a group cut by a quote is not one.
  for (const command of [
    "echo x > {A}PPROVAL.md$N",
    "echo x > APPROVAL.m^q\"$N\"",
    "echo x > {1..$N}APPROVAL.md",
    "echo x > {a','b}APPROVAL.md$N",
    "touch {a,b}^c$X",
  ]) {
    assert.equal(zshOptionCommandReading(command, null)?.endsWith(" *"), true, command);
    assert.match(claude(command), /^deny: .*policy\.core/u, command);
  }
});

test("security review of 16426b38: the unknown answer is kept per reading, so neither reading reuses the other's", () => {
  // Two entries on one path: as spelled the first declared answers alone, and
  // the folded reading takes each (takeAmongEqual). A memo keyed on the
  // entries alone kept whichever reading asked first, and a spelled-first
  // line left the folded reading without policy.edit.design (fail open).
  const tied = (): { path: string; class: string }[] => [
    { path: "SPEC.md", class: "policy.edit.spec" },
    { path: "SPEC.md", class: "policy.edit.design" },
  ];
  const pastCap = `echo x > build/${"b*/".repeat(65)}x`;
  const classesIn = (result: ReturnType<typeof classifyCommandInThisReading>): string[] =>
    result.ok ? [...new Set(result.classes)].sort() : [`refused ${result.code}`];
  const spelledFresh = classesIn(withNamesAsSpelled(() => classifyCommandInThisReading(pastCap, tied())));
  const foldedFresh = classesIn(classifyCommandInThisReading(pastCap, tied()));
  assert.ok(foldedFresh.includes("policy.edit.design") && foldedFresh.includes("policy.edit.spec"), foldedFresh.join(", "));
  assert.ok(!spelledFresh.includes("policy.edit.design"), spelledFresh.join(", "));
  // Spelled first, then folded, on one entry list: the folded answer is whole.
  const first = tied();
  withNamesAsSpelled(() => classifyCommandInThisReading(pastCap, first));
  assert.deepEqual(classesIn(classifyCommandInThisReading(pastCap, first)), foldedFresh);
  // Folded first, then spelled: the spelled answer is its own.
  const second = tied();
  classifyCommandInThisReading(pastCap, second);
  assert.deepEqual(classesIn(withNamesAsSpelled(() => classifyCommandInThisReading(pastCap, second))), spelledFresh);
});

test("build-1's queue red 3 on #682: the unknown answer leaves the line's own reading as it found it", () => {
  // globGuardUnknown's list joins both readings of every guarded name itself,
  // so a name of the list that folds (APPROVAL.md) no longer marks the CALLER's
  // reading diverged: a line that does not diverge on main is read once, not
  // a second time as spelled (1.5 to 1.7 times main's cost on "nested defaults
  // with outputs", n=20000). A fresh entry list per call, as the hook and the
  // cost tests give it, so the list's memo never answers.
  const pastCap = `echo x > build/${"b*/".repeat(65)}x`;
  const readings = (line: string): number => eachNameReading(() => classifyCommandInThisReading(line, [])).length;
  const classesOf = (line: string, entries: { path: string; class: string }[] = []): string[] => {
    const result = classifyCommandInThisReading(line, entries);
    return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
  };
  // Read once, as on main (the second reading came from the list alone) ...
  assert.equal(readings(pastCap), 1);
  // ... and the answer is the whole unknown answer, as it was.
  assert.deepEqual(classesOf(pastCap), [
    "log.mutate redirect-protected",
    "policy.core redirect-protected",
    "policy.edit redirect-protected",
    "cron.manage redirect-protected",
    "files.write.workspace redirect-write",
  ]);
  // A line whose own names diverge is still read as spelled too, whether its
  // own name comes before the unknown answer or after it: the list restores
  // the reading it found, it does not clear it.
  assert.equal(readings("echo y > APPROVAL.MD"), 2);
  assert.equal(readings(`echo y > APPROVAL.MD; ${pastCap}`), 2);
  assert.equal(readings(`${pastCap}; echo y > APPROVAL.MD`), 2);
  // Tied entries: the folded reading still takes each (the memo per reading,
  // security review of 16426b38), and as spelled the first alone.
  const tied = (): { path: string; class: string }[] => [
    { path: "SPEC.md", class: "policy.edit.spec" },
    { path: "SPEC.md", class: "policy.edit.design" },
  ];
  const folded = classesOf(pastCap, tied());
  assert.ok(folded.includes("policy.edit.spec redirect-protected") && folded.includes("policy.edit.design redirect-protected"), folded.join(", "));
  const spelled = withNamesAsSpelled(() => classesOf(pastCap, tied()));
  assert.ok(!spelled.includes("policy.edit.design redirect-protected"), spelled.join(", "));
  // The helper itself: what runs inside is undone, what the caller recorded stays.
  assert.equal(eachNameReading(() => apartFromCallerReading(() => foldNameExact("APPROVAL.md"))).length, 1);
  assert.equal(eachNameReading(() => { foldNameExact("APPROVAL.md"); return apartFromCallerReading(() => foldNameExact("approval.md")); }).length, 2);
  assert.equal(eachNameReading(() => { apartFromCallerReading(() => foldNameExact("APPROVAL.md")); return foldNameExact("APPROVAL.md"); }).length, 2);
  assert.equal(eachNameReading(() => apartFromCallerReading(() => foldNameExact("approval.md"))).length, 1);
});
