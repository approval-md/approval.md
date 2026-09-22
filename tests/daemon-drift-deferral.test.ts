/**
 * The drift scan under contention (APRV-403).
 *
 * Found while landing APRV-381: the end-to-end daemon case that holds the append
 * lockfile for a whole tick printed
 *
 *   append-refused  envelope.drift for task-042 was not appended (lock-timeout)
 *
 * which is true and reads as a lost record. Nothing was lost — the scan
 * re-derives the disagreement from the verified log every tick and the next one
 * appended it — and an operator reading a daemon window had no way to know that.
 *
 * So the drift scan takes the split APRV-381 made for the audit sweep, from the
 * SAME closed list of transient codes: `lock-timeout` and `head-moved` are said
 * as deferrals naming the task and promising the retry, the retry names itself,
 * and every other append refusal keeps the form it had.
 *
 * The contention here is real. The lockfile every writer in this repository
 * contends for is held by this test process while the tick runs, so the refusal
 * comes from `core/log.ts`'s own acquisition rather than from a stub. The
 * non-transient case uses a copy of `schema/` with `envelope.drift` struck from
 * the event enum, so the refusal comes from the real write boundary.
 *
 * Runs the daemon IN PROCESS, as `tests/daemon-tick-cost.test.ts` and
 * `tests/prune.test.ts` do: the retry marker is a statement about one run's own
 * output, so a spawned `--once` child (a fresh process every time) could not
 * exhibit it at all. `tests/daemon.test.ts` owns the live-process questions and
 * carries the end-to-end line an operator actually reads.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Daemon, resetDriftDeferrals, type DaemonEvent } from "../src/daemon/daemon.js";
import { register } from "./clock-adapters.js";
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

const scratch = scratchRoot("daemon-drift-deferral");

after(() => {
  scratch.cleanup();
});

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA_DIR = join(REPO_ROOT, "schema");

const TASK = "task-042";
const BINDING = createHash("sha256").update("payload:drift", "utf8").digest("hex");

/**
 * A task file whose `state:` says `declared`.
 *
 * The log's answer for this task is `proposed` (registered, nothing requested),
 * so a file claiming anything else is a §6.3 contradiction and the scan appends
 * `envelope.drift` for it.
 */
function taskFile(declared: string): string {
  return [
    "---",
    `id: ${TASK}`,
    "title: Chase deposit refund",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: drift-deferral-test",
    '    created_by: "human:carter"',
    `  state: ${declared}`,
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser"',
    "      reversible: false",
    '      est_cost_usd: "0.02"',
    `      idempotency_key: "${TASK}:chaser"`,
    `      payload_hash: "${BINDING}"`,
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
}

interface Fixture {
  unit: Scenario;
  tasksDir: string;
  taskPath: string;
}

/**
 * Policy attested, task registered, and a task file that contradicts the log.
 *
 * Starts from an empty deferral memory, which is the state a fresh process is
 * in. The memory is keyed by log path as well as task, so cases could not leak
 * into each other anyway; the reset is what makes "what a restarted daemon does"
 * expressible at all.
 */
function ready(declared = "approved"): Fixture {
  resetDriftDeferrals();
  const unit = newScenario(scratch.root);
  attest(unit, T0);
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "drift-deferral-test", created_by: "human:carter" },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            summary: "Send deposit chaser",
            reversible: false,
            est_cost_usd: "0.02",
            idempotency_key: `${TASK}:chaser`,
            payload_hash: BINDING,
          },
        ],
      },
    },
    T0,
    "agent:claude",
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const tasksDir = join(unit.dir, "backlog", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const taskPath = join(tasksDir, `${TASK}.md`);
  writeFileSync(taskPath, taskFile(declared), "utf8");
  return { unit, tasksDir, taskPath };
}

/**
 * Run `body` while an outside party holds the append lock.
 *
 * The same helper `tests/audit.test.ts` uses for APRV-381, and for the same
 * reason: the lockfile is what every writer in this repository contends for, so
 * holding it here reproduces the contention the primary daemon met rather than
 * simulating it.
 */
async function underHeldLock<T>(unit: Scenario, body: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(unit.logPath), { recursive: true });
  const lock = `${unit.logPath}.lock`;
  closeSync(openSync(lock, "wx"));
  try {
    return await body();
  } finally {
    unlinkSync(lock);
  }
}

/**
 * A copy of `schema/` with `envelope.drift` struck from the event enum.
 *
 * The rest is copied byte for byte: the refusal under test is the write
 * boundary's own `validation`, which is the shape no retry repairs.
 */
let schemaCounter = 0;
function schemaDirRejectingDrift(): string {
  schemaCounter += 1;
  const dir = join(scratch.root, `schema-${String(schemaCounter)}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(SCHEMA_DIR)) {
    if (!entry.endsWith(".json")) continue;
    copyFileSync(join(SCHEMA_DIR, entry), join(dir, entry));
  }
  const path = join(dir, "event.schema.json");
  const schema = JSON.parse(readFileSync(path, "utf8")) as {
    properties: { event: { enum: string[] } };
  };
  const enumeration = schema.properties.event.enum;
  const index = enumeration.indexOf("envelope.drift");
  assert.notEqual(index, -1, "envelope.drift is not in the event enum");
  enumeration.splice(index, 1);
  writeFileSync(path, JSON.stringify(schema, null, 2), "utf8");
  return dir;
}

/** One in-process tick of `daemon`, at a fixed instant. */
async function tickOf(daemon: Daemon): Promise<void> {
  const outcome = await daemon.run();
  assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
}

/**
 * One `--once` daemon bound to `fixture`, writing into `emitted`.
 *
 * A fresh instance per tick, because `once: true` means `run()` settles after
 * one pass. That is fine for the retry marker: the deferral memory is
 * process-lifetime (as `daemon/audit.ts`'s is), so consecutive ticks in this
 * test process are one PROCESS, which is the scope the marker claims. A
 * "restarted daemon" is expressed by `resetDriftDeferrals()`, not by a second
 * instance.
 */
function daemonFor(
  fixture: Fixture,
  minutes: number,
  emitted: DaemonEvent[],
  schemaDir?: string,
): Daemon {
  return new Daemon({
    logPath: fixture.unit.logPath,
    tasksDir: fixture.tasksDir,
    queuePath: join(fixture.unit.dir, ".approval", "QUEUE.md"),
    policy: { file: fixture.unit.policyPath },
    cwd: fixture.unit.dir,
    intervalMs: 60_000,
    debounceMs: 10,
    once: true,
    clock: fixedClock(at(minutes)),
    ...(schemaDir === undefined ? {} : { schemaDir }),
    sink: { emit: (event) => emitted.push(event) },
  });
}

function warningsOf(emitted: DaemonEvent[]): Extract<DaemonEvent, { event: "warning" }>[] {
  return emitted.filter(
    (event): event is Extract<DaemonEvent, { event: "warning" }> => event.event === "warning",
  );
}

function driftsOf(emitted: DaemonEvent[]): Extract<DaemonEvent, { event: "drift" }>[] {
  return emitted.filter(
    (event): event is Extract<DaemonEvent, { event: "drift" }> => event.event === "drift",
  );
}

function driftRecords(unit: Scenario) {
  return records(unit).filter((record) => record.event === "envelope.drift");
}

// ===========================================================================

test("a held lock defers the drift record by name and promises the retry", async () => {
  const fixture = ready();
  const before = records(fixture.unit).length;
  const emitted: DaemonEvent[] = [];

  const started = Date.now();
  await underHeldLock(fixture.unit, () => tickOf(daemonFor(fixture, 5, emitted)));
  const waited = Date.now() - started;

  const warnings = warningsOf(emitted);
  const deferrals = warnings.filter((warning) => warning.code === "drift-deferred");
  assert.equal(deferrals.length, 1, JSON.stringify(warnings));
  const line = deferrals[0]?.message ?? "";
  assert.match(line, /task-042/u, "the line must name the task key");
  assert.match(line, /lock-timeout/u);
  assert.match(line, /retries on the next tick/u);
  assert.match(line, /NOT lost/u);

  assert.equal(
    warnings.filter((warning) => warning.code === "append-refused").length,
    0,
    "a deferral must not use the channel a real refusal uses",
  );
  assert.deepEqual(driftsOf(emitted), [], "nothing was appended, so nothing is reported appended");
  assert.equal(records(fixture.unit).length, before, "a deferred drift record wrote to the log");
  // `core/log.ts`'s own 2000ms wait, not a longer one taken for this sweep.
  assert.ok(waited >= 1_000, `the scan gave up after ${String(waited)}ms`);

  // The file was NOT repaired. Write-back runs later in the same tick and would
  // otherwise correct the disagreement off the record, which would leave the
  // retry with nothing to re-derive and turn the deferral into a silent loss.
  assert.equal(readFileSync(fixture.taskPath, "utf8"), taskFile("approved"));
});

test("the retry lands on the next tick of the same run and says so", async () => {
  const fixture = ready();
  const emitted: DaemonEvent[] = [];

  await underHeldLock(fixture.unit, () => tickOf(daemonFor(fixture, 5, emitted)));
  assert.equal(
    warningsOf(emitted).filter((warning) => warning.code === "drift-deferred").length,
    1,
  );

  // The lock is gone. Nothing was remembered about the drift being DUE: the scan
  // re-reads the folder and re-derives the disagreement, which is why the
  // deferral cost nothing.
  const second: DaemonEvent[] = [];
  await tickOf(daemonFor(fixture, 6, second));

  const drifts = driftsOf(second);
  assert.equal(drifts.length, 1, JSON.stringify(second));
  assert.equal(drifts[0]?.task, TASK);
  assert.equal(drifts[0]?.retry, true, "the retry must name itself");
  assert.equal(
    warningsOf(second).filter((warning) => warning.code === "drift-deferred").length,
    0,
    "the deferral is said once, not once per tick",
  );
  assert.equal(driftRecords(fixture.unit).length, 1);

  // And the repair follows the record, in that order, in the tick that wrote it.
  assert.equal(readFileSync(fixture.taskPath, "utf8"), taskFile("proposed"));

  // A third tick: the file agrees with the log, so no drift, no write, no event.
  const third: DaemonEvent[] = [];
  await tickOf(daemonFor(fixture, 7, third));
  assert.deepEqual(driftsOf(third), []);
  assert.equal(driftRecords(fixture.unit).length, 1);

  assertClean(fixture.unit);
});

test("a run that never deferred claims no retry", async () => {
  const fixture = ready();
  const emitted: DaemonEvent[] = [];

  await tickOf(daemonFor(fixture, 5, emitted));

  const drifts = driftsOf(emitted);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.retry, undefined, "absent, so the shape supervisors parse is unchanged");
  assert.deepEqual(warningsOf(emitted).map((warning) => warning.code), []);
  assertClean(fixture.unit);
});

test("a restarted daemon makes the append and claims nothing", async () => {
  const fixture = ready();
  const first: DaemonEvent[] = [];
  await underHeldLock(fixture.unit, () => tickOf(daemonFor(fixture, 5, first)));
  assert.equal(warningsOf(first).filter((w) => w.code === "drift-deferred").length, 1);

  // The restart: the process's deferral memory is gone. The append still
  // happens, because the scan re-derives the drift from the verified log and
  // needed no memory to retry; what is gone is the CLAIM, because this process
  // did not witness the deferral it would be closing.
  resetDriftDeferrals();
  const fresh: DaemonEvent[] = [];
  await tickOf(daemonFor(fixture, 6, fresh));

  const drifts = driftsOf(fresh);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.retry, undefined);
  assert.equal(driftRecords(fixture.unit).length, 1);

  // And the repair is not held back by a deferral nobody remembers: the record
  // landed on this tick, so write-back follows it, in that order.
  assert.equal(readFileSync(fixture.taskPath, "utf8"), taskFile("proposed"));
  assertClean(fixture.unit);
});

test("a refusal a retry cannot fix keeps the append-refused form", async () => {
  const fixture = ready();
  const before = records(fixture.unit).length;
  const emitted: DaemonEvent[] = [];

  await tickOf(daemonFor(fixture, 5, emitted, schemaDirRejectingDrift()));

  const warnings = warningsOf(emitted);
  const refused = warnings.filter((warning) => warning.code === "append-refused");
  assert.equal(refused.length, 1, JSON.stringify(warnings));
  assert.match(
    refused[0]?.message ?? "",
    /^envelope\.drift for task-042 was not appended \(validation\)/u,
    "the pre-APRV-403 form is what a real refusal still reads as",
  );
  assert.doesNotMatch(refused[0]?.message ?? "", /retries on the next tick/u);
  assert.equal(
    warnings.filter((warning) => warning.code === "drift-deferred").length,
    0,
    "a schema refusal is not a deferral",
  );
  assert.equal(records(fixture.unit).length, before);

  // A non-transient refusal is NOT a deferral, so it does not hold write-back
  // back: this file is repaired exactly as it was before APRV-403, and the
  // refusal an operator has to act on stands on its own.
  assert.equal(readFileSync(fixture.taskPath, "utf8"), taskFile("proposed"));
  assertClean(fixture.unit);
});

test("the envelope-missing reason takes the same split", async () => {
  // APRV-63's other drift reason: the log registered the task and the file has
  // no `approval:` key at all. Contention does not care which reason a record
  // carries, so an operator must not read a deferral for one and a refusal for
  // the other.
  const fixture = ready();
  writeFileSync(
    fixture.taskPath,
    ["---", `id: ${TASK}`, "title: Chase deposit refund", "status: Done", "---", "", "Body.", ""].join(
      "\n",
    ),
    "utf8",
  );

  const emitted: DaemonEvent[] = [];
  await underHeldLock(fixture.unit, () => tickOf(daemonFor(fixture, 5, emitted)));

  const deferrals = warningsOf(emitted).filter((warning) => warning.code === "drift-deferred");
  assert.equal(deferrals.length, 1, JSON.stringify(warningsOf(emitted)));
  assert.match(deferrals[0]?.message ?? "", /envelope-missing/u);
  assert.match(deferrals[0]?.message ?? "", /task-042/u);
  assert.match(deferrals[0]?.message ?? "", /retries on the next tick/u);
  assert.equal(driftRecords(fixture.unit).length, 0);

  const second: DaemonEvent[] = [];
  await tickOf(daemonFor(fixture, 6, second));
  const drifts = driftsOf(second);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.reason, "envelope-missing");
  assert.equal(drifts[0]?.retry, true);
  assert.equal(driftRecords(fixture.unit).length, 1);
  assertClean(fixture.unit);
});
