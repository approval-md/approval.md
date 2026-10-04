/**
 * What fsync-per-append costs (APRV-440), opt-in like every wall-clock number
 * in this repository (APRV-248).
 *
 * ```
 * npm run build && APPROVAL_BENCH=1 node --test dist/tests/append-fsync.bench.js
 * ```
 *
 * Kept out of `npm test` the same two ways `tests/telegram-tap-latency.bench.ts`
 * is: the runner discovers `*.test.js` only, and without `APPROVAL_BENCH=1`
 * every case fails fast instead of measuring. The structural claim (fsync after
 * the write, before ok) is asserted at any load in `tests/log-fsync.test.ts`;
 * what lives here is the magnitude, which is a fact about the disk.
 *
 * Two measurements, each taken twice on the same shape: once with Node's real
 * layer, and once with a layer whose fsync does nothing, so the difference is
 * the fsync and only the fsync.
 *
 *  1. One append, repeated: the per-record price every verb now pays.
 *  2. One daemon tick that appends: the drift scan finding `DRIFTING` task files
 *     whose declared state disagrees with the log, which is the tick shape that
 *     appends the most records through `appendEvent` in one pass.
 *
 * The numbers print as `# BENCH` lines. The budget each case asserts is the one
 * recorded in the APRV-440 notes; a breach is a REPORT to read against what else
 * the machine was doing, not a verdict.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { appendEvent, type EventInput } from "../src/core/log.js";
import { setAppendWriteLayerForTests, type AppendWriteLayer } from "../src/core/log-write-layer.js";
import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";
import { register } from "./clock-adapters.js";
import { assertClean, at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

function requireOptIn(): void {
  assert.equal(
    process.env["APPROVAL_BENCH"],
    "1",
    "this is a benchmark, not a test: it measures the disk as much as the code. Run it on purpose " +
      "with APPROVAL_BENCH=1, and read `tests/log-fsync.test.ts` for the load-proof ordering claim.",
  );
}

/** Real open, write and close; an fsync that returns at once. The control arm. */
const NO_FSYNC: AppendWriteLayer = {
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (fd, data) => writeSync(fd, data, 0, data.length),
  fsync: () => {},
  close: (fd) => {
    closeSync(fd);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
};

const scratch = scratchRoot("append-fsync-bench");

/**
 * Per-append fsync budget, median. A tap's acknowledgement pays exactly one
 * append, and APRV-206 bounds the whole ack at 300 ms on a 10k-record log; one
 * fsync may take a small slice of that and no more.
 */
const APPEND_FSYNC_BUDGET_MS = 25;
/**
 * Per-tick fsync budget for a tick that appends {@link DRIFTING} records. The
 * daemon ticks every 30 s by default and a tick costs tens of milliseconds; the
 * fsyncs of a heavy tick may add up to a second before batching them into one
 * sync per tick is worth what it gives up (each append's own ok meaning durable).
 */
const TICK_FSYNC_BUDGET_MS = 1_000;
const DRIFTING = 20;
const APPENDS = 200;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number;
}

function input(n: number): EventInput {
  return {
    ts: T0,
    event: "task.registered",
    actor: "agent:bench",
    task: `bench-${String(n)}`,
    channel: "cli",
    payload: { title: `bench ${String(n)}` },
  };
}

function appendTimings(layer: AppendWriteLayer | null): number[] {
  setAppendWriteLayerForTests(layer);
  try {
    const unit = newScenario(scratch.root);
    const timings: number[] = [];
    for (let n = 1; n <= APPENDS; n += 1) {
      const started = process.hrtime.bigint();
      const result = appendEvent(unit.logPath, input(n));
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.ok(result.ok, JSON.stringify(result));
    }
    return timings;
  } finally {
    setAppendWriteLayerForTests(null);
  }
}

test("BENCH: one append, with and without its fsync", () => {
  requireOptIn();
  // Warm the module graph and the schema compile out of the first arm's numbers.
  appendTimings(null);
  const withFsync = appendTimings(null);
  const without = appendTimings(NO_FSYNC);

  const cost = median(withFsync) - median(without);
  process.stdout.write(
    `# BENCH append: with fsync median ${median(withFsync).toFixed(3)} ms p95 ${p95(withFsync).toFixed(3)} ms; ` +
      `without median ${median(without).toFixed(3)} ms p95 ${p95(without).toFixed(3)} ms; ` +
      `fsync costs ${cost.toFixed(3)} ms per append (${process.platform}, n=${String(APPENDS)})\n`,
  );
  assert.ok(cost < APPEND_FSYNC_BUDGET_MS, `fsync costs ${cost.toFixed(3)} ms per append`);
});

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

/**
 * A home whose log registers {@link DRIFTING} tasks as `proposed` and whose
 * task files claim `approved`: each one is a drift record the next tick appends.
 */
function driftingHome(): { unit: Scenario; tasksDir: string } {
  const unit = newScenario(scratch.root);
  attest(unit, T0);
  const tasksDir = join(unit.dir, "backlog", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  for (let index = 0; index < DRIFTING; index += 1) {
    const task = `drift-${String(index)}`;
    const key = `${task}:draft`;
    const action = {
      class: "files.write.local",
      summary: "Write the draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: key,
      payload_hash: bindingFor(key),
    };
    const registered = register(
      unit.logPath,
      { task, envelope: { origin: { app: "harness", created_by: "agent:claude" }, state: "proposed", actions: [action] } },
      at(1),
      "agent:claude",
      unit.options,
    );
    assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
    writeFileSync(
      join(tasksDir, `${task}.md`),
      [
        "---",
        `id: ${task}`,
        `title: Drifting ${String(index)}`,
        "status: In Progress",
        "approval:",
        "  origin:",
        "    app: harness",
        '    created_by: "agent:claude"',
        "  state: approved",
        "  actions:",
        "    - class: files.write.local",
        '      summary: "Write the draft"',
        "      reversible: true",
        '      est_cost_usd: "0.01"',
        `      idempotency_key: "${key}"`,
        `      payload_hash: "${bindingFor(key)}"`,
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return { unit, tasksDir };
}

async function tickMs(layer: AppendWriteLayer | null): Promise<{ ms: number; drift: number }> {
  const { unit, tasksDir } = driftingHome();
  const emitted: DaemonEvent[] = [];
  setAppendWriteLayerForTests(layer);
  let wall: number;
  try {
    const daemon = new Daemon({
      logPath: unit.logPath,
      tasksDir,
      queuePath: join(unit.dir, ".approval", "QUEUE.md"),
      policy: { file: unit.policyPath },
      cwd: unit.dir,
      intervalMs: 60_000,
      debounceMs: 10,
      once: true,
      clock: fixedClock(at(10)),
      sink: { emit: (event) => emitted.push(event) },
    });
    const started = process.hrtime.bigint();
    const outcome = await daemon.run();
    wall = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
  } finally {
    setAppendWriteLayerForTests(null);
  }
  const line = emitted.find((event) => event.event === "tick");
  assert.ok(line !== undefined && line.event === "tick", "the tick emitted no tick line");
  assertClean(unit);
  return { ms: wall, drift: line.drift };
}

test("BENCH: a daemon tick that appends, with and without fsync", async () => {
  requireOptIn();
  await tickMs(null); // warm-up
  const withRuns: number[] = [];
  const withoutRuns: number[] = [];
  let drift = 0;
  for (let run = 0; run < 3; run += 1) {
    const w = await tickMs(null);
    const wo = await tickMs(NO_FSYNC);
    withRuns.push(w.ms);
    withoutRuns.push(wo.ms);
    drift = w.drift;
    assert.equal(w.drift, wo.drift, "both arms must append the same records");
  }
  assert.ok(drift >= DRIFTING, `the tick appended ${String(drift)} drift record(s), expected ${String(DRIFTING)}`);
  const cost = median(withRuns) - median(withoutRuns);
  process.stdout.write(
    `# BENCH tick: ${String(drift)} appends; with fsync median ${median(withRuns).toFixed(1)} ms; ` +
      `without ${median(withoutRuns).toFixed(1)} ms; fsync adds ${cost.toFixed(1)} ms per tick ` +
      `(${(cost / drift).toFixed(2)} ms per append, ${process.platform})\n`,
  );
  assert.ok(cost < TICK_FSYNC_BUDGET_MS, `fsync adds ${cost.toFixed(1)} ms to a ${String(drift)}-append tick`);
});
