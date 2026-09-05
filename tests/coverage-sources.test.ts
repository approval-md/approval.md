/**
 * The coverage sources (APRV-245): what git and `gh` actually witnessed.
 *
 * These are the halves of the report that leave this process, so the cases are
 * about the boundary rather than about the join. A real repository is built in a
 * temp directory with the same runner the source uses (`core/git-run.ts`), given
 * commits, a merge into a local trunk and a tag, and then asked what it saw.
 *
 * **Every git command in this file runs inside a temp repository.** Nothing here
 * touches this checkout, and nothing here writes an `events.jsonl` of any kind:
 * a source's whole job is to read a witness, and a test that had to write one
 * would be testing something else.
 *
 * The trunk ref is passed in as an option rather than assumed, which is what
 * lets a fixture with a local `main` and no remote exercise the `vcs.push.main`
 * arm at all: `defaultRange` and `DEFAULT_TRUNK_REF` speak of `origin/main`, and
 * a fixture repository has no origin.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { observeGh } from "../src/core/coverage-sources/gh.js";
import { defaultRange, observeGit } from "../src/core/coverage-sources/git.js";
import { git, onPath } from "../src/core/git-run.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-coverage-sources-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** git in the fixture, asserting success: a broken fixture is not a finding. */
function must(args: string[], root: string): string {
  const run = git(args, root);
  assert.equal(run.ok, true, `git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/** Write `path` and commit it, with an identity that belongs to no person. */
function commit(root: string, path: string, body: string, message: string): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  must(["add", "--", path], root);
  must(["commit", "-m", message], root);
  return must(["rev-parse", "HEAD"], root);
}

/**
 * A fixture repository with a local `main`, deterministic identity, and no
 * remote. The identity is set per-repository so no global git config is read
 * or written.
 */
function fixture(): string {
  counter += 1;
  const root = join(scratch, `repo-${counter}`);
  mkdirSync(root, { recursive: true });
  must(["init", "--initial-branch=main"], root);
  must(["config", "user.email", "fixture@example.invalid"], root);
  must(["config", "user.name", "Fixture"], root);
  must(["config", "commit.gpgsign", "false"], root);
  return root;
}

// ---------------------------------------------------------------------------
// git: commits, the trunk, merges, tags, protected paths
// ---------------------------------------------------------------------------

test("git reports every commit in the range, with the author as a hint", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  commit(root, "b.txt", "two\n", "second");
  const head = commit(root, "c.txt", "three\n", "third");

  const seen = observeGit(root, { base, head, trunk: "main" });
  assert.equal(seen.available, true, seen.reason ?? "");
  assert.equal(seen.effects.length, 2, JSON.stringify(seen.effects));
  for (const effect of seen.effects) {
    assert.equal(effect.source, "git");
    assert.equal(effect.actorHint, "fixture@example.invalid");
    assert.match(effect.at, /^\d{4}-\d\d-\d\dT/u);
  }
  // `base..head` is exclusive at the base, so the first commit is outside it.
  assert.equal(
    seen.effects.some((effect) => effect.id === base),
    false,
  );
});

test("a commit the trunk reaches is vcs.push.main; one it does not is vcs.commit.branch", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  const onTrunk = commit(root, "b.txt", "two\n", "on the trunk");

  must(["checkout", "-b", "side"], root);
  const offTrunk = commit(root, "c.txt", "three\n", "on a branch");

  const seen = observeGit(root, { base, head: "side", trunk: "main" });
  assert.equal(seen.available, true, seen.reason ?? "");
  const classes = new Map(seen.effects.map((effect) => [effect.id, effect.class]));
  assert.equal(classes.get(onTrunk), "vcs.push.main");
  assert.equal(classes.get(offTrunk), "vcs.commit.branch");
});

test("a commit a remote-tracking branch reaches is vcs.push.branch: it left the machine", () => {
  const remote = fixture();
  must(["config", "receive.denyCurrentBranch", "ignore"], remote);
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  must(["remote", "add", "origin", remote], root);

  must(["checkout", "-b", "demo/gated"], root);
  const pushed = commit(root, "b.txt", "two\n", "pushed to a branch");
  must(["push", "-u", "origin", "demo/gated"], root);
  const unpushed = commit(root, "c.txt", "three\n", "still local");

  const seen = observeGit(root, { base, head: "demo/gated", trunk: "main" });
  assert.equal(seen.available, true, seen.reason ?? "");
  const classes = new Map(seen.effects.map((effect) => [effect.id, effect.class]));
  assert.equal(classes.get(pushed), "vcs.push.branch");
  assert.equal(classes.get(unpushed), "vcs.commit.branch");
});

test("a merge into the trunk is a trunk commit and says merge in its detail", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  must(["checkout", "-b", "side"], root);
  commit(root, "c.txt", "three\n", "branch work");
  must(["checkout", "main"], root);
  must(["merge", "--no-ff", "-m", "Merge side", "side"], root);
  const merge = must(["rev-parse", "HEAD"], root);

  const seen = observeGit(root, { base, head: "main", trunk: "main" });
  const effect = seen.effects.find((entry) => entry.id === merge);
  assert.ok(effect !== undefined, "the merge commit was not reported");
  // No class of its own: the policy has none for a merge, and an effect nobody
  // can declare is an effect nothing can cover.
  assert.equal(effect.class, "vcs.push.main");
  assert.match(effect.detail, /^merge commit /u);
});

test("a tag whose target is in the range is reported as release.publish", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  const head = commit(root, "b.txt", "two\n", "second");
  must(["tag", "v9.9.9"], root);

  const seen = observeGit(root, { base, head, trunk: "main" });
  const tag = seen.effects.find((effect) => effect.id === "tag:v9.9.9");
  assert.ok(tag !== undefined, JSON.stringify(seen.effects));
  assert.equal(tag.class, "release.publish");
  assert.match(tag.detail, /^tag v9\.9\.9 on /u);
});

test("a tag outside the range is not reported", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  must(["tag", "v0.0.1"], root);
  const head = commit(root, "b.txt", "two\n", "second");

  const seen = observeGit(root, { base, head, trunk: "main" });
  assert.equal(
    seen.effects.some((effect) => effect.id === "tag:v0.0.1"),
    false,
  );
});

test("a protected path a commit changed is its own policy.edit effect carrying the path", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  // `CLAUDE.md` is protected by the classifier's own built-in list, so this
  // case needs no policy at all.
  const head = commit(root, "CLAUDE.md", "# instructions\n", "edit the instructions");

  const seen = observeGit(root, { base, head, trunk: "main" });
  const edit = seen.effects.find((effect) => effect.class === "policy.edit");
  assert.ok(edit !== undefined, JSON.stringify(seen.effects));
  assert.equal(edit.path, "CLAUDE.md");
  // Its own effect, beside the commit's, so the join can put the guard's
  // byte-level verdict against the path and the class-and-window rule against
  // the commit.
  assert.equal(
    seen.effects.filter((effect) => effect.id === head).length,
    1,
  );
});

test("a path the POLICY names is protected too, and one it does not name is not", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  const head = commit(root, "release.yml", "on: push\n", "touch the release config");

  const bare = observeGit(root, { base, head, trunk: "main" });
  assert.equal(
    bare.effects.some((effect) => effect.class === "policy.edit"),
    false,
  );
  const widened = observeGit(root, {
    base,
    head,
    trunk: "main",
    policyProtectedPaths: ["release.yml"],
  });
  assert.equal(
    widened.effects.some((effect) => effect.class === "policy.edit"),
    true,
  );
});

test("the commit bound truncates and says so rather than reporting a short answer", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  commit(root, "b.txt", "two\n", "second");
  commit(root, "c.txt", "three\n", "third");
  const head = commit(root, "d.txt", "four\n", "fourth");

  const seen = observeGit(root, { base, head, trunk: "main", maxCommits: 1 });
  assert.equal(seen.available, true);
  assert.equal(seen.effects.filter((effect) => effect.class !== "policy.edit").length, 1);
  assert.match(seen.reason ?? "", /beyond the 1-commit bound/u);
});

// ---------------------------------------------------------------------------
// git: unavailable is reported, never inferred
// ---------------------------------------------------------------------------

test("a directory that is not a checkout is unavailable, not an empty answer", () => {
  const plain = join(scratch, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  const seen = observeGit(plain, { base: "a", head: "b" });
  assert.equal(seen.available, false);
  assert.equal(seen.reason, "not a git checkout");
  assert.deepEqual(seen.effects, []);
});

test("a ref that does not resolve is unavailable with git's own words", () => {
  const root = fixture();
  commit(root, "a.txt", "one\n", "first");
  const seen = observeGit(root, { base: "no-such-ref", head: "HEAD", trunk: "main" });
  assert.equal(seen.available, false);
  assert.match(seen.reason ?? "", /git log no-such-ref\.\.HEAD failed/u);
});

test("an unresolvable trunk reports every commit as a branch commit and says why", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  const head = commit(root, "b.txt", "two\n", "second");
  // The lower claim about an unknown: with nothing to compare against, no
  // commit is asserted to be on the trunk.
  const seen = observeGit(root, { base, head, trunk: "origin/main" });
  assert.equal(seen.available, true);
  assert.equal(seen.effects[0]?.class, "vcs.commit.branch");
  assert.match(seen.reason ?? "", /origin\/main does not resolve/u);
});

// ---------------------------------------------------------------------------
// defaultRange
// ---------------------------------------------------------------------------

test("defaultRange takes the merge base when the trunk resolves", () => {
  const root = fixture();
  const base = commit(root, "a.txt", "one\n", "first");
  must(["checkout", "-b", "side"], root);
  commit(root, "b.txt", "two\n", "branch work");

  const range = defaultRange(root, "main");
  assert.equal(range.base, base);
  assert.equal(range.head, "HEAD");
  assert.equal(range.note, undefined);
});

test("defaultRange falls back to the last twenty commits and ANNOUNCES the guess", () => {
  const root = fixture();
  commit(root, "a.txt", "one\n", "first");
  const range = defaultRange(root, "origin/main");
  assert.equal(range.base, "HEAD~20");
  // A reader has to be able to see that the answer came from a guess.
  assert.match(range.note ?? "", /does not resolve here/u);
});

// ---------------------------------------------------------------------------
// gh: absent is reported, never inferred
// ---------------------------------------------------------------------------

test("gh off the PATH is an unavailable source with a reason and no effects", () => {
  const empty = join(scratch, "empty-path");
  mkdirSync(empty, { recursive: true });
  const root = fixture();
  commit(root, "a.txt", "one\n", "first");

  const savedPath = process.env["PATH"];
  process.env["PATH"] = empty;
  try {
    assert.equal(onPath("gh", root), false, "gh was still reachable with an emptied PATH");
    const seen = observeGh(root, {
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(seen.available, false);
    assert.equal(seen.reason, "gh is not on PATH");
    assert.deepEqual(seen.effects, []);
  } finally {
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  }
});

test("a repository gh cannot answer for is unavailable with gh's own words", () => {
  const root = fixture();
  commit(root, "a.txt", "one\n", "first");
  const seen = observeGh(root, {
    since: "2026-01-01T00:00:00.000Z",
    until: "2026-12-31T00:00:00.000Z",
  });
  // The fixture has no remote, so gh has nothing to list. Either way — gh
  // absent, or gh present and refusing — the source reports unavailable with a
  // reason and contributes no effects. "gh could not be asked" and "gh saw
  // nothing" must never collapse into each other.
  assert.equal(seen.available, false);
  assert.ok((seen.reason ?? "").length > 0, "an unavailable source gave no reason");
  assert.deepEqual(seen.effects, []);
});
