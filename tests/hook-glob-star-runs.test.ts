/**
 * A run of `*` in a path word, and a pattern too wide to list.
 *
 * A hook the harness kills at its timeout is a tool call that proceeds
 * (`docs/claude-code-hook.md`), so a word that holds the hook is a way past
 * it. Two such words are pinned here:
 *
 * 1. a run of `*`. Each star became its own `.*`, and a backtracking matcher
 *    tries every way of sharing a name between them: 441 bytes held the hook
 *    for minutes. A run is now written once, which matches the same names.
 * 2. a word whose patterns go round a link back to where they started. Each
 *    component is listed from up to 256 places, so the same directory was
 *    listed that many times per lap, for as long as the word went on. The
 *    listing now has a budget of steps, and a word past it is judged a read
 *    the hook cannot list.
 *
 * Costs are CPU time, never wall-clock time: this machine is shared. No input
 * is larger than 64 KB and none can exhaust memory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-stars-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** CPU seconds (user and system) spent in `run`. */
function cpu(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

/** A workspace with an approval home, a Hermes home, a link into the first, and two plain files. */
function workspace(): string {
  const root = join(scratch, "ws");
  if (planted) return root;
  planted = true;
  mkdirSync(join(root, ".approval", "keys"), { recursive: true });
  mkdirSync(join(root, ".approval", "log"), { recursive: true });
  mkdirSync(join(root, ".hermes"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".approval", "env"), "x\n");
  writeFileSync(join(root, ".hermes", "config.yaml"), "x\n");
  writeFileSync(join(root, "notes.txt"), "x\n");
  writeFileSync(join(root, "src", "a.ts"), "x\n");
  symlinkSync(".approval", join(root, "alias"));
  return root;
}

let planted = false;

/** The whole answer, with every run of two or more `*` in it written `**` (the command's own text is in it). */
function answer(command: string, cwd: string): string {
  return JSON.stringify(classifyForHook(command, [], cwd)).replace(/\*{2,}/gu, "**");
}

/** The classes alone. */
function classesOf(command: string, cwd: string): string[] {
  const { result } = classifyForHook(command, [], cwd);
  return result.ok ? result.classes : [`refused ${result.code}`];
}

/** Commands with one `*` each, written `@`: every place a pattern is read. */
const SHAPES: readonly string[] = [
  // The line of the finding: a pattern inside a substitution, as a write target.
  'git push --force && echo x > "$(echo .@x)"',
  // Reads: a credential by a pattern in its name, in its directory, through a link, and none.
  "cat .approval/e@v",
  "cat .appr@/env",
  "cat ali@/env",
  "cat @",
  "cat .@",
  "cat @/env",
  "cat n@s.txt",
  "cat no@such",
  "cat src/@.ts",
  "cat [e@]nv",
  "cat .approval/[e@]nv",
  "grep -r x .appr@",
  "cat < .approval/e@v",
  // Writes: an organ, the log, the git directory, and a plain file.
  "echo x > .herm@/config.yaml",
  "echo x > .hermes/conf@.yaml",
  "rm -rf .appro@",
  "cp notes.txt .approval/l@g/x",
  "echo x > .gi@/config",
  "echo x > src/@.ts",
  "tee .approval/k@s/x",
];

test("a run of stars is read as one: every shape has the classes of its one-star form, the whole answer of its two-star form, and 200 stars cost what two cost", () => {
  const cwd = workspace();
  for (const shape of SHAPES) {
    // `**` has a reading of its own elsewhere in the hook (zsh's any-depth
    // form: the directory it starts from is named as the path read), so the
    // whole answer is compared with the two-star form and the classes with
    // the one-star form.
    const one = classesOf(shape.replace("@", "*"), cwd);
    const two = answer(shape.replace("@", "**"), cwd);
    // 200, not 400: a component of more than 255 bytes is a name no
    // filesystem holds, which the hook answers on its own terms.
    for (const run of [2, 3, 7, 200]) {
      const command = shape.replace("@", "*".repeat(run));
      let got = "";
      const spent = cpu(() => {
        got = answer(command, cwd);
      });
      assert.equal(got, two, `${shape} with ${String(run)} stars`);
      assert.deepEqual(classesOf(command, cwd), one, `${shape} with ${String(run)} stars`);
      // The finding's line took over 120 CPU seconds with 400 stars; with 26, two.
      assert.ok(spent < 2, `${shape} with ${String(run)} stars: ${spent.toFixed(3)} CPU s`);
    }
  }
});

test("the line of the finding: 441 bytes, the class it always had, in well under 2 CPU seconds", () => {
  const cwd = workspace();
  const line = (stars: number): string => `git push --force && echo x > "$(echo .${"*".repeat(stars)}x)"`;
  assert.equal(line(400).length, 441);
  let classes: readonly string[] = [];
  const spent = cpu(() => {
    const { result } = classifyForHook(line(400), [], cwd);
    classes = result.ok ? result.classes : [`refused ${result.code}`];
  });
  assert.deepEqual(classes, ["vcs.history.rewrite"]);
  assert.ok(spent < 2, `${spent.toFixed(3)} CPU s`);
  // Runs apart from each other are each written once, and the names they
  // match are still matched: `.a…p…l` names the approval home.
  const spread = `cat .a${"*".repeat(200)}p${"*".repeat(200)}l/env`;
  const { result } = classifyForHook(spread, [], cwd);
  assert.deepEqual(result.ok ? result.classes : [], ["read.shell", "account.credential"]);
});

test("a pattern too wide to list is a read the hook cannot clear, answered in under 2 CPU seconds", () => {
  // 250 folders and one more, each with a link `u` back to this directory.
  // `f*` matches the 250; `u` after it is 250 spellings of this directory;
  // `only*` then matches one name from each, so the 250 survive every lap,
  // and every lap lists the directory 250 times: 63,000 names a lap. Nothing
  // here is a credential.
  const dir = join(scratch, "wide");
  for (let index = 0; index < 250; index += 1) {
    const folder = join(dir, `f${String(index).padStart(3, "0")}`);
    mkdirSync(folder, { recursive: true });
    symlinkSync("..", join(folder, "u"));
  }
  mkdirSync(join(dir, "only1"), { recursive: true });
  symlinkSync("..", join(dir, "only1", "u"));
  // A few laps are listed, and clear.
  assert.deepEqual(classesOf("ls f*", dir), ["read.shell"]);
  assert.deepEqual(classesOf("ls f*/u/only*", dir), ["read.shell"]);
  assert.deepEqual(classesOf(`ls f*/u/${"only*/u/".repeat(3)}only*`, dir), ["read.shell"]);
  // Forty laps are two and a half million names: not listed. The word is a
  // read of something the hook cannot name. (A path has room for a hundred
  // laps or more, and a directory can hold far more than 251 names.)
  const wide = `ls f*/u/${"only*/u/".repeat(40)}only*`;
  let got: string[] = [];
  const spent = cpu(() => {
    got = classesOf(wide, dir);
  });
  assert.deepEqual(got, ["read.shell", "account.credential"]);
  assert.ok(spent < 2, `${spent.toFixed(3)} CPU s`);
  // A word with one pattern and no lap is listed, and clear.
  assert.deepEqual(classesOf(`ls ${"./".repeat(200)}only*`, dir), ["read.shell"]);
});
