/**
 * The hook's own classification deadline (`cli/hook-deadline.ts`).
 *
 * A harness kills a hook that runs past its timeout, and on Claude Code,
 * Cursor, Grok, Muse (and Hermes without `fail_closed`) a killed hook lets the
 * call run. Classification is synchronous, so the wait's deadline never covered
 * it. These pin that a classification past the hook's own deadline is refused
 * `hook-classify-deadline` in every harness's deny format, appends nothing, and
 * comes back inside the deadline; that a real slow input (a 40,000-segment
 * path, which takes about 47 CPU s to classify on the branch this was cut from)
 * is interrupted, not merely a test spin; that a call finishing in time gets
 * its old verdict; and that the watchdog costs well under a millisecond.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { openWindow } from "../src/core/gate-window.js";
import { classifyForHook, commandHook, HOOK_DENY_CODES } from "../src/cli/hook.js";
import {
  classifyDeadlineDetail,
  classifyDeadlineMs,
  HOOK_CLASSIFY_DEADLINE_CODE,
  HOOK_CLASSIFY_DEADLINE_MS,
  runWithinDeadline,
  setClassifyDeadlineForTests,
} from "../src/cli/hook-deadline.js";

const ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const COMMAND_CLASS_VECTORS = fileURLToPath(
  new URL("../../conformance/vectors/command-class.v1.json", import.meta.url),
);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-classify-deadline-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => setClassifyDeadlineForTests(null));

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
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

function env(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  delete out["APPROVAL_HUMAN"];
  return out;
}

/** A fresh directory with the policy attested. */
function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = spawnSync(process.execPath, [ENTRY, "policy", "attest", "--as", "human:alice"], {
    cwd: dir,
    env: env(),
    encoding: "utf8",
    input: "",
  });
  assert.equal(attested.status, 0, attested.stderr);
  return dir;
}

function rawLog(dir: string): string {
  const path = join(dir, ".approval", "log", "events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

interface Verdict {
  permission: "allow" | "deny";
  message: string;
}

/** The nested PreToolUse envelope Claude Code, Codex and Muse read, keys checked exactly. */
function nested(stdout: string): Verdict {
  const body = JSON.parse(stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["hookSpecificOutput"]);
  const out = body["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(out["hookEventName"], "PreToolUse");
  const permission = out["permissionDecision"];
  assert.ok(permission === "allow" || permission === "deny", `permissionDecision ${String(permission)}`);
  return { permission, message: String(out["permissionDecisionReason"]) };
}

interface Harness {
  kind: "claude-code" | "cursor" | "codex" | "grok" | "muse" | "hermes";
  /** The exit code this harness's deny carries. */
  denyExit: number;
  /** A call the policy admits at once, so a deny can only be the deadline's. */
  call: (dir: string, command: string) => string;
  verdict: (stdout: string) => Verdict;
}

const PATCH = "*** Begin Patch\n*** Add File: deadline.txt\n+x\n*** End Patch";

const HARNESSES: readonly Harness[] = [
  {
    kind: "claude-code",
    denyExit: 0,
    call: (dir, command) =>
      JSON.stringify({
        session_id: "sess-deadline",
        transcript_path: "/dev/null",
        cwd: dir,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "tu-deadline",
      }),
    verdict: nested,
  },
  {
    kind: "cursor",
    denyExit: 0,
    call: (dir, command) =>
      JSON.stringify({
        session_id: "cursor-sess-deadline",
        cwd: dir,
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_input: { command },
        tool_use_id: "tu-deadline",
      }),
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["agent_message", "permission", "user_message"]);
      const permission = body["permission"];
      assert.ok(permission === "allow" || permission === "deny", `permission ${String(permission)}`);
      assert.equal(body["user_message"], body["agent_message"]);
      return { permission, message: String(body["agent_message"]) };
    },
  },
  {
    // Codex's native Bash is refused before classification (SPEC §10.6), so
    // the classified call is a direct apply_patch; its command is ignored.
    kind: "codex",
    denyExit: 0,
    call: (dir) =>
      JSON.stringify({
        session_id: "codex-sess-deadline",
        transcript_path: "/never/read",
        cwd: dir,
        hook_event_name: "PreToolUse",
        model: "synthetic-model",
        turn_id: "synthetic-turn",
        tool_name: "apply_patch",
        tool_use_id: "tu-deadline",
        tool_input: { command: PATCH },
      }),
    verdict: nested,
  },
  {
    kind: "grok",
    denyExit: 2,
    call: (dir, command) =>
      JSON.stringify({
        hookEventName: "PreToolUse",
        sessionId: "grok-sess-deadline",
        cwd: dir,
        workspaceRoot: dir,
        toolName: "Bash",
        toolInput: { command },
        toolUseId: "tu-deadline",
      }),
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["decision", "reason"]);
      const permission = body["decision"];
      assert.ok(permission === "allow" || permission === "deny", `decision ${String(permission)}`);
      return { permission, message: String(body["reason"]) };
    },
  },
  {
    kind: "muse",
    denyExit: 0,
    call: (dir, command) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "muse-sess-deadline",
        turn_id: "turn-1",
        tool_use_id: "tu-deadline",
        transcript_path: null,
        cwd: dir,
        model: "muse-spark-1.3",
        model_provider: "meta",
        permission_mode: "default",
        tool_name: "bash",
        tool_input: { command, workdir: dir },
      }),
    verdict: nested,
  },
  {
    kind: "hermes",
    denyExit: 2,
    call: (dir, command) =>
      JSON.stringify({
        hook_event_name: "pre_tool_call",
        session_id: "hermes-sess-deadline",
        tool_use_id: "tu-deadline",
        cwd: dir,
        profile: "default",
        extra: {},
        tool_name: "terminal",
        tool_input: { command, workdir: dir },
      }),
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      if (Object.keys(body).length === 0) return { permission: "allow", message: "" };
      assert.deepEqual(Object.keys(body).sort(), ["action", "message"]);
      assert.equal(body["action"], "block");
      return { permission: "deny", message: String(body["message"]) };
    },
  },
];

interface HookRun {
  code: number;
  stdout: string;
  ms: number;
}

/** One pre-execution call through the hook, in process. */
function hook(harness: Harness, dir: string, input: string, extra: string[] = []): HookRun {
  const out: string[] = [];
  const streams = { out: (text: string) => out.push(text), err: () => undefined };
  const started = performance.now();
  const code = commandHook(
    [harness.kind, "--as", `agent:${harness.kind}`, "--dir", dir, "--timeout", "1s", ...extra],
    streams,
    dir,
    () => input,
  );
  return { code, stdout: out.join(""), ms: performance.now() - started };
}

/** Spin on the CPU until `ms` have passed: a stand-in for a slow classifier. */
function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy
  }
}

test("hook-classify-deadline is a frozen member of HOOK_DENY_CODES, after the cap refusal", () => {
  assert.equal(HOOK_CLASSIFY_DEADLINE_CODE, "hook-classify-deadline");
  const at = HOOK_DENY_CODES.indexOf(HOOK_CLASSIFY_DEADLINE_CODE);
  assert.ok(at > 0, "listed");
  assert.equal(HOOK_DENY_CODES[at - 1], "hook-harness-cap-too-short");
});

test("the deadline is 20 s, or a third of a known harness cap when that is shorter", () => {
  assert.equal(HOOK_CLASSIFY_DEADLINE_MS, 20_000);
  assert.equal(classifyDeadlineMs(null), 20_000, "no cap known: Claude Code's 60 s default");
  assert.equal(classifyDeadlineMs(60_000), 20_000);
  assert.equal(classifyDeadlineMs(30_000), 10_000, "Hermes's default callback timeout");
  assert.equal(classifyDeadlineMs(300_000), 20_000, "never more than 20 s");
  assert.equal(classifyDeadlineMs(540_000), 20_000);
  assert.equal(classifyDeadlineMs(0), 1, "a spent cap still gives vm a positive timeout");
});

test("runWithinDeadline passes a value and a throw through untouched", () => {
  const value = { classes: ["read.shell"] };
  const ran = runWithinDeadline(5_000, () => value);
  assert.equal(ran.ok, true);
  assert.equal(ran.ok && ran.value, value, "the same object, not a copy");
  const thrown = new TypeError("from inside");
  assert.throws(
    () =>
      runWithinDeadline(5_000, () => {
        throw thrown;
      }),
    (error: unknown) => error === thrown,
  );
});

test("runWithinDeadline interrupts a backtracking regular expression that a catch inside cannot hold", () => {
  const started = performance.now();
  const ran = runWithinDeadline(200, () => {
    try {
      return /^(a+)+$/u.test(`${"a".repeat(40)}b`);
    } catch {
      return "caught inside";
    }
  });
  const ms = performance.now() - started;
  assert.equal(ran.ok, false);
  assert.ok(!ran.ok && ran.elapsedMs >= 150, `stopped at ${String(!ran.ok && ran.elapsedMs)}`);
  assert.ok(ms < 10_000, `returned after ${ms.toFixed(0)} ms`);
  // The process carries on normally after an interruption.
  const next = runWithinDeadline(5_000, () => 42);
  assert.deepEqual(next, { ok: true, value: 42 });
});

test("the refusal says what happened, that the call was not judged, and what to do", () => {
  const detail = classifyDeadlineDetail(20_004, 20_000);
  assert.match(detail, /stopped judging this call after 20\.0s, its own deadline of 20\.0s/u);
  assert.match(detail, /was not judged and is refused/u);
  assert.match(detail, /Nothing was appended/u);
  assert.match(detail, /Split the command into shorter commands, or shorten the long path, glob pattern or word/u);
});

for (const harness of HARNESSES) {
  test(`${harness.kind}: a classification past the deadline is denied hook-classify-deadline in its own format, and nothing is appended`, () => {
    const dir = ready();
    // The control first: the same call, with no injected slowness, is allowed
    // (and an autonomous allow records its execution).
    const control = hook(harness, dir, harness.call(dir, "ls"));
    assert.equal(control.code, 0, control.stdout);
    assert.equal(harness.verdict(control.stdout).permission, "allow", control.stdout);

    const before = rawLog(dir);
    setClassifyDeadlineForTests({ deadlineMs: 100, before: () => spin(30_000) });
    const slow = hook(harness, dir, harness.call(dir, "ls"));
    setClassifyDeadlineForTests(null);

    assert.equal(slow.code, harness.denyExit, slow.stdout);
    const verdict = harness.verdict(slow.stdout);
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.message, /^hook-classify-deadline: the hook stopped judging this call after /u);
    assert.match(verdict.message, /its own deadline of 0\.1s/u);
    assert.equal(rawLog(dir), before, "a deadline deny appends nothing");
    assert.ok(slow.ms < 15_000, `answered after ${slow.ms.toFixed(0)} ms, against a 30 s spin`);
  });
}

test("claude-code: a REAL slow classification (a 40,000-segment path) is interrupted, not only an injected spin", () => {
  const dir = ready();
  const harness = HARNESSES[0] as Harness;
  const command = `cat ${"a/".repeat(40_000)}x`;
  const before = rawLog(dir);
  setClassifyDeadlineForTests({ deadlineMs: 300 });
  const slow = hook(harness, dir, harness.call(dir, command));
  setClassifyDeadlineForTests(null);
  const verdict = harness.verdict(slow.stdout);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /^hook-classify-deadline: /u);
  assert.equal(rawLog(dir), before);
  // About 47 CPU s uninterrupted; the bound leaves room for a busy runner.
  assert.ok(slow.ms < 15_000, `answered after ${slow.ms.toFixed(0)} ms`);
});

test("claude-code: the read-tool fast path is under the deadline too", () => {
  const dir = ready();
  writeFileSync(join(dir, "notes.txt"), "hello\n", "utf8");
  const read = JSON.stringify({
    session_id: "sess-deadline",
    transcript_path: "/dev/null",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(dir, "notes.txt") },
    tool_use_id: "tu-read",
  });
  const harness = HARNESSES[0] as Harness;
  assert.equal(harness.verdict(hook(harness, dir, read).stdout).permission, "allow");
  setClassifyDeadlineForTests({ deadlineMs: 100, before: () => spin(30_000) });
  const slow = hook(harness, dir, read);
  setClassifyDeadlineForTests(null);
  const verdict = harness.verdict(slow.stdout);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /^hook-classify-deadline: /u);
});

test("claude-code: the open window's bypass classifies under the deadline, and records no bypass", () => {
  const dir = ready();
  const opened = openWindow(
    join(dir, ".approval", "log", "events.jsonl"),
    { durationText: "30m", durationMs: 30 * 60_000, reason: "debugging the classify deadline" },
    "human:alice",
  );
  assert.equal(opened.ok, true, opened.ok ? "" : `${opened.code}: ${opened.message}`);
  const harness = HARNESSES[0] as Harness;
  const before = rawLog(dir);
  setClassifyDeadlineForTests({ deadlineMs: 100, before: () => spin(30_000) });
  const slow = hook(harness, dir, harness.call(dir, "npm install left-pad"));
  setClassifyDeadlineForTests(null);
  const verdict = harness.verdict(slow.stdout);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /^hook-classify-deadline: /u);
  assert.equal(rawLog(dir), before, "no gate.bypassed for a call nobody finished judging");
});

test("under the real 20 s deadline, the command-class corpus classifies exactly as without it", () => {
  // The equivalence the deadline promises for input that finishes in time:
  // the same function, the same arguments, the same answer. Every eighth
  // command of the conformance corpus, so the pin costs about a second; the
  // whole corpus took 13 s when the change was made, and matched.
  const corpus = JSON.parse(readFileSync(COMMAND_CLASS_VECTORS, "utf8")) as {
    vectors: { input: { command?: unknown } }[];
  };
  const commands = corpus.vectors
    .map((vector) => vector.input.command)
    .filter((command): command is string => typeof command === "string");
  assert.ok(commands.length > 300, `corpus has ${String(commands.length)} commands`);
  const cwd = ready();
  for (const command of commands.filter((_, at) => at % 8 === 0)) {
    const bare = classifyForHook(command, [], cwd, [], false, []);
    const bounded = runWithinDeadline(classifyDeadlineMs(null), () =>
      classifyForHook(command, [], cwd, [], false, []),
    );
    assert.equal(bounded.ok, true, command);
    assert.deepEqual(bounded.ok && bounded.value, bare, command);
  }
});

test("cost: the watchdog adds well under a millisecond of CPU per call when it does not fire", () => {
  const calls = 500;
  const start = process.cpuUsage();
  for (let i = 0; i < calls; i += 1) runWithinDeadline(HOOK_CLASSIFY_DEADLINE_MS, () => i);
  const used = process.cpuUsage(start);
  const perCallMs = (used.user + used.system) / 1000 / calls;
  // About 0.07 ms on a laptop; CPU time, so a busy runner does not stretch it.
  assert.ok(perCallMs < 1, `${perCallMs.toFixed(3)} CPU ms per call`);
});
