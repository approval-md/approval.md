/**
 * The hook answers before the harness stops listening.
 *
 * A hook the harness kills at its timeout is a tool call that PROCEEDS
 * (`docs/claude-code-hook.md`), so the time this hook takes is part of the
 * gate. Two things are pinned here:
 *
 * 1. the path walks that ran in the square of a word's length are linear, with
 *    the same answers (against the walks as they were, kept below as the
 *    reference, on a fixture of links, loops and missing components);
 * 2. describing a call has a deadline of its own, and a call that outlasts it
 *    is refused `hook-deadline` (through the real CLI).
 *
 * Costs are CPU time and ratios, never wall-clock time: this machine is shared.
 * No input here is larger than 1 MiB, and none can exhaust memory: every walk
 * under test is linear in it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalPath,
  classifyForHook,
  decideHarnessCall,
  DESCRIBE_DEADLINE_ENV,
  DESCRIBE_DEADLINE_MS,
  describeDeadlineMs,
  HARNESS_ADAPTERS,
  type HarnessVerdict,
  HOOK_DENY_CODES,
  type HookInput,
  hookScope,
  physicalLanding,
} from "../src/cli/hook.js";
import { runUnderDeadline } from "../src/core/deadline.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-deadline-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** CPU seconds (user and system) spent in `run`. */
function cpu(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

// ---------------------------------------------------------------------------
// 1. The deadline itself
// ---------------------------------------------------------------------------

test("runUnderDeadline returns the work's value, and passes on an error the work throws", () => {
  assert.deepEqual(runUnderDeadline(1000, () => 42), { ok: true, value: 42 });
  assert.deepEqual(runUnderDeadline(1000, () => undefined), { ok: true, value: undefined });
  assert.throws(
    () =>
      runUnderDeadline(1000, () => {
        throw new RangeError("mine");
      }),
    (error: unknown) => error instanceof RangeError && error.message === "mine",
  );
  // And works again after an error.
  assert.deepEqual(runUnderDeadline(1000, () => "again"), { ok: true, value: "again" });
});

test("runUnderDeadline stops synchronous work at the deadline: a loop that never ends, and a regular expression that backtracks", () => {
  const spin = (): never => {
    for (;;) {
      // Never ends by itself. No allocation: nothing here can exhaust memory.
    }
  };
  const started = Date.now();
  assert.deepEqual(runUnderDeadline(100, spin), { ok: false });
  assert.deepEqual(runUnderDeadline(100, () => /^(a+)+$/u.test(`${"a".repeat(40)}b`)), { ok: false });
  // Two deadlines of 100 ms: well under what either would take unstopped
  // (for ever, and minutes). A generous ceiling, for a loaded machine.
  assert.ok(Date.now() - started < 20_000, `${String(Date.now() - started)} ms`);
  // The process goes on, and the next call is answered.
  assert.deepEqual(runUnderDeadline(1000, () => [1, 2, 3].map((n) => n * 2)), { ok: true, value: [2, 4, 6] });
});

test("runUnderDeadline: a nested call runs under the outer deadline", () => {
  assert.deepEqual(
    runUnderDeadline(1000, () => runUnderDeadline(1, () => "inner")),
    { ok: true, value: { ok: true, value: "inner" } },
  );
  const spin = (): never => {
    for (;;) {
      // As above.
    }
  };
  // The inner call does not catch the stop: the outer one reports it.
  assert.deepEqual(
    runUnderDeadline(100, () => runUnderDeadline(60_000, spin)),
    { ok: false },
  );
  // And the inner limit is not a second deadline: work that outlasts it is
  // finished under the outer one.
  const busy = (milliseconds: number): string => {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
      // Fifty milliseconds of work, against an inner limit of one.
    }
    return "inner";
  };
  assert.deepEqual(
    runUnderDeadline(60_000, () => runUnderDeadline(1, () => busy(50))),
    { ok: true, value: { ok: true, value: "inner" } },
  );
});

test("the describe deadline: 15 s, a quarter of a known harness ceiling when that is shorter, and the environment can only shorten it", () => {
  assert.equal(DESCRIBE_DEADLINE_MS, 15_000);
  assert.equal(describeDeadlineMs(null, {}), 15_000);
  assert.equal(describeDeadlineMs(600_000, {}), 15_000);
  assert.equal(describeDeadlineMs(30_000, {}), 7_500);
  assert.equal(describeDeadlineMs(2, {}), 1, "never below one millisecond");
  assert.equal(describeDeadlineMs(null, { [DESCRIBE_DEADLINE_ENV]: "250" }), 250);
  assert.equal(describeDeadlineMs(null, { [DESCRIBE_DEADLINE_ENV]: "0" }), 1);
  // Longer, or not a whole number of milliseconds: ignored.
  for (const stated of ["999999999", "60000", "-5", "1e3", "12.5", " 5", "five", ""]) {
    assert.equal(describeDeadlineMs(null, { [DESCRIBE_DEADLINE_ENV]: stated }), 15_000, JSON.stringify(stated));
    assert.equal(describeDeadlineMs(30_000, { [DESCRIBE_DEADLINE_ENV]: stated }), 7_500, JSON.stringify(stated));
  }
  assert.ok((HOOK_DENY_CODES as readonly string[]).includes("hook-deadline"));
});

// ---------------------------------------------------------------------------
// 2. The path walks: the same answers as the walks they replace
// ---------------------------------------------------------------------------

/** `canonicalPath` as it was: one climb, and one resolution of the whole path, per missing component. */
function canonicalPathBefore(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** `physicalLanding` as it was: every component joined to the whole path so far and resolved. */
function physicalLandingBefore(from: string, text: string): string {
  let current = isAbsolute(text) ? sep : from;
  try {
    current = realpathSync(current);
  } catch {
    // An ancestor that does not exist stays as spelled.
  }
  for (const component of text.split(/\/+/u)) {
    if (component.length === 0 || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, component);
    try {
      current = realpathSync(next);
    } catch {
      current = next;
    }
  }
  return current;
}

/** A small tree with a directory link, an absolute link, a dangling link, a loop and a link to the parent. */
function fixture(): string {
  const root = join(scratch, "tree");
  if (planted) return root;
  planted = true;
  mkdirSync(join(root, "a", "b", "c"), { recursive: true });
  writeFileSync(join(root, "a", "file"), "x\n");
  symlinkSync(join("a", "b"), join(root, "link"));
  symlinkSync(join(root, "a"), join(root, "abs"));
  symlinkSync("nowhere", join(root, "dangling"));
  symlinkSync("loop", join(root, "loop"));
  symlinkSync("..", join(root, "a", "b", "up"));
  return root;
}

let planted = false;

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["a", "b", "c", "file", "link", "abs", "dangling", "loop", "up", "x", "y", "..", "..", "."];

test("canonicalPath and physicalLanding answer as the walks they replace, on links, loops, missing components and `..`", { skip: sep !== "/" }, () => {
  const root = fixture();
  const next = random(20261123);
  const froms = [root, join(root, "a"), join(root, "a", "b", "c"), join(root, "missing"), `${join(root, "missing")}/`, join(root, "link")];
  let compared = 0;
  for (let round = 0; round < 4000; round += 1) {
    const length = Math.floor(next() * 14);
    const parts: string[] = [];
    for (let index = 0; index < length; index += 1) parts.push(NAMES[Math.floor(next() * NAMES.length)] as string);
    // Some with a long run of missing components: past the 32 climbs.
    if (round % 7 === 0) for (let index = 0; index < 40 + Math.floor(next() * 60); index += 1) parts.push(next() < 0.1 ? ".." : "m");
    const from = froms[Math.floor(next() * froms.length)] as string;
    const text = (round % 5 === 0 ? `${root}/` : "") + parts.join(round % 11 === 0 ? "//" : "/") + (round % 13 === 0 ? "/" : "");
    assert.equal(physicalLanding(from, text), physicalLandingBefore(from, text), `physicalLanding(${JSON.stringify(from)}, ${JSON.stringify(text)})`);
    // The two forms the hook hands canonicalPath: resolved, and as spelled.
    for (const path of [resolve(from, text), `${from}/${text}`, physicalLanding(from, text)]) {
      assert.equal(canonicalPath(path), canonicalPathBefore(path), `canonicalPath(${JSON.stringify(path)})`);
      compared += 1;
    }
  }
  assert.ok(compared >= 12000);
  // The shapes the halving is for, each against the old walk: 33 and 34
  // missing components (either side of the climb limit), and a few thousand.
  for (const count of [31, 32, 33, 34, 35, 64, 3000]) {
    for (const base of [root, join(root, "a", "b"), join(root, "link"), join(root, "abs", "b", "c"), join(root, "a", "file"), "/"]) {
      const path = join(base, ...Array.from({ length: count }, (_, index) => `m${String(index % 3)}`));
      assert.equal(canonicalPath(path), canonicalPathBefore(path), `${base} + ${String(count)}`);
      assert.equal(physicalLanding(root, path), physicalLandingBefore(root, path), `${base} + ${String(count)}`);
    }
  }
  // A step back among the components: `x/..` resolves where `x` does not, so
  // the longest prefix that resolves is not a boundary a halving finds. Such
  // a path is climbed as it always was, and a link past the step back is
  // still followed.
  for (const pairs of [1, 2, 3, 5, 8]) {
    for (const count of [33, 34, 36, 40, 47]) {
      for (const leaf of ["link", "abs", "a/b/up"]) {
        const path = `${root}/${"x/../".repeat(pairs)}${leaf}/${Array.from({ length: count }, () => "m").join("/")}`;
        assert.equal(canonicalPath(path), canonicalPathBefore(path), path);
      }
    }
  }
});

test("a megabyte of path costs what a megabyte costs: the walks are linear", { skip: sep !== "/" }, () => {
  const root = fixture();
  const deep = (size: number, unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size - (size % unit.length));
  // 64 KB against 16 KB: four times the input. The walks they replace took
  // sixteen times as long, and about half a minute at 64 KB.
  for (const [label, run] of [
    ["canonicalPath, missing components", (size: number) => canonicalPath(join(root, deep(size, "b/")))],
    ["physicalLanding, missing components", (size: number) => physicalLanding(root, deep(size, "b/"))],
    ["physicalLanding, a name and a step back", (size: number) => physicalLanding(root, deep(size, "a/../"))],
    ["physicalLanding, missing then back", (size: number) => physicalLanding(root, deep(size / 2, "b/") + deep(size / 2, "../"))],
  ] as const) {
    const control = cpu(() => run(16 * 1024));
    const spent = cpu(() => run(64 * 1024));
    assert.ok(spent <= 8 * control + 0.5, `${label}: ${spent.toFixed(3)} s at 64 KB against ${control.toFixed(3)} s at 16 KB`);
  }
  // And one megabyte is answered at all, in seconds: no spread of half a
  // million arguments, no climb of half a million components.
  const megabyte = deep(1024 * 1024, "b/");
  assert.ok(cpu(() => canonicalPath(join(root, megabyte))) < 10);
  assert.ok(cpu(() => physicalLanding(root, megabyte)) < 10);
  assert.equal(canonicalPath(join(root, megabyte)), join(root, megabyte).replace(/\/$/u, ""));
});

test("through the hook's classification, a long read word, a long write target and a long run of steps back are linear", { skip: sep !== "/" }, () => {
  const root = fixture();
  const deep = (size: number, unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size - (size % unit.length));
  for (const [label, line] of [
    ["cat of a deep missing path", (size: number) => `cat ${deep(size, "b/")}env`],
    ["cat under the approval home", (size: number) => `cat .approval/${deep(size, "b/")}env`],
    ["cat under a Hermes home", (size: number) => `cat .hermes/${deep(size, "x/")}auth.json`],
    ["cat of a name and a step back", (size: number) => `cat .approval/${deep(size, "keys/../")}env`],
    ["a write to a deep missing path", (size: number) => `echo x > ${deep(size, "b/")}out.txt`],
    ["a write up and back", (size: number) => `echo x > ${deep(size / 2, "b/")}${deep(size / 2, "../")}out.txt`],
  ] as const) {
    const control = cpu(() => classifyForHook(line(16 * 1024), [], root));
    const spent = cpu(() => classifyForHook(line(64 * 1024), [], root));
    assert.ok(spent <= 8 * control + 0.5, `${label}: ${spent.toFixed(3)} s at 64 KB against ${control.toFixed(3)} s at 16 KB`);
  }
});

test("the two walks that take components from a list still take them in order: a link, then what follows it", { skip: sep !== "/" }, () => {
  const root = join(scratch, "order");
  mkdirSync(join(root, "home", ".hermes", "skills"), { recursive: true });
  mkdirSync(join(root, "ws", ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, "ws", "plain", "deep"), { recursive: true });
  // `k` is a link into a Hermes home: `k/../.op.env` lands on the home's
  // `.op.env`, which only the kernel's order of the components shows.
  symlinkSync(join(root, "home", ".hermes", "skills"), join(root, "ws", "k"));
  // `g` is a link into the git directory: `g/pre-push` lands in `.git/hooks`.
  symlinkSync(join(".git", "hooks"), join(root, "ws", "g"));
  // `p` is a link to an ordinary folder: the same shapes land nowhere special.
  symlinkSync(join("plain", "deep"), join(root, "ws", "p"));
  const classes = (command: string): string[] => {
    const { result } = classifyForHook(command, [], join(root, "ws"));
    return result.ok ? result.classes : [`refused ${result.code}`];
  };
  // The credential pass's walk (`physicalLanding` in the hook).
  assert.deepEqual(classes("cat k/../.op.env"), ["read.shell", "account.credential"]);
  assert.deepEqual(classes("cat p/../.op.env"), ["read.shell"]);
  // The git-directory pass's walk (`physicalLanding` in git-dir-writes).
  assert.deepEqual(classes("echo x > g/pre-push"), ["files.write.workspace", "vcs.history.rewrite"]);
  assert.deepEqual(classes("echo x > p/pre-push"), ["files.write.workspace"]);
  // A link whose target has several pieces: they are walked first piece first.
  // A checkout whose git directory is named by a `.git` FILE, so no `.git`
  // appears in the link's text or in where it lands: only the order of the
  // pieces (`plain`, back out twice, then `store/gd/hooks`) finds it.
  mkdirSync(join(root, "store", "gd", "hooks"), { recursive: true });
  mkdirSync(join(root, "ws2", "plain"), { recursive: true });
  writeFileSync(join(root, "ws2", ".git"), "gitdir: ../store/gd\n");
  symlinkSync("plain/../../store/gd/hooks", join(root, "ws2", "h"));
  symlinkSync("plain", join(root, "ws2", "p"));
  const classes2 = (command: string): string[] => {
    const { result } = classifyForHook(command, [], join(root, "ws2"));
    return result.ok ? result.classes : [`refused ${result.code}`];
  };
  assert.deepEqual(classes2("echo x > h/pre-push"), ["files.write.workspace", "vcs.history.rewrite"]);
  assert.deepEqual(classes2("echo x > p/pre-push"), ["files.write.workspace"]);
});

// ---------------------------------------------------------------------------
// 3. Through the real CLI: a call the hook cannot read in time is refused
// ---------------------------------------------------------------------------

/** dist/tests/hook-deadline.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const GIT = spawnSync("git", ["--version"]).status === 0;
const skip = GIT ? false : "no git binary";

function runCli(
  args: readonly string[],
  cwd: string,
  input = "",
  extra: Readonly<Record<string, string>> = {},
): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env, ...extra };
  delete env["APPROVAL_HUMAN"];
  const ran = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(ran.error, undefined, String(ran.error));
  return { code: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

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

let labs = 0;
function lab(): string {
  labs += 1;
  const dir = join(scratch, `lab-${String(labs)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY);
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function decide(dir: string, command: string, extra: Readonly<Record<string, string>> = {}): { permission: string; reason: string } {
  return decideTool(dir, { tool_name: "Bash", tool_input: { command } }, extra);
}

function decideTool(
  dir: string,
  tool: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, string>> = {},
): { permission: string; reason: string } {
  labs += 1;
  const ran = runCli(
    ["hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "deadline",
      tool_use_id: `deadline-${String(labs)}`,
      cwd: dir,
      transcript_path: "/dev/null",
      ...tool,
    }),
    extra,
  );
  assert.equal(ran.code, 0, ran.stderr);
  const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
}

test("through the real hook, a call it cannot read inside its deadline is refused hook-deadline, and the same call is read when it has the time", { skip }, () => {
  const dir = lab();
  // 256 KB of path words: milliseconds of reading per kilobyte, far past a
  // one-millisecond deadline, and nowhere near the 15 s one.
  const command = `cat ${"notes/a.txt ".repeat(21_000)}`;
  const refused = decide(dir, command, { [DESCRIBE_DEADLINE_ENV]: "1" });
  assert.equal(refused.permission, "deny", refused.reason);
  assert.match(refused.reason, /^hook-deadline: this hook could not read the Bash call within its own 1ms limit/u);
  assert.match(refused.reason, /Nothing was registered or requested/u);
  // With the deadline it ships with, the same call is read and allowed.
  const read = decide(dir, command);
  assert.equal(read.permission, "allow", read.reason);
  // The environment cannot lengthen the deadline, and a longer value changes nothing.
  assert.equal(decide(dir, "cat notes/a.txt", { [DESCRIBE_DEADLINE_ENV]: "999999999" }).permission, "allow");
});

test("through the real hook, the two worst patterns found so far are answered inside the deadline: 400 stars, and ten stars with a letter between them", { skip }, () => {
  // Review-b's findings (lead RULED L61849 and L61857). A pattern matcher
  // that backtracks tries every way of sharing a name between the stars:
  // 441 bytes of stars in a row, or 24 bytes of `*a` against one file named
  // sixty a's, are minutes of matching.
  const dir = lab();
  writeFileSync(join(dir, "a".repeat(60)), "");
  const stars = `git push --force && echo x > "$(echo .${"*".repeat(400)}x)"`;
  const letters = `cat ${"*a".repeat(9)}*b`;
  assert.equal(stars.length, 441);
  assert.equal(letters.length, 24);
  for (const command of [stars, letters]) {
    labs += 1;
    const began = Date.now();
    const ran = spawnSync(
      process.execPath,
      [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, [DESCRIBE_DEADLINE_ENV]: "500" },
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "deadline",
          tool_use_id: `deadline-${String(labs)}`,
          cwd: dir,
          transcript_path: "/dev/null",
          tool_name: "Bash",
          tool_input: { command },
        }),
        // Far past the 500 ms deadline, far short of the minutes the match
        // takes: a hook with no deadline is stopped here and the test fails.
        timeout: 30_000,
      },
    );
    const label = command.slice(0, 40);
    assert.equal(ran.error, undefined, `${label}: the hook was still running after ${String(Date.now() - began)} ms: ${String(ran.error)}`);
    assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
    // What must hold is an answer in time, and never an allow of a line the
    // hook did not finish reading. While the matcher backtracks the answer
    // is the `hook-deadline` refusal. A matcher that does not backtrack reads
    // both lines in milliseconds, and then each has its own answer: the push
    // waits for a human here and times out, the read is allowed.
    if (output.permissionDecisionReason.startsWith("hook-deadline: ")) {
      assert.equal(output.permissionDecision, "deny", label);
    } else if (command === stars) {
      assert.equal(output.permissionDecision, "deny", `${label}: ${output.permissionDecisionReason}`);
      assert.match(output.permissionDecisionReason, /^hook-timeout: /u, label);
    } else {
      assert.equal(output.permissionDecision, "allow", `${label}: ${output.permissionDecisionReason}`);
    }
  }
});

test("through the real hook, a Write through a link and a step back is judged where the kernel lands it", { skip }, () => {
  // The file tools' walk (`kernelLanding`): `k` links into a Hermes home, so
  // `k/../.op.env` is that home's `.op.env`, whatever the text says.
  const dir = lab();
  const home = join(scratch, "kernel-home");
  mkdirSync(join(home, ".hermes", "skills"), { recursive: true });
  mkdirSync(join(dir, "plain", "deep"), { recursive: true });
  symlinkSync(join(home, ".hermes", "skills"), join(dir, "k"));
  symlinkSync(join("plain", "deep"), join(dir, "p"));
  const write = (file: string): Readonly<Record<string, unknown>> => ({ tool_name: "Write", tool_input: { file_path: file, content: "x\n" } });
  const organ = decideTool(dir, write("k/../.op.env"));
  assert.equal(organ.permission, "deny", organ.reason);
  assert.match(organ.reason, /policy\.core/u);
  const plain = decideTool(dir, write("p/../note.txt"));
  assert.equal(plain.permission, "allow", plain.reason);
});

// ---------------------------------------------------------------------------
// 4. In this process, as the Codex bridge calls it
// ---------------------------------------------------------------------------

/** One call through `decideHarnessCall`, the way a long-lived caller makes it. */
function decideHere(dir: string, command: string): HarnessVerdict {
  labs += 1;
  const { logPath, root, options } = hookScope({}, dir);
  const input: HookInput = {
    sessionId: "deadline",
    sessionIdPresent: true,
    cwd: dir,
    toolName: "Bash",
    toolInput: { command },
    toolUseId: `deadline-${String(labs)}`,
    hookEventName: "PreToolUse",
    model: null,
    toolResponse: null,
    toolResponseRaw: undefined,
    interrupted: false,
    harnessVersion: null,
  };
  return decideHarnessCall({
    streams: { out: () => undefined, err: () => undefined },
    input,
    adapter: HARNESS_ADAPTERS["claude-code"],
    cwd: dir,
    logPath,
    root,
    options,
    actor: "agent:cc",
    timeoutMs: 1_000,
    intervalMs: 100,
    graceMs: 60_000,
    windowRecords: null,
  });
}

// LAST IN THIS FILE, and on purpose: after it this process describes no call.
test("after one call has outlasted the deadline, this process reads no further call and says why", { skip }, () => {
  const dir = lab();
  const before = decideHere(dir, "cat notes/a.txt");
  assert.equal(before.permission, "allow", JSON.stringify(before));
  process.env[DESCRIBE_DEADLINE_ENV] = "1";
  let stopped: HarnessVerdict;
  try {
    stopped = decideHere(dir, `cat ${"notes/a.txt ".repeat(21_000)}`);
  } finally {
    delete process.env[DESCRIBE_DEADLINE_ENV];
  }
  assert.equal(stopped.permission, "deny", JSON.stringify(stopped).slice(0, 300));
  assert.equal(stopped.permission === "deny" ? stopped.code : "", "hook-deadline");
  assert.match(stopped.permission === "deny" ? stopped.detail : "", /^this hook could not read the Bash call within its own 1ms limit/u);
  // The same short call that was allowed a moment ago, with the deadline it ships with.
  const later = decideHere(dir, "cat notes/a.txt");
  assert.equal(later.permission, "deny", JSON.stringify(later));
  assert.equal(later.permission === "deny" ? later.code : "", "hook-deadline");
  assert.match(later.permission === "deny" ? later.detail : "", /^an earlier call in this process outlasted the hook's own limit/u);
  assert.match(later.permission === "deny" ? later.detail : "", /Nothing was registered or requested\. Start the process again\.$/u);
});
