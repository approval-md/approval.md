/**
 * `git push` through git 2.50's option grammar (APRV-517).
 *
 * The APRV-648 refutation (finding S2) found `git push -ud`, `-du`, `--del`
 * and `--de` deleting the remote branch while classifying as a plain push:
 * `vcs.push.branch` (autonomous here) for a branch and `vcs.push.main`
 * (supervised-retro) for the trunk, so `vcs.ref.delete` (manual) was never
 * asked. This file pins the closed rule that replaced the exact-spelling
 * flag scan:
 *
 * 1. every short bundle and every unique long-option abbreviation git accepts
 *    classifies at least as strictly as the spelled-out option;
 * 2. a deletion in any form (flag, empty-source refspec, `--prune`) is
 *    `vcs.ref.delete` or stricter;
 * 3. what the grammar cannot walk is refused or read as the strictest push:
 *    an option git refuses, an ambiguous abbreviation, a far-side program, a
 *    word the shell may expand, an environment that steers git's config;
 * 4. nothing ordinary moved.
 *
 * Pure: no disk, no clock, no log. The real-git half is
 * tests/git-push-delete-spellings.test.ts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { COMMAND_RULES, classifyCommand } from "../src/core/command-class.js";
import { GIT_PUSH_OPTIONS, parseGitPushArgv } from "../src/core/git-push-argv.js";

type Answer = readonly [cls: string, rule: string, path?: string];

function answer(command: string): Answer | readonly ["refused", string] {
  const result = classifyCommand(command);
  if (!result.ok) return ["refused", result.code];
  assert.equal(result.segments.length, 1, command);
  const segment = result.segments[0] as { class: string; rule: string; path?: string };
  return segment.path === undefined ? [segment.class, segment.rule] : [segment.class, segment.rule, segment.path];
}

function pin(rows: readonly (readonly [string, readonly string[]])[]): void {
  for (const [command, expected] of rows) {
    test(`git push grammar: ${command}`, () => {
      assert.deepEqual(answer(command), expected, command);
    });
  }
}

const DELETE = "vcs.ref.delete";
const REWRITE = "vcs.history.rewrite";

// ---------------------------------------------------------------------------
// 1 and 2. Deletions in every spelling git accepts
// ---------------------------------------------------------------------------

pin([
  // Finding S2, verbatim.
  ["git push -ud origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -du origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push --del origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push --de origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -ud origin main", [DELETE, "git-ref-delete", "main"]],
  ["git push --del origin main", [DELETE, "git-ref-delete", "main"]],
  // Every unique prefix of --delete; `--d` is ambiguous with --dry-run.
  ["git push --dele origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push --delet origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push origin --de lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push --d origin lane", ["refused", "opaque"]],
  // Other bundles carrying d. A dry run is still read as the deletion it names.
  ["git push -dn origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -nd origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -qd origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -dv origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -4d origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -d6 origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -duq origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -fd origin lane", [REWRITE, "git-push-force"]],
  ["git push -df origin lane", [REWRITE, "git-push-force"]],
  // `-o` takes the rest of its bundle, or the next word, as its value.
  ["git push -dofoo origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -do foo origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -o foo -d origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push -od origin lane", ["vcs.push.branch", "git-push-branch"]],
  // A value-taking long option consumes its word.
  ["git push --repo origin --de origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push --push-option=x --de origin lane", [DELETE, "git-ref-delete", "lane"]],
  // Refspecs with an empty source, plain and forced.
  ["git push origin :lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push origin :refs/heads/lane", [DELETE, "git-ref-delete", "refs/heads/lane"]],
  ["git push origin +:lane", [REWRITE, "git-push-force"]],
  ["git push origin lane:lane :stale", [DELETE, "git-ref-delete", "stale"]],
  ["git push -- origin :lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push --end-of-options origin :lane", [DELETE, "git-ref-delete", "lane"]],
  // --prune removes the remote refs a pattern no longer matches; nothing is bound.
  ["git push --prune origin lane", [DELETE, "git-push-prune"]],
  ["git push --pru origin lane", [DELETE, "git-push-prune"]],
  ["git push --prun --all origin", [DELETE, "git-push-prune"]],
  ["git push --prune --branches origin", [DELETE, "git-push-prune"]],
  ["git push --no-pru origin lane", ["vcs.push.branch", "git-push-branch"]],
  // --mirror forces and deletes; every prefix of it is unique.
  ["git push --mirror origin", [REWRITE, "git-push-force"]],
  ["git push --mirr origin", [REWRITE, "git-push-force"]],
  ["git push --m origin", [REWRITE, "git-push-force"]],
  // A global option in front of push no longer shifts the positionals.
  ["git --no-pager push -ud origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git -P push --del origin main", [DELETE, "git-ref-delete", "main"]],
  // Tags keep the release class above the deletion one, as before.
  ["git push --de origin refs/tags/v1.2.3", ["release.publish", "git-push-tag"]],
  ["git push -ud origin v1.2.3", ["release.publish", "git-push-tag"]],
]);

// ---------------------------------------------------------------------------
// 1. Force, tag and all-branch abbreviations, which the same walk reads
// ---------------------------------------------------------------------------

pin([
  ["git push -uf origin lane", [REWRITE, "git-push-force"]],
  ["git push -fu origin lane", [REWRITE, "git-push-force"]],
  ["git push --force-w origin lane", [REWRITE, "git-push-force"]],
  ["git push --force-with=lane:abc origin lane", [REWRITE, "git-push-force"]],
  ["git push --force-i origin lane", [REWRITE, "git-push-force"]],
  // `--fo`, `--for`, `--forc` are ambiguous among the three force options.
  ["git push --forc origin lane", ["refused", "opaque"]],
  ["git push --ta origin lane", ["release.publish", "git-push-tag"]],
  ["git push --fol origin lane", ["release.publish", "git-push-tag"]],
  ["git push --al origin", ["vcs.push.main", "git-push-implicit"]],
  ["git push --b origin", ["vcs.push.main", "git-push-implicit"]],
  ["git push --recurse-submodules=on-demand origin lane", ["vcs.push.main", "git-push-main"]],
  ["git push --recurse-submodules check origin lane", ["vcs.push.branch", "git-push-branch"]],
]);

// ---------------------------------------------------------------------------
// 3. What the walk cannot read
// ---------------------------------------------------------------------------

pin([
  // git refuses these itself; so does the classifier.
  ["git push --frob origin lane", ["refused", "opaque"]],
  ["git push -x origin lane", ["refused", "opaque"]],
  ["git push --de=1 origin lane", ["refused", "opaque"]],
  ["git push --no-de=1 origin lane", ["refused", "opaque"]],
  ["git push origin lane --repo", ["refused", "opaque"]],
  ["git push --n origin lane", ["refused", "opaque"]],
  ["git push --v origin lane", ["refused", "opaque"]],
  // A far-side program: for a local or file:// remote it runs here.
  ["git push --exec=x origin lane", ["refused", "opaque"]],
  ["git push --receive-pack x origin lane", ["refused", "opaque"]],
  ["git push --rece=x origin lane", ["refused", "opaque"]],
  ["git push --e x origin lane", ["refused", "opaque"]],
  // A global option this file does not read past.
  ["git --version push origin lane", ["refused", "opaque"]],
  // Words the shell may expand into `-d`, `:main` or `+main`.
  ["git push origin $B", [REWRITE, "git-push-unreadable"]],
  ['git push origin "$B"', [REWRITE, "git-push-unreadable"]],
  ["git push $FLAGS origin lane", [REWRITE, "git-push-unreadable"]],
  ["git push origin {lane,:main}", [REWRITE, "git-push-unreadable"]],
  ["git push origin {-d,lane}", [REWRITE, "git-push-unreadable"]],
  ["git push origin 'refs/heads/*:refs/heads/*'", [REWRITE, "git-push-unreadable"]],
  ['git push origin "$(git branch --show-current)"', [REWRITE, "git-push-unreadable"]],
  // Environment that decides which configuration git reads. APRV-521: an
  // assignment in front of git that is not on the classifier's closed list
  // leaves the segment unclassified before the push grammar is reached.
  ["GIT_CONFIG_PARAMETERS=x git push origin lane", ["refused", "unclassified"]],
  ["GIT_CONFIG_COUNT=1 git push origin lane", ["refused", "unclassified"]],
  ["HOME=/tmp/h git push origin lane", ["refused", "unclassified"]],
  ["XDG_CONFIG_HOME=/tmp/h git push origin lane", ["refused", "unclassified"]],
  ["FOO=1 git push origin lane", ["refused", "unclassified"]],
  // A word on that list reaches the push grammar, which still reads every
  // GIT_* assignment as steering its configuration (stricter, unchanged).
  ["GIT_TERMINAL_PROMPT=0 git push origin lane", [REWRITE, "git-push-unreadable"]],
  ["PAGER=cat git push origin lane", ["vcs.push.branch", "git-push-branch"]],
  // Global options that pick another repository's config, or inject config.
  // APRV-520: every value-taking git global, separate or `=`-joined, leaves
  // the segment unclassified before the push grammar is reached.
  ["git --git-dir=/tmp/x/.git push origin lane", ["refused", "unclassified"]],
  ["git --work-tree=/tmp/x push origin lane", ["refused", "unclassified"]],
  ["git --config-env=remote.origin.push=V push origin", ["refused", "unclassified"]],
  ["git --exec-path=/tmp/x push origin lane", ["refused", "unclassified"]],
  ["git --namespace=x push origin lane", ["refused", "unclassified"]],
]);

// ---------------------------------------------------------------------------
// 4. Nothing ordinary moved
// ---------------------------------------------------------------------------

pin([
  ["git push origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push -u origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push -q -u origin feature/x", ["vcs.push.branch", "git-push-branch"]],
  ["git push --set-upstream origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push --set-u origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push origin HEAD:refs/heads/lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push origin HEAD~1:lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push origin HEAD@{1}:lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push -o ci.skip origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push --no-verify origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push --no-delete origin lane", ["vcs.push.branch", "git-push-branch"]],
  ["git push origin main", ["vcs.push.main", "git-push-main"]],
  ["git push", ["vcs.push.main", "git-push-implicit"]],
  ["git push origin", ["vcs.push.main", "git-push-implicit"]],
  ["git push --force-with-lease origin lane", [REWRITE, "git-push-force"]],
  ["git push --tags", ["release.publish", "git-push-tag"]],
  ["git push --delete origin lane", [DELETE, "git-ref-delete", "lane"]],
  ["git push origin --delete a b c", [DELETE, "git-ref-delete", "a b c"]],
  // A help request prints usage and pushes nothing; it adds nothing.
  ["git push -h", ["vcs.push.main", "git-push-implicit"]],
]);

test("the floor: a value word the old scan took for a refspec keeps its old, stricter reading", () => {
  // `-o main` is a push option, so git pushes `lane` only. The word scan this
  // row always made read `main` as a refspec; it stays as the floor, so the
  // verdict never moves looser than it was.
  assert.deepEqual(answer("git push origin -o main lane"), ["vcs.push.main", "git-push-main"]);
});

test("a global option no longer hides an implicit push", () => {
  // On main this was `vcs.push.branch`: the word after `push` was taken for a
  // refspec. git reads `origin` as the remote and pushes the current branch.
  assert.deepEqual(answer("git --no-pager push origin"), ["vcs.push.main", "git-push-implicit"]);
});

test("a deletion and its negation together read as the deletion", () => {
  // git takes the last word; reading the first is the stricter answer.
  assert.deepEqual(answer("git push -d --no-delete origin lane"), [DELETE, "git-ref-delete", "lane"]);
});

test("the git-push row's emits are unchanged", () => {
  const row = COMMAND_RULES.find((candidate) => candidate.id === "git-push");
  assert.deepEqual(row?.emits, ["vcs.push.branch", "vcs.push.main", "vcs.history.rewrite", "vcs.ref.delete"]);
});

test("the parser reports refusals by kind", () => {
  assert.deepEqual(parseGitPushArgv(["--d"]), { ok: false, kind: "unparseable", detail: "git push --d is ambiguous" });
  assert.equal((parseGitPushArgv(["--exec=x"]) as { kind: string }).kind, "runs-program");
  assert.equal((parseGitPushArgv(["origin", "$B"]) as { kind: string }).kind, "unreadable");
  assert.equal((parseGitPushArgv(["origin"], ["GIT_DIR=x"]) as { kind: string }).kind, "unreadable");
  assert.equal((parseGitPushArgv(["origin"], [], true) as { kind: string }).kind, "unreadable");
  const read = parseGitPushArgv(["-ud", "origin", "lane"]);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.reading.remove, true);
    assert.deepEqual(read.reading.positionals, ["origin", "lane"]);
  }
});

test("the option table is the one `git push -h` prints on git 2.50", (t) => {
  const version = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) return t.skip("no git binary found");
  if (!version.stdout.startsWith("git version 2.50.")) return t.skip(`table is git 2.50's; this is ${version.stdout.trim()}`);
  const help = spawnSync("git", ["push", "-h"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" } });
  const listed = new Set<string>();
  for (const match of `${help.stdout}${help.stderr}`.matchAll(/--(?:\[no-\])?([a-z0-9][a-z0-9-]*)/gu)) {
    listed.add(match[1] as string);
  }
  // `--verify` is printed as the opposite of `--no-verify`, which is the table's spelling.
  listed.delete("verify");
  const table = new Set(GIT_PUSH_OPTIONS.map((option) => option.long));
  assert.deepEqual([...listed].filter((name) => !table.has(name)).sort(), [], "options git lists that the table lacks");
  assert.deepEqual([...table].filter((name) => !listed.has(name)).sort(), [], "options the table has that git does not list");
});
