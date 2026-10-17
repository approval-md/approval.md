/**
 * `exec.code` through the real hooks (APRV-510).
 *
 * Opaque agent code (`python3 -c`, `node -e` and kin, an interpreter running a
 * file that is not a skill script, Hermes `execute_code`) was refused before
 * policy on every harness. These cases pin what a policy can now do with it,
 * and, as firmly, what a policy that says nothing still gets:
 *
 * - SILENT POLICY: today's refusal, byte for byte (`hook-opaque`,
 *   `hook-unclassified`, `hook-hermes-execute-code-unbound`, same words);
 * - the policy NAMES `exec.code` without `exec.code.custody: attested`:
 *   `hook-exec-code-custody-unattested`, naming the key;
 * - custody attested: the call is classified `exec.code`, resolved like any
 *   class, and recorded by the program's SHA-256 and length; the program TEXT
 *   never reaches the log or the payload store;
 * - a file program the hook cannot read: `hook-exec-code-unreadable`;
 * - `execute_code` needs `exec.code.execute_code: hooked` beside custody.
 *
 * Spawn the compiled CLI; never hand-write log lines.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-exec-code-")));
let counter = 0;
/** A fresh tool-call id per hook invocation: one id is one action key. */
let calls = 0;
function nextCall(): string {
  calls += 1;
  return String(calls);
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

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

/** A policy: manual default unless `defaults` says otherwise, plus extra lines. */
function policy({
  autonomy = "manual",
  classes = [] as string[],
  exec = [] as string[],
} = {}): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    `  autonomy: ${autonomy}`,
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    ...exec,
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  files.write.workspace:",
    "    autonomy: autonomous",
    "  exec.local:",
    "    autonomy: autonomous",
    "  policy.core:",
    "    autonomy: human-only",
    "  log.mutate:",
    "    autonomy: human-only",
    "  account.credential:",
    "    autonomy: human-only",
    ...classes,
    "```",
    "",
  ].join("\n");
}

const CUSTODY = ["exec:", "  code:", "    custody: attested"];
const BOTH = ["exec:", "  code:", "    custody: attested", "    execute_code: hooked"];
const ROW_AUTONOMOUS = ["  exec.code:", "    autonomy: autonomous"];
const ROW_MANUAL = ["  exec.code:", "    autonomy: manual"];

function ready(text: string): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const LOG = ".approval/log/events.jsonl";

function records(dir: string): Record<string, unknown>[] {
  const path = join(dir, LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Everything the gate wrote: the log and every stored payload. */
function written(dir: string): string {
  const payloads = join(dir, ".approval", "payloads");
  const stored = existsSync(payloads)
    ? readdirSync(payloads).map((name) => readFileSync(join(payloads, name), "utf8"))
    : [];
  const log = existsSync(join(dir, LOG)) ? readFileSync(join(dir, LOG), "utf8") : "";
  return [log, ...stored].join("\n");
}

// --- Hermes ------------------------------------------------------------------

function hermes(dir: string, tool: string, input: Record<string, unknown>, extra: string[] = []): Run {
  const body = JSON.stringify({
    hook_event_name: "pre_tool_call",
    session_id: "exec-code-sess",
    tool_use_id: `tool-${nextCall()}`,
    cwd: dir,
    profile: "default",
    extra: { turn_id: "turn-1" },
    tool_name: tool,
    tool_input: input,
  });
  return runCli(["hook", "hermes", "--as", "agent:hermes", "--dir", dir, ...extra], dir, body);
}

function terminal(dir: string, command: string): Run {
  return hermes(dir, "terminal", { command, workdir: dir });
}

interface Verdict {
  permission: "allow" | "deny";
  code: string | null;
  message: string;
}

function hermesVerdict(run: Run): Verdict {
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  if (Object.keys(parsed).length === 0) {
    assert.equal(run.code, 0, run.stderr);
    return { permission: "allow", code: null, message: run.stderr };
  }
  assert.equal(parsed["action"], "block", run.stdout);
  assert.equal(run.code, 2);
  const message = String(parsed["message"]);
  const colon = message.indexOf(":");
  return { permission: "deny", code: colon > 0 ? message.slice(0, colon) : null, message };
}

// --- Claude Code ---------------------------------------------------------------

function claude(dir: string, command: string, extra: string[] = []): Run {
  const body = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "exec-code-cc",
    tool_use_id: `cc-${nextCall()}`,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir, ...extra], dir, body);
}

function claudeVerdict(run: Run): Verdict {
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> };
  const nested = parsed.hookSpecificOutput ?? {};
  const permission = String(nested["permissionDecision"]) as "allow" | "deny";
  const message = String(nested["permissionDecisionReason"]);
  const colon = message.indexOf(":");
  return {
    permission,
    code: permission === "deny" && colon > 0 ? message.slice(0, colon) : null,
    message,
  };
}

const INLINE = "python3 -c 'import os; print(\"example-not-a-key\")'";
const INLINE_SOURCE = 'import os; print("example-not-a-key")';

// ---------------------------------------------------------------------------
// A silent policy keeps today's refusals, byte for byte
// ---------------------------------------------------------------------------

test("a policy that never names exec.code refuses every inline form exactly as before", () => {
  const dir = ready(policy({ autonomy: "autonomous" }));
  for (const command of [
    INLINE,
    "node -e 'console.log(1)'",
    "node --eval 'console.log(1)'",
    "deno eval 'console.log(1)'",
    "perl -e 'print 1'",
    "ruby -e 'puts 1'",
    "bun -e 'console.log(1)'",
    "python3 tool.py",
  ]) {
    const classified = classifyCommand(command);
    assert.equal(classified.ok, false, command);
    if (classified.ok) continue;
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.permission, "deny", command);
    assert.equal(verdict.code, `hook-${classified.code}`, command);
    assert.equal(
      verdict.message,
      `hook-${classified.code}: ${classified.detail} (segment: ${classified.segment}). Rewrite it as a command the classifier can read, or run the effect through \`approval run\` with a granted token.`,
      command,
    );
  }
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
});

test("an exec.* family row is not a mention: the refusal stays today's", () => {
  const dir = ready(policy({ classes: ["  exec.*:", "    autonomy: autonomous"] }));
  assert.equal(hermesVerdict(terminal(dir, INLINE)).code, "hook-opaque");
});

test("execute_code under a silent policy keeps its own refusal, word for word", () => {
  const dir = ready(policy({ autonomy: "autonomous" }));
  const verdict = hermesVerdict(hermes(dir, "execute_code", { code: "print(2 + 2)" }));
  assert.equal(verdict.code, "hook-hermes-execute-code-unbound");
  assert.equal(
    verdict.message,
    "hook-hermes-execute-code-unbound: Hermes execute_code is refused because the call carries a program and nothing else: no path, no argv and no working directory, so no class can be resolved and no payload can bind what it would do. Run the work through the `terminal` tool, where the words are visible to the classifier, or through `approval run` with a granted token. No policy or open window authorizes bytes the hook cannot read",
  );
});

// ---------------------------------------------------------------------------
// A policy that names the class without custody
// ---------------------------------------------------------------------------

test("an exec.code row without custody refuses hook-exec-code-custody-unattested, naming the key", () => {
  const dir = ready(policy({ classes: ROW_AUTONOMOUS }));
  for (const verdict of [hermesVerdict(terminal(dir, INLINE)), claudeVerdict(claude(dir, INLINE))]) {
    assert.equal(verdict.permission, "deny");
    assert.equal(verdict.code, "hook-exec-code-custody-unattested");
    assert.match(verdict.message, /exec\.code\.custody: attested/u);
  }
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
});

test("the custody-unattested refusal names the program by hash, never by text (refuter S2)", () => {
  const dir = ready(policy({ classes: ROW_AUTONOMOUS }));
  const sha = createHash("sha256").update(INLINE_SOURCE).digest("hex");
  for (const verdict of [hermesVerdict(terminal(dir, INLINE)), claudeVerdict(claude(dir, INLINE))]) {
    assert.equal(verdict.code, "hook-exec-code-custody-unattested");
    assert.equal(verdict.message.includes("example-not-a-key"), false, verdict.message);
    assert.match(verdict.message, new RegExp(`python3 inline program sha256:${sha}`, "u"));
  }
});

test("APPROVAL_HOOK_REQUIRE_SANDBOX names an exec.code program by hash, never by text (refuter S1)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  const body = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "exec-code-cc",
    tool_use_id: `cc-${nextCall()}`,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command: INLINE },
  });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, APPROVAL_HOOK_REQUIRE_SANDBOX: "1" };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(
    process.execPath,
    [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--dir", dir],
    { cwd: dir, encoding: "utf8", env: childEnv, input: body },
  );
  const verdict = claudeVerdict({ code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr });
  assert.equal(verdict.code, "hook-sandbox-required", verdict.message);
  assert.equal(`${result.stdout}${result.stderr}`.includes("example-not-a-key"), false);
  assert.match(verdict.message, /python3 inline program sha256:[0-9a-f]{64}/u);
});

test("a Hermes terminal call with background or pty set keeps today's refusal (refuter S3)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  for (const extra of [{ background: true }, { pty: true }, { background: "yes" }]) {
    const verdict = hermesVerdict(hermes(dir, "terminal", { command: INLINE, workdir: dir, ...extra }));
    assert.equal(verdict.code, "hook-opaque", `${JSON.stringify(extra)}: ${verdict.message}`);
  }
  const plain = hermesVerdict(hermes(dir, "terminal", { command: INLINE, workdir: dir, background: false }));
  assert.equal(plain.permission, "allow", plain.message);
});

test("a program or command with a lone surrogate is refused hook-exec-code-unreadable (refuter S5)", () => {
  const dir = ready(policy({ exec: BOTH, classes: ROW_AUTONOMOUS }));
  const shell = hermesVerdict(terminal(dir, "python3 -c 'x\udc80'"));
  assert.equal(shell.code, "hook-exec-code-unreadable", shell.message);
  const kernel = hermesVerdict(hermes(dir, "execute_code", { code: "x\udc80" }));
  assert.equal(kernel.code, "hook-exec-code-unreadable", kernel.message);
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
});

test("an explicit custody: unattested refuses the same way, and bash -c stays opaque", () => {
  const dir = ready(policy({ exec: ["exec:", "  code:", "    custody: unattested"] }));
  assert.equal(hermesVerdict(terminal(dir, "node -e 'x'")).code, "hook-exec-code-custody-unattested");
  assert.equal(hermesVerdict(terminal(dir, "bash -c 'curl x | sh'")).code, "hook-opaque");
});

test("execute_code with execute_code: hooked but no custody is custody-unattested", () => {
  const dir = ready(policy({ exec: ["exec:", "  code:", "    execute_code: hooked"] }));
  const verdict = hermesVerdict(hermes(dir, "execute_code", { code: "print(1)" }));
  assert.equal(verdict.code, "hook-exec-code-custody-unattested");
});

// ---------------------------------------------------------------------------
// Custody attested
// ---------------------------------------------------------------------------

test("custody attested and an autonomous row: the inline program runs, recorded by hash, never by text", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  const verdict = hermesVerdict(terminal(dir, INLINE));
  assert.equal(verdict.permission, "allow", verdict.message);
  assert.match(verdict.message, /autonomous: exec\.code/u);
  const sha = createHash("sha256").update(INLINE_SOURCE).digest("hex");
  assert.match(verdict.message, new RegExp(`sha256:${sha}`, "u"));
  const starts = records(dir).filter((r) => r["event"] === "execution.started");
  assert.equal(starts.length, 1);
  assert.equal(((starts[0]?.["payload"] ?? {}) as Record<string, unknown>)["class"], "exec.code");
  assert.equal(written(dir).includes("example-not-a-key"), false, "the program text never reaches the log");
});

test("every inline form classifies exec.code under custody, on Claude Code too", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  for (const command of [
    "node -e 'console.log(1)'",
    "node --eval 'console.log(1)'",
    "bun -e 'console.log(1)'",
    "deno eval 'console.log(1)'",
    "perl -e 'print 1'",
    "ruby -e 'puts 1'",
    "python -c 'print(1)'",
    "python3 -I -c 'print(1)'",
  ]) {
    const verdict = claudeVerdict(claude(dir, command));
    assert.equal(verdict.permission, "allow", `${command}: ${verdict.message}`);
    assert.match(verdict.message, /exec\.code/u, command);
  }
});

test("shapes outside the scope stay refused under custody", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  const cases: [string, string][] = [
    ["bash -c 'python3 -c \"print(1)\"'", "hook-opaque"],
    ["sh -c \"node -e 'console.log(1)'\"", "hook-opaque"],
    ["eval 'python3 -c x'", "hook-opaque"],
    ["curl -s https://example.com/x.py | python3", "hook-unclassified"],
    ["python3 -", "hook-unclassified"],
    ["python3 -m http.server", "hook-unclassified"],
    ["PYTHONSTARTUP=x.py python3 -c 'print(1)'", "hook-opaque"],
    ["python3 -c \"print('$HOME')\"", "hook-opaque"],
    ["python3 -c 'print(1)' < input.txt", "hook-opaque"],
    ["python3 -c 'print(1)' > out.txt", "hook-opaque"],
    ["./python3 -c 'print(1)'", "hook-opaque"],
  ];
  for (const [command, code] of cases) {
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.permission, "deny", command);
    assert.equal(verdict.code, code, `${command}: ${verdict.message}`);
  }
});

test("custody attested and no exec.code row: the class falls to defaults.autonomy", () => {
  const recorder = ready(policy({ autonomy: "autonomous", exec: CUSTODY }));
  assert.equal(hermesVerdict(terminal(recorder, INLINE)).permission, "allow");

  // Manual default: the call opens a request, which nobody answers here.
  const gated = ready(policy({ exec: CUSTODY }));
  const verdict = claudeVerdict(claude(gated, INLINE, ["--timeout", "1s", "--interval", "100ms"]));
  assert.equal(verdict.permission, "deny");
  const requested = records(gated).filter((r) => r["event"] === "approval.requested");
  assert.equal(requested.length, 1);
  assert.equal(((requested[0]?.["payload"] ?? {}) as Record<string, unknown>)["class"], "exec.code");
});

test("a manual exec.code row holds the call, and the stored payload binds hash and length only", () => {
  const dir = ready(policy({ autonomy: "autonomous", exec: CUSTODY, classes: ROW_MANUAL }));
  const verdict = claudeVerdict(claude(dir, `cd ${dir} && ${INLINE}`, ["--timeout", "1s", "--interval", "100ms"]));
  assert.equal(verdict.permission, "deny");
  const requested = records(dir).filter((r) => r["event"] === "approval.requested");
  assert.equal(requested.length, 1);
  assert.equal(written(dir).includes("example-not-a-key"), false);
  const payloads = readdirSync(join(dir, ".approval", "payloads"));
  const stored = payloads
    .map((name) => JSON.parse(readFileSync(join(dir, ".approval", "payloads", name), "utf8")) as unknown)
    .find((value) => JSON.stringify(value).includes("exec_code")) as Record<string, unknown> | undefined;
  assert.notEqual(stored, undefined, "the exec.code payload is stored");
  const text = JSON.stringify(stored);
  const sha = createHash("sha256").update(INLINE_SOURCE).digest("hex");
  assert.match(text, new RegExp(sha, "u"));
  assert.match(text, new RegExp(createHash("sha256").update(`cd ${dir} && ${INLINE}`).digest("hex"), "u"));
  assert.equal(text.includes('"command"'), false, "no command string rides in the payload");
});

test("a file program is read and hashed; a skill script stays exec.local", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  writeFileSync(join(dir, "tool.py"), 'print("example-not-a-key")\n', "utf8");
  const verdict = hermesVerdict(terminal(dir, "python3 tool.py --flag"));
  assert.equal(verdict.permission, "allow", verdict.message);
  const sha = createHash("sha256").update('print("example-not-a-key")\n').digest("hex");
  assert.match(verdict.message, new RegExp(sha, "u"));

  mkdirSync(join(dir, "skills", "demo", "scripts"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "scripts", "run.py"), "print(1)\n", "utf8");
  const skill = hermesVerdict(terminal(dir, "python3 skills/demo/scripts/run.py"));
  assert.equal(skill.permission, "allow", skill.message);
  assert.match(skill.message, /exec\.local/u);
  assert.doesNotMatch(skill.message, /exec\.code/u);
});

test("a relative file program after a cd, pushd or popd is refused: the hook cannot tell which file runs (review finding 2)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  mkdirSync(join(dir, "other"));
  writeFileSync(join(dir, "a.py"), "print('decoy')\n", "utf8");
  writeFileSync(join(dir, "other", "a.py"), "print('real')\n", "utf8");
  for (const command of ["cd other && python3 a.py", "cd other || true; python3 a.py"]) {
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.code, "hook-exec-code-unreadable", `${command}: ${verdict.message}`);
  }
  // pushd and popd are refused on their own today, so the line never runs.
  for (const command of ["pushd other && python3 a.py", "popd; python3 a.py"]) {
    assert.equal(hermesVerdict(terminal(dir, command)).permission, "deny", command);
  }
  // An absolute path names one file wherever the shell stands, but since fix
  // round 2 (refuter M2) file mode opens only for the line's sole segment, so
  // the `cd` line is refused all the same, and the absolute path alone binds.
  const absolute = hermesVerdict(terminal(dir, `cd other && python3 ${join(dir, "other", "a.py")}`));
  assert.equal(absolute.code, "hook-exec-code-unreadable", absolute.message);
  const alone = hermesVerdict(terminal(dir, `python3 ${join(dir, "other", "a.py")}`));
  assert.equal(alone.permission, "allow", alone.message);
});

// ---------------------------------------------------------------------------
// Fix round 2 (f6ff8f75 recheck): M1, M2, N8
// ---------------------------------------------------------------------------

/** The SHA-256 of what `cat <path>` reads in `cwd`: the file the kernel opens. */
function kernelSha(cwd: string, path: string): string {
  const read = spawnSync("cat", [path], { cwd });
  assert.equal(read.status, 0, `cat ${path} in ${cwd}`);
  return createHash("sha256").update(read.stdout).digest("hex");
}

test("a file program path with `..`, a later `.`, or a symlinked directory is refused, never folded (refuter M1)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  writeFileSync(join(dir, "x.py"), "print('top')\n", "utf8");
  mkdirSync(join(dir, "real", "sub"), { recursive: true });
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "real", "x.py"), "print('real')\n", "utf8");
  writeFileSync(join(dir, "real", "sub", "keep.py"), "print('keep')\n", "utf8");
  writeFileSync(join(dir, "sub", "x.py"), "print('sub')\n", "utf8");
  symlinkSync("real/sub", join(dir, "lnk"));
  symlinkSync("real/x.py", join(dir, "alias.py"));
  // The differential itself: a lexical fold names `x.py`, the kernel opens `real/x.py`.
  assert.equal(kernelSha(dir, "lnk/../x.py"), createHash("sha256").update("print('real')\n").digest("hex"));
  for (const command of [
    "python3 lnk/../x.py",
    `python3 ${join(dir, "lnk")}/../x.py`,
    "python3 sub/../x.py",
    "python3 real/sub/../x.py",
    "python3 ../x.py",
    "python3 sub/./x.py",
    "python3 sub//x.py",
    "python3 lnk/keep.py",
    `python3 ${join(dir, "lnk", "keep.py")}`,
  ]) {
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.code, "hook-exec-code-unreadable", `${command}: ${verdict.message}`);
  }
  // A symlinked workdir: `..` leaves the real directory, and with no `..` the
  // directory is still not its own realpath (the seat's stricter rule).
  for (const command of ["python3 ../x.py", "python3 keep.py", "python3 ./keep.py"]) {
    const verdict = hermesVerdict(hermes(dir, "terminal", { command, workdir: join(dir, "lnk") }));
    assert.equal(verdict.code, "hook-exec-code-unreadable", `${command} in lnk: ${verdict.message}`);
  }
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
  // Accepted: real directories, a leading `./`, and a symlinked FILE (the
  // realpath of the file itself is what the kernel opens).
  for (const path of ["./x.py", "real/x.py", "sub/x.py", "alias.py", join(dir, "real", "sub", "keep.py")]) {
    const verdict = hermesVerdict(terminal(dir, `python3 ${path}`));
    assert.equal(verdict.permission, "allow", `${path}: ${verdict.message}`);
    assert.match(verdict.message, new RegExp(kernelSha(dir, path), "u"), path);
  }
});

test("file mode opens only for the line's sole segment: an earlier write, copy, move or link is refused (refuter M2)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  writeFileSync(join(dir, "x.py"), "print(1)\n", "utf8");
  writeFileSync(join(dir, "evil.py"), "print(2)\n", "utf8");
  for (const command of [
    "echo 'print(2)' > x.py; python3 x.py",
    "cp evil.py x.py && python3 x.py",
    "mv evil.py x.py; python3 x.py",
    "echo 'print(2)' | tee x.py; python3 x.py",
    "ln -sf evil.py x.py; python3 x.py",
    "true || python3 x.py",
    "python3 x.py; echo done",
    "python3 x.py && echo done",
    "python3 x.py | cat",
    "python3 x.py & echo done",
    "python3 x.py\necho done",
    "cd sub && python3 x.py",
    `cd ${dir} && python3 ${join(dir, "x.py")}`,
  ]) {
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.code, "hook-exec-code-unreadable", `${command}: ${verdict.message}`);
  }
  assert.equal(readFileSync(join(dir, "x.py"), "utf8"), "print(1)\n", "nothing ran");
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
  // The accepted controls: the program alone, and an inline program beside
  // another segment (its source is in argv, so no earlier segment rewrites it).
  for (const command of ["python3 x.py", "python3 x.py 2>/dev/null", "python3 -c 'print(1)' 2>&1", "echo start; python3 -c 'print(1)'"]) {
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.permission, "allow", `${command}: ${verdict.message}`);
  }
});

/** A Claude Code `Bash` call whose envelope `cwd` is `envelopeCwd` (absent when `null`), from a hook run in `hookCwd`. */
function claudeAt(dir: string, command: string, envelopeCwd: string | null, hookCwd: string): Run {
  const body = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "exec-code-cc",
    tool_use_id: `cc-${nextCall()}`,
    ...(envelopeCwd === null ? {} : { cwd: envelopeCwd }),
    tool_name: "Bash",
    tool_input: { command },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], hookCwd, body);
}

test("Claude Code file mode resolves against the envelope's cwd, and refuses without one (refuter N8)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "x.py"), "print('hook cwd')\n", "utf8");
  writeFileSync(join(dir, "a", "x.py"), "print('envelope cwd')\n", "utf8");
  const envelopeSha = createHash("sha256").update("print('envelope cwd')\n").digest("hex");
  const hookSha = createHash("sha256").update("print('hook cwd')\n").digest("hex");
  // The hook process runs in the gate root; the envelope says `a`.
  const bound = claudeVerdict(claudeAt(dir, "python3 x.py", join(dir, "a"), dir));
  assert.equal(bound.permission, "allow", bound.message);
  assert.match(bound.message, new RegExp(`python3 file program sha256:${envelopeSha}`, "u"));
  assert.equal(bound.message.includes(hookSha), false, "the hook directory's file is never bound");
  // Only the hook's directory has the file: refused, not read from there.
  rmSync(join(dir, "a", "x.py"));
  const missing = claudeVerdict(claudeAt(dir, "python3 x.py", join(dir, "a"), dir));
  assert.equal(missing.code, "hook-exec-code-unreadable", missing.message);
  // No envelope cwd: file mode is refused, relative or absolute, rather than guessed.
  for (const command of ["python3 x.py", `python3 ${join(dir, "x.py")}`]) {
    const verdict = claudeVerdict(claudeAt(dir, command, null, dir));
    assert.equal(verdict.code, "hook-exec-code-unreadable", `${command}: ${verdict.message}`);
  }
  // A relative envelope cwd is no statement either.
  const relative = claudeVerdict(claudeAt(dir, "python3 x.py", "a", dir));
  assert.equal(relative.code, "hook-exec-code-unreadable", relative.message);
});

/** A Muse `bash` call, the session `cwd` the gate root; `workdir` is left out when `undefined`. */
function museAt(dir: string, command: string, workdir: unknown): Run {
  const body = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "exec-code-muse",
    turn_id: "turn-1",
    tool_use_id: `muse-${nextCall()}`,
    transcript_path: null,
    cwd: dir,
    model: "muse-spark-1.3",
    model_provider: "meta",
    permission_mode: "default",
    tool_name: "bash",
    tool_input: { command, ...(workdir === undefined ? {} : { workdir }) },
  });
  return runCli(["hook", "muse", "--as", "agent:muse", "--dir", dir], dir, body);
}

test("Muse file mode takes a carried workdir only when absolute, and never falls back past it (refuter S1)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "x.py"), "print('session cwd')\n", "utf8");
  writeFileSync(join(dir, "a", "x.py"), "print('workdir a')\n", "utf8");
  const rootSha = createHash("sha256").update("print('session cwd')\n").digest("hex");
  const workdirSha = createHash("sha256").update("print('workdir a')\n").digest("hex");
  // A relative workdir: Muse runs the command in `<cwd>/a`, a directory the hook
  // cannot place, so file mode is refused, never hashed from the session cwd.
  // Any carried value that is not an absolute path is no statement either.
  for (const workdir of ["a", "./a", "", 7, null]) {
    for (const command of ["python3 x.py", `python3 ${join(dir, "a", "x.py")}`]) {
      const verdict = claudeVerdict(museAt(dir, command, workdir));
      assert.equal(verdict.code, "hook-exec-code-unreadable", `${JSON.stringify(workdir)} ${command}: ${verdict.message}`);
      assert.equal(verdict.message.includes(rootSha), false, "the session cwd's file is never bound");
    }
  }
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
  // An inline program does not read a file, so a relative workdir does not refuse it.
  const inline = claudeVerdict(museAt(dir, "python3 -c 'print(1)'", "a"));
  assert.equal(inline.permission, "allow", inline.message);
  // An absolute workdir is the statement: bound to `a/x.py`, the file bash runs.
  const absolute = claudeVerdict(museAt(dir, "python3 x.py", join(dir, "a")));
  assert.equal(absolute.permission, "allow", absolute.message);
  assert.match(absolute.message, new RegExp(`python3 file program sha256:${workdirSha}`, "u"));
  assert.equal(absolute.message.includes(rootSha), false);
  // No workdir key at all: the session cwd stands, as before.
  const absent = claudeVerdict(museAt(dir, "python3 x.py", undefined));
  assert.equal(absent.permission, "allow", absent.message);
  assert.match(absent.message, new RegExp(`python3 file program sha256:${rootSha}`, "u"));
  assert.equal(absent.message.includes(workdirSha), false);
});

test("a command with an embedded NUL is refused hook-exec-code-unreadable, never bound (refuter N-b)", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  for (const command of ["python3 -c 'print(1)\u0000junk'", "python3 -c 'print(1)'\u0000", "node -e 'console.log(1)\u0000'"]) {
    const verdict = hermesVerdict(terminal(dir, command));
    assert.equal(verdict.code, "hook-exec-code-unreadable", `${JSON.stringify(command)}: ${verdict.message}`);
    assert.match(verdict.message, /embedded NUL/u);
  }
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
  // The same program without the NUL is recorded.
  const plain = hermesVerdict(terminal(dir, "python3 -c 'print(1)junk'"));
  assert.equal(plain.permission, "allow", plain.message);
});

test("a file program the hook cannot read is refused hook-exec-code-unreadable", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  const missing = hermesVerdict(terminal(dir, "python3 missing.py"));
  assert.equal(missing.code, "hook-exec-code-unreadable", missing.message);
  const bun = hermesVerdict(terminal(dir, "bun missing.ts"));
  assert.equal(bun.code, "hook-exec-code-unreadable", bun.message);
  mkdirSync(join(dir, "pkg"));
  assert.equal(hermesVerdict(terminal(dir, "python3 pkg")).code, "hook-exec-code-unreadable");
  writeFileSync(join(dir, "moved.py"), "print(1)\n", "utf8");
  const afterCd = hermesVerdict(terminal(dir, `cd ${dir} && python3 moved.py`));
  assert.equal(afterCd.code, "hook-exec-code-unreadable", afterCd.message);
  assert.equal(records(dir).filter((r) => r["event"] === "execution.started").length, 0);
});

test("an unreadable file (EACCES) is refused, never guessed", { skip: process.getuid?.() === 0 }, () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  const file = join(dir, "locked.py");
  writeFileSync(file, "print(1)\n", "utf8");
  chmodSync(file, 0o000);
  try {
    const verdict = hermesVerdict(terminal(dir, `python3 ${file}`));
    assert.equal(verdict.code, "hook-exec-code-unreadable", verdict.message);
  } finally {
    chmodSync(file, 0o600);
  }
});

test("a file program landing on a protected path refuses as the skill-script pass does", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  // The direct spelling is the protected class itself.
  const direct = hermesVerdict(terminal(dir, "python3 APPROVAL.md"));
  assert.equal(direct.permission, "deny");
  assert.equal(direct.code, "hook-class-human-only", direct.message);
});

// ---------------------------------------------------------------------------
// Hermes execute_code
// ---------------------------------------------------------------------------

test("execute_code with custody only keeps its refusal and names the second key", () => {
  const dir = ready(policy({ exec: CUSTODY, classes: ROW_AUTONOMOUS }));
  const verdict = hermesVerdict(hermes(dir, "execute_code", { code: "print(1)" }));
  assert.equal(verdict.code, "hook-hermes-execute-code-unbound");
  assert.match(verdict.message, /exec\.code\.execute_code: hooked/u);
});

test("execute_code with both keys is recorded exec.code by hash, and its post event closes the start", () => {
  const dir = ready(policy({ exec: BOTH, classes: ROW_AUTONOMOUS }));
  const code = 'print("example-not-a-key")';
  const pre = hermesVerdict(hermes(dir, "execute_code", { code }));
  const preId = `tool-${String(calls)}`;
  assert.equal(pre.permission, "allow", pre.message);
  assert.match(pre.message, new RegExp(createHash("sha256").update(code).digest("hex"), "u"));
  const starts = records(dir).filter((r) => r["event"] === "execution.started");
  assert.equal(starts.length, 1);
  assert.equal(((starts[0]?.["payload"] ?? {}) as Record<string, unknown>)["class"], "exec.code");

  const post = runCli(
    ["hook", "hermes", "--as", "agent:hermes", "--dir", dir],
    dir,
    JSON.stringify({
      hook_event_name: "post_tool_call",
      session_id: "exec-code-sess",
      tool_use_id: preId,
      cwd: dir,
      profile: "default",
      extra: {},
      tool_name: "execute_code",
      tool_input: { code },
      result: JSON.stringify({ status: "success", output: "ok" }),
    }),
  );
  assert.equal(post.code, 0, post.stderr);
  assert.equal(post.stdout, "");
  assert.equal(written(dir).includes("example-not-a-key"), false);
});

test("a tools entry cannot claim execute_code", () => {
  const dir = ready(
    policy({
      autonomy: "autonomous",
      classes: ["  marketplace.app.read:", "    autonomy: autonomous"],
    }).replace("classes:", 'tools:\n  - match: "*"\n    class: marketplace.app.read\nclasses:'),
  );
  assert.equal(
    hermesVerdict(hermes(dir, "execute_code", { code: "print(1)" })).code,
    "hook-hermes-execute-code-unbound",
  );
});

// ---------------------------------------------------------------------------
// hook classify explains what the hook decides
// ---------------------------------------------------------------------------

test("hook classify names exec.code under custody and refuses without it", () => {
  const open = ready(policy({ exec: CUSTODY }));
  const shown = runCli(["hook", "classify", "--dir", open, "--json", "--", INLINE], open);
  assert.equal(shown.code, 0, shown.stderr);
  const parsed = JSON.parse(shown.stdout) as { ok: boolean; classes?: string[] };
  assert.deepEqual(parsed.classes, ["exec.code"]);

  const closed = ready(policy());
  const refused = JSON.parse(
    runCli(["hook", "classify", "--dir", closed, "--json", "--", INLINE], closed).stdout,
  ) as { ok: boolean; code?: string };
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "opaque");
});
