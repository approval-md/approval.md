/**
 * Command classifier fixtures (APRV-82).
 *
 * The classifier is the reviewable artifact of the harness hook: policy speaks
 * in classes, the harness speaks in command lines, and this is the whole of the
 * translation. So the table below is written as a specification rather than as a
 * sample — every row of `COMMAND_RULES` has at least one positive case (asserted
 * mechanically at the bottom), and the tokenizer's edge cases each have their
 * own row.
 *
 * Nothing here touches the filesystem, the clock, or the log: the function under
 * test is pure, which is what lets a fixture table stand in for a proof.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCommand,
  isProtectedPath,
  CLASSIFIER_CLASSES,
  COMMAND_RULES,
  GATE_SELF_CLASS,
} from "../src/core/command-class.js";

interface Fixture {
  command: string;
  /** Expected class of the FIRST segment. */
  class: string;
  /** Expected `rule` of the first segment. */
  rule: string;
  /** The `COMMAND_RULES` row this exercises, when the rule id differs. */
  row?: string;
  /** Every class the whole command should produce, when there is more than one. */
  classes?: string[];
}

const FIXTURES: readonly Fixture[] = [
  // -- git pushes: the three classes that differ only by flags and refspec ---
  { command: "git push origin main", class: "vcs.push.main", rule: "git-push-main", row: "git-push" },
  { command: "git push origin master", class: "vcs.push.main", rule: "git-push-main", row: "git-push" },
  { command: "git push origin HEAD:main", class: "vcs.push.main", rule: "git-push-main", row: "git-push" },
  { command: "git push origin refs/heads/main", class: "vcs.push.main", rule: "git-push-main", row: "git-push" },
  { command: "git push", class: "vcs.push.main", rule: "git-push-implicit", row: "git-push" },
  { command: "git push origin", class: "vcs.push.main", rule: "git-push-implicit", row: "git-push" },
  { command: "git push origin $BRANCH", class: "vcs.push.main", rule: "git-push-main", row: "git-push" },
  { command: "git push --delete origin feature", class: "vcs.push.main", rule: "git-push-delete", row: "git-push" },
  { command: "git push origin :feature", class: "vcs.push.main", rule: "git-push-delete", row: "git-push" },
  { command: "git push origin claude/aprv-82", class: "vcs.push.branch", rule: "git-push-branch", row: "git-push" },
  { command: "git push -u origin feature/x", class: "vcs.push.branch", rule: "git-push-branch", row: "git-push" },
  { command: "git push --force origin feature", class: "vcs.history.rewrite", rule: "git-push-force", row: "git-push" },
  { command: "git push -f", class: "vcs.history.rewrite", rule: "git-push-force", row: "git-push" },
  { command: "git push --force-with-lease origin feature", class: "vcs.history.rewrite", rule: "git-push-force", row: "git-push" },
  { command: "git push origin +feature", class: "vcs.history.rewrite", rule: "git-push-force", row: "git-push" },

  // -- the rest of git ------------------------------------------------------
  { command: "git rebase main", class: "vcs.history.rewrite", rule: "git-rewrite" },
  { command: "git reset --hard HEAD~1", class: "vcs.history.rewrite", rule: "git-reset-hard", row: "git-reset" },
  { command: "git reset HEAD~1", class: "vcs.commit.branch", rule: "git-reset" },
  { command: 'git commit -m "wip"', class: "vcs.commit.branch", rule: "git-commit" },
  { command: "git commit --amend --no-edit", class: "vcs.history.rewrite", rule: "git-commit-amend", row: "git-commit" },
  { command: "git branch", class: "read.shell", rule: "git-branch-read", row: "git-branch" },
  { command: "git branch -D stale", class: "vcs.commit.branch", rule: "git-branch-write", row: "git-branch" },
  { command: "git tag v0.1.0", class: "release.publish", rule: "git-tag" },
  { command: "git clone https://github.com/x/y", class: "network.call", rule: "git-clone" },
  { command: "git add -A", class: "vcs.commit.branch", rule: "git-write" },
  { command: "git fetch origin", class: "read.vcs.remote", rule: "git-remote-read" },
  { command: "git status --short", class: "read.shell", rule: "git-read" },
  { command: "git frobnicate", class: "", rule: "", classes: [] },

  // -- gh -------------------------------------------------------------------
  { command: "gh release create v0.1.0", class: "release.publish", rule: "gh-release" },
  { command: "gh api repos/x/y/pulls", class: "network.call", rule: "gh-api" },
  { command: "gh status", class: "read.vcs.remote", rule: "gh-simple-read" },
  { command: "gh pr view 51", class: "read.vcs.remote", rule: "gh-read", row: "gh" },
  { command: "gh pr checks", class: "read.vcs.remote", rule: "gh-read", row: "gh" },
  { command: "gh issue list", class: "read.vcs.remote", rule: "gh-read", row: "gh" },
  { command: "gh pr create --fill", class: "network.call", rule: "gh-write", row: "gh" },
  { command: "gh pr merge 51 --squash", class: "network.call", rule: "gh-write", row: "gh" },
  { command: "gh issue comment 12 --body hi", class: "network.call", rule: "gh-write", row: "gh" },

  // -- package managers -----------------------------------------------------
  { command: "npm publish", class: "release.publish", rule: "npm-publish" },
  { command: "npm version patch", class: "release.publish", rule: "npm-publish" },
  { command: "npm install left-pad", class: "deps.add", rule: "npm-install-package", row: "npm-install" },
  { command: "npm i --save-dev typescript", class: "deps.add", rule: "npm-install-package", row: "npm-install" },
  { command: "npm install", class: "deps.install", rule: "npm-install-lockfile", row: "npm-install" },
  { command: "yarn add react", class: "deps.add", rule: "yarn-add" },
  { command: "pnpm install", class: "deps.install", rule: "yarn-install" },
  { command: "npm ci", class: "deps.install", rule: "npm-ci" },
  { command: "npm update", class: "deps.upgrade", rule: "npm-update" },
  { command: "npm uninstall left-pad", class: "deps.remove", rule: "npm-remove" },
  { command: "npm link ../other", class: "deps.add", rule: "npm-link" },
  { command: "npm audit", class: "network.call", rule: "npm-network" },
  { command: "npm ls --depth 0", class: "read.shell", rule: "npm-list" },
  { command: "npm test", class: "files.write.workspace", rule: "npm-script" },
  { command: "npm run build", class: "files.write.workspace", rule: "npm-script" },

  // -- workspace tools ------------------------------------------------------
  { command: "node scripts/run-tests.mjs", class: "files.write.workspace", rule: "node-script", row: "node" },
  { command: "node dist/src/cli/main.js log verify", class: GATE_SELF_CLASS, rule: "node-approval-cli", row: "node" },
  { command: "node ./cli.js status", class: GATE_SELF_CLASS, rule: "node-approval-cli", row: "node" },
  { command: "approval queue --json", class: GATE_SELF_CLASS, rule: "approval" },
  { command: "npx tsx src/tool.ts", class: "files.write.workspace", rule: "workspace-tool" },
  { command: "mkdir -p src/core", class: "files.write.workspace", rule: "workspace-write" },
  { command: "rm dist/stale.js", class: "files.write.workspace", rule: "rm-workspace", row: "rm" },
  { command: "rm -rf /etc/hosts", class: "files.delete.out_of_scope", rule: "rm-absolute", row: "rm" },
  { command: "rm ../sibling/file", class: "files.delete.out_of_scope", rule: "rm-parent", row: "rm" },
  { command: "rm -rf .", class: "files.delete.out_of_scope", rule: "rm-recursive-root", row: "rm" },
  { command: "rm -rf $TARGET", class: "files.delete.out_of_scope", rule: "rm-unreadable-path", row: "rm" },
  { command: "rm -rf node_modules", class: "files.write.workspace", rule: "rm-workspace", row: "rm" },
  { command: "sed -n '1,20p' README.md", class: "read.shell", rule: "sed-read", row: "sed" },
  { command: "sed -i.bak s/a/b/ src/x.ts", class: "files.write.workspace", rule: "sed-in-place", row: "sed" },

  // -- network and reads ----------------------------------------------------
  { command: "curl -sS https://example.com", class: "network.call", rule: "network" },
  { command: "wget https://example.com/x.tgz", class: "network.call", rule: "network" },
  { command: "ls -la src", class: "read.shell", rule: "read-shell" },
  { command: "grep -rn TODO src", class: "read.shell", rule: "read-shell" },

  // -- the overrides --------------------------------------------------------
  { command: "echo hi > APPROVAL.md", class: "policy.edit", rule: "redirect-protected" },
  { command: "cp draft.md CLAUDE.md", class: "policy.edit", rule: "protected-path" },
  { command: "rm -rf .approval/log", class: "policy.edit", rule: "protected-path" },
  { command: "cp x .github/workflows/ci.yml", class: "policy.edit", rule: "protected-path" },
  { command: "ls src > listing.txt", class: "files.write.workspace", rule: "redirect-write" },
  { command: "APPROVAL_HUMAN=human:alice", class: "read.shell", rule: "assignment" },
  { command: "APPROVAL_HUMAN=human:alice approval queue", class: GATE_SELF_CLASS, rule: "approval" },
];

for (const fixture of FIXTURES) {
  if (fixture.rule === "") continue;
  test(`classify: ${fixture.command}`, () => {
    const result = classifyCommand(fixture.command);
    assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.detail}`);
    if (!result.ok) return;
    const first = result.segments[0];
    assert.ok(first !== undefined, "at least one segment");
    assert.equal(first.class, fixture.class);
    assert.equal(first.rule, fixture.rule);
    if (fixture.classes !== undefined) assert.deepEqual(result.classes, fixture.classes);
  });
}

// ---------------------------------------------------------------------------
// Coverage: no row of the table is unexercised
// ---------------------------------------------------------------------------

test("every rule in COMMAND_RULES has at least one positive fixture", () => {
  const covered = new Set(FIXTURES.map((fixture) => fixture.row ?? fixture.rule));
  const missing = COMMAND_RULES.map((rule) => rule.id).filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `rules with no fixture: ${missing.join(", ")}`);
});

test("CLASSIFIER_CLASSES is exactly what the table can emit", () => {
  const emitted = new Set(
    FIXTURES.flatMap((fixture) => (fixture.rule === "" ? [] : [fixture.class])),
  );
  for (const cls of emitted) {
    assert.ok(
      CLASSIFIER_CLASSES.includes(cls),
      `${cls} is emitted by a fixture but missing from CLASSIFIER_CLASSES`,
    );
  }
});

// ---------------------------------------------------------------------------
// Multi-segment commands
// ---------------------------------------------------------------------------

test("every segment of a list is classified, and the classes are the union", () => {
  const result = classifyCommand("cd src && npm test && git push origin main");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.segments.map((segment) => segment.class),
    ["read.shell", "files.write.workspace", "vcs.push.main"],
  );
  assert.deepEqual(result.classes, ["read.shell", "files.write.workspace", "vcs.push.main"]);
});

test("a pipeline classifies both sides", () => {
  const result = classifyCommand("curl -s https://example.com | jq .name");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["network.call", "read.shell"]);
});

test("newlines separate segments as operators do", () => {
  const result = classifyCommand("git add -A\ngit commit -m 'wip'\n");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.classes, ["vcs.commit.branch"]);
});

test("one unreadable segment refuses the whole command", () => {
  const result = classifyCommand("ls && eval \"$PLAN\"");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
});

// ---------------------------------------------------------------------------
// Tokenizer edge cases
// ---------------------------------------------------------------------------

test("quoted operators are text, not separators", () => {
  const result = classifyCommand('git commit -m "fix && push"');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.class, "vcs.commit.branch");
});

test("single quotes protect a redirection character", () => {
  const result = classifyCommand("grep -n '>' src/core/command-class.ts");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
});

test("a backslash escape protects a separator", () => {
  const result = classifyCommand("echo a\\;b");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.segments.length, 1);
});

test("a backslash-newline continuation keeps one segment", () => {
  const result = classifyCommand("git push \\\n  origin main");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["vcs.push.main"]);
});

test("a heredoc body is data, never classified", () => {
  const result = classifyCommand("cat <<'EOF' > notes.md\nrm -rf /\ngit push --force\nEOF\n");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["files.write.workspace"]);
});

test("a bare heredoc terminator is honoured too", () => {
  const result = classifyCommand("cat <<EOF\nvalue\nEOF\ngit status\n");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
});

test("an unterminated heredoc is unparseable", () => {
  const result = classifyCommand("cat <<EOF\nnever closed\n");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unparseable");
});

test("an unterminated quote is unparseable", () => {
  const result = classifyCommand("git commit -m 'wip");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unparseable");
});

test("2>&1 is a descriptor dup, not a redirect target", () => {
  const result = classifyCommand("npm test 2>&1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["files.write.workspace"]);
});

test("a read-only command substitution does not taint its segment", () => {
  const result = classifyCommand("echo $(cat VERSION)");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
});

test("a heredoc inside a command substitution is still a read", () => {
  const result = classifyCommand("echo $(cat <<'EOF'\nbody\nEOF\n)");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
});

test("an effectful command substitution taints its segment", () => {
  const result = classifyCommand("echo $(git push origin main)");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
  assert.match(result.detail, /vcs\.push\.main/u);
});

test("backticks are opaque", () => {
  const result = classifyCommand("echo `ls`");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
  assert.match(result.detail, /backtick/u);
});

test("arithmetic expansion is opaque", () => {
  const result = classifyCommand("echo $((1 + 1))");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
});

for (const opaque of [
  "bash -c 'git push --force'",
  "sh script.sh",
  "zsh -c ls",
  "eval $PLAN",
  "source .env",
  ". ./setup.sh",
  "exec node x.js",
  "sudo rm -rf /",
  "env FOO=1 npm test",
  "xargs rm < list.txt",
  "node -e 'process.exit(0)'",
  "node --eval 'x'",
  "python3 -c 'import os'",
  "perl -e 'unlink'",
]) {
  test(`opaque: ${opaque}`, () => {
    const result = classifyCommand(opaque);
    assert.equal(result.ok, false, "an opaque construct must never classify");
    if (result.ok) return;
    assert.equal(result.code, "opaque");
  });
}

for (const unknown of ["vim CLAUDE.md", "docker compose up", "git frobnicate", "gh weird thing"]) {
  test(`unclassified: ${unknown}`, () => {
    const result = classifyCommand(unknown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unclassified");
  });
}

test("an empty command is unclassified rather than allowed", () => {
  const result = classifyCommand("   ");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unclassified");
});

// ---------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------

test("isProtectedPath names the policy surface and nothing else", () => {
  for (const path of [
    "APPROVAL.md",
    "./APPROVAL.md",
    "/repo/APPROVAL.md",
    "APPROVALS.md",
    "CLAUDE.md",
    "AGENTS.md",
    ".npmrc",
    ".approval/log/events.jsonl",
    "/repo/.approval/vault.enc",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isProtectedPath(path), true, `${path} must be protected`);
  }
  for (const path of [
    "README.md",
    "src/core/gate.ts",
    "docs/claude-code-hook.md",
    ".claude/agents/reviewer.md",
    ".github/ISSUE_TEMPLATE.md",
    "backlog/tasks/aprv-82.md",
    "",
  ]) {
    assert.equal(isProtectedPath(path), false, `${path} must not be protected`);
  }
});
