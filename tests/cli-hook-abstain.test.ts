/**
 * `approval hook claude-code`: the opt-in `defaults.unclassified_command:
 * abstain` key.
 *
 * Absent (or `deny`), a Bash command no built-in rule covers is denied
 * `hook-unclassified`, as every earlier build did. Under an ATTESTED policy
 * declaring `abstain`, the same command gets no verdict at all: empty stdout,
 * exit 0, nothing appended, so Claude Code's own permission flow decides it.
 * Only the no-rule case abstains: `opaque` and `unparseable` stay denied, a
 * command whose other segments are not all autonomous keeps today's deny, and
 * every other harness keeps today's deny.
 *
 * Spawn the compiled CLI; never hand-write log lines. Every path is absolute.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { abstainPolicyRefusal } from "../src/cli/hook.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { readVerifiedRecords } from "../src/core/state.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-abstain-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function policy(key: string | null, top: readonly string[] = [], classes: readonly string[] = []): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    ...(key === null ? [] : [`  unclassified_command: ${key}`]),
    ...top,
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  release.publish:",
    "    autonomy: human-only",
    ...classes,
    "```",
    "",
  ].join("\n");
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function ready(text: string, attest = true): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  if (attest) {
    const attested = runCli(
      ["policy", "attest", "--dir", dir, "--log", logPath(dir), "--as", "human:alice"],
      dir,
    );
    assert.equal(attested.code, 0, attested.stderr);
  } else {
    mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  }
  return dir;
}

function rawLog(dir: string): string {
  return existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8") : "";
}

function starts(dir: string): number {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.includes('"event":"execution.started"')).length;
}

function claude(dir: string, command: string, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "cc-sess-abstain",
    tool_use_id: id,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

function verdict(run: Run): { permission: string; reason: string } {
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> };
  const out = parsed.hookSpecificOutput ?? {};
  return { permission: String(out["permissionDecision"]), reason: String(out["permissionDecisionReason"]) };
}

/** No verdict: nothing on stdout or stderr, exit 0, and the log byte for byte as it was. */
function assertAbstained(dir: string, run: Run, before: string): void {
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "", "an abstain prints nothing");
  assert.equal(run.stderr, "");
  assert.equal(rawLog(dir).length, before.length, "nothing was appended");
  assert.equal(rawLog(dir), before);
}

// F-12 fold: `railway whoami` no longer abstains (its tail `whoami` is
// `read.shell`, test (x)), so the fixture is a CLI whose every later word is
// unknown to the table.
const UNCLASSIFIED = "railway status";

test("(a) without the key an unclassified Bash command is denied hook-unclassified, unchanged", () => {
  for (const key of [null, "deny"]) {
    const dir = ready(policy(key));
    const before = rawLog(dir);
    const v = verdict(claude(dir, UNCLASSIFIED, `t-a-${String(key)}`));
    assert.equal(v.permission, "deny");
    assert.match(v.reason, /^hook-unclassified: no rule for railway status \(segment: railway status\)/u);
    assert.equal(rawLog(dir), before);
  }
});

test("(b) under an attested abstain policy an unclassified Bash command gets no verdict and appends nothing", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-b"), before);
});

test("(b2) a read segment beside it still abstains; a cd anywhere in the command keeps the deny", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, `git status && ${UNCLASSIFIED}`, "t-b2-git"), before);
  // A directory change moves where the no-rule segment's relative words land, so it never abstains.
  const v = verdict(claude(dir, `cd ${dir} && ${UNCLASSIFIED}`, "t-b2-cd"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("(c) under abstain an opaque command is still denied", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  const v = verdict(claude(dir, "timeout 60 echo x", "t-c"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-opaque: /u);
  // An opaque segment AFTER an unclassified one is still read, and still denies.
  const mixed = verdict(claude(dir, `${UNCLASSIFIED} && timeout 60 echo x`, "t-c-mixed"));
  assert.equal(mixed.permission, "deny");
  assert.match(mixed.reason, /^hook-opaque: /u);
  // A substitution running an unclassified command taints the segment as before.
  const substituted = verdict(claude(dir, "echo $(railway variables)", "t-c-subst"));
  assert.equal(substituted.permission, "deny");
  assert.equal(rawLog(dir), before);
});

test("(d) under abstain a built-in autonomous class is allowed as before, with one execution.started", () => {
  const dir = ready(policy("abstain"));
  const v = verdict(claude(dir, "echo hello", "t-d"));
  assert.equal(v.permission, "allow");
  assert.equal(v.reason, "autonomous: read.shell");
  assert.equal(starts(dir), 1);
});

test("(e) under abstain a human-only class is denied as before, alone or beside an unclassified segment", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  const v = verdict(claude(dir, "npm publish", "t-e"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-class-human-only: /u);
  // The unclassified segment does not hand the human-only one to the harness.
  for (const command of [`${UNCLASSIFIED} && npm publish`, `npm publish; ${UNCLASSIFIED}`]) {
    const mixed = verdict(claude(dir, command, `t-e-${String(command.length)}`));
    assert.equal(mixed.permission, "deny", command);
    assert.match(mixed.reason, /^hook-unclassified: no rule for railway status/u, command);
  }
  // Nor a class that would wait for a human (deps.add resolves manual here).
  const manual = verdict(claude(dir, `${UNCLASSIFIED} && npm install left-pad`, "t-e-manual"));
  assert.equal(manual.permission, "deny");
  assert.match(manual.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("(f) the schema admits deny and abstain and rejects any other value", () => {
  assert.equal(loadPolicyText("APPROVAL.md", policy("abstain")).ok, true);
  assert.equal(loadPolicyText("APPROVAL.md", policy("deny")).ok, true);
  for (const value of ["allow", "ask", "Abstain", "true"]) {
    const loaded = loadPolicyText("APPROVAL.md", policy(value));
    assert.equal(loaded.ok, false, value);
  }
  const dir = ready(policy("allow"), false);
  const v = verdict(claude(dir, UNCLASSIFIED, "t-f"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-policy-unavailable: /u);
});

test("(g) the key cannot slip past attestation: an unattested policy carrying it is refused policy-not-attested", () => {
  // Attested WITHOUT the key, then the key is added on disk and nobody attests.
  const dir = ready(policy(null));
  writeFileSync(join(dir, "APPROVAL.md"), policy("abstain"), "utf8");
  const before = rawLog(dir);
  const v = verdict(claude(dir, UNCLASSIFIED, "t-g-edit"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-gate-refused:policy-not-attested: /u);
  assert.equal(rawLog(dir), before);

  // A policy that was never attested at all.
  const never = ready(policy("abstain"), false);
  const n = verdict(claude(never, UNCLASSIFIED, "t-g-never"));
  assert.equal(n.permission, "deny");
  assert.match(n.reason, /^hook-gate-refused:policy-not-attested: /u);

  // Re-attesting the edit is what puts it in force.
  const attested = runCli(
    ["policy", "attest", "--dir", dir, "--log", logPath(dir), "--as", "human:alice"],
    dir,
  );
  assert.equal(attested.code, 0, attested.stderr);
  const afterAttest = rawLog(dir);
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-g-after"), afterAttest);
});

test("(h) another harness keeps today's deny under an abstain policy", () => {
  const dir = ready(policy("abstain"));
  const event = JSON.stringify({
    hookEventName: "PreToolUse",
    sessionId: "grok-sess-abstain",
    cwd: dir,
    workspaceRoot: dir,
    toolName: "Bash",
    toolInput: { command: UNCLASSIFIED },
  });
  const run = runCli(["hook", "grok", "--dir", dir], dir, event);
  assert.equal(run.code, 2);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["decision"], "deny");
  assert.match(String(parsed["reason"]), /^hook-unclassified: /u);
});

test("(i) hook classify is unchanged by the key: it still reports unclassified", () => {
  const dir = ready(policy("abstain"));
  const run = runCli(["hook", "classify", "--json", "--dir", dir, "--", UNCLASSIFIED], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], false);
  assert.equal(parsed["code"], "unclassified");
});

function claudePost(dir: string, command: string, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "cc-sess-abstain",
    tool_use_id: id,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

test("(j) the PostToolUse half of an abstained call is silent: exit 0, nothing printed, nothing appended", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-j"), before);
  assertAbstained(dir, claudePost(dir, UNCLASSIFIED, "t-j"), before);

  // Without the key nothing ran, and a report for it still says no start was written (exit 2, shown).
  const plain = ready(policy(null));
  const run = claudePost(plain, UNCLASSIFIED, "t-j-plain");
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /post-tool-gate-refused:not-delegated/u);

  // Under the key, a gated call's missing start is still reported: only an abstained command is silent.
  const gated = claudePost(dir, "echo hello", "t-j-gated");
  assert.equal(gated.code, 2);
  assert.match(gated.stderr, /post-tool-gate-refused:not-delegated/u);
  assert.equal(rawLog(dir), before);
});

/** The rule: abstain ONLY when every segment other than the no-rule one(s) is a read (`read`, `read.*`). */
test("(k) a no-rule segment beside a side-effecting segment keeps today's deny, even when that segment is autonomous", () => {
  const dir = ready(policy("abstain", [], ["  vcs.push.branch:", "    autonomy: autonomous", "  vcs.commit.branch:", "    autonomy: autonomous"]));
  const before = rawLog(dir);
  for (const command of [
    `git push origin feature-x && ${UNCLASSIFIED}`,
    `${UNCLASSIFIED}; git push origin feature-x`,
    `git commit -m wip && ${UNCLASSIFIED}`,
  ]) {
    const v = verdict(claude(dir, command, `t-k-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
    assert.match(v.reason, /^hook-unclassified: no rule for railway status/u, command);
  }
  // Alone, the autonomous push is still allowed and recorded as before.
  assert.equal(verdict(claude(dir, "git push origin feature-x", "t-k-alone")).permission, "allow");
  assert.equal(starts(dir), 1);
  assert.notEqual(rawLog(dir), before);
});

test("(l) a no-rule segment that names a protected path or a credential keeps the refusal", () => {
  // The protected and credential families human-only, so a refusal is immediate rather than a wait.
  const dir = ready(policy("abstain", [], ["  policy.*:", "    autonomy: human-only", "  log.*:", "    autonomy: human-only", "  account.*:", "    autonomy: human-only"]));
  const before = rawLog(dir);
  for (const command of [
    `${UNCLASSIFIED} > APPROVAL.md`,
    "railway up APPROVAL.md",
    "railway up --config=.approval/log/events.jsonl",
    "railway up .approval/env",
    // F-12 fold (review-b N2): APFS is case-insensitive.
    `${UNCLASSIFIED} >> approval.md`,
    `${UNCLASSIFIED} > Approval.MD`,
    "frobnicate approvals.md",
    "frobnicate claude.md",
  ]) {
    const run = claude(dir, command, `t-l-${String(command.length)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(m) an exec.code segment beside a no-rule segment keeps the deny", () => {
  const dir = ready(policy("abstain", ["exec:", "  code:", "    custody: attested"], ["  exec.code:", "    autonomy: autonomous"]));
  const before = rawLog(dir);
  const v = verdict(claude(dir, `python3 -c 'print(1)' && ${UNCLASSIFIED}`, "t-m"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("(n) the abstain is believed only of the bytes attested: an edit between the two reads refuses", () => {
  const dir = ready(policy("abstain"));
  const path = join(dir, "APPROVAL.md");
  const attestedText = policy("abstain");
  const loaded = loadPolicyText(path, attestedText);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const read = readVerifiedRecords(logPath(dir));
  assert.equal(read.ok, true);
  if (!read.ok) return;
  // The same bytes: no refusal.
  assert.equal(abstainPolicyRefusal(loaded, { path, bytes: Buffer.from(attestedText, "utf8") }, read.records), null);
  // The decision was made on the attested policy, the file read for the attestation is an edit.
  const edited = policy("abstain", [], ["  vcs.*:", "    autonomy: autonomous"]);
  const swapped = abstainPolicyRefusal(loaded, { path, bytes: Buffer.from(edited, "utf8") }, read.records);
  assert.notEqual(swapped, null);
  // The decision was made on an edit, the bytes read back are the attested ones.
  const loadedEdit = loadPolicyText(path, edited);
  assert.equal(loadedEdit.ok, true);
  if (!loadedEdit.ok) return;
  const back = abstainPolicyRefusal(loadedEdit, { path, bytes: Buffer.from(attestedText, "utf8") }, read.records);
  assert.notEqual(back, null);
  // No file at all to read back.
  assert.notEqual(abstainPolicyRefusal(loaded, null, read.records), null);
  // F-12 fold (review-b S2, mutant attest-skip): bytes that PARSE to the
  // attested policy but are not the attested bytes (a prose-only edit outside
  // the yaml block) still refuse, on the attestation half alone.
  const prose = `${attestedText}\nA prose line nobody attested.\n`;
  const proseLoaded = loadPolicyText(path, prose);
  assert.equal(proseLoaded.ok, true);
  if (!proseLoaded.ok) return;
  assert.equal(JSON.stringify(proseLoaded.policy), JSON.stringify(loaded.policy), "the edit parses equal");
  const unattested = abstainPolicyRefusal(loaded, { path, bytes: Buffer.from(prose, "utf8") }, read.records);
  assert.notEqual(unattested, null);
  assert.match(unattested?.code ?? "", /^hook-gate-refused:/u);
});

/** Fail closed: a no-rule segment whose words cannot be checked as written never abstains. */
test("(o) after a cd (or pushd/popd) the no-rule segment keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of [
    "cd ~/.ssh && frobnicate id_rsa",
    `pushd ${dir} && frobnicate x`,
    "popd; frobnicate x",
    "builtin cd /tmp && frobnicate x",
    "'cd' /tmp && frobnicate x",
    "\\cd /tmp && frobnicate x",
    "command cd /tmp; frobnicate x",
    "echo $(cd /tmp) && frobnicate x",
    "(cd /tmp; ls) && frobnicate x",
    "if cd /tmp; then frobnicate y; fi",
    "while popd; do frobnicate; done",
    "! cd - && frobnicate x",
    // F-12 fold (review-b M2a): a login-shell script runs where the OUTER cd went.
    "cd ~/.ssh && bash -c 'frobnicate id_rsa'",
    "cd ~/.aws && bash -c 'frobnicate credentials'",
    "cd ~/.claude-b1 && bash -c 'frobnicate settings.json'",
    "cd .git && bash -c 'frobnicate config'",
    "cd .approval/log && bash -c 'frobnicate events.jsonl'",
    "cd .github/workflows && bash -c 'frobnicate ci.yml'",
    "cd ~/.ssh; bash -c 'frobnicate id_rsa'",
    "cd ~/.ssh || bash -c 'frobnicate id_rsa'",
    "cd ~/.ssh && sh -c 'frobnicate id_ed25519'",
    "pushd sub && zsh -c 'frobnicate x'",
    // F-12 fold (review-b M2b): zsh's chdir is cd.
    "chdir Library; frobnicate x",
    "chdir private; frobnicate odin-token",
  ]) {
    const v = verdict(claude(dir, command, `t-o-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(p) a flag carrying a joined value keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of [`frobnicate -o${homedir()}/.ssh/id_rsa`, "frobnicate --out=/tmp/x", "frobnicate -o./x", "frobnicate -fPATH", "frobnicate -oAPPROVAL.md"]) {
    const v = verdict(claude(dir, command, `t-p-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(q) an assignment in front of the no-rule command keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  const v = verdict(claude(dir, `FOO=${dir}/APPROVAL.md frobnicate`, "t-q"));
  assert.equal(v.permission, "deny");
  assert.equal(verdict(claude(dir, "FOO=bar frobnicate", "t-q2")).permission, "deny");
  assert.equal(rawLog(dir), before);
});

test("(r) a bare word, a flag with a separate plain value, or nothing at all still abstains; a path-like word does not", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, "frobnicate status", "t-r1"), before);
  assertAbstained(dir, claude(dir, "frobnicate --flag value", "t-r2"), before);
  assertAbstained(dir, claude(dir, "frobnicate", "t-r3"), before);
  assertAbstained(dir, claude(dir, "frobnicate -v plain-word --flag", "t-r4"), before);
  // A symlink in a neutral directory is reached through a path-like word: refused.
  for (const command of ["frobnicate ./file", "frobnicate ./link", "frobnicate .env", "frobnicate sub/dir"]) {
    assert.equal(verdict(claude(dir, command, `t-r-${String(command.length)}`)).permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(s) a word with a glob or brace character, quoted or not, keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of ["frobnicate ~/.ss*/id_rsa", "frobnicate 'a?b'", "frobnicate x[1]", "frobnicate {a,b}", "frobnicate $HOME/x", "frobnicate \"$PWD/x\""]) {
    const v = verdict(claude(dir, command, `t-s-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(t) relative words are also judged from the envelope's cwd: a credential there keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "cc-sess-abstain",
    tool_use_id: "t-t",
    cwd: join(dir, ".approval"),
    tool_name: "Bash",
    tool_input: { command: "frobnicate env" },
  });
  const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
  assert.equal(verdict(run).permission, "deny");
  assert.equal(rawLog(dir), before);
});

test("(u) a heredoc, a here-string or a pipe-fed no-rule segment keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of ["frobnicate <<'X'\nbody line\nX", "frobnicate <<< word", "git status | frobnicate", "frobnicate < input"]) {
    const v = verdict(claude(dir, command, `t-u-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(v) a word carrying = or : keeps the refusal", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of ["frobnicate key=~/.ssh/id_rsa", "frobnicate key=value", "frobnicate host:path", "frobnicate --opt=plain"]) {
    const v = verdict(claude(dir, command, `t-v-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(w) a cwd inside a dot-directory, a protected path or a credential home keeps the refusal, even for a bare word", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const [cwd, command] of [
    [join(homedir(), ".ssh"), "frobnicate id_rsa"],
    [join(dir, ".approval"), "frobnicate status"],
    [join(dir, ".approval", "log"), "frobnicate"],
  ] as const) {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "cc-sess-abstain",
      tool_use_id: `t-w-${String(cwd.length)}`,
      cwd,
      tool_name: "Bash",
      tool_input: { command },
    });
    const run = runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
    assert.equal(verdict(run).permission, "deny", `${cwd}: ${command}`);
  }
  // The same bare words from the neutral tenant directory still abstain.
  assertAbstained(dir, claude(dir, "frobnicate id_rsa", "t-w-neutral"), before);
  assert.equal(rawLog(dir), before);
});

/**
 * F-12 fold (review-b M1, laundering): a classified command behind a word the
 * table does not know is not a no-rule segment. Every later word is read as a
 * command (and a quoted word as the script a runner may hand to a shell); any
 * answer other than "no rule" keeps today's deny.
 */
const LAUNDERED: readonly string[] = [
  "command npm publish",
  "builtin npm publish",
  "command -p npm publish",
  "command -- npm publish",
  "command git push origin main",
  "command claude -p hi",
  "command security dump-keychain",
  "command ssh host",
  "command rm x",
  "uv run npm publish",
  "caffeinate npm publish",
  "caffeinate -i npm publish",
  "arch npm publish",
  "nice npm publish",
  "script -q out npm publish",
  "screen -d -m npm publish",
  "tmux new -d npm publish",
  "su x -c 'npm publish'",
  "setsid npm publish",
  "flock lockname npm publish",
  "taskpolicy -b npm publish",
  "launchctl asuser 501 npm publish",
  "gtimeout 5 npm publish",
  "osascript -e 'do shell script \"npm publish\"'",
  "parallel npm publish",
  "chronic npm publish",
  "unbuffer npm publish",
  "bunx npm publish",
  "sg staff npm publish",
  "sg staff -c 'npm publish'",
  "strace npm publish",
  "dtruss npm publish",
  "lldb npm publish",
  "busybox rm x",
  // The quoted script is read segment by segment, not only its first word.
  "frobnicate 'helper; npm publish'",
];

test("(x) a classified command behind an unknown word (command, builtin, a runner) keeps today's deny", () => {
  const dir = ready(
    policy("abstain", [], [
      "  vcs.push.main:",
      "    autonomy: human-only",
      "  harness.launch.*:",
      "    autonomy: human-only",
      "  account.credential:",
      "    autonomy: human-only",
    ]),
  );
  const before = rawLog(dir);
  for (const command of LAUNDERED) {
    const run = claude(dir, command, `t-x-${String(command.length)}-${command.slice(0, 6)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  // Fail closed: an unknown CLI whose subcommand is a command the table reads keeps the deny too.
  const whoami = verdict(claude(dir, "railway whoami", "t-x-whoami"));
  assert.equal(whoami.permission, "deny");
  assert.match(whoami.reason, /^hook-unclassified: no rule for railway whoami/u);
  // SEC-3: a word with a space is read as a command too, so it is refused even when it names nothing.
  assert.equal(verdict(claude(dir, "frobnicate 'a b'", "t-x-ab")).permission, "deny");
  // A lookup of unknown words still abstains.
  assertAbstained(dir, claude(dir, "command -v frobnicate", "t-x-v"), before);
  assert.equal(rawLog(dir), before);
});

/** Draft 5 of the factory hands policy (W1-12 [F-12]), its yaml block with the key turned on. Synthetic copy. */
const DRAFT5 = [
  "# Factory hands policy (draft 5, test copy)",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised-retro",
  "  channel: cli",
  "  approval_ttl: 2h",
  "  on_expiry: reject",
  "  token_delivery: sealed",
  "  unclassified_command: abstain",
  "approvers:",
  "  carter:",
  "    channels: [cli]",
  "classes:",
  ...[
    ["read.*", "autonomous"],
    ["read.shell", "autonomous"],
    ["files.write.workspace", "autonomous"],
    ["files.delete.scratch", "autonomous"],
    ["vcs.commit.branch", "autonomous"],
    ["vcs.push.branch", "autonomous"],
    ["vcs.push.main", "autonomous"],
    ["vcs.pr.*", "autonomous"],
    ["deps.install", "autonomous"],
    ["exec.code", "autonomous"],
    ["log.sync", "autonomous"],
    ["factory.railway.var", "autonomous"],
    ["factory.roll", "autonomous"],
    ["factory.paste", "autonomous"],
    ["factory.deploy", "autonomous"],
    ["factory.tool.local", "autonomous"],
    ["factory.prod.read", "autonomous"],
    ["factory.referendum", "human-only"],
    ["factory.ddl", "human-only"],
    ["factory.secret.rotate", "human-only"],
    ["factory.npm.publish", "human-only"],
    ["release.publish", "human-only"],
    ["factory.partner.message", "human-only"],
    ["factory.tag.first-roll", "human-only"],
    ["account.credential", "human-only"],
    ["policy.core", "human-only"],
    ["policy.edit.ci", "human-only"],
    ["log.mutate", "human-only"],
    ["factory.claims.mutate", "human-only"],
    ["vcs.history.rewrite", "human-only"],
    ["vcs.ref.delete", "human-only"],
    ["harness.launch.*", "human-only"],
  ].flatMap(([name, autonomy]) => [`  ${String(name)}:`, `    autonomy: ${String(autonomy)}`]),
  "budgets:",
  "  global:",
  "    daily_actions: 20000",
  "```",
  "",
].join("\n");

test("(y) on draft 5 with the key on, the laundered and directory-moved shapes keep today's deny", () => {
  assert.equal(loadPolicyText("APPROVAL.md", DRAFT5).ok, true);
  const dir = ready(DRAFT5);
  const before = rawLog(dir);
  for (const command of [
    ...LAUNDERED,
    "cd ~/.ssh && bash -c 'frobnicate id_rsa'",
    "cd .approval/log && bash -c 'frobnicate events.jsonl'",
    "chdir Library; frobnicate x",
    `${UNCLASSIFIED} >> approval.md`,
  ]) {
    const run = claude(dir, command, `t-y-${String(command.length)}-${command.slice(0, 6)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  // The key still does its job on draft 5.
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-y-plain"), before);
  assert.equal(rawLog(dir), before);
});

test("(z) SEC-1: a quoted script stands in only as one plain segment that passes the no-rule guard itself", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of [
    "frobnicate -c 'helper >> approval.md'",
    "frobnicate -c 'helper > claude.md'",
    "frobnicate -c 'cd private; helper token'",
    "frobnicate -c 'helper; frob2'",
    "frobnicate -c 'helper && frob2'",
    "frobnicate -c 'helper | frob2'",
    "frobnicate -c 'helper < input'",
    "frobnicate -c 'chdir private'",
    "frobnicate -c 'helper approvals.md'",
    // SEC-3: the allowlist refuses any word with a space, so even a plain quoted script keeps the deny.
    "frobnicate -c 'helper plain-word'",
  ]) {
    const run = claude(dir, command, `t-z1-${String(command.length)}-${command.slice(14, 22)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  // Unknown lower-case words still abstain.
  assertAbstained(dir, claude(dir, "frobnicate -c helper plain-word", "t-z1-plain"), before);
  assert.equal(rawLog(dir), before);
});

test("(z2) SEC-2: APFS is case-insensitive: an upper-case command word, as written or read in a tail, keeps the deny", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of [
    "NPM publish",
    "command Git push origin main",
    "uv run NPM publish",
    "Claude -p hi",
    "Frobnicate x",
    "frobnicate -c 'Helper x'",
    // SEC-3: the allowlist also refuses an upper-case argument (it is read as a command by the tail check).
    "frobnicate README",
  ]) {
    const run = claude(dir, command, `t-z2-${String(command.length)}-${command.slice(0, 6)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  // Lower-case ASCII words still abstain.
  assertAbstained(dir, claude(dir, "frobnicate readme", "t-z2-readme"), before);
  assert.equal(rawLog(dir), before);
});

test("(z3) SEC-3: only lower-case ASCII command words stand in (fullwidth, diacritic and lookalike letters keep the deny)", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of [
    "\uFF4E\uFF50\uFF4D publish", // fullwidth npm
    "\u0143pm publish", // Latin capital N with acute
    "n\u0440m publish", // Cyrillic er in place of p
    "frobnicate \u0441url x", // a lookalike in a later word
    "\u00E9cho x", // a lower-case letter outside ASCII
  ]) {
    const run = claude(dir, command, `t-z3-${String(command.length)}-${String(command.codePointAt(0))}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(z4) SEC-4: a binary the rule table knows, with a subcommand no row lists, keeps the deny (aliases, unlisted targets)", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  for (const command of ["npm pub", "npm publ", "git p origin main", "gh rel create v1", "pnpm pub", "frobnicate npm pub"]) {
    const run = claude(dir, command, `t-z4-${String(command.length)}-${command.slice(0, 5)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-z4-plain"), before);
  assert.equal(rawLog(dir), before);
});

test("(z5) SEC-5: under a tripped loop floor a no-rule command is never handed to the harness", () => {
  const dir = ready(policy("abstain", [], ["  files.write.workspace:", "    autonomy: autonomous"]));
  const call = (event: string, command: string, id: string, response?: unknown): Run =>
    runCli(
      ["hook", "claude-code", "--as", "agent:cc", "--dir", dir],
      dir,
      JSON.stringify({
        hook_event_name: event,
        session_id: "cc-sess-floor",
        tool_use_id: id,
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command },
        ...(response === undefined ? {} : { tool_response: response }),
      }),
    );
  // Before any failure the no-rule command abstains in this session.
  const clean = rawLog(dir);
  assertAbstained(dir, call("PreToolUse", UNCLASSIFIED, "t-z5-0"), clean);
  // Three failed side-effecting calls trip the session's floor.
  for (const id of ["t-z5-1", "t-z5-2", "t-z5-3"]) {
    assert.equal(verdict(call("PreToolUse", "mkdir -p build", id)).permission, "allow");
    const post = call("PostToolUse", "mkdir -p build", id, { type: "error", error: "boom" });
    assert.equal(post.code, 0, post.stderr);
  }
  const before = rawLog(dir);
  const run = call("PreToolUse", UNCLASSIFIED, "t-z5-4");
  assert.notEqual(run.stdout, "", "a tripped floor must not abstain");
  const v = verdict(run);
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-unclassified: .*loop-escalated/u);
  assert.equal(rawLog(dir), before);
});
