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
  commandSegmentWords,
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
  // `gh api` splits on its method and field flags (APRV-114); the other
  // subcommands on the row are `network.call` whatever their flags say.
  { command: "gh api repos/x/y/pulls", class: "read.vcs.remote", rule: "gh-api-read", row: "gh-api" },
  { command: "gh api -X GET repos/x/y", class: "read.vcs.remote", rule: "gh-api-read", row: "gh-api" },
  { command: "gh api --method GET repos/x/y", class: "read.vcs.remote", rule: "gh-api-read", row: "gh-api" },
  { command: "gh api repos/x/y --paginate --jq .[].name", class: "read.vcs.remote", rule: "gh-api-read", row: "gh-api" },
  { command: "gh api -X POST repos/x/y/issues", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api --method=PATCH repos/x/y", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api -XDELETE repos/x/y", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api graphql -f query=Q", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api repos/x/y --field a=b", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api repos/x/y --raw-field a=b", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api repos/x/y -F a=b", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh api repos/x/y --input body.json", class: "network.call", rule: "gh-api-write", row: "gh-api" },
  { command: "gh auth status", class: "network.call", rule: "gh-api" },
  { command: "gh secret set TOKEN", class: "network.call", rule: "gh-api" },
  { command: "gh status", class: "read.vcs.remote", rule: "gh-simple-read" },
  { command: "gh pr view 51", class: "read.vcs.remote", rule: "gh-read", row: "gh" },
  { command: "gh pr checks", class: "read.vcs.remote", rule: "gh-read", row: "gh" },
  { command: "gh issue list", class: "read.vcs.remote", rule: "gh-read", row: "gh" },
  { command: "gh pr create --fill", class: "vcs.pr.open", rule: "gh-pr-open", row: "gh" },
  { command: "gh pr edit 51 --title t", class: "vcs.pr.update", rule: "gh-pr-update", row: "gh" },
  { command: "gh pr comment 51 --body hi", class: "vcs.pr.update", rule: "gh-pr-update", row: "gh" },
  { command: "gh pr merge 51 --squash", class: "vcs.push.main", rule: "gh-pr-merge", row: "gh" },
  { command: "gh pr checkout 51", class: "vcs.commit.branch", rule: "gh-pr-checkout", row: "gh" },
  { command: "gh pr unknown-verb", class: "network.call", rule: "gh-write", row: "gh" },
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

  // -- web fetches: GET-shaped is read.web, everything else network.call -----
  { command: "curl https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl -sS https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl -fsSL https://example.com/api", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl -I https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl -X GET https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl -XGET https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl --request=GET https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl --request HEAD https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "curl -H 'Accept: application/json' https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "wget https://example.com/x.tgz", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "wget --method=GET https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "http https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "http GET https://example.com", class: "read.web", rule: "web-read", row: "web-fetch" },
  { command: "httpie https://example.com/?a=b", class: "read.web", rule: "web-read", row: "web-fetch" },

  { command: "curl -X POST https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl -XPOST https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --request DELETE https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --method PUT https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl -d a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --data a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --data-raw a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --data-ascii a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --data-binary @body.json https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --data-urlencode a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --json '{}' https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl -F file=@x.png https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --form file=@x.png https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --form-string a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl -T upload.tgz https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "curl --upload-file upload.tgz https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "wget --post-data=a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "wget --post-file body.txt https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "wget --body-data a=b https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "wget --body-file body.txt https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "wget --method PUT https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "http POST https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "httpie PUT https://example.com", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "http https://example.com name=carter", class: "network.call", rule: "web-write", row: "web-fetch" },
  { command: "http --form https://example.com a=b", class: "network.call", rule: "web-write", row: "web-fetch" },

  // -- transports: manual whatever the argv says ----------------------------
  { command: "ssh host uptime", class: "network.call", rule: "network" },
  { command: "scp local.txt host:/tmp/", class: "network.call", rule: "network" },
  { command: "sftp host", class: "network.call", rule: "network" },
  { command: "rsync -a src/ host:/srv/", class: "network.call", rule: "network" },
  { command: "nc -z host 443", class: "network.call", rule: "network" },
  { command: "telnet host 25", class: "network.call", rule: "network" },
  { command: "ftp host", class: "network.call", rule: "network" },

  { command: "ls -la src", class: "read.shell", rule: "read-shell" },
  { command: "grep -rn TODO src", class: "read.shell", rule: "read-shell" },

  // -- the overrides --------------------------------------------------------
  { command: "echo hi > APPROVAL.md", class: "policy.edit", rule: "redirect-protected" },
  { command: "cp draft.md CLAUDE.md", class: "policy.edit", rule: "protected-path" },
  { command: "rm -rf .approval/log", class: "policy.edit", rule: "protected-path" },
  { command: "cp x .github/workflows/ci.yml", class: "policy.edit", rule: "protected-path" },
  { command: "cp x .cursor/hooks.json", class: "policy.edit", rule: "protected-path" },
  { command: "rm -rf .cursor/hooks", class: "policy.edit", rule: "protected-path" },
  { command: "tee .cursor/agents/x.md", class: "policy.edit", rule: "protected-path" },
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
// Web fetches: the ambiguous invocations fail toward network.call (APRV-114)
// ---------------------------------------------------------------------------

/**
 * The read carve-out is only safe while everything it cannot read stays out of
 * it. Each line below is a way to reach the network with a method or a body the
 * text does not show, and each one must answer `network.call`: a fetch we have
 * to guess about is a fetch a human decides.
 */
const AMBIGUOUS_FETCHES: readonly string[] = [
  // A method the environment supplies, in each spelling of the flag.
  'curl -X "$METHOD" https://example.com',
  "curl --request $METHOD https://example.com",
  "curl --request=$METHOD https://example.com",
  "gh api -X $METHOD repos/x/y",
  // A method flag with nothing after it.
  "curl -X",
  "curl https://example.com --request",
  // A short-flag bundle we decline to unbundle: the method is in the next word.
  "curl -sSX POST https://example.com",
  "gh api -sX POST repos/x/y",
  // A config file can carry any option, including a method and a body.
  "curl -K request.conf https://example.com",
  "curl --config request.conf https://example.com",
  "wget --config=wgetrc https://example.com",
  // A bare expansion is not a URL; it is whatever the environment puts there.
  "curl $ENDPOINT",
  "curl $CURL_OPTS https://example.com",
  "gh api $ROUTE",
  // Flags written after `--`. Real curl reads them as URLs, so this is stricter
  // than curl itself, which is the direction this classifier errs in.
  "curl -- -d a=b https://example.com",
];

for (const command of AMBIGUOUS_FETCHES) {
  test(`an ambiguous fetch is network.call: ${command}`, () => {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.detail}`);
    if (!result.ok) return;
    assert.deepEqual(result.classes, ["network.call"]);
  });
}

test("a fetch whose argument is a read-only substitution is still network.call", () => {
  // The substitution itself is inert, so the segment classifies; the word it
  // produces is not a URL this file can read, so the fetch is not a read.
  const result = classifyCommand("curl $(cat url.txt)");
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.detail}`);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["network.call"]);
});

test("a fetch built by a write substitution is opaque", () => {
  const result = classifyCommand("curl $(npm publish)");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
});

test("a GET-shaped fetch redirected into a file is a workspace write, not a read", () => {
  const result = classifyCommand("curl -sS https://example.com > out.json");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["files.write.workspace"]);
});

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
  const result = classifyCommand("curl -X POST https://example.com | jq .name");
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
    ".cursor/hooks.json",
    ".cursor/hooks/approve.sh",
    ".cursor/agents/token-heavy-implementer.md",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isProtectedPath(path), true, `${path} must be protected`);
  }
  for (const path of [
    "README.md",
    "src/core/gate.ts",
    "docs/claude-code-hook.md",
    ".claude/agents/reviewer.md",
    ".cursor/rules/style.mdc",
    ".github/ISSUE_TEMPLATE.md",
    "backlog/tasks/aprv-82.md",
    "",
  ]) {
    assert.equal(isProtectedPath(path), false, `${path} must not be protected`);
  }
});

// ---------------------------------------------------------------------------
// policy.protected_paths (APRV-107)
// ---------------------------------------------------------------------------

const EXTRA: readonly string[] = ["SPEC.md", "docs/constitution.md", "design/"];

test("an exact entry matches the file wherever the candidate is rooted", () => {
  for (const path of [
    "SPEC.md",
    "./SPEC.md",
    "/abs/repo/SPEC.md",
    "../sibling/SPEC.md",
    // A one-segment entry is a FILENAME, matching in any directory exactly as
    // the built-in `CLAUDE.md` does. Erring wide is the fail-closed direction:
    // a false positive costs one approval prompt.
    "docs/SPEC.md",
  ]) {
    assert.equal(isProtectedPath(path, EXTRA), true, `${path} must be protected`);
  }
});

test("a multi-segment entry matches only that whole trailing path", () => {
  for (const path of ["docs/constitution.md", "./docs/constitution.md", "/repo/docs/constitution.md"]) {
    assert.equal(isProtectedPath(path, EXTRA), true, `${path} must be protected`);
  }
  for (const path of [
    // The last segment alone is not the entry: the entry named a path.
    "constitution.md",
    "docs/notes/constitution.md",
    "constitution.md/docs",
  ]) {
    assert.equal(isProtectedPath(path, EXTRA), false, `${path} must not be protected`);
  }
});

test("a trailing-slash entry protects the subtree at any depth", () => {
  for (const path of [
    "design/",
    "design",
    "design/notes.md",
    "design/sub/deep/notes.md",
    "/abs/repo/design/notes.md",
    "./design/notes.md",
  ]) {
    assert.equal(isProtectedPath(path, EXTRA), true, `${path} must be protected`);
  }
  for (const path of ["designs/notes.md", "redesign/notes.md", "src/design.ts"]) {
    assert.equal(isProtectedPath(path, EXTRA), false, `${path} must not be protected`);
  }
});

test("an unlisted path stays unprotected, and no entry at all changes nothing", () => {
  assert.equal(isProtectedPath("SPEC.md"), false);
  assert.equal(isProtectedPath("README.md", EXTRA), false);
  assert.equal(isProtectedPath("src/core/gate.ts", EXTRA), false);
  assert.equal(isProtectedPath("", EXTRA), false);
});

test("the built-in set is protected whatever the policy lists (fail closed)", () => {
  // An empty list, a list of unrelated files, and a list that names the
  // built-ins' neighbours all leave the built-ins exactly as protected.
  for (const extra of [[], ["README.md"], ["docs/", "src/"]]) {
    for (const path of [
      "APPROVAL.md",
      "APPROVALS.md",
      "CLAUDE.md",
      "AGENTS.md",
      ".npmrc",
      ".approval/log/events.jsonl",
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".cursor/hooks/x.sh",
      ".cursor/agents/x.md",
      ".github/workflows/ci.yml",
    ]) {
      assert.equal(
        isProtectedPath(path, extra),
        true,
        `${path} must stay protected with extra ${JSON.stringify(extra)}`,
      );
    }
  }
});

test("a malformed entry matches nothing rather than matching wildly", () => {
  // The schema rejects these before they reach the matcher; the matcher is
  // defensive anyway, because an entry it half-understood would be a
  // protection an author believes is in force.
  for (const entry of ["", "   ", "/", "..", "../", "./"]) {
    assert.equal(
      isProtectedPath("src/core/gate.ts", [entry]),
      false,
      `entry ${JSON.stringify(entry)} must match nothing`,
    );
  }
  // A glob is matched literally: it protects a file actually named `*.md`, and
  // never every `.md` in the tree.
  assert.equal(isProtectedPath("docs/notes.md", ["docs/*.md"]), false);
});

test("classifyCommand routes the policy's paths to policy.edit", () => {
  const bare = classifyCommand("cp draft.md SPEC.md");
  assert.ok(bare.ok);
  assert.equal(bare.classes[0], "files.write.workspace");

  for (const command of [
    "cp draft.md SPEC.md",
    "echo hi > SPEC.md",
    "rm -rf design",
    "mv old.md design/new.md",
  ]) {
    const result = classifyCommand(command, EXTRA);
    assert.ok(result.ok, `${command} must classify`);
    assert.deepEqual(result.classes, ["policy.edit"], command);
  }
});

test("a policy path inside a command substitution taints the outer segment", () => {
  const result = classifyCommand("echo $(cp a SPEC.md)", EXTRA);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
  assert.match(result.detail, /policy\.edit/u);
});

test("reading a protected path is still a read", () => {
  const result = classifyCommand("cat SPEC.md", EXTRA);
  assert.ok(result.ok);
  assert.deepEqual(result.classes, ["read.shell"]);
});

test("a policy.edit segment reports WHICH path earned it (APRV-143)", () => {
  // The word the matcher matched, verbatim, so a channel can name it without a
  // second search of its own. Only the segment that took `policy.edit` carries
  // one: a segment classified by its binary names no path, because no path
  // decided it.
  const result = classifyCommand("cp notes.md docs/notes.md && cp draft.md CLAUDE.md");
  assert.ok(result.ok);
  assert.equal(result.segments[0]?.class, "files.write.workspace");
  assert.equal(result.segments[0]?.path, undefined);
  assert.equal(result.segments[1]?.class, "policy.edit");
  assert.equal(result.segments[1]?.rule, "protected-path");
  assert.equal(result.segments[1]?.path, "CLAUDE.md");
});

test("a redirection onto a protected path reports its target as the path", () => {
  const result = classifyCommand("echo hi > .github/workflows/ci.yml");
  assert.ok(result.ok);
  assert.equal(result.segments[0]?.rule, "redirect-protected");
  assert.equal(result.segments[0]?.path, ".github/workflows/ci.yml");
});

test("a path protected only by policy.protected_paths is reported as written", () => {
  const result = classifyCommand("mv old.md design/new.md", EXTRA);
  assert.ok(result.ok);
  assert.equal(result.segments[0]?.class, "policy.edit");
  assert.equal(result.segments[0]?.path, "design/new.md");
});

// ---------------------------------------------------------------------------
// commandSegmentWords (APRV-144)
// ---------------------------------------------------------------------------

test("commandSegmentWords splits on the same boundaries the classifier does", () => {
  const command = "git add . && git commit -m 'a msg' | tee log.txt";
  const words = commandSegmentWords(command);
  const classified = classifyCommand(command);
  assert.ok(words !== null);
  assert.ok(classified.ok);
  // One tokenizer, so one segmentation: the display aid and the class always
  // describe the same pieces of the same command.
  assert.deepEqual(
    words.map((segment) => segment.text),
    classified.segments.map((segment) => segment.text),
  );
  assert.deepEqual(words[1], {
    text: "git commit -m 'a msg'",
    bin: "git",
    args: ["commit", "-m", "a msg"],
  });
});

test("commandSegmentWords skips VAR=value prefixes, as the classifier does", () => {
  const words = commandSegmentWords("FOO=1 BAR=2 npm run build");
  assert.ok(words !== null);
  assert.equal(words[0]?.bin, "npm");
  assert.deepEqual(words[0]?.args, ["run", "build"]);
});

test("commandSegmentWords omits a segment with no binary", () => {
  // A bare assignment and a lone redirection classify (as `assignment` and
  // `redirect-write`) but have no verb to show, so they are not segments a
  // breakdown can describe.
  assert.deepEqual(commandSegmentWords("FOO=1"), []);
  assert.deepEqual(commandSegmentWords("> out.txt"), []);
});

test("commandSegmentWords refuses exactly what the tokenizer refuses", () => {
  const command = "echo 'unterminated";
  assert.equal(commandSegmentWords(command), null);
  const classified = classifyCommand(command);
  assert.equal(classified.ok, false);
  if (!classified.ok) assert.equal(classified.code, "unparseable");
});
