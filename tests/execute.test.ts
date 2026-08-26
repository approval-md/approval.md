/**
 * Execution core tests (APRV-18 Part A): `core/execute.ts` and `core/loop.ts`.
 *
 * Every record here is produced by the real append path — `core/gate.ts`,
 * `core/token.ts`, or `core/execute.ts` calling `appendEvent`. Nothing
 * hand-writes a log line, so no assertion can rest on a record the write
 * boundary would have rejected, and every scenario ends by walking the chain:
 * a refusal that leaves a broken log has still failed.
 *
 * Timestamps are supplied, never read from the clock, so budget windows and TTL
 * lapse are exercised deterministically rather than with sleeps.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";


import {
  danglingExecutions,
  declaringTasks,
  EXECUTE_REFUSAL_CODES,
  executionCustody,
  findDeclaration,
  indeterminateExecutions,
  loopEscalation,
  LOOP_ESCALATION_THRESHOLD,
  type ExecuteOptions,
  type ExecuteRefusal,
} from "../src/core/execute.js";
import { startHarnessExecution } from "../src/core/gate.js";
import { appendEvent } from "../src/core/log.js";
import {
  appendAttestation,
  decide,
  finishExecution,
  indeterminateExecution,
  reconcileExecution,
  register,
  request,
  resolveExecution,
  startExecution,
} from "./clock-adapters.js";
import type { EventRecord } from "../src/core/log.js";
import { isLoopEscalated } from "../src/core/loop.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-execute-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
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
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "```",
  "",
].join("\n");

/** Same policy, but the supervised class is capped at one action a day. */
const POLICY_TIGHT = POLICY.replace("    daily_actions: 50", "    daily_actions: 1");

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: ExecuteOptions;
}

function newCase(policyText: string = POLICY): Case {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText, "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

function attest(unit: Case, ts: string = T0): void {
  const result = appendAttestation(unit.logPath, unit.policyPath, "human:carter", ts);
  assert.equal(result.ok, true, "attestation append failed");
}

function records(unit: Case): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(unit.logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function eventTypes(unit: Case): string[] {
  return records(unit).map((record) => record.event);
}

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

function asRefusal(value: { ok: boolean }): ExecuteRefusal {
  assert.equal(value.ok, false, "expected a refusal");
  return value as ExecuteRefusal;
}

/**
 * The content binding of amended SPEC.md §6.2 (A1), one per action key.
 *
 * Only the manual action strictly needs it — intake refuses
 * `payload-hash-required` without one — but every declaration carries it here,
 * because SHOULD-otherwise is the spec's answer for the rest and a fixture that
 * models only the mandatory case would not exercise the SHOULD path at all.
 */
function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

/**
 * `unit.options` plus the binding an executor must now state (APRV-140).
 *
 * Off the manual path the declaration is the whole of what was authorized, so
 * `startExecution` requires the executor to say which bytes it holds and
 * compares them against it. Every start meant to SUCCEED therefore goes through
 * here; the cases that pass bare `unit.options` are the ones pinning what
 * happens when it does not.
 */
function bound(unit: Case, key: string): ExecuteOptions {
  return { ...unit.options, presentedPayloadHash: bindingFor(key) };
}

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: "task-042:chaser",
      payload_hash: bindingFor("task-042:chaser"),
    },
    {
      class: "files.write.local",
      summary: "Write the draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft",
      payload_hash: bindingFor("task-042:draft"),
    },
    {
      class: "files.write.local",
      summary: "Write the second draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft2",
      payload_hash: bindingFor("task-042:draft2"),
    },
    {
      class: "files.write.local",
      summary: "Write the third draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft3",
      payload_hash: bindingFor("task-042:draft3"),
    },
    {
      class: "files.write.local",
      summary: "Write the fourth draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft4",
      payload_hash: bindingFor("task-042:draft4"),
    },
  ],
};

/** Attest + register: the baseline every scenario starts from. */
function ready(policyText: string = POLICY): Case {
  const unit = newCase(policyText);
  attest(unit);
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: ENVELOPE },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

/** Request + grant the manual action, returning the raw token. */
function grantChaser(unit: Case, ts: string = at(1)): string {
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
      payload_hash: bindingFor("task-042:chaser"),
    },
    ts,
    "agent:claude",
    { policy: { file: unit.policyPath } },
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);

  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", ts, {
    policy: { file: unit.policyPath },
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");
  return granted.token;
}

// ===========================================================================
// the refusal union
// ===========================================================================

test("the execution refusal-code union is frozen public API", () => {
  assert.deepEqual([...EXECUTE_REFUSAL_CODES], [
    "action-not-registered",
    "token-required",
    "loop-escalated",
    "policy-not-attested",
    "already-executed",
    "budget-exceeded",
    "not-started",
    "already-finished",
    "not-granted",
    "token-mismatch",
    "token-consumed",
    "token-expired",
    "token-revoked",
    // APRV-106: surfaced verbatim from core/token.ts. The grant is complete
    // and authorized a process that runs the command itself, so there is no
    // token and nothing to present.
    "harness-executed",
    // APRV-20 pass two, amendment A1: the payload presented is not the payload
    // approved. Nothing appended, token still live.
    "payload-mismatch",
    // APRV-20 pass two: `resolveExecution` is human-only and note-mandatory.
    "actor-not-human",
    // APRV-120: indeterminate is a custody state, and its three refusals are
    // distinct from the ones that surround them. `execution-indeterminate` is
    // not `already-executed`, because "we do not know whether this happened" is
    // a different fact and a different repair; `not-indeterminate` tells an
    // operator who reached for reconcile that they wanted resolve; and
    // `already-reconciled` says a person already answered.
    "execution-indeterminate",
    "not-indeterminate",
    "already-reconciled",
    "log-unreadable",
    "log-torn-tail",
    // APRV-20 finding S1, shared verbatim with the gate and the token module.
    "log-corrupt",
    "append-failed",
  ]);
});

// ===========================================================================
// startExecution — the manual path
// ===========================================================================

test("a manual action without a token refuses token-required and appends NOTHING", () => {
  const unit = ready();
  grantChaser(unit);
  const before = readFileSync(unit.logPath, "utf8");

  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:chaser", unit.options, at(2), "agent:claude"),
  );
  assert.equal(refusal.code, "token-required");
  assert.match(refusal.message, /manual/u);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "the refusal wrote to the log");
  assertClean(unit);
});

test("a manual action with its token appends execution.started and spends the token", () => {
  const unit = ready();
  const token = grantChaser(unit);

  const started = startExecution(
    unit.logPath,
    "task-042:chaser",
    { ...unit.options, token, presentedPayloadHash: bindingFor("task-042:chaser") },
    at(2),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  if (!started.ok) throw new Error("unreachable");
  assert.equal(started.autonomy, "manual");
  assert.equal(started.record.event, "execution.started");
  assert.equal(started.task, "task-042");
  assert.equal(started.class, "communicate.email.external");
  assert.equal(started.est_cost_usd, "0.02");
  assert.equal(typeof started.tokenSha256, "string");
  assert.equal(readFileSync(unit.logPath, "utf8").includes(token), false, "raw token in the log");

  // Single-use: the same token cannot start a second execution.
  const again = asRefusal(
    startExecution(
      unit.logPath,
      "task-042:chaser",
      { ...unit.options, token, presentedPayloadHash: bindingFor("task-042:chaser") },
      at(3),
      "agent:claude",
    ),
  );
  assert.equal(again.code, "token-consumed");
  assertClean(unit);
});

test("a manual action that was never granted refuses through the token layer", () => {
  const unit = ready();
  const refusal = asRefusal(
    startExecution(
      unit.logPath,
      "task-042:chaser",
      { ...unit.options, token: "f".repeat(64) },
      at(2),
      "agent:claude",
    ),
  );
  assert.equal(refusal.code, "not-granted");
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered"]);
  assertClean(unit);
});

test("an undeclared action key refuses action-not-registered", () => {
  const unit = ready();
  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:nope", unit.options, at(2), "agent:claude"),
  );
  assert.equal(refusal.code, "action-not-registered");
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered"]);
});

// ===========================================================================
// startExecution — supervised / autonomous
// ===========================================================================

test("a supervised action starts with no token and charges its budget at the start", () => {
  const unit = ready();
  const started = startExecution(
    unit.logPath,
    "task-042:draft",
    bound(unit, "task-042:draft"),
    at(2),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  if (!started.ok) throw new Error("unreachable");
  assert.equal(started.autonomy, "supervised");
  assert.equal(started.tokenSha256, undefined);
  // APRV-140: the start event names the bytes as well as the price. The hash is
  // the one the executor recomputed and the declaration bound to, so the log
  // says WHAT ran and not only that something did.
  assert.deepEqual(started.record.payload, {
    class: "files.write.local",
    est_cost_usd: "0.01",
    payload_hash: bindingFor("task-042:draft"),
  });
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered", "execution.started"]);
  assertClean(unit);
});

test("the start event is what a budget window sees, and an exceeded budget refuses AFTER logging", () => {
  const unit = ready(POLICY_TIGHT); // global.daily_actions: 1
  const first = startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude");
  assert.equal(first.ok, true);

  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:draft2", bound(unit, "task-042:draft2"), at(3), "agent:claude"),
  );
  assert.equal(refusal.code, "budget-exceeded");
  assert.equal(refusal.verdicts?.[0]?.limit, "global.daily_actions");
  // The one deliberate write-then-refuse: an unauditable budget refusal is how
  // quiet budget creep starts.
  assert.deepEqual(eventTypes(unit), [
    "policy.updated",
    "task.registered",
    "execution.started",
    "budget.exceeded",
  ]);
  assert.equal(records(unit)[3]?.payload?.["stage"], "execution");
  assertClean(unit);
});

test("a supervised action refuses when the policy bytes changed since attestation", () => {
  const unit = ready();
  writeFileSync(unit.policyPath, `${POLICY}\n# edited after attestation\n`, "utf8");

  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude"),
  );
  assert.equal(refusal.code, "policy-not-attested");
  assert.equal(refusal.detail, "hash-mismatch");
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered"]);
});

test("a second start for the same non-manual key refuses already-executed", () => {
  const unit = ready();
  assert.equal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude").ok,
    true,
  );
  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(3), "agent:claude"),
  );
  assert.equal(refusal.code, "already-executed");
  assertClean(unit);
});

test("a spliced-out record refuses log-corrupt: nothing executes on an unverifiable log", () => {
  const unit = ready();
  // Delete a record from the middle. Every surviving line is valid JSON and
  // schema-valid; only the chain says a record is missing — the deletion this
  // whole design exists to make visible.
  const lines = readFileSync(unit.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  writeFileSync(unit.logPath, `${lines.slice(1).join("\n")}\n`, "utf8");
  const before = readFileSync(unit.logPath, "utf8");

  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude"),
  );
  assert.equal(refusal.code, "log-corrupt");
  assert.match(refusal.message, /does not verify/);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "nothing was appended");
});

// ===========================================================================
// finishExecution
// ===========================================================================

test("finishExecution records completed for 0 and failed with the real exit code", () => {
  for (const [exitCode, event] of [
    [0, "execution.completed"],
    [17, "execution.failed"],
    [137, "execution.failed"],
  ] as const) {
    const unit = ready();
    assert.equal(
      startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude").ok,
      true,
    );
    const finished = finishExecution(
      unit.logPath,
      "task-042:draft",
      exitCode,
      at(3),
      "agent:claude",
    );
    assert.equal(finished.ok, true, finished.ok ? "" : finished.message);
    if (!finished.ok) throw new Error("unreachable");
    assert.equal(finished.event, event);
    assert.deepEqual(finished.record.payload, { exit_code: exitCode });
    assert.equal(finished.record.task, "task-042");
    assertClean(unit);
  }
});

test("finishExecution refuses not-started and already-finished, writing nothing either time", () => {
  const unit = ready();
  const cold = asRefusal(
    finishExecution(unit.logPath, "task-042:draft", 0, at(3), "agent:claude"),
  );
  assert.equal(cold.code, "not-started");

  assert.equal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude").ok,
    true,
  );
  assert.equal(finishExecution(unit.logPath, "task-042:draft", 0, at(3), "agent:claude").ok, true);
  const before = readFileSync(unit.logPath, "utf8");

  const twice = asRefusal(finishExecution(unit.logPath, "task-042:draft", 0, at(4), "agent:claude"));
  assert.equal(twice.code, "already-finished");
  assert.equal(readFileSync(unit.logPath, "utf8"), before);
  assertClean(unit);
});

// ===========================================================================
// dangling executions — the crash state, and the human recovery
// ===========================================================================

test("a start with no finish is dangling, and nothing repairs it on its own", () => {
  const unit = ready();
  const started = startExecution(
    unit.logPath,
    "task-042:draft",
    bound(unit, "task-042:draft"),
    at(2),
    "agent:claude",
  );
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("unreachable");

  assert.deepEqual(danglingExecutions(records(unit)), [
    {
      actionKey: "task-042:draft",
      task: "task-042",
      ts: at(2),
      seq: started.record.seq,
      actor: "agent:claude",
    },
  ]);

  // A second run does not reconcile the first: it refuses.
  const again = asRefusal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(3), "agent:claude"),
  );
  assert.equal(again.code, "already-executed");
  assert.equal(danglingExecutions(records(unit)).length, 1, "the refusal changed the state");

  // The human recovery: record what actually happened, through the same path.
  const recovered = finishExecution(unit.logPath, "task-042:draft", 1, at(4), "human:carter");
  assert.equal(recovered.ok, true);
  assert.deepEqual(danglingExecutions(records(unit)), []);
  assertClean(unit);
});

test("danglingExecutions is per action key and only the latest cycle counts", () => {
  const unit = ready();
  assert.equal(
    startExecution(unit.logPath, "task-042:draft", bound(unit, "task-042:draft"), at(2), "agent:claude").ok,
    true,
  );
  assert.equal(finishExecution(unit.logPath, "task-042:draft", 0, at(3), "agent:claude").ok, true);
  assert.equal(
    startExecution(unit.logPath, "task-042:draft2", bound(unit, "task-042:draft2"), at(4), "agent:claude")
      .ok,
    true,
  );

  assert.deepEqual(
    danglingExecutions(records(unit)).map((entry) => entry.actionKey),
    ["task-042:draft2"],
  );
});

// ===========================================================================
// custody: indeterminate, reconcile, and the harness records that are neither
// (APRV-120)
// ===========================================================================

/** A supervised action started and closed as indeterminate, through the log. */
function attempted(key = "task-042:draft"): Case {
  const unit = ready();
  assert.equal(startExecution(unit.logPath, key, bound(unit, key), at(2), "agent:claude").ok, true);
  const unknown = indeterminateExecution(unit.logPath, key, "act-threw", at(3), "agent:claude");
  assert.equal(unknown.ok, true, unknown.ok ? "" : unknown.message);
  return unit;
}

test("an indeterminate outcome is its own custody state, and carries only a closed code", () => {
  const unit = attempted();
  const cycle = executionCustody(records(unit))[0];
  assert.equal(cycle?.state, "indeterminate");
  assert.equal(cycle?.reason, "act-threw");
  assert.equal(cycle?.resolution, null);

  // Not dangling: a dangling execution asks a person to look at what THIS
  // runtime did, and an indeterminate one asks whether the far side committed.
  assert.deepEqual(danglingExecutions(records(unit)), []);
  assert.deepEqual(
    indeterminateExecutions(records(unit)).map((entry) => entry.actionKey),
    ["task-042:draft"],
  );

  const record = records(unit).find((entry) => entry.event === "execution.indeterminate");
  assert.deepEqual(record?.payload, { reason: "act-threw", exit_code: null });
  assertClean(unit);
});

test("an indeterminate outcome burns the key: the re-run refusal is its own code", () => {
  const unit = attempted();
  const before = records(unit).length;
  const refusal = asRefusal(
    startExecution(
      unit.logPath,
      "task-042:draft",
      bound(unit, "task-042:draft"),
      at(4),
      "agent:claude",
    ),
  );
  // Not `already-executed`: "we do not know whether this happened" is a
  // different fact from "this happened", and it calls for a different repair.
  assert.equal(refusal.code, "execution-indeterminate");
  assert.match(refusal.message, /reconcile/u);
  assert.equal(records(unit).length, before, "a refused retry appended something");
  assertClean(unit);
});

test("no outcome may be written over an indeterminate one", () => {
  const unit = attempted();
  const before = records(unit).length;

  const finished = asRefusal(
    finishExecution(unit.logPath, "task-042:draft", 0, at(4), "agent:claude"),
  );
  assert.equal(finished.code, "already-finished");
  assert.match(finished.message, /reconcile/u);

  const resolved = asRefusal(
    resolveExecution(
      unit.logPath,
      "task-042:draft",
      "completed",
      "I think it went out",
      at(5),
      "human:carter",
    ),
  );
  assert.equal(resolved.code, "already-finished");
  assert.equal(records(unit).length, before, "a refusal appended something");
  assertClean(unit);
});

test("reconcile appends beside the indeterminate record and never rewrites it", () => {
  const unit = attempted();
  const indeterminate = records(unit).find(
    (entry) => entry.event === "execution.indeterminate",
  );
  const before = JSON.stringify(indeterminate);

  const reconciled = reconcileExecution(
    unit.logPath,
    "task-042:draft",
    "executed",
    "the provider console shows message id 8f21c accepted at 14:47:02",
    at(6),
    "human:carter",
  );
  assert.equal(reconciled.ok, true, reconciled.ok ? "" : reconciled.message);
  if (!reconciled.ok) throw new Error("unreachable");
  assert.equal(reconciled.indeterminateSeq, indeterminate?.seq);
  assert.deepEqual(reconciled.record.payload, {
    indeterminate_seq: indeterminate?.seq,
    resolution: "executed",
    note: "the provider console shows message id 8f21c accepted at 14:47:02",
    attested_by_human: true,
  });

  // The doubt survives its own answer: the original record is byte-identical.
  assert.equal(
    JSON.stringify(records(unit).find((entry) => entry.event === "execution.indeterminate")),
    before,
  );
  assert.equal(executionCustody(records(unit))[0]?.state, "reconciled");
  assert.deepEqual(indeterminateExecutions(records(unit)), []);
  assertClean(unit);
});

test("resolving not-executed is recorded distinctly, and the key stays burned", () => {
  const unit = attempted();
  const reconciled = reconcileExecution(
    unit.logPath,
    "task-042:draft",
    "not-executed",
    "nothing in the provider's outbound log for that window",
    at(6),
    "human:carter",
  );
  assert.equal(reconciled.ok, true, reconciled.ok ? "" : reconciled.message);
  assert.equal(executionCustody(records(unit))[0]?.resolution, "not-executed");

  // Re-opening the EFFECT is not re-opening the KEY: an idempotency key is the
  // global identity of one side effect, and a used one is used. The repair is a
  // fresh action, which is a new question with a new answer.
  const again = asRefusal(
    startExecution(
      unit.logPath,
      "task-042:draft",
      bound(unit, "task-042:draft"),
      at(7),
      "agent:claude",
    ),
  );
  assert.equal(again.code, "already-executed");
  assertClean(unit);
});

test("reconcile is human-only, note-mandatory, once, and only where there is doubt", () => {
  const unit = attempted();
  const before = records(unit).length;

  const agent = asRefusal(
    reconcileExecution(unit.logPath, "task-042:draft", "executed", "saw it", at(6), "agent:claude"),
  );
  assert.equal(agent.code, "actor-not-human");

  const silent = asRefusal(
    reconcileExecution(unit.logPath, "task-042:draft", "executed", "   ", at(6), "human:carter"),
  );
  assert.equal(silent.code, "actor-not-human");

  // A key with no indeterminate record at all: the operator wanted `resolve`.
  const wrongVerb = asRefusal(
    reconcileExecution(unit.logPath, "task-042:draft2", "executed", "saw it", at(6), "human:carter"),
  );
  assert.equal(wrongVerb.code, "not-indeterminate");
  assert.match(wrongVerb.message, /execution resolve/u);
  assert.equal(records(unit).length, before, "a refusal appended something");

  assert.equal(
    reconcileExecution(unit.logPath, "task-042:draft", "executed", "saw it", at(6), "human:carter")
      .ok,
    true,
  );
  const twice = asRefusal(
    reconcileExecution(
      unit.logPath,
      "task-042:draft",
      "not-executed",
      "on reflection, no",
      at(7),
      "human:carter",
    ),
  );
  assert.equal(twice.code, "already-reconciled");
  assertClean(unit);
});

test("a harness execution is DELEGATED, not dangling: it is terminal by design", () => {
  // APRV-117/APRV-141: the harness runs the command and this runtime never
  // observes an exit status, so no outcome event will ever follow. Before
  // the custody vocabulary these read as debris — dozens of them in the
  // reference repository's own log — which is how a list an operator is
  // supposed to act on becomes a list they scroll past.
  const unit = ready();
  const cls = "read.web";
  const key = `hook:sess-1:tu-1:${cls}`;
  const registered = register(
    unit.logPath,
    {
      task: "hook:sess-1:tu-1",
      envelope: {
        origin: { app: "claude-code-hook", created_by: "agent:claude-code" },
        state: "proposed",
        actions: [
          { class: cls, summary: "ls", reversible: true, est_cost_usd: "0", idempotency_key: key },
        ],
      },
    },
    T0,
    "agent:claude-code",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const started = startHarnessExecution(
    unit.logPath,
    { task: "hook:sess-1:tu-1", cls, actionKey: key },
    "agent:claude-code",
    { ...unit.options, clock: () => at(2) },
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);

  const cycle = executionCustody(records(unit)).find((entry) => entry.actionKey === key);
  assert.equal(cycle?.state, "delegated");
  assert.deepEqual(danglingExecutions(records(unit)), [], "a harness record was reported as debris");
  assert.deepEqual(indeterminateExecutions(records(unit)), []);
  assertClean(unit);
});

// ===========================================================================
// loop escalation (SPEC.md §10.2)
// ===========================================================================

/** Start and fail one supervised action, through the real append path. */
function failOnce(unit: Case, actionKey: string, minute: number): void {
  assert.equal(
    startExecution(unit.logPath, actionKey, bound(unit, actionKey), at(minute), "agent:claude").ok,
    true,
  );
  assert.equal(
    finishExecution(unit.logPath, actionKey, 1, at(minute + 1), "agent:claude").ok,
    true,
  );
}

test("three consecutive execution.failed escalate the task; a completed resets the streak", () => {
  assert.equal(LOOP_ESCALATION_THRESHOLD, 3);
  const unit = ready();

  failOnce(unit, "task-042:draft", 2);
  assert.equal(isLoopEscalated(records(unit), "task-042"), false);
  failOnce(unit, "task-042:draft2", 4);
  assert.equal(isLoopEscalated(records(unit), "task-042"), false);
  failOnce(unit, "task-042:draft3", 6);
  assert.equal(isLoopEscalated(records(unit), "task-042"), true);

  assert.deepEqual(loopEscalation(records(unit)), [
    {
      task: "task-042",
      consecutiveFailures: 3,
      escalated: true,
      streakStartSeq: 4,
      lastFailureSeq: 8,
    },
  ]);

  // A completion is the only thing that clears it — and it clears it fully.
  const fresh = ready();
  failOnce(fresh, "task-042:draft", 2);
  failOnce(fresh, "task-042:draft2", 4);
  assert.equal(
    startExecution(fresh.logPath, "task-042:draft3", bound(fresh, "task-042:draft3"), at(6), "agent:claude")
      .ok,
    true,
  );
  assert.equal(
    finishExecution(fresh.logPath, "task-042:draft3", 0, at(7), "agent:claude").ok,
    true,
  );
  failOnce(fresh, "task-042:draft4", 8);
  assert.equal(isLoopEscalated(records(fresh), "task-042"), false);
  assert.equal(loopEscalation(records(fresh))[0]?.consecutiveFailures, 1);
  assertClean(fresh);
});

test("an escalated task refuses a supervised start, and the gate refuses the request too", () => {
  const unit = ready();
  failOnce(unit, "task-042:draft", 2);
  failOnce(unit, "task-042:draft2", 4);
  failOnce(unit, "task-042:draft3", 6);

  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:draft4", bound(unit, "task-042:draft4"), at(8), "agent:claude"),
  );
  assert.equal(refusal.code, "loop-escalated");
  assert.match(refusal.message, /§10\.2/u);

  const gated = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:draft4",
      cls: "files.write.local",
      reversible: true,
      payload_hash: bindingFor("task-042:draft4"),
    },
    at(8),
    "agent:claude",
    { policy: { file: unit.policyPath } },
  );
  assert.equal(gated.ok, false);
  if (gated.ok) throw new Error("unreachable");
  assert.equal(gated.code, "loop-escalated");

  // Escalation is a floor, not a ban: the task's MANUAL actions still work.
  const token = grantChaser(unit, at(9));
  const started = startExecution(
    unit.logPath,
    "task-042:chaser",
    { ...unit.options, token, presentedPayloadHash: bindingFor("task-042:chaser") },
    at(10),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  assertClean(unit);
});

test("loopEscalation is per task and ignores other tasks' failures", () => {
  const unit = ready();
  failOnce(unit, "task-042:draft", 2);
  const states = loopEscalation(records(unit));
  assert.deepEqual(
    states.map((state) => [state.task, state.consecutiveFailures, state.escalated]),
    [["task-042", 1, false]],
  );
  assert.equal(isLoopEscalated(records(unit), "task-999"), false);
});

// ===========================================================================
// findDeclaration
// ===========================================================================

test("findDeclaration reads the class from the log, not from the task file", () => {
  const unit = ready();
  assert.deepEqual(findDeclaration(records(unit), "task-042:chaser"), {
    task: "task-042",
    class: "communicate.email.external",
    est_cost_usd: "0.02",
    reversible: false,
    summary: "Send deposit chaser",
    payload_hash: bindingFor("task-042:chaser"),
  });
  assert.equal(findDeclaration(records(unit), "task-042:absent"), null);
});

// ===========================================================================
// declaringTasks + cross-task collision fail-closed (APRV-138, red-team F1)
// ===========================================================================

/**
 * Append a second `task.registered` for `key` under a different task, through
 * the real append path. `register` now refuses this at the write boundary
 * (APRV-138), so the only way a log holds a collision is an older binary or
 * out-of-band write. These tests prove the runtime fails closed on such a log
 * instead of trusting the later, weaker declaration.
 */
function shadowRegister(unit: Case, task: string, key: string, cls: string, ts: string): void {
  const appended = appendEvent(unit.logPath, {
    ts,
    event: "task.registered",
    actor: "agent:mallory",
    task,
    payload: {
      actions: [
        {
          class: cls,
          summary: "shadow declaration",
          reversible: true,
          est_cost_usd: "0",
          idempotency_key: key,
          payload_hash: bindingFor(key),
        },
      ],
    },
  });
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
}

test("declaringTasks reports one task normally, and every task on a collision", () => {
  const unit = ready();
  assert.deepEqual(declaringTasks(records(unit), "task-042:chaser"), ["task-042"]);
  shadowRegister(unit, "task-099", "task-042:chaser", "read.web", at(1));
  assert.deepEqual(declaringTasks(records(unit), "task-042:chaser"), ["task-042", "task-099"]);
});

test("startExecution refuses a collision-shadowed key rather than run the weaker declaration", () => {
  const unit = ready();
  // task-042 declared task-042:chaser as communicate.email.external, reversible
  // false: manual, floor engaged. The shadow re-declares it as read.web
  // (autonomous) reversible true. Last-wins would execute it with no token, no
  // human, floor gone. The guard must refuse instead.
  shadowRegister(unit, "task-099", "task-042:chaser", "read.web", at(1));
  const before = records(unit).length;
  const refusal = asRefusal(
    startExecution(unit.logPath, "task-042:chaser", unit.options, at(2), "agent:mallory"),
  );
  assert.equal(refusal.code, "action-not-registered");
  assert.match(refusal.message, /more than one task/u);
  assert.match(refusal.message, /task-042/u);
  assert.match(refusal.message, /task-099/u);
  assert.equal(records(unit).length, before, "nothing may be appended on the refusal");
  assertClean(unit);
});

/**
 * The residual APRV-138 left open, now closed (APRV-140, red-team F3).
 *
 * This test used to assert the hole: a lone autonomous registration executed
 * with no token and no presented payload hash, so `approval run <key> --
 * <anything>` under an autonomous class was unauthenticated arbitrary
 * execution. It is flipped: off the manual path there is no grant, so the
 * DECLARATION is what authorizes, and an executor that will not say which bytes
 * it holds is refused `payload-mismatch` with the log untouched.
 */
function autonomousCase(): Case {
  const unit = newCase();
  attest(unit);
  const envelope = {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: [
      {
        class: "read.web",
        summary: "read a page",
        reversible: true,
        est_cost_usd: "0",
        idempotency_key: "task-500:read",
        payload_hash: bindingFor("task-500:read"),
      },
    ],
  };
  const registered = register(unit.logPath, { task: "task-500", envelope }, T0, "agent:claude");
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

test("F3 CLOSED: a lone autonomous key refuses when the executor states no payload", () => {
  const unit = autonomousCase();
  const before = records(unit).length;
  const refusal = asRefusal(
    startExecution(unit.logPath, "task-500:read", unit.options, at(2), "agent:x"),
  );
  assert.equal(refusal.code, "payload-mismatch");
  assert.match(refusal.message, /presented none/u);
  assert.equal(records(unit).length, before, "a refused start appended something");
  assertClean(unit);
});

test("F3 CLOSED: an autonomous key refuses bytes other than the declared ones", () => {
  const unit = autonomousCase();
  const before = records(unit).length;
  const refusal = asRefusal(
    startExecution(
      unit.logPath,
      "task-500:read",
      { ...unit.options, presentedPayloadHash: bindingFor("something-else") },
      at(2),
      "agent:x",
    ),
  );
  assert.equal(refusal.code, "payload-mismatch");
  assert.match(refusal.message, /not the one declared/u);
  assert.equal(records(unit).length, before, "a refused start appended something");
  assertClean(unit);
});

test("F3 CLOSED: the declared bytes start, and the start event records their hash", () => {
  const unit = autonomousCase();
  const started = startExecution(
    unit.logPath,
    "task-500:read",
    bound(unit, "task-500:read"),
    at(2),
    "agent:x",
  );
  assert.equal(started.ok, true, started.ok ? "" : (started as ExecuteRefusal).message);
  if (!started.ok) throw new Error("unreachable");
  assert.equal(
    (started.record.payload as Record<string, unknown>)["payload_hash"],
    bindingFor("task-500:read"),
  );
  assertClean(unit);
});

test("F3 CLOSED: an action declared with no payload_hash cannot execute at all", () => {
  const unit = newCase();
  attest(unit);
  const envelope = {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: [
      {
        class: "read.web",
        summary: "read a page",
        reversible: true,
        est_cost_usd: "0",
        idempotency_key: "task-501:read",
      },
    ],
  };
  const registered = register(unit.logPath, { task: "task-501", envelope }, T0, "agent:claude");
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  const before = records(unit).length;
  // Even a truthful executor is refused: there is nothing to check it against,
  // and an unbound declaration would make the binding optional in practice.
  const refusal = asRefusal(
    startExecution(
      unit.logPath,
      "task-501:read",
      { ...unit.options, presentedPayloadHash: bindingFor("task-501:read") },
      at(2),
      "agent:x",
    ),
  );
  assert.equal(refusal.code, "payload-mismatch");
  assert.match(refusal.message, /carries no payload_hash/u);
  assert.equal(records(unit).length, before, "a refused start appended something");
  assertClean(unit);
});
