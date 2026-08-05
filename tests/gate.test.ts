/**
 * Gate core tests (APRV-16 Part A).
 *
 * Every record consumed or asserted here is produced by the real append path —
 * `core/gate.ts` calling `core/log.ts`'s `appendEvent`, or `appendEvent`
 * directly for the execution events APRV-18 will own. Nothing hand-writes a log
 * line, so no test can assert on a record the write boundary would have
 * rejected. Every scenario ends by walking the chain with `verify()`: a gate
 * that refuses correctly but leaves a broken log has still failed.
 *
 * Timestamps are supplied, never read from the clock, so TTL lapse and budget
 * windows are exercised deterministically rather than with sleeps.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import {
  decide,
  expire,
  EXPIRY_ACTOR,
  GATE_REFUSAL_CODES,
  register,
  registeredAction,
  request,
  requestState,
  type GateOptions,
  type GateRefusal,
} from "../src/core/gate.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { tokenHash } from "../src/core/token.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-gate-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

/** `minutes` after {@link T0}, as an RFC 3339 instant. */
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
  "  financial.spend:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 0.5",
  "  physical.order:",
  "    autonomy: manual",
  "    limits:",
  "      daily_actions: 1",
  "```",
  "",
].join("\n");

/** A policy with no `defaults.approval_ttl`: nothing ever lapses. */
const POLICY_NO_TTL = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "```",
  "",
].join("\n");

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: GateOptions;
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

/** Attest the policy through the real append path. */
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

/** The chain must be clean after every scenario. */
function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

const ENVELOPE = {
  origin: { app: "cartsos", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: 0.02,
      idempotency_key: "task-042:chaser",
    },
  ],
};

/** Register `ENVELOPE` under `task-042` and return the record. */
function registerTask(unit: Case, ts: string = T0): EventRecord {
  const result = register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, ts, "agent:claude");
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  return result.record;
}

/** Request the canonical manual action. */
function requestChaser(unit: Case, ts: string = at(1)): EventRecord {
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      cls: "communicate.email.external",
      est_cost_usd: 0.02,
      reversible: false,
      summary: "Send deposit chaser",
    },
    ts,
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok || result.record === null) throw new Error("expected an approval.requested record");
  return result.record;
}

function asRefusal(value: { ok: boolean }): GateRefusal {
  assert.equal(value.ok, false, "expected a refusal");
  return value as GateRefusal;
}

/** Append an execution.started through the real write path (APRV-18's event). */
function executionStarted(unit: Case, actionKey: string, ts: string): void {
  const result = appendEvent(unit.logPath, {
    ts,
    event: "execution.started",
    actor: "agent:claude",
    task: "task-042",
    action_key: actionKey,
    payload: { class: "communicate.email.external", est_cost_usd: 0.02 },
  });
  assert.equal(result.ok, true);
}

// ===========================================================================
// requestState — pure derivation
// ===========================================================================

test("requestState: no request is `none`", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const derivation = requestState(records(unit), "task-042:chaser", at(1), 3_600_000);
  assert.equal(derivation.state, "none");
  assert.equal(derivation.requestSeq, null);
  assert.deepEqual(derivation.execution, { started: null, completed: null, failed: null });
});

test("requestState: requested, then each terminal decision", () => {
  for (const [verb, expected] of [
    ["grant", "granted"],
    ["reject", "rejected"],
  ] as const) {
    const unit = newCase();
    attest(unit);
    registerTask(unit);
    const requested = requestChaser(unit);

    const live = requestState(records(unit), "task-042:chaser", at(2), 3_600_000);
    assert.equal(live.state, "requested");
    assert.equal(live.requestSeq, requested.seq);
    assert.equal(live.requestTs, requested.ts);
    assert.equal(live.declared.class, "communicate.email.external");
    assert.equal(live.declared.est_cost_usd, 0.02);
    assert.equal(live.declared.reversible, false);

    const decided = decide(unit.logPath, "task-042:chaser", verb, "human:carter", at(3), unit.options);
    assert.equal(decided.ok, true, decided.ok ? "" : decided.message);

    const after_ = requestState(records(unit), "task-042:chaser", at(4), 3_600_000);
    assert.equal(after_.state, expected);
    assert.equal(after_.decision, expected);
    assert.equal(after_.decisionTs, at(3));
    assertClean(unit);
  }
});

test("requestState: revoked and expired states", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options).ok, true);
  assert.equal(decide(unit.logPath, "task-042:chaser", "revoke", "human:carter", at(3), unit.options).ok, true);
  assert.equal(requestState(records(unit), "task-042:chaser", at(4), 3_600_000).state, "revoked");

  const other = newCase();
  attest(other);
  registerTask(other);
  requestChaser(other);
  assert.equal(expire(other.logPath, "task-042:chaser", at(62), other.options).ok, true);
  const expired = requestState(records(other), "task-042:chaser", at(63), 3_600_000);
  assert.equal(expired.state, "expired");
  assert.equal(expired.expiredByEvent, true);
  assert.equal(expired.expiredLazily, false);
  assertClean(unit);
  assertClean(other);
});

test("requestState: lazy expiry and event expiry are equivalent", () => {
  const lazy = newCase();
  attest(lazy);
  registerTask(lazy);
  requestChaser(lazy);
  const lazyDerivation = requestState(records(lazy), "task-042:chaser", at(62), 3_600_000);
  assert.equal(lazyDerivation.state, "expired");
  assert.equal(lazyDerivation.expiredLazily, true);
  assert.equal(lazyDerivation.expiredByEvent, false);
  // No approval.expired event exists — the state is arithmetic on the request.
  assert.equal(eventTypes(lazy).includes("approval.expired"), false);

  const eventful = newCase();
  attest(eventful);
  registerTask(eventful);
  requestChaser(eventful);
  assert.equal(expire(eventful.logPath, "task-042:chaser", at(62), eventful.options).ok, true);
  const eventDerivation = requestState(records(eventful), "task-042:chaser", at(62), 3_600_000);

  assert.equal(lazyDerivation.state, eventDerivation.state);
  // EXACTLY at the TTL the request is still live: the comparison is strict
  // (`now > requestTs + ttl`), so the boundary instant belongs to the request —
  // the same half-open convention the budget window uses.
  assert.equal(requestState(records(lazy), "task-042:chaser", at(61), 3_600_000).state, "requested");
});

test("requestState: no TTL means no lapse", () => {
  const unit = newCase(POLICY_NO_TTL);
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  const derivation = requestState(records(unit), "task-042:chaser", at(10_000), null);
  assert.equal(derivation.state, "requested");
});

test("requestState: execution facts, and a re-request resets the cycle", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(decide(unit.logPath, "task-042:chaser", "reject", "human:carter", at(2), unit.options).ok, true);

  // Rejected is terminal for THAT request; a fresh request re-opens the cycle.
  const second = requestChaser(unit, at(3));
  const reopened = requestState(records(unit), "task-042:chaser", at(4), 3_600_000);
  assert.equal(reopened.state, "requested");
  assert.equal(reopened.requestSeq, second.seq);
  assert.equal(reopened.decision, null);

  assert.equal(decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(5), unit.options).ok, true);
  executionStarted(unit, "task-042:chaser", at(6));
  const executed = requestState(records(unit), "task-042:chaser", at(7), 3_600_000);
  assert.equal(executed.state, "granted");
  assert.notEqual(executed.execution.started, null);
  assertClean(unit);
});

// ===========================================================================
// register
// ===========================================================================

test("register appends task.registered carrying the declared actions", () => {
  const unit = newCase();
  const result = register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, T0, "agent:claude");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.record.event, "task.registered");
  assert.equal(result.record.task, "task-042");
  assert.equal(result.record.actor, "agent:claude");
  assert.deepEqual(result.record.payload, {
    actions: [
      {
        class: "communicate.email.external",
        idempotency_key: "task-042:chaser",
        summary: "Send deposit chaser",
        reversible: false,
        est_cost_usd: 0.02,
      },
    ],
    state: "proposed",
  });
  assertClean(unit);
});

test("register fails closed on an invalid envelope: nothing is appended", () => {
  const unit = newCase();
  const result = register(
    unit.logPath,
    { task: "task-042", envelope: { origin: { app: "cartsos" }, state: "proposed" } },
    T0,
    "agent:claude",
  );
  const refusal = asRefusal(result);
  assert.equal(refusal.code, "envelope-invalid");
  assert.ok((refusal.errors ?? []).length > 0);
  assert.deepEqual(records(unit), []);
});

test("register refuses an unknown envelope state before writing", () => {
  const unit = newCase();
  const refusal = asRefusal(
    register(
      unit.logPath,
      { task: "task-042", envelope: { ...ENVELOPE, state: "yolo" } },
      T0,
      "agent:claude",
    ),
  );
  assert.equal(refusal.code, "envelope-invalid");
  assert.deepEqual(records(unit), []);
});

test("register refuses a second registration of the same task id", () => {
  const unit = newCase();
  registerTask(unit);
  const refusal = asRefusal(
    register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, at(1), "agent:claude"),
  );
  assert.equal(refusal.code, "task-already-registered");
  assert.equal(records(unit).length, 1);
  assertClean(unit);
});

test("register refuses a system: actor", () => {
  const unit = newCase();
  const refusal = asRefusal(
    register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, T0, "system:daemon"),
  );
  assert.equal(refusal.code, "actor-invalid");
  assert.deepEqual(records(unit), []);
});

test("register reads the envelope from a task file's frontmatter", () => {
  const unit = newCase();
  const file = join(unit.dir, "task-042.md");
  writeFileSync(
    file,
    [
      "---",
      "id: task-042",
      "title: Chase deposit refund",
      "status: In Progress",
      "custom_board_key: kept",
      "approval:",
      "  origin:",
      "    app: cartsos",
      '    created_by: "human:carter"',
      "  state: proposed",
      "  actions:",
      "    - class: communicate.email.external",
      '      summary: "Send deposit chaser"',
      "      reversible: false",
      "      est_cost_usd: 0.02",
      '      idempotency_key: "task-042:chaser"',
      "---",
      "",
      "## Description",
      "Body text.",
      "",
    ].join("\n"),
    "utf8",
  );

  const before = readFileSync(file);
  const result = register(unit.logPath, { file }, T0, "agent:claude");
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.task, "task-042");
  assert.deepEqual(result.actions.map((action) => action.idempotency_key), ["task-042:chaser"]);
  // The task file is read-only to this milestone: not one byte moves.
  assert.ok(before.equals(readFileSync(file)), "register must not rewrite the task file");
  assertClean(unit);
});

test("register refuses a task file with no frontmatter, and one with no approval key", () => {
  const unit = newCase();
  const plain = join(unit.dir, "plain.md");
  writeFileSync(plain, "# Just markdown\n", "utf8");
  assert.equal(asRefusal(register(unit.logPath, { file: plain }, T0, "agent:x")).code, "envelope-invalid");

  const noEnvelope = join(unit.dir, "no-envelope.md");
  writeFileSync(noEnvelope, "---\nid: task-9\ntitle: x\n---\n\nbody\n", "utf8");
  assert.equal(
    asRefusal(register(unit.logPath, { file: noEnvelope }, T0, "agent:x")).code,
    "envelope-invalid",
  );

  assert.equal(
    asRefusal(register(unit.logPath, { file: join(unit.dir, "absent.md") }, T0, "agent:x")).code,
    "task-file-unreadable",
  );
  assert.deepEqual(records(unit), []);
});

test("registeredAction reads the declaration back out of the log", () => {
  const unit = newCase();
  registerTask(unit);
  const found = registeredAction(records(unit), "task-042", "task-042:chaser");
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.equal(found.action.class, "communicate.email.external");
  assert.equal(found.action.reversible, false);

  assert.equal(
    asRefusal(registeredAction(records(unit), "task-999", "k")).code,
    "not-registered",
  );
  assert.equal(
    asRefusal(registeredAction(records(unit), "task-042", "nope")).code,
    "action-not-registered",
  );
});

// ===========================================================================
// request
// ===========================================================================

test("request refuses when the policy has never been attested", () => {
  const unit = newCase();
  registerTask(unit);
  const refusal = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "policy-not-attested");
  assert.equal(refusal.detail, "not-attested");
  assert.deepEqual(eventTypes(unit), ["task.registered"]);
});

test("request refuses when the policy bytes changed since attestation", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  writeFileSync(unit.policyPath, `${POLICY}\n<!-- edited by something -->\n`, "utf8");
  const refusal = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "policy-not-attested");
  assert.equal(refusal.detail, "hash-mismatch");
  assert.equal(eventTypes(unit).includes("approval.requested"), false);
});

test("request on the manual path appends approval.requested with class and cost", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const record = requestChaser(unit);

  assert.equal(record.event, "approval.requested");
  assert.equal(record.actor, "agent:claude");
  assert.equal(record.action_key, "task-042:chaser");
  assert.deepEqual(record.payload, {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    summary: "Send deposit chaser",
    reversible: false,
  });
  assertClean(unit);
});

test("an undeclared cost is recorded as 0, per the budgets consumption contract", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const result = request(
    unit.logPath,
    { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.record === null) return;
  assert.equal((result.record.payload as Record<string, unknown>)["est_cost_usd"], 0);
});

test("supervised and autonomous actions emit NO approval.* events (amended §6.3)", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);

  for (const [cls, autonomy] of [
    ["read.web", "autonomous"],
    ["files.write.repo", "supervised"],
  ] as const) {
    const result = request(
      unit.logPath,
      { task: "task-042", actionKey: `task-042:${cls}`, cls, reversible: true },
      at(1),
      "agent:claude",
      unit.options,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.autonomy, autonomy);
    assert.equal(result.proceed, true);
    assert.equal(result.record, null);
  }

  // Scan the whole log: not one approval.* record exists.
  assert.deepEqual(
    eventTypes(unit).filter((event) => event.startsWith("approval.")),
    [],
  );
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered"]);
  assertClean(unit);
});

test("the irreversibility floor pulls an autonomous class back onto the manual path", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const result = request(
    unit.logPath,
    { task: "task-042", actionKey: "task-042:read", cls: "read.web", reversible: false },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.autonomy, "manual");
  assert.equal(result.proceed, false);
  assert.equal(result.resolution.floorApplied, true);
  assert.notEqual(result.record, null);
  assertClean(unit);
});

test("request refuses a duplicate live request, and an already-executed key", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  const duplicate = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(2),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(duplicate.code, "duplicate-request");
  assert.equal(duplicate.state, "requested");
  assert.equal(records(unit).length, 3);

  assert.equal(decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), unit.options).ok, true);
  executionStarted(unit, "task-042:chaser", at(4));

  const executed = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(5),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(executed.code, "already-executed");
  assert.equal(records(unit).length, 5);
  assertClean(unit);
});

test("request refuses a non-principal actor", () => {
  const unit = newCase();
  attest(unit);
  const refusal = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "k", cls: "communicate.email.external" },
      at(1),
      "system:gate",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "actor-invalid");
});

test("a failed budget appends budget.exceeded with the verdicts, and refuses", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);

  const refusal = asRefusal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:spend",
        cls: "financial.spend",
        est_cost_usd: 5,
        reversible: false,
      },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "budget-exceeded");
  assert.deepEqual(
    (refusal.verdicts ?? []).map((verdict) => verdict.limit),
    ["per_action_usd"],
  );

  const logged = records(unit);
  const last = logged[logged.length - 1] as EventRecord;
  assert.equal(last.event, "budget.exceeded");
  assert.equal(last.action_key, "task-042:spend");
  const payload = last.payload as Record<string, unknown>;
  assert.equal(payload["class"], "financial.spend");
  assert.equal(payload["est_cost_usd"], 5);
  assert.equal(payload["stage"], "request");
  assert.ok(Array.isArray(payload["verdicts"]));
  // No approval.requested was appended: the refusal is the whole outcome.
  assert.equal(eventTypes(unit).includes("approval.requested"), false);
  assertClean(unit);
});

// ===========================================================================
// decide
// ===========================================================================

test("grant appends approval.granted carrying class and est_cost_usd (budgets contract)", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  const result = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), {
    ...unit.options,
    note: "go, but cc me",
  });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;

  assert.equal(result.state, "granted");
  assert.equal(result.record.event, "approval.granted");
  assert.equal(result.record.actor, "human:carter");
  assert.equal(result.record.task, "task-042");
  // Exact payload: the budgets evaluator meters authorization from these fields,
  // and APRV-17 adds the minted token's digest — never the token itself.
  assert.deepEqual(result.record.payload, {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    note: "go, but cc me",
    token_sha256: tokenHash(result.token ?? ""),
  });
  assertClean(unit);
});

test("grant/reject/revoke are human-only", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  for (const actor of ["agent:claude", "system:gate", "carter"]) {
    const refusal = asRefusal(
      decide(unit.logPath, "task-042:chaser", "grant", actor, at(2), unit.options),
    );
    assert.equal(refusal.code, "actor-not-human");
  }
  assert.equal(eventTypes(unit).includes("approval.granted"), false);
});

test("decide refuses when there is nothing to decide", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const refusal = asRefusal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(1), unit.options),
  );
  assert.equal(refusal.code, "not-requested");
  assert.equal(refusal.state, "none");
});

test("a second decision is refused: grant after reject, and grant after grant", () => {
  const rejected = newCase();
  attest(rejected);
  registerTask(rejected);
  requestChaser(rejected);
  assert.equal(decide(rejected.logPath, "task-042:chaser", "reject", "human:carter", at(2), rejected.options).ok, true);
  const afterReject = asRefusal(
    decide(rejected.logPath, "task-042:chaser", "grant", "human:carter", at(3), rejected.options),
  );
  assert.equal(afterReject.code, "already-decided");
  assert.equal(afterReject.state, "rejected");
  assert.equal(eventTypes(rejected).filter((event) => event === "approval.granted").length, 0);

  const granted = newCase();
  attest(granted);
  registerTask(granted);
  requestChaser(granted);
  assert.equal(decide(granted.logPath, "task-042:chaser", "grant", "human:carter", at(2), granted.options).ok, true);
  const twice = asRefusal(
    decide(granted.logPath, "task-042:chaser", "grant", "human:carter", at(3), granted.options),
  );
  assert.equal(twice.code, "already-decided");
  assert.equal(eventTypes(granted).filter((event) => event === "approval.granted").length, 1);
  assertClean(rejected);
  assertClean(granted);
});

test("revoke is legal only on a granted, unexecuted request", () => {
  const live = newCase();
  attest(live);
  registerTask(live);
  requestChaser(live);
  const tooEarly = asRefusal(
    decide(live.logPath, "task-042:chaser", "revoke", "human:carter", at(2), live.options),
  );
  assert.equal(tooEarly.code, "not-granted");
  assert.equal(tooEarly.state, "requested");

  const executed = newCase();
  attest(executed);
  registerTask(executed);
  requestChaser(executed);
  assert.equal(decide(executed.logPath, "task-042:chaser", "grant", "human:carter", at(2), executed.options).ok, true);
  executionStarted(executed, "task-042:chaser", at(3));
  const tooLate = asRefusal(
    decide(executed.logPath, "task-042:chaser", "revoke", "human:carter", at(4), executed.options),
  );
  assert.equal(tooLate.code, "already-executed");
  assert.equal(eventTypes(executed).includes("approval.revoked"), false);
  assertClean(live);
  assertClean(executed);
});

test("a grant after the TTL is refused with `expired` even with no expired event in the log", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  // Precondition: the log carries no approval.expired at all.
  assert.equal(eventTypes(unit).includes("approval.expired"), false);

  const refusal = asRefusal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(62), unit.options),
  );
  assert.equal(refusal.code, "expired");
  assert.equal(refusal.state, "expired");
  assert.equal(eventTypes(unit).includes("approval.granted"), false);

  // The lazily-derived lapse was materialised, with the system actor.
  const logged = records(unit);
  const last = logged[logged.length - 1] as EventRecord;
  assert.equal(last.event, "approval.expired");
  assert.equal(last.actor, EXPIRY_ACTOR);
  assert.match(last.actor, /^system:/);
  assert.equal(refusal.record?.seq, last.seq);
  assertClean(unit);
});

test("a reject after the TTL is refused too, and the materialisation happens once", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(
    asRefusal(decide(unit.logPath, "task-042:chaser", "reject", "human:carter", at(62), unit.options)).code,
    "expired",
  );
  assert.equal(
    asRefusal(decide(unit.logPath, "task-042:chaser", "reject", "human:carter", at(63), unit.options)).code,
    "expired",
  );
  assert.equal(eventTypes(unit).filter((event) => event === "approval.expired").length, 1);
  assertClean(unit);
});

test("grant refuses on an attestation mismatch; reject and revoke do not", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  writeFileSync(unit.policyPath, `${POLICY}\n<!-- edited -->\n`, "utf8");

  const refusal = asRefusal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options),
  );
  assert.equal(refusal.code, "policy-not-attested");
  assert.equal(refusal.detail, "hash-mismatch");

  // Withdrawing authority must not be blocked by a changed policy file.
  const rejected = decide(unit.logPath, "task-042:chaser", "reject", "human:carter", at(3), unit.options);
  assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.message);
  assertClean(unit);
});

test("budgets are re-evaluated at grant time, appending budget.exceeded on failure", () => {
  const unit = newCase();
  attest(unit);
  register(unit.logPath, {
    task: "task-100",
    envelope: {
      origin: { app: "cartsos", created_by: "human:carter" },
      state: "proposed",
      actions: [
        { class: "physical.order", idempotency_key: "task-100:a" },
        { class: "physical.order", idempotency_key: "task-100:b" },
      ],
    },
  }, T0, "agent:claude");

  for (const key of ["task-100:a", "task-100:b"]) {
    const result = request(
      unit.logPath,
      { task: "task-100", actionKey: key, cls: "physical.order", est_cost_usd: 0 },
      at(1),
      "agent:claude",
      unit.options,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.message);
  }

  // daily_actions: 1 — the first grant consumes the class's whole allowance.
  assert.equal(decide(unit.logPath, "task-100:a", "grant", "human:carter", at(2), unit.options).ok, true);
  const refusal = asRefusal(
    decide(unit.logPath, "task-100:b", "grant", "human:carter", at(3), unit.options),
  );
  assert.equal(refusal.code, "budget-exceeded");
  assert.deepEqual((refusal.verdicts ?? []).map((verdict) => verdict.limit), ["daily_actions"]);

  const logged = records(unit);
  const last = logged[logged.length - 1] as EventRecord;
  assert.equal(last.event, "budget.exceeded");
  assert.equal((last.payload as Record<string, unknown>)["stage"], "grant");
  assert.equal(eventTypes(unit).filter((event) => event === "approval.granted").length, 1);
  assertClean(unit);
});

// ===========================================================================
// expire
// ===========================================================================

test("expire appends approval.expired with a system: actor and the on_expiry setting", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const requested = requestChaser(unit);

  const result = expire(unit.logPath, "task-042:chaser", at(62), unit.options);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.record.event, "approval.expired");
  assert.equal(result.record.actor, EXPIRY_ACTOR);
  assert.equal(result.record.task, "task-042");
  assert.deepEqual(result.record.payload, {
    requested_ts: requested.ts,
    ttl_ms: 3_600_000,
    on_expiry: "reject",
    class: "communicate.email.external",
  });
  assertClean(unit);
});

test("on_expiry: reject makes the expired state terminal for every verb", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(expire(unit.logPath, "task-042:chaser", at(62), unit.options).ok, true);

  for (const verb of ["grant", "reject", "revoke"] as const) {
    const refusal = asRefusal(
      decide(unit.logPath, "task-042:chaser", verb, "human:carter", at(63), unit.options),
    );
    assert.equal(refusal.code, "expired");
    assert.equal(refusal.state, "expired");
  }
  assert.equal(eventTypes(unit).filter((event) => event.startsWith("approval.")).length, 2);
  assertClean(unit);
});

test("expire refuses before the TTL lapses, and when the policy declares no TTL", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  const early = asRefusal(expire(unit.logPath, "task-042:chaser", at(30), unit.options));
  assert.equal(early.code, "not-expired");
  assert.equal(early.state, "requested");

  const untimed = newCase(POLICY_NO_TTL);
  attest(untimed);
  registerTask(untimed);
  requestChaser(untimed, at(1));
  const never = asRefusal(expire(untimed.logPath, "task-042:chaser", at(10_000), untimed.options));
  assert.equal(never.code, "not-expired");
  assert.match(never.message, /no defaults\.approval_ttl/u);
  assertClean(unit);
  assertClean(untimed);
});

test("expire refuses a decided request and a second expiry", () => {
  const decided = newCase();
  attest(decided);
  registerTask(decided);
  requestChaser(decided);
  assert.equal(decide(decided.logPath, "task-042:chaser", "grant", "human:carter", at(2), decided.options).ok, true);
  assert.equal(
    asRefusal(expire(decided.logPath, "task-042:chaser", at(62), decided.options)).code,
    "already-decided",
  );

  const twice = newCase();
  attest(twice);
  registerTask(twice);
  requestChaser(twice);
  assert.equal(expire(twice.logPath, "task-042:chaser", at(62), twice.options).ok, true);
  assert.equal(
    asRefusal(expire(twice.logPath, "task-042:chaser", at(63), twice.options)).code,
    "already-decided",
  );
  assert.equal(eventTypes(twice).filter((event) => event === "approval.expired").length, 1);

  const missing = newCase();
  attest(missing);
  assert.equal(
    asRefusal(expire(missing.logPath, "task-042:chaser", at(62), missing.options)).code,
    "not-requested",
  );
  assertClean(decided);
  assertClean(twice);
});

// ===========================================================================
// Log-reading refusals
// ===========================================================================

test("a torn tail is refused with its own code, and nothing is appended", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  // Simulate a crashed write by appending an unterminated line to the file.
  // (Not a mutation of an existing record: the log's bytes are only extended,
  // exactly as a killed writer would leave them.)
  const before = readFileSync(unit.logPath, "utf8");
  writeFileSync(unit.logPath, `${before}{"seq":3,"ts":"2026`, "utf8");

  const refusal = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "log-torn-tail");
  assert.equal(readFileSync(unit.logPath, "utf8"), `${before}{"seq":3,"ts":"2026`);
});

test("a full manual lifecycle leaves the chain clean and the states in order", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options).ok, true);
  executionStarted(unit, "task-042:chaser", at(3));
  assert.equal(
    appendEvent(unit.logPath, {
      ts: at(4),
      event: "execution.completed",
      actor: "agent:claude",
      task: "task-042",
      action_key: "task-042:chaser",
    }).ok,
    true,
  );

  assert.deepEqual(eventTypes(unit), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
    "execution.started",
    "execution.completed",
  ]);
  const derivation = requestState(records(unit), "task-042:chaser", at(5), 3_600_000);
  assert.equal(derivation.state, "granted");
  assert.notEqual(derivation.execution.completed, null);
  assertClean(unit);
});

test("the refusal-code union is frozen public API", () => {
  // Agents branch on these strings; adding one is a spec change and renaming
  // one is a breaking change, so the list is pinned here rather than assumed.
  assert.deepEqual([...GATE_REFUSAL_CODES], [
    "policy-not-attested",
    "envelope-invalid",
    "task-file-unreadable",
    "task-already-registered",
    "not-registered",
    "action-not-registered",
    "duplicate-request",
    "already-executed",
    "budget-exceeded",
    // APRV-18 added this one: SPEC.md §10.2 loop safety, refused at intake for
    // the non-manual paths only. An addition to the union, not a rename.
    "loop-escalated",
    "not-requested",
    "already-decided",
    "not-granted",
    "expired",
    "not-expired",
    "actor-invalid",
    "actor-not-human",
    "log-unreadable",
    "log-torn-tail",
    "append-failed",
  ]);
});
