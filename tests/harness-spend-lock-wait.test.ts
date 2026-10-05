/**
 * A harness hook whose spend waits for the log's lock still answers a signal
 * with a block, and never records an execution after it (APRV-478).
 *
 * APRV-473 and APRV-475 put every `approval hook <harness>` CLI route on the
 * yielding driver and a zero pause (`BEFORE_SPEND`) before every spend. The
 * spend itself still waited for `<log>.lock` inside `core/log.ts`, retrying on a
 * synchronous `Atomics.wait` sleep for up to two seconds, AFTER that pause. So a
 * SIGTERM that arrived while another writer (the daemon, routinely) held the
 * lock was held by the wait's listener through the whole stretch: the spend
 * appended `execution.started`, the allow went out, and the wait's `finally`
 * removed the listener, discarding the signal with it (the APRV-475 refuter's
 * `lockrace.mjs` repro, on Claude Code and on Hermes). Now the wait for the lock
 * is yields of the same generator chain (`spendUnderLock`), and these pin, on
 * every harness:
 *
 * - the held-lockfile repro: a grant lands, an outside writer holds the lock,
 *   SIGTERM arrives while the spend waits, the lock is released after. The hook
 *   answers with its own `hook-interrupted` block at its own exit code, nothing
 *   records `execution.started`, nothing is written over the grant, and an
 *   identical retry carries the grant that was left unspent;
 * - the grant racing the signal while the lock is contended, ten at a time:
 *   whichever lands first, every run blocks and none records a start;
 * - with no signal the spend still waits for the lock and spends once it is
 *   free, and a lock held past the writer's bound is a deny that appends
 *   nothing (`append-failed`, `lock-timeout`), as it always was;
 * - step by step, in process: while the lock is held the spend yields the
 *   retry interval with nothing spent, and once it is free the zero pause comes
 *   immediately before the append.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { commandHookSteps, interruptedWaitDirective } from "../src/cli/hook.js";
import { decide } from "../src/core/gate.js";
import { DEFAULT_LOCK_RETRY_MS } from "../src/core/log.js";

const BIN = fileURLToPath(new URL("../../cli.js", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-spend-lock-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

function policy(writes: "autonomous" | "manual"): string {
  return [
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
    `    autonomy: ${writes}`,
    "```",
    "",
  ].join("\n");
}

type Kind = "claude-code" | "cursor" | "codex" | "grok" | "muse" | "hermes";

interface Verdict {
  permission: "allow" | "deny";
  message: string;
}

interface Harness {
  kind: Kind;
  /** The policy under which {@link call} waits on a human. */
  policy: string;
  /** A call that opens a question and waits on it; identical bytes for every id. */
  call: (dir: string, id: string) => string;
  /** Flags this harness needs beyond the wait's own. */
  extra: string[];
  /** The verdict in this harness's dialect. */
  verdict: (stdout: string) => Verdict;
}

const NPM_INSTALL = "npm install left-pad";
const PATCH = "*** Begin Patch\n*** Add File: interrupt.txt\n+x\n*** End Patch";

function nested(stdout: string): Verdict {
  const body = JSON.parse(stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["hookSpecificOutput"]);
  const out = body["hookSpecificOutput"] as Record<string, unknown>;
  const permission = out["permissionDecision"];
  assert.ok(permission === "allow" || permission === "deny", `permissionDecision ${String(permission)}`);
  return { permission, message: String(out["permissionDecisionReason"]) };
}

function claudeShape(dir: string, id: string): string {
  return JSON.stringify({
    session_id: "sess-spend-lock",
    transcript_path: "/dev/null",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: NPM_INSTALL },
    tool_use_id: id,
  });
}

const HARNESSES: readonly Harness[] = [
  {
    kind: "claude-code",
    policy: policy("autonomous"),
    call: claudeShape,
    extra: [],
    verdict: nested,
  },
  {
    kind: "cursor",
    policy: policy("autonomous"),
    call: (dir, id) =>
      JSON.stringify({
        session_id: "cursor-sess-spend-lock",
        cwd: dir,
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_input: { command: NPM_INSTALL },
        tool_use_id: id,
      }),
    extra: [],
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      const permission = body["permission"];
      assert.ok(permission === "allow" || permission === "deny", `permission ${String(permission)}`);
      return { permission, message: String(body["user_message"] ?? "") };
    },
  },
  {
    // Codex's native Bash is refused before the gate (SPEC §10.6): the call
    // that waits is a direct apply_patch under a manual write class.
    kind: "codex",
    policy: policy("manual"),
    call: (dir, id) =>
      JSON.stringify({
        session_id: "codex-sess-spend-lock",
        transcript_path: "/never/read",
        cwd: dir,
        hook_event_name: "PreToolUse",
        model: "synthetic-model",
        turn_id: "synthetic-turn",
        tool_name: "apply_patch",
        tool_use_id: id,
        tool_input: { command: PATCH },
      }),
    extra: [],
    verdict: nested,
  },
  {
    kind: "grok",
    policy: policy("autonomous"),
    call: (dir, id) =>
      JSON.stringify({
        hookEventName: "PreToolUse",
        sessionId: "grok-sess-spend-lock",
        cwd: dir,
        workspaceRoot: dir,
        toolName: "Bash",
        toolInput: { command: NPM_INSTALL },
        toolUseId: id,
      }),
    extra: [],
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      const permission = body["decision"];
      assert.ok(permission === "allow" || permission === "deny", `decision ${String(permission)}`);
      return { permission, message: String(body["reason"] ?? "") };
    },
  },
  {
    kind: "muse",
    policy: policy("autonomous"),
    call: (dir, id) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "muse-sess-spend-lock",
        turn_id: "turn-1",
        tool_use_id: id,
        transcript_path: null,
        cwd: dir,
        model: "muse-spark-1.3",
        model_provider: "meta",
        permission_mode: "default",
        tool_name: "bash",
        tool_input: { command: NPM_INSTALL, workdir: dir },
      }),
    extra: [],
    verdict: nested,
  },
  {
    kind: "hermes",
    policy: policy("autonomous"),
    call: (dir, id) =>
      JSON.stringify({
        hook_event_name: "pre_tool_call",
        session_id: "hermes-sess-spend-lock",
        tool_use_id: id,
        cwd: dir,
        profile: "default",
        extra: {},
        tool_name: "terminal",
        tool_input: { command: NPM_INSTALL, workdir: dir },
      }),
    extra: ["--harness-cap", "300s"],
    // Hermes blocks with {action:"block",message} and allows with anything
    // that is not one.
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      if (body["action"] === "block") return { permission: "deny", message: String(body["message"]) };
      return { permission: "allow", message: String(body["message"] ?? "") };
    },
  },
];

const byKind = (kind: Kind): Harness => HARNESSES.find((harness) => harness.kind === kind) as Harness;

function env(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  delete out["APPROVAL_HUMAN"];
  delete out["HERMES_HOME"];
  delete out["APPROVAL_HERMES_HOME"];
  return out;
}

/** A fresh directory with `text` attested and no log yet. */
function ready(text: string): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  const attested = cli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function cli(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [ENTRY, ...args], { cwd, env: env(), encoding: "utf8", input: "" });
  return { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

const logOf = (dir: string): string => join(dir, ".approval", "log", "events.jsonl");
const lockOf = (dir: string): string => `${logOf(dir)}.lock`;

function records(dir: string): Record<string, unknown>[] {
  if (!existsSync(logOf(dir))) return [];
  return readFileSync(logOf(dir), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function count(dir: string, name: string): number {
  return records(dir).filter((r) => r["event"] === name).length;
}

/** Take the log's lock as an outside writer would (the daemon, mid-append). */
function hold(dir: string): void {
  writeFileSync(lockOf(dir), "held by the test\n", { flag: "wx" });
}

/** {@link hold}, waiting out a writer that holds it now (the hook's withdrawal). */
function holdWhenFree(dir: string): void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      hold(dir);
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) throw cause;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function release(dir: string): void {
  rmSync(lockOf(dir), { force: true });
}

/**
 * A human's grant, appended in process, with the lock taken straight after it
 * in the same synchronous stretch: the daemon appending a grant and then its
 * next record. The hook cannot read the grant and take the lock in between, so
 * its spend always meets a held lock. Returns whether the grant landed (a
 * withdrawal that got there first refuses it).
 */
function grantThenHold(dir: string, key: string): boolean {
  release(dir);
  const granted = decide(logOf(dir), key, "grant", "human:alice", { policy: { dir } });
  holdWhenFree(dir);
  if (!granted.ok) assert.equal(granted.code, "request-withdrawn", JSON.stringify(granted));
  return granted.ok;
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Hook {
  kill: (signal: NodeJS.Signals) => void;
  done: Promise<Outcome>;
}

function launch(harness: Harness, dir: string, input: string, extra: string[]): Hook {
  const child = spawn(
    process.execPath,
    [BIN, "hook", harness.kind, "--as", `agent:${harness.kind}`, ...harness.extra, ...extra],
    { cwd: dir, env: env() },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  const backstop = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const done = new Promise<Outcome>((settle) => {
    child.on("close", (code, signal) => {
      clearTimeout(backstop);
      settle({ code, signal, stdout, stderr });
    });
  });
  return { kill: (signal) => child.kill(signal), done };
}

const delay = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

async function until(what: string, check: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(25);
  }
}

/** The action key of the hook's one question, once the hook is polling on it. */
async function waiting(dir: string): Promise<string> {
  await until("the hook's request", () => records(dir).some((r) => r["event"] === "approval.requested"));
  await delay(250);
  const request = records(dir).find((r) => r["event"] === "approval.requested");
  return String(request?.["action_key"]);
}

function only(harness: Harness, outcome: Outcome): Verdict {
  const lines = outcome.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `expected exactly one object on stdout: ${JSON.stringify(outcome.stdout)} ${outcome.stderr}`);
  return harness.verdict(lines[0] as string);
}

/** The hook answered with its own interrupted-wait block, byte for byte. */
function assertInterrupted(harness: Harness, outcome: Outcome): void {
  assert.equal(outcome.signal, null, `died by ${String(outcome.signal)}: ${outcome.stdout} ${outcome.stderr}`);
  const expected = interruptedWaitDirective("SIGTERM", harness.kind);
  assert.equal(outcome.stdout, expected.stdout, outcome.stderr);
  assert.equal(outcome.code, expected.exitCode, outcome.stderr);
  assert.equal(only(harness, outcome).permission, "deny");
}

// ---------------------------------------------------------------------------
// The held-lockfile repro, on every harness
// ---------------------------------------------------------------------------

for (const harness of HARNESSES) {
  const { kind } = harness;

  test(`${kind}: SIGTERM while the spend waits for a held log lock blocks in its own dialect, spends nothing, and a retry carries the grant`, async () => {
    const dir = ready(harness.policy);
    const hook = launch(harness, dir, harness.call(dir, "tu-lock"), ["--timeout", "4m", "--interval", "100ms"]);
    const key = await waiting(dir);
    assert.equal(grantThenHold(dir, key), true);
    try {
      // Several polls: the hook has read the grant and is now waiting for the
      // lock, well inside the two seconds a writer waits for it.
      await delay(700);
      assert.equal(count(dir, "execution.started"), 0, "the spend went through a held lock");
      hook.kill("SIGTERM");
      // The lock is released only after the signal. Before APRV-478 this is
      // the moment the held spend went through, the allow was printed, and the
      // signal was discarded with the wait's listener.
      await delay(100);
    } finally {
      release(dir);
    }
    const outcome = await hook.done;

    assertInterrupted(harness, outcome);
    assert.equal(count(dir, "execution.started"), 0, `a start after the signal: ${outcome.stderr}`);
    // The grant stands as the human gave it: the handler's withdrawal is
    // refused `already-decided`, so nothing is written over the decision.
    assert.equal(count(dir, "approval.withdrawn"), 0);
    assert.equal(count(dir, "approval.granted"), 1);

    // And it was left unspent, not lost: an identical retry carries it, once.
    const retry = launch(harness, dir, harness.call(dir, "tu-lock-retry"), ["--timeout", "30s", "--interval", "100ms"]);
    const again = await retry.done;
    assert.equal(again.code, 0, `${again.stdout} ${again.stderr}`);
    assert.equal(only(harness, again).permission, "allow", again.stderr);
    const starts = records(dir).filter((r) => r["event"] === "execution.started");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.["action_key"], key);
  });
}

// ---------------------------------------------------------------------------
// The grant racing the signal while the lock is contended
// ---------------------------------------------------------------------------

for (const kind of ["claude-code", "grok", "hermes"] as const) {
  const harness = byKind(kind);

  test(`${kind}: the grant races the signal under lock contention, ten at a time: every run blocks and none records a start`, async (t) => {
    const runs = Array.from({ length: 10 }, async (_, index) => {
      const dir = ready(harness.policy);
      const hook = launch(harness, dir, harness.call(dir, `tu-race-${String(index)}`), [
        "--timeout",
        "4m",
        "--interval",
        "50ms",
      ]);
      const key = await waiting(dir);
      hold(dir);
      let granted: boolean;
      try {
        if (index % 2 === 0) {
          // The grant first: the hook reads it and its spend waits for the
          // lock; the signal lands in that wait.
          granted = grantThenHold(dir, key);
          await delay(250);
          hook.kill("SIGTERM");
        } else {
          // The signal first: the wait's handler blocks and tries to withdraw
          // (behind the lock); the grant lands before or after that.
          hook.kill("SIGTERM");
          granted = grantThenHold(dir, key);
        }
        await delay(150);
      } finally {
        release(dir);
      }
      return { dir, granted, outcome: await hook.done };
    });
    let grantedFirst = 0;
    for (const { dir, granted, outcome } of await Promise.all(runs)) {
      assertInterrupted(harness, outcome);
      assert.equal(count(dir, "execution.started"), 0, `a start after a block: ${outcome.stderr}`);
      // Exactly one of the two landed: a grant (the withdrawal then refused
      // `already-decided`) or a withdrawal (the grant then refused
      // `request-withdrawn`). Never both, never neither.
      assert.equal(count(dir, "approval.granted"), granted ? 1 : 0);
      assert.equal(count(dir, "approval.withdrawn"), granted ? 0 : 1);
      if (granted) grantedFirst += 1;
    }
    t.diagnostic(`${kind}: ${String(grantedFirst)} of 10 granted before the withdrawal`);
  });
}

// ---------------------------------------------------------------------------
// With no signal: the spend still waits, and the writer's bound still holds
// ---------------------------------------------------------------------------

for (const kind of ["claude-code", "codex", "hermes"] as const) {
  const harness = byKind(kind);

  test(`${kind}: with no signal the spend waits out a held lock and spends once it is free`, async () => {
    const dir = ready(harness.policy);
    const hook = launch(harness, dir, harness.call(dir, "tu-wait"), ["--timeout", "4m", "--interval", "100ms"]);
    const key = await waiting(dir);
    assert.equal(grantThenHold(dir, key), true);
    try {
      await delay(600);
      assert.equal(count(dir, "execution.started"), 0, "the spend went through a held lock");
    } finally {
      release(dir);
    }
    const outcome = await hook.done;
    assert.equal(outcome.code, 0, `${outcome.stdout} ${outcome.stderr}`);
    assert.equal(only(harness, outcome).permission, "allow", outcome.stderr);
    assert.equal(count(dir, "execution.started"), 1);
  });

  test(`${kind}: a lock held past the writer's bound denies the spend and appends nothing`, async () => {
    const dir = ready(harness.policy);
    const hook = launch(harness, dir, harness.call(dir, "tu-bound"), ["--timeout", "4m", "--interval", "100ms"]);
    const key = await waiting(dir);
    assert.equal(grantThenHold(dir, key), true);
    let outcome: Outcome;
    try {
      outcome = await hook.done;
    } finally {
      release(dir);
    }
    assert.equal(outcome.signal, null, outcome.stderr);
    const verdict = only(harness, outcome);
    assert.equal(verdict.permission, "deny", outcome.stderr);
    assert.match(verdict.message, /^hook-gate-refused:append-failed: /u);
    assert.match(verdict.message, /another writer holds .*events\.jsonl\.lock/u);
    assert.match(verdict.message, /on the event loop for its whole 2000 ms bound, trying every 20 ms, and another writer held it at each of its \d+ attempts? \(APRV-478\)/u);
    assert.equal(count(dir, "execution.started"), 0);
    // Nothing was spent, so the grant is still there for a retry.
    assert.equal(count(dir, "approval.granted"), 1);
  });
}

// ---------------------------------------------------------------------------
// Step by step: the lock wait yields, and the zero pause is last
// ---------------------------------------------------------------------------

type Steps = Generator<number, number, boolean | undefined>;

function stepsFor(harness: Harness, dir: string, input: string, extra: string[] = []): { steps: Steps; out: string[] } {
  const out: string[] = [];
  const streams = { out: (text: string) => out.push(text), err: () => undefined };
  const steps = commandHookSteps(
    [harness.kind, "--as", `agent:${harness.kind}`, "--dir", dir, "--timeout", "4m", "--interval", "50ms", ...harness.extra, ...extra],
    streams,
    dir,
    () => input,
  );
  return { steps, out };
}

/** Step as the yielding driver does (`true`) to the first poll pause. */
function toFirstPoll(steps: Steps, out: string[]): void {
  let step = steps.next(true);
  while (step.done !== true && step.value === 0) step = steps.next(true);
  assert.equal(step.done, false, `the hook answered without waiting: ${out.join("")}`);
  assert.ok(step.value > 0, "the first pause is the poll interval");
}

/**
 * From a step that is about to spend with the lock held: the zero pause, the
 * retry interval three times with nothing spent, then (lock released) the zero
 * pause again with nothing spent, and only then the append and the allow.
 */
function assertYieldedSpend(harness: Harness, dir: string, steps: Steps, out: string[], startsBefore: number): void {
  let step = steps.next(true);
  assert.equal(step.done, false, `the grant was spent with no pause before it: ${out.join("")}`);
  assert.equal(step.value, 0, `expected the shared zero pause first, got a ${String(step.value)} ms pause`);
  for (let i = 0; i < 3; i += 1) {
    step = steps.next(true);
    assert.equal(step.done, false, `the spend did not wait for the lock: ${out.join("")}`);
    assert.equal(step.value, DEFAULT_LOCK_RETRY_MS, `expected the lock's retry interval, got a ${String(step.value)} ms pause`);
    assert.equal(count(dir, "execution.started"), startsBefore, "the spend went through a held lock");
  }
  // The other writer finishes. The next step is the zero pause again, the last
  // point a held signal can reach a listener; nothing is spent yet.
  release(dir);
  step = steps.next(true);
  assert.equal(step.done, false, `the spend ran with no pause after the lock wait: ${out.join("")}`);
  assert.equal(step.value, 0, `expected the zero pause before the spend, got a ${String(step.value)} ms pause`);
  assert.equal(count(dir, "execution.started"), startsBefore, "the spend ran before the pause");
  // Past the pause, the spend and the allow, with no further pause.
  step = steps.next(true);
  assert.equal(step.done, true, "the hook paused again after the spend's pause");
  assert.equal(count(dir, "execution.started"), startsBefore + 1);
  assert.equal(harness.verdict(out.join("").trim()).permission, "allow", out.join(""));
}

/**
 * The process tests above depend on timing; these do not. They drive the very
 * steps the CLI's yielding driver runs, in process, and stop at each pause.
 * With the wait for the lock done synchronously inside the writer (the
 * pre-APRV-478 spend), the step after the zero pause blocks for two seconds and
 * refuses, so every one of these fails.
 */
for (const harness of HARNESSES) {
  test(`${harness.kind}: while the log's lock is held the spend yields the retry interval, and the zero pause comes last`, () => {
    const dir = ready(harness.policy);
    const { steps, out } = stepsFor(harness, dir, harness.call(dir, "tu-stepped"));
    try {
      toFirstPoll(steps, out);
      const request = records(dir).find((r) => r["event"] === "approval.requested");
      assert.ok(request !== undefined, "the hook opened no question");
      // The grant lands and an outside writer takes the lock behind it; the
      // next poll reads the grant and the spend meets the held lock.
      assert.equal(grantThenHold(dir, String(request["action_key"])), true);
      assertYieldedSpend(harness, dir, steps, out, 0);
    } finally {
      release(dir);
      // Runs the generator's finally blocks, so a failed assertion above does
      // not leave the wait's signal listeners registered in this process.
      steps.return(-1);
    }
  });
}

for (const kind of ["claude-code", "hermes"] as const) {
  const harness = byKind(kind);

  test(`${kind}: a carried grant's spend waits for a held lock in yields too`, () => {
    const dir = ready(harness.policy);
    // The first call times out with its question open; the human then grants
    // it, and an identical retry carries the grant.
    const first = launch(harness, dir, harness.call(dir, "tu-carry-1"), ["--timeout", "1s", "--interval", "100ms"]);
    return first.done.then((timedOut) => {
      assert.equal(only(harness, timedOut).permission, "deny", timedOut.stderr);
      const request = records(dir).find((r) => r["event"] === "approval.requested");
      assert.ok(request !== undefined);
      assert.equal(grantThenHold(dir, String(request["action_key"])), true);
      const { steps, out } = stepsFor(harness, dir, harness.call(dir, "tu-carry-2"));
      try {
        // No wait on this path: the steps go straight to the spend, which
        // meets the held lock.
        assertYieldedSpend(harness, dir, steps, out, 0);
        const start = records(dir).find((r) => r["event"] === "execution.started");
        assert.ok(start !== undefined, "no start recorded");
        assert.equal((start["payload"] as Record<string, unknown>)["grant_origin"], "carried");
      } finally {
        release(dir);
        steps.return(-1);
      }
    });
  });

  test(`${kind}: an autonomous charge waits for a held lock in yields too`, () => {
    const dir = ready(policy("autonomous"));
    const call =
      kind === "hermes"
        ? JSON.stringify({
            hook_event_name: "pre_tool_call",
            session_id: "hermes-sess-charge",
            tool_use_id: "tu-charge",
            cwd: dir,
            profile: "default",
            extra: {},
            tool_name: "terminal",
            tool_input: { command: "ls", workdir: dir },
          })
        : JSON.stringify({
            session_id: "sess-charge",
            transcript_path: "/dev/null",
            cwd: dir,
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "ls" },
            tool_use_id: "tu-charge",
          });
    hold(dir);
    const { steps, out } = stepsFor(harness, dir, call);
    try {
      assertYieldedSpend(harness, dir, steps, out, 0);
    } finally {
      release(dir);
      steps.return(-1);
    }
  });
}

test("hermes: SIGTERM while an autonomous charge waits for a held lock blocks at exit 2 and records nothing", async () => {
  const harness = byKind("hermes");
  const dir = ready(policy("autonomous"));
  const before = records(dir).length;
  hold(dir);
  const hook = launch(
    harness,
    dir,
    JSON.stringify({
      hook_event_name: "pre_tool_call",
      session_id: "hermes-sess-charge",
      tool_use_id: "tu-charge-signal",
      cwd: dir,
      profile: "default",
      extra: {},
      tool_name: "terminal",
      tool_input: { command: "ls", workdir: dir },
    }),
    [],
  );
  let outcome: Outcome;
  try {
    // Inside the two seconds the charge waits for the lock, after startup.
    await delay(1_200);
    hook.kill("SIGTERM");
    await delay(100);
  } finally {
    release(dir);
  }
  outcome = await hook.done;
  // Hermes's early guard answers: its block, exit 2. Before APRV-478 the
  // signal was held through the charge's synchronous lock wait and the hook
  // answered {} with a start recorded after it.
  assert.equal(outcome.signal, null, outcome.stderr);
  assert.equal(outcome.code, 2, `${outcome.stdout} ${outcome.stderr}`);
  assert.equal(only(harness, outcome).permission, "deny", outcome.stdout);
  assert.equal(records(dir).length, before, "the interrupted charge recorded something");
});

test("claude-code: a multi-class spend pauses before each class, so a signal between two blocks with only the earlier start recorded", () => {
  const harness = byKind("claude-code");
  const dir = ready(policy("autonomous"));
  const command = "npm install left-pad && curl -X POST https://example.com/hook";
  const call = JSON.stringify({
    session_id: "sess-multi",
    transcript_path: "/dev/null",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "tu-multi",
  });
  const { steps, out } = stepsFor(harness, dir, call);
  try {
    toFirstPoll(steps, out);
    const requests = records(dir).filter((r) => r["event"] === "approval.requested");
    assert.equal(requests.length, 2, JSON.stringify(requests.map((r) => r["action_key"])));
    for (const request of requests) {
      const granted = decide(logOf(dir), String(request["action_key"]), "grant", "human:alice", { policy: { dir } });
      assert.equal(granted.ok, true, JSON.stringify(granted));
    }
    // The poll reads both grants; the first key's pause, nothing spent.
    let step = steps.next(true);
    assert.equal(step.done, false);
    assert.equal(step.value, 0);
    assert.equal(count(dir, "execution.started"), 0);
    // The second key's pause, with the first key spent: a signal dispatched
    // here blocks the call with this one start on the log (documented in
    // consumeGrants and docs/claude-code-hook.md), and nothing after it.
    step = steps.next(true);
    assert.equal(step.done, false, out.join(""));
    assert.equal(step.value, 0);
    assert.equal(count(dir, "execution.started"), 1);
    step = steps.next(true);
    assert.equal(step.done, true);
    assert.equal(count(dir, "execution.started"), 2);
    assert.equal(harness.verdict(out.join("").trim()).permission, "allow");
  } finally {
    steps.return(-1);
  }
});

test("the synchronous driver keeps the writer's own lock wait: no yields, and a held lock refuses after the writer's bound", () => {
  // commandHook in process, the serve worker and the Codex bridge step with
  // `false`/nothing. Their spend is the pre-APRV-478 one: the zero pause (no
  // pause there) and the writer's own synchronous two-second wait.
  const harness = byKind("claude-code");
  const dir = ready(harness.policy);
  const { steps, out } = stepsFor(harness, dir, harness.call(dir, "tu-sync"));
  try {
    let step = steps.next();
    while (step.done !== true && step.value === 0) step = steps.next();
    assert.equal(step.done, false);
    const request = records(dir).find((r) => r["event"] === "approval.requested");
    assert.ok(request !== undefined);
    assert.equal(grantThenHold(dir, String(request["action_key"])), true);
    step = steps.next();
    assert.equal(step.done, false);
    assert.equal(step.value, 0, "the shared pause");
    const startedAt = Date.now();
    step = steps.next();
    const blockedMs = Date.now() - startedAt;
    assert.equal(step.done, true, "the synchronous spend yielded");
    assert.ok(blockedMs >= 1_900, `the writer waited ${String(blockedMs)} ms, not its own bound`);
    const verdict = harness.verdict(out.join("").trim());
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.message, /gave up after 2000ms/u);
    assert.doesNotMatch(verdict.message, /APRV-478/u);
    assert.equal(count(dir, "execution.started"), 0);
  } finally {
    release(dir);
    steps.return(-1);
  }
});

// ---------------------------------------------------------------------------
// A lost race goes back to waiting, for the spend and for its evidence
// ---------------------------------------------------------------------------

/**
 * Another writer takes the lock in the gap between the probe that saw it free
 * and the attempt (here: at the zero pause, which is exactly that gap). The
 * attempt loses, writes nothing, and the spend goes back to waiting on the
 * event loop instead of refusing; once the lock is free again it spends.
 */
function lsCall(dir: string, id: string): string {
  return JSON.stringify({
    session_id: "sess-race",
    transcript_path: "/dev/null",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: id,
  });
}

/** Lock held; step to the zero pause after the wait, re-take the lock there, and lose. */
function loseOneRace(dir: string, steps: Steps, out: string[]): void {
  let step = steps.next(true);
  assert.equal(step.value, 0, "the shared zero pause");
  step = steps.next(true);
  assert.equal(step.value, DEFAULT_LOCK_RETRY_MS, "waiting for the held lock");
  release(dir);
  step = steps.next(true);
  assert.equal(step.done, false);
  assert.equal(step.value, 0, "the zero pause after the wait, before the attempt");
  // The race: another writer takes the lock after the probe saw it free.
  hold(dir);
  step = steps.next(true);
  assert.equal(step.done, false, `the attempt lost the race and refused instead of waiting: ${out.join("")}`);
  assert.equal(step.value, DEFAULT_LOCK_RETRY_MS, "back to waiting on the event loop after the lost race");
  release(dir);
  step = steps.next(true);
  assert.equal(step.done, false);
  assert.equal(step.value, 0, "the zero pause again before the next attempt");
  step = steps.next(true);
  assert.equal(step.done, true, out.join(""));
}

test("claude-code: an attempt that loses the lock race goes back to waiting and then spends", () => {
  const harness = byKind("claude-code");
  const dir = ready(policy("autonomous"));
  hold(dir);
  const { steps, out } = stepsFor(harness, dir, lsCall(dir, "tu-race-lost"));
  try {
    loseOneRace(dir, steps, out);
    assert.equal(harness.verdict(out.join("").trim()).permission, "allow", out.join(""));
    assert.equal(count(dir, "execution.started"), 1);
  } finally {
    release(dir);
    steps.return(-1);
  }
});

test("claude-code: a budget refusal whose budget.exceeded record loses the lock race is retried, so the record lands", () => {
  const harness = byKind("claude-code");
  const dir = ready(
    [
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
      "budgets:",
      "  global:",
      "    daily_actions: 1",
      "```",
      "",
    ].join("\n"),
  );
  // The first call spends the one action the budget allows.
  const first = stepsFor(harness, dir, lsCall(dir, "tu-budget-1"));
  let step = first.steps.next(true);
  while (step.done !== true) step = first.steps.next(true);
  assert.equal(harness.verdict(first.out.join("").trim()).permission, "allow", first.out.join(""));
  assert.equal(count(dir, "budget.exceeded"), 0);

  hold(dir);
  const { steps, out } = stepsFor(harness, dir, lsCall(dir, "tu-budget-2"));
  try {
    loseOneRace(dir, steps, out);
    const verdict = harness.verdict(out.join("").trim());
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.message, /budget-exceeded/u);
    // The evidence the refusal promises is on the log (SPEC's start-path code
    // table: a budget.exceeded record IS appended before the refusal).
    assert.equal(count(dir, "budget.exceeded"), 1, verdict.message);
    assert.equal(count(dir, "execution.started"), 1, "only the first call's start");
  } finally {
    release(dir);
    steps.return(-1);
  }
});
