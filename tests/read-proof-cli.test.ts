/**
 * The operator surface of the incremental prefix proof (APRV-217).
 *
 * The proof a daemon runs is configuration, and configuration nobody can see is
 * the failure mode this project exists to prevent. Four surfaces carry it, and
 * each is asserted here against the real code path rather than a description of
 * it: the `started` line names the mode in force, the `tick` line names the
 * path the tick's reads actually took, `--read-proof` beats the policy (and a
 * typo is refused before the first tick), and `approval doctor` has a row that
 * reads the policy and never a running process's memory.
 *
 * The daemon runs in process with `once: true`, the pattern
 * `tests/daemon-tick-cost.test.ts` uses: what is being observed is a field on a
 * line, and a spawned CLI would report the same field more slowly. The doctor
 * row is the exception — it is a spawned CLI, because the row's own JSON shape
 * is what an operator's tooling reads.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { commandDaemonRun } from "../src/cli/daemon.js";
import { appendEvent } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { processReadCache, useReadProof } from "../src/core/state.js";
import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = scratchRoot("read-proof-cli");

after(() => {
  // `commandDaemonRun` sets the process-wide default, exactly as it does for an
  // operator; this file is a process too, so it puts it back.
  useReadProof(null);
  scratch.cleanup();
});

/** A policy with a `daemon` block, on the fixture policy every suite uses. */
function policyWith(block: string[]): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    ...block,
    "```",
    "",
  ].join("\n");
}

function ready(policyText?: string): Scenario {
  const unit = policyText === undefined ? newScenario(scratch.root) : newScenario(scratch.root, policyText);
  attest(unit, T0);
  mkdirSync(join(unit.dir, "backlog", "tasks"), { recursive: true });
  return unit;
}

/** One in-process tick, with `readProof` exactly as the CLI would set it. */
async function tick(
  unit: Scenario,
  readProof?: { mode: "full" | "incremental"; everyReads: number; afterMs: number },
): Promise<DaemonEvent[]> {
  const emitted: DaemonEvent[] = [];
  const daemon = new Daemon({
    logPath: unit.logPath,
    tasksDir: join(unit.dir, "backlog", "tasks"),
    queuePath: join(unit.dir, ".approval", "QUEUE.md"),
    policy: { file: unit.policyPath },
    cwd: unit.dir,
    intervalMs: 60_000,
    debounceMs: 10,
    once: true,
    clock: fixedClock(at(1)),
    ...(readProof === undefined ? {} : { readProof }),
    sink: { emit: (event) => emitted.push(event) },
  });
  const outcome = await daemon.run();
  assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
  return emitted;
}

function lineOf<K extends DaemonEvent["event"]>(
  emitted: DaemonEvent[],
  event: K,
): Extract<DaemonEvent, { event: K }> {
  const found = emitted.find((entry) => entry.event === event);
  assert.ok(found !== undefined, `no ${event} line was emitted`);
  return found as Extract<DaemonEvent, { event: K }>;
}

// ===========================================================================

test("the started line names the proof in force, and defaults to full", async () => {
  const unit = ready();
  assert.equal(lineOf(await tick(unit), "started").read_proof, "full");
  assert.equal(
    lineOf(await tick(unit, { mode: "incremental", everyReads: 50, afterMs: 60_000 }), "started")
      .read_proof,
    "incremental",
  );
});

test("the tick line reports the path its reads took, not the mode configured", async () => {
  const unit = ready();

  // Under `full` every tick is a full tick, which is the honest report.
  assert.equal(lineOf(await tick(unit), "tick").reproof, "full");

  // Under `incremental`: the first tick of this process cold-walks (nothing is
  // cached yet) and says so; a later tick over an unchanged log is served from
  // the carried hash state.
  processReadCache.clear();
  const proof = { mode: "incremental" as const, everyReads: 10_000, afterMs: 3_600_000 };
  assert.equal(lineOf(await tick(unit, proof), "tick").reproof, "full", "the first tick is cold");
  assert.equal(lineOf(await tick(unit, proof), "tick").reproof, "incremental");

  // An append by another writer moves the head; the tail is walked and the
  // prefix is still carried, so the tick stays incremental.
  const appended = appendEvent(unit.logPath, {
    ts: at(2),
    event: "task.registered",
    actor: "agent:planner",
    task: "read-proof-tick",
    payload: { title: "a record from elsewhere" },
  });
  assert.ok(appended.ok, "the fixture append must succeed");
  // …except that this process made the append itself, and `core/log.ts` marks
  // the log for a full re-proof when it does (APRV-217, the writer that matters
  // most). The next tick after our own write is therefore a full one.
  assert.equal(lineOf(await tick(unit, proof), "tick").reproof, "full");
  assert.equal(lineOf(await tick(unit, proof), "tick").reproof, "incremental");
  processReadCache.clear();
});

test("--read-proof beats the policy, and the started line says so", async () => {
  const unit = ready(policyWith(["daemon:", "  read_proof: full"]));
  const out: string[] = [];
  const streams = { out: (text: string) => out.push(text), err: () => undefined };

  const code = await commandDaemonRun(
    ["--once", "--json", "--dir", unit.dir, "--log", unit.logPath, "--read-proof", "incremental"],
    streams,
    unit.dir,
  );
  assert.equal(code, 0, out.join(""));
  const started = JSON.parse(out.join("").split("\n")[0] ?? "{}") as Record<string, unknown>;
  assert.equal(started["event"], "started");
  assert.equal(started["read_proof"], "incremental", "the flag wins over the policy");
});

test("the policy governs when no flag is typed", async () => {
  const unit = ready(
    policyWith(["daemon:", "  read_proof: incremental", "  full_reproof_every: 10"]),
  );
  const out: string[] = [];
  const code = await commandDaemonRun(
    ["--once", "--json", "--dir", unit.dir, "--log", unit.logPath],
    { out: (text: string) => out.push(text), err: () => undefined },
    unit.dir,
  );
  assert.equal(code, 0, out.join(""));
  const started = JSON.parse(out.join("").split("\n")[0] ?? "{}") as Record<string, unknown>;
  assert.equal(started["read_proof"], "incremental");
});

test("a misspelt --read-proof is a usage error before the first tick", async () => {
  const unit = ready();
  const err: string[] = [];

  const code = await commandDaemonRun(
    ["--once", "--json", "--dir", unit.dir, "--log", unit.logPath, "--read-proof", "incrementel"],
    { out: () => undefined, err: (text: string) => err.push(text) },
    unit.dir,
  );
  assert.equal(code, 2, "the frozen usage exit code");
  assert.match(err.join(""), /--read-proof expects full or incremental/u);

  const badCount = await commandDaemonRun(
    ["--once", "--json", "--dir", unit.dir, "--log", unit.logPath, "--full-reproof-every", "0"],
    { out: () => undefined, err: (text: string) => err.push(text) },
    unit.dir,
  );
  assert.equal(badCount, 2);
  assert.match(err.join(""), /--full-reproof-every expects a positive whole number/u);

  const badDuration = await commandDaemonRun(
    ["--once", "--json", "--dir", unit.dir, "--log", unit.logPath, "--full-reproof-after", "soon"],
    { out: () => undefined, err: (text: string) => err.push(text) },
    unit.dir,
  );
  assert.equal(badDuration, 2);
  assert.match(err.join(""), /--full-reproof-after expects a duration/u);
});

test("doctor's read-proof row names the configured mode, and skips when nothing is declared", () => {
  const declared = ready(
    policyWith(["daemon:", "  read_proof: incremental", '  full_reproof_after: "45s"']),
  );
  const silent = ready();

  const rowOf = (unit: Scenario): { status: string; detail: string } => {
    const run = spawnSync(process.execPath, [CLI_ENTRY, "doctor", "--json", "--dir", unit.dir], {
      cwd: unit.dir,
      encoding: "utf8",
      env: { ...process.env, APPROVAL_TG_TOKEN: undefined, APPROVAL_TG_CHAT: undefined },
    });
    const report = JSON.parse(run.stdout) as {
      checks: Array<{ check: string; status: string; detail: string }>;
    };
    const row = report.checks.find((check) => check.check === "read-proof");
    assert.ok(row !== undefined, `doctor printed no read-proof row: ${run.stdout}`);
    return { status: row.status, detail: row.detail };
  };

  const shown = rowOf(declared);
  assert.equal(shown.status, "pass");
  assert.match(shown.detail, /daemon\.read_proof: incremental/u);
  assert.match(shown.detail, /45000 ms/u, "the resolved duration, parsed once by the loader");

  const skipped = rowOf(silent);
  assert.equal(skipped.status, "skip", "a policy with no daemon block declares no mode");
  assert.match(skipped.detail, /read_proof: full/u);
});

test("a policy carrying a daemon block still loads, and still governs its classes", () => {
  // A guard on the fixture itself: a `daemon` block that failed schema
  // validation would take every class to `manual` and pass the rows above by
  // accident.
  const unit = ready(policyWith(["daemon:", "  read_proof: incremental"]));
  const loaded = loadPolicy({ file: unit.policyPath });
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.message);
  if (!loaded.ok) throw new Error("unreachable");
  assert.equal(loaded.daemon.readProof, "incremental");
  assert.deepEqual(loaded.policy.classes?.["read.*"], { autonomy: "autonomous" });
});
