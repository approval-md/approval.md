/**
 * A Hermes hook interrupted mid-wait withdraws its question and never records
 * an execution (APRV-473).
 *
 * Hermes sends SIGTERM on its own hook timeout and on gateway shutdown, and
 * from that moment it has abandoned the tool call. Before APRV-473 the CLI hook
 * run was synchronous end to end (`readFileSync` on stdin, an `Atomics.wait`
 * poll), so the signal was held until the wait returned: a human who granted
 * meanwhile got an `execution.started` recorded for a call that never ran, and
 * Hermes (which had stopped listening) was answered `{}`. The CLI route now
 * runs its pauses on the event loop (`commandHookYielding`), so these pin:
 *
 * - SIGTERM or SIGINT mid-wait, through the bin and through the bare entry,
 *   answers within one poll with the wait's own `hook-interrupted` directive at
 *   exit 2, exactly one object on stdout, and appends `approval.withdrawn` for
 *   the question this invocation opened;
 * - a grant that arrives after that is refused `request-withdrawn` by the state
 *   machine and nothing records `execution.started`;
 * - a grant that lands BEFORE the signal, between two polls, is never spent:
 *   the withdrawal is refused `already-decided` (nothing is forged over the
 *   decision), the hook still blocks, and the log carries no start;
 * - a signal held through the synchronous stdin read is dispatched at the pause
 *   before the first `execution.started` append, so an unattended call blocks
 *   rather than recording a start for a harness that already gave up;
 * - the wait's 240 s window and its poll cadence are untouched (a wait with no
 *   signal still runs to its own `hook-timeout`).
 *
 * The CLI route is what changed; the serve route's equivalent (a client that
 * disconnects mid-wait) is pinned in `tests/serve-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../../cli.js", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hermes-interrupt-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

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
  delete out["HERMES_HOME"];
  delete out["APPROVAL_HERMES_HOME"];
  return out;
}

/** A fresh directory with an attested policy and no log yet. */
function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
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

function event(dir: string, toolUseId: string, tool: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "pre_tool_call",
    session_id: "hermes-sess-interrupt",
    tool_use_id: toolUseId,
    cwd: dir,
    profile: "default",
    extra: {},
    ...tool,
  });
}

/** A manual-class call: it opens a question and waits on it. */
function manualCall(dir: string, toolUseId: string): string {
  return event(dir, toolUseId, {
    tool_name: "terminal",
    tool_input: { command: "npm install left-pad", workdir: dir },
  });
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
  dir: string,
  input: string,
  extra: string[],
  opts: { holdInput?: boolean } = {},
): Hook {
  const child = spawn(
    process.execPath,
    [entry, "hook", "hermes", "--as", "agent:hermes", "--harness-cap", "300s", ...extra],
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

/** The action key of the one question the hook opened, once it is on the log. */
async function requested(dir: string): Promise<string> {
  await until("the hook's request", () => records(dir).some((r) => r["event"] === "approval.requested"));
  const request = records(dir).find((r) => r["event"] === "approval.requested");
  return String(request?.["action_key"]);
}

function only(outcome: Outcome): Record<string, unknown> {
  const lines = outcome.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `expected exactly one object on stdout: ${JSON.stringify(outcome.stdout)}`);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "message"]);
  assert.equal(parsed["action"], "block");
  return parsed;
}

function starts(dir: string): Record<string, unknown>[] {
  return records(dir).filter((r) => r["event"] === "execution.started");
}

// ---------------------------------------------------------------------------
// The signal mid-wait: withdrawn, blocked, and a later grant is refused
// ---------------------------------------------------------------------------

for (const [label, entry] of [
  ["the bin", BIN],
  ["the bare entry", ENTRY],
] as const) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`through ${label}, ${signal} mid-wait withdraws the question, blocks at once, and a later grant starts nothing`, async () => {
      const dir = ready();
      // A wait far longer than the test, so only the signal can end it.
      const hook = launch(entry, dir, manualCall(dir, `tu-${signal}`), ["--timeout", "4m", "--interval", "200ms"]);
      const key = await requested(dir);
      hook.kill(signal);
      const outcome = await hook.done;

      assert.equal(outcome.signal, null, `died by ${String(outcome.signal)}: ${outcome.stderr}`);
      assert.equal(outcome.code, 2, outcome.stderr);
      // Within one poll interval and the withdrawal's own append, not at the
      // end of a four-minute wait. Generous for a loaded machine.
      assert.ok(outcome.ms < 15_000, `answered ${String(outcome.ms)} ms after the signal`);
      const parsed = only(outcome);
      assert.equal(
        parsed["message"],
        `hook-interrupted: the hook received ${signal} while waiting for a decision; nothing authorizes this call`,
      );

      const withdrawn = records(dir).filter((r) => r["event"] === "approval.withdrawn");
      assert.equal(withdrawn.length, 1, JSON.stringify(withdrawn));
      assert.equal(withdrawn[0]?.["action_key"], key);
      assert.equal(withdrawn[0]?.["actor"], "agent:hermes");

      // The human answers after Hermes gave up: the state machine refuses it.
      const late = cli(["grant", key, "--as", "human:alice", "--json"], dir);
      assert.notEqual(late.code, 0, `a grant on a withdrawn request was accepted: ${late.stdout}`);
      assert.match(`${late.stdout}${late.stderr}`, /request-withdrawn/u);
      assert.equal(records(dir).filter((r) => r["event"] === "approval.granted").length, 0);
      assert.deepEqual(starts(dir), []);
    });
  }
}

// ---------------------------------------------------------------------------
// The race: a grant that lands between two polls, then the signal
// ---------------------------------------------------------------------------

test("a grant that lands between two polls, then SIGTERM: blocked, nothing spent, and the withdrawal forges nothing over the decision", async () => {
  const dir = ready();
  // A poll interval far longer than the race, so the grant and the signal both
  // land inside one pause and the next poll never runs.
  const hook = launch(BIN, dir, manualCall(dir, "tu-race"), ["--timeout", "4m", "--interval", "60s"]);
  const key = await requested(dir);
  const grant = cli(["grant", key, "--as", "human:alice", "--json"], dir);
  assert.equal(grant.code, 0, grant.stderr);
  hook.kill("SIGTERM");
  const outcome = await hook.done;

  assert.equal(outcome.code, 2, outcome.stderr);
  assert.match(String(only(outcome)["message"]), /^hook-interrupted: the hook received SIGTERM while waiting/u);
  // The grant stands as the human gave it: the requester's withdrawal is
  // refused `already-decided`, so no withdrawn record is written over it.
  assert.equal(records(dir).filter((r) => r["event"] === "approval.withdrawn").length, 0);
  assert.equal(records(dir).filter((r) => r["event"] === "approval.granted").length, 1);
  // And it was not spent on a call Hermes abandoned.
  assert.deepEqual(starts(dir), []);
});

test("the race, twenty times: whichever of the grant and the signal lands first, no execution.started is ever recorded", async () => {
  const runs = Array.from({ length: 20 }, async (_, index) => {
    const dir = ready();
    const hook = launch(BIN, dir, manualCall(dir, `tu-race-${String(index)}`), [
      "--timeout",
      "4m",
      "--interval",
      "20ms",
    ]);
    const key = await requested(dir);
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
  for (const { dir, outcome } of await Promise.all(runs)) {
    if (outcome.stdout.trim() === "{}") {
      // The one legitimate allow: the hook read the grant and spent it BEFORE
      // the signal reached it, so the answer was on stdout first. The signal
      // then lands after the answer: on the bin's guard, which exits with it
      // (0), or during Node's own teardown, after the runtime has closed its
      // signal handles, which is a death by that signal with the answer
      // already written.
      assert.ok(
        outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"),
        `an allow that exited ${String(outcome.code)} (${String(outcome.signal)}): ${outcome.stderr}`,
      );
      assert.equal(starts(dir).length, 1);
      continue;
    }
    assert.equal(outcome.code, 2, `${outcome.stdout} ${outcome.stderr}`);
    only(outcome);
    assert.deepEqual(starts(dir), [], `a start after a block: ${outcome.stdout}`);
  }
});

// ---------------------------------------------------------------------------
// Held through the synchronous stretch: dispatched before the spend
// ---------------------------------------------------------------------------

test("a SIGTERM held through the stdin read is answered before an unattended call records its start", async () => {
  const dir = ready();
  const call = event(dir, "tu-held", {
    tool_name: "write_file",
    tool_input: { path: join(dir, "notes.txt"), content: "hello\n" },
  });

  // The control: unsignalled, this call is allowed and records one start.
  const control = launch(BIN, dir, call, []);
  const allowed = await control.done;
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "{}");
  assert.equal(starts(dir).length, 1, "the control recorded no start, so this test proves nothing");

  // The same call, with the signal landing while the hook blocks on stdin.
  const held = event(dir, "tu-held-2", {
    tool_name: "write_file",
    tool_input: { path: join(dir, "notes.txt"), content: "hello\n" },
  });
  const hook = launch(BIN, dir, held, [], { holdInput: true });
  // Long enough for the runtime to load on any machine this runs on; if the
  // load is still running the bin's own guard answers instead, with the same
  // directive and no record either.
  await delay(2_000);
  hook.kill("SIGTERM");
  await delay(200);
  hook.endInput();
  const outcome = await hook.done;
  assert.equal(outcome.code, 2, `${outcome.stdout} ${outcome.stderr}`);
  assert.match(String(only(outcome)["message"]), /^hook-interrupted: the hook received SIGTERM/u);
  assert.equal(starts(dir).length, 1, "the interrupted call recorded a start");
});

// ---------------------------------------------------------------------------
// The window is unchanged
// ---------------------------------------------------------------------------

test("with no signal the yielding wait still runs to its own timeout and leaves the question open", async () => {
  const dir = ready();
  const hook = launch(BIN, dir, manualCall(dir, "tu-quiet"), ["--timeout", "1500ms", "--interval", "100ms"]);
  const key = await requested(dir);
  const outcome = await hook.done;
  assert.equal(outcome.code, 2, outcome.stderr);
  assert.ok(outcome.ms >= 1_500, `the wait ended after ${String(outcome.ms)} ms, before its timeout`);
  assert.match(String(only(outcome)["message"]), /^hook-timeout: /u);
  // A timeout keeps the question for the retry grace, exactly as before.
  assert.equal(records(dir).filter((r) => r["event"] === "approval.withdrawn").length, 0);
  const late = cli(["grant", key, "--as", "human:alice"], dir);
  assert.equal(late.code, 0, late.stderr);
  assert.deepEqual(starts(dir), []);
});
