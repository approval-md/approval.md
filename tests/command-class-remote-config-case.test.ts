/**
 * APRV-518 under letter case.
 *
 * APFS and the default macOS volume fold case, and main's no-rule guard
 * already refuses an upper-case command word for that reason (F-12 fold,
 * SEC-2/SEC-3). Each APRV-518 rule must hold the same way: an upper-case or
 * mixed-case spelling of a command is classified at least as strictly as the
 * lower-case one, or refused, with the default options and under
 * `noRuleSegments` (`defaults.unclassified_command: abstain`).
 *
 * Four spellings were looser before this file's commit, and are fixed there:
 * a destination prefix in another case (`lane:refs/HEADS/main`,
 * `lane:HEADS/MAIN`), a tag prefix in another case (`TAGS/v1`,
 * `lane:refs/TAGS/v1`), a legacy remotes file named in another case
 * (`git push OLD` reads `remotes/old`), and a local tag named in another case
 * (`git push origin V1` pushes the loose `refs/tags/v1`). The last part runs
 * real git on a bare local remote and checks each case's class against what
 * git did, so the test says what this filesystem does rather than assuming it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand, gitPushSegmentClass, type PushRepoFacts } from "../src/core/command-class.js";

/** Strictest first; a refusal is stricter than every class. */
const ORDER = [
  "vcs.history.rewrite",
  "release.publish",
  "vcs.ref.delete",
  "vcs.push.main",
  "vcs.push.branch",
  "files.write.workspace",
  "vcs.commit.branch",
  "read.vcs.remote",
  "read.shell",
];

function rank(cls: string): number {
  const at = ORDER.indexOf(cls);
  assert.notEqual(at, -1, `a class this file ranks: ${cls}`);
  return ORDER.length - at;
}

const REFUSED = 1_000;

/** The strictness of a whole line: a refusal, or its strictest class. */
function strictness(command: string, noRule: boolean): { score: number; shown: string } {
  const result = classifyCommand(command, [], noRule ? { noRuleSegments: true, noRuleCwds: ["/Users/oracle/work"] } : {});
  if (!result.ok) return { score: REFUSED, shown: `refused (${result.code})` };
  return {
    score: Math.max(...result.classes.map(rank)),
    shown: result.segments.map((segment) => `${segment.class} (${segment.rule})`).join(", "),
  };
}

/** Each APRV-518 rule: the lower-case line, and spellings of it in other cases. */
const RULES: readonly { rule: string; lower: string; folded: readonly string[] }[] = [
  {
    rule: "git-remote-write (mirror add)",
    lower: "git remote add --mirror=push m https://example.com/r.git",
    folded: [
      "GIT REMOTE ADD --mirror=push m https://example.com/r.git",
      "Git remote add --mirror=push m https://example.com/r.git",
      "git REMOTE add --mirror=push m https://example.com/r.git",
      "git Remote add --mirror=push m https://example.com/r.git",
      "git remote ADD --mirror=push m https://example.com/r.git",
      "git remote Add --MIRROR=PUSH m https://example.com/r.git",
    ],
  },
  {
    rule: "git-remote-write (set-url, rename, prune)",
    lower: "git remote set-url origin https://example.com/r.git",
    folded: [
      "GIT remote set-url origin https://example.com/r.git",
      "git remote SET-URL origin https://example.com/r.git",
      "git remote Rename origin m",
      "git remote PRUNE origin",
      "git remote update --PRUNE",
      "git remote Update -P",
    ],
  },
  {
    rule: "git-remote-read stays the floor: the read list in another case is stricter, never looser",
    lower: "git remote -v",
    folded: ["git remote -V", "git remote SHOW origin", "git remote Get-Url origin", "git remote UPDATE", "GIT remote -v", "Git Remote"],
  },
  {
    rule: "git-dir-write (rm, redirect, tee, cp, sed -i, curl -o)",
    lower: "rm -f .git/index.lock",
    folded: [
      "rm -f .GIT/index.lock",
      "rm -f .Git/INDEX.LOCK",
      "RM -f .git/index.lock",
      "Rm -f .git/index.lock",
      "printf x >> .GIT/CONFIG",
      "PRINTF x >> .git/config",
      "tee -a .Git/Config",
      "TEE -a .git/config",
      "cp x .GIT/hooks/pre-push",
      "CP x .git/hooks/pre-push",
      "sed -i s/a/b/ .GIT/config",
      "curl -o .GIT/config https://example.com/c",
      "CURL -o .git/config https://example.com/c",
    ],
  },
  {
    rule: "git-config-file-write",
    lower: "printf x >> ~/.gitconfig",
    folded: [
      "printf x >> ~/.GITCONFIG",
      "printf x >> ~/.GitConfig",
      "cp x ~/.CONFIG/GIT/config",
      "cp x ~/.Config/git/Config",
      "printf x >> /ETC/GITCONFIG",
      "printf x >> /etc/GitConfig",
      "PRINTF x >> ~/.gitconfig",
    ],
  },
  {
    rule: "git-push-head",
    lower: "git push origin HEAD",
    folded: [
      "git push origin head",
      "git push origin Head",
      "git push origin hEaD",
      "GIT push origin HEAD",
      "git PUSH origin HEAD",
      "Git Push origin HEAD",
      "GIT PUSH ORIGIN HEAD",
      "GIT push -u origin @",
    ],
  },
  {
    rule: "destination resolution (heads/x, refs/heads/x)",
    lower: "git push origin lane:heads/main",
    folded: [
      "git push origin lane:HEADS/MAIN",
      "git push origin lane:Heads/Main",
      "git push origin lane:refs/HEADS/main",
      "git push origin lane:REFS/heads/main",
      "git push origin lane:REFS/HEADS/MAIN",
      "git push origin lane:Refs/Heads/Master",
      "git push origin HEADS/main",
      "git push origin Heads/Master",
      "GIT push origin lane:heads/main",
    ],
  },
  {
    rule: "destination resolution (tags/x, refs/tags/x)",
    lower: "git push origin tags/v1",
    folded: [
      "git push origin TAGS/v1",
      "git push origin Tags/V1",
      "git push origin lane:REFS/TAGS/v1",
      "git push origin lane:refs/TAGS/v1",
      "git push origin lane:Tags/v1",
      "git push origin --delete TAGS/v1",
    ],
  },
  {
    rule: "the trust rule, a concurrent segment, a cd",
    lower: "git checkout main && git push origin HEAD",
    folded: [
      "GIT checkout main && git push origin HEAD",
      "git CHECKOUT main && git push origin HEAD",
      "git checkout main && GIT push origin HEAD",
      "CD /tmp && git push origin",
      "Cd /tmp; git push origin",
      "git status | GIT push origin",
      "PUSHD /tmp && git push origin",
    ],
  },
];

for (const { rule, lower, folded } of RULES) {
  test(`letter case: ${rule} is at least as strict as \`${lower}\`, or refused`, () => {
    for (const noRule of [false, true]) {
      const floor = strictness(lower, noRule);
      for (const command of folded) {
        const got = strictness(command, noRule);
        assert.ok(
          got.score >= floor.score,
          `${noRule ? "noRuleSegments" : "default"}: \`${command}\` is ${got.shown}, looser than \`${lower}\` (${floor.shown})`,
        );
      }
    }
  });
}

test("letter case: the four spellings that were looser now take the lower-case class", () => {
  const exact = (command: string): string => {
    const result = classifyCommand(command, []);
    assert.equal(result.ok, true, command);
    return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`).join(", ") : "";
  };
  assert.equal(exact("git push origin lane:refs/HEADS/main"), "vcs.push.main git-push-main");
  assert.equal(exact("git push origin lane:HEADS/MAIN"), "vcs.push.main git-push-main");
  assert.equal(exact("git push origin Heads/Master"), "vcs.push.main git-push-main");
  assert.equal(exact("git push origin TAGS/v1"), "release.publish git-push-tag");
  assert.equal(exact("git push origin lane:refs/TAGS/v1"), "release.publish git-push-tag");
});

// ---------------------------------------------------------------------------
// What the checkout says, under letter case (pure: facts handed in)
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

test("letter case: a legacy remotes file and a local tag are matched without case", () => {
  for (const word of ["old", "OLD", "Old"]) {
    assert.deepEqual(gitPushSegmentClass(`git push ${word}`, [facts({ legacyRemotes: ["old"] })]), {
      class: "vcs.history.rewrite",
      rule: "git-push-config-unreadable",
    });
  }
  for (const word of ["v1", "V1", "+V1"]) {
    assert.deepEqual(gitPushSegmentClass(`git push origin ${word}`, [facts({ tags: new Set(["v1"]) })])?.class, word.startsWith("+") ? "vcs.history.rewrite" : "release.publish", word);
  }
  assert.deepEqual(gitPushSegmentClass("git push origin V1", [facts({ tags: new Set(["v1"]) })]), {
    class: "release.publish",
    rule: "git-push-local-tag",
    path: "V1",
  });
  // A HEAD on a branch whose name is the trunk in another case is the trunk.
  assert.equal(gitPushSegmentClass("git push origin HEAD", [facts({ head: "MAIN" })])?.class, "vcs.push.main");
  assert.equal(gitPushSegmentClass("git push origin HEAD", [facts({ head: "Develop", defaultBranch: "develop" })])?.class, "vcs.push.main");
  // An upper-case git binary is not re-read as a push: the hook then fails closed.
  assert.equal(gitPushSegmentClass("GIT push origin HEAD", [facts()]), null);
});

// ---------------------------------------------------------------------------
// Real git on this filesystem: the class is at least what git did
// ---------------------------------------------------------------------------

const work = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-push-case-")));
after(() => rmSync(work, { recursive: true, force: true }));

const HOME = join(work, "home");
mkdirSync(HOME);
writeFileSync(
  join(HOME, ".gitconfig"),
  ["[user]", "\tname = Case Oracle", "\temail = oracle@example.invalid", "[init]", "\tdefaultBranch = main", ""].join("\n"),
);
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
process.env["GIT_TERMINAL_PROMPT"] = "0";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];

const ENV: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

function git(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function ok(cwd: string, args: readonly string[]): string {
  const ran = git(cwd, args);
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout.trim();
}

const GIT = spawnSync("git", ["--version"], { env: ENV }).status === 0;

let fixtures = 0;

/** Remote: `main` and `stale` at c0. Clone: `main` at c1 (a fast-forward), on branch `lane`, a loose tag `v1`. */
function fixture(): { remote: string; clone: string } {
  fixtures += 1;
  const root = join(work, `case-${String(fixtures)}`);
  mkdirSync(root);
  const remote = join(root, "remote.git");
  const clone = join(root, "clone");
  ok(root, ["init", "-q", "--bare", remote]);
  ok(root, ["init", "-q", clone]);
  ok(clone, ["remote", "add", "origin", "../remote.git"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "c0"]);
  ok(clone, ["push", "-q", "origin", "main", "main:refs/heads/stale"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "c1"]);
  ok(clone, ["tag", "v1"]);
  ok(clone, ["checkout", "-q", "-b", "lane"]);
  return { remote, clone };
}

function refsOf(dir: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of ok(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n")) {
    const [ref, sha] = line.split(" ");
    if (ref !== undefined && sha !== undefined && ref !== "") refs.set(ref.toLowerCase(), sha);
  }
  return refs;
}

/** The class git's observed effect needs at least. */
function floorOf(before: Map<string, string>, afterRefs: Map<string, string>): { floor: string; effect: string[] } {
  const effect: string[] = [];
  let floor = "vcs.push.branch";
  const raise = (cls: string, what: string): void => {
    effect.push(what);
    if (ORDER.indexOf(cls) < ORDER.indexOf(floor)) floor = cls;
  };
  for (const ref of new Set([...before.keys(), ...afterRefs.keys()])) {
    const was = before.get(ref);
    const now = afterRefs.get(ref);
    if (was === now) continue;
    if (ref.startsWith("refs/tags/")) raise("release.publish", `tag ${ref}`);
    else if (now === undefined) raise("vcs.ref.delete", `removed ${ref}`);
    else if (ref === "refs/heads/main") raise("vcs.push.main", "trunk moved");
    else raise("vcs.push.branch", `moved ${ref}`);
  }
  return { floor, effect };
}

const CASES: readonly { name: string; setup?: (clone: string) => void; command: string; argv: readonly string[] }[] = [
  {
    name: "a legacy remotes file, named in another case",
    setup: (clone) => {
      mkdirSync(join(clone, ".git", "remotes"), { recursive: true });
      writeFileSync(join(clone, ".git", "remotes", "old"), "URL: ../remote.git\nPush: :refs/heads/stale\n");
    },
    command: "git push OLD",
    argv: ["push", "OLD"],
  },
  { name: "a loose local tag, named in another case", command: "git push origin V1", argv: ["push", "origin", "V1"] },
  { name: "a tag prefix in another case", command: "git push origin TAGS/v1", argv: ["push", "origin", "TAGS/v1"] },
  { name: "a destination prefix in another case", command: "git push origin lane:refs/HEADS/main", argv: ["push", "origin", "lane:refs/HEADS/main"] },
  { name: "a short destination in another case", command: "git push origin lane:HEADS/MAIN", argv: ["push", "origin", "lane:HEADS/MAIN"] },
  { name: "HEAD in another case, on the trunk", setup: (clone) => ok(clone, ["checkout", "-q", "main"]), command: "git push origin head", argv: ["push", "origin", "head"] },
  {
    name: "a mirror remote named in another case is another remote: git pushes nowhere",
    setup: (clone) => ok(clone, ["remote", "add", "--mirror=push", "m", "../remote.git"]),
    command: "git push M",
    argv: ["push", "M"],
  },
];

for (const each of CASES) {
  test(`real git, letter case: ${each.name}: the hook's class is at least what git did`, { skip: GIT ? false : "no git binary" }, () => {
    const { remote, clone } = fixture();
    each.setup?.(clone);
    const refined = classifyForHook(each.command, [], clone);
    assert.equal(refined.result.ok, true, JSON.stringify(refined.result));
    if (!refined.result.ok) return;
    const got = refined.result.segments[0]?.class ?? "";
    const before = refsOf(remote);
    git(clone, each.argv);
    const { floor, effect } = floorOf(before, refsOf(remote));
    assert.ok(
      ORDER.indexOf(got) <= ORDER.indexOf(floor),
      `${each.command}: classified ${got}, but git did ${effect.join(", ")} (needs ${floor})`,
    );
  });
}
