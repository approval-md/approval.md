/**
 * Real git, bare local remote: each APRV-518 case does what its class says.
 *
 * For every case a fresh fixture is made (a bare remote and a clone whose refs
 * disagree with it), the case's setup runs (a `git remote add --mirror=push`,
 * a configured push refspec, a checkout), the command is classified by
 * `classifyForHook` in the clone exactly as `approval hook claude-code` would
 * classify it there, and then the push runs. What the remote shows afterwards
 * is the effect, and the effect sets a floor:
 *
 * - a remote branch removed: at least `vcs.ref.delete`;
 * - a remote branch moved by a non-fast-forward: `vcs.history.rewrite`;
 * - a tag created, moved or removed: at least `release.publish`;
 * - the trunk moved: at least `vcs.push.main`.
 *
 * Each case also pins the exact class and rule, so a reading that drifts
 * stricter shows up as a diff rather than as silence. The first case is the
 * F1 finding as found: on git 2.50.1 a `git push m` after
 * `git remote add --mirror=push m` deleted a remote branch while the classifier
 * on main read it as an implicit trunk push.
 *
 * Hermetic: HOME is a fixture directory and system configuration is off, both
 * for the git this file runs and for the git the refinement runs (it inherits
 * this process's environment). Skips when no git binary is found.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand } from "../src/core/command-class.js";

const work = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-push-config-")));
after(() => rmSync(work, { recursive: true, force: true }));

const HOME = join(work, "home");
mkdirSync(HOME);
writeFileSync(
  join(HOME, ".gitconfig"),
  ["[user]", "\tname = Push Oracle", "\temail = oracle@example.invalid", "[init]", "\tdefaultBranch = main", ""].join("\n"),
);
// The refinement spawns git with this process's environment.
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
process.env["GIT_TERMINAL_PROMPT"] = "0";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: readonly string[]): Ran {
  const result = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ok(cwd: string, args: readonly string[]): string {
  const ran = git(cwd, args);
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout.trim();
}

const GIT_VERSION = (() => {
  const ran = spawnSync("git", ["--version"], { env: ENV, encoding: "utf8" });
  return ran.status === 0 ? ran.stdout.trim() : null;
})();

/** Strictest first. */
const ORDER = ["vcs.history.rewrite", "release.publish", "vcs.ref.delete", "vcs.push.main", "vcs.push.branch"];

interface Fixture {
  remote: string;
  clone: string;
}

let counter = 0;

/**
 * Remote: `main` at c0, `lane` at r1, `stale` (no local counterpart). Clone:
 * `main` at m1 (a fast-forward of the remote trunk), `lane` at l1 (diverged
 * from r1, so only a forced push moves it), HEAD on `lane`. Built once and
 * copied per case (the origin URL is relative, so a copy is self-contained):
 * building it is fifteen git runs, copying it is one directory walk.
 */
const TEMPLATE = join(work, "template");
let templateBuilt = false;

function buildTemplate(): void {
  const remote = join(TEMPLATE, "remote.git");
  const clone = join(TEMPLATE, "clone");
  mkdirSync(TEMPLATE);
  ok(TEMPLATE, ["init", "-q", "--bare", remote]);
  ok(remote, ["config", "receive.denyDeleteCurrent", "ignore"]);
  ok(TEMPLATE, ["init", "-q", clone]);
  ok(clone, ["remote", "add", "origin", "../remote.git"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "c0"]);
  ok(clone, ["push", "-q", "origin", "main", "main:refs/heads/stale"]);
  ok(clone, ["checkout", "-q", "-b", "remote-lane"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "r1"]);
  ok(clone, ["push", "-q", "origin", "remote-lane:refs/heads/lane"]);
  ok(clone, ["checkout", "-q", "main"]);
  ok(clone, ["branch", "-q", "-D", "remote-lane"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "m1"]);
  ok(clone, ["checkout", "-q", "-b", "lane", "HEAD~1"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "l1"]);
  ok(clone, ["fetch", "-q", "origin"]);
}

function makeFixture(): Fixture {
  if (!templateBuilt) {
    buildTemplate();
    templateBuilt = true;
  }
  counter += 1;
  const root = join(work, `case-${counter}`);
  cpSync(TEMPLATE, root, { recursive: true });
  return { remote: join(root, "remote.git"), clone: join(root, "clone") };
}

function refsOf(dir: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of ok(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n")) {
    const [ref, sha] = line.split(" ");
    if (ref !== undefined && sha !== undefined && ref !== "") refs.set(ref, sha);
  }
  return refs;
}

/** The class the observed effect needs at least. */
function floorOf(fixture: Fixture, before: Map<string, string>, after: Map<string, string>): { floor: string; effect: string[] } {
  const effect: string[] = [];
  let floor = "vcs.push.branch";
  const raise = (cls: string, what: string): void => {
    effect.push(what);
    if (ORDER.indexOf(cls) < ORDER.indexOf(floor)) floor = cls;
  };
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(ref);
    const now = after.get(ref);
    if (was === now) continue;
    if (ref.startsWith("refs/tags/")) {
      raise("release.publish", `tag ${ref}`);
      continue;
    }
    if (!ref.startsWith("refs/heads/")) continue;
    if (now === undefined) {
      raise("vcs.ref.delete", `removed ${ref}`);
      continue;
    }
    if (was !== undefined && git(fixture.clone, ["merge-base", "--is-ancestor", was, now]).status !== 0) {
      raise("vcs.history.rewrite", `forced ${ref}`);
    }
    if (ref === "refs/heads/main") raise("vcs.push.main", "trunk moved");
  }
  return { floor, effect };
}

interface Case {
  name: string;
  setup: readonly (readonly string[])[];
  /** The command as an agent writes it (what is classified). */
  command: string;
  /** The argv after `git` that runs it, in the clone. */
  argv: readonly string[];
  expect: { class: string; rule: string };
  /** What the effect must include, so the case proves what it claims. */
  sees?: RegExp;
  /** The class the pure classifier on #649's head gave, for the record. */
  was?: string;
}

const CASES: readonly Case[] = [
  {
    name: "F1: a mirror remote added, then a refspec-less push to it",
    setup: [["remote", "add", "--mirror=push", "m", "../remote.git"]],
    command: "git push m",
    argv: ["push", "m"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-mirror" },
    sees: /removed refs\/heads\/stale/u,
    was: "vcs.push.main",
  },
  {
    name: "a mirror remote with --tags still mirrors",
    setup: [["remote", "add", "--mirror=push", "m", "../remote.git"]],
    command: "git push --tags m",
    argv: ["push", "--tags", "m"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-mirror" },
    sees: /removed refs\/heads\/stale/u,
    was: "release.publish",
  },
  {
    name: "a mirror remote reached through --repo",
    setup: [["remote", "add", "--mirror=push", "m", "../remote.git"]],
    command: "git push --repo=m",
    argv: ["push", "--repo=m"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-mirror" },
    sees: /removed refs\/heads\/stale/u,
    was: "vcs.push.main",
  },
  {
    name: "a mirror remote renamed onto origin",
    setup: [
      ["remote", "remove", "origin"],
      ["remote", "add", "--mirror=push", "m", "../remote.git"],
      ["remote", "rename", "m", "origin"],
    ],
    command: "git push origin",
    argv: ["push", "origin"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-mirror" },
    sees: /removed refs\/heads\/stale/u,
    was: "vcs.push.main",
  },
  {
    name: "remote.origin.mirror set on the existing remote, then a bare git push",
    setup: [["config", "remote.origin.mirror", "true"]],
    command: "git push",
    argv: ["push"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-mirror" },
    sees: /removed refs\/heads\/stale/u,
    was: "vcs.push.main",
  },
  {
    name: "a configured deleting push refspec",
    setup: [["config", "remote.origin.push", ":refs/heads/stale"]],
    command: "git push origin",
    argv: ["push", "origin"],
    expect: { class: "vcs.ref.delete", rule: "git-push-config-refspec" },
    sees: /removed refs\/heads\/stale/u,
    was: "vcs.push.main",
  },
  {
    name: "a configured forcing push refspec, refspec-less push",
    setup: [["config", "remote.origin.push", "+refs/heads/lane:refs/heads/lane"]],
    command: "git push",
    argv: ["push"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-refspec" },
    sees: /forced refs\/heads\/lane/u,
    was: "vcs.push.main",
  },
  {
    name: "a colon-less refspec takes the configured mapping's force and destination",
    setup: [
      // A lane that does not descend from the remote trunk, so only a force moves main to it.
      ["checkout", "-q", "--orphan", "orphan"],
      ["commit", "-q", "--allow-empty", "-m", "o1"],
      ["branch", "-q", "-f", "lane", "orphan"],
      ["config", "remote.origin.push", "+refs/heads/lane:refs/heads/main"],
    ],
    command: "git push origin lane",
    argv: ["push", "origin", "lane"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-refspec" },
    sees: /forced refs\/heads\/main/u,
    was: "vcs.push.branch",
  },
  {
    name: "a colon-less refspec mapped onto the trunk",
    setup: [
      ["checkout", "-q", "-B", "lane", "main"],
      ["config", "remote.origin.push", "refs/heads/lane:refs/heads/main"],
    ],
    command: "git push origin lane",
    argv: ["push", "origin", "lane"],
    expect: { class: "vcs.push.main", rule: "git-push-config-refspec" },
    sees: /trunk moved/u,
    was: "vcs.push.branch",
  },
  {
    name: "a pattern mapping forces a colon-less refspec",
    setup: [["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"]],
    command: "git push origin lane",
    argv: ["push", "origin", "lane"],
    expect: { class: "vcs.history.rewrite", rule: "git-push-config-refspec" },
    sees: /forced refs\/heads\/lane/u,
    was: "vcs.push.branch",
  },
  {
    name: "F3: HEAD on main is a trunk push",
    setup: [["checkout", "-q", "main"]],
    command: "git push origin HEAD",
    argv: ["push", "origin", "HEAD"],
    expect: { class: "vcs.push.main", rule: "git-push-head" },
    sees: /trunk moved/u,
    was: "vcs.push.branch",
  },
  {
    name: "F3: @ on main is a trunk push",
    setup: [["checkout", "-q", "main"]],
    command: "git push -u origin @",
    argv: ["push", "-u", "origin", "@"],
    expect: { class: "vcs.push.main", rule: "git-push-head" },
    sees: /trunk moved/u,
    was: "vcs.push.branch",
  },
  {
    name: "HEAD on a feature branch is that branch (and takes no configured force)",
    setup: [
      ["checkout", "-q", "-b", "feature", "main"],
      ["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"],
    ],
    command: "git push origin HEAD",
    argv: ["push", "origin", "HEAD"],
    expect: { class: "vcs.push.branch", rule: "git-push-branch" },
    was: "vcs.push.branch",
  },
  {
    name: "a colon-less word naming a local tag publishes the tag",
    setup: [["tag", "t1"]],
    command: "git push origin t1",
    argv: ["push", "origin", "t1"],
    expect: { class: "release.publish", rule: "git-push-local-tag" },
    sees: /tag refs\/tags\/t1/u,
    was: "vcs.push.branch",
  },
  {
    name: "push.followTags publishes an annotated tag beside a branch push",
    setup: [
      ["checkout", "-q", "-b", "feature", "main"],
      ["tag", "-a", "t2", "-m", "t2"],
      ["config", "push.followTags", "true"],
    ],
    command: "git push origin feature",
    argv: ["push", "origin", "feature"],
    expect: { class: "release.publish", rule: "git-push-config-tags" },
    sees: /tag refs\/tags\/t2/u,
    was: "vcs.push.branch",
  },
  {
    name: "steer: a push refspec written into .git/config as a FILE (not via git config), then a push in a later call",
    setup: [],
    command: "git push origin",
    argv: ["push", "origin"],
    expect: { class: "vcs.ref.delete", rule: "git-push-config-refspec" },
    sees: /removed refs\/heads\/lane/u,
    was: "vcs.push.main",
  },
  {
    name: "steer: a destination git DWIMs to the trunk (`lane:heads/main`)",
    setup: [["checkout", "-q", "-B", "lane", "main"]],
    command: "git push origin lane:heads/main",
    argv: ["push", "origin", "lane:heads/main"],
    expect: { class: "vcs.push.main", rule: "git-push-main" },
    sees: /trunk moved/u,
    was: "vcs.push.branch",
  },
  {
    name: "steer: a colon-less `heads/main` pushes the trunk",
    setup: [["checkout", "-q", "main"]],
    command: "git push origin heads/main",
    argv: ["push", "origin", "heads/main"],
    expect: { class: "vcs.push.main", rule: "git-push-main" },
    sees: /trunk moved/u,
    was: "vcs.push.branch",
  },
  {
    name: "the control: an ordinary branch push in a plain checkout is unmoved",
    setup: [["checkout", "-q", "-b", "feature", "main"]],
    command: "git push -u origin feature",
    argv: ["push", "-u", "origin", "feature"],
    expect: { class: "vcs.push.branch", rule: "git-push-branch" },
    was: "vcs.push.branch",
  },
];

function classified(command: string, cwd: string): { class: string; rule: string } {
  const result = classifyForHook(command, [], cwd).result;
  assert.equal(result.ok, true, `${command}: ${result.ok ? "" : `${result.code}: ${result.detail}`}`);
  if (!result.ok) throw new Error("unreachable");
  const pushes = result.segments.filter((segment) => segment.rule.startsWith("git-push") || segment.rule === "git-ref-delete");
  assert.equal(pushes.length, 1, `${command}: ${JSON.stringify(result.segments)}`);
  const segment = pushes[0] as { class: string; rule: string };
  return { class: segment.class, rule: segment.rule };
}

for (const one of CASES) {
  test(`${GIT_VERSION ?? "no git"}: ${one.name}`, { skip: GIT_VERSION === null ? "no git binary" : false }, () => {
    const fixture = makeFixture();
    for (const step of one.setup) ok(fixture.clone, step);
    if (one.name.startsWith("steer: a push refspec written into .git/config")) {
      appendFileSync(join(fixture.clone, ".git", "config"), '[remote "origin"]\n\tpush = :refs/heads/lane\n');
    }
    const answer = classified(one.command, fixture.clone);
    const before = refsOf(fixture.remote);
    git(fixture.clone, one.argv);
    const { floor, effect } = floorOf(fixture, before, refsOf(fixture.remote));
    if (one.sees !== undefined) assert.match(effect.join("; "), one.sees, `${one.command}: effect ${effect.join("; ")}`);
    assert.ok(
      ORDER.indexOf(answer.class) <= ORDER.indexOf(floor),
      `${one.command} classified ${answer.class} but did ${effect.join("; ")} (needs ${floor})`,
    );
    assert.deepEqual(answer, one.expect, one.command);
    if (one.was !== undefined) {
      assert.ok(ORDER.indexOf(answer.class) <= ORDER.indexOf(one.was), `${one.command} must not be looser than ${one.was}`);
    }
  });
}

test("a case-insensitive filesystem: `head` is HEAD, and on main it moves the trunk", { skip: GIT_VERSION === null }, (t) => {
  const fixture = makeFixture();
  if (!existsSync(join(fixture.clone, ".git", "head"))) {
    t.skip("case-sensitive filesystem: `head` names no ref here");
    return;
  }
  ok(fixture.clone, ["checkout", "-q", "main"]);
  const answer = classified("git push origin head", fixture.clone);
  const before = refsOf(fixture.remote);
  git(fixture.clone, ["push", "origin", "head"]);
  const { floor, effect } = floorOf(fixture, before, refsOf(fixture.remote));
  assert.match(effect.join("; "), /trunk moved/u);
  assert.ok(ORDER.indexOf(answer.class) <= ORDER.indexOf(floor));
  assert.deepEqual(answer, { class: "vcs.push.main", rule: "git-push-head" });
});

test("a detached HEAD: git refuses the push, and the class stays the trunk's", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  ok(fixture.clone, ["checkout", "-q", "--detach", "main"]);
  assert.deepEqual(classified("git push origin HEAD", fixture.clone), { class: "vcs.push.main", rule: "git-push-head" });
  const before = refsOf(fixture.remote);
  assert.notEqual(git(fixture.clone, ["push", "origin", "HEAD"]).status, 0);
  assert.deepEqual(refsOf(fixture.remote), before);
});

test("the git remote writes that arm these pushes classify vcs.history.rewrite before any push runs", () => {
  for (const command of [
    "git remote add --mirror=push m ../remote.git",
    "git remote rename m origin",
    "git remote remove origin",
    "git remote set-url origin ../remote.git",
  ]) {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, command);
    if (!result.ok) continue;
    assert.equal(result.segments[0]?.class, "vcs.history.rewrite", command);
  }
});

test("a directory the push runs in that cannot be named: the push its configuration decides is vcs.history.rewrite", () => {
  const fixture = makeFixture();
  assert.deepEqual(classified('cd "$WT" && git push origin lane', fixture.clone), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
  assert.deepEqual(classified("cd - && git push", fixture.clone), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
  // An explicit src:dst names its refs, but followTags may still publish tags.
  assert.deepEqual(classified('cd "$WT" && git push origin lane:lane', fixture.clone), {
    class: "release.publish",
    rule: "git-push-config-unreadable",
  });
  // A bare relative name goes through CDPATH, so it is not followed.
  assert.equal(classified("cd clone && git push origin lane", join(fixture.clone, "..")).rule, "git-push-config-unreadable");
});

test("a cd to a literal path reads the checkout there, and the one it left", { skip: GIT_VERSION === null }, () => {
  const mirrored = makeFixture();
  ok(mirrored.clone, ["config", "remote.origin.mirror", "true"]);
  const plain = makeFixture();
  // From a plain checkout into a mirrored one: the mirror is seen.
  assert.equal(classified(`cd ${mirrored.clone} && git push origin`, plain.clone).class, "vcs.history.rewrite");
  // From a mirrored checkout into a plain one: a failed cd would push from the mirror, so it is seen too.
  assert.equal(classified(`cd ${plain.clone} && git push origin`, mirrored.clone).class, "vcs.history.rewrite");
  // Relative and home-relative spellings resolve.
  assert.equal(classified("cd ../clone && git push origin", join(mirrored.clone, ".git")).class, "vcs.history.rewrite");
});

test("no repository anywhere the push runs: git refuses there, and the pure class stands", () => {
  const empty = join(work, "not-a-repo");
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(classified("git push origin lane", empty), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(classified("git push", empty), { class: "vcs.push.main", rule: "git-push-implicit" });
});

test("steer: the one-command F1 chain (printf >> .git/config && git push origin) is refused, and it really deletes", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  const command = "printf '[remote \"origin\"]\\n\\tpush = :refs/heads/lane\\n' >> .git/config && git push origin";
  const result = classifyForHook(command, [], fixture.clone).result;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.classes.includes("vcs.history.rewrite"), JSON.stringify(result.segments));
  assert.equal(result.segments[0]?.rule, "git-dir-write");
  const before = refsOf(fixture.remote);
  const ran = spawnSync("/bin/sh", ["-c", command], { cwd: fixture.clone, env: ENV, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const { effect } = floorOf(fixture, before, refsOf(fixture.remote));
  assert.match(effect.join("; "), /removed refs\/heads\/lane/u);
});

test("steer: the branch origin/HEAD names is a trunk, by name and through DWIM", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  ok(fixture.clone, ["push", "-q", "origin", "main:refs/heads/develop"]);
  ok(fixture.clone, ["fetch", "-q", "origin"]);
  ok(fixture.clone, ["remote", "set-head", "origin", "develop"]);
  ok(fixture.clone, ["checkout", "-q", "-B", "lane", "main"]);
  ok(fixture.clone, ["commit", "-q", "--allow-empty", "-m", "d1"]);
  assert.deepEqual(classified("git push origin lane:heads/develop", fixture.clone), { class: "vcs.push.main", rule: "git-push-main" });
  const before = refsOf(fixture.remote);
  ok(fixture.clone, ["push", "-q", "origin", "lane:heads/develop"]);
  const after = refsOf(fixture.remote);
  assert.notEqual(after.get("refs/heads/develop"), before.get("refs/heads/develop"), "develop moved");
});

test("steer + review: any earlier non-read segment, or foreign code, makes the push's configuration unreadable", () => {
  const fixture = makeFixture();
  assert.deepEqual(classified("npm test && git push -u origin lane", fixture.clone), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
  assert.deepEqual(classified('printf x >> "$(git rev-parse --git-dir)/config" && git push origin', fixture.clone), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
  assert.deepEqual(classified("git add -A && git commit -q -m x && git push -u origin lane", fixture.clone), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
  // The refs are on the line, but followTags may still be on by then.
  assert.deepEqual(classified("npm test && git push origin lane:lane", fixture.clone), {
    class: "release.publish",
    rule: "git-push-config-unreadable",
  });
  // A read before it, a read piped after it, and a write after it (not concurrent) leave the reading alone.
  assert.deepEqual(classified("git status && git push -u origin lane", fixture.clone), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(classified("git push -u origin lane 2>&1 | tail -3", fixture.clone), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(classified("git push -u origin lane && gh pr create --fill", fixture.clone), {
    class: "vcs.push.branch",
    rule: "git-push-branch",
  });
  // Run alongside a write, it is unreadable.
  assert.deepEqual(classified("git push -u origin lane & npm test", fixture.clone), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
});
// ---------------------------------------------------------------------------
// Security review: config the hook reads, config changed on the same line
// ---------------------------------------------------------------------------

/** Run a whole command line in the clone, as the harness would. */
function sh(cwd: string, command: string): Ran {
  const ran = spawnSync("/bin/sh", ["-c", command], { cwd, env: ENV, encoding: "utf8", timeout: 20_000 });
  return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function assertCovers(fixture: Fixture, command: string, cwd: string, sees: RegExp): { class: string; rule: string } {
  const result = classifyForHook(command, [], cwd).result;
  assert.equal(result.ok, true, command);
  if (!result.ok) throw new Error("unreachable");
  let strictest = "vcs.push.branch";
  for (const segment of result.segments) {
    if (ORDER.includes(segment.class) && ORDER.indexOf(segment.class) < ORDER.indexOf(strictest)) strictest = segment.class;
  }
  const before = refsOf(fixture.remote);
  sh(cwd, command);
  const { floor, effect } = floorOf(fixture, before, refsOf(fixture.remote));
  assert.match(effect.join("; "), sees, `${command}: effect ${effect.join("; ")}`);
  assert.ok(ORDER.indexOf(strictest) <= ORDER.indexOf(floor), `${command}: ${strictest} but did ${effect.join("; ")}`);
  const push = result.segments.find((segment) => segment.rule.startsWith("git-push") || segment.rule === "git-ref-delete");
  return { class: push?.class ?? "", rule: push?.rule ?? "" };
}

test("review: a mirror set in a per-worktree config.worktree is read in the worktree", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  ok(fixture.clone, ["config", "extensions.worktreeConfig", "true"]);
  const wt = join(fixture.clone, "..", "wt");
  ok(fixture.clone, ["worktree", "add", "-q", "-b", "wtb", wt, "main"]);
  ok(wt, ["config", "--worktree", "remote.origin.mirror", "true"]);
  assert.deepEqual(assertCovers(fixture, "git push origin", wt, /removed refs\/heads\/stale/u), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-mirror",
  });
});

test("review: a mirror set through include.path is read (git config reads includes)", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  writeFileSync(join(fixture.clone, "inc.cfg"), '[remote "origin"]\n\tmirror = true\n');
  ok(fixture.clone, ["config", "include.path", "../inc.cfg"]);
  assert.deepEqual(assertCovers(fixture, "git push origin", fixture.clone, /removed refs\/heads\/stale/u), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-mirror",
  });
});

test("review: includeIf onbranch flips after a checkout on the same line; the hook does not trust its earlier read", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  writeFileSync(join(fixture.clone, "main.cfg"), '[remote "origin"]\n\tmirror = true\n');
  ok(fixture.clone, ["config", "includeIf.onbranch:main.path", "../main.cfg"]);
  // On lane the include is off, and the hook's read says so.
  assert.deepEqual(classified("git push origin", fixture.clone), { class: "vcs.push.main", rule: "git-push-implicit" });
  // After `git checkout main` on the same line it is on; the push really mirrors.
  assert.deepEqual(assertCovers(fixture, "git checkout -q main && git push origin", fixture.clone, /removed refs\/heads\/stale/u), {
    class: "vcs.history.rewrite",
    rule: "git-push-config-unreadable",
  });
});

test("review: HEAD read before a checkout on the same line is not trusted", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  assert.deepEqual(classified("git push origin HEAD", fixture.clone), { class: "vcs.push.branch", rule: "git-push-branch" });
  const answer = assertCovers(fixture, "git checkout -q main && git push origin HEAD", fixture.clone, /trunk moved/u);
  assert.deepEqual(answer, { class: "release.publish", rule: "git-push-config-unreadable" });
});

test("review: a mirror appended to ~/.gitconfig on the same line is refused, and it really mirrors", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  const user = join(HOME, ".gitconfig");
  const saved = readFileSync(user, "utf8");
  try {
    const command = "printf '[remote \"origin\"]\\n\\tmirror = true\\n' >> ~/.gitconfig && git push origin";
    const result = classifyForHook(command, [], fixture.clone).result;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.classes, ["vcs.history.rewrite"]);
    assert.equal(result.segments[0]?.rule, "git-config-file-write");
    const before = refsOf(fixture.remote);
    assert.equal(sh(fixture.clone, command).status, 0);
    assert.match(floorOf(fixture, before, refsOf(fixture.remote)).effect.join("; "), /removed refs\/heads\/stale/u);
  } finally {
    writeFileSync(user, saved);
  }
});

// ---------------------------------------------------------------------------
// Agreement with git 2.50's parsers, for the readings APRV-518 touched
// ---------------------------------------------------------------------------

const REMOTE_READ_FORMS: readonly string[] = [
  "git remote",
  "git remote -v",
  "git remote --verbose",
  "git remote -v -v",
  "git remote show origin",
  "git remote show -n origin",
  "git remote -v show origin",
  "git remote get-url origin",
  "git remote get-url --push origin",
  "git remote get-url --all --push origin",
  "git remote get-url --no-push origin",
  "git remote update",
  "git remote update origin",
  "git remote -v update origin",
  "git remote update --no-prune origin",
];

test("agreement: every git remote form the classifier reads is one git accepts and that writes no configuration", { skip: GIT_VERSION === null }, () => {
  const fixture = makeFixture();
  const config = join(fixture.clone, ".git", "config");
  for (const command of REMOTE_READ_FORMS) {
    assert.deepEqual(classified0(command), { class: "read.vcs.remote", rule: "git-remote-read" }, command);
    const before = readFileSync(config, "utf8");
    const heads = [...refsOf(fixture.clone).keys()].filter((ref) => !ref.startsWith("refs/remotes/"));
    const ran = sh(fixture.clone, command);
    assert.equal(ran.status, 0, `${command}: git refused it: ${ran.stderr}`);
    assert.equal(readFileSync(config, "utf8"), before, `${command} changed .git/config`);
    assert.deepEqual([...refsOf(fixture.clone).keys()].filter((ref) => !ref.startsWith("refs/remotes/")), heads, command);
  }
});

function classified0(command: string): { class: string; rule: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, true, command);
  if (!result.ok) throw new Error("unreachable");
  const segment = result.segments[0] as { class: string; rule: string };
  return { class: segment.class, rule: segment.rule };
}

/** Destinations, pushed from a lane one commit ahead of the remote trunk. */
const DESTINATIONS = ["main", "heads/main", "refs/heads/main", "MAIN", "Main", "master", "HEAD", "remotes/origin/main", "tags/t9", "heads/heads/main", "heads/lane", "lane", "refs/heads/lane"];
/** Colon-less words, pushed from main one commit ahead of the remote trunk. */
const COLONLESS = ["main", "heads/main", "refs/heads/main", "HEAD", "@", "head", "HeAd", "HEAD~1", "@{u}", "HEAD^", "refs/heads/HEAD"];

test("agreement: every DWIM destination and HEAD spelling is classified at least as strictly as git 2.50 acts on it", { skip: GIT_VERSION === null }, () => {
  const cases = [
    ...DESTINATIONS.map((dst) => ({ setup: ["checkout", "-q", "-B", "lane", "main"], argv: ["push", "origin", `lane:${dst}`] })),
    ...COLONLESS.map((word) => ({ setup: ["checkout", "-q", "main"], argv: ["push", "origin", word] })),
  ];
  for (const one of cases) {
    const fixture = makeFixture();
    ok(fixture.clone, one.setup);
    ok(fixture.clone, ["branch", "-q", "-u", "origin/main"]);
    const command = `git ${one.argv.join(" ")}`;
    const pure = classified0(command);
    const hook = classified(command, fixture.clone);
    const before = refsOf(fixture.remote);
    git(fixture.clone, one.argv);
    const { floor, effect } = floorOf(fixture, before, refsOf(fixture.remote));
    for (const [layer, answer] of [["pure", pure], ["hook", hook]] as const) {
      assert.ok(
        ORDER.indexOf(answer.class) <= ORDER.indexOf(floor),
        `${layer}: ${command} classified ${answer.class} but git did ${effect.join("; ")} (needs ${floor})`,
      );
    }
  }
});
