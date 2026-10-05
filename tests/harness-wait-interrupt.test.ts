/**
 * Every CLI harness hook interrupted mid-wait withdraws its question, answers
 * in its own block dialect, and never records an execution (APRV-475).
 *
 * APRV-473 moved the gate path onto one generator chain with two drivers and
 * put `approval hook hermes` on the yielding one, so a SIGTERM mid-wait reached
 * the wait's withdrawing handler. The other five CLI harness verbs still drove
 * the same steps synchronously (`Atomics.wait` between polls), so a signal sent
 * mid-wait was held until the wait returned, and a human who granted meanwhile
 * got `execution.started` recorded for a tool call the harness had already
 * abandoned. Now every `approval hook <harness>` route runs through
 * `commandHookYielding`, and these pin, for Claude Code, Cursor, Codex, Grok
 * and Muse each (`tests/hermes-wait-interrupt.test.ts` holds Hermes):
 *
 * - SIGTERM through the bin and SIGINT through the bare entry, mid-wait, answer
 *   within one poll with that harness's own `hook-interrupted` deny (its own
 *   keys, its own exit code), exactly one object on stdout, and append
 *   `approval.withdrawn` for the question this invocation opened;
 * - a grant that arrives after that is refused `request-withdrawn` and nothing
 *   records `execution.started`;
 * - a grant that lands BEFORE the signal, between two polls, is never spent:
 *   the withdrawal is refused `already-decided` (nothing is written over the
 *   decision), the hook still blocks, and the log carries no start;
 * - twenty concurrent races of a grant against the signal never end in a start
 *   after a block;
 * - a signal before the wait (here, during the stdin read) takes the default
 *   disposition on these harnesses, which register no listener there: the
 *   process dies, and the call it was deciding records nothing;
 * - the wait's window and cadence are untouched: with no signal it still runs
 *   to its own `hook-timeout` and leaves the question open.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { commandHookSteps, interruptedWaitDirective } from "../src/cli/hook.js";

const BIN = fileURLToPath(new URL("../../cli.js", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-harness-interrupt-")));
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

type Kind = "claude-code" | "cursor" | "codex" | "grok" | "muse";

interface Verdict {
  permission: "allow" | "deny";
  message: string;
}

interface Harness {
  kind: Kind;
  /** The exit code this harness's deny carries. */
  denyExit: number;
  /** The policy under which {@link manualCall} waits on a human. */
  manualPolicy: string;
  /** A call that opens a question and waits on it. */
  manualCall: (dir: string, id: string) => string;
  /** A call the policy admits at once, recording one `execution.started`. */
  autonomousCall: (dir: string, id: string) => string;
  /** The verdict in this harness's dialect, with its keys checked exactly. */
  verdict: (stdout: string) => Verdict;
}

const NPM_INSTALL = "npm install left-pad";
const PATCH = "*** Begin Patch\n*** Add File: interrupt.txt\n+x\n*** End Patch";

/** The nested PreToolUse envelope Claude Code, Codex and Muse read. */
function nested(stdout: string): Verdict {
  const body = JSON.parse(stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["hookSpecificOutput"]);
  const out = body["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(out["hookEventName"], "PreToolUse");
  const permission = out["permissionDecision"];
  assert.ok(permission === "allow" || permission === "deny", `permissionDecision ${String(permission)}`);
  return { permission, message: String(out["permissionDecisionReason"]) };
}

function claudeShape(dir: string, id: string, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "sess-interrupt",
    transcript_path: "/dev/null",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
  });
}

const HARNESSES: readonly Harness[] = [
  {
    kind: "claude-code",
    denyExit: 0,
    manualPolicy: policy("autonomous"),
    manualCall: (dir, id) => claudeShape(dir, id, "Bash", { command: NPM_INSTALL }),
    autonomousCall: (dir, id) =>
      claudeShape(dir, id, "Write", { file_path: join(dir, "notes.txt"), content: "hello\n" }),
    verdict: nested,
  },
  {
    kind: "cursor",
    denyExit: 0,
    manualPolicy: policy("autonomous"),
    manualCall: (dir, id) =>
      JSON.stringify({
        session_id: "cursor-sess-interrupt",
        cwd: dir,
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_input: { command: NPM_INSTALL },
        tool_use_id: id,
      }),
    autonomousCall: (dir, id) =>
      JSON.stringify({
        session_id: "cursor-sess-interrupt",
        cwd: dir,
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: { path: "notes.txt", contents: "hello\n" },
        tool_use_id: id,
      }),
    verdict: (stdout) => {
      const body = JSON.parse(stdout) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["agent_message", "permission", "user_message"]);
      const permission = body["permission"];
      assert.ok(permission === "allow" || permission === "deny", `permission ${String(permission)}`);
      assert.equal(body["user_message"], body["agent_message"]);
      return { permission, message: String(body["user_message"]) };
    },
  },
  {
    // Codex's native Bash is refused before the gate (SPEC §10.6), so the
    // call that waits is a direct apply_patch under a manual write class.
    kind: "codex",
    denyExit: 0,
    manualPolicy: policy("manual"),
    manualCall: (dir, id) =>
      JSON.stringify({
        session_id: "codex-sess-interrupt",
        transcript_path: "/never/read",
        cwd: dir,
        hook_event_name: "PreToolUse",
        model: "synthetic-model",
        turn_id: "synthetic-turn",
        tool_name: "apply_patch",
        tool_use_id: id,
        tool_input: { command: PATCH },
      }),
    autonomousCall: (dir, id) =>
      JSON.stringify({
        session_id: "codex-sess-interrupt",
        transcript_path: "/never/read",
        cwd: dir,
        hook_event_name: "PreToolUse",
        model: "synthetic-model",
        turn_id: "synthetic-turn",
        tool_name: "apply_patch",
        tool_use_id: id,
        tool_input: { command: PATCH },
      }),
    verdict: nested,
  },
  {
    kind: "grok",
    denyExit: 2,
    manualPolicy: policy("autonomous"),
    manualCall: (dir, id) =>
      JSON.stringify({
        hookEventName: "PreToolUse",
        sessionId: "grok-sess-interrupt",
        cwd: dir,
        workspaceRoot: dir,
        toolName: "Bash",
        toolInput: { command: NPM_INSTALL },
        toolUseId: id,
      }),
    autonomousCall: (dir, id) =>
      JSON.stringify({
        hookEventName: "PreToolUse",
        sessionId: "grok-sess-interrupt",
        cwd: dir,
        workspaceRoot: dir,
        toolName: "Write",
        toolInput: { file_path: join(dir, "notes.txt"), content: "hello\n" },
        toolUseId: id,
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
    manualPolicy: policy("autonomous"),
    manualCall: (dir, id) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "muse-sess-interrupt",
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
    autonomousCall: (dir, id) =>
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "muse-sess-interrupt",
        turn_id: "turn-1",
        tool_use_id: id,
        transcript_path: null,
        cwd: dir,
        model: "muse-spark-1.3",
        model_provider: "meta",
        permission_mode: "default",
        tool_name: "write_file",
        tool_input: { path: "notes.txt", content: "hello\n" },
      }),
    verdict: nested,
  },
];

function env(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  delete out["APPROVAL_HUMAN"];
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

function records(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function count(dir: string, name: string): number {
  return records(dir).filter((r) => r["event"] === name).length;
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Milliseconds from the signal (or from spawn, unsignalled) to exit. */
  ms: number;
}

interface Hook {
  kill: (signal: NodeJS.Signals) => void;
  /** Ends stdin, for a hook launched with it held open. */
  endInput: () => void;
  done: Promise<Outcome>;
}

function launch(
  entry: string,
  harness: Harness,
  dir: string,
  input: string,
  extra: string[],
  opts: { holdInput?: boolean } = {},
): Hook {
  const child = spawn(
    process.execPath,
    [entry, "hook", harness.kind, "--as", `agent:${harness.kind}`, ...extra],
    { cwd: dir, env: env() },
  );
  let stdout = "";
  let stderr = "";
  let from = Date.now();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", () => undefined);
  if (opts.holdInput === true) child.stdin.write(input);
  else child.stdin.end(input);
  const backstop = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const done = new Promise<Outcome>((settle) => {
    child.on("close", (code, signal) => {
      clearTimeout(backstop);
      settle({ code, signal, stdout, stderr, ms: Date.now() - from });
    });
  });
  return {
    kill: (signal) => {
      from = Date.now();
      child.kill(signal);
    },
    endInput: () => child.stdin.end(),
    done,
  };
}

const delay = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

async function until(what: string, check: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(25);
  }
}

/**
 * The action key of the one question the hook opened, once it is on the log
 * and the hook has had time to start polling on it. The request is appended a
 * moment before the wait's handler is registered, and a signal inside that
 * moment is a signal before the wait (the default disposition, pinned by its
 * own test below), so the mid-wait tests leave the hook a beat to get there.
 */
async function waiting(dir: string): Promise<string> {
  await until("the hook's request", () => records(dir).some((r) => r["event"] === "approval.requested"));
  await delay(250);
  const request = records(dir).find((r) => r["event"] === "approval.requested");
  return String(request?.["action_key"]);
}

/** The one object on stdout, read in the harness's dialect. */
function only(harness: Harness, outcome: Outcome): Verdict {
  const lines = outcome.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `expected exactly one object on stdout: ${JSON.stringify(outcome.stdout)}`);
  return harness.verdict(lines[0] as string);
}

for (const harness of HARNESSES) {
  const { kind } = harness;

  // -------------------------------------------------------------------------
  // The signal mid-wait: withdrawn, blocked in the harness's dialect, and a
  // later grant is refused
  // -------------------------------------------------------------------------

  for (const [label, entry, signal] of [
    ["the bin", BIN, "SIGTERM"],
    ["the bare entry", ENTRY, "SIGINT"],
  ] as const) {
    test(`${kind}: through ${label}, ${signal} mid-wait withdraws the question, blocks in its own dialect, and a later grant starts nothing`, async () => {
      const dir = ready(harness.manualPolicy);
      // A wait far longer than the test, so only the signal can end it.
      const hook = launch(entry, harness, dir, harness.manualCall(dir, `tu-${signal}`), [
        "--timeout",
        "4m",
        "--interval",
        "200ms",
      ]);
      const key = await waiting(dir);
      hook.kill(signal);
      const outcome = await hook.done;

      assert.equal(outcome.signal, null, `died by ${String(outcome.signal)}: ${outcome.stderr}`);
      assert.equal(outcome.code, harness.denyExit, outcome.stderr);
      // Within one poll interval and the withdrawal's own append, not at the
      // end of a four-minute wait. Generous for a loaded machine.
      assert.ok(outcome.ms < 15_000, `answered ${String(outcome.ms)} ms after the signal`);
      const verdict = only(harness, outcome);
      assert.equal(verdict.permission, "deny");
      assert.equal(
        verdict.message,
        `hook-interrupted: the hook received ${signal} while waiting for a decision; nothing authorizes this call`,
      );
      // Byte for byte the directive the runtime builds for this harness, at
      // its exit code: one construction site per harness.
      const expected = interruptedWaitDirective(signal, kind);
      assert.equal(outcome.stdout, expected.stdout);
      assert.equal(outcome.code, expected.exitCode);

      const withdrawn = records(dir).filter((r) => r["event"] === "approval.withdrawn");
      assert.equal(withdrawn.length, 1, JSON.stringify(withdrawn));
      assert.equal(withdrawn[0]?.["action_key"], key);
      assert.equal(withdrawn[0]?.["actor"], `agent:${kind}`);

      // The human answers after the harness gave up: the state machine refuses it.
      const late = cli(["grant", key, "--as", "human:alice", "--json"], dir);
      assert.notEqual(late.code, 0, `a grant on a withdrawn request was accepted: ${late.stdout}`);
      assert.match(`${late.stdout}${late.stderr}`, /request-withdrawn/u);
      assert.equal(count(dir, "approval.granted"), 0);
      assert.equal(count(dir, "execution.started"), 0);
    });
  }

  // -------------------------------------------------------------------------
  // The race: a grant that lands between two polls, then the signal
  // -------------------------------------------------------------------------

  test(`${kind}: a grant that lands between two polls, then SIGTERM: blocked, nothing spent, nothing written over the decision`, async () => {
    const dir = ready(harness.manualPolicy);
    // A poll interval far longer than the race, so the grant and the signal
    // both land inside one pause and the next poll never runs.
    const hook = launch(BIN, harness, dir, harness.manualCall(dir, "tu-race"), [
      "--timeout",
      "4m",
      "--interval",
      "60s",
    ]);
    const key = await waiting(dir);
    const grant = cli(["grant", key, "--as", "human:alice", "--json"], dir);
    assert.equal(grant.code, 0, grant.stderr);
    hook.kill("SIGTERM");
    const outcome = await hook.done;

    assert.equal(outcome.signal, null, `died by ${String(outcome.signal)}: ${outcome.stderr}`);
    assert.equal(outcome.code, harness.denyExit, outcome.stderr);
    const verdict = only(harness, outcome);
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.message, /^hook-interrupted: the hook received SIGTERM while waiting/u);
    // The grant stands as the human gave it: the requester's withdrawal is
    // refused `already-decided`, so no withdrawn record is written over it.
    assert.equal(count(dir, "approval.withdrawn"), 0);
    assert.equal(count(dir, "approval.granted"), 1);
    // And it was not spent on a call the harness abandoned.
    assert.equal(count(dir, "execution.started"), 0);
  });

  test(`${kind}: the race, twenty times concurrently: whichever of the grant and the signal lands first, no start follows a block`, async (t) => {
    const runs = Array.from({ length: 20 }, async (_, index) => {
      const dir = ready(harness.manualPolicy);
      const hook = launch(BIN, harness, dir, harness.manualCall(dir, `tu-race-${String(index)}`), [
        "--timeout",
        "4m",
        "--interval",
        "20ms",
      ]);
      const key = await waiting(dir);
      // The grant and the signal as close together as two processes allow, in
      // alternating order, against a 20 ms poll: some runs see the grant first.
      const grant = (): void => {
        cli(["grant", key, "--as", "human:alice"], dir);
      };
      if (index % 2 === 0) {
        grant();
        hook.kill("SIGTERM");
      } else {
        hook.kill("SIGTERM");
        grant();
      }
      return { dir, outcome: await hook.done };
    });
    let allowed = 0;
    let torn = 0;
    for (const { dir, outcome } of await Promise.all(runs)) {
      if (outcome.code === null) {
        // The signal landed after the wait's handler was removed, which is
        // after the spend: the grant was read and recorded as spent BEFORE the
        // signal arrived, and the default disposition then ended the process,
        // with or without the allow already on stdout. Never a block.
        torn += 1;
        assert.equal(outcome.signal, "SIGTERM");
        if (outcome.stdout !== "") assert.equal(only(harness, outcome).permission, "allow");
        assert.equal(count(dir, "execution.started"), 1, `a death by signal with no spend: ${outcome.stderr}`);
        continue;
      }
      const verdict = only(harness, outcome);
      if (verdict.permission === "allow") {
        // The legitimate allow: the hook read the grant and passed its pause
        // before the spend with no signal dispatched. The signal then landed
        // after the spend, or inside the spend's own synchronous stretch (its
        // read and its single try at the lock and append), which is the
        // documented residue; a wait for the lock yields since APRV-478 and is
        // pinned in tests/harness-spend-lock-wait.test.ts. The pause itself is
        // pinned deterministically by the stepped test below, not by this race.
        allowed += 1;
        assert.equal(outcome.code, 0, outcome.stderr);
        assert.equal(count(dir, "execution.started"), 1);
        continue;
      }
      assert.equal(outcome.code, harness.denyExit, `${outcome.stdout} ${outcome.stderr}`);
      assert.match(verdict.message, /^hook-interrupted: /u);
      assert.equal(count(dir, "execution.started"), 0, `a start after a block: ${outcome.stdout}`);
    }
    t.diagnostic(`${kind}: ${String(allowed)} allowed, ${String(torn)} ended after the spend`);
  });

  // -------------------------------------------------------------------------
  // Before the wait: the default disposition, nothing recorded
  // -------------------------------------------------------------------------

  test(`${kind}: a SIGTERM during the stdin read ends the process and the call records no start`, async () => {
    const dir = ready(policy("autonomous"));

    // The control: unsignalled, this call is admitted and records one start.
    const control = launch(BIN, harness, dir, harness.autonomousCall(dir, "tu-held-1"), []);
    const allowed = await control.done;
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(only(harness, allowed).permission, "allow");
    assert.equal(count(dir, "execution.started"), 1, "the control recorded no start, so this test proves nothing");

    // The same call, with the signal landing while the hook blocks on stdin.
    const hook = launch(BIN, harness, dir, harness.autonomousCall(dir, "tu-held-2"), [], { holdInput: true });
    await delay(2_000);
    hook.kill("SIGTERM");
    await delay(200);
    hook.endInput();
    const outcome = await hook.done;
    // No listener is registered before the wait on this harness, so the
    // signal is never held: the process dies at once, with nothing printed.
    assert.equal(outcome.code, null, `${outcome.stdout} ${outcome.stderr}`);
    assert.equal(outcome.signal, "SIGTERM");
    assert.equal(outcome.stdout, "");
    assert.equal(count(dir, "execution.started"), 1, "the interrupted call recorded a start");
  });

  // -------------------------------------------------------------------------
  // The window is unchanged
  // -------------------------------------------------------------------------

  test(`${kind}: with no signal the yielding wait still runs to its own timeout and leaves the question open`, async () => {
    const dir = ready(harness.manualPolicy);
    const hook = launch(BIN, harness, dir, harness.manualCall(dir, "tu-quiet"), [
      "--timeout",
      "1500ms",
      "--interval",
      "100ms",
    ]);
    const outcome = await hook.done;
    assert.equal(outcome.code, harness.denyExit, outcome.stderr);
    assert.ok(outcome.ms >= 1_500, `the wait ended after ${String(outcome.ms)} ms, before its timeout`);
    const verdict = only(harness, outcome);
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.message, /^hook-timeout: /u);
    // A timeout keeps the question for the retry grace, exactly as before.
    assert.equal(count(dir, "approval.withdrawn"), 0);
    const request = records(dir).find((r) => r["event"] === "approval.requested");
    const late = cli(["grant", String(request?.["action_key"]), "--as", "human:alice"], dir);
    assert.equal(late.code, 0, late.stderr);
    assert.equal(count(dir, "execution.started"), 0);
  });
}

// ---------------------------------------------------------------------------
// The shared pause before the spend, pinned step by step (APRV-475 refuter)
// ---------------------------------------------------------------------------

/**
 * Every harness, Hermes included, for the stepped test: the shared pause is
 * one yield in one chain, so it must show up identically on all six.
 */
const STEPPED: readonly { kind: string; policy: string; call: (dir: string) => string; extra: string[] }[] = [
  ...HARNESSES.map((harness) => ({
    kind: harness.kind,
    policy: harness.manualPolicy,
    call: (dir: string) => harness.manualCall(dir, "tu-stepped"),
    extra: [] as string[],
  })),
  {
    kind: "hermes",
    policy: policy("autonomous"),
    call: (dir: string) =>
      JSON.stringify({
        hook_event_name: "pre_tool_call",
        session_id: "hermes-sess-stepped",
        tool_use_id: "tu-stepped",
        cwd: dir,
        profile: "default",
        extra: {},
        tool_name: "terminal",
        tool_input: { command: NPM_INSTALL, workdir: dir },
      }),
    extra: ["--harness-cap", "300s"],
  },
];

/**
 * The race tests above cannot see this pause: a 60 s interval dispatches the
 * signal in the timer pause, and the twenty-run race is probabilistic (the
 * refuter deleted the pause and all thirty still passed). So this drives the
 * very steps the CLI's yielding driver runs, in process, and stops at each
 * pause to look at the log: after a grant lands, the next step must be a ZERO
 * pause with the grant read and nothing spent yet, and only the step after it
 * may append `execution.started`. With the pause removed, the step after the
 * grant spends at once and this fails.
 */
for (const stepped of STEPPED) {
  test(`${stepped.kind}: after the wait reads a grant, the shared zero pause comes before anything is spent`, () => {
    const dir = ready(stepped.policy);
    const out: string[] = [];
    const streams = { out: (text: string) => out.push(text), err: () => undefined };
    const steps = commandHookSteps(
      [stepped.kind, "--as", `agent:${stepped.kind}`, "--dir", dir, "--timeout", "4m", "--interval", "50ms", ...stepped.extra],
      streams,
      dir,
      () => stepped.call(dir),
    );
    try {
      // Run to the first poll pause: the question is open and nothing is spent.
      let step = steps.next();
      while (step.done !== true && step.value === 0) step = steps.next();
      assert.equal(step.done, false, `the hook answered without waiting: ${out.join("")}`);
      assert.ok(step.value > 0, "the first pause is the poll interval");
      const request = records(dir).find((r) => r["event"] === "approval.requested");
      assert.ok(request !== undefined, "the hook opened no question");
      assert.equal(count(dir, "execution.started"), 0);

      // The human grants while the hook sleeps between polls.
      const grant = cli(["grant", String(request["action_key"]), "--as", "human:alice"], dir);
      assert.equal(grant.code, 0, grant.stderr);

      // The next poll reads the grant, and the step it ends on is the zero
      // pause: the point where the yielding driver lets a held signal reach
      // the wait's handler. Nothing is spent yet.
      step = steps.next();
      assert.equal(step.done, false, `the grant was spent with no pause before it: ${out.join("")}`);
      assert.equal(step.value, 0, `expected the zero pause before the spend, got a ${String(step.value)} ms pause`);
      assert.equal(count(dir, "execution.started"), 0, "the grant was spent before the pause");

      // Past the pause, the spend and the allow.
      step = steps.next();
      assert.equal(step.done, true, "the hook paused again after the spend's pause");
      assert.equal(step.value, 0, out.join(""));
      assert.equal(count(dir, "execution.started"), 1);
    } finally {
      // Runs the generator's finally blocks, so a failed assertion above does
      // not leave the wait's signal listeners registered in this process.
      steps.return(-1);
    }
  });
}
