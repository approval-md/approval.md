/**
 * `git remote` writes and the pushes their configuration decides (APRV-518).
 *
 * Two holes the APRV-517 build lane found on main (its follow-ups F1 and F3):
 *
 * - F1: every `git remote` subcommand classified `read.vcs.remote`, so
 *   `git remote add --mirror=push m <url>` ran unasked, and the `git push m`
 *   after it read as an implicit `vcs.push.main` while it was a mirror push
 *   that deleted remote branches. A two-step way around `vcs.ref.delete` and
 *   `vcs.history.rewrite`.
 * - F3: `git push origin HEAD` and `git push origin @` were `vcs.push.branch`
 *   even on main.
 *
 * This file pins the pure half: the closed list of `git remote` reads, the
 * writing forms at `vcs.history.rewrite`, `git config` writes of `remote.*`
 * still refused, a colon-less HEAD/@ read as the trunk, and
 * {@link gitPushSegmentClass} under every kind of repository fact, including
 * the property that it never answers looser than the pure classifier except
 * for the one `HEAD` a current branch resolves. Pure: no disk, no git.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLASSIFIER_CLASSES,
  classifyCommand,
  GIT_PUSH_RULES,
  gitPushSegmentClass,
  isCurrentBranchRefspec,
  type PushRepoFacts,
} from "../src/core/command-class.js";

const REWRITE = "vcs.history.rewrite";

/** Strictest first, the order the push row ranks its answers in. */
const ORDER = ["vcs.history.rewrite", "release.publish", "vcs.ref.delete", "vcs.push.main", "vcs.push.branch"];

function only(command: string): { class: string; rule: string; path?: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, true, `${command}: ${result.ok ? "" : `${result.code}: ${result.detail}`}`);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, command);
  const segment = result.segments[0] as { class: string; rule: string; path?: string };
  return { class: segment.class, rule: segment.rule, ...(segment.path === undefined ? {} : { path: segment.path }) };
}

function refusal(command: string): string {
  const result = classifyCommand(command);
  assert.equal(result.ok, false, `${command} should be refused`);
  if (result.ok) throw new Error("unreachable");
  return result.code;
}

// ---------------------------------------------------------------------------
// F1: git remote
// ---------------------------------------------------------------------------

const REMOTE_READS: readonly string[] = [
  "git remote",
  "git remote -v",
  "git remote --verbose",
  "git remote -v -v",
  "git remote show origin",
  "git remote show -n origin",
  "git remote -v show origin upstream",
  "git remote get-url origin",
  "git remote get-url --push origin",
  "git remote get-url --all --push origin",
  "git remote get-url --no-push origin",
  "git remote update",
  "git remote update origin upstream",
  "git remote -v update origin",
  "git remote update --no-prune origin",
  "git --no-pager remote -v",
  // A word the shell expands is still only a name to these two.
  'git remote get-url "$R"',
  'git remote show "$R"',
];

for (const command of REMOTE_READS) {
  test(`git remote read stays read.vcs.remote: ${command}`, () => {
    assert.deepEqual(only(command), { class: "read.vcs.remote", rule: "git-remote-read" });
  });
}

const REMOTE_WRITES: readonly string[] = [
  // The F1 command itself, and the other mirror spellings.
  "git remote add --mirror=push m ../r.git",
  "git remote add --mirror=fetch m ../r.git",
  "git remote add --mirror m ../r.git",
  "git remote add m https://example.invalid/r.git",
  "git remote add -f -t main m ../r.git",
  "git remote -v add m ../r.git",
  "git remote set-url origin https://example.invalid/x.git",
  "git remote set-url --push origin ../r.git",
  "git remote set-url --add origin ../r.git",
  "git remote set-url --delete origin ../r.git",
  "git remote rename m origin",
  "git remote rename --no-progress m origin",
  "git remote remove m",
  "git remote rm m",
  "git remote set-head origin lane",
  "git remote set-head origin -a",
  "git remote set-head origin --delete",
  "git remote set-branches origin main",
  "git remote set-branches --add origin lane",
  "git remote prune origin",
  "git remote prune -n origin",
  "git remote prune --dry-run origin",
  "git remote update --prune",
  "git remote update -p origin",
  "git remote update --pru origin",
  "git remote -v update --prune",
  // Fail closed: options outside the closed read list, an unknown or
  // unreadable subcommand, and a `--`.
  "git remote show --verbose origin",
  "git remote show -- origin",
  "git remote get-url --bogus origin",
  "git remote update -v",
  'git remote update "$GROUP"',
  "git remote --verb",
  "git remote -vv",
  'git remote "$SUB" m ../r.git',
  "git remote frobnicate",
  "git remote $(printf add) m ../r.git",
];

for (const command of REMOTE_WRITES) {
  test(`git remote write is vcs.history.rewrite: ${command}`, () => {
    assert.deepEqual(only(command), { class: REWRITE, rule: "git-remote-write" });
  });
}

test("git fetch and git ls-remote are untouched by the remote split", () => {
  for (const command of ["git fetch origin", "git fetch --prune origin", "git ls-remote origin"]) {
    assert.deepEqual(only(command), { class: "read.vcs.remote", rule: "git-remote-read" }, command);
  }
});

test("the remote write class is emittable, so the dogfood coverage sees it", () => {
  assert.ok(CLASSIFIER_CLASSES.includes(REWRITE));
});

test("git config writes of remote.* keys stay refused (unclassified), the strictest answer there is", () => {
  for (const command of [
    "git config remote.m.mirror true",
    "git config remote.origin.push :refs/heads/main",
    "git config --add remote.origin.push +refs/heads/lane:refs/heads/main",
    "git config remote.origin.url ../r.git",
    "git config remote.origin.pushurl ../r.git",
    "git config set remote.m.mirror true",
    "git config --local Remote.m.Mirror true",
    "git config include.path /tmp/remote.cfg",
  ]) {
    assert.equal(refusal(command), "unclassified", command);
  }
});

test("a remote key set for one push through `git -c` is refused", () => {
  assert.notEqual(refusal("git -c remote.m.mirror=true push m"), undefined);
  assert.notEqual(refusal("git -c remote.origin.push=:refs/heads/main push origin"), undefined);
});

// ---------------------------------------------------------------------------
// F3: HEAD and @
// ---------------------------------------------------------------------------

test("isCurrentBranchRefspec: HEAD and @ in any case, colon-less, nothing else", () => {
  for (const word of ["HEAD", "head", "HeAd", "@"]) assert.equal(isCurrentBranchRefspec(word), true, word);
  for (const word of ["HEAD:lane", "+HEAD", "HEAD~1", "@{u}", "refs/heads/HEAD", "lane", "@@"]) {
    assert.equal(isCurrentBranchRefspec(word), false, word);
  }
});

const HEAD_PUSHES: readonly string[] = [
  "git push origin HEAD",
  "git push origin @",
  "git push -u origin HEAD",
  "git push --set-upstream origin @",
  "git push origin head",
  "git push origin HeAd",
  "git push origin HEAD lane",
  "git push --repo=origin origin HEAD",
];

for (const command of HEAD_PUSHES) {
  test(`HEAD/@ may be the trunk, so the pure reading is vcs.push.main: ${command}`, () => {
    assert.deepEqual(only(command), { class: "vcs.push.main", rule: "git-push-head" });
  });
}

test("HEAD with the trunk named elsewhere on the line keeps the trunk rule", () => {
  assert.deepEqual(only("git push origin HEAD main"), { class: "vcs.push.main", rule: "git-push-main" });
});

test("HEAD with an explicit destination is unmoved: the destination is on the line", () => {
  assert.deepEqual(only("git push origin HEAD:refs/heads/lane"), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(only("git push origin HEAD:lane"), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(only("git push origin HEAD:main"), { class: "vcs.push.main", rule: "git-push-main" });
  assert.equal(only("git push origin +HEAD").class, REWRITE);
  assert.equal(only("git push origin --delete HEAD").class, "vcs.ref.delete");
});

// ---------------------------------------------------------------------------
// gitPushSegmentClass under repository facts
// ---------------------------------------------------------------------------

function facts(overrides: Partial<PushRepoFacts> = {}): PushRepoFacts {
  return {
    head: "lane",
    headIsDefault: false,
    defaultBranch: null,
    remotes: new Map(),
    legacyRemotes: [],
    tags: new Set(),
    followTags: false,
    submodules: false,
    ...overrides,
  };
}

function under(command: string, repo: readonly PushRepoFacts[] | null): { class: string; rule: string; path?: string } {
  const answer = gitPushSegmentClass(command, repo);
  assert.ok(answer !== null, `${command} re-reads as one git push`);
  return answer;
}

test("HEAD/@ resolve to the current branch: a feature branch is a branch push, the trunk or a detached HEAD is the trunk", () => {
  assert.deepEqual(under("git push origin HEAD", [facts()]), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(under("git push -u origin @", [facts()]), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(under("git push origin HEAD", [facts({ head: "main", headIsDefault: true })]), {
    class: "vcs.push.main",
    rule: "git-push-head",
  });
  assert.deepEqual(under("git push origin @", [facts({ head: "develop", headIsDefault: true })]), {
    class: "vcs.push.main",
    rule: "git-push-head",
  });
  assert.deepEqual(under("git push origin HEAD", [facts({ head: null })]), { class: "vcs.push.main", rule: "git-push-head" });
});

test("several directories: the strictest answer wins (a cd that may fail leaves the shell where it was)", () => {
  assert.equal(under("git push origin HEAD", [facts(), facts({ head: "main", headIsDefault: true })]).class, "vcs.push.main");
});

test("HEAD/@ cannot be read: the trunk, since HEAD takes no configured mapping", () => {
  assert.deepEqual(under("git push origin HEAD", null), { class: "vcs.push.main", rule: "git-push-head" });
});

test("a mirror remote makes the push a mirror push, whatever its other words", () => {
  const mirror = facts({ remotes: new Map([["m", { mirror: true, push: [] }]]) });
  for (const command of ["git push m", "git push --tags m", "git push --all m", "git push m lane", "git push", "git push --repo=m"]) {
    assert.deepEqual(under(command, [mirror]), { class: REWRITE, rule: "git-push-config-mirror", path: "m" }, command);
  }
  // Another remote is not the mirror.
  assert.deepEqual(under("git push origin lane", [mirror]), { class: "vcs.push.branch", rule: "git-push-branch" });
});

test("configured push refspecs answer a refspec-less push and a colon-less one", () => {
  const remote = (push: string[]): PushRepoFacts => facts({ remotes: new Map([["origin", { mirror: false, push }]]) });
  assert.deepEqual(under("git push origin", [remote([":refs/heads/stale"])]), {
    class: "vcs.ref.delete",
    rule: "git-push-config-refspec",
    path: "refs/heads/stale",
  });
  assert.deepEqual(under("git push", [remote(["+refs/heads/x:refs/heads/main"])]), { class: REWRITE, rule: "git-push-config-refspec" });
  assert.deepEqual(under("git push origin lane", [remote(["+refs/heads/lane:refs/heads/main"])]), {
    class: REWRITE,
    rule: "git-push-config-refspec",
  });
  assert.deepEqual(under("git push origin lane", [remote(["refs/heads/lane:refs/heads/main"])]), {
    class: "vcs.push.main",
    rule: "git-push-config-refspec",
  });
  assert.deepEqual(under("git push origin lane", [remote(["+refs/heads/*:refs/heads/*"])]), {
    class: REWRITE,
    rule: "git-push-config-refspec",
  });
  // An explicit src:dst, a deletion's refs, and HEAD take no configured mapping.
  assert.deepEqual(under("git push origin lane:lane", [remote(["+refs/heads/*:refs/heads/*"])]), {
    class: "vcs.push.branch",
    rule: "git-push-branch",
  });
  assert.deepEqual(under("git push origin --delete stale", [remote(["refs/heads/stale:refs/heads/main"])]), {
    class: "vcs.ref.delete",
    rule: "git-ref-delete",
    path: "stale",
  });
  assert.deepEqual(under("git push origin HEAD", [remote(["+refs/heads/*:refs/heads/*"])]), {
    class: "vcs.push.branch",
    rule: "git-push-branch",
  });
});

test("a colon-less word naming a local tag publishes it; followTags and submodules add their classes", () => {
  assert.deepEqual(under("git push origin t1", [facts({ tags: new Set(["t1"]) })]), {
    class: "release.publish",
    rule: "git-push-local-tag",
    path: "t1",
  });
  assert.deepEqual(under("git push origin lane", [facts({ followTags: true })]), {
    class: "release.publish",
    rule: "git-push-config-tags",
  });
  assert.deepEqual(under("git push origin lane", [facts({ submodules: true })]), {
    class: "vcs.push.main",
    rule: "git-push-config-submodules",
  });
  assert.equal(under("git push origin --delete lane", [facts({ followTags: true, submodules: true })]).class, "vcs.ref.delete");
});

test("a legacy remotes/branches file the push may use is unreadable", () => {
  assert.deepEqual(under("git push old", [facts({ legacyRemotes: ["old"] })]), { class: REWRITE, rule: "git-push-config-unreadable" });
  assert.deepEqual(under("git push", [facts({ legacyRemotes: ["old"] })]), { class: REWRITE, rule: "git-push-config-unreadable" });
  assert.deepEqual(under("git push origin lane", [facts({ legacyRemotes: ["old"] })]), {
    class: "vcs.push.branch",
    rule: "git-push-branch",
  });
});

test("configuration that cannot be read: a push it decides is vcs.history.rewrite, an explicit one keeps its class", () => {
  for (const command of ["git push", "git push origin", "git push origin lane", "git push --tags origin", "git push -u origin lane"]) {
    assert.deepEqual(under(command, null), { class: REWRITE, rule: "git-push-config-unreadable" }, command);
  }
  assert.deepEqual(under("git push origin lane:lane", null), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.deepEqual(under("git push origin :stale", null), { class: "vcs.ref.delete", rule: "git-ref-delete", path: "stale" });
  assert.deepEqual(under("git push origin --delete lane", null), { class: "vcs.ref.delete", rule: "git-ref-delete", path: "lane" });
});

test("the segment re-read sees through the sandbox wrapper the classifier opens, and declines anything else", () => {
  assert.deepEqual(under("approval sandbox -- git push origin HEAD", [facts()]), { class: "vcs.push.branch", rule: "git-push-branch" });
  assert.equal(gitPushSegmentClass("git push origin lane && git push origin main", [facts()]), null);
  assert.equal(gitPushSegmentClass("env git push origin lane", [facts()]), null);
  assert.equal(gitPushSegmentClass("git push --exec=x origin lane", [facts()]), null);
});

test("GIT_PUSH_RULES names every rule a classified git push carries", () => {
  for (const command of [
    "git push origin lane",
    "git push origin main",
    "git push",
    "git push origin HEAD",
    "git push --force origin lane",
    "git push origin v1.2.3",
    "git push origin :lane",
    "git push --prune origin 'refs/heads/*:refs/heads/*'",
    'git push origin "$B"',
  ]) {
    assert.ok(GIT_PUSH_RULES.includes(only(command).rule), command);
  }
});

// ---------------------------------------------------------------------------
// The property: never looser than the pure classifier, but for HEAD
// ---------------------------------------------------------------------------

const REMOTE_WORDS = ["", "origin", "m", "../r.git"];
const OPTION_WORDS = ["", "-u", "--tags", "--all", "--delete", "-f", "--prune", "-n", "--follow-tags"];
const REFSPECS = ["", "lane", "main", "HEAD", "@", "lane:lane", "HEAD:main", ":stale", "+lane", "t1", "v1.2.3", "lane HEAD"];

const FACT_SETS: readonly (readonly PushRepoFacts[] | null)[] = [
  null,
  [facts()],
  [facts({ head: "main", headIsDefault: true })],
  [facts({ head: null })],
  [facts({ remotes: new Map([["m", { mirror: true, push: [] }]]) })],
  [facts({ remotes: new Map([["origin", { mirror: false, push: [":refs/heads/stale", "+refs/heads/*:refs/heads/*"] }]]) })],
  [facts({ tags: new Set(["t1"]), followTags: true, submodules: true })],
  [facts(), facts({ head: "main", headIsDefault: true })],
];

test("property: under any facts, a push is never looser than the pure classifier, except a HEAD/@ that resolves to a feature branch", () => {
  let checked = 0;
  for (const remote of REMOTE_WORDS) {
    for (const option of OPTION_WORDS) {
      for (const refspec of REFSPECS) {
        if (remote === "" && refspec !== "") continue;
        const command = ["git", "push", option, remote, refspec].filter((word) => word !== "").join(" ");
        const pure = classifyCommand(command);
        if (!pure.ok) continue;
        const segment = pure.segments[0] as { class: string; rule: string };
        for (const repo of FACT_SETS) {
          const answer = under(command, repo);
          checked += 1;
          if (ORDER.indexOf(answer.class) <= ORDER.indexOf(segment.class)) continue;
          // The one lowering: the pure HEAD rule, answered by a current branch.
          assert.equal(segment.rule, "git-push-head", `${command} under ${JSON.stringify(repo)}: ${answer.class} < ${segment.class}`);
          assert.equal(answer.class, "vcs.push.branch", command);
          assert.ok(repo !== null && repo.every((one) => one.head !== null && !one.headIsDefault), command);
        }
      }
    }
  }
  assert.ok(checked > 1000, `checked ${checked}`);
});

// ---------------------------------------------------------------------------
// Steer (#649 refutation): a write into .git arms a push; DWIM destinations
// ---------------------------------------------------------------------------

const GIT_DIR_WRITES: readonly (readonly [string, string])[] = [
  ["printf '[remote \"origin\"]\\n\\tpush = :refs/heads/lane\\n' >> .git/config", ".git/config"],
  ["echo x > .git/config", ".git/config"],
  ["tee -a .git/config", ".git/config"],
  ["cp /tmp/evil .git/hooks/pre-push", ".git/hooks/pre-push"],
  ["mv /tmp/cfg /repo/.git/config", "/repo/.git/config"],
  ['sed -i "" s/a/b/ .git/config', ".git/config"],
  ["sed -i s/a/b/ .GIT/config", ".GIT/config"],
  ["rm -f .git/index.lock", ".git/index.lock"],
  ["ln -sf /tmp/cfg .git/config", ".git/config"],
  ["cp a b --target-directory=.git", ".git"],
  ["curl -o .git/config https://example.invalid/x", ".git/config"],
  ["wget -O .git/config https://example.invalid/x", ".git/config"],
  ["echo gitdir: /x > .git", ".git"],
];

for (const [command, path] of GIT_DIR_WRITES) {
  test(`a write into a git directory is vcs.history.rewrite: ${command}`, () => {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, command);
    if (!result.ok) return;
    const hit = result.segments.find((segment) => segment.rule === "git-dir-write");
    assert.ok(hit !== undefined, `${command}: ${JSON.stringify(result.segments)}`);
    assert.equal(hit.class, REWRITE);
    assert.equal(hit.path, path);
  });
}

test("the F1 file-write chain is refused as a whole: the write is the rewrite class", () => {
  const result = classifyCommand("printf '[remote \"origin\"]\\n\\tpush = :refs/heads/lane\\n' >> .git/config && git push origin");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.classes.includes(REWRITE), JSON.stringify(result.classes));
});

test("reads of a git directory, .gitignore and prose naming .git are unmoved", () => {
  for (const command of ["cat .git/config", "ls .git", "head -5 .git/HEAD"]) {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, command);
    if (result.ok) assert.ok(result.segments.every((segment) => segment.rule !== "git-dir-write"), command);
  }
  assert.equal(only("echo x > .gitignore").class, "files.write.workspace");
  assert.equal(only("git add .gitignore").class, "vcs.commit.branch");
  assert.equal(only('git commit -m "fix the .git/config path"').class, "vcs.commit.branch");
  assert.equal(only("git --git-dir=/tmp/x/.git commit -m x").class, "vcs.commit.branch");
  assert.equal(only("git --git-dir=/tmp/x/.git log > .git/out").rule, "git-dir-write");
});

const DWIM_TRUNK: readonly string[] = [
  "git push origin lane:heads/main",
  "git push origin lane:heads/master",
  "git push origin lane:refs/heads/main",
  "git push origin heads/main",
  "git push origin refs/heads/main",
  "git push origin lane:MAIN",
  "git push origin lane:Master",
  "git push origin lane:refs/heads/Main",
];

for (const command of DWIM_TRUNK) {
  test(`a destination git resolves to the trunk is vcs.push.main: ${command}`, () => {
    assert.equal(only(command).class, "vcs.push.main");
  });
}

test("tags/ on either side is a tag (git tries refs/<name> first)", () => {
  assert.equal(only("git push origin lane:tags/t9").class, "release.publish");
  assert.equal(only("git push origin tags/t3").class, "release.publish");
});

test("non-trunk short destinations are unmoved", () => {
  for (const command of ["git push origin lane:heads/lane", "git push origin lane:remotes/origin/main", "git push origin lane:mainline"]) {
    assert.equal(only(command).class, "vcs.push.branch", command);
  }
});

test("the branch origin/HEAD names is a trunk when the checkout shows it", () => {
  const develop = facts({ defaultBranch: "develop" });
  assert.equal(under("git push origin lane:develop", [develop]).class, "vcs.push.main");
  assert.equal(under("git push origin lane:heads/develop", [develop]).class, "vcs.push.main");
  assert.equal(under("git push origin develop", [develop]).class, "vcs.push.main");
  assert.equal(under("git push origin lane:develop", [facts()]).class, "vcs.push.branch");
});
