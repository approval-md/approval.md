/**
 * The `approval` bin's own signal guard for the Hermes hook (APRV-466).
 *
 * Hermes reads a hook that exits non-zero with an EMPTY stdout as an ALLOW, and
 * it sends SIGTERM on its hook timeout and on gateway shutdown. The runtime's
 * guard (`hermesFailClosed`, APRV-445) exists only once dist/ has loaded, and
 * on the CLI it never gets a turn anyway (the hook run is synchronous, and a JS
 * listener runs only when the event loop turns), so the bin installs one first.
 * These tests pin:
 *
 * - a signal dispatched while the runtime is still loading answers with the
 *   runtime's own `hook-interrupted` directive, byte for byte, at exit 2, every
 *   time across twenty concurrent children (the regression test: without the
 *   bin's guard each of these dies by signal with an empty stdout);
 * - while a runtime raises HERMES_SIGNAL_OWNER, the bin steps aside and only the
 *   runtime's answer is printed;
 * - a signal held through the synchronous hook run ends with the run's own
 *   single verdict at exit 2;
 * - every other verb, and every other harness hook, keeps the default
 *   disposition;
 * - a smoke run of signals at arbitrary instants from spawn on never ends in a
 *   numeric exit without a block. It cannot tell a death in Node's bootstrap
 *   from a death the bin should have prevented, so it is a smoke test and the
 *   held-runtime test is the pin.
 *
 * The module-load window is held open by construction rather than by timing:
 * a copy of the real `cli.js` sits beside a stand-in `dist/src/cli/main.js`
 * whose evaluation writes a marker to fd 2 and then awaits (top-level await), so
 * the bin's `import()` of the runtime is still pending, with the event loop
 * free, when the signal lands. Whether a real cold load turns the loop depends
 * on the Node release (about thirty turns on Node 24, none on Node 26); where it
 * does not, the signal is held into the run and the last test's path applies.
 * A `--import` resolve hook cannot hold the load open: on current Node the main
 * thread waits on the hooks thread synchronously, so a signal sent while a
 * resolve is held is not dispatched until the resolve returns.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { HERMES_SIGNAL_OWNER, hermesInterruptedDirective } from "../src/cli/hook.js";

const BIN = fileURLToPath(new URL("../../cli.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-bin-signal-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

const HELD = "aprv-466: runtime still loading\n";

/**
 * The real bin beside a runtime that never finishes loading: its evaluation
 * says so on fd 2 and then waits, the way a cold dist/ load is still in
 * progress. The timer also keeps the loop alive, so the pending top-level await
 * is not settled early as an unfinished one (exit 13).
 */
const HELD_BIN = ((): string => {
  const root = join(scratch, "held-runtime");
  mkdirSync(join(root, "dist", "src", "cli"), { recursive: true });
  copyFileSync(BIN, join(root, "cli.js"));
  writeFileSync(
    join(root, "dist", "src", "cli", "main.js"),
    [
      'import { writeSync } from "node:fs";',
      `writeSync(2, ${JSON.stringify(HELD)});`,
      "await new Promise((settle) => setTimeout(settle, 30_000));",
      "export async function main() {",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return join(root, "cli.js");
})();

/**
 * The real bin beside a stand-in runtime that does what `hermesFailClosed` does
 * when it can: raises the owner flag under the runtime's own registry key,
 * listens, and answers with its own directive. The bin must step aside.
 */
const OWNING_BIN = ((): string => {
  const root = join(scratch, "owning-runtime");
  mkdirSync(join(root, "dist", "src", "cli"), { recursive: true });
  copyFileSync(BIN, join(root, "cli.js"));
  const key = HERMES_SIGNAL_OWNER.description ?? "";
  writeFileSync(
    join(root, "dist", "src", "cli", "main.js"),
    [
      'import { writeSync } from "node:fs";',
      `globalThis[Symbol.for(${JSON.stringify(key)})] = true;`,
      "const answer = (signal) => {",
      '  writeSync(1, `${JSON.stringify({ action: "block", message: `runtime: ${signal}` })}\\n`);',
      "  process.exit(2);",
      "};",
      'process.on("SIGTERM", answer);',
      'process.on("SIGINT", answer);',
      `writeSync(2, ${JSON.stringify(HELD)});`,
      "await new Promise((settle) => setTimeout(settle, 30_000));",
      "export async function main() {",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return join(root, "cli.js");
})();

function env(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  delete out["APPROVAL_HUMAN"];
  delete out["HERMES_HOME"];
  delete out["APPROVAL_HERMES_HOME"];
  return out;
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Child {
  /** Resolves when `text` first appears on the child's stderr. */
  saw: (text: string) => Promise<void>;
  kill: (signal: NodeJS.Signals) => void;
  done: Promise<Outcome>;
}

function launch(args: string[], cwd: string, opts: { bin?: string; input?: string } = {}): Child {
  const child = spawn(process.execPath, [opts.bin ?? BIN, ...args], { cwd, env: env() });
  let stdout = "";
  let stderr = "";
  const waiters: Array<{ text: string; settle: () => void }> = [];
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    for (const waiter of waiters.splice(0)) {
      if (stderr.includes(waiter.text)) waiter.settle();
      else waiters.push(waiter);
    }
  });
  // EPIPE on a child that died before reading is part of what is under test.
  child.stdin.on("error", () => undefined);
  child.stdin.end(opts.input ?? "{}");
  // A child that is never signalled must not hang the suite.
  const backstop = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const done = new Promise<Outcome>((settle) => {
    child.on("close", (code, signal) => {
      clearTimeout(backstop);
      settle({ code, signal, stdout, stderr });
    });
  });
  return {
    saw: (text) =>
      new Promise((settle) => {
        if (stderr.includes(text)) settle();
        else waiters.push({ text, settle });
      }),
    kill: (signal) => child.kill(signal),
    done,
  };
}

const delay = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

// ---------------------------------------------------------------------------
// Inside module load
// ---------------------------------------------------------------------------

test("a signal while the runtime is loading answers with the runtime's own directive at exit 2, twenty times at once", async () => {
  const dir = caseDir();
  const runs = Array.from({ length: 20 }, async (_, index) => {
    const signal: NodeJS.Signals = index % 2 === 0 ? "SIGTERM" : "SIGINT";
    const child = launch(["hook", "hermes", "--as", "agent:hermes"], dir, { bin: HELD_BIN });
    await child.saw(HELD);
    child.kill(signal);
    return { signal, outcome: await child.done };
  });
  for (const { signal, outcome } of await Promise.all(runs)) {
    assert.equal(outcome.signal, null, `died by ${String(outcome.signal)}: ${outcome.stderr}`);
    assert.equal(outcome.code, 2, outcome.stderr);
    // Byte-identical to the runtime's guard, and exactly one object.
    assert.equal(outcome.stdout, hermesInterruptedDirective(signal));
  }
});

test("the bin's directive is the runtime's: the same two keys, the hook-interrupted code, the signal named", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const parsed = JSON.parse(hermesInterruptedDirective(signal)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["action", "message"]);
    assert.equal(parsed["action"], "block");
    assert.equal(
      parsed["message"],
      `hook-interrupted: the hook received ${signal} before it reached a verdict; nothing authorizes this call`,
    );
  }
  // The bin spells the bytes by hand (it runs before this module can load);
  // the spawned comparison above is the pin, this is the reader's map to it.
  const bin = readFileSync(BIN, "utf8");
  assert.ok(
    bin.includes(
      "hook-interrupted: the hook received ${signal} before it reached a verdict; nothing authorizes this call",
    ),
    "cli.js no longer spells the runtime's hook-interrupted message",
  );
  // And it steps aside under the runtime's own registry key.
  assert.ok(
    bin.includes(`Symbol.for(${JSON.stringify(HERMES_SIGNAL_OWNER.description)})`),
    "cli.js no longer reads the runtime's HERMES_SIGNAL_OWNER key",
  );
});

// ---------------------------------------------------------------------------
// The handover
// ---------------------------------------------------------------------------

test("while the runtime owns the signal, the bin steps aside and only the runtime's answer is printed", async () => {
  const dir = caseDir();
  const runs = Array.from({ length: 6 }, async (_, index) => {
    const signal: NodeJS.Signals = index % 2 === 0 ? "SIGTERM" : "SIGINT";
    const child = launch(["hook", "hermes", "--as", "agent:hermes"], dir, { bin: OWNING_BIN });
    await child.saw(HELD);
    child.kill(signal);
    return { signal, outcome: await child.done };
  });
  for (const { signal, outcome } of await Promise.all(runs)) {
    assert.equal(outcome.code, 2, outcome.stderr);
    assert.equal(outcome.stdout, `${JSON.stringify({ action: "block", message: `runtime: ${signal}` })}\n`);
  }
});

// ---------------------------------------------------------------------------
// At an arbitrary instant (smoke)
// ---------------------------------------------------------------------------

test("smoke: a signal at an arbitrary instant from spawn on never ends in a numeric exit without one block", async (t) => {
  const dir = caseDir();
  // Spread across Node's bootstrap, the runtime's load, and the run itself.
  const runs = Array.from({ length: 20 }, async (_, index) => {
    const child = launch(["hook", "hermes", "--as", "agent:hermes"], dir);
    await delay(index * 5);
    child.kill(index % 2 === 0 ? "SIGTERM" : "SIGINT");
    return child.done;
  });
  let bootstrap = 0;
  for (const outcome of await Promise.all(runs)) {
    if (outcome.code === null) {
      // Expected only in Node's own bootstrap, before the bin's first
      // statement. This test cannot tell that apart from a regression of the
      // bin's guard; the held-runtime test above is what pins the guard.
      bootstrap += 1;
      assert.notEqual(outcome.signal, null);
      assert.equal(outcome.stdout, "", "a death by signal after something was printed");
      continue;
    }
    assert.equal(outcome.code, 2, `exit ${String(outcome.code)}: ${outcome.stdout} ${outcome.stderr}`);
    const lines = outcome.stdout.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1, `expected exactly one object: ${outcome.stdout}`);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ["action", "message"]);
    assert.equal(parsed["action"], "block");
  }
  t.diagnostic(`${String(bootstrap)} of 20 signals ended in a death by signal (Node's bootstrap)`);
});

// ---------------------------------------------------------------------------
// Held through the synchronous run
// ---------------------------------------------------------------------------

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
  "```",
  "",
].join("\n");

function logRecords(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The hook's wait is a synchronous `Atomics.wait` poll, so a SIGTERM sent once
 * the request is logged is caught and held: no JS listener runs until the run
 * returns. What then answers is the run's own verdict (here the 3 s
 * `hook-timeout`), and the bin's guard, dispatched last, exits with it rather
 * than printing a second object.
 */
test("through the bin, a SIGTERM held through the wait ends with the run's own single verdict at exit 2", async () => {
  const dir = caseDir();
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attest = launch(["policy", "attest", "--as", "human:alice"], dir, { input: "" });
  const attested = await attest.done;
  assert.equal(attested.code, 0, attested.stderr);

  const child = launch(
    ["hook", "hermes", "--as", "agent:hermes", "--harness-cap", "300s", "--timeout", "3s", "--interval", "50ms"],
    dir,
    {
      input: JSON.stringify({
        hook_event_name: "pre_tool_call",
        session_id: "hermes-sess-bin-guard",
        tool_use_id: "tool-bin-guard",
        cwd: dir,
        profile: "default",
        extra: {},
        tool_name: "terminal",
        tool_input: { command: "npm install left-pad", workdir: dir },
      }),
    },
  );
  const deadline = Date.now() + 30_000;
  while (!logRecords(dir).some((record) => record["event"] === "approval.requested")) {
    assert.ok(Date.now() < deadline, "the hook never requested");
    await delay(50);
  }
  child.kill("SIGTERM");
  const outcome = await child.done;
  assert.equal(outcome.code, 2, outcome.stderr);
  const lines = outcome.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `the bin and the runtime both printed: ${outcome.stdout}`);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "message"]);
  assert.equal(parsed["action"], "block");
  assert.match(String(parsed["message"]), /^hook-(interrupted|timeout): /u);
});

// ---------------------------------------------------------------------------
// Everything else is untouched
// ---------------------------------------------------------------------------

test("any other verb, and any other harness hook, keeps the default disposition while the runtime loads", async () => {
  const dir = caseDir();
  for (const args of [
    ["--version"],
    ["status"],
    ["hook", "claude-code"],
    ["hook", "cursor"],
    ["hook", "codex"],
    ["hook", "grok"],
    ["hook", "muse"],
  ]) {
    const child = launch(args, dir, { bin: HELD_BIN });
    await child.saw(HELD);
    child.kill("SIGTERM");
    const outcome = await child.done;
    assert.equal(outcome.code, null, `${args.join(" ")}: exit ${String(outcome.code)} ${outcome.stdout}`);
    assert.equal(outcome.signal, "SIGTERM", args.join(" "));
    assert.equal(outcome.stdout, "", args.join(" "));
  }
});
