/**
 * What one daemon tick costs (APRV-211), asserted structurally.
 *
 * The incident this suite exists for: a tick against a ten-thousand-record log
 * pinned a core for three seconds, because the drift scan performed one verified
 * read PER TASK FILE (210 of them), each of which re-hashed a 6.8 MB file and
 * re-derived every anomaly. Nothing about that is visible in a wall-clock
 * assertion on a loaded CI machine, so the claim under test here is the
 * structural one:
 *
 *   **the number of verified reads a tick makes does not depend on how many task
 *   files there are.**
 *
 * A timing assertion is present too, deliberately generous (5 s for a tick that
 * should cost tens of milliseconds), as a smoke alarm rather than a benchmark: it
 * fires for a regression of the ORDER this incident was, and for nothing else.
 *
 * The second claim is that the daemon does not wake itself: a clean read of an
 * unchanged log republishes no verified-head snapshot, so the file the daemon
 * watches does not change because the daemon looked at it.
 *
 * The log is built through the real append path and walked at the end, like
 * every other suite here. The daemon runs in process with `once: true` and a
 * fixed clock, the pattern `tests/prune.test.ts` uses: what is being observed is
 * a counter on the tick line, and a spawned CLI would report the same number
 * more slowly. `tests/daemon.test.ts` owns the live-process questions.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { readSnapshot, snapshotPathFor } from "../src/core/verified-snapshot.js";
import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";
import { register, startExecution } from "./clock-adapters.js";
import {
  assertClean,
  at,
  attest,
  fixedClock,
  newScenario,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const scratch = scratchRoot("daemon-tick-cost");

after(() => {
  scratch.cleanup();
});

/** Records in the fixture log. Big enough to be a real read, small enough to build. */
const TASKS = 100;
const ACTIONS_PER_TASK = 20;
/** One action per task is left unexecuted, so a later case has something to append. */
const EXECUTED_PER_TASK = ACTIONS_PER_TASK - 1;
/** Task files with frontmatter and no `approval:` envelope: the hot path. */
const ENVELOPE_LESS = 200;

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

function classFor(index: number): string {
  return index % 4 === 3 ? "files.write.local" : "read.inbox";
}

interface Fixture {
  unit: Scenario;
  tasksDir: string;
  /** An action key the log declares and has never executed. */
  unexecuted: string;
}

let built: Fixture | null = null;

/**
 * ~2,000 records through the real append path, plus a task folder shaped like
 * this repository's: a couple of hundred plain Backlog.md files and a few
 * carrying an envelope that agrees with the log.
 */
function fixture(): Fixture {
  if (built !== null) return built;

  const unit = newScenario(scratch.root);
  attest(unit, T0);
  const tasksDir = join(unit.dir, "backlog", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  for (let index = 0; index < TASKS; index += 1) {
    const task = `bulk-${String(index).padStart(3, "0")}`;
    const actions = [];
    for (let action = 0; action < ACTIONS_PER_TASK; action += 1) {
      const key = `${task}:${String(action)}`;
      actions.push({
        class: classFor(action),
        summary: `step ${String(action)}`,
        reversible: true,
        est_cost_usd: "0",
        idempotency_key: key,
        payload_hash: bindingFor(key),
      });
    }
    const registered = register(
      unit.logPath,
      {
        task,
        envelope: {
          origin: { app: "harness", created_by: "agent:claude" },
          state: "proposed",
          actions,
        },
      },
      at(1),
      "agent:claude",
      unit.options,
    );
    assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

    for (let action = 0; action < EXECUTED_PER_TASK; action += 1) {
      const key = `${task}:${String(action)}`;
      const started = startExecution(
        unit.logPath,
        key,
        { ...unit.options, presentedPayloadHash: bindingFor(key) },
        at(2),
        "agent:claude",
      );
      assert.equal(started.ok, true, started.ok ? "" : started.message);
    }
  }

  // Three tasks that DO carry an envelope, registered and never acted on, so the
  // log implies `proposed` and their files say `proposed`: the scan reads a claim
  // out of each and finds no drift, which is the state a healthy repo is in.
  const envelopeTasks: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const task = `enveloped-${String(index)}`;
    envelopeTasks.push(task);
    const key = `${task}:draft`;
    const envelope = {
      origin: { app: "harness", created_by: "agent:claude" },
      state: "proposed",
      actions: [
        {
          class: "files.write.local",
          summary: "Write the draft",
          reversible: true,
          est_cost_usd: "0.01",
          idempotency_key: key,
          payload_hash: bindingFor(key),
        },
      ],
    };
    const registered = register(
      unit.logPath,
      { task, envelope },
      at(3),
      "agent:claude",
      unit.options,
    );
    assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
    writeFileSync(
      join(tasksDir, `${task}.md`),
      [
        "---",
        `id: ${task}`,
        `title: Enveloped ${String(index)}`,
        "status: In Progress",
        "approval:",
        "  origin:",
        "    app: harness",
        '    created_by: "agent:claude"',
        "  state: proposed",
        "  actions:",
        "    - class: files.write.local",
        '      summary: "Write the draft"',
        "      reversible: true",
        '      est_cost_usd: "0.01"',
        `      idempotency_key: "${key}"`,
        `      payload_hash: "${bindingFor(key)}"`,
        "---",
        "",
        "## Description",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  writeEnvelopeLess(tasksDir, ENVELOPE_LESS);

  built = { unit, tasksDir, unexecuted: `bulk-000:${String(ACTIONS_PER_TASK - 1)}` };
  return built;
}

/** Plain Backlog.md task files: frontmatter with an id, no `approval:` key. */
function writeEnvelopeLess(tasksDir: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = `APRV-${String(index + 1)}`;
    writeFileSync(
      join(tasksDir, `${id.toLowerCase()} - Task-${String(index + 1)}.md`),
      ["---", `id: ${id}`, `title: Task ${String(index + 1)}`, "status: Done", "---", "", "Filler.", ""].join(
        "\n",
      ),
      "utf8",
    );
  }
}

function removeEnvelopeLess(tasksDir: string, from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    const id = `APRV-${String(index + 1)}`;
    rmSync(join(tasksDir, `${id.toLowerCase()} - Task-${String(index + 1)}.md`), { force: true });
  }
}

/** One in-process tick, at a fixed instant. Returns everything it emitted. */
async function tick(unit: Scenario, tasksDir: string, minutes: number): Promise<DaemonEvent[]> {
  const emitted: DaemonEvent[] = [];
  const daemon = new Daemon({
    logPath: unit.logPath,
    tasksDir,
    queuePath: join(unit.dir, ".approval", "QUEUE.md"),
    policy: { file: unit.policyPath },
    cwd: unit.dir,
    intervalMs: 60_000,
    debounceMs: 10,
    once: true,
    clock: fixedClock(at(minutes)),
    sink: { emit: (event) => emitted.push(event) },
  });
  const outcome = await daemon.run();
  assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
  return emitted;
}

function tickLine(emitted: DaemonEvent[]): Extract<DaemonEvent, { event: "tick" }> {
  const line = emitted.find((event) => event.event === "tick");
  assert.ok(line !== undefined && line.event === "tick", "the tick emitted no tick line");
  return line;
}

function warnings(emitted: DaemonEvent[]): string[] {
  return emitted.filter((event) => event.event === "warning").map((event) => event.code);
}

/** The snapshot file's identity: a temp-and-rename publish always changes it. */
function snapshotIdentity(unit: Scenario): string {
  const stats = statSync(snapshotPathFor(unit.logPath));
  return `${String(stats.ino)}:${String(stats.mtimeMs)}`;
}

// ===========================================================================

test("a tick's verified reads do not grow with the task folder", async () => {
  const { unit, tasksDir } = fixture();
  assert.ok(records(unit).length > 1_500, "the fixture log must be a real read");

  const many = tickLine(await tick(unit, tasksDir, 10));
  assert.deepEqual(warnings(await tick(unit, tasksDir, 10)), [], "the fixture must tick cleanly");
  assert.equal(many.drift, 0, "a folder that agrees with the log drifts nothing");

  // The same log, an order of magnitude fewer files.
  removeEnvelopeLess(tasksDir, 20, ENVELOPE_LESS);
  const few = tickLine(await tick(unit, tasksDir, 10));

  assert.equal(
    many.reads,
    few.reads,
    `${String(ENVELOPE_LESS + 3)} task files cost ${String(many.reads)} verified reads and 23 cost ${String(
      few.reads,
    )}; the drift scan is reading the log per file again`,
  );
  assert.ok(
    many.reads <= 12,
    `a tick made ${String(many.reads)} verified reads; the loop reads a bounded handful by design`,
  );

  // A generous smoke budget. Not a benchmark: the structural assertion above is
  // the real one, and this fires only for a regression of the order APRV-211 was
  // (2.9 s per tick), which no amount of machine load explains.
  assert.ok(
    many.ms < 5_000,
    `one tick took ${String(many.ms)} ms over ${String(records(unit).length)} records`,
  );

  // The phase breakdown is on the line, and it adds up to something no larger
  // than the tick it describes.
  const phases = Object.values(many.phases).reduce((sum, value) => sum + value, 0);
  assert.ok(phases <= many.ms + 1, `phases (${String(phases)} ms) exceed the tick (${String(many.ms)} ms)`);

  assertClean(unit);
});

test("an unchanged log republishes no snapshot, and a real append does", async () => {
  const { unit, tasksDir, unexecuted } = fixture();

  await tick(unit, tasksDir, 11);
  const snapshotPath = snapshotPathFor(unit.logPath);
  const before = snapshotIdentity(unit);
  const headBefore = tickLine(await tick(unit, tasksDir, 11)).head;

  // Nothing appended between the two ticks, so nothing about the endorsement
  // changed — and the file the daemon WATCHES must therefore not have moved. A
  // publish here is the daemon scheduling its own next tick (APRV-211).
  assert.equal(snapshotIdentity(unit), before, `${snapshotPath} was rewritten by an idle tick`);

  // One real append through the real path, and the next tick endorses it.
  const started = startExecution(
    unit.logPath,
    unexecuted,
    { ...unit.options, presentedPayloadHash: bindingFor(unexecuted) },
    at(11),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);

  const after_ = tickLine(await tick(unit, tasksDir, 12));
  assert.notEqual(snapshotIdentity(unit), before, "an appended log must be endorsed again");
  assert.notEqual(after_.head, headBefore, "the head moved");

  const snapshot = readSnapshot(unit.logPath);
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(
    (snapshot as { ok: true; snapshot: { head: { seq: number } } }).snapshot.head.seq,
    after_.head,
    "the snapshot endorses the head the tick reported",
  );

  assertClean(unit);
});
