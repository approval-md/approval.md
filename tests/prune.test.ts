/**
 * Payload retention pruning (APRV-41) — amended SPEC.md §5.2's enforcement half.
 *
 * The properties under test are the ones an operator's evidence rests on:
 *
 * 1. **Write-ahead, never the reverse.** The `payload.pruned` event lands before
 *    the file goes. The crash-window case proves the ordering by making the
 *    unlink fail after a successful append and then completing the removal on a
 *    later pass — with no second event for the same hash.
 * 2. **Non-terminal payloads are immortal.** Pending, granted-not-executed, and
 *    registered-never-requested payloads survive a 1ms retention evaluated years
 *    later. A live approval binds to those exact bytes.
 * 3. **Terminal plus duration, measured from the log.** Rejected, revoked,
 *    expired (by event) and executed release the bytes once the recorded terminal
 *    moment is more than `payload_retention` old. The boundary is strict.
 * 4. **Orphans go when pruning is on, and only then.** With the key absent the
 *    subsystem does not run at all: nothing is deleted, orphan or not, and the
 *    log is byte-identical across the pass.
 * 5. **The daemon is the only pruner.** The last case drives the real `Daemon`
 *    for one tick and asserts the same behavior through it.
 *
 * Nothing here hand-writes a log line: every record is produced by
 * `core/attest.ts`, `core/gate.ts`, `core/execute.ts` or the pruner's own
 * append path, and `verify` runs at the end of every scenario that writes.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";
import { planPrune, prunePayloads } from "../src/daemon/prune.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { payloadStoreCensus } from "../src/core/payload-census.js";
import { payloadPath, payloadStoreDirFor, storePayload } from "../src/core/payload-store.js";
import {
  decide,
  finishExecution,
  register,
  request,
  startExecution,
} from "./clock-adapters.js";
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

const scratch = scratchRoot("prune");
after(scratch.cleanup);

const TASK = "task-700";
const MANUAL_ACTION = `${TASK}:chaser`;
const SUPERVISED_ACTION = `${TASK}:draft`;
const AGENT = "agent:drafter";
const HUMAN = "human:carter";

const PAYLOAD = {
  to: ["agency@example.co.uk"],
  subject: "Deposit refund chaser",
  body: "Following up on the deposit refund.",
};
const HASH = payloadHash(PAYLOAD);

const DRAFT_PAYLOAD = { path: "drafts/chaser.md", body: "Draft body" };
const DRAFT_HASH = payloadHash(DRAFT_PAYLOAD);

/** A policy with, or without, `payload_retention`. */
function policyText(retention: string | null): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    ...(retention === null ? [] : [`payload_retention: "${retention}"`]),
    "classes:",
    "  files.write.*:",
    "    autonomy: supervised",
    "  communicate.email.external:",
    "    autonomy: manual",
    "```",
    "",
  ].join("\n");
}

const ENVELOPE = {
  origin: { app: "example-capture", created_by: HUMAN },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: MANUAL_ACTION,
      payload_hash: HASH,
    },
    {
      class: "files.write.local",
      summary: "Write the draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: SUPERVISED_ACTION,
      payload_hash: DRAFT_HASH,
    },
  ],
};

interface Unit extends Scenario {
  storeDir: string;
}

/** A fresh home whose policy declares `retention`, with the payload stored. */
function setup(retention: string | null): Unit {
  const unit = newScenario(scratch.root, policyText(retention)) as Unit;
  unit.storeDir = payloadStoreDirFor(unit.logPath);
  attest(unit, T0);
  const stored = storePayload(unit.storeDir, PAYLOAD);
  assert.equal(stored.ok, true, JSON.stringify(stored));
  return unit;
}

function registerTask(unit: Unit, ts: string = T0): void {
  const result = register(unit.logPath, { task: TASK, envelope: ENVELOPE }, ts, AGENT);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

function requestChaser(unit: Unit, ts: string = at(1)): void {
  const result = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: MANUAL_ACTION,
      payload_hash: HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
    },
    ts,
    AGENT,
    unit.options,
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

/** Register, request, and settle the manual action with `decision`. */
function settled(unit: Unit, decision: "reject" | "revoke", ts: string = at(2)): void {
  registerTask(unit);
  requestChaser(unit);
  if (decision === "revoke") {
    const granted = decide(unit.logPath, MANUAL_ACTION, "grant", HUMAN, at(2), unit.options);
    assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  }
  const result = decide(unit.logPath, MANUAL_ACTION, decision, HUMAN, ts, unit.options);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

function prune(unit: Unit, ts: string): ReturnType<typeof prunePayloads> {
  return prunePayloads({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    clock: fixedClock(ts),
  });
}

function eventsOf(unit: Unit): EventRecord[] {
  return records(unit);
}

function prunedEvents(unit: Unit): EventRecord[] {
  return eventsOf(unit).filter((record) => record.event === "payload.pruned");
}

function stored(unit: Unit, hash: string = HASH): boolean {
  return existsSync(payloadPath(unit.storeDir, hash));
}

// ===========================================================================
// Terminal plus duration
// ===========================================================================

test("a rejected payload older than the retention is pruned exactly once", () => {
  const unit = setup("1h");
  settled(unit, "reject");
  assert.equal(stored(unit), true);

  const report = prune(unit, at(200));
  assert.equal(report.appended.length, 1);
  assert.equal(report.appended[0]?.hash, HASH);
  assert.equal(report.appended[0]?.reason, "payload_retention");
  assert.equal(report.appended[0]?.terminalState, "rejected");
  assert.deepEqual(report.removed, [HASH]);
  assert.deepEqual(report.warnings, []);
  assert.equal(stored(unit), false);

  const events = prunedEvents(unit);
  assert.equal(events.length, 1);
  const record = events[0];
  assert.equal(record?.actor, "system:daemon");
  assert.equal(record?.ts, at(200), "the runtime, not the caller, stamps the prune");
  assert.equal(record?.action_key, MANUAL_ACTION);
  const payload = (record?.payload ?? {}) as Record<string, unknown>;
  assert.equal(payload["payload_hash"], HASH);
  assert.equal(payload["reason"], "payload_retention");
  assert.equal(payload["retention"], "1h");
  assert.equal(payload["terminal_state"], "rejected");
  assertClean(unit);

  // Re-derived every pass: a second run appends nothing and removes nothing.
  const again = prune(unit, at(300));
  assert.deepEqual(again.appended, []);
  assert.deepEqual(again.removed, []);
  assert.equal(prunedEvents(unit).length, 1);
  assertClean(unit);
});

test("revoked and executed are terminal too, and executed is dated from the log", () => {
  const revoked = setup("1h");
  settled(revoked, "revoke", at(3));
  assert.equal(prune(revoked, at(200)).appended[0]?.terminalState, "revoked");
  assert.equal(stored(revoked), false);
  assertClean(revoked);

  // The supervised action needs no approval: it registers, executes, completes.
  const executed = setup("1h");
  const draft = storePayload(executed.storeDir, DRAFT_PAYLOAD);
  assert.equal(draft.ok, true);
  registerTask(executed);
  const started = startExecution(
    executed.logPath,
    SUPERVISED_ACTION,
    { policy: { file: executed.policyPath } },
    at(4),
    AGENT,
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  const finished = finishExecution(executed.logPath, SUPERVISED_ACTION, 0, at(5), AGENT, {
    policy: { file: executed.policyPath },
  });
  assert.equal(finished.ok, true, finished.ok ? "" : finished.message);

  const report = prune(executed, at(200));
  const candidate = report.appended.find((entry) => entry.hash === DRAFT_HASH);
  assert.equal(candidate?.terminalState, "executed");
  assert.equal(candidate?.terminalTs, at(5), "retention is measured from the recorded event");
  assert.equal(stored(executed, DRAFT_HASH), false);
  assertClean(executed);
});

test("the retention boundary is strict: equal is not longer than", () => {
  const unit = setup("1h");
  settled(unit, "reject", at(2));

  // Terminal at at(2); one hour later is exactly the boundary.
  assert.deepEqual(prune(unit, at(62)).appended, []);
  assert.equal(stored(unit), true);

  const past = new Date(Date.parse(at(62)) + 1).toISOString();
  assert.equal(prune(unit, past).appended.length, 1);
  assert.equal(stored(unit), false);
  assertClean(unit);
});

// ===========================================================================
// Non-terminal payloads survive everything
// ===========================================================================

test("non-terminal payloads survive a 1ms retention evaluated years later", () => {
  const distantFuture = "2099-01-01T00:00:00.000Z";

  // 1. Requested and undecided.
  const pending = setup("1ms");
  registerTask(pending);
  requestChaser(pending);
  assert.deepEqual(prune(pending, distantFuture).appended, []);
  assert.equal(stored(pending), true);
  assertClean(pending);

  // 2. Granted and not executed: the grant binds to exactly these bytes.
  const granted = setup("1ms");
  registerTask(granted);
  requestChaser(granted);
  const decision = decide(granted.logPath, MANUAL_ACTION, "grant", HUMAN, at(2), granted.options);
  assert.equal(decision.ok, true, decision.ok ? "" : decision.message);
  assert.deepEqual(prune(granted, distantFuture).appended, []);
  assert.equal(stored(granted), true);
  assertClean(granted);

  // 3. Registered and never requested: the declaration still names the bytes.
  const declared = setup("1ms");
  registerTask(declared);
  assert.deepEqual(prune(declared, distantFuture).appended, []);
  assert.equal(stored(declared), true);
  assertClean(declared);

  // 4. Re-requested after an earlier rejection: the fresh request revives the
  //    binding, whatever the old decision said.
  const revived = setup("1ms");
  settled(revived, "reject", at(2));
  requestChaser(revived, at(3));
  assert.deepEqual(prune(revived, distantFuture).appended, []);
  assert.equal(stored(revived), true);
  assertClean(revived);
});

test("planPrune: one live binding among settled ones keeps the payload", () => {
  const unit = setup("1ms");
  settled(unit, "reject", at(2));
  // A second action declaring the SAME bytes, still awaiting a decision.
  const second = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: `${TASK}:chaser-2`,
      payload_hash: HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser again",
    },
    at(3),
    AGENT,
    unit.options,
  );
  assert.equal(second.ok, true, second.ok ? "" : second.message);

  const plan = planPrune(eventsOf(unit), [HASH], at(500), 1);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.completions, []);
});

// ===========================================================================
// Orphans
// ===========================================================================

test("an orphan is pruned at any age when retention is set", () => {
  const unit = setup("52w");
  const orphan = storePayload(unit.storeDir, { residue: "head-moved" });
  assert.equal(orphan.ok, true);
  if (!orphan.ok) return;
  registerTask(unit);

  const report = prune(unit, at(1));
  assert.equal(report.appended.length, 1, JSON.stringify(report));
  assert.equal(report.appended[0]?.hash, orphan.hash);
  assert.equal(report.appended[0]?.reason, "orphaned");
  assert.equal(existsSync(orphan.path), false);
  // The bound-but-live payload was not touched.
  assert.equal(stored(unit), true);

  const record = prunedEvents(unit)[0];
  assert.notEqual(record, undefined);
  assert.equal(record?.action_key, undefined);
  assert.equal(((record?.payload ?? {}) as Record<string, unknown>)["reason"], "orphaned");
  assertClean(unit);
});

// ===========================================================================
// Absent key: the subsystem does not run
// ===========================================================================

test("with payload_retention absent nothing is pruned, orphan or not", () => {
  const unit = setup(null);
  settled(unit, "reject", at(2));
  const orphan = storePayload(unit.storeDir, { residue: "head-moved" });
  assert.equal(orphan.ok, true);
  if (!orphan.ok) return;

  const before = readFileSync(unit.logPath);
  const report = prune(unit, "2099-01-01T00:00:00.000Z");
  assert.equal(report.retentionMs, null);
  assert.deepEqual(report.appended, []);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.warnings, []);

  assert.deepEqual(readFileSync(unit.logPath), before, "the log was not touched");
  assert.equal(stored(unit), true);
  assert.equal(existsSync(orphan.path), true);
  assertClean(unit);
});

test("an unloadable policy prunes nothing (fail closed)", () => {
  const unit = setup("1h");
  settled(unit, "reject", at(2));
  const report = prunePayloads({
    logPath: unit.logPath,
    policy: { file: join(unit.dir, "NO-SUCH-POLICY.md") },
    clock: fixedClock(at(500)),
  });
  assert.equal(report.retentionMs, null);
  assert.deepEqual(report.appended, []);
  assert.equal(stored(unit), true);
  assertClean(unit);
});

// ===========================================================================
// The crash window
// ===========================================================================

test("the event lands before the file goes, and a crash between is completed", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: an unwritable directory cannot be simulated with mode bits");
    return;
  }

  const unit = setup("1h");
  settled(unit, "reject", at(2));

  // The crash: the append succeeds, the unlink cannot happen.
  chmodSync(unit.storeDir, 0o555);
  let report;
  try {
    report = prune(unit, at(200));
  } finally {
    chmodSync(unit.storeDir, 0o755);
  }
  assert.equal(report.appended.length, 1, "the event must land first");
  assert.deepEqual(report.removed, []);
  assert.equal(report.warnings[0]?.code, "unlink-failed");
  assert.equal(stored(unit), true, "the bytes are still there — the log is merely ahead");
  assert.equal(prunedEvents(unit).length, 1);
  assertClean(unit);

  // The completion: the file goes, and NO second event is written for it.
  const completion = prune(unit, at(300));
  assert.deepEqual(completion.completed, [HASH]);
  assert.deepEqual(completion.appended, []);
  assert.deepEqual(completion.removed, [HASH]);
  assert.equal(stored(unit), false);
  assert.equal(prunedEvents(unit).length, 1, "never a second payload.pruned for one hash");
  assertClean(unit);
});

// ===========================================================================
// Reporting
// ===========================================================================

test("the census counts pruned-by-log, orphans, and files awaiting removal", () => {
  const unit = setup("1h");
  settled(unit, "reject", at(2));
  const orphan = storePayload(unit.storeDir, { residue: "head-moved" });
  assert.equal(orphan.ok, true);

  const before = payloadStoreCensus(eventsOf(unit), unit.storeDir);
  assert.deepEqual(before, { files: 2, pruned: 0, orphans: 1, awaitingRemoval: 0 });

  prune(unit, at(200));
  const after = payloadStoreCensus(eventsOf(unit), unit.storeDir);
  assert.equal(after.files, 0);
  assert.equal(after.pruned, 2, "the log keeps saying what the store no longer holds");
  assert.equal(after.orphans, 0);
  assertClean(unit);
});

// ===========================================================================
// Through the real daemon
// ===========================================================================

test("the daemon prunes on its tick, and the log stays clean", async () => {
  const unit = setup("1h");
  settled(unit, "reject", at(2));

  const tasksDir = join(unit.dir, "backlog", "tasks");
  mkdirSync(tasksDir, { recursive: true });
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
    clock: fixedClock(at(200)),
    sink: { emit: (event) => emitted.push(event) },
  });

  const outcome = await daemon.run();
  assert.equal(outcome.kind, "stopped");
  assert.equal(
    emitted.some((event) => event.event === "warning" && event.code === "prune-refused"),
    false,
    JSON.stringify(emitted.filter((event) => event.event === "warning")),
  );
  assert.equal(stored(unit), false, "the daemon is the pruner");
  const appended = prunedEvents(unit);
  assert.equal(appended.length, 1);

  // APRV-57: one line per completed prune, naming the record it reports. The
  // deletion of approval evidence is exactly the kind of thing an operator's
  // `--json` pipeline should see happen, not infer from a store that shrank.
  const lines = emitted.filter((event) => event.event === "pruned");
  assert.equal(lines.length, 1, JSON.stringify(emitted));
  const line = lines[0];
  assert.equal(line?.event === "pruned" && line.payload_hash, HASH);
  assert.equal(line?.event === "pruned" && line.reason, "payload_retention");
  assert.equal(line?.event === "pruned" && line.seq, appended[0]?.seq);
  assert.equal(line?.event === "pruned" && line.action_key, MANUAL_ACTION);
  assertClean(unit);
});
