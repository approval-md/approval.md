/**
 * Remote ref deletion is its own class (APRV-352).
 *
 * Found while building the APRV-318 branch-deletion driver: a `git push` that
 * removes remote refs classified `vcs.push.main`, this repository holds that
 * class at `supervised-retro`, and 233 irreversible deletions would therefore
 * have proceeded unasked and been sampled afterwards. The driver worked around
 * it by demanding a grant record before `--execute`; the fix is a class.
 *
 * The three things this suite pins:
 *
 * 1. every spelling of a deletion — the `--delete`/`-d` flag, the colon
 *    refspec, and bulk forms mixing several — is `vcs.ref.delete`, with the ref
 *    names BOUND, so an approver is told what is about to disappear;
 * 2. nothing else moved. An ordinary push is still `vcs.push.branch` or
 *    `vcs.push.main`, a force push is still `vcs.history.rewrite` (human-only
 *    in this repository), and a TAG deletion is still `release.publish`,
 *    because deleting the name a release was published under is a release act
 *    whichever spelling removes it;
 * 3. the class is enumerable: it is in the `git-push` row's `emits`, so
 *    `CLASSIFIER_CLASSES` carries it and the dogfood coverage test can see it.
 *
 * Pure: no disk, no clock, no log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLASSIFIER_CLASSES,
  COMMAND_RULES,
  classifyCommand,
  emittableClass,
} from "../src/core/command-class.js";

const REF_DELETE = "vcs.ref.delete";

function only(command: string): { class: string; rule: string; path?: string } {
  const result = classifyCommand(command);
  assert.equal(
    result.ok,
    true,
    `expected ${JSON.stringify(command)} to classify, got ${
      result.ok ? "" : `${result.code}: ${result.detail}`
    }`,
  );
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, command);
  return result.segments[0] as { class: string; rule: string; path?: string };
}

// ---------------------------------------------------------------------------
// Criterion 1: every spelling, with the refs bound
// ---------------------------------------------------------------------------

const DELETIONS: readonly (readonly [string, string])[] = [
  // The flag form, long and short.
  ["git push origin --delete feature/x", "feature/x"],
  ["git push origin -d feature/x", "feature/x"],
  ["git push --delete origin feature/x", "feature/x"],
  ["git push origin --delete refs/heads/feature/x", "refs/heads/feature/x"],
  // The colon refspec, fully qualified and short.
  ["git push origin :refs/heads/x", "refs/heads/x"],
  ["git push origin :x", "x"],
  // Bulk: several refs behind one flag, and several colon refspecs.
  ["git push origin --delete a b c", "a b c"],
  ["git push origin :a :b :c", "a b c"],
  // A bulk form mixing a deletion with an ordinary push. One deleting refspec
  // makes the whole command a deletion: the command's effect is the union of
  // its refspecs, and the destructive half is the half a person is being asked
  // about.
  ["git push origin feature :stale", "stale"],
  // The other empty side, which this classifier has always read as a deletion.
  ["git push origin stale:", "stale"],
];

for (const [command, refs] of DELETIONS) {
  test(`ref deletion: ${command}`, () => {
    const segment = only(command);
    assert.equal(segment.class, REF_DELETE, command);
    assert.equal(segment.rule, "git-ref-delete", command);
    assert.equal(segment.path, refs, `${command} should bind ${refs}`);
  });
}

test("a --delete naming no ref at all stays in the class, with nothing bound", () => {
  // A git error, and the invocation that least deserves the looser answer:
  // targets the classifier cannot read must not fall through to a push class.
  const segment = only("git push origin --delete");
  assert.equal(segment.class, REF_DELETE);
  assert.equal(segment.rule, "git-ref-delete");
  assert.equal(segment.path, undefined);
});

test("a ref name the classifier cannot expand is still a deletion", () => {
  const segment = only("git push origin --delete $BRANCH");
  assert.equal(segment.class, REF_DELETE);
  assert.equal(segment.path, "$BRANCH");
});

// ---------------------------------------------------------------------------
// Criterion 2: nothing else moved
// ---------------------------------------------------------------------------

const UNMOVED: readonly (readonly [string, string, string])[] = [
  ["git push origin main", "vcs.push.main", "git-push-main"],
  ["git push origin master", "vcs.push.main", "git-push-main"],
  ["git push origin HEAD:main", "vcs.push.main", "git-push-main"],
  ["git push", "vcs.push.main", "git-push-implicit"],
  ["git push origin feature/x", "vcs.push.branch", "git-push-branch"],
  ["git push -u origin feature/x", "vcs.push.branch", "git-push-branch"],
  ["git push --force origin main", "vcs.history.rewrite", "git-push-force"],
  ["git push --force-with-lease origin feature/x", "vcs.history.rewrite", "git-push-force"],
  ["git push --mirror origin", "vcs.history.rewrite", "git-push-force"],
  ["git push origin +refs/heads/x", "vcs.history.rewrite", "git-push-force"],
  // Tags. A deletion under a tag pattern keeps the release class it has today:
  // stricter here (`manual`) than the new one would be, and the name a release
  // was published under is a release surface however it is removed.
  ["git push origin --delete refs/tags/v1.2.3", "release.publish", "git-push-tag"],
  ["git push origin -d refs/tags/v1.2.3", "release.publish", "git-push-tag"],
  ["git push origin :refs/tags/v1.2.3", "release.publish", "git-push-tag"],
  ["git push origin :v1.2.3", "release.publish", "git-push-tag"],
  ["git push --tags origin", "release.publish", "git-push-tag"],
  // A bulk deletion that mixes a tag in takes the tag class for the whole
  // command, which is the stricter of the two and the direction §11.1 requires.
  ["git push origin --delete feature/x refs/tags/v1.2.3", "release.publish", "git-push-tag"],
];

for (const [command, cls, rule] of UNMOVED) {
  test(`unchanged: ${command}`, () => {
    const segment = only(command);
    assert.equal(segment.class, cls, command);
    assert.equal(segment.rule, rule, command);
  });
}

test("a force push that also deletes is still a rewrite", () => {
  // `vcs.history.rewrite` is human-only in this repository (APRV-185), and the
  // force check sits above the deletion check so the stricter class wins.
  const segment = only("git push --force origin --delete feature/x");
  assert.equal(segment.class, "vcs.history.rewrite");
  assert.equal(segment.rule, "git-push-force");
});

// ---------------------------------------------------------------------------
// Criterion 3: the class is enumerable
// ---------------------------------------------------------------------------

test("the git-push row declares vcs.ref.delete in its emits", () => {
  const row = COMMAND_RULES.find((candidate) => candidate.id === "git-push");
  assert.notEqual(row, undefined);
  assert.ok(row?.emits?.includes(REF_DELETE), `git-push emits: ${String(row?.emits)}`);
});

test("vcs.ref.delete is in CLASSIFIER_CLASSES and is emittable with no policy at all", () => {
  assert.ok(CLASSIFIER_CLASSES.includes(REF_DELETE), CLASSIFIER_CLASSES.join(","));
  assert.equal(emittableClass(REF_DELETE), true);
});
