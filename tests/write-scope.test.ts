/**
 * Write scope, the pure half (design v4, writes outside the workspace).
 *
 * The guarded list as a table of places and near misses, the opt-in rule
 * (point 8), and the guarded class's built-in minimum (point 5): clamped at
 * resolution whatever a wildcard, `defaults.autonomy`, `allow_irreversible`
 * or a supervision mode says, refused at load only for a row that names the
 * class itself below `manual`, and never failing an existing policy.
 *
 * No disk beyond the policy files the loader reads.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyCommand, isGateOrganPath } from "../src/core/command-class.js";
import { eachNameReading, withNamesAsSpelled } from "../src/core/name-fold.js";
import { explain } from "../src/core/policy-explain.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { CLASS_MINIMUMS, resolve } from "../src/core/policy-match.js";
import {
  DECISION_B_UNREADABLE_CLASS,
  DECISION_D_OVERWRITE_IS_GUARDED,
  DECISION_E_WINDOW,
  guardedEntryBelow,
  guardedEntryOf,
  isClaudeConfigFolderName,
  WRITE_GUARDED_CLASS,
  WRITE_GUARDED_MINIMUM,
  WRITE_OUT_OF_SCOPE_CLASS,
  writeScopeOptedIn,
} from "../src/core/write-scope.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-write-scope-pure-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const HOME = "/Users/tester";
const HOMES = [HOME, "/private/var/tester-real"];

// ---------------------------------------------------------------------------
// The guarded list
// ---------------------------------------------------------------------------

test("every family on the guarded list is guarded, at the place and under it", () => {
  const cases: Array<[path: string, entry: string]> = [
    [`${HOME}/.ssh`, "~/.ssh"],
    [`${HOME}/.ssh/authorized_keys`, "~/.ssh"],
    [`${HOME}/.ssh/sub/deeper/k`, "~/.ssh"],
    [`${HOME}/.zshrc`, "~/.zshrc"],
    [`${HOME}/.zshenv`, "~/.zshenv"],
    [`${HOME}/.zprofile`, "~/.zprofile"],
    [`${HOME}/.zlogin`, "~/.zlogin"],
    [`${HOME}/.bashrc`, "~/.bashrc"],
    [`${HOME}/.bash_profile`, "~/.bash_profile"],
    [`${HOME}/.profile`, "~/.profile"],
    [`${HOME}/.config/fish/config.fish`, "~/.config/fish"],
    [`${HOME}/Library/LaunchAgents/x.plist`, "~/Library/LaunchAgents"],
    [`${HOME}/Library/LaunchDaemons/x.plist`, "~/Library/LaunchDaemons"],
    ["/Library/LaunchAgents/x.plist", "/Library/LaunchAgents"],
    ["/Library/LaunchDaemons/x.plist", "/Library/LaunchDaemons"],
    ["/System/Library/LaunchAgents/x.plist", "/System/Library/LaunchAgents"],
    ["/System/Library/LaunchDaemons/x.plist", "/System/Library/LaunchDaemons"],
    ["/etc/hosts", "/etc"],
    ["/etc/crontab", "/etc"],
    ["/etc/cron.d/job", "/etc"],
    ["/private/etc/hosts", "/etc"],
    ["/var/at/tabs/root", "/var/at"],
    ["/private/var/at/tabs/root", "/var/at"],
    ["/usr/lib/cron/tabs/x", "/usr/lib/cron"],
    ["/Users/someone-else/notes.txt", "another user's home"],
    ["/home/someone/notes.txt", "another user's home"],
    ["/var/root/x", "another user's home"],
    ["/root/.bashrc", "another user's home"],
    ["/work/repo/.git/hooks/pre-push", "a git hooks folder"],
    ["/work/repo/.claude/hooks/pre-tool.sh", "a Claude Code hooks folder"],
    ["/work/repo/.claude/hooks", "a Claude Code hooks folder"],
    [`${HOME}/.claude/hooks/x.sh`, "a Claude Code hooks folder"],
    [`${HOME}/.gitconfig`, "~/.gitconfig"],
    [`${HOME}/.config/git/config`, "~/.config/git"],
    [`${HOME}/bin/tool`, "~/bin"],
    [`${HOME}/.local/bin/tool`, "~/.local/bin"],
    ["/usr/local/bin/tool", "/usr/local/bin"],
    ["/opt/homebrew/bin/tool", "/opt/homebrew/bin"],
    [`${HOME}/.aws/credentials`, "~/.aws"],
    [`${HOME}/.config/gh/hosts.yml`, "~/.config/gh"],
    [`${HOME}/.netrc`, "~/.netrc"],
    [`${HOME}/.docker/config.json`, "~/.docker"],
    [`${HOME}/.kube/config`, "~/.kube"],
    [`${HOME}/.gnupg/pubring.kbx`, "~/.gnupg"],
    // The resolved spelling of the home is a home too.
    ["/private/var/tester-real/.ssh/k", "~/.ssh"],
  ];
  for (const [path, entry] of cases) {
    assert.equal(guardedEntryOf(path, HOMES), entry, path);
  }
});

test("near misses of the list are not guarded", () => {
  for (const path of [
    `${HOME}/.sshx`,
    `${HOME}/.ssh-backup/x`,
    `${HOME}/binary`,
    `${HOME}/dev/bin/tool`,
    `${HOME}/.config/ghost`,
    `${HOME}/.config/fisher`,
    `${HOME}/dev/repo/notes.txt`,
    `${HOME}/Library/Caches/x`,
    "/etcetera/x",
    "/usr/local/lib/x",
    "/Users/Shared/x",
    "/Users",
    "/private/tmp/x",
    "/work/repo/hooks/x",
  ]) {
    assert.equal(guardedEntryOf(path, HOMES), null, path);
  }
});

test("guarded names compare through the fold: case and the APFS code points", () => {
  for (const [path, entry] of [
    [`${HOME}/.SSH/k`, "~/.ssh"],
    [`${HOME}/.ZshRC`, "~/.zshrc"],
    ["/ETC/hosts", "/etc"],
    [`${HOME}/library/launchagents/x`, "~/Library/LaunchAgents"],
    [`${HOME}/.ſsh/k`, "~/.ssh"],
    ["/work/repo/.GIT/HOOKS/pre-commit", "a git hooks folder"],
    ["/work/repo/.Claude/Hooks/x.sh", "a Claude Code hooks folder"],
    ["/USERS/someone/x", "another user's home"],
  ] as const) {
    assert.equal(guardedEntryOf(path, HOMES), entry, path);
  }
});

test("a path with no home known is judged by the absolute entries and other homes", () => {
  assert.equal(guardedEntryOf("/etc/hosts", []), "/etc");
  // With no home of its own, every child of /Users is someone's home.
  assert.equal(guardedEntryOf(`${HOME}/notes.txt`, []), "another user's home");
});

// ---------------------------------------------------------------------------
// The opt-in rule (point 8)
// ---------------------------------------------------------------------------

test("only the class's own key or a write_scope block opts a policy in", () => {
  assert.equal(writeScopeOptedIn(null), false);
  assert.equal(writeScopeOptedIn({}), false);
  assert.equal(writeScopeOptedIn({ classes: { "files.*": {} } }), false, "a wildcard is not naming the class");
  assert.equal(writeScopeOptedIn({ classes: { "files.write.*": {} } }), false);
  assert.equal(writeScopeOptedIn({ classes: { [WRITE_GUARDED_CLASS]: {} } }), false);
  assert.equal(writeScopeOptedIn({ classes: { [WRITE_OUT_OF_SCOPE_CLASS]: {} } }), true);
  assert.equal(writeScopeOptedIn({ write_scope: {} }), true);
  assert.equal(writeScopeOptedIn({ write_scope: { roots: ["/x"] } }), true);
});

test("decisions B, D and E stand as the page recommends (A is not built)", () => {
  assert.equal(DECISION_B_UNREADABLE_CLASS, WRITE_GUARDED_CLASS);
  assert.equal(DECISION_D_OVERWRITE_IS_GUARDED, false);
  assert.equal(DECISION_E_WINDOW, "as-manual");
});

// ---------------------------------------------------------------------------
// The built-in minimum (point 5)
// ---------------------------------------------------------------------------

function policyFile(classes: string[], defaults = "  autonomy: autonomous"): PolicyLoadResult {
  counter += 1;
  const path = join(scratch, `policy-${counter}.md`);
  writeFileSync(
    path,
    ["# P", "", "```yaml approval-policy", 'version: "0.1"', "defaults:", defaults, "classes:", ...classes, "```", ""].join("\n"),
    "utf8",
  );
  return loadPolicy({ file: path });
}

test("the guarded class's minimum is manual and no policy setting lifts it", () => {
  assert.equal(WRITE_GUARDED_MINIMUM, "manual");
  assert.equal(CLASS_MINIMUMS[WRITE_GUARDED_CLASS], "manual");
  const lifts: Array<[label: string, classes: string[], defaults?: string]> = [
    ["defaults.autonomy autonomous", ["  read.*: { autonomy: autonomous }"]],
    ["files.* autonomous with allow_irreversible", ["  files.*: { autonomy: autonomous, allow_irreversible: true }"]],
    ["* and *.* autonomous", ['  "*": { autonomy: autonomous }', '  "*.*": { autonomy: autonomous, allow_irreversible: true }']],
    ["files.write.* supervised-live", ["  files.write.*: { autonomy: supervised-live, live_rate: 0.5 }"]],
    ["files.write.* supervised-retro", ["  files.write.*: { autonomy: supervised-retro }"]],
    ["files.write.* bare supervised", ["  files.write.*: { autonomy: supervised }"]],
    ["defaults supervised-retro", ["  read.*: { autonomy: autonomous }"], "  autonomy: supervised-retro"],
  ];
  for (const [label, classes, defaults] of lifts) {
    const load = policyFile(classes, defaults);
    assert.equal(load.ok, true, `${label}: an existing policy must still load (${load.ok ? "" : load.message})`);
    for (const options of [{}, { reversible: true }, { reversible: false }]) {
      const resolution = resolve(load, WRITE_GUARDED_CLASS, options);
      assert.equal(resolution.autonomy, "manual", `${label} ${JSON.stringify(options)}`);
      assert.equal(resolution.declaredAutonomy, "manual", label);
      assert.equal(resolution.supervision, null, label);
      assert.equal(resolution.liveRate, null, label);
      assert.equal(resolution.provenance, "floor", label);
      assert.equal(resolution.floorApplied, true, label);
    }
    // And the clamp touches no other class.
    assert.notEqual(resolve(load, "files.write.workspace").provenance, "floor", label);
  }
});

test("a stricter answer for the guarded class stands, and manual is untouched", () => {
  const humanOnly = policyFile([`  ${WRITE_GUARDED_CLASS}: { autonomy: human-only }`, "  files.*: { autonomy: autonomous }"]);
  assert.equal(humanOnly.ok, true);
  assert.equal(resolve(humanOnly, WRITE_GUARDED_CLASS).autonomy, "human-only");
  assert.equal(resolve(humanOnly, WRITE_GUARDED_CLASS).provenance, "rule");

  const manual = policyFile([`  ${WRITE_GUARDED_CLASS}: { autonomy: manual }`]);
  assert.equal(manual.ok, true);
  assert.equal(resolve(manual, WRITE_GUARDED_CLASS).autonomy, "manual");
  assert.equal(resolve(manual, WRITE_GUARDED_CLASS).provenance, "rule");
  assert.equal(resolve(manual, WRITE_GUARDED_CLASS).floorApplied, false);

  const wildcardHumanOnly = policyFile(["  files.*: { autonomy: human-only }"]);
  assert.equal(resolve(wildcardHumanOnly, WRITE_GUARDED_CLASS).autonomy, "human-only");
});

test("only a row naming the guarded class itself below manual is refused at load", () => {
  for (const level of ["autonomous", "supervised-retro", "supervised", "supervised-live, live_rate: 1"]) {
    const load = policyFile([`  ${WRITE_GUARDED_CLASS}: { autonomy: ${level} }`]);
    assert.equal(load.ok, false, level);
    if (load.ok) continue;
    assert.equal(load.code, "class-minimum", level);
    assert.match(load.message, /built-in minimum manual/u);
    // A policy that does not load resolves every class manual.
    assert.equal(resolve(load, "files.write.workspace").autonomy, "manual");
  }
});

test("policy check says the class minimum decided, and names the missing row", () => {
  const load = policyFile(["  files.*: { autonomy: autonomous }"]);
  const guarded = explain(load, WRITE_GUARDED_CLASS);
  assert.equal(guarded.outcome.autonomy, "manual");
  assert.equal(guarded.manualBecause, "class-minimum");
  assert.ok(guarded.decisionPath.some((line) => line.startsWith("built-in minimum:")), guarded.decisionPath.join("\n"));

  const workspace = explain(load, "files.write.workspace");
  assert.ok(
    workspace.decisionPath.some((line) => line.startsWith("write scope: the row is missing")),
    workspace.decisionPath.join("\n"),
  );
  const opted = explain(policyFile([`  ${WRITE_OUT_OF_SCOPE_CLASS}: { autonomy: supervised-retro }`]), WRITE_OUT_OF_SCOPE_CLASS);
  assert.ok(opted.decisionPath.some((line) => line.startsWith("write scope: the policy opts in")), opted.decisionPath.join("\n"));
  assert.equal(opted.outcome.supervision, "retro");
});

test("a write_scope block loads, and an unexpandable root is refused by the schema", () => {
  counter += 1;
  const path = join(scratch, `policy-${counter}.md`);
  writeFileSync(
    path,
    ["```yaml approval-policy", 'version: "0.1"', "write_scope:", "  roots: [/opt/out, ../sibling]", "```", ""].join("\n"),
    "utf8",
  );
  const load = loadPolicy({ file: path });
  assert.equal(load.ok, true, load.ok ? "" : load.message);
  if (load.ok) assert.deepEqual(load.policy.write_scope, { roots: ["/opt/out", "../sibling"] });

  counter += 1;
  const bad = join(scratch, `policy-${counter}.md`);
  writeFileSync(bad, ["```yaml approval-policy", 'version: "0.1"', "write_scope:", "  roots: [~/x]", "```", ""].join("\n"), "utf8");
  const refused = loadPolicy({ file: bad });
  assert.equal(refused.ok, false);
});

test("a Claude Code hooks folder is the pair of segments, nothing beside it; a tree written at .claude can hold it", () => {
  for (const path of ["/work/repo/.claude/notes.md", "/work/repo/.claude/hooks-notes/x", "/work/repo/claude/hooks/x", "/work/repo/.claude-/hooks/x", "/work/repo/hooks/.claude/x"]) {
    assert.equal(guardedEntryOf(path, HOMES), null, path);
  }
  assert.equal(guardedEntryBelow("/work/repo/.claude", HOMES), "a Claude Code hooks folder");
  assert.equal(guardedEntryBelow("/work/repo/.CLAUDE", HOMES), "a Claude Code hooks folder");
  assert.equal(guardedEntryBelow("/work/repo/.claude/notes", HOMES), null);
});

// ---------------------------------------------------------------------------
// S2, part 1: Claude Code's config folders (lead, CLAIMS L62289)
// ---------------------------------------------------------------------------

/** A folder `CLAUDE_CONFIG_DIR` names, as given and resolved. */
const CONFIG_DIRS = ["/opt/cc", "/private/opt/cc-real"];

test("S2.1: a config folder is .claude or .claude-<suffix>, one or more characters after the dash, through the fold", () => {
  for (const name of [".claude", ".claude-x", ".claude-b1", ".claude-edge2", ".claude--"]) assert.equal(isClaudeConfigFolderName(name), true, name);
  for (const name of [".claude-", ".claudex", "claude-x", ".clauderc", ".claude.json", "x.claude-x", ""]) assert.equal(isClaudeConfigFolderName(name), false, name);
});

test("S2.1: settings under .claude-<suffix> are policy.core in the pure classifier, as .claude's are; near misses keep their class", () => {
  for (const command of [
    "echo x > ~/.claude-work/settings.json",
    "echo x > ~/.claude-b1/settings.local.json",
    "cp a .claude-2/settings.json",
    "echo x > ~/.Claude-Work/Settings.json",
    "echo x > /Users/tester/.claude-x/settings.json.tmp",
  ]) {
    const result = classifyCommand(command, []);
    assert.equal(result.ok, true, command);
    if (result.ok) assert.ok(result.classes.includes("policy.core"), `${command}: ${JSON.stringify(result.classes)}`);
  }
  for (const command of [
    "echo x > ~/.claude-/settings.json",
    "echo x > ~/.claudex/settings.json",
    "echo x > ~/.claude-x/notes.md",
    "echo x > ~/.claude-x/projects/p/memory/settings-notes.md",
    "echo x > ~/.clauderc",
  ]) {
    const result = classifyCommand(command, []);
    assert.equal(result.ok, true, command);
    if (result.ok) assert.ok(!result.classes.includes("policy.core"), `${command}: ${JSON.stringify(result.classes)}`);
  }
});

test("S2.1: the hooks pair and the plugins tree count under .claude-<suffix>; the folder itself is not guarded whole", () => {
  const cases: Array<[path: string, entry: string]> = [
    [`${HOME}/.claude-x/hooks/h.sh`, "a Claude Code hooks folder"],
    [`${HOME}/.claude-x/hooks`, "a Claude Code hooks folder"],
    ["/work/repo/.claude-old/hooks/x", "a Claude Code hooks folder"],
    [`${HOME}/.Claude-X/HOOKS/h.sh`, "a Claude Code hooks folder"],
    [`${HOME}/.claude/plugins/cache/p/1.0/hooks/hooks.json`, "a Claude Code plugins folder"],
    [`${HOME}/.claude-x/plugins/p/hooks`, "a Claude Code plugins folder"],
    [`${HOME}/.claude-x/plugins/marketplaces/m/plugins/p/hooks/run.sh`, "a Claude Code plugins folder"],
    // The whole plugins tree (seat ruling on the review of 8cd41612): code and configuration that runs.
    [`${HOME}/.claude-x/plugins/p/index.js`, "a Claude Code plugins folder"],
    [`${HOME}/.claude-x/plugins/p/.mcp.json`, "a Claude Code plugins folder"],
    [`${HOME}/.claude/plugins/installed_plugins.json`, "a Claude Code plugins folder"],
    [`${HOME}/.claude/plugins/known_marketplaces.json`, "a Claude Code plugins folder"],
    [`${HOME}/.claude-x/plugins`, "a Claude Code plugins folder"],
    [`${HOME}/.Claude-X/PLUGINS/p/x`, "a Claude Code plugins folder"],
    ["/work/repo/.claude/plugins/p/x", "a Claude Code plugins folder"],
    [`${HOME}/.claude.json`, "~/.claude.json"],
    [`${HOME}/.CLAUDE.JSON`, "~/.claude.json"],
    [`${HOME}/.claude/.claude.json`, "a Claude Code config folder"],
    [`${HOME}/.claude-x/.claude.json`, "a Claude Code config folder"],
    [`${HOME}/.claude-x/settings.json`, "a Claude Code config folder"],
    [`${HOME}/.claude-x/remote-settings.json`, "a Claude Code config folder"],
    [`${HOME}/.claude/remote-settings.json`, "a Claude Code config folder"],
    ["/private/var/tester-real/.claude-x/.claude.json", "a Claude Code config folder"],
  ];
  for (const [path, entry] of cases) assert.equal(guardedEntryOf(path, HOMES), entry, path);
  for (const path of [
    `${HOME}/.claude-x/notes.md`,
    `${HOME}/.claude-x/projects/p/memory/m.md`,
    `${HOME}/.claude/plans/a.md`,
    `${HOME}/.claude-x/pluginsx/a`,
    `${HOME}/.claude-x/projects/plugins/a`,
    `${HOME}/.claude-/plugins/a`,
    `${HOME}/dev/plugins/a`,
    `${HOME}/.claude-x/statusline.sh`,
    `${HOME}/.clauderc`,
    `${HOME}/.claude-/hooks/h.sh`,
    `${HOME}/.claude-/settings.json`,
    `${HOME}/.claude.json.bak`,
    `${HOME}/.claude.jsonx`,
    `${HOME}/dev/.claude-x/.claude.json`,
    `${HOME}/dev/plugins/p/hooks/x`,
  ]) {
    assert.equal(guardedEntryOf(path, HOMES), null, path);
  }
});

test("S2.1: the folder CLAUDE_CONFIG_DIR names is a config folder whatever it is called, as given and resolved", () => {
  const cases: Array<[path: string, entry: string]> = [
    ["/opt/cc/settings.json", "a Claude Code config folder"],
    ["/opt/cc/settings.local.json", "a Claude Code config folder"],
    ["/opt/cc/Settings.JSON", "a Claude Code config folder"],
    ["/opt/cc/remote-settings.json", "a Claude Code config folder"],
    ["/opt/cc/.claude.json", "a Claude Code config folder"],
    ["/opt/cc/hooks/h.sh", "a Claude Code hooks folder"],
    ["/opt/cc/hooks", "a Claude Code hooks folder"],
    ["/opt/cc/plugins/p/hooks/h.sh", "a Claude Code plugins folder"],
    ["/opt/cc/plugins/p/x.js", "a Claude Code plugins folder"],
    ["/opt/cc/plugins/installed_plugins.json", "a Claude Code plugins folder"],
    ["/private/opt/cc-real/settings.json", "a Claude Code config folder"],
    ["/OPT/CC/HOOKS/x", "a Claude Code hooks folder"],
  ];
  for (const [path, entry] of cases) assert.equal(guardedEntryOf(path, HOMES, CONFIG_DIRS), entry, path);
  for (const path of ["/opt/cc/notes.md", "/opt/cc/projects/p/memory/m.md", "/opt/cc/plans/a.md", "/opt/cc/pluginsx/a", "/opt/cc/projects/plugins/a", "/opt/ccx/settings.json", "/opt/settings.json", "/opt/cc/sub/settings.json"]) {
    assert.equal(guardedEntryOf(path, HOMES, CONFIG_DIRS), null, path);
  }
  // With no folder named, the same paths are what they were.
  assert.equal(guardedEntryOf("/opt/cc/settings.json", HOMES), null);
  assert.equal(guardedEntryOf("/opt/cc/settings.json", HOMES, []), null);
});

test("S2.1: a tree written at a config folder, at its plugins, or above the variable's folder can hold its hooks", () => {
  assert.equal(guardedEntryBelow(`${HOME}/.claude-x`, HOMES), "a Claude Code hooks folder");
  assert.equal(guardedEntryBelow("/work/repo/.Claude-Old", HOMES), "a Claude Code hooks folder");
  assert.equal(guardedEntryBelow(`${HOME}/.claude/plugins`, HOMES), "a Claude Code plugins folder");
  assert.equal(guardedEntryBelow(`${HOME}/.claude-x/plugins/cache/p`, HOMES), "a Claude Code plugins folder");
  assert.equal(guardedEntryBelow("/opt/cc", HOMES, CONFIG_DIRS), "a Claude Code config folder");
  assert.equal(guardedEntryBelow("/opt", HOMES, CONFIG_DIRS), "a Claude Code config folder");
  assert.equal(guardedEntryBelow("/opt/cc/plugins/p", HOMES, CONFIG_DIRS), "a Claude Code plugins folder");
  for (const path of [`${HOME}/.claude-x/projects`, `${HOME}/.claude-`, "/opt/cc/projects/p", "/opt/ccx", "/work/repo/plugins/p"]) {
    assert.equal(guardedEntryBelow(path, HOMES, CONFIG_DIRS), null, path);
  }
});

// ---------------------------------------------------------------------------
// S2, part 3: the list gaps (lead, N3)
// ---------------------------------------------------------------------------

test("S2.3: npm's config, the login and logout files, user services, pyenv shims and cargo's bin are guarded; near misses are not", () => {
  const cases: Array<[path: string, entry: string]> = [
    [`${HOME}/.npmrc`, "~/.npmrc"],
    [`${HOME}/.NPMRC`, "~/.npmrc"],
    [`${HOME}/.zlogout`, "~/.zlogout"],
    [`${HOME}/.bash_login`, "~/.bash_login"],
    [`${HOME}/.bash_logout`, "~/.bash_logout"],
    [`${HOME}/.config/systemd/user/x.service`, "~/.config/systemd/user"],
    [`${HOME}/.config/systemd/user`, "~/.config/systemd/user"],
    [`${HOME}/.pyenv/shims/python`, "~/.pyenv/shims"],
    [`${HOME}/.cargo/bin/rg`, "~/.cargo/bin"],
    ["/private/var/tester-real/.cargo/bin/x", "~/.cargo/bin"],
  ];
  for (const [path, entry] of cases) assert.equal(guardedEntryOf(path, HOMES), entry, path);
  for (const path of [
    `${HOME}/.npmrc.bak`,
    `${HOME}/dev/repo/.npmrc`,
    `${HOME}/.zlogoutx`,
    `${HOME}/.config/systemd/system/x`,
    `${HOME}/.config/systemd/userx`,
    `${HOME}/.pyenv/versions/3.12/bin/python`,
    `${HOME}/.cargo/registry/x`,
    `${HOME}/.cargo/binx`,
  ]) {
    assert.equal(guardedEntryOf(path, HOMES), null, path);
  }
  // A tree written at ~/.config/systemd holds the user services.
  assert.equal(guardedEntryBelow(`${HOME}/.config/systemd`, HOMES), "~/.config/systemd/user");
});

test("S2.3: .git/config and config.worktree are guarded anywhere, as the hooks pair is; near misses are not", () => {
  for (const path of [
    "/work/repo/.git/config",
    "/work/repo/.git/config.worktree",
    "/work/repo/.GIT/Config",
    "/work/repo/.git/worktrees/lane/config.worktree",
    `${HOME}/.git/config`,
  ]) {
    assert.equal(guardedEntryOf(path, HOMES), "a git config file", path);
  }
  for (const path of [
    "/work/repo/.git/configs",
    "/work/repo/.gitx/config",
    "/work/repo/.git/config/x",
    "/work/repo/.git/info/config",
    "/work/repo/.git/worktrees/lane/config",
    "/work/repo/.git/worktrees/lane/sub/config.worktree",
    "/work/repo/config",
    "/work/repo/.git/modules/m/config",
  ]) {
    assert.equal(guardedEntryOf(path, HOMES), null, path);
  }
  assert.equal(guardedEntryBelow("/work/repo/.git/worktrees", HOMES), "a git config file");
  assert.equal(guardedEntryBelow("/work/repo/.git/worktrees/lane", HOMES), "a git config file");
  assert.equal(guardedEntryBelow("/work/repo/.git/worktrees/lane/logs", HOMES), null);
});

// ---------------------------------------------------------------------------
// S2.1: the `.claude-<suffix>` settings rule is in the folded reading only
// (seat ruling on the differential of d76ebd0d: 0 looser)
// ---------------------------------------------------------------------------

/** Every segment as `class rule`. */
function segmentsOf1(command: string): string[] {
  const result = classifyCommand(command, []);
  assert.equal(result.ok, true, command);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [];
}

test("S2.1 reading: a .claude-<suffix> settings write is policy.core folded and keeps main's class as spelled; both are reported", () => {
  for (const [command, own] of [
    ["echo x > ~/.claude-work/settings.json", "files.write.workspace redirect-write"],
    ["cp a .claude-2/settings.local.json", "files.write.workspace workspace-write"],
    ["echo x > /Users/tester/.claude-b1/settings.json", "files.write.workspace redirect-write"],
  ] as const) {
    const both = segmentsOf1(command);
    assert.ok(both.some((each) => each.startsWith("policy.core ")), `${command}: ${both.join(" | ")}`);
    assert.ok(both.includes(own), `${command}: main's own class is kept beside it: ${both.join(" | ")}`);
    // As spelled the rule does not apply: exactly the answer main gave.
    const spelled = withNamesAsSpelled(() => segmentsOf1(command));
    assert.deepEqual(spelled, [own], command);
  }
  // `.claude/settings*` is policy.core in both readings, as on main.
  assert.deepEqual(withNamesAsSpelled(() => segmentsOf1("echo x > .claude/settings.json")), ["policy.core redirect-protected"]);
  assert.deepEqual(segmentsOf1("echo x > .claude/settings.json"), ["policy.core redirect-protected"]);
});

test("S2.1 reading: the second reading runs for a .claude-<suffix> settings word and nowhere else it did not run before", () => {
  const readings = (command: string): number => eachNameReading(() => classifyCommand(command, [])).length;
  assert.equal(readings("echo x > ~/.claude-work/settings.json"), 2);
  assert.equal(readings("cp a .claude-2/settings.local.json"), 2);
  for (const command of [
    "echo x > notes.txt",
    "echo x > .claude/settings.json",
    "echo x > ~/.claude-work/notes.md",
    "echo x > ~/.claude-work/projects/p/settings-notes.md",
    "echo x > ~/.claude-/settings.json",
    "echo x > ~/.claudex/settings.json",
    "echo x > ~/.claude-x/hooks/h.sh",
    "echo x > ~/.claude-x/plugins/p/x.js",
    `touch ${Array.from({ length: 200 }, (_, i) => `out/p${String(i)}.txt`).join(" ")}`,
  ]) {
    assert.equal(readings(command), 1, command);
  }
});

test("S2.1 reading: a .claude-<suffix> settings file is not a gate organ (a grant holds in both readings); .claude's still is", () => {
  for (const path of [".claude-x/settings.json", "/Users/tester/.claude-b1/settings.local.json", ".claude-2/settings.json"]) {
    assert.equal(isGateOrganPath(path), false, path);
  }
  assert.equal(isGateOrganPath(".claude/settings.json"), true);
  assert.equal(isGateOrganPath(".claude/settings.local.json"), true);
});
