/**
 * Write landings, the disk half (design v4, writes outside the workspace).
 *
 * Every case builds real directories and real symlinks under a temp root, with
 * HOME a fixture folder inside it, and classifies through `classifyForHook`:
 * nothing here runs a command line. The file tools go through the compiled CLI
 * (`approval hook claude-code`) against an attested policy, and the open
 * window through `approval gate open` in process.
 *
 * The contract under test, in order of weight:
 *
 * 1. Under a policy that does not opt in, the only change is an ADDED
 *    `files.write.guarded` entry, for the guarded list and for a target that
 *    cannot be read: every class main gave stays where it was.
 * 2. The guarded class is judged on the word as spelled and on every landing,
 *    before any root.
 * 3. The resolver gives up rather than guessing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook, hookSettingsReads, HOOK_SETTINGS_MAX_BYTES, readTar, refineWriteLandings, resolveWriteScope, WRITE_SCOPE_OFF, type WriteScopeContext } from "../src/cli/hook.js";
import { commandGate } from "../src/cli/gate-window.js";
import type { Streams } from "../src/cli/main.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";

/** dist/tests/x.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const GUARDED = "files.write.guarded";
const OUT = "files.write.out_of_scope";
const WORKSPACE = "files.write.workspace";
const DELETE_OUT = "files.delete.out_of_scope";

const base = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-write-landings-")));
after(() => {
  rmSync(base, { recursive: true, force: true });
});

// HOME is a fixture folder: nothing here reads or writes the real one.
const home = join(base, "home");
process.env["HOME"] = home;
// The seats that run this suite set CLAUDE_CONFIG_DIR to a real config folder:
// a test that inherited it would judge (and read) the real one. Each case
// below that needs it sets it, and puts it back (S2).
delete process.env["CLAUDE_CONFIG_DIR"];
delete process.env["CLAUDE_PROJECT_DIR"];
mkdirSync(join(home, ".ssh", "sub"), { recursive: true });
writeFileSync(join(home, ".zshrc"), "# rc\n", "utf8");
const ws = join(base, "ws");
const outside = join(base, "outside");
mkdirSync(join(ws, "scripts"), { recursive: true });
mkdirSync(join(ws, "sub"), { recursive: true });
mkdirSync(join(ws, "a.d"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(ws, "a"), "a", "utf8");
writeFileSync(join(ws, "scripts", "one.sh"), "", "utf8");
writeFileSync(join(ws, "scripts", "two.sh"), "", "utf8");
symlinkSync(join(home, ".ssh", "sub"), join(ws, "link"));
symlinkSync(join(home, ".zshrc"), join(ws, "rc"));
symlinkSync(outside, join(ws, "link-out"));

/** A policy that opts in, rooted at the workspace. */
function optedIn(declared?: string[]): WriteScopeContext {
  return resolveWriteScope(ws, ws, {
    version: "0.1",
    classes: { [OUT]: { autonomy: "supervised-retro" } },
    ...(declared === undefined ? {} : { write_scope: { roots: declared } }),
  });
}

interface Seen {
  ok: boolean;
  segments: Array<[cls: string, rule: string]>;
  classes: string[];
  notes: string;
}

function see(command: string, scope: WriteScopeContext = WRITE_SCOPE_OFF, cwd = ws): Seen {
  const refined = classifyForHook(command, [], cwd, [], false, [], false, scope);
  if (!refined.result.ok) return { ok: false, segments: [], classes: [], notes: refined.result.code };
  return {
    ok: true,
    segments: refined.result.segments.map((segment) => [segment.class, segment.rule]),
    classes: refined.result.classes,
    notes: refined.notes.join("\n"),
  };
}

/** The classes before this design's pass: what the chain gave when only the old passes ran. */
function withoutLandingEntries(seen: Seen): Array<[string, string]> {
  return seen.segments.filter(([cls, rule]) => !(["write-guarded", "write-unreadable", "write-out-of-scope"].includes(rule) && (cls === GUARDED || cls === OUT)));
}

// ---------------------------------------------------------------------------
// 1. The guarded list, under a policy that does not opt in
// ---------------------------------------------------------------------------

test("every write verb onto the list adds files.write.guarded and keeps its own class", () => {
  for (const command of [
    "echo x > ~/.zshrc",
    "echo x >> ~/.ssh/authorized_keys",
    "echo x > $HOME/.zshrc",
    "echo x > ${HOME}/.ssh/k",
    "echo x > /etc/hosts",
    "cp a ~/.ssh/authorized_keys",
    "cp a ~/.ssh/",
    "mv a ~/.zshrc",
    "tee ~/.zshrc",
    "touch ~/.ssh/config",
    "mkdir ~/Library/LaunchAgents",
    "ln -s a ~/.zshenv",
    "chmod 600 ~/.ssh/k",
    "truncate -s 0 ~/.zshrc",
    "sed -i '' s/a/b/ ~/.zshrc",
    "sed -i -e s/a/b/ ~/.bashrc",
    "curl -o ~/.zshrc https://example.invalid/x",
    "curl --output ~/.local/bin/tool https://example.invalid/x",
    "wget -O ~/.ssh/k https://example.invalid/x",
    "tar -x -f a.tgz -C ~/.ssh",
    "cp a /usr/local/bin/tool",
    "echo x > /Users/someone-else/x",
    "echo x > .git/hooks/pre-push",
    "echo x > .claude/hooks/pre-tool.sh",
    "tee .claude/hooks/pre-tool.sh < a",
    "sed -i s/a/b/ .Claude/Hooks/pre-tool.sh",
    "cp a .claude/hooks/",
  ]) {
    const seen = see(command);
    assert.equal(seen.ok, true, command);
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    // The entry is added BESIDE the classifier's answer, never in its place.
    assert.ok(withoutLandingEntries(seen).length >= 1, command);
  }
});

test("writes the pass reads beyond the plain rows: a substitution, a reader's own output, a name copied into a directory", () => {
  writeFileSync(join(ws, ".zprofile"), "", "utf8");
  for (const command of [
    "echo $(echo x > ~/.zshrc)",
    "X=$(tee ~/.ssh/k < a)",
    "sort -o ~/.zshrc a",
    "cp .zp* ~/",
    "cp $SRC ~/",
  ]) {
    const seen = see(command);
    if (!seen.ok) continue; // refused outright is stricter still
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  // A plain copy into the home under a name off the list stays as it was.
  assert.ok(!see("cp a ~/").classes.includes(GUARDED));
});

test("a listed place compares through the fold", () => {
  for (const command of ["echo x > ~/.SSH/k", "echo x > ~/.ZSHRC", "echo x > /ETC/hosts"]) {
    assert.ok(see(command).classes.includes(GUARDED), command);
  }
});

test("a write in the workspace, out of it, or into scratch is left exactly as it was", () => {
  for (const command of [
    "echo x > notes.txt",
    "cp a sub/",
    "mkdir -p sub/deeper",
    "echo x > ../sibling.txt",
    "echo x > link-out/y",
    "cp a ../sibling.txt",
    "tar -x -f a.tgz -C ../out",
    "chmod +x scripts/*",
    "cd sub && echo x > y",
    "X=sub; echo x > $X/y",
  ]) {
    const seen = see(command);
    assert.equal(seen.ok, true, command);
    assert.ok(!seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
    assert.ok(!seen.classes.includes(OUT), `${command}: a policy that does not opt in never sees the out-of-scope class`);
  }
  // Main's own answers for an out-of-scope cp stand under such a policy.
  assert.deepEqual(see("cp a ../sibling.txt").segments, [[DELETE_OUT, "write-out-of-scope-resolved"]]);
  assert.deepEqual(see("echo x > ../sibling.txt").segments, [[WORKSPACE, "redirect-write"]]);
});

test("a stricter class still wins: a protected path, a delete", () => {
  const policy = see("echo x > APPROVAL.md");
  assert.equal(policy.segments[0]?.[0], "policy.core");
  // A delete keeps its class and gets no write entry (point 7).
  assert.deepEqual(see("rm ~/.zshrc").segments, [[DELETE_OUT, "rm-unreadable-path"]]);
});

// ---------------------------------------------------------------------------
// 2. Landings, both readings, before any root
// ---------------------------------------------------------------------------

test("ws/link/../authorized_keys with link -> ~/.ssh/sub is guarded (the kernel's reading)", () => {
  const seen = see("echo x > link/../authorized_keys");
  assert.ok(seen.classes.includes(GUARDED), seen.notes);
  assert.match(seen.notes, /\.ssh\/authorized_keys/u);
  // The text alone reads it as ws/authorized_keys.
  assert.ok(!see("echo x > authorized_keys").classes.includes(GUARDED));
});

test("a write through a symlink lands on its target, and a final link is judged as both", () => {
  assert.ok(see("echo x > link/k").classes.includes(GUARDED));
  assert.ok(see("echo x > rc").classes.includes(GUARDED), "rc -> ~/.zshrc");
  assert.ok(see("mv a rc").classes.includes(GUARDED), "a move that replaces a guarded symlink");
  assert.ok(see("ln -sf a rc").classes.includes(GUARDED));
});

test("a listed path inside a root is still guarded: a checkout rooted at the home", () => {
  const scope = resolveWriteScope(home, home, { version: "0.1", classes: { [OUT]: { autonomy: "supervised-retro" } } });
  const seen = see("echo x > .ssh/authorized_keys", scope, home);
  assert.ok(seen.classes.includes(GUARDED), seen.notes);
  assert.ok(!see("echo x > notes.txt", scope, home).classes.includes(OUT));
});

test("a cd the hook can follow carries the write with it; one it cannot makes the write unreadable", () => {
  assert.ok(see("cd /etc && echo x > hosts").classes.includes(GUARDED));
  assert.ok(see("cd ~ && echo x > .zshrc").classes.includes(GUARDED));
  assert.ok(see("cd && echo x > .zshrc").classes.includes(GUARDED));
  const unknown = see('cd "$D" && echo x > y');
  assert.ok(unknown.classes.includes(GUARDED), unknown.notes);
  assert.match(unknown.notes, /write-unreadable/u);
});

// ---------------------------------------------------------------------------
// 3. The resolver gives up, it never guesses
// ---------------------------------------------------------------------------

test("a same-line variable set once, unconditionally, before the write is read", () => {
  assert.ok(see("X=~/.ssh; echo x > $X/k").classes.includes(GUARDED));
  assert.ok(see('X="$HOME/.ssh"; echo x > "$X/k"').classes.includes(GUARDED));
  assert.ok(!see("X=sub; echo x > $X/k").classes.includes(GUARDED));
  assert.ok(see("D=/etc; cp a $D/hosts").classes.includes(GUARDED));
});

test("unreadable targets are guarded: decision B", () => {
  for (const command of [
    "echo x > $X",
    "echo x > $X/y",
    "echo x > ${X:-sub}/y",
    "echo x > ${#X}",
    "echo x > $(pwd)/y",
    "echo x > \"$(mktemp)\"",
    "X=sub; X=other; echo x > $X/y",
    "true && X=sub; echo x > $X/y",
    "false || X=sub; echo x > $X/y",
    "X=sub true; echo x > $X/y",
    "echo x > $X/y; X=sub",
    "echo x > $1",
    "echo x > ~-/y",
    "echo x > ~root/y",
  ]) {
    const seen = see(command);
    if (!seen.ok) continue; // refused outright is stricter still
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    assert.match(seen.notes, /write-unreadable/u, command);
  }
});

test("a line that sets HOME, PWD or TMPDIR does not have them read", () => {
  for (const command of ["cd sub; echo x > $PWD/y", "PWD=/tmp; echo x > $PWD/y", "TMPDIR=/x; echo x > $TMPDIR/y", "HOME=/x; echo x > ~/y"]) {
    const seen = see(command);
    if (!seen.ok) continue;
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Globs, read from the disk
// ---------------------------------------------------------------------------

test("a glob is judged by what it matches on the disk", () => {
  assert.ok(!see("chmod +x scripts/*.sh").classes.includes(GUARDED));
  assert.ok(see("echo x > ~/.z*rc").classes.includes(GUARDED), "matches ~/.zshrc");
  assert.ok(see("chmod 600 ~/.ss?/*").classes.includes(GUARDED));
});

test("a pattern takes the class its matches take written out: the directory is listed (lead, CLAIMS L61914)", () => {
  // A gate's own folder: the policy file beside ordinary ones.
  const gated = join(base, "gated");
  mkdirSync(join(gated, "plain"), { recursive: true });
  mkdirSync(join(gated, "docs"), { recursive: true });
  for (const name of ["APPROVAL.md", "README.md", "a.txt", "plain/a.md", "plain/b.md", "docs/a.md"]) writeFileSync(join(gated, name), "x", "utf8");
  const at = (command: string, cwd = gated): Seen => see(command, WRITE_SCOPE_OFF, cwd);

  // The plain spellings, as main has them: the control.
  for (const plain of ["echo x > APPROVAL.md", "sed -i s/a/b/ APPROVAL.md README.md", "touch APPROVAL.md", "chmod +x APPROVAL.md", "git add APPROVAL.md"]) {
    assert.ok(at(plain).classes.includes("policy.core"), plain);
  }
  // A pattern that reaches the policy file takes the same class, beside its own.
  const REACHES = [
    "echo x > *.md",
    "echo x > A*",
    "echo x > APPROVAL.m?",
    "echo x > [A]PPROVAL.md",
    "echo x > ./*.md",
    "echo x >> $PWD/*.md",
    "sed -i s/a/b/ *.md",
    "touch *.md",
    "chmod +x *.md",
    "cp a.txt A*.md",
    "git add *.md",
    "prettier --write **/*.md",
    "x='*.md'; echo hi > $x",
    "x=*.md; sed -i s/a/b/ $x",
    "cd plain && echo x > ../*.md",
    "true && tee *.md < a.txt",
  ];
  for (const line of REACHES) {
    const seen = at(line);
    assert.ok(seen.ok, line);
    assert.ok(seen.classes.includes("policy.core"), `${line}: ${JSON.stringify(seen.segments)}`);
    assert.match(seen.notes, /write-resolved-landing: .* matches \d+ names? on the disk/u, line);
  }
  // Only ever beside: what the line had without the entry is what it has with it.
  for (const line of REACHES) {
    const seen = at(line);
    const elsewhere = see(line, WRITE_SCOPE_OFF, join(gated, "docs"));
    if (line.includes("..") || line.includes("$PWD") || line.startsWith("cd ") || line.startsWith("cp ")) continue;
    assert.deepEqual(
      seen.segments.filter(([cls]) => cls !== "policy.core"),
      elsewhere.segments.filter(([cls]) => cls !== "policy.core"),
      line,
    );
  }
  // The same pattern where it reaches no such file adds nothing.
  for (const line of ["echo x > plain/*.md", "sed -i s/a/b/ plain/*.md", "touch plain/*.md docs/*.md", "echo x > *.txt", "chmod +x docs/*.md"]) {
    assert.ok(!at(line).classes.includes("policy.core"), `${line}: ${JSON.stringify(at(line).segments)}`);
    assert.ok(!at(line).segments.some(([, rule]) => rule === "write-resolved-landing"), line);
  }
  for (const line of ["echo x > *.md", "sed -i s/a/b/ *.md", "touch *.md"]) {
    assert.ok(!see(line, WRITE_SCOPE_OFF, join(gated, "plain")).classes.includes("policy.core"), `${line} in plain/`);
  }
  // A quoted pattern is a name, not a listing; a quoted variable is not globbed.
  assert.ok(!at("touch '*.md'").classes.includes("policy.core"));
  assert.ok(!at('x=*.md; sed -i s/a/b/ "$x"').classes.includes("policy.core"));
  // A read stays a read: nothing is added for a line that writes nothing.
  for (const line of ["ls *.md", "cat *.md", "grep -l foo *", "wc -l **/*.md"]) {
    assert.deepEqual(at(line).segments.filter(([, rule]) => rule === "write-resolved-landing" || rule === "write-unreadable"), [], line);
  }
});

test("a pattern too wide to read is unreadable, for a delete too; a read is not listed; thousands of matches are read whole", () => {
  // Thousands of matches are read whole and move nothing by their number.
  const many = join(base, "many");
  mkdirSync(many, { recursive: true });
  for (let n = 0; n < 3000; n += 1) writeFileSync(join(many, `f${String(n).padStart(4, "0")}.md`), "", "utf8");
  for (const line of ["touch *.md", "chmod +x *.md", "sed -i s/a/b/ *.md", "rm *.md", "ls *.md"]) {
    const seen = see(line, WRITE_SCOPE_OFF, many);
    assert.ok(!seen.classes.includes(GUARDED), `${line}: ${JSON.stringify(seen.segments)}`);
    assert.ok(!seen.segments.some(([, rule]) => rule === "write-resolved-landing"), line);
  }
  // Among them, the policy file is still found.
  writeFileSync(join(many, "APPROVAL.md"), "x", "utf8");
  assert.ok(see("touch *.md", WRITE_SCOPE_OFF, many).classes.includes("policy.core"));
  assert.ok(see("rm *.md", WRITE_SCOPE_OFF, many).classes.includes("policy.core"));

  // More than a megabyte of names: 5,200 files with names of 210 bytes.
  const wide = join(base, "wide");
  mkdirSync(wide, { recursive: true });
  for (let n = 0; n < 5200; n += 1) writeFileSync(join(wide, `${"w".repeat(202)}${String(n).padStart(4, "0")}.md`), "", "utf8");
  const written = see("touch *.md", WRITE_SCOPE_OFF, wide);
  assert.ok(written.classes.includes(GUARDED), JSON.stringify(written.segments));
  assert.match(written.notes, /write-unreadable: \*\.md matches more names than this hook reads/u);
  const some = see("touch w*0001.md", WRITE_SCOPE_OFF, wide);
  assert.ok(!some.classes.includes(GUARDED), "one name is read");
  // A read is left as main has it. A delete is not: a bound that is passed is
  // never "nothing found", or padding a directory would hide the policy file.
  assert.deepEqual(see("ls *.md", WRITE_SCOPE_OFF, wide).segments, [["read.shell", "read-shell"]]);
  const removed = see("rm *.md", WRITE_SCOPE_OFF, wide);
  assert.ok(removed.classes.includes(GUARDED), JSON.stringify(removed.segments));
  assert.ok(removed.segments.some(([cls]) => cls.startsWith("files.delete")), "main's own class stays");
  // More names than the bound, short ones: 8,300 files.
  const crowd = join(base, "crowd");
  mkdirSync(crowd, { recursive: true });
  for (let n = 0; n < 8300; n += 1) writeFileSync(join(crowd, `c${String(n).padStart(4, "0")}.md`), "", "utf8");
  const crowded = see("chmod +x *.md", WRITE_SCOPE_OFF, crowd);
  assert.ok(crowded.classes.includes(GUARDED), JSON.stringify(crowded.segments));
  assert.match(crowded.notes, /matches more names than this hook reads/u);
  assert.ok(!see("chmod +x c0*.md", WRITE_SCOPE_OFF, crowd).classes.includes(GUARDED), "a thousand names are read");
  writeFileSync(join(crowd, "APPROVAL.md"), "x", "utf8");
  assert.ok(see("rm *.md", WRITE_SCOPE_OFF, crowd).classes.includes(GUARDED), "a delete among more names than are read: the policy file is not hidden");
  assert.deepEqual(see("ls *.md", WRITE_SCOPE_OFF, crowd).segments, [["read.shell", "read-shell"]]);
  // Many patterns in one segment: each is a listing, and they are bounded.
  const patterns = (count: number): string => Array.from({ length: count }, (_, n) => `f${String(n).padStart(4, "0")}.m?`).join(" ");
  const eighty = see(`touch ${patterns(80)}`, WRITE_SCOPE_OFF, many);
  assert.ok(eighty.classes.includes(GUARDED), JSON.stringify(eighty.segments.slice(0, 4)));
  assert.match(eighty.notes, /more patterns than this hook reads in one segment/u);
  assert.ok(!see(`touch ${patterns(60)}`, WRITE_SCOPE_OFF, many).classes.includes(GUARDED), "sixty patterns are read");
  assert.ok(see(`rm ${patterns(80)}`, WRITE_SCOPE_OFF, many).classes.includes(GUARDED), "a delete too");
});

test("resolved words are re-read once a segment, and many brace words all at once: linear, and nothing is lost", () => {
  // Past the first sixteen words with several spellings, the rest are re-read
  // in one line, each alternative a word of its own: the class is still found.
  // (`touch`, because main already answers `policy.core` for a `cp` with a variable.)
  const fillers = Array.from({ length: 20 }, (_, n) => `d$y/{a,b}f${String(n)}`).join(" ");
  const late = see(`y=; touch ${fillers} .appro{val,vax}$y/env`);
  assert.ok(late.classes.includes("policy.core"), JSON.stringify(late.segments));
  assert.ok(!late.classes.includes(GUARDED), `every word is read: ${late.notes.slice(0, 200)}`);
  const early = see("y=; touch .appro{val,vax}$y/env");
  assert.ok(early.classes.includes("policy.core"), JSON.stringify(early.segments));
  const control = see(`y=; touch ${fillers} .appro{vex,vax}$y/env`);
  assert.ok(!control.classes.includes("policy.core"), `the control: no alternative is the policy folder: ${JSON.stringify(control.segments)}`);
  // One line for every word read to one other spelling: a read of n home
  // paths costs n, not n squared (it was 3.6 CPU s at 6,400 words, 1.0 now).
  const cpu = (run: () => void): number => {
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1e6;
  };
  const read = (n: number): string => `cat ${Array.from({ length: n }, (_, i) => `~/f${String(i)}`).join(" ")}`;
  const least = (n: number): number => Math.min(cpu(() => see(read(n))), cpu(() => see(read(n))));
  see(read(200));
  const small = least(3_200);
  const large = least(12_800);
  // Four times the words: about four times the cost when linear, sixteen when square.
  assert.ok(large < small * 8 + 0.2, `3,200 words ${small.toFixed(2)} CPU s, 12,800 words ${large.toFixed(2)} CPU s`);
});

test("a glob over a directory that cannot be read is guarded", { skip: process.getuid?.() === 0 ? "root reads every directory" : false }, () => {
  const locked = join(ws, "locked");
  mkdirSync(join(locked, "inner"), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    // The second line is a read to the classifier (`sort`), so the pattern rule
    // leaves it alone and only the write word's own landing says so.
    for (const command of ["chmod +x locked/*/x", "sort -o locked/*/x a"]) {
      const seen = see(command);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
      assert.match(seen.notes, /could not be read from the disk/u, command);
    }
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("an empty spelling is no landing: a JSON body of `{}` in the home folder is not a tree written over the home", () => {
  // The brace reader also reads a word with its stray braces removed, so `{}`
  // came as nothing too, and nothing joined to the directory was the directory:
  // from `~`, the overlay's `curl ... -d '{}'` recipes were guarded (CI's
  // class-diff on the first push of this work).
  for (const command of [
    "curl -s -X POST -H \"Content-Type: application/json\" --url \"https://e.example/register/{event_id}\" -d '{}'",
    "curl -s -d '{}' https://e.example/x",
    "touch {}",
    "touch {,x}",
  ]) {
    const seen = see(command, WRITE_SCOPE_OFF, home);
    assert.equal(seen.ok, true, command);
    assert.equal(seen.classes.includes(GUARDED), false, `${command}: ${seen.notes}`);
  }
  // A word that does name the home folder, or a listed place in it, still is.
  for (const command of ["rsync -a src/ .", "touch {.zshrc,}", "curl -s -d '{}' -o .zshrc https://e.example/x"]) {
    const seen = see(command, WRITE_SCOPE_OFF, home);
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
});

test("a segment that reports several protected classes keeps them all, and a guarded landing beside it is still found", () => {
  // A segment that writes two protected paths reports each class as its own
  // entry over the same text (#690), so the classifier's list is longer than
  // the line's segments. This pass places its entries by position: none of
  // the classifier's may be lost to that, and none of its own.
  const routes = [
    { path: "design/", class: "policy.edit.design" },
    { path: ".github/workflows/", class: "policy.edit.ci" },
  ];
  const classesOf = (command: string): string[] => {
    const { result } = classifyForHook(command, routes, ws, [], false, [], false, WRITE_SCOPE_OFF);
    return result.ok ? result.classes : [`refused ${result.code}`];
  };
  const BOTH = ["policy.edit.design", "policy.edit.ci"];
  for (const [command, guarded] of [
    ["tee design/x .github/workflows/ci.yml", false],
    ["tee design/x .github/workflows/ci.yml; echo ok > out.txt", false],
    ["tee design/x .github/workflows/ci.yml; echo x > ~/.zshrc", true],
    ["echo x > ~/.zshrc; tee design/x .github/workflows/ci.yml", true],
    ["tee design/x .github/workflows/ci.yml ~/.zshrc", true],
    ["tee design/x .github/workflows/ci.yml > ~/.ssh/k", true],
    ["echo a > notes.txt; tee design/x .github/workflows/ci.yml; echo x > ~/.ssh/k; echo b > c.txt", true],
    ["tee {design/x,.github/workflows/ci.yml}; cp -r a.d ~/.ssh", true],
    ["echo x > design/a > .github/workflows/ci.yml; echo y > ~/.zshrc", true],
  ] as const) {
    const classes = classesOf(command);
    for (const cls of BOTH) assert.ok(classes.includes(cls), `${command}: ${classes.join(", ")}`);
    assert.equal(classes.includes(GUARDED), guarded, `${command}: ${classes.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// 5. The snapshot rule (codex, CLAIMS L61466)
// ---------------------------------------------------------------------------

test("a landing an earlier segment may change is not read from the disk", () => {
  for (const command of [
    "ln -s ~/.ssh ws2; echo x > ws2/authorized_keys",
    "mv a.d b.d && echo x > b.d/y",
    "rm -rf link-out && ln -s ~/.ssh link-out && echo x > link-out/k",
    "cp -R a.d b2.d && echo x > b2.d/y",
    "ln -s \"$T\" l; echo x > sub/y",
  ]) {
    const seen = see(command);
    assert.equal(seen.ok, true, command);
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    assert.match(seen.notes, /write-unreadable/u, command);
  }
  // A path the earlier segment did not touch is read as usual.
  assert.ok(!see("mv a.d b.d && echo x > sub/y").classes.includes(GUARDED));
  // A plain write or a mkdir cannot make a component a link: not counted
  // (SNAPSHOT_CHANGERS.write and .mkdir are off; see their note).
  for (const command of ["mkdir -p out && echo x > out/y", "echo a > f && echo b >> f", "touch t && chmod +x t"]) {
    assert.ok(!see(command).classes.includes(GUARDED), command);
  }
});

// ---------------------------------------------------------------------------
// 6. A policy that opts in
// ---------------------------------------------------------------------------

test("opted in: an out-of-scope write is files.write.out_of_scope, beside its own class", () => {
  const scope = optedIn();
  const redirect = see("echo x > ../sibling.txt", scope);
  assert.deepEqual(redirect.segments, [[WORKSPACE, "redirect-write"], [OUT, "write-out-of-scope"]]);
  assert.ok(see("echo x > link-out/y", scope).classes.includes(OUT));
  // `tee ../x` is a row main already tightens: it stays as main has it.
  assert.deepEqual(see("tee ../x", scope).segments, [[DELETE_OUT, "write-out-of-scope-resolved"]]);
  assert.ok(see("echo x | tee -a ../x", scope).classes.includes(DELETE_OUT));
  assert.ok(!see("echo x > notes.txt", scope).classes.includes(OUT));
  // The list still wins, and is still added beside.
  const listed = see("echo x > ~/.zshrc", scope);
  assert.ok(listed.classes.includes(GUARDED));
});

/**
 * Decision A is not built (coordinator, 23 Nov): under EVERY policy, opted in
 * or not, each segment main gave stays exactly as main gave it, and a row main
 * already tightens to `files.delete.*` takes no out-of-scope entry beside it.
 * These are the lines the old decision A lightened or was asked to keep: each
 * now passes trivially, and fails if A comes back.
 */
const NOT_LIGHTER_LINES = [
  "cp a ../sibling.txt",
  "cp a link-out/y",
  "tar -x -f a.tgz -C ../out",
  "cp a /etc/hosts",
  "rm ../x",
  "mv ../outside/a b",
  "mv a ../outside/b",
  "rmdir ../outside",
  "tar -c --remove-files -f x.tar ../outside/a",
  "tar -x -f a.tgz -C",
  "cp ../outside/a sub/",
  "cp a ../outside/a sub/",
  "ln -s a b ../outside/",
  "cp --target-directory=../outside a",
  "cp -t ../outside a",
  "tar -C ../outside -x -f a.tgz",
  "tar -x -f ../outside/a -C sub",
  "mv ~/x ./y",
  "rsync --remove-source-files ../outside/a b",
  "tar -xf a.tar -C ../out",
  "tar -xPf a.tar",
  "tar --rem -cf out.tar x",
  "TAR_OPTIONS=-P tar -xf a.tar",
  "npm pack --pack-destination ../x",
  "cp --unknown-flag a ../x",
  "cp --targ=../x a",
  "cp -s a ../x",
  "chmod -x ../x",
  "cp -- a ../x",
  "cp a ../x",
  "cp -Rp a ../x",
  "cp -t ../x a",
  "ln -sf a ../x",
  "touch ../x",
  "mkdir -p ../x",
  "chmod +x ../x",
  "truncate -s 0 ../x",
  "tee -a ../x",
];

test("no line gets lighter under any policy: every segment main gave stays, first and unchanged (decision A is not built)", () => {
  writeFileSync(join(outside, "a"), "a", "utf8");
  for (const scope of [WRITE_SCOPE_OFF, optedIn()]) {
    for (const command of NOT_LIGHTER_LINES) {
      const main = classifyForHook(command, [], ws, [], false, [], false, WRITE_SCOPE_OFF);
      const head = see(command, scope);
      if (!main.result.ok) {
        assert.equal(head.ok, false, command);
        continue;
      }
      const before = main.result.segments.filter((segment) => !["write-guarded", "write-unreadable", "write-out-of-scope", "write-resolved-landing"].includes(segment.rule));
      assert.deepEqual(head.segments.slice(0, before.length), before.map((segment) => [segment.class, segment.rule]), command);
      assert.ok(!head.segments.some(([, rule]) => rule === "write-out-of-scope-landed" || rule === "write-in-scope-resolved"), command);
      for (const cls of main.result.classes) assert.ok(head.classes.includes(cls), `${command}: lost ${cls}`);
    }
  }
});

test("opted in: a row main tightens to files.delete.out_of_scope stays exactly as main has it", () => {
  const scope = optedIn();
  assert.deepEqual(see("cp a ../sibling.txt", scope).segments, [[DELETE_OUT, "write-out-of-scope-resolved"]]);
  assert.deepEqual(see("cp a link-out/y", scope).segments, [[DELETE_OUT, "write-out-of-scope-resolved"]]);
  assert.deepEqual(see("tar -x -f a.tgz -C ../out", scope).segments, [[DELETE_OUT, "packaging-write-out-of-scope"]]);
  // The guarded minimum is still added beside a delete row (point 5).
  assert.ok(see("cp a /etc/hosts", scope).classes.includes(GUARDED));
  assert.ok(see("cp a ~/.zshrc", scope).classes.includes(GUARDED));
  // `cp a ../x` and `echo x > ../x` therefore still differ: a decision for the lead.
  assert.ok(!see("cp a ../x", scope).classes.includes(OUT));
  assert.ok(see("echo x > ../x", scope).classes.includes(OUT));
});

test("a variable spliced inside a guarded name is read where the line sets it, and guarded where it cannot be (review-b, CLAIMS L61530)", () => {
  const repo = join(base, "splice");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  const resolved: Array<[command: string, cls: string]> = [
    ["x=; echo x >> .appro${x}val/env", "policy.core"],
    ["x=; echo x >> A${x}PPROVAL.md", "policy.core"],
    ["x=; echo x >> .gi${x}t/config", "vcs.history.rewrite"],
    ["x=t; echo y >> .gi${x}/config", "vcs.history.rewrite"],
    ["x=t; echo y >> .gi$x/config", "vcs.history.rewrite"],
    ['x=; echo x >> ".appro${x}val/env"', "policy.core"],
    ["x=val; echo x >> .appro${x}/env", "policy.core"],
  ];
  const unreadable = [
    "echo x >> .appro${x:-}val/env",
    "echo x >> .appro${y}val/env",
    "x=a; x=; echo x >> .appro${x}val/env",
    "true && x=; echo x >> .appro${x}val/env",
    "x=t; echo x >> .gi$xt/config",
  ];
  for (const scope of [WRITE_SCOPE_OFF, optedIn()]) {
    for (const [command, cls] of resolved) {
      const seen = see(command, scope, repo);
      assert.ok(seen.classes.includes(cls), `${command}: ${JSON.stringify(seen.segments)}`);
    }
    for (const command of unreadable) {
      const seen = see(command, scope, repo);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    }
    // Every word, not only write targets, in the binary's own argv; and a
    // resolved word the hook cannot fully judge fails to guarded.
    // After `&&` the assignment is conditional, so the word is unreadable.
    assert.ok(see('cd "$D" && x=; echo y >> .appro${x}val/env', scope, repo).classes.includes(GUARDED));
    // Set plainly, then a cd the hook cannot follow: the plain spelling's
    // class AND guarded (the git-directory pass cannot run from an unknown
    // directory), never nothing.
    const unknownCd = see('x=; cd "$D" && echo y >> .appro${x}val/env', scope, repo);
    assert.ok(unknownCd.classes.includes(GUARDED) && unknownCd.classes.includes("policy.core"), JSON.stringify(unknownCd.segments));
    for (const [command, cls] of [
      ["x=; cp .appro${x}val/env out.txt", "account.credential"],
      ["x=; ln -s .appro${x}val/env l", "policy.core"],
      ["x=; cp -t .appro${x}val a", "policy.core"],
      ["x=; cat .appro${x}val/env", "account.credential"],
    ] as const) {
      const seen = see(command, scope, repo);
      assert.ok(seen.classes.includes(cls), `${command}: ${JSON.stringify(seen.segments)}`);
    }
    // `.gi$x/config` with x empty is `.gi/config`, which is no git directory.
    const plain = see("x=; echo x >> .gi$x/config", scope, repo);
    assert.ok(!plain.classes.includes("vcs.history.rewrite") && !plain.classes.includes(GUARDED), JSON.stringify(plain.segments));
  }
});

test("a resolved word's class is added and nothing main gave is dropped (review of bd1bddc6)", () => {
  const repo = join(base, "splice-a");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a"), "a", "utf8");
  for (const command of ["x=; cp .appro${x}val/env ../x/", "x=; y=; cp .appro${x}val/env A${y}PPROVAL.md ../x/"]) {
    const before = see(command, WRITE_SCOPE_OFF, repo);
    const after = see(command, optedIn(), repo);
    assert.deepEqual(withoutLandingEntries(after).slice(0, 1), withoutLandingEntries(before).slice(0, 1), command);
    assert.ok(after.classes.some((cls) => cls === "account.credential" || cls === "policy.core"), JSON.stringify(after.segments));
  }
});

// ---------------------------------------------------------------------------
// Which segment an entry belongs to (third review of 2b83468a, point 3)
// ---------------------------------------------------------------------------

test("an entry is tied to its segment by position, never by matching text", () => {
  // The same text twice, one of them made guarded by its own substitution:
  // one guarded entry, over the segment that holds the substitution.
  for (const command of ["echo x > a; echo x > a $(sort -o ~/.zshrc b)", "echo x > a $(sort -o ~/.zshrc b); echo x > a"]) {
    const seen = see(command);
    assert.equal(seen.segments.filter(([cls]) => cls === GUARDED).length, 1, `${command}: ${JSON.stringify(seen.segments)}`);
  }
  // The classifier refuses a substitution that writes; one it lets through
  // (`sort -o`) is judged, and a target spelled BY a substitution is unreadable.
  for (const [command, host] of [
    ["echo x > a; echo x > $(echo a)", "echo x > $(echo a)"],
    ["echo x > $(echo a); echo x > a", "echo x > $(echo a)"],
  ] as const) {
    const one = classifyForHook(command, [], ws, [], false, [], false, WRITE_SCOPE_OFF);
    assert.ok(one.result.ok, command);
    if (one.result.ok) assert.deepEqual(one.result.segments.filter((segment) => segment.class === GUARDED).map((segment) => segment.text), [host], command);
  }
  const refined = classifyForHook("echo x > a; echo x > a $(sort -o ~/.zshrc b)", [], ws, [], false, [], false, WRITE_SCOPE_OFF);
  assert.ok(refined.result.ok);
  if (refined.result.ok) {
    const guarded = refined.result.segments.filter((segment) => segment.class === GUARDED);
    assert.deepEqual(guarded.map((segment) => segment.text), ["echo x > a $(sort -o ~/.zshrc b)"]);
  }
  // Two identical segments, each its own: a guarded write repeated is one
  // guarded entry per segment, never folded into one by text.
  const twice = classifyForHook("echo x > ~/.zshrc; echo x > ~/.zshrc", [], ws, [], false, [], false, WRITE_SCOPE_OFF);
  assert.ok(twice.result.ok);
  if (twice.result.ok) assert.equal(twice.result.segments.filter((segment) => segment.class === GUARDED).length, 2);
  // A script that repeats a segment's text: the inner write is judged on its
  // own (guarded), the plain one outside stays as it was.
  const scripted = see("echo x > a; bash -c 'echo x > a; echo y > ~/.zshrc'");
  assert.equal(scripted.segments.filter(([cls]) => cls === GUARDED).length, 1, JSON.stringify(scripted.segments));
  const plain = see("echo x > a; bash -c 'echo x > a'");
  assert.ok(!plain.classes.includes(GUARDED), JSON.stringify(plain.segments));
});

// ---------------------------------------------------------------------------
// A pattern's listing is a snapshot too (third review of 2b83468a, point 2)
// ---------------------------------------------------------------------------

test("a glob over a prefix an earlier segment changed is unreadable, not judged by its listing", () => {
  mkdirSync(join(ws, "gl.d"), { recursive: true });
  writeFileSync(join(ws, "gl.d", "one.txt"), "", "utf8");
  for (const command of [
    "ln -s ~/.ssh gl2.d; echo x > gl2.d/*.pub",
    "mv gl.d gl3.d && echo x > gl3.d/*.txt",
    "rm -rf gl.d && ln -s ~ gl.d && echo x > gl.d/.zsh*",
    "ln -s ~/.ssh gl.d/inner; echo x > gl.d/*/authorized_keys",
    "ln -s ~/.ssh gl.d/inner; cp a gl.d/*/",
    "ln -s ~/.ssh gl.d/inner; cd gl.d/i* && echo x > authorized_keys",
  ]) {
    const seen = see(command);
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    assert.match(seen.notes, /write-unreadable/u, command);
  }
  // A changed path beside the pattern's prefix, not under it: read as usual.
  assert.ok(!see("mv a.d b.d && echo x > gl.d/*.txt").classes.includes(GUARDED));
  // The rule is the same named place: a cd it cannot follow is unknown too.
  assert.ok(see('cd "$D" && echo x > gl.d/*.txt').classes.includes(GUARDED));
});

// ---------------------------------------------------------------------------
// A tree written at a place that holds a guarded entry (re-read of the pass)
// ---------------------------------------------------------------------------

test("a tree written where a guarded entry can sit under it is guarded; one written beside is not", () => {
  mkdirSync(join(ws, "dotfiles"), { recursive: true });
  mkdirSync(join(ws, "Library"), { recursive: true });
  for (const command of [
    "cp -R dotfiles/ ~/",
    "cp -a dotfiles/. ~",
    "rsync -a dotfiles/ ~/",
    "cp -R Library ~/",
    "mv dotfiles ~/.config",
    "ln -sfn dotfiles ~/.config",
    "tar -xf a.tar -C ~",
    "tar -xPf a.tar",
    "tar --extract --absolute-names -f a.tar -C sub",
    "git clone https://example.invalid/r.git ~/.config",
    "cp -R dotfiles .git",
    "cp -R dotfiles .claude",
    "find . -name x -fprint ~/.zshrc",
    "npx prettier --write ~/.zshrc",
    "make -C ~/.ssh",
  ]) {
    for (const scope of [WRITE_SCOPE_OFF, optedIn()]) {
      const seen = see(command, scope);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    }
  }
  // A program main classes as a write may write any word it is handed: each
  // is a judged write, against the roots as well as the list.
  assert.ok(see("npx prettier --write ../x.md", optedIn()).classes.includes(OUT));
  for (const command of ["npx prettier --write src", "make build", "cp -R dotfiles ~/", "cp -R dotfiles out/", "mv a.d b.d", "rsync -a dotfiles/ dist/", "tar -xf a.tar -C sub", "tar -xf a.tar", "cp dotfiles/x ~/", "ln -s a.d l"]) {
    const seen = see(command);
    assert.ok(!seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
});

test("a tar extract is read through an allowlist of flags; anything else is unreadable (review of d3bd1c1b, point 1)", () => {
  for (const command of [
    "tar -x --abs -f a.tar",
    "tar -x --absolute-paths -f a.tar",
    "tar --insecure -xf a.tar",
    "TAR_OPTIONS=-P tar -xf a.tar",
    "tar -xf a.tar --weird",
    "tar -xPf a.tar",
    "tar xPf a.tar",
    "tar -x --extr -f a.tar",
    "tar -xf a.tar -s ,^,../,",
    "tar -xf",
  ]) {
    for (const scope of [WRITE_SCOPE_OFF, optedIn()]) {
      const seen = see(command, scope);
      if (!seen.ok) continue; // refused upstream: stricter still
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    }
  }
  for (const command of ["tar -xzvf a.tgz -C sub", "tar xzf a.tgz -C sub", "tar --extract --file=a.tar --directory sub", "tar -x -f a.tar -C sub --no-same-owner", "tar -xf a.tar"]) {
    assert.ok(!see(command).classes.includes(GUARDED), `${command}: ${JSON.stringify(see(command).segments)}`);
  }
  // Flags the environment adds are not on the line: unreadable.
  process.env["TAR_OPTIONS"] = "-P";
  try {
    assert.ok(see("tar -xf a.tar -C sub").classes.includes(GUARDED));
  } finally {
    delete process.env["TAR_OPTIONS"];
  }
  process.env["TAR_READER_OPTIONS"] = "x";
  try {
    assert.ok(see("tar -xf a.tar -C sub").classes.includes(GUARDED));
  } finally {
    delete process.env["TAR_READER_OPTIONS"];
  }
});

test("a tree written at a checkout, at home, or above a listed place is guarded; the snapshot rule counts every change under it (review of d3bd1c1b, points 2 and 3)", () => {
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  mkdirSync(join(ws, "repo2"), { recursive: true });
  writeFileSync(join(ws, "repo2", ".git"), "gitdir: /nowhere\n", "utf8");
  mkdirSync(join(ws, "dotfiles"), { recursive: true });
  for (const command of [
    "tar -xf a.tar -C repo",
    "tar -xf a.tar -C repo2",
    "cd repo && tar -xf a.tar",
    "cp -r dotfiles/. repo/",
    "cp -R dotfiles/ repo",
    "rsync -a dotfiles/ ~/",
    "npx prettier --write repo",
    "scp -r h:x/ ~/.config",
    "scp -r h:x ~/",
    "scp h:key ~/.ssh/",
    "git worktree add ~/.config",
    "mkdir -p nd/.git && tar -xf a.tar -C nd",
    "touch nd2/.git && cp -r dotfiles/. nd2",
    "ln -s repo nd3 && tar -xf a.tar -C nd3",
    // Rule A with the whole tree test for a program known to write trees.
    "rsync -a dotfiles/ repo/",
    "scp -r h:x repo",
    // A link laid UNDER the landing first: the copy's contents go through it.
    "ln -s ~/.ssh nd4/sub && cp -r dotfiles/. nd4",
  ]) {
    for (const scope of [WRITE_SCOPE_OFF, optedIn()]) {
      const seen = see(command, scope);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    }
  }
  for (const command of [
    "tar -xf a.tar -C newdir",
    "cp -r dotfiles repo/",
    "mkdir -p out && cp -r dotfiles/. out",
    "npx prettier --write sub",
    "scp -P 22 a h:/tmp",
  ]) {
    const seen = see(command);
    assert.ok(!seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
});

test("each give-up of the cwd and of a resolved word is guarded (mutant survivors of d3bd1c1b)", () => {
  // A cd the hook cannot follow: `cd -`, `popd`.
  for (const command of ["cd - && echo x > y", "popd && echo x > y", "pushd sub && popd && echo x > y"]) {
    const seen = see(command);
    if (!seen.ok) continue;
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  // A resolved word that is no write target, after a cd the hook cannot follow.
  assert.ok(see('x=; cd "$D" && cat .appro${x}val/env').classes.includes(GUARDED));
  // A word of the binary's own argv takes the class its plain spelling takes.
  assert.ok(see("x=; touch A${x}PPROVAL.md").classes.includes("policy.core"), JSON.stringify(see("x=; touch A${x}PPROVAL.md").segments));
  // A cd pattern over a prefix an earlier segment changed, matching nothing yet.
  mkdirSync(join(ws, "gl.d"), { recursive: true });
  assert.ok(see("ln -s ~/.ssh gl.d/new; cd gl.d/n* && echo x > authorized_keys").classes.includes(GUARDED));
});

test("one tar reader, no other option parser (review of 90b809fe)", () => {
  // B: two -C are unreadable (each moves the next); an exact long spelling and
  // the old bundled form are read by the same table.
  for (const command of ["tar -C a -C ../b -xf x.tar", "tar --directory=a -C b -xf x.tar", "tar -xf x.tar --exclude", "tar -xyf x.tar", "tar -f x.tar", "tar -xcf x.tar"]) {
    const seen = see(command);
    if (!seen.ok) continue;
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  for (const command of ["tar --extract --file=x.tar", "tar xf x.tar", "tar xzf x.tgz -C sub", "tar -czf out.tgz --exclude=node_modules src", "tar -tf x.tar", "tar --create --file out.tar -C sub ."]) {
    const seen = see(command);
    assert.ok(seen.ok && !seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  // The reader itself, called directly (main's classifier refuses a tar with
  // no mode before the hook sees it).
  assert.deepEqual(readTar(["-xzf", "a.tgz", "-C", "d"], [], {}), { mode: "extract", directory: "d" });
  assert.deepEqual(readTar(["xzfC", "a.tgz", "d"], [], {}), { mode: "extract", directory: "d" });
  assert.deepEqual(readTar(["--extract", "--file=a.tar", "--directory", "d"], [], {}), { mode: "extract", directory: "d" });
  assert.deepEqual(readTar(["-czf", "o.tgz", "--exclude=x", "src"], [], {}), { mode: "create", directory: null });
  assert.deepEqual(readTar(["-tvf", "a.tar"], [], {}), { mode: "list", directory: null });
  for (const [args, assignments, env] of [
    [["-f", "a.tar"], [], {}],
    [["-xcf", "a.tar"], [], {}],
    [["-xf", "a.tar", "-C", "a", "-C", "b"], [], {}],
    [["-xPf", "a.tar"], [], {}],
    [["-x", "--abs", "-f", "a.tar"], [], {}],
    [["-x", "--extrac", "-f", "a.tar"], [], {}],
    [["-xf", "a.tar"], ["TAR_OPTIONS=-P"], {}],
    [["-xf", "a.tar"], [], { TAR_OPTIONS: "-P" }],
    [["xPf", "a.tar"], [], {}],
    [["-xf"], [], {}],
  ] as const) {
    assert.ok("unreadable" in readTar(args, assignments, env), JSON.stringify(args));
  }
  // A: scp is not parsed; every word and every tail of a cluster is judged
  // against the list as a tree root.
  for (const command of ["scp -rP 22 a ~/.ssh/", "scp -r ~/.ssh host:b", "scp -i ~/.ssh/id_ed25519 a host:b", "rsync -a --log-file=~/.zshrc a b", "scp -o/etc/ssh_config a host:b"]) {
    const seen = see(command);
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  assert.ok(!see("scp -rP 22 a host:b").classes.includes(GUARDED));
  // A program main refuses stays refused: nothing is added to a refusal.
  assert.equal(see("unzip a.zip -d ~/Library/LaunchAgents").ok, false);
  // A read is not a write: its words are not judged.
  assert.ok(!see("cat ~/.zshrc").classes.includes(GUARDED));
  assert.ok(!see("ls ~").classes.includes(GUARDED));
});

test("checks the A/B/C change had dropped are back (review of 2b91ad45)", () => {
  // 1. A key=value operand's value: main refuses dd (the refusal stands), and
  // under rule A and rule C the value is judged.
  for (const command of ["dd if=a of=~/.ssh/authorized_keys", "dd if=a of=../x"]) assert.equal(see(command).ok, false, command);
  assert.ok(see("make DESTDIR=/usr/local/bin install").classes.includes(GUARDED));
  assert.ok(see("gh api repos/o/r -f path=~/.ssh/k").classes.includes(GUARDED));
  assert.ok(see("make OUT=../x", optedIn()).classes.includes(OUT));
  // 2. find's write primaries (main's own table) are judged writes.
  for (const command of ["find . -fprint ~/.zshrc", "find . -name x -fprint0 ~/.zshrc", "find . -fls ~/.ssh/k", "find . -fprintf ~/.zshrc %p"]) {
    assert.ok(see(command).classes.includes(GUARDED), command);
  }
  assert.ok(see("find . -name x -fprint ../out.txt", optedIn()).classes.includes(OUT));
  assert.ok(!see("find . -name x -fprint out.txt").classes.includes(GUARDED));
  // 3. A tree program under rule A keeps the checkout test (see the tree test).
  assert.ok(see("rsync -a dotfiles/ repo/").classes.includes(GUARDED));
  // 4. chown and chgrp with chmod: main refuses the first two (the refusal
  // stands); chmod's operands are judged writes.
  for (const command of ["chown me ~/.ssh/x", "chgrp g ~/.ssh/x"]) assert.equal(see(command).ok, false, command);
  assert.ok(see("chmod 600 ~/.ssh/config").classes.includes(GUARDED));
  // A program's word the hook cannot resolve is unreadable, as any write's is.
  assert.ok(see("node x.js $(cat f)").classes.includes(GUARDED));
});

test("rule A fails closed for a tree copier; find's writes are read whatever rule main gave (review of dbb980b7)", () => {
  for (const command of ['rsync -a src/ "$DEST"', 'scp -r a "$H":x "$LOCAL"', "install -D a $X/b", 'rsync -a "$SRC"/ out/']) {
    const seen = see(command);
    if (!seen.ok) continue; // refused upstream (install): stricter still
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  // A program that writes no tree: an unreadable word is not a target.
  assert.ok(!see('gh pr view "$N"').classes.includes(GUARDED));
  for (const command of ["find . -delete -fprint ~/.zshrc", "find . -name x -fls ~/.ssh/k -delete"]) {
    assert.ok(see(command).classes.includes(GUARDED), command);
  }
  // Main answers this line with its delete row (files.delete.out_of_scope):
  // a delete row takes no out-of-scope entry beside it (decision A is not
  // built), but its write primary is read, so a listed one is guarded.
  assert.deepEqual(see("find . -name x -fls ../out -delete", optedIn()).segments, [[DELETE_OUT, "find-delete"]]);
  // The main row stays exactly as main gave it.
  assert.equal(see("find . -name x -fls ../out -delete").segments[0]?.[1], "find-delete");
  // A guarded landing does not hide an out-of-scope one on the same segment.
  const both = see("echo x > ~/.zshrc 2> ../x", optedIn());
  assert.ok(both.classes.includes(GUARDED) && both.classes.includes(OUT), JSON.stringify(both.segments));
  // The fold strips what HFS+ ignores (U+200D here), in both name readings.
  assert.ok(see("echo x > ~/.s\u200Dsh/x").classes.includes(GUARDED));
  assert.ok(see("echo x > ~/.SSH/x").classes.includes(GUARDED));
  // A word after `--` is an operand.
  mkdirSync(join(home, ".ssh"), { recursive: true });
  assert.ok(see("cd ~/.ssh && touch -- -x").classes.includes(GUARDED));
});

test("what the pass cannot read at all fails to guarded, never to nothing", () => {
  // The classifier refuses these lines upstream; called on its own, the pass
  // still adds the guarded class rather than nothing.
  for (const command of ["bash -x -c 'echo x > ~/.zshrc'", 'echo "unterminated', "x $(a $(b $(c $(d $(e $(f > ~/.zshrc))))))"]) {
    const forged = { ok: true as const, segments: [{ text: command, class: WORKSPACE, rule: "redirect-write" }], classes: [WORKSPACE] };
    const refined = refineWriteLandings(forged, command, [ws], WRITE_SCOPE_OFF);
    assert.ok(refined.result.ok && refined.result.classes.includes(GUARDED), `${command}: ${JSON.stringify(refined.result)}`);
    if (refined.result.ok) assert.deepEqual(refined.result.segments[0], forged.segments[0], command);
  }
});

test("opted in: write_scope.roots widens and never narrows", () => {
  const scope = optedIn([outside]);
  assert.ok(!see("echo x > link-out/y", scope).classes.includes(OUT));
  assert.ok(!see("echo x > ../outside/y", scope).classes.includes(OUT));
  assert.ok(see("echo x > ../sibling.txt", scope).classes.includes(OUT));
  // A root never lifts the list.
  const listed = optedIn([home]);
  assert.ok(see("echo x > ~/.zshrc", listed).classes.includes(GUARDED));
});

// ---------------------------------------------------------------------------
// 7. The file tools and the window, through the compiled CLI
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = "", env: Record<string, string | undefined> = {}): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  // Set or deleted explicitly in every spawned hook's environment (S2).
  delete childEnv["CLAUDE_CONFIG_DIR"];
  delete childEnv["CLAUDE_PROJECT_DIR"];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env: childEnv, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

let gates = 0;
function gate(classes: string[], defaults = "autonomous"): string {
  gates += 1;
  const dir = join(base, `gate-${gates}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "defaults:", `  autonomy: ${defaults}`, '  approval_ttl: "1h"', "  on_expiry: reject", "classes:", "  policy.core: { autonomy: manual }", ...classes, "```", ""].join("\n"),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function verdict(run: Run): { permission: string; reason: string } {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const out = (JSON.parse(run.stdout) as Record<string, Record<string, unknown>>)["hookSpecificOutput"] ?? {};
  return { permission: String(out["permissionDecision"]), reason: String(out["permissionDecisionReason"]) };
}

let uses = 0;
function event(tool: string, input: Record<string, unknown>): string {
  uses += 1;
  return JSON.stringify({ session_id: "ws-1", cwd: "/somewhere/else", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `tu-${String(uses)}` });
}

const FILE_TOOLS: Array<[tool: string, input: (path: string) => Record<string, unknown>]> = [
  ["Write", (path) => ({ file_path: path, content: "x" })],
  ["Edit", (path) => ({ file_path: path, old_string: "a", new_string: "b" })],
  ["NotebookEdit", (path) => ({ notebook_path: path, new_source: "x" })],
];

test("file tools: a listed target is files.write.guarded under a policy that does not name it", () => {
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  for (const [tool, input] of FILE_TOOLS) {
    for (const path of [join(home, ".zshrc"), join(home, ".ssh", "authorized_keys"), "/etc/hosts"]) {
      const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path))));
      assert.equal(seen.permission, "deny", `${tool} ${path}`);
      assert.match(seen.reason, /files\.write\.guarded resolves to human-only/u, `${tool} ${path}`);
    }
    const inside = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(join(dir, "notes.txt")))));
    assert.equal(inside.permission, "allow", `${tool} in the workspace: ${inside.reason}`);
  }
});

test("file tools: no wildcard or default lifts the guarded minimum", () => {
  const dir = gate(["  files.*: { autonomy: autonomous, allow_irreversible: true }", '  "*.*": { autonomy: autonomous }']);
  const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "200ms"], dir, event("Write", { file_path: join(home, ".zshrc"), content: "x" }));
  const seen = verdict(run);
  // Manual: a request is opened and, with nobody to answer it, times out.
  assert.equal(seen.permission, "deny", seen.reason);
  assert.match(seen.reason, /hook-timeout|timed out|no decision/u, seen.reason);
  const inside = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Write", { file_path: join(dir, "x.txt"), content: "x" })));
  assert.equal(inside.permission, "allow");
});

test("file tools: out of scope only when the policy opts in", () => {
  const old = gate(["  files.write.workspace: { autonomy: autonomous }"]);
  const sibling = join(base, "sibling.txt");
  assert.equal(verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], old, event("Write", { file_path: sibling, content: "x" }))).permission, "allow");
  const opted = gate(["  files.write.workspace: { autonomy: autonomous }", `  ${OUT}: { autonomy: human-only }`]);
  const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], opted, event("Write", { file_path: sibling, content: "x" })));
  assert.equal(seen.permission, "deny");
  assert.match(seen.reason, /files\.write\.out_of_scope resolves to human-only/u);
  assert.equal(verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], opted, event("Write", { file_path: join(opted, "in.txt"), content: "x" }))).permission, "allow");
});

test("the open window treats files.write.guarded as a manual class: decision E", () => {
  const dir = gate(["  files.write.workspace: { autonomy: autonomous }"], "manual");
  const answers = ["understood"];
  const prompter: Prompter = {
    readLine: () => answers.shift() ?? null,
    readSecret: (): SecretRead => {
      throw new Error("no secret is asked");
    },
    confirm: () => {
      throw new Error("no confirmation is asked");
    },
  } as unknown as Prompter;
  const sink: Streams = { out: () => undefined, err: () => undefined };
  assert.equal(commandGate(["open", "--for", "5m", "--reason", "test", "--as", "human:alice"], sink, dir, { prompter }), 0);
  const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Write", { file_path: join(home, ".zshrc"), content: "x" })));
  assert.equal(seen.permission, "allow", seen.reason);
  assert.match(seen.reason, /files\.write\.guarded/u);
  const log = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  assert.match(log, /gate\.bypassed/u);
  assert.ok(existsSync(join(dir, ".approval")));
});

// ---------------------------------------------------------------------------
// S2, part 1: Claude Code's config folders (lead, CLAIMS L62289)
// ---------------------------------------------------------------------------

/** Run `body` with CLAUDE_CONFIG_DIR set (or deleted, for `undefined`) in this process, then put it back. */
function withConfigDir<T>(value: string | undefined, body: () => T): T {
  const before = process.env["CLAUDE_CONFIG_DIR"];
  if (value === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = before;
  }
}

const ccReal = join(base, "cc-real");
const ccLink = join(base, "cc-link");
mkdirSync(join(ccReal, "hooks"), { recursive: true });
mkdirSync(join(home, ".claude-x", "hooks"), { recursive: true });
mkdirSync(join(home, ".claude", "plugins", "cache", "p", "hooks"), { recursive: true });
symlinkSync(ccReal, ccLink);

test("S2.1 Bash: a config folder's settings, hooks, plugin hooks and .claude.json are guarded; its memory, plans and notes are not", () => {
  withConfigDir(undefined, () => {
    for (const command of [
      "echo x > ~/.claude-x/hooks/h.sh",
      "echo x > ~/.Claude-X/Hooks/h.sh",
      "tee ~/.claude/plugins/cache/p/hooks/hooks.json < a",
      "echo x > ~/.claude-x/plugins/p/1.0/hooks/run.sh",
      "echo x > ~/.claude.json",
      "echo x > ~/.CLAUDE.json",
      "cp a ~/.claude-x/.claude.json",
      "echo x > ~/.claude/.claude.json",
      "echo x > ~/.claude-x/remote-settings.json",
      "cp -r a ~/.claude-x/plugins/new",
      "echo x > ~/.claude-x/plugins/p/index.js",
      "echo '{}' > ~/.claude/plugins/installed_plugins.json",
      "echo x > ~/.Claude-X/Plugins/p/.mcp.json",
    ]) {
      const seen = see(command);
      assert.equal(seen.ok, true, command);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    }
    // Settings are policy.core already (the pure classifier), and guarded beside it.
    const settings = see("echo '{}' > ~/.claude-x/settings.json");
    assert.ok(settings.classes.includes("policy.core"), JSON.stringify(settings.segments));
    assert.ok(settings.classes.includes(GUARDED), JSON.stringify(settings.segments));
    for (const command of [
      "echo x > ~/.claude-x/notes.md",
      "echo x > ~/.clauderc",
      "echo x > ~/.claude-/settings.json",
      "echo x > ~/.claude-/hooks/h.sh",
      "echo x > ~/.claude-x/pluginsx/a",
      "echo x > ~/.claude-x/projects/plugins/a",
      "echo x > ~/.claude.json.bak",
    ]) {
      const seen = see(command);
      assert.equal(seen.ok, true, command);
      assert.ok(!seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
      assert.ok(!seen.classes.includes("policy.core"), `${command}: ${JSON.stringify(seen.segments)}`);
    }
    // Claude Code's own memory, plan and transcript files keep the class they had.
    for (const command of ["echo x > ~/.claude-x/projects/p/memory/m.md", "echo x > ~/.claude/plans/a.md", "echo x >> ~/.claude-x/projects/p/s.jsonl"]) {
      assert.deepEqual(see(command).segments, [[WORKSPACE, "redirect-write"]], command);
    }
  });
});

test("S2.1 Bash: the folder CLAUDE_CONFIG_DIR names is guarded only when the variable is set, absolute, and as given and resolved", () => {
  const lines = (dir: string): string[] => [
    `echo '{}' > ${dir}/settings.json`,
    `echo x > ${dir}/Settings.local.json`,
    `echo x > ${dir}/remote-settings.json`,
    `echo x > ${dir}/.claude.json`,
    `echo x > ${dir}/hooks/h.sh`,
    `echo x > ${dir}/plugins/p/hooks/h.sh`,
    `echo x > ${dir}/plugins/p/x.js`,
  ];
  const controls = (dir: string): string[] => [`echo x > ${dir}/notes.md`, `echo x > ${dir}/projects/p/memory/m.md`, `echo x > ${dir}x/settings.json`, `echo x > ${dir}/pluginsx/a`, `echo x > ${dir}/projects/plugins/a`];
  withConfigDir(ccReal, () => {
    for (const command of lines(ccReal)) {
      const seen = see(command);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
      assert.match(seen.notes, /a Claude Code (config|hooks|plugins) folder/u, command);
    }
    // Not policy.core: the pure classifier cannot see the variable; guarded is the answer.
    assert.ok(!see(`echo x > ${ccReal}/settings.json`).classes.includes("policy.core"));
    for (const command of controls(ccReal)) assert.ok(!see(command).classes.includes(GUARDED), command);
  });
  // Pointing at a symlink: the folder as given and as resolved.
  withConfigDir(ccLink, () => {
    for (const command of [...lines(ccLink), ...lines(ccReal)]) assert.ok(see(command).classes.includes(GUARDED), command);
    for (const command of controls(ccReal)) assert.ok(!see(command).classes.includes(GUARDED), command);
  });
  // Unset or empty: no folder.
  for (const value of [undefined, ""]) {
    withConfigDir(value, () => {
      for (const command of lines(ccReal)) {
        if (command.includes("/hooks/") || command.includes("/plugins/")) continue;
        assert.ok(!see(command, WRITE_SCOPE_OFF, base).classes.includes(GUARDED), `${String(value)}: ${command}`);
      }
    });
  }
});

/** Run `body` with this process's cwd at `dir`, then put it back. */
function withCwd<T>(dir: string, body: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return body();
  } finally {
    process.chdir(before);
  }
}

test("S2.1 Bash: a relative CLAUDE_CONFIG_DIR is the hook's cwd joined to it, .. collapsed, as given and through realpath; ~ is not expanded", () => {
  mkdirSync(join(base, "rel-sub"), { recursive: true });
  mkdirSync(join(base, "~", "x"), { recursive: true });
  withCwd(base, () => {
    for (const [value, folders] of [
      ["cc-real", [ccReal]],
      ["./cc-real", [ccReal]],
      ["rel-sub/../cc-real", [ccReal]],
      ["cc-link", [ccLink, ccReal]],
      ["~/x", [join(base, "~", "x")]],
      [`${base}/rel-sub/../cc-real`, [ccReal]],
    ] as const) {
      withConfigDir(value, () => {
        for (const folder of folders) {
          for (const command of [`echo '{}' > ${folder}/settings.json`, `echo x > ${folder}/hooks/h.sh`]) {
            assert.ok(see(command, WRITE_SCOPE_OFF, base).classes.includes(GUARDED), `${value}: ${command}`);
          }
          assert.ok(!see(`echo x > ${folder}/notes.md`, WRITE_SCOPE_OFF, base).classes.includes(GUARDED), `${value}: notes`);
        }
      });
    }
    // `~/x` is never the home's x.
    withConfigDir("~/x", () => {
      assert.ok(!see(`echo '{}' > ${home}/x/settings.json`, WRITE_SCOPE_OFF, base).classes.includes(GUARDED));
    });
  });
});

test("S2.1 through the real hook: Bash and the file tools onto a config folder are denied; a note beside them is allowed", () => {
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  const env = { CLAUDE_CONFIG_DIR: ccLink };
  const deny = (run: Run, label: string): void => {
    const seen = verdict(run);
    assert.equal(seen.permission, "deny", `${label}: ${seen.reason}`);
    assert.match(seen.reason, /files\.write\.guarded resolves to human-only/u, label);
  };
  for (const command of ["echo x > ~/.claude-x/hooks/h.sh", "echo x > ~/.claude.json", `echo x > ${ccReal}/settings.json`, `echo x > ${ccLink}/hooks/h.sh`]) {
    deny(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Bash", { command }), env), command);
  }
  for (const [tool, input] of FILE_TOOLS) {
    for (const path of [join(home, ".claude-x", "settings.json"), join(home, ".claude-x", "hooks", "h.sh"), join(home, ".claude.json"), join(ccReal, "settings.json"), join(ccLink, ".claude.json")]) {
      deny(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path)), env), `${tool} ${path}`);
    }
    for (const path of [join(home, ".claude-x", "notes.md"), join(home, ".claude-x", "projects", "p", "memory", "m.md"), join(ccReal, "notes.md")]) {
      const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path)), env));
      assert.equal(seen.permission, "allow", `${tool} ${path}: ${seen.reason}`);
    }
  }
  // A relative value, read from the hook's own cwd (the gate here).
  mkdirSync(join(dir, "rel-cc"), { recursive: true });
  deny(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Write", { file_path: join(dir, "rel-cc", "settings.json"), content: "x" }), { CLAUDE_CONFIG_DIR: "rel-cc" }), "relative Write");
  deny(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Bash", { command: "echo x > rel-cc/hooks/h.sh" }), { CLAUDE_CONFIG_DIR: "./sub/../rel-cc" }), "relative Bash");
  // The variable unset in the hook: the folder it named is an ordinary place.
  const unset = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Write", { file_path: join(ccReal, "settings.json"), content: "x" }), { CLAUDE_CONFIG_DIR: undefined }));
  assert.equal(unset.permission, "allow", unset.reason);
});

// ---------------------------------------------------------------------------
// S2, part 2: the hook scripts the live settings name (lead, CLAIMS L62289)
// ---------------------------------------------------------------------------

/** Run `body` with HOME (and CLAUDE_CONFIG_DIR) set in this process, then put both back. */
function withHome<T>(value: string, configDir: string | undefined, body: () => T): T {
  const before = process.env["HOME"];
  process.env["HOME"] = value;
  try {
    return withConfigDir(configDir, body);
  } finally {
    process.env["HOME"] = before;
  }
}

let s2Homes = 0;
/** A fresh fixture home (the settings are read once per process for each set of folders). */
function freshHome(settings: Record<string, string> = {}): string {
  s2Homes += 1;
  const dir = join(base, `s2-home-${String(s2Homes)}`);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  for (const [name, text] of Object.entries(settings)) writeFileSync(join(dir, ".claude", name), text, "utf8");
  return dir;
}

/** Settings fixture text: one hook per event shape, a status line, and a helper. Fixture only: no real settings are read. */
const S2_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: "Bash|Write", hooks: [{ type: "command", command: "python3 ~/tools/hooks/guard.py --flag 2>/dev/null" }] }],
    Stop: [
      {
        hooks: [
          { type: "command", command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh' },
          { type: "command", command: "/opt/s2-abs/run.sh && $HOME/bin2/after.sh; ${HOME}/b3/c.sh | tee -a /tmp/s2-hook.log" },
        ],
      },
    ],
  },
  statusLine: { type: "command", command: "~/.config/iterm2/cc-status" },
  apiKeyHelper: "~/keys/helper.sh",
  permissions: { allow: ["Bash(~/not-a-hook/x.sh)"] },
});

test("S2.2 Bash: a file the settings name as a hook command is guarded, exactly, through the fold; the folder beside it is not", () => {
  const h = freshHome({ "settings.json": S2_SETTINGS });
  mkdirSync(join(h, "tools", "hooks"), { recursive: true });
  writeFileSync(join(h, "tools", "hooks", "guard.py"), "# hook\n", "utf8");
  symlinkSync(join(h, "tools", "hooks", "guard.py"), join(ws, "s2-hooklink"));
  withHome(h, undefined, () => {
    for (const command of [
      "echo x >> ~/tools/hooks/guard.py",
      "sed -i '' s/a/b/ ~/tools/hooks/guard.py",
      "echo x > ~/TOOLS/Hooks/GUARD.py",
      `echo x > ${h}/tools/hooks/../hooks/guard.py`,
      "echo x > s2-hooklink",
      "cp a ~/tools/hooks/guard.py",
      "echo x > ~/bin2/after.sh",
      "echo x > ~/b3/c.sh",
      "echo x > /opt/s2-abs/run.sh",
      "echo x > ~/.config/iterm2/cc-status",
      "echo x > ~/keys/helper.sh",
    ]) {
      const seen = see(command);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
      assert.match(seen.notes, /a hook script the settings name/u, command);
    }
    for (const command of [
      "echo x > ~/tools/hooks/other.py",
      "echo x > ~/tools/hooks/guard.py.bak",
      "echo x > ~/tools/guard.py",
      "tee /dev/null < a",
      "echo x > ~/not-a-hook/x.sh",
      "echo x > ~/tools/hooks/guard.py/x",
    ]) {
      const seen = see(command);
      assert.ok(!seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
    }
  });
});

test("S2.2: the variable's folder and the gate root's .claude are read too; $CLAUDE_PROJECT_DIR is the gate root", () => {
  const h = freshHome();
  const cc = join(base, `s2-cc-${String(s2Homes)}`);
  mkdirSync(cc, { recursive: true });
  writeFileSync(join(cc, "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/lane/x.sh" }] }] } }), "utf8");
  const project = join(base, `s2-project-${String(s2Homes)}`);
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/scripts/hook.sh" }] }] } }), "utf8");
  const scope: WriteScopeContext = { ...WRITE_SCOPE_OFF, gateRoot: project };
  withHome(h, cc, () => {
    assert.ok(see("echo x > ~/lane/x.sh", scope).classes.includes(GUARDED));
    assert.ok(see(`echo x > ${project}/scripts/hook.sh`, scope).classes.includes(GUARDED));
    assert.ok(!see(`echo x > ${project}/scripts/other.sh`, scope).classes.includes(GUARDED));
  });
  // The same lines with the variable unset and no gate root: neither file is named.
  withHome(h, undefined, () => {
    assert.ok(!see("echo x > ~/lane/x.sh").classes.includes(GUARDED));
    assert.ok(!see(`echo x > ${project}/scripts/hook.sh`).classes.includes(GUARDED));
  });
  // resolveWriteScope carries the gate root whatever the opt-in.
  assert.equal(resolveWriteScope(project, project, { version: "0.1" }).gateRoot, project);
});

test("S2.2: a settings file over 1 MiB, one that does not parse, and a FIFO are skipped, not errors", () => {
  const big = freshHome({ "settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "~/big/x.sh" }] }] }, pad: "x".repeat(HOOK_SETTINGS_MAX_BYTES) }) });
  withHome(big, undefined, () => {
    const seen = see("echo x > ~/big/x.sh");
    assert.equal(seen.ok, true);
    assert.ok(!seen.classes.includes(GUARDED), seen.notes);
  });
  const broken = freshHome({ "settings.json": '{"hooks": {"Stop": [{"hooks": [{"command": "~/broken/x.sh"}]}]}', "settings.local.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "~/fine/x.sh" }] }] } }) });
  withHome(broken, undefined, () => {
    assert.ok(!see("echo x > ~/broken/x.sh").classes.includes(GUARDED));
    // The other settings file in the folder is still read.
    assert.ok(see("echo x > ~/fine/x.sh").classes.includes(GUARDED));
  });
  const fifo = freshHome();
  const made = spawnSync("/usr/bin/mkfifo", [join(fifo, ".claude", "settings.json")]);
  if (made.status === 0) {
    withHome(fifo, undefined, () => {
      const started = Date.now();
      assert.ok(!see("echo x > ~/fifo/x.sh").classes.includes(GUARDED));
      assert.ok(Date.now() - started < 10_000, "a FIFO is never waited on");
    });
  }
});

test("S2.2: the settings are read lazily, only for a landing not guarded already, and once per process", () => {
  const h = freshHome({ "settings.json": S2_SETTINGS });
  withHome(h, undefined, () => {
    const start = hookSettingsReads.count;
    see("ls -la");
    see("echo x > ~/.zshrc");
    assert.equal(hookSettingsReads.count, start, "no landing judged, or one guarded already: nothing read");
    see("echo x > notes.txt");
    const once = hookSettingsReads.count;
    assert.ok(once > start, "a landing not guarded reads the settings");
    see("echo x > other.txt");
    see("echo x > ~/tools/hooks/guard.py");
    assert.equal(hookSettingsReads.count, once, "read at most once per process");
  });
});

test("S2.2 through the real hook: Bash and the file tools onto a named hook script are denied; a script beside it is allowed", () => {
  const h = freshHome({ "settings.json": S2_SETTINGS });
  mkdirSync(join(h, "tools", "hooks"), { recursive: true });
  writeFileSync(join(h, "tools", "hooks", "guard.py"), "# hook\n", "utf8");
  writeFileSync(join(h, "tools", "hooks", "other.py"), "# other\n", "utf8");
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/scripts/stop.sh" }] }] } }), "utf8");
  const env = { HOME: h, CLAUDE_CONFIG_DIR: undefined };
  const run = (tool: string, input: Record<string, unknown>): { permission: string; reason: string } =>
    verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input), env));
  for (const command of ["echo x >> ~/tools/hooks/guard.py", `echo x > ${join(dir, "scripts", "stop.sh")}`]) {
    const seen = run("Bash", { command });
    assert.equal(seen.permission, "deny", `${command}: ${seen.reason}`);
    assert.match(seen.reason, /files\.write\.guarded resolves to human-only/u, command);
  }
  for (const [tool, input] of FILE_TOOLS) {
    for (const path of [join(h, "tools", "hooks", "guard.py"), join(dir, "scripts", "stop.sh")]) {
      const seen = run(tool, input(path));
      assert.equal(seen.permission, "deny", `${tool} ${path}: ${seen.reason}`);
    }
    const beside = run(tool, input(join(h, "tools", "hooks", "other.py")));
    assert.equal(beside.permission, "allow", `${tool} beside: ${beside.reason}`);
  }
  assert.equal(run("Bash", { command: "echo x > ~/tools/hooks/other.py" }).permission, "allow");
});

// ---------------------------------------------------------------------------
// S2, part 2 fold: ancestors, the project folders, relative words (seat
// ruling on the review of e2a76e15)
// ---------------------------------------------------------------------------

/** Run `body` with CLAUDE_PROJECT_DIR set (or deleted) in this process, then put it back. */
function withProjectDir<T>(value: string | undefined, body: () => T): T {
  const before = process.env["CLAUDE_PROJECT_DIR"];
  if (value === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
  else process.env["CLAUDE_PROJECT_DIR"] = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
    else process.env["CLAUDE_PROJECT_DIR"] = before;
  }
}

test("S2.2 fold: removing or moving a named hook script's folder or a grandparent is guarded; a sibling folder is not", () => {
  const h = freshHome({ "settings.json": S2_SETTINGS });
  mkdirSync(join(h, "tools", "hooks"), { recursive: true });
  mkdirSync(join(h, "tools", "hooks2"), { recursive: true });
  writeFileSync(join(h, "tools", "hooks", "guard.py"), "# hook\n", "utf8");
  mkdirSync(join(ws, "s2-src"), { recursive: true });
  withHome(h, undefined, () => {
    for (const command of [
      "rm -rf ~/tools/hooks",
      "rm -rf ~/tools",
      "rm ~/tools/hooks/guard.py",
      "rm -rf ~/TOOLS/Hooks",
      "mv ~/tools/hooks ~/old-hooks",
      "mv ~/tools ~/old-tools",
      "mv a ~/tools/hooks/guard.py",
      "cp -r s2-src/. ~/tools/hooks",
      "rm -rf ~/tools/*",
    ]) {
      const seen = see(command);
      assert.equal(seen.ok, true, command);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
      assert.match(seen.notes, /a hook script the settings name/u, command);
    }
    // `~/tools/hook` and `~/tools/hoo` are string prefixes of the script's folder, not folders above it.
    for (const command of ["rm -rf ~/tools/hooks2", "mv ~/tools/hooks2 ~/old2", "rm -rf ~/other", "cp -r s2-src/. ~/tools/hooks2", "rm -rf ~/tools/hooks/guard.py.bak", "rm -rf ~/tools/hook", "mv ~/tools/hoo ~/old3", "cp -r s2-src/. ~/tools/hook"]) {
      const seen = see(command);
      assert.ok(!seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
    }
  });
});

test("S2.2 fold: CLAUDE_PROJECT_DIR is a project folder beside the gate root; $CLAUDE_PROJECT_DIR and relative words are read against both", () => {
  const h = freshHome();
  const project = join(base, `s2-cpd-${String(s2Homes)}`);
  const gateRoot = join(base, `s2-gate-${String(s2Homes)}`);
  for (const dir of [project, gateRoot]) mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash $CLAUDE_PROJECT_DIR/hooks/p.sh && python3 ./scripts/rel.py --flag; node tools/x.mjs $FOO/bar/y.sh a=b/c.sh" }] }] } }),
    "utf8",
  );
  writeFileSync(join(gateRoot, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/g.sh" }] }] } }), "utf8");
  const scope: WriteScopeContext = { ...WRITE_SCOPE_OFF, gateRoot };
  withHome(h, undefined, () => {
    withProjectDir(project, () => {
      for (const dir of [project, gateRoot]) {
        for (const file of ["hooks/p.sh", "scripts/rel.py", "tools/x.mjs", "g.sh"]) {
          const seen = see(`echo x > ${dir}/${file}`, scope);
          assert.ok(seen.classes.includes(GUARDED), `${dir}/${file}: ${JSON.stringify(seen.segments)}`);
        }
        // Controls: a word without a slash names nothing; a word reading another variable is skipped.
        for (const file of ["python3", "--flag", "bar/y.sh", "c.sh", "a=b/c.sh", "hooks/other.sh"]) {
          assert.ok(!see(`echo x > ${dir}/${file}`, scope).classes.includes(GUARDED), `${dir}/${file}`);
        }
      }
    });
    // The variable unset: only the gate root's settings, read against the gate root.
    withProjectDir(undefined, () => {
      assert.ok(see(`echo x > ${gateRoot}/g.sh`, scope).classes.includes(GUARDED));
      assert.ok(!see(`echo x > ${project}/hooks/p.sh`, scope).classes.includes(GUARDED));
      assert.ok(!see(`echo x > ${project}/g.sh`, scope).classes.includes(GUARDED));
    });
    // Relative: not a project folder.
    withProjectDir("s2-relative", () => {
      assert.ok(!see(`echo x > ${join(base, "s2-relative", "g.sh")}`, scope).classes.includes(GUARDED));
    });
  });
});

test("S2.2 fold through the real hook: CLAUDE_PROJECT_DIR's settings, a relative word, and an rm -rf above a script", () => {
  const h = freshHome();
  const project = join(base, `s2-cpd-cli-${String(s2Homes)}`);
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./scripts/stop.sh" }] }] } }), "utf8");
  writeFileSync(join(project, "scripts", "stop.sh"), "#!/bin/sh\n", "utf8");
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  const run = (tool: string, input: Record<string, unknown>, projectDir: string | undefined): { permission: string; reason: string } =>
    verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input), { HOME: h, CLAUDE_CONFIG_DIR: undefined, CLAUDE_PROJECT_DIR: projectDir }));
  for (const [tool, input] of FILE_TOOLS) {
    assert.equal(run(tool, input(join(project, "scripts", "stop.sh")), project).permission, "deny", tool);
    assert.equal(run(tool, input(join(project, "scripts", "other.sh")), project).permission, "allow", tool);
    assert.equal(run(tool, input(join(project, "scripts", "stop.sh")), undefined).permission, "allow", `${tool} without the variable`);
  }
  assert.equal(run("Bash", { command: `rm -rf ${join(project, "scripts")}` }, project).permission, "deny");
  assert.equal(run("Bash", { command: `mv ${project} ${project}-old` }, project).permission, "deny");
});

// ---------------------------------------------------------------------------
// S2, part 3: the list gaps (lead, N3)
// ---------------------------------------------------------------------------

test("S2.3 Bash: npm's config, login files, user services, shims, cargo's bin and .git/config are guarded; main's own class stays", () => {
  const repo = join(base, "s2-repo");
  mkdirSync(join(repo, ".git", "worktrees", "lane"), { recursive: true });
  mkdirSync(join(repo, ".gitx"), { recursive: true });
  for (const command of [
    "echo '//registry/:_authToken=x' >> ~/.npmrc",
    "echo x > ~/.NPMRC",
    "echo x >> ~/.zlogout",
    "echo x >> ~/.bash_login",
    "echo x >> ~/.bash_logout",
    "cp a ~/.config/systemd/user/x.service",
    "echo x > ~/.pyenv/shims/python",
    "cp a ~/.cargo/bin/rg",
    "echo x > .git/config",
    "echo x >> .git/config.worktree",
    "echo x > .GIT/Config",
    "echo x > .git/worktrees/lane/config.worktree",
  ]) {
    const seen = see(command, WRITE_SCOPE_OFF, repo);
    assert.equal(seen.ok, true, command);
    assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
  // Main's git-dir pass answers vcs.history.rewrite for .git/config: kept, the guarded entry beside it.
  const config = see("echo x > .git/config", WRITE_SCOPE_OFF, repo);
  assert.equal(config.segments[0]?.[0], "vcs.history.rewrite", JSON.stringify(config.segments));
  for (const command of [
    "echo x > ~/.npmrc.bak",
    "echo x > .npmrc",
    "echo x > ~/.config/systemd/system.conf",
    "echo x > ~/.pyenv/version",
    "echo x > ~/.cargo/config.toml",
    "echo x > .git/configs",
    "echo x > .gitx/config",
    "echo x > config",
  ]) {
    const seen = see(command, WRITE_SCOPE_OFF, repo);
    assert.ok(!seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
  }
});

test("S2.3 through the real hook: the file tools onto the new entries are denied; a file beside them is allowed", () => {
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  mkdirSync(join(dir, ".git"), { recursive: true });
  for (const [tool, input] of FILE_TOOLS) {
    for (const path of [join(home, ".npmrc"), join(home, ".bash_logout"), join(home, ".cargo", "bin", "rg"), join(dir, ".git", "config")]) {
      const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path))));
      assert.equal(seen.permission, "deny", `${tool} ${path}: ${seen.reason}`);
    }
    for (const path of [join(home, ".npmrc.bak"), join(dir, ".gitx-config")]) {
      const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path))));
      assert.equal(seen.permission, "allow", `${tool} ${path}: ${seen.reason}`);
    }
  }
  const bash = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Bash", { command: "echo x >> ~/.npmrc" })));
  assert.equal(bash.permission, "deny", bash.reason);
});

test("S2.2 fold parity: a move or delete whose word cannot be read, placed or trusted keeps the answer it had at bceddb81", () => {
  // The ancestor check only ever ADDS a guarded entry, and only for a word it
  // can place; where it cannot, the answer is what the guarded-list judgement
  // gave before S2 (read with the same settings at bceddb81). The three that
  // stay unguarded are known gaps for the lead: `rm -rf $X`, a delete after a
  // cd the hook cannot follow, and a delete through a link the same line makes.
  const h = freshHome({ "settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "python3 ~/tools/hooks/guard.py" }] }] } }) });
  mkdirSync(join(h, "tools", "hooks"), { recursive: true });
  writeFileSync(join(h, "tools", "hooks", "guard.py"), "#\n", "utf8");
  const lab = join(base, "s2-parity");
  mkdirSync(lab, { recursive: true });
  symlinkSync("loop", join(lab, "loop"));
  const at = (command: string): Array<[string, string]> => see(command, WRITE_SCOPE_OFF, lab).segments;
  withHome(h, undefined, () => {
    assert.deepEqual(at("rm -rf $X"), [[DELETE_OUT, "rm-unreadable-path"]]);
    assert.deepEqual(at("mv $X y"), [["policy.core", "copy-target-unknown"], [GUARDED, "write-unreadable"]]);
    assert.deepEqual(at("cd $D && rm -rf tools"), [["read.shell", "read-shell"], [WORKSPACE, "rm-workspace"]]);
    assert.deepEqual(at("cd $D && mv hooks y"), [["read.shell", "read-shell"], [WORKSPACE, "workspace-write"], [GUARDED, "write-unreadable"]]);
    assert.deepEqual(at("rm -rf loop/x"), [[WORKSPACE, "rm-workspace"], ["vcs.history.rewrite", "git-dir-write"]]);
    assert.deepEqual(at("mv loop/x y"), [[WORKSPACE, "workspace-write"], ["vcs.history.rewrite", "git-dir-write"]]);
    assert.deepEqual(at(`ln -s ${h}/tools l && rm -rf l/hooks`), [[DELETE_OUT, "write-out-of-scope-resolved"], [WORKSPACE, "rm-workspace"]]);
    assert.deepEqual(at(`ln -s ${h}/tools l && mv l/hooks y`), [[DELETE_OUT, "write-out-of-scope-resolved"], [WORKSPACE, "workspace-write"]]);
    // A word it can place: the ancestor check adds its entry.
    assert.ok(see("rm -rf ~/tools/hooks", WRITE_SCOPE_OFF, lab).classes.includes(GUARDED));
  });
});

// ---------------------------------------------------------------------------
// S2, part 4: zsh's `=name` (lead, N1)
// ---------------------------------------------------------------------------

test("S2.4 Bash: an unquoted =name redirect or write target is unreadable; '=x', =, == and a=b are not that form", () => {
  // The seat ruled the form fails closed whatever follows the `=` (lab: zsh -f wrote bin/tool for =tool, ="tool" and =\tool).
  for (const command of ["echo x > =mytool", "echo x >> =node", "cp a =mytool", "tee =python3 < a", "touch =x.y", "echo x 2> =_t", "echo x > =g++", "echo x > =my-tool", 'echo x > ="tool"', "echo x > =\\tool", "echo x > =$X", "echo x > ={a,b}", "cp a =-x"]) {
    const seen = see(command);
    assert.equal(seen.ok, true, command);
    assert.ok(seen.segments.some(([cls, rule]) => cls === GUARDED && rule === "write-unreadable"), `${command}: ${JSON.stringify(seen.segments)}`);
    assert.match(seen.notes, /equals expansion/u, command);
  }
  for (const command of ["echo x > '=mytool'", 'echo x > "=mytool"', "echo x > \\=mytool", "echo x > =", "echo x > ==", "echo x > ==x", "echo x > a=b", "cp a b=c", "echo =mytool > out.txt", "X='=tool'; echo x > $X"]) {
    const seen = see(command);
    assert.equal(seen.ok, true, command);
    assert.ok(!seen.classes.includes(GUARDED), `${command}: ${seen.notes}`);
  }
  // zsh equals-expands an unquoted `=` that opens an assignment's value (or follows a `:` in it), so the
  // variable holds the program's path (lab: X==tool; echo x > $X wrote bin/tool): not read.
  for (const command of ["X==tool; echo x > $X", "X=a:=tool; echo x > $X"]) {
    const seen = see(command);
    assert.ok(seen.segments.some(([cls, rule]) => cls === GUARDED && rule === "write-unreadable"), `${command}: ${JSON.stringify(seen.segments)}`);
  }
});

test("S2.4 through the real hook: echo x > =mytool is denied under a policy that guards", () => {
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  const denied = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Bash", { command: "echo x > =mytool" })));
  assert.equal(denied.permission, "deny", denied.reason);
  const allowed = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Bash", { command: "echo x > '=mytool'" })));
  assert.equal(allowed.permission, "allow", allowed.reason);
});

// ---------------------------------------------------------------------------
// S2, part 5: `~` in a file tool's path (lead, N2)
// ---------------------------------------------------------------------------

test("S2.5 through the real hook: a file tool's ~/ path is also read with HOME expanded, and the stricter answer stands", () => {
  const dir = gate([`  ${GUARDED}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  mkdirSync(join(home, ".claude-x", "hooks"), { recursive: true });
  for (const [tool, input] of FILE_TOOLS) {
    for (const path of ["~/.zshrc", "~/.ssh/authorized_keys", "~/.claude-x/hooks/h.sh", "~/.npmrc", "~/.ZSHRC"]) {
      const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path))));
      assert.equal(seen.permission, "deny", `${tool} ${path}: ${seen.reason}`);
      assert.match(seen.reason, /files\.write\.guarded resolves to human-only/u, `${tool} ${path}`);
    }
    // Controls: the home itself, a note under it, a `~` that is not the first segment, and `~user`.
    for (const path of ["~", "~/notes.md", "sub/~/.zshrc", "~nobody/.zshrc"]) {
      const seen = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event(tool, input(path))));
      assert.equal(seen.permission, "allow", `${tool} ${path}: ${seen.reason}`);
    }
  }
  // A landing that only the expanded reading reaches takes its organ class:
  // ~/s2-log is a link to the gate's own log folder.
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  symlinkSync(join(dir, ".approval", "log"), join(home, "s2-log"));
  // (This gate's default resolves log.mutate autonomous: the class is what is pinned.)
  const organ = verdict(runCli(["hook", "claude-code", "--as", "agent:cc"], dir, event("Write", { file_path: "~/s2-log/x.jsonl", content: "x" })));
  assert.match(organ.reason, /log\.mutate/u, organ.reason);
});

test("S2.2: a quoted word and a word through a symlink name the script as given and as resolved", () => {
  const h = freshHome();
  mkdirSync(join(h, "realdir"), { recursive: true });
  symlinkSync(join(h, "realdir"), join(h, "linkdir"));
  writeFileSync(join(h, "realdir", "x.sh"), "#\n", "utf8");
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/linkdir/x.sh && '/opt/s2-quoted/q.sh' \"$HOME\"/dq/d.sh" }] }] } }), "utf8");
  withHome(h, undefined, () => {
    // The settings name ~/linkdir/x.sh; a write to the real file is the same script.
    for (const command of [`echo x > ${h}/realdir/x.sh`, "echo x > ~/linkdir/x.sh", "echo x > /opt/s2-quoted/q.sh", "echo x > ~/dq/d.sh"]) {
      assert.ok(see(command).classes.includes(GUARDED), command);
    }
    assert.ok(!see(`echo x > ${h}/realdir/y.sh`).classes.includes(GUARDED));
  });
});
