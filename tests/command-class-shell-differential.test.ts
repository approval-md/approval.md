/**
 * Shell differential: the classifier's verdict against what bash actually runs
 * (APRV-508, security findings on command-class.ts).
 *
 * The classifier refuses a command it cannot read, and a command that runs
 * something with no class of its own is the bypass this file looks for. So it
 * runs each command string through a REAL bash, in a scratch directory, with a
 * PATH holding nothing but stub scripts. A stub only appends its own name to a
 * log, so no real program runs: `evil` stands for any command the classifier
 * has no rule for, and `rm` for one it classifies as a write. The oracle:
 *
 * - if the classifier ADMITS a command (any class), bash must not have run
 *   `evil`, which no rule names; and
 * - if the classifier admits it as reads only, bash must not have run `rm`.
 *
 * The corpus is the hand-written list below (every construct the security
 * findings named: `>&` beside quotes and escapes, line continuations, ANSI-C
 * quoting, `${…:-$(…)}`, nested `$( $( ) )`, arithmetic with `$(…)` inside,
 * comments after operators, CR, NBSP and other non-ASCII whitespace, `;;` and
 * `case`, heredoc bodies and delimiters quoted and not, here-strings,
 * redirection targets, assignments and subscripts) plus seeded mutations of
 * it: one or two tokens from a quoting-and-operator alphabet inserted at random
 * points, so the near misses around each construct are run as well. A first
 * pass proves the oracle fires (bash runs `evil` in hundreds of these).
 *
 * Builtins still run as builtins, so the corpus holds no `/` (an absolute path
 * would bypass the stub PATH), no `cd`, and no `\x`/octal escape that could
 * spell one at run time.
 *
 * Gated on bash 4 or later (the boxes and CI run bash 5): macOS still ships
 * bash 3.2, whose parser differs in places this corpus reaches, so a run there
 * would test a shell the classifier is not deployed beside. The test is
 * skipped, with the reason printed, when no bash 4+ is found or when the
 * oracle's self-check does not hold on the bash it found.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";

/** The bash major version, or 0 when it cannot be read. */
function bashMajor(path: string): number {
  const probe = spawnSync(path, ["--noprofile", "--norc", "-c", "echo ${BASH_VERSINFO[0]}"], {
    encoding: "utf8",
    timeout: 3000,
  });
  return probe.status === 0 ? Number.parseInt(probe.stdout.trim(), 10) || 0 : 0;
}

const BASH_CANDIDATES = ["/usr/local/bin/bash", "/opt/homebrew/bin/bash", "/usr/bin/bash", "/bin/bash"].filter(
  (candidate) => existsSync(candidate),
);
const BASH = BASH_CANDIDATES.find((candidate) => bashMajor(candidate) >= 4);

const root = mkdtempSync(join(tmpdir(), "approval-md-shell-diff-"));
const stubs = join(root, "stubs");
const log = join(root, "ran.log");
mkdirSync(stubs);
for (const name of ["evil", "rm", "cat", "date", "ls", "paste", "seq", "head", "wc"]) {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/sh\necho ${name} >> '${log}'\n`);
  chmodSync(path, 0o755);
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The stubs bash ran for this command string, in order. */
function bashRuns(command: string): string[] {
  rmSync(log, { force: true });
  const work = join(root, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  spawnSync(BASH as string, ["--noprofile", "--norc", "-c", command], {
    cwd: work,
    env: { PATH: stubs, HOME: work },
    timeout: 3000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const CURATED: readonly string[] = [
  "date >&'2'",
  "date >&\"2\"",
  "date >&\\2",
  "date >&2'x'",
  "date >&'x' ; evil",
  "date >&\\\n2",
  "date >&$'\\x32'",
  "date >& 2;evil",
  "date 2>&1;evil",
  "date >&2\\;evil",
  "date \\\n-u",
  "date \\\n; evil",
  "da\\\nte",
  "date -u\\\n;evil",
  "echo $(da\\\nte)",
  "date # \\\nevil",
  "date \\\n# c\nevil",
  "echo $'a\\'b'; evil",
  "echo $'a\\' ; evil ; echo '",
  "echo $'\\''; evil",
  "echo $'x' ; date",
  "echo $'\\x24(evil)'",
  "echo $'`evil`'",
  "echo $\"$(evil)\"",
  "echo $\"x\"",
  "date -d $'now'",
  "echo $'it\\'s' && date",
  "echo ${X:-$(evil)}",
  "echo ${X:-`evil`}",
  "echo \"${X:-$(evil)}\"",
  "echo ${X:-'$(evil)'}",
  "echo ${X:-\"$(evil)\"}",
  "echo ${X#$(evil)}",
  "echo ${X:-${Y:-$(evil)}}",
  "echo ${#X} ; date",
  "echo ${X:=$(evil)}",
  "echo '${X:-$(evil)}'",
  "echo $(echo $(evil))",
  "echo $(date $(evil))",
  "echo \"$(echo \"$(evil)\")\"",
  "echo $(echo ')' ; evil)",
  "echo $(echo \")\" ; evil)",
  "echo $(case x in x) evil;; esac)",
  "echo $( (evil) )",
  "echo $(echo \\) ; evil)",
  "echo $(# )\nevil)",
  "echo $(echo x # )\nevil\n)",
  "echo $((1+$(evil)))",
  "echo $(( $(evil) ))",
  "echo $[$(evil)]",
  "echo $((a[$(evil)]))",
  "(( $(evil) ))",
  "echo $(( 1 ))$(evil)",
  "echo $( (1+1) )",
  "echo $((1)) ; date",
  "date # $(evil)",
  "date #; evil",
  "date x#y; evil",
  "date;# x\nevil",
  "date &&# x\nevil",
  "date |# x\nevil",
  "date >& # x\nevil",
  "date; #evil",
  "echo a#b ; evil",
  "date#; evil",
  "date '#' ; evil",
  "date \\#; evil",
  "echo ${X#x}; evil",
  "date\r\nevil",
  "date\revil",
  "date\r;evil",
  "date\u00a0;evil",
  "date\u00a0evil",
  "date\u2028evil",
  "date\u3000evil",
  "date\u000bevil",
  "date\fevil",
  "date\tevil",
  "case x in x) evil;; esac",
  "case x in x) date;; esac",
  "case $(evil) in x) ;; esac",
  "date ;; evil",
  "date;;evil",
  "cat <<EOF\n$(evil)\nEOF",
  "cat <<-EOF\n\t$(evil)\n\tEOF",
  "cat <<EOF\n`evil`\nEOF",
  "cat <<EOF\n${X:-$(evil)}\nEOF",
  "cat <<'EOF'\n$(evil)\nEOF",
  "cat <<\"EOF\"\n$(evil)\nEOF",
  "cat <<\\EOF\n$(evil)\nEOF",
  "cat <<EOF\n\\$(evil)\nEOF",
  "cat <<E'O'F\n$(evil)\nEOF",
  "cat <<EOF\nx\nEOF\nevil",
  "cat <<EOF;evil\nx\nEOF",
  "cat <<EOF | cat\n$(evil)\nEOF",
  "cat <<EOF\nEOF \nevil\nEOF",
  "cat <<-EOF\n\tx\n\tEOF\nevil",
  "cat <<EOF\n$(echo\nEOF\n)\nEOF",
  "cat << EOF\n$(evil)\nEOF",
  "cat <<EOF <<EOF2\nx\nEOF\n$(evil)\nEOF2",
  "cat <<EOF\r\n$(evil)\r\nEOF\r\n",
  "cat <<<\"$(evil)\"",
  "cat <<< $(evil)",
  "cat <x$(evil)",
  "date > \"$(evil)\"",
  "date >|x$(evil)",
  "date &>x$(evil)",
  "date &>>x$(evil)",
  "date 2>x$(evil)",
  "date {fd}>x$(evil)",
  "date <>x$(evil)",
  "date <>x ; evil",
  "date >x`evil`",
  "date >&$(evil)",
  "date 1>&$(evil)",
  "X=$(evil)",
  "X=$(evil) date",
  "a[$(evil)]=1",
  "X=`evil`",
  "X=${Y:-$(evil)}",
  "a=($(evil))",
  "X+=$(evil)",
  "declare X=$(evil)",
  "local X=$(evil)",
  "export X=$(evil)"
];

/** Inserted by the mutation pass: quoting, operators, and the two stubs. */
const ALPHABET: readonly string[] = [
  "date", "cat", "evil", "rm", " ", ";", "\n", "&&", "|", "$(", ")", "`", "'", '"', "\\", "$'", "\\'", "#",
  ">&", ">", "<", "<<", "EOF", "<<'EOF'", "${X:-", "}", "$((", "))", "1", "x", "\r", "\u00a0", "\t", "a[", "]",
  "=", "X=", "$X", ";;", "2>&1", "&",
];

function corpus(): string[] {
  let seed = 4242;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out = [...CURATED];
  for (let i = 0; i < 3000; i += 1) {
    let text = CURATED[Math.floor(rand() * CURATED.length)] as string;
    const inserts = 1 + Math.floor(rand() * 2);
    for (let j = 0; j < inserts; j += 1) {
      const at = Math.floor(rand() * (text.length + 1));
      text = text.slice(0, at) + (ALPHABET[Math.floor(rand() * ALPHABET.length)] as string) + text.slice(at);
    }
    out.push(text);
  }
  return out.filter((text) => !/[/]|\bcd\b|\\x|\\[0-7]/u.test(text));
}

test("shell differential: nothing the classifier admits runs a command it did not classify", (t) => {
  if (BASH === undefined) {
    const found = BASH_CANDIDATES.map((candidate) => `${candidate} (bash ${String(bashMajor(candidate))})`);
    return t.skip(`needs bash 4 or later; found ${found.length === 0 ? "none" : found.join(", ")}`);
  }
  // The oracle can see what it looks for; a bash on which it cannot is skipped
  // with what it saw, rather than failing the suite for the shell's sake.
  const control = bashRuns("cat <<EOF\n$(evil)\nEOF");
  if (control.join(",") !== "evil,cat") {
    return t.skip(`the oracle self-check did not hold on ${BASH}: expected evil,cat, saw ${control.join(",") || "nothing"}`);
  }
  let admitted = 0;
  let ranEvil = 0;
  for (const command of corpus()) {
    const verdict = classifyCommand(command);
    const ran = bashRuns(command);
    if (ran.includes("evil")) ranEvil += 1;
    if (!verdict.ok) continue;
    admitted += 1;
    assert.ok(!ran.includes("evil"), `admitted as ${verdict.classes.join(",")} but bash ran evil: ${JSON.stringify(command)}`);
    if (verdict.classes.every((cls) => cls.startsWith("read."))) {
      assert.ok(!ran.includes("rm"), `admitted as a read but bash ran rm: ${JSON.stringify(command)}`);
    }
  }
  assert.ok(ranEvil > 100, `the corpus must make bash run evil often enough to mean something (${String(ranEvil)})`);
  t.diagnostic(`${String(admitted)} admitted, bash ran evil in ${String(ranEvil)}, against ${BASH}`);
});
