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

import { classifyForHook, refineWriteLandings, resolveWriteScope, WRITE_SCOPE_OFF, type WriteScopeContext } from "../src/cli/hook.js";
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

test("a glob over a directory that cannot be read is guarded", { skip: process.getuid?.() === 0 ? "root reads every directory" : false }, () => {
  const locked = join(ws, "locked");
  mkdirSync(join(locked, "inner"), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    const seen = see("chmod +x locked/*/x");
    assert.ok(seen.classes.includes(GUARDED), seen.notes);
    assert.match(seen.notes, /could not be read from the disk/u);
  } finally {
    chmodSync(locked, 0o755);
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
    "find . -name x -fprint ~/.zshrc",
    "npx prettier --write ~/.zshrc",
    "make -C ~/.ssh",
  ]) {
    for (const scope of [WRITE_SCOPE_OFF, optedIn()]) {
      const seen = see(command, scope);
      assert.ok(seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
    }
  }
  // A program's argv is judged against the list only, never the roots.
  assert.ok(!see("npx prettier --write ../x.md", optedIn()).classes.includes(OUT));
  for (const command of ["npx prettier --write src", "make build", "cp -R dotfiles ~/", "cp -R dotfiles out/", "mv a.d b.d", "rsync -a dotfiles/ dist/", "tar -xf a.tar -C sub", "tar -xf a.tar", "cp dotfiles/x ~/", "ln -s a.d l"]) {
    const seen = see(command);
    assert.ok(!seen.classes.includes(GUARDED), `${command}: ${JSON.stringify(seen.segments)}`);
  }
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

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
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
