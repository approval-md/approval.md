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

import { explain } from "../src/core/policy-explain.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { CLASS_MINIMUMS, resolve } from "../src/core/policy-match.js";
import {
  DECISION_B_UNREADABLE_CLASS,
  DECISION_D_OVERWRITE_IS_GUARDED,
  DECISION_E_WINDOW,
  guardedEntryOf,
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
    "/work/repo/.git/config",
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
