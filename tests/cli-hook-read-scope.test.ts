/**
 * Read scope: the classifier's half, the disk half, and the harness half
 * (APRV-347).
 *
 * Three layers, and they are separated because they fail differently.
 *
 * 1. `classifyCommand` with synthetic roots: pure, no disk, a fixture table.
 *    What is under test is segment matching, so a real filesystem would only
 *    add ways for the test to be about something else.
 * 2. `refineReadScope` against real directories, real symlinks and a real
 *    working directory. `realpath` is the fact here, and a stub would be a
 *    second opinion about it.
 * 3. The compiled CLI, per harness. `approval hook classify` printing a
 *    different class from the one `approval hook claude-code` decides would
 *    make the explainer a different program (APRV-108's rule), and the read
 *    gate has to hold that line as much as the delete gate does.
 *
 * The out-of-scope target throughout is `/etc/hosts`: the scratch gates live
 * under the system temp root, which IS a read root by default, so a sibling
 * directory beside the gate would be in scope and would prove nothing. A path
 * under `/etc` is outside the gate root and outside every temp root on every
 * machine this suite runs on.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CLASSIFIER_CLASSES, classifyCommand } from "../src/core/command-class.js";
import {
  READ_OUT_OF_SCOPE_CLASS,
  effectiveReadRoots,
  isAtOrUnderReadRoot,
  readTargetsOf,
} from "../src/core/read-scope.js";
import { refineReadScope, resolveReadRoots } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-read-scope-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A path that is outside the gate root AND outside every temp root. */
const OUTSIDE = "/etc/hosts";

// ---------------------------------------------------------------------------
// 1. The pure half
// ---------------------------------------------------------------------------

/** Synthetic roots: this layer compares segments and never touches the disk. */
const ROOTS: readonly string[] = ["/dev/muse", "/private/tmp"];

function pure(command: string, roots: readonly string[] = ROOTS): {
  cls: string;
  rule: string;
  path: string | undefined;
} {
  const result = classifyCommand(command, [], { readRoots: roots });
  assert.equal(result.ok, true, `expected a classification for ${command}`);
  if (!result.ok) throw new Error("unreachable");
  const segment = result.segments[0];
  assert.ok(segment !== undefined);
  return { cls: segment.class, rule: segment.rule, path: segment.path };
}

test("an absolute read outside every root is read.file.out_of_scope, with the path bound", () => {
  for (const command of [
    "cat /dev/other/secrets",
    "head -20 /etc/passwd",
    "tail -f /var/log/system.log",
    "grep needle /dev/other",
    "rg needle /dev/other/src",
    "ls /dev/other",
    "find /dev/other -name '*.ts'",
    "sed -n '1,5p' /dev/other/x",
    "wc -l /dev/other/x",
    "stat /dev/other/x",
    "file /dev/other/x",
    "diff /dev/muse/a /dev/other/b",
  ]) {
    const verdict = pure(command);
    assert.equal(verdict.cls, READ_OUT_OF_SCOPE_CLASS, `${command} -> ${verdict.cls}`);
    assert.equal(typeof verdict.path, "string", `${command} bound no path`);
    assert.equal(
      verdict.path?.startsWith("/dev/other") || verdict.path?.startsWith("/etc") || verdict.path?.startsWith("/var"),
      true,
      `${command} bound ${String(verdict.path)}`,
    );
  }
});

test("the same commands inside a root stay read.shell", () => {
  for (const command of [
    "cat /dev/muse/src/a.ts",
    "head -20 /dev/muse/README.md",
    "grep needle /dev/muse/src",
    "rg needle /dev/muse",
    "ls /dev/muse",
    "find /dev/muse -name '*.ts'",
    "sed -n '1,5p' /dev/muse/x",
    // The root itself: at-or-under, not strictly-under. `ls <gate root>` is the
    // most ordinary command a session runs.
    "ls /private/tmp",
    "cat /private/tmp/scratch.txt",
  ]) {
    assert.equal(pure(command).cls, "read.shell", `${command} left the scope`);
  }
});

test("a target whose expansion the text cannot see is out of scope", () => {
  for (const command of ["cat $SOMEWHERE", "cat ~/secrets", "head /dev/*/x", "cat /dev/?ther/x"]) {
    const verdict = pure(command);
    assert.equal(verdict.cls, READ_OUT_OF_SCOPE_CLASS, `${command} -> ${verdict.cls}`);
    assert.equal(verdict.rule, "read-unreadable-path");
  }
});

test("a relative target is NOT decided here; it is left for the disk pass", () => {
  // The pure half has no working directory, so `../other/x` means nothing to
  // it. Answering out-of-scope here would be right by accident and wrong for
  // `./src/a.ts`; answering in-scope would be a hole. It answers neither.
  for (const command of ["cat ../other/x", "cat src/a.ts", "ls", "grep needle"]) {
    assert.equal(pure(command).cls, "read.shell", `${command} was decided too early`);
  }
});

test("a caller that passes no readRoots gets exactly the pre-APRV-347 answer", () => {
  const without = classifyCommand("cat /etc/passwd", []);
  assert.equal(without.ok, true);
  if (!without.ok) throw new Error("unreachable");
  assert.equal(without.segments[0]?.class, "read.shell");
  // And the empty list is not a silent synonym for "scope nothing": a caller
  // that means to scope reads passes roots, and one that passes none is the
  // caller that existed before this field.
  assert.equal(pure("cat /etc/passwd", []).cls, "read.shell");
});

test("the class is a member of the classifier's declared vocabulary", () => {
  assert.equal(CLASSIFIER_CLASSES.includes(READ_OUT_OF_SCOPE_CLASS), true);
});

test("a write, a credential touch and a protected path all outrank the read scope", () => {
  // The refinement is last and narrowest on purpose: a segment that has already
  // taken a stronger class is not a read, whatever binary opened it.
  assert.equal(pure("sed -i s/a/b/ /etc/hosts").cls, "files.write.workspace");
  assert.equal(pure("cat /etc/../dev/muse/.approval/env").cls, "account.credential");
  assert.equal(pure("ls /dev/other > out.txt").cls, "files.write.workspace");
});

test("segment matching is by segment, so a root is not a string prefix", () => {
  assert.equal(isAtOrUnderReadRoot("/dev/muse-other/x", "/dev/muse"), false);
  assert.equal(isAtOrUnderReadRoot("/dev/muse", "/dev/muse"), true);
  assert.equal(isAtOrUnderReadRoot("/dev/muse/x/y", "/dev/muse"), true);
  assert.equal(pure("cat /dev/muse-other/x").cls, READ_OUT_OF_SCOPE_CLASS);
});

test("a pattern delivered by flag does not shield the file operand", () => {
  // `grep -e needle /etc/passwd`: positional 0 is the FILE, and a rule that
  // always skipped the first positional would leave it unchecked.
  assert.deepEqual(readTargetsOf("grep", ["/etc/passwd"], ["-e", "needle", "/etc/passwd"]), [
    "/etc/passwd",
  ]);
  assert.deepEqual(readTargetsOf("grep", ["needle", "/etc/passwd"], ["needle", "/etc/passwd"]), [
    "/etc/passwd",
  ]);
  assert.equal(pure("grep -e needle /etc/passwd").cls, READ_OUT_OF_SCOPE_CLASS);
  // A binary this module does not scope answers `null`, and the segment is left
  // exactly as the table classified it.
  assert.equal(readTargetsOf("echo", ["/etc/passwd"]), null);
  assert.equal(pure("echo /etc/passwd").cls, "read.shell");
});

test("read_scope.roots widens and never narrows", () => {
  const roots = effectiveReadRoots({
    gateRoot: "/dev/muse",
    systemRoots: ["/private/tmp"],
    declared: ["/opt/corpus", "vendor", "", "$HOME/x"],
  });
  assert.deepEqual(roots, ["/dev/muse", "/private/tmp", "/opt/corpus", "/dev/muse/vendor"]);
  // The gate root leads whatever the policy says, and the two malformed entries
  // were dropped rather than turned into a root.
  assert.equal(roots[0], "/dev/muse");
  assert.equal(roots.includes("/"), false);
});

// ---------------------------------------------------------------------------
// 2. The disk half
// ---------------------------------------------------------------------------

function diskCase(): { root: string; sibling: string } {
  counter += 1;
  const base = join(scratch, `disk-${counter}`);
  const root = join(base, "muse");
  const sibling = join(base, "other");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(sibling, "secrets.txt"), "sk-live-do-not-read\n", "utf8");
  return { root: realpathSync(root), sibling: realpathSync(sibling) };
}

function decide(
  command: string,
  roots: readonly string[],
  cwd: string,
): { cls: string; rule: string; note: string } {
  const classified = classifyCommand(command, [], { readRoots: roots });
  assert.equal(classified.ok, true);
  if (!classified.ok) throw new Error("unreachable");
  const refined = refineReadScope(classified, roots, cwd);
  assert.equal(refined.result.ok, true);
  if (!refined.result.ok) throw new Error("unreachable");
  const segment = refined.result.segments[0];
  assert.ok(segment !== undefined);
  return { cls: segment.class, rule: segment.rule, note: refined.notes.join(" ") };
}

test("a relative target that escapes the root is tightened by the disk pass", () => {
  const { root, sibling } = diskCase();
  const inside = decide("cat src/a.ts", [root], root);
  assert.equal(inside.cls, "read.shell");

  const escaped = decide("cat ../other/secrets.txt", [root], root);
  assert.equal(escaped.cls, READ_OUT_OF_SCOPE_CLASS);
  assert.equal(escaped.rule, "read-out-of-scope-resolved");
  assert.match(escaped.note, /resolves to/u);
  assert.match(escaped.note, new RegExp(sibling.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("a symlink inside the root that points out of it does not smuggle a read", () => {
  const { root, sibling } = diskCase();
  const link = join(root, "peek");
  symlinkSync(sibling, link);
  // Textually under the root; physically not. Only the disk can say so.
  assert.equal(decide("cat peek/secrets.txt", [root], root).cls, READ_OUT_OF_SCOPE_CLASS);
  assert.equal(decide(`cat ${link}/secrets.txt`, [root], root).cls, READ_OUT_OF_SCOPE_CLASS);
});

test("a read with no operand is checked against the working directory", () => {
  const { root, sibling } = diskCase();
  assert.equal(decide("ls", [root], root).cls, "read.shell");
  assert.equal(decide("grep needle", [root], root).cls, "read.shell");
  // The same command, run from outside the scope, is a read of somewhere else.
  assert.equal(decide("ls", [root], sibling).cls, READ_OUT_OF_SCOPE_CLASS);
});

test("a target nothing can resolve is out of scope (fail closed)", () => {
  const { root } = diskCase();
  // A path whose every ancestor is absent resolves to nothing, and a path this
  // pass cannot place is a path it may not vouch for.
  const verdict = decide("cat /nonexistent-root-aprv347/deep/x", [root], root);
  assert.equal(verdict.cls, READ_OUT_OF_SCOPE_CLASS);
});

test("an empty root list leaves every segment untouched", () => {
  const { root } = diskCase();
  assert.equal(decide("cat ../other/secrets.txt", [], root).cls, "read.shell");
});

test("resolveReadRoots anchors on the gate root and widens from the policy", () => {
  const { root } = diskCase();
  const roots = resolveReadRoots(root, root);
  assert.equal(roots[0], root, "the gate root leads");
  // The system temp root is a default read root — but `resolveScratchRoots`
  // discards any candidate that CONTAINS the working directory, which is what
  // stops a root swallowing the checkout. These fixtures live under the temp
  // root, so the temp root is correctly absent here; in a real session the
  // working directory is the repository and the temp root stands.
  const outside = resolveReadRoots(process.cwd(), root);
  assert.equal(
    outside.some((candidate) => isAtOrUnderReadRoot(realpathSync(tmpdir()), candidate)),
    true,
    `the temp root is missing from ${outside.join(", ")}`,
  );
  // Widened by a declared root, which is joined onto the gate root when relative.
  const widened = resolveReadRoots(root, root, ["src"]);
  assert.equal(widened.includes(realpathSync(join(root, "src"))), true);
  // And widened by an absolute one — resolved, like every root, so `/etc`
  // arrives as `/private/etc` on macOS. A profile or a comparison naming an
  // unresolved path matches nothing (the lesson APRV-193 paid for).
  assert.equal(
    resolveReadRoots(root, root, ["/etc"]).includes(realpathSync("/etc")),
    true,
  );
});

// ---------------------------------------------------------------------------
// 3. The harness half, through the compiled CLI
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
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

/**
 * `read.file.out_of_scope` is `human-only` in this fixture.
 *
 * Not because that is what a project should write — the proposal for this
 * repository asks for `manual` — but because human-only is the one autonomy
 * whose refusal is immediate, total and appends nothing, so these cases test
 * the ROUTING (did the class reach policy resolution with the right name?)
 * without also standing up a channel, a daemon and a timeout.
 */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  read.file.out_of_scope:",
  "    autonomy: human-only",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  policy.core:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

function gate(): string {
  counter += 1;
  const dir = join(scratch, `gate-${counter}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function rawLog(dir: string): string {
  const path = join(dir, ".approval", "log", "events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function claudeVerdict(run: Run): { permission: string; reason: string } {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const out = parsed["hookSpecificOutput"] as Record<string, unknown>;
  return {
    permission: String(out["permissionDecision"]),
    reason: String(out["permissionDecisionReason"]),
  };
}

function claudeEvent(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "read-scope-1",
    // Self-reported, and never consulted: the tier and the scope are both
    // resolved from the hook's OWN directory.
    cwd: "/somewhere/else",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu-read-scope-1",
  });
}

test("Claude Code: Read, Glob and Grep inside the scope keep their pass-through allow", () => {
  const dir = gate();
  const before = rawLog(dir);
  for (const [tool, input] of [
    ["Read", { file_path: join(dir, "src", "a.ts") }],
    ["Read", { file_path: "src/a.ts" }],
    ["Glob", { pattern: "**/*.ts", path: dir }],
    ["Grep", { pattern: "needle", path: join(dir, "src") }],
  ] as const) {
    const verdict = claudeVerdict(runCli(["hook", "claude-code"], dir, claudeEvent(tool, input)));
    assert.equal(verdict.permission, "allow", `${tool} ${JSON.stringify(input)}`);
    assert.match(verdict.reason, /is not a gated tool/u);
  }
  assert.equal(rawLog(dir), before, "an in-scope read writes nothing at all");
});

test("Claude Code: a read tool carrying no path is still not a gated tool", () => {
  const dir = gate();
  for (const [tool, input] of [
    ["Glob", { pattern: "**/*.ts" }],
    ["Grep", { pattern: "needle" }],
  ] as const) {
    const verdict = claudeVerdict(runCli(["hook", "claude-code"], dir, claudeEvent(tool, input)));
    assert.equal(verdict.permission, "allow");
    assert.match(verdict.reason, /is not a gated tool/u);
  }
});

test("Claude Code: a Read outside the scope is answered by policy", () => {
  const dir = gate();
  for (const [tool, input] of [
    ["Read", { file_path: OUTSIDE }],
    ["Glob", { pattern: "*", path: "/etc" }],
    ["Grep", { pattern: "root", path: "/etc" }],
  ] as const) {
    const verdict = claudeVerdict(runCli(["hook", "claude-code"], dir, claudeEvent(tool, input)));
    assert.equal(verdict.permission, "deny", `${tool} ${JSON.stringify(input)}`);
    assert.match(verdict.reason, /^hook-class-human-only: /u);
    assert.match(verdict.reason, /read\.file\.out_of_scope/u);
  }
});

test("Claude Code: a path that resolves nowhere is out of scope, not waved through", () => {
  const dir = gate();
  const verdict = claudeVerdict(
    runCli(
      ["hook", "claude-code"],
      dir,
      claudeEvent("Read", { file_path: "/nonexistent-root-aprv347/deep/x" }),
    ),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-class-human-only: /u);
});

test("Claude Code: the harness-supplied cwd cannot move the scope", () => {
  const dir = gate();
  // `cwd` says `/etc`, which would make `/etc/hosts` a local read if the hook
  // believed it. SPEC.md §11.1: self-reported fields never reduce scrutiny.
  const event = JSON.stringify({
    session_id: "read-scope-2",
    cwd: "/etc",
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "hosts" },
    tool_use_id: "tu-read-scope-2",
  });
  const verdict = claudeVerdict(runCli(["hook", "claude-code"], dir, event));
  // Resolved against the HOOK's directory, so `hosts` is `<gate>/hosts`, which
  // is inside the scope and does not exist — an in-scope read of a missing file
  // is the harness's problem, not the gate's.
  assert.equal(verdict.permission, "allow");
});

test("Cursor: the read gate speaks the native envelope", () => {
  const dir = gate();
  const event = (input: Record<string, unknown>): string =>
    JSON.stringify({
      session_id: "cursor-read-1",
      cwd: "/repo",
      hook_event_name: "preToolUse",
      tool_name: "Read",
      tool_input: input,
    });

  const inside = runCli(["hook", "cursor"], dir, event({ path: "src/a.ts" }));
  const insideParsed = JSON.parse(inside.stdout) as Record<string, unknown>;
  assert.equal(insideParsed["permission"], "allow");
  assert.equal(insideParsed["hookSpecificOutput"], undefined);

  const outside = runCli(["hook", "cursor"], dir, event({ path: OUTSIDE }));
  const outsideParsed = JSON.parse(outside.stdout) as Record<string, unknown>;
  assert.equal(outsideParsed["permission"], "deny");
  assert.match(String(outsideParsed["agent_message"]), /^hook-class-human-only: /u);
});

test("Codex: there is no read tool to gate, and a read it cannot bind is denied", () => {
  const dir = gate();
  const event = JSON.stringify({
    session_id: "codex-read-1",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { path: OUTSIDE },
  });
  const run = runCli(["hook", "codex"], dir, event);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const out = parsed["hookSpecificOutput"] as Record<string, unknown>;
  // `Read` is not in the Codex adapter's tables at all — its native contract
  // exposes `Bash` and `apply_patch` and nothing else (docs/codex-hook.md) —
  // and a Codex allow must echo the exact bound `tool_input.command`, which a
  // tool carrying no command has none of. So the pass-through arm refuses,
  // which is pre-APRV-347 behaviour and the strict direction. A Codex read
  // reaches this runtime as a shell command or it does not reach it at all.
  assert.equal(out["permissionDecision"], "deny");
  assert.match(String(out["permissionDecisionReason"]), /^hook-io: /u);
});

test("unparseable hook input is denied, on every harness", () => {
  const dir = gate();
  for (const [verb, envelope] of [
    ["claude-code", "hookSpecificOutput"],
    ["cursor", "permission"],
    ["codex", "hookSpecificOutput"],
  ] as const) {
    const run = runCli(["hook", verb], dir, "{not json at all");
    assert.equal(run.code, 0, `${verb}: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.ok(envelope in parsed, `${verb} printed the wrong envelope`);
    const reason =
      envelope === "permission"
        ? String(parsed["agent_message"])
        : String((parsed["hookSpecificOutput"] as Record<string, unknown>)["permissionDecisionReason"]);
    assert.match(reason, /^hook-io: /u);
  }
});

test("`approval hook classify` prints the same class the harness hook decides", () => {
  const dir = gate();
  const outside = runCli(["hook", "classify", "--json", "--", `cat ${OUTSIDE}`], dir);
  assert.equal(outside.code, 0, outside.stderr);
  const parsed = JSON.parse(outside.stdout) as { classes: string[] };
  assert.deepEqual(parsed.classes, [READ_OUT_OF_SCOPE_CLASS]);

  const inside = runCli(["hook", "classify", "--json", "--", "cat src/a.ts"], dir);
  assert.deepEqual((JSON.parse(inside.stdout) as { classes: string[] }).classes, ["read.shell"]);

  // And the human rendering names the resolved path, so an operator reading the
  // table sees WHICH file left the scope.
  const human = runCli(["hook", "classify", "--", `cat ${OUTSIDE}`], dir);
  assert.match(human.stdout, /read\.file\.out_of_scope/u);
});

test("a shell read outside the scope is answered by policy through the harness hook", () => {
  const dir = gate();
  const event = claudeEvent("Bash", { command: `cat ${OUTSIDE}` });
  const verdict = claudeVerdict(runCli(["hook", "claude-code"], dir, event));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-class-human-only: /u);
});
