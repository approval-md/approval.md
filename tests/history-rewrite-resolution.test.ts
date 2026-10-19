/**
 * The `vcs.history.rewrite` split, pure halves (amended SPEC.md §7, APRV-433).
 *
 * Resolution (spec section 7.2, P1 to P11, where the case is pure), the trace
 * and the amendment diff, the reachability list, and the pure parsing helpers
 * the hook's impure step leans on. Every policy is built through the real
 * `loadPolicy` path. The impure classification cases (section 7.1) and the
 * evidence cases (7.3) build real repositories in `tests/cli-hook-rewrite.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BUILTIN_MERGE_STRATEGIES,
  emittableClass,
  gitInvocationShape,
  pullRebaseMode,
  readPullRebase,
  rebaseRunsStrategy,
  RUNTIME_CLASSES,
} from "../src/core/command-class.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { diffPolicies } from "../src/core/policy-diff.js";
import { explain } from "../src/core/policy-explain.js";
import {
  HISTORY_REWRITE_CLASS,
  HISTORY_REWRITE_LOCAL,
  HISTORY_REWRITE_SHARED,
  historyRewriteAdopted,
  isHistoryRewriteMember,
  resolve,
} from "../src/core/policy-match.js";
import { checkPolicyExpectations } from "../src/core/policy-expectations.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-history-resolution-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function policy(block: string): PolicyLoadResult {
  counter += 1;
  const path = join(scratch, `policy-${String(counter)}.md`);
  writeFileSync(path, `# Policy\n\nprose\n\n\`\`\`yaml approval-policy\n${block}\n\`\`\`\n`);
  const loaded = loadPolicy({ file: path });
  assert.equal(loaded.ok, true, loaded.ok ? "" : `${loaded.code}: ${loaded.message}`);
  return loaded;
}

function classesPolicy(
  rules: Array<[pattern: string, autonomy: string]>,
  defaults = "defaults:\n  autonomy: manual\n",
): PolicyLoadResult {
  const body = rules.map(([pattern, autonomy]) => `  "${pattern}": { autonomy: ${autonomy} }`).join("\n");
  return policy(`version: "0.1"\n${defaults}classes:\n${body}`);
}

/** The lines of this repository's APPROVAL.md that the split touches, as of 801684f9. */
const THIS_REPO: Array<[string, string]> = [
  ["vcs.commit.branch", "autonomous"],
  ["vcs.history.rewrite", "human-only"],
  ["vcs.*", "supervised"],
];

const COMMIT_BRANCH = "vcs.commit.branch";

test("P1: this repo today, a local amend with legacy vcs.commit.branch, is autonomous under provenance legacy", () => {
  const load = classesPolicy(THIS_REPO);
  assert.equal(historyRewriteAdopted(load), false);
  const r = resolve(load, HISTORY_REWRITE_LOCAL, { legacyClass: COMMIT_BRANCH });
  assert.equal(r.autonomy, "autonomous");
  assert.equal(r.provenance, "legacy");
  assert.equal(r.matched?.pattern, COMMIT_BRANCH);
});

test("P2: this repo today, a local reset whose legacy is the bare class, is human-only under provenance legacy", () => {
  const load = classesPolicy(THIS_REPO);
  const r = resolve(load, HISTORY_REWRITE_LOCAL, { legacyClass: HISTORY_REWRITE_CLASS });
  assert.equal(r.autonomy, "human-only");
  assert.equal(r.provenance, "legacy");
});

test("legacy without a stated class falls back to the bare class, and a member is never its own legacy", () => {
  const load = classesPolicy(THIS_REPO);
  assert.equal(resolve(load, HISTORY_REWRITE_LOCAL).autonomy, "human-only");
  assert.equal(
    resolve(load, HISTORY_REWRITE_SHARED, { legacyClass: HISTORY_REWRITE_LOCAL }).autonomy,
    "human-only",
  );
});

test("P3: adding vcs.history.rewrite.local: autonomous makes a local reset autonomous by rule", () => {
  const load = classesPolicy([...THIS_REPO, ["vcs.history.rewrite.local", "autonomous"]]);
  assert.equal(historyRewriteAdopted(load), true);
  const r = resolve(load, HISTORY_REWRITE_LOCAL, { legacyClass: HISTORY_REWRITE_CLASS });
  assert.equal(r.autonomy, "autonomous");
  assert.equal(r.provenance, "rule");
  assert.equal(r.matched?.pattern, HISTORY_REWRITE_LOCAL);
});

test("P4: under the same policy a shared amend inherits line 50, human-only", () => {
  const load = classesPolicy([...THIS_REPO, ["vcs.history.rewrite.local", "autonomous"]]);
  const r = resolve(load, HISTORY_REWRITE_SHARED, { legacyClass: COMMIT_BRANCH });
  assert.equal(r.autonomy, "human-only");
  assert.equal(r.provenance, "inherited");
  assert.equal(r.matched?.pattern, HISTORY_REWRITE_CLASS);
  assert.deepEqual(r.candidates, []);
});

test("P5: vcs.* autonomous plus a .local line and no bare line: shared inherits autonomous through the bare class, no floor", () => {
  const load = classesPolicy([
    ["vcs.*", "autonomous"],
    ["vcs.history.rewrite.local", "autonomous"],
  ]);
  const r = resolve(load, HISTORY_REWRITE_SHARED);
  assert.equal(r.autonomy, "autonomous");
  assert.equal(r.provenance, "inherited");
  assert.equal(r.matched?.pattern, "vcs.*");
});

test("non-own patterns never reach a member directly once the split is adopted", () => {
  // vcs.history.* would match the member by ordinary matching, and is more
  // specific than vcs.*; it is screened out, and the bare class decides.
  const load = classesPolicy([
    ["vcs.history.*", "autonomous"],
    ["vcs.history.rewrite", "manual"],
    ["vcs.history.rewrite.local", "autonomous"],
  ]);
  const r = resolve(load, HISTORY_REWRITE_SHARED);
  assert.equal(r.autonomy, "manual");
  assert.equal(r.provenance, "inherited");
});

test("P6: vcs.history.rewrite.* autonomous: shared is floored at manual, local is autonomous", () => {
  const load = classesPolicy([["vcs.history.rewrite.*", "autonomous"]]);
  const shared = resolve(load, HISTORY_REWRITE_SHARED);
  assert.equal(shared.autonomy, "manual");
  assert.equal(shared.provenance, "floor");
  assert.equal(shared.historyFloor, true);
  assert.equal(shared.floorApplied, false, "the irreversibility floor did not decide this");
  const local = resolve(load, HISTORY_REWRITE_LOCAL);
  assert.equal(local.autonomy, "autonomous");
  assert.equal(local.provenance, "rule");
});

test("the family floor leaves a stricter family key alone", () => {
  const load = classesPolicy([["vcs.history.rewrite.*", "human-only"]]);
  const r = resolve(load, HISTORY_REWRITE_SHARED);
  assert.equal(r.autonomy, "human-only");
  assert.equal(r.provenance, "rule");
  assert.equal(r.historyFloor, undefined);
});

test("P7: an exact vcs.history.rewrite.shared key may set it below manual", () => {
  const load = classesPolicy([
    ["vcs.history.rewrite.*", "autonomous"],
    ["vcs.history.rewrite.shared", "supervised-retro"],
  ]);
  const r = resolve(load, HISTORY_REWRITE_SHARED);
  assert.equal(r.autonomy, "supervised");
  assert.equal(r.supervision, "retro");
  assert.equal(r.provenance, "rule");
  assert.equal(r.matched?.pattern, HISTORY_REWRITE_SHARED);
});

test("P8: the AV template (defaults autonomous, no vcs line) resolves both members autonomous under legacy", () => {
  const load = classesPolicy([["read.*", "autonomous"]], "defaults:\n  autonomy: autonomous\n");
  for (const member of [HISTORY_REWRITE_SHARED, HISTORY_REWRITE_LOCAL]) {
    for (const legacy of [HISTORY_REWRITE_CLASS, COMMIT_BRANCH]) {
      const r = resolve(load, member, { legacyClass: legacy });
      assert.equal(r.autonomy, "autonomous", `${member} via ${legacy}`);
      assert.equal(r.provenance, "legacy");
    }
  }
});

test("P9: a policy carrying the new lines loads, and the bare class an older core emits still resolves by line 50", () => {
  const load = classesPolicy([
    ...THIS_REPO,
    ["vcs.history.rewrite.shared", "human-only"],
    ["vcs.history.rewrite.local", "autonomous"],
  ]);
  assert.equal(load.ok, true);
  const bare = resolve(load, HISTORY_REWRITE_CLASS);
  assert.equal(bare.autonomy, "human-only");
  assert.equal(bare.matched?.pattern, HISTORY_REWRITE_CLASS);
});

test("P10: the P3 policy with reversible: false floors a local reset to manual", () => {
  const load = classesPolicy([...THIS_REPO, ["vcs.history.rewrite.local", "autonomous"]]);
  const r = resolve(load, HISTORY_REWRITE_LOCAL, { reversible: false });
  assert.equal(r.autonomy, "manual");
  assert.equal(r.provenance, "floor");
  assert.equal(r.floorApplied, true);
});

test("a policy that failed to load resolves a member fail-closed, like any class", () => {
  const failed: PolicyLoadResult = loadPolicy({ file: join(scratch, "absent.md") });
  assert.equal(failed.ok, false);
  const r = resolve(failed, HISTORY_REWRITE_LOCAL, { legacyClass: COMMIT_BRANCH });
  assert.equal(r.autonomy, "manual");
  assert.equal(r.provenance, "fail-closed");
  assert.equal(historyRewriteAdopted(failed), false);
});

test("deeper classes under the family key are ordinary classes, and the bare class is not a member", () => {
  assert.equal(isHistoryRewriteMember(HISTORY_REWRITE_CLASS), false);
  assert.equal(isHistoryRewriteMember("vcs.history.rewrite.other"), false);
  const load = classesPolicy([["vcs.history.rewrite.*", "autonomous"]]);
  assert.equal(resolve(load, "vcs.history.rewrite.other").autonomy, "autonomous");
  assert.equal(resolve(load, HISTORY_REWRITE_CLASS).autonomy, "manual", "the family key does not match the bare class");
});

test("explain names the legacy fallback, inheritance, and the family floor", () => {
  const legacy = explain(classesPolicy(THIS_REPO), HISTORY_REWRITE_LOCAL);
  assert.equal(legacy.provenance, "legacy");
  assert.ok(legacy.decisionPath.some((line) => line.includes("pre-split")), legacy.decisionPath.join("\n"));

  const inherited = explain(
    classesPolicy([...THIS_REPO, ["vcs.history.rewrite.local", "autonomous"]]),
    HISTORY_REWRITE_SHARED,
  );
  assert.equal(inherited.provenance, "inherited");
  assert.ok(inherited.decisionPath.some((line) => line.includes("inherits")), inherited.decisionPath.join("\n"));

  const floored = explain(classesPolicy([["vcs.history.rewrite.*", "autonomous"]]), HISTORY_REWRITE_SHARED);
  assert.equal(floored.outcome.autonomy, "manual");
  assert.ok(
    floored.decisionPath.some((line) => line.includes("never inferred below manual")),
    floored.decisionPath.join("\n"),
  );
});

test("the amendment diff shows adopting the split as a resolution change for BOTH members", () => {
  const before = classesPolicy(THIS_REPO);
  const after = classesPolicy([...THIS_REPO, ["vcs.history.rewrite.local", "autonomous"]]);
  const diff = diffPolicies(before, after);
  assert.ok(diff.probes.includes(HISTORY_REWRITE_LOCAL));
  assert.ok(diff.probes.includes(HISTORY_REWRITE_SHARED), "the member the author did not name is probed too");
  const changed = diff.classes.map((change) => change.class);
  assert.ok(changed.includes(HISTORY_REWRITE_LOCAL), JSON.stringify(diff.classes));
  assert.ok(changed.includes(HISTORY_REWRITE_SHARED), JSON.stringify(diff.classes));
});

test("both members are reachable classes, so a policy line naming one is not refused unreachable", () => {
  assert.ok(RUNTIME_CLASSES.includes(HISTORY_REWRITE_SHARED));
  assert.ok(RUNTIME_CLASSES.includes(HISTORY_REWRITE_LOCAL));
  assert.equal(emittableClass(HISTORY_REWRITE_LOCAL), true);
  const load = classesPolicy([...THIS_REPO, ["vcs.history.rewrite.local", "autonomous"]]);
  const checked = checkPolicyExpectations(load, []);
  assert.deepEqual(
    checked.failures.filter((failure) => failure.kind === "unreachable"),
    [],
  );
});

test("gitInvocationShape: assignments, global options, the subcommand, unreadable words", () => {
  assert.deepEqual(gitInvocationShape("GIT_SEQUENCE_EDITOR=: git rebase -i main"), {
    assignments: ["GIT_SEQUENCE_EDITOR=:"],
    binary: "git",
    globalOptions: [],
    sub: "rebase",
    args: ["-i", "main"],
    unreadable: [false, false],
    writeTargets: [],
    opaque: false,
  });
  // A write redirect is reported, a descriptor dup is not (APRV-433 build).
  assert.deepEqual(gitInvocationShape("git add a.txt > .git/x 2>&1")?.writeTargets, [".git/x"]);
  assert.deepEqual(gitInvocationShape("git status 2>/dev/null")?.writeTargets, ["/dev/null"]);
  assert.deepEqual(gitInvocationShape("git --git-dir=../x/.git reset --hard")?.globalOptions, [
    "--git-dir=../x/.git",
  ]);
  assert.deepEqual(gitInvocationShape('git reset --hard "$REV"')?.unreadable, [false, true]);
  assert.deepEqual(gitInvocationShape("git reset --hard $(git rev-parse x)")?.unreadable, [false, true]);
  // APRV-648 S1: a word that is not `LexWord.exact` is unreadable, so an
  // unquoted `~` anywhere, a brace and a kept double-quoted backslash are;
  // the quoted spellings are read.
  assert.deepEqual(gitInvocationShape("git reset --hard HEAD~2")?.unreadable, [false, true]);
  assert.deepEqual(gitInvocationShape("git reset --hard 'HEAD~2'")?.unreadable, [false, false]);
  assert.deepEqual(gitInvocationShape("git reset --hard HEAD^^")?.unreadable, [false, false]);
  assert.deepEqual(gitInvocationShape("git reset --hard a=~/x")?.unreadable, [false, true]);
  assert.deepEqual(gitInvocationShape("git reset --hard b{,}")?.unreadable, [false, true]);
  assert.deepEqual(gitInvocationShape("git reset --hard 'b{,}'")?.unreadable, [false, false]);
  assert.deepEqual(gitInvocationShape('git reset --hard "m\\ain"')?.unreadable, [false, true]);
  assert.deepEqual(gitInvocationShape('git reset --hard "main"')?.unreadable, [false, false]);
  assert.deepEqual(gitInvocationShape("git reset --hard ma*")?.unreadable, [false, true]);
  assert.equal(gitInvocationShape("approval sandbox -- git rebase main"), null);
  assert.equal(gitInvocationShape("git a && git b"), null, "one segment only");
  // APRV-648 N1: the program word is reported as written, so a caller can
  // insist on the bare `git` on PATH.
  assert.equal(gitInvocationShape("./git status")?.binary, "./git");
  assert.equal(gitInvocationShape("/tmp/x/git status")?.binary, "/tmp/x/git");
  assert.equal(gitInvocationShape("git status")?.binary, "git");
});

test("pullRebaseMode and rebaseRunsStrategy read the flags the classifier reads", () => {
  assert.equal(pullRebaseMode([]), null);
  assert.equal(pullRebaseMode(["--rebase"]), "rebase");
  assert.equal(pullRebaseMode(["-r"]), "rebase");
  assert.equal(pullRebaseMode(["--rebase=merges"]), "merges");
  assert.equal(pullRebaseMode(["--rebase=m"]), "merges");
  // git accepts an unambiguous prefix of a long option (APRV-433 build).
  assert.equal(pullRebaseMode(["--reb"]), "rebase");
  assert.equal(pullRebaseMode(["--rebas=i"]), "interactive");
  // An abbreviation is a word the reader does not understand (fix round 3),
  // so the strictest reading any word allows wins.
  assert.equal(pullRebaseMode(["--rebase", "--no-reb"]), "rebase");
  assert.equal(pullRebaseMode(["--recurse-submodules=no"]), null);
  assert.equal(pullRebaseMode(["--rebase=interactive"]), "interactive");
  assert.equal(pullRebaseMode(["--rebase=i"]), "interactive");
  assert.equal(pullRebaseMode(["--rebase", "--no-rebase"]), null);
  assert.equal(pullRebaseMode(["--rebase=false"]), null);
  assert.equal(pullRebaseMode(["-Xtheirs"]), null);
  // APRV-648 fix round 3, M3: values of pull's value-taking options are
  // skipped the way git's parse-options skips them (builtin/pull.c).
  assert.deepEqual(readPullRebase(["-r", "-o", "--no-rebase", "origin"]), {
    mode: "rebase",
    explicit: true,
    understood: true,
  });
  assert.deepEqual(readPullRebase(["-o", "--no-rebase"]), { mode: null, explicit: false, understood: true });
  assert.deepEqual(readPullRebase(["--server-option=--no-rebase"]), { mode: null, explicit: false, understood: true });
  assert.deepEqual(readPullRebase(["--server-option", "--no-rebase"]), { mode: null, explicit: false, understood: true });
  // git reads `=--no-rebase` as `-o`'s value; the pre-round-3 floor reads the
  // bundle's `r` as a rebase, and the floor wins (spurious, never milder).
  assert.deepEqual(readPullRebase(["-o=--no-rebase"]), { mode: "rebase", explicit: false, understood: true });
  assert.deepEqual(readPullRebase(["--no-rebase"]), { mode: null, explicit: true, understood: true });
  assert.deepEqual(readPullRebase(["--rebase=false"]), { mode: null, explicit: true, understood: true });
  // git reads `-rfalse` as a merge; the floor reads a bundle carrying `r` as a rebase.
  assert.deepEqual(readPullRebase(["-rfalse"]), { mode: "rebase", explicit: true, understood: true });
  // A value option with nothing after it, an abbreviation, an unknown word:
  // not understood, never an explicit merge.
  assert.deepEqual(readPullRebase(["-o"]), { mode: null, explicit: false, understood: false });
  assert.deepEqual(readPullRebase(["--serv", "--no-rebase"]), { mode: null, explicit: false, understood: false });
  assert.deepEqual(readPullRebase(["-r", "--serv", "--no-rebase"]), { mode: "rebase", explicit: false, understood: false });
  assert.deepEqual(readPullRebase(["--no-reb"]), { mode: null, explicit: false, understood: false });
  assert.deepEqual(readPullRebase(["--frob", "--rebase=i"]), { mode: "interactive", explicit: false, understood: false });
  // A swallowed value that looks like a rebase request counts as one, and so
  // does one after `--` or inside a bundle (stricter than git, never milder
  // than the reading before fix round 3).
  assert.equal(readPullRebase(["-o", "-r"]).mode, "rebase");
  assert.equal(readPullRebase(["--server-option", "--rebase=i"]).mode, "interactive");
  assert.equal(readPullRebase(["--", "-r"]).mode, "rebase");
  assert.equal(readPullRebase(["-or"]).mode, "rebase");
  // After `--` every word is a positional.
  assert.deepEqual(readPullRebase(["-r", "--", "--no-rebase"]), { mode: "rebase", explicit: true, understood: true });
  for (const builtin of BUILTIN_MERGE_STRATEGIES) {
    assert.equal(rebaseRunsStrategy(["-s", builtin]), false, builtin);
  }
  assert.equal(rebaseRunsStrategy(["-s", "custom"]), true);
  assert.equal(rebaseRunsStrategy(["--strategy=custom"]), true);
  assert.equal(rebaseRunsStrategy(["-scustom"]), true);
  assert.equal(rebaseRunsStrategy(["-Xours"]), false);
});
