/**
 * The hook answers before the harness stops listening.
 *
 * A hook the harness kills at its timeout is a tool call that PROCEEDS
 * (`docs/claude-code-hook.md`), so the time this hook takes is part of the
 * gate. Three things are pinned here:
 *
 * 1. the path walks that ran in the square of a word's length are linear, with
 *    the same answers (against the walks as they were, kept below as the
 *    reference, on a fixture of links, loops and missing components);
 * 2. describing a call has a deadline of its own, and a call that outlasts it
 *    is refused `hook-deadline` (through the real CLI);
 * 3. a read that takes more than a second shortens the wait for a decision.
 *
 * Costs are CPU time and ratios, never wall-clock time: this machine is shared.
 * No input here is larger than 1 MiB, and none can exhaust memory: every walk
 * under test is linear in it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalPath,
  classifyForHook,
  commandHook,
  decideHarnessCall,
  DESCRIBE_CAP_MARGIN_MS,
  DESCRIBE_DEADLINE_ENV,
  DESCRIBE_DEADLINE_MS,
  describeDeadlineMs,
  HARNESS_ADAPTERS,
  type HarnessVerdict,
  HOOK_DENY_CODES,
  type HookInput,
  hookScope,
  physicalLanding,
  READ_FREE_MS,
  waitAfterRead,
} from "../src/cli/hook.js";
import { commandGate } from "../src/cli/gate-window.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import { readVerifiedRecords } from "../src/core/state.js";
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

test("the describe deadline: 15 s, a known harness ceiling less two seconds when that is shorter, and the environment can only shorten it", () => {
  assert.equal(DESCRIBE_DEADLINE_MS, 15_000);
  assert.equal(DESCRIBE_CAP_MARGIN_MS, 2_000);
  assert.equal(describeDeadlineMs(null, {}), 15_000);
  assert.equal(describeDeadlineMs(600_000, {}), 15_000);
  // Hermes's default ceiling (its `plugins.hook_callback_timeout`, 30 s) leaves
  // the whole 15 s: a read of ordinary size was refused at a quarter of it.
  assert.equal(describeDeadlineMs(30_000, {}), 15_000);
  assert.equal(describeDeadlineMs(17_000, {}), 15_000);
  assert.equal(describeDeadlineMs(16_999, {}), 14_999, "the ceiling less the margin, from here down");
  assert.equal(describeDeadlineMs(10_000, {}), 8_000);
  // Where the margin does not fit, a quarter of the ceiling.
  assert.equal(describeDeadlineMs(2_400, {}), 600);
  assert.equal(describeDeadlineMs(2_000, {}), 500);
  assert.equal(describeDeadlineMs(2, {}), 1, "never below one millisecond");
  // Never past the ceiling, whatever it is.
  for (const cap of [1, 3, 999, 2_001, 2_667, 5_000, 16_000, 17_001, 60_000, 300_000]) {
    const deadline = describeDeadlineMs(cap, {});
    assert.ok(deadline >= 1 && deadline <= Math.max(1, cap) && deadline <= DESCRIBE_DEADLINE_MS, `${String(cap)}: ${String(deadline)}`);
    if (cap >= 4 * DESCRIBE_CAP_MARGIN_MS) assert.ok(cap - deadline >= DESCRIBE_CAP_MARGIN_MS, `${String(cap)} leaves the margin`);
  }
  assert.equal(describeDeadlineMs(null, { [DESCRIBE_DEADLINE_ENV]: "250" }), 250);
  assert.equal(describeDeadlineMs(null, { [DESCRIBE_DEADLINE_ENV]: "0" }), 1);
  assert.equal(describeDeadlineMs(10_000, { [DESCRIBE_DEADLINE_ENV]: "9000" }), 8_000, "the environment cannot lengthen what the ceiling leaves");
  // Longer, or not a whole number of milliseconds: ignored.
  for (const stated of ["999999999", "60000", "-5", "1e3", "12.5", " 5", "five", ""]) {
    assert.equal(describeDeadlineMs(null, { [DESCRIBE_DEADLINE_ENV]: stated }), 15_000, JSON.stringify(stated));
    assert.equal(describeDeadlineMs(10_000, { [DESCRIBE_DEADLINE_ENV]: stated }), 8_000, JSON.stringify(stated));
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

// ---------------------------------------------------------------------------
// 4. The ceiling reaches the read on every path: a window open, a remainder
// ---------------------------------------------------------------------------

/** Open a window in `dir`, as a human at a terminal does (`approval gate open`). */
function openWindow(dir: string): void {
  const prompter: Prompter = {
    readLine: () => "understood",
    readSecret(): SecretRead {
      throw new Error("gate open asks for no secret");
    },
    confirm(): boolean {
      throw new Error("gate open asks for no confirmation");
    },
  };
  let err = "";
  const code = commandGate(
    ["open", "--for", "5m", "--reason", "the deadline test", "--as", "human:alice"],
    {
      out: () => undefined,
      err: (text) => {
        err += text;
      },
    },
    dir,
    { prompter },
  );
  assert.equal(code, 0, err);
}

/** A Bash event for `command`, written to a file: a megabyte goes to a child from a file, not through a pipe. */
function eventFile(dir: string, command: string): string {
  labs += 1;
  const file = join(scratch, `event-${String(labs)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "deadline",
      tool_use_id: `deadline-${String(labs)}`,
      cwd: dir,
      transcript_path: "/dev/null",
      tool_name: "Bash",
      tool_input: { command },
    }),
  );
  return file;
}

/** Linear, and slow by its size alone: 720 KB of path words is seconds to read on any machine. */
const SLOW_BY_SIZE = `cat ${"notes/a.txt ".repeat(60_000)}`;

test("a stated ceiling sets the read's deadline with a window open as with it closed", { skip }, () => {
  // Review of ab74cfbb (codex, CLAIMS L62004): the open-window path read the
  // call under the default 15 s whatever `--harness-cap` said. Under a 2 s
  // ceiling the read has 500 ms. The line takes seconds, so each path must
  // refuse it at 500 ms; a path that has 15 s reads it and answers otherwise.
  const dir = lab();
  const ask = (command: string): { permission: string; reason: string } => {
    const stdin = openSync(eventFile(dir, command), "r");
    try {
      const ran = spawnSync(
        process.execPath,
        [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms", "--harness-cap", "2s"],
        { cwd: dir, encoding: "utf8", env: { ...process.env }, stdio: [stdin, "pipe", "pipe"], timeout: 60_000 },
      );
      assert.equal(ran.error, undefined, String(ran.error));
      assert.equal(ran.status, 0, ran.stderr);
      const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
      return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
    } finally {
      closeSync(stdin);
    }
  };
  const closed = ask(SLOW_BY_SIZE);
  assert.equal(closed.permission, "deny", closed.reason);
  assert.match(closed.reason, /^hook-deadline: this hook could not read the Bash call within its own 500ms limit/u);
  assert.equal(ask("cat notes/a.txt").permission, "allow");

  openWindow(dir);
  const open = ask(SLOW_BY_SIZE);
  assert.equal(open.permission, "deny", open.reason);
  assert.match(open.reason, /^hook-deadline: this hook could not read the Bash call within its own 500ms limit/u);
  // The window is open and does its work for a call the hook can read.
  assert.equal(ask("cat notes/a.txt").permission, "allow");
});

test("what an embedding caller has left of the ceiling sets the read's deadline, with a window open as with it closed", { skip }, () => {
  // `approval serve` charges a call for the time it spent in line and hands
  // the hook the remainder (`HookWaitSeam.remainingCapMs`). 2 s left of a
  // stated 10 s is a 500 ms read, not the 8 s the stated ceiling alone gives.
  // In a child process: a read stopped at its deadline latches the process.
  const dir = lab();
  const script = join(scratch, `remainder-${String(labs)}.mjs`);
  writeFileSync(
    script,
    [
      'import { readFileSync } from "node:fs";',
      `import { commandHook } from ${JSON.stringify(pathToFileURL(join(dirname(CLI_ENTRY), "hook.js")).href)};`,
      "const [dir, event] = process.argv.slice(2);",
      'let out = "";',
      'let err = "";',
      "const code = commandHook(",
      '  ["claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms", "--harness-cap", "10s"],',
      "  { out: (text) => { out += text; }, err: (text) => { err += text; } },",
      "  dir,",
      '  () => readFileSync(event, "utf8"),',
      "  { enterWait: () => undefined, leaveWait: () => undefined, remainingCapMs: 2000 },",
      ");",
      "process.stdout.write(JSON.stringify({ code, out, err }));",
      "",
    ].join("\n"),
  );
  const ask = (command: string): { permission: string; reason: string } => {
    const ran = spawnSync(process.execPath, [script, dir, eventFile(dir, command)], { cwd: dir, encoding: "utf8", env: { ...process.env }, timeout: 60_000 });
    assert.equal(ran.error, undefined, String(ran.error));
    assert.equal(ran.status, 0, ran.stderr);
    const said = JSON.parse(ran.stdout) as { code: number; out: string; err: string };
    assert.equal(said.code, 0, said.err);
    const output = (JSON.parse(said.out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
    return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
  };
  const closed = ask(SLOW_BY_SIZE);
  assert.equal(closed.permission, "deny", closed.reason);
  assert.match(closed.reason, /^hook-deadline: .* within its own 500ms limit/u);
  openWindow(dir);
  const open = ask(SLOW_BY_SIZE);
  assert.equal(open.permission, "deny", open.reason);
  assert.match(open.reason, /^hook-deadline: .* within its own 500ms limit/u);
  assert.equal(ask("cat notes/a.txt").permission, "allow");
});

test("through the real hook, a read of seconds is timed by the real clock, and the wait that follows is the shortened one", { skip }, () => {
  // Review of ab74cfbb (review-b, CLAIMS L62017): the wait test below owns the
  // clock, so nothing held the clock every real caller gets. With that clock
  // stopped the read always "took" nothing, and a long read plus a whole wait
  // outran the harness again. Here nothing is supplied: the real CLI, a call
  // that waits for a human (the POST), and a read of seconds.
  //
  // The read must take more than the free second and less than the 15 s
  // deadline on a machine of any speed, at any load. So the line is sized
  // here, now: path words enough to take about four seconds in this process,
  // the middle of that window. The size is an estimate, and it has been wrong
  // both ways: a busy machine met the deadline, and on CI (run 45272670454) the
  // CLI read the line in under the free second, said nothing about the read,
  // and the test failed with nothing to measure. So the size is searched for:
  // a read that met the deadline is tried at a third, one that left no line
  // at three times, four tries in all. What is asserted is unchanged, and it
  // is asserted of the first read that lands in the window.
  const dir = lab();
  const line = (words: number): string => `curl -X POST https://example.com/api -d call=1; cat ${"notes/a.txt ".repeat(words)}`;
  const millisecondsFor = (words: number): number => {
    const began = performance.now();
    classifyForHook(line(words), [], dir);
    return performance.now() - began;
  };
  millisecondsFor(500);
  const sample = millisecondsFor(4_000);
  const MOST_WORDS = 240_000;
  const sized = Math.min(160_000, Math.max(4_000, Math.round((4_000 * 4_000) / sample)));
  let said: RegExpExecArray | null = null;
  let reason = "";
  let err = "";
  const tried: string[] = [];
  let words = sized;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stdin = openSync(eventFile(dir, line(words)), "r");
    try {
      const ran = spawnSync(
        process.execPath,
        [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "2s", "--interval", "100ms"],
        { cwd: dir, encoding: "utf8", env: { ...process.env }, stdio: [stdin, "pipe", "pipe"], timeout: 90_000 },
      );
      assert.equal(ran.error, undefined, String(ran.error));
      assert.equal(ran.status, 0, ran.stderr);
      const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
      assert.equal(output.permissionDecision, "deny", output.permissionDecisionReason);
      reason = output.permissionDecisionReason;
      err = ran.stderr;
    } finally {
      closeSync(stdin);
    }
    if (reason.startsWith("hook-deadline: ")) {
      tried.push(`${String(words)} words met the deadline`);
      words = Math.max(1_500, Math.round(words / 3));
      continue;
    }
    said = /reading this call took (\d+)ms, so the wait for a decision is (\d+)ms of its 2000ms/u.exec(err);
    if (said !== null || words >= MOST_WORDS) break;
    tried.push(`${String(words)} words left no line about the read`);
    words = Math.min(MOST_WORDS, words * 3);
  }
  const history = `4,000 words took ${sample.toFixed(0)} ms here; ${tried.join("; ")}`;
  assert.match(reason, /^hook-timeout: /u, `${history}: ${reason.slice(0, 200)}`);
  assert.ok(said !== null, `no line about the read on stderr at any size, so the read was not timed (${history}): ${err.slice(0, 400)}`);
  const readMs = Number(said[1]);
  const left = Number(said[2]);
  assert.ok(readMs > READ_FREE_MS && readMs < DESCRIBE_DEADLINE_MS, `the read took ${String(readMs)} ms by the hook's clock`);
  assert.equal(left, waitAfterRead(2_000, readMs));
  assert.ok(left < 2_000);
});

test("a read slower than a second shortens the wait by the rest; an ordinary read leaves it whole", () => {
  assert.equal(READ_FREE_MS, 1_000);
  assert.equal(waitAfterRead(55_000, 0), 55_000);
  assert.equal(waitAfterRead(55_000, 1_000), 55_000);
  assert.equal(waitAfterRead(55_000, 1_001), 54_999);
  assert.equal(waitAfterRead(55_000, 7_000), 49_000);
  assert.equal(waitAfterRead(2_000, 15_000), 0, "never below none");
  assert.equal(waitAfterRead(0, 0), 0);
});

test("the wait that follows a slow read is the shortened one: the hook stops polling when it says it will", { skip }, () => {
  // A call that waits for a human (the POST). The read is timed by a clock
  // this test owns, which adds 1.8 s to what the read really took: a slow read
  // without an input that takes seconds, so the test does not depend on how
  // busy the machine is (review of 259711a6: with a 250 KB input it reached
  // the deadline itself under load). Polls are counted, not timed: at one
  // every 50 ms, the wait that is left allows a known number of them, and the
  // whole 2 s would allow forty.
  const dir = lab();
  labs += 1;
  let polls = 0;
  let out = "";
  let err = "";
  let reads = 0;
  commandHook(
    ["claude-code", "--as", "agent:cc", "--timeout", "2s", "--interval", "50ms"],
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    dir,
    () =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "deadline",
        tool_use_id: `deadline-${String(labs)}`,
        cwd: dir,
        transcript_path: "/dev/null",
        tool_name: "Bash",
        tool_input: { command: "curl -X POST https://example.com/api -d call=1; cat notes/a.txt" },
      }),
    {
      enterWait: () => undefined,
      leaveWait: () => undefined,
      pollRead: (logPath) => {
        polls += 1;
        return readVerifiedRecords(logPath);
      },
      // Asked twice, before the read and after it.
      readClock: () => Date.now() + (reads++ === 0 ? 0 : 1_800),
    },
  );
  assert.equal(reads, 2, "the read is timed by the seam's clock, once on each side");
  const verdict = (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  assert.equal(verdict.permissionDecision, "deny", verdict.permissionDecisionReason);
  assert.match(verdict.permissionDecisionReason, /^hook-timeout: /u);
  const said = /reading this call took (\d+)ms, so the wait for a decision is (\d+)ms of its 2000ms/u.exec(err);
  assert.ok(said !== null, `no line about the read on stderr: ${err.slice(0, 400)}`);
  const readMs = Number(said[1]);
  const left = Number(said[2]);
  assert.ok(readMs >= 1_800, `the read took what the clock said: ${String(readMs)}`);
  assert.equal(left, waitAfterRead(2_000, readMs));
  assert.ok(left <= 1_200, `at most 1.2 s is left of the 2 s: ${String(left)}`);
  // One poll per 50 ms of the wait that is left, and a few for its two ends.
  assert.ok(polls <= Math.ceil(left / 50) + 4, `${String(polls)} polls in a wait of ${String(left)} ms`);
});

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
