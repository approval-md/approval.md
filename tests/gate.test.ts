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
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  appendAttestation,
  consumeHarnessGrant,
  decide,
  expire,
  register,
  request,
  withdraw,
} from "./clock-adapters.js";
import {
  EXPIRY_ACTOR,
  findHarnessCarry,
  GATE_REFUSAL_CODES,
  registeredAction,
  requestState,
  type GateOptions,
  type GateRefusal,
} from "../src/core/gate.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { tokenHash } from "../src/core/token.js";
import { verify } from "../src/core/verify.js";
import { canonicalRender } from "../src/core/wysiwys.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-gate-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

/**
 * A stand-in content binding (amended SPEC.md §6.2, A1).
 *
 * Every manual action needs one: intake refuses `payload-hash-required` without
 * it, because a grant binds to bytes. The value here is an arbitrary 64-hex
 * digest — these suites test the gate's handling of the binding, not the hash
 * function, which `tests/payload.test.ts` covers.
 */
const PAYLOAD_HASH = "1".repeat(64);

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
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
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

/**
 * Register `task-042` declaring one action per key, each bound to
 * {@link PAYLOAD_HASH}.
 *
 * SPEC.md §7 as APRV-147 enforces it: intake refuses an action the log has not
 * declared, so a manual scenario asking about a key other than the canonical
 * chaser declares it here first.
 */
function registerKeys(unit: Case, keys: readonly string[], ts: string = T0): EventRecord {
  const result = register(
    unit.logPath,
    {
      task: "task-042",
      envelope: {
        ...ENVELOPE,
        actions: keys.map((key) => ({ ...ENVELOPE.actions[0], idempotency_key: key })),
      },
    },
    ts,
    "agent:claude",
  );
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
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
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
    payload: { class: "communicate.email.external", est_cost_usd: "0.02" },
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
    assert.equal(live.declared.est_cost_usd, "0.02");
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
        est_cost_usd: "0.02",
        payload_hash: PAYLOAD_HASH,
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
    { task: "task-042", envelope: { origin: { app: "example-capture" }, state: "proposed" } },
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

// APRV-138: an idempotency_key is the global identity of one side effect and
// cannot be re-declared under a second task. The exploit these guard is a
// weaker registration (reversible flipped true) shadowing the first at execute
// time, which would disable the irreversibility floor.
test("register refuses a cross-task reuse of an idempotency_key, floor-flip and all", () => {
  const unit = newCase();
  registerTask(unit); // task-042 declares task-042:chaser, reversible:false
  const shadow = {
    ...ENVELOPE,
    actions: [{ ...ENVELOPE.actions[0], reversible: true }],
  };
  const refusal = asRefusal(
    register(unit.logPath, { task: "task-099", envelope: shadow }, at(1), "agent:mallory"),
  );
  assert.equal(refusal.code, "task-already-registered");
  assert.match(refusal.message, /task-042:chaser/u);
  assert.equal(records(unit).length, 1, "the shadow registration must not be appended");
  assertClean(unit);
});

test("register refuses a whole multi-action envelope when any one key collides", () => {
  const unit = newCase();
  registerTask(unit); // task-042 owns task-042:chaser
  const mixed = {
    ...ENVELOPE,
    actions: [
      { ...ENVELOPE.actions[0], idempotency_key: "task-099:fresh" },
      { ...ENVELOPE.actions[0], idempotency_key: "task-042:chaser" }, // collides
    ],
  };
  const refusal = asRefusal(
    register(unit.logPath, { task: "task-099", envelope: mixed }, at(1), "agent:mallory"),
  );
  assert.equal(refusal.code, "task-already-registered");
  assert.equal(records(unit).length, 1, "all-or-nothing: the fresh key must not land either");
  assertClean(unit);
});

test("register still admits a distinct key under a different task", () => {
  const unit = newCase();
  registerTask(unit);
  const other = {
    ...ENVELOPE,
    actions: [{ ...ENVELOPE.actions[0], idempotency_key: "task-099:fresh" }],
  };
  const result = register(unit.logPath, { task: "task-099", envelope: other }, at(1), "agent:claude");
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.equal(records(unit).length, 2);
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
      "    app: example-capture",
      '    created_by: "human:carter"',
      "  state: proposed",
      "  actions:",
      "    - class: communicate.email.external",
      '      summary: "Send deposit chaser"',
      "      reversible: false",
      '      est_cost_usd: "0.02"',
      '      idempotency_key: "task-042:chaser"',
      `      payload_hash: "${PAYLOAD_HASH}"`,
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
      { task: "task-042", actionKey: "task-042:chaser", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
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
      { task: "task-042", actionKey: "task-042:chaser", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
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
    est_cost_usd: "0.02",
    payload_hash: PAYLOAD_HASH,
    summary: "Send deposit chaser",
    reversible: false,
    // APRV-118: the attested policy this request was routed by, stamped at the
    // write boundary.
    policy_sha256: policySha256(unit),
  });
  assertClean(unit);
});

test("an undeclared cost is recorded as 0, per the budgets consumption contract", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const result = request(
    unit.logPath,
    { task: "task-042", actionKey: "task-042:chaser", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.record === null) return;
  assert.equal((result.record.payload as Record<string, unknown>)["est_cost_usd"], "0");
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
  // Declared, because the floor lands this on the manual path and APRV-147
  // checks the declaration there.
  registerKeys(unit, ["task-042:read"]);
  const result = request(
    unit.logPath,
    { task: "task-042", actionKey: "task-042:read", payload_hash: PAYLOAD_HASH, cls: "read.web", reversible: false },
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

// ===========================================================================
// Intake checks the declaration (APRV-147, SPEC.md §7)
// ===========================================================================

/** The operator-held secret's variable NAME, test-scoped and never exported. */
const LIVE_SECRET_ENV = "APPROVAL_TEST_GATE_LIVE_SECRET";
const LIVE_ENV: NodeJS.ProcessEnv = { [LIVE_SECRET_ENV]: "operator-held-secret-never-in-the-log" };

/** {@link POLICY} with `files.write.*` supervised live at `rate`. */
function livePolicy(rate: string): string {
  return POLICY.replace(
    "classes:\n",
    `audit:\n  supervised_sample_rate: 1\n  sampling_secret_env: ${LIVE_SECRET_ENV}\nclasses:\n`,
  ).replace(
    "  files.write.*:\n    autonomy: supervised\n",
    `  files.write.*:\n    autonomy: supervised-live\n    live_rate: ${rate}\n`,
  );
}

test("a manual request for an unregistered task is refused, and nothing is appended", () => {
  const unit = newCase();
  attest(unit);
  const before = records(unit).length;
  const refusal = asRefusal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:chaser",
        // The caller names its own binding, which is exactly the shape APRV-147
        // closes: before it, this recorded an approval.requested for a class the
        // log never saw declared, and a human was asked to approve it.
        payload_hash: PAYLOAD_HASH,
        cls: "communicate.email.external",
        est_cost_usd: "0.02",
        reversible: false,
      },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "not-registered");
  assert.equal(records(unit).length, before);
  assert.equal(eventTypes(unit).includes("approval.requested"), false);
  assertClean(unit);
});

test("a registered task with an undeclared action key is refused action-not-registered", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const before = records(unit).length;
  const refusal = asRefusal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:undeclared",
        payload_hash: PAYLOAD_HASH,
        cls: "communicate.email.external",
      },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "action-not-registered");
  assert.equal(records(unit).length, before);
  assertClean(unit);
});

test("an unregistered task hears not-registered, never payload-hash-required", () => {
  // The order pin. With no hash anywhere — none declared, because there is no
  // declaration, and none supplied — the missing binding is a consequence of the
  // missing registration, so the refusal names the cause and not the symptom.
  const unit = newCase();
  attest(unit);
  const refusal = asRefusal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "not-registered");
  assert.deepEqual(eventTypes(unit), ["policy.updated"]);
});

test("a supervised-live class refuses an unregistered task at every rate: the draw never runs", () => {
  // The no-re-roll closure. The live fraction is drawn over the payload hash, so
  // an unregistered action drawing over a hash the CALLER chose could be
  // re-presented until the draw came up unsampled. At a rate this small
  // essentially nothing is selected, so before APRV-147 this call returned
  // `proceed: true` with a `not-selected` verdict; the refusal below is the
  // evidence that the declaration check runs before `liveVerdict` is consulted
  // at all.
  for (const rate of ["0.0000001", "0.5", "1"]) {
    const unit = newCase(livePolicy(rate));
    attest(unit);
    // The scenario is only worth anything if the class really is live: a policy
    // that failed to load would fail closed to manual and refuse for a reason
    // that has nothing to do with the draw.
    const load = loadPolicy({ file: unit.policyPath });
    assert.equal(load.ok, true, `rate ${rate} did not load`);
    const resolution = resolve(load, "files.write.repo", { reversible: true });
    assert.equal(resolution.autonomy, "supervised", `rate ${rate} is not supervised`);
    assert.equal(resolution.supervision, "live", `rate ${rate} is not live`);

    const result = request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:draft",
        payload_hash: PAYLOAD_HASH,
        cls: "files.write.repo",
        reversible: true,
      },
      at(1),
      "agent:claude",
      { ...unit.options, env: LIVE_ENV },
    );
    const refusal = asRefusal(result);
    assert.equal(refusal.code, "not-registered", `rate ${rate} did not refuse`);
    assert.deepEqual(eventTypes(unit), ["policy.updated"], `rate ${rate} appended something`);
    assertClean(unit);
  }
});

test("a registered manual request is still recorded exactly as before", () => {
  // The other side of the check: the ordinary flow is untouched, so the record a
  // declared action produces is the record it always produced.
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const record = requestChaser(unit);
  assert.equal(record.event, "approval.requested");
  assert.deepEqual(record.payload, {
    class: "communicate.email.external",
    est_cost_usd: "0.02",
    payload_hash: PAYLOAD_HASH,
    summary: "Send deposit chaser",
    reversible: false,
    policy_sha256: policySha256(unit),
  });
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered", "approval.requested"]);
  assertClean(unit);
});

test("a declaration with no payload_hash still accepts the caller's fallback", () => {
  // Behaviour APRV-147 preserves rather than adds to: where the registration
  // declared no binding there is nothing for the log's declaration to win with,
  // and the caller's hash is taken on the terms it always was — but only now
  // that a registration exists to be taken on behalf of.
  const unit = newCase();
  attest(unit);
  const unbound = { ...ENVELOPE.actions[0] };
  delete (unbound as Record<string, unknown>)["payload_hash"];
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: { ...ENVELOPE, actions: [unbound] } },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const caller = "7".repeat(64);
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      payload_hash: caller,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
    },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok || result.record === null) throw new Error("expected an approval.requested record");
  assert.equal((result.record.payload as Record<string, unknown>)["payload_hash"], caller);
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
      { task: "task-042", actionKey: "task-042:chaser", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
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
      { task: "task-042", actionKey: "task-042:chaser", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
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
      { task: "task-042", actionKey: "k", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
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
  registerKeys(unit, ["task-042:spend"]);

  const refusal = asRefusal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:spend",
        payload_hash: PAYLOAD_HASH,
        cls: "financial.spend",
        est_cost_usd: "5",
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
  assert.equal(payload["est_cost_usd"], "5");
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
    est_cost_usd: "0.02",
    // A1: the grant copies the request's content binding, so the token is bound
    // to the request, its key, AND the bytes.
    payload_hash: PAYLOAD_HASH,
    note: "go, but cc me",
    token_sha256: tokenHash(result.token ?? ""),
    // APRV-118: the attested policy the approver decided under, checked against
    // the request's before anything was appended.
    policy_sha256: policySha256(unit),
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
      origin: { app: "example-capture", created_by: "human:carter" },
      state: "proposed",
      actions: [
        { class: "physical.order", idempotency_key: "task-100:a", payload_hash: PAYLOAD_HASH },
        { class: "physical.order", idempotency_key: "task-100:b", payload_hash: PAYLOAD_HASH },
      ],
    },
  }, T0, "agent:claude");

  for (const key of ["task-100:a", "task-100:b"]) {
    const result = request(
      unit.logPath,
      { task: "task-100", actionKey: key, payload_hash: PAYLOAD_HASH, cls: "physical.order", est_cost_usd: "0" },
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
      { task: "task-042", actionKey: "task-042:chaser", payload_hash: PAYLOAD_HASH, cls: "communicate.email.external" },
      at(1),
      "agent:claude",
      unit.options,
    ),
  );
  assert.equal(refusal.code, "log-torn-tail");
  assert.equal(readFileSync(unit.logPath, "utf8"), `${before}{"seq":3,"ts":"2026`);
});

test("a forged record is refused log-corrupt: the gate verifies what it reads", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  // The attacker rewrites a record's payload in place. The line is still valid
  // JSON and still schema-valid — only its digest no longer matches, which is
  // precisely what a JSON-parsing reader could not see and a verifying one can.
  const lines = readFileSync(unit.logPath, "utf8").split("\n");
  const forged = JSON.parse(lines[2] as string) as Record<string, unknown>;
  forged["payload"] = { class: "communicate.email.external", est_cost_usd: "999" };
  lines[2] = JSON.stringify(forged);
  writeFileSync(unit.logPath, lines.join("\n"), "utf8");
  const before = readFileSync(unit.logPath, "utf8");

  const refusal = asRefusal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options),
  );
  assert.equal(refusal.code, "log-corrupt");
  assert.match(refusal.message, /does not verify/);
  assert.match(refusal.message, /hash-mismatch/);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "nothing was appended");
});

test("a decision appended between the gate's read and its write is refused head-moved", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  // Stand in for the interleaving: the gate's own append path is exercised
  // directly with the head the gate would have read one record ago.
  const all = records(unit);
  const stale = all[all.length - 2] as EventRecord;
  const result = appendEvent(
    unit.logPath,
    {
      ts: at(2),
      event: "approval.granted",
      actor: "human:carter",
      task: "task-042",
      action_key: "task-042:chaser",
      payload: { class: "communicate.email.external", est_cost_usd: "0.02" },
    },
    { expectedHead: { seq: stale.seq, hash: stale.hash } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "head-moved");
  assertClean(unit);
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

// ===========================================================================
// withdraw (APRV-106)
// ===========================================================================

test("withdraw: the requester retracts its own pending request", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  const result = withdraw(unit.logPath, "task-042:chaser", "agent:claude", at(2), {
    ...unit.options,
    reason: "timeout",
    note: "the wait elapsed",
  });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.record.event, "approval.withdrawn");
  assert.equal(result.record.actor, "agent:claude");
  assert.equal(result.record.task, "task-042");
  assert.deepEqual(result.record.payload, {
    action_key: "task-042:chaser",
    reason: "timeout",
    note: "the wait elapsed",
  });

  // Terminal, and derived as such from the log alone.
  assert.equal(
    requestState(records(unit), "task-042:chaser", at(3), 3_600_000).state,
    "withdrawn",
  );
  assertClean(unit);
});

test("withdraw: only the requester may, and anyone else is not-requester", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  // A human, an approver even, is still not the party that asked.
  const stranger = asRefusal(
    withdraw(unit.logPath, "task-042:chaser", "human:carter", at(2), unit.options),
  );
  assert.equal(stranger.code, "not-requester");
  assert.match(stranger.message, /reject it/u);

  // A different agent is refused for exactly the same reason: if any actor
  // could withdraw, the approver's queue would be clearable by whoever reached
  // the log first.
  assert.equal(
    asRefusal(withdraw(unit.logPath, "task-042:chaser", "agent:mallory", at(2), unit.options)).code,
    "not-requester",
  );

  // Nothing was appended by either attempt.
  assert.equal(eventTypes(unit).filter((event) => event === "approval.withdrawn").length, 0);
  assert.equal(
    requestState(records(unit), "task-042:chaser", at(2), 3_600_000).state,
    "requested",
  );
  assertClean(unit);
});

test("withdraw: system: is refused before the log is even read", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  const refusal = asRefusal(
    withdraw(unit.logPath, "task-042:chaser", "system:gate", at(2), unit.options),
  );
  assert.equal(refusal.code, "actor-invalid");
  assert.match(refusal.message, /TTL/u);
  assertClean(unit);
});

test("withdraw: a decided request is already-decided, and a second withdrawal is terminal", () => {
  const granted = newCase();
  attest(granted);
  registerTask(granted);
  requestChaser(granted);
  assert.equal(
    decide(granted.logPath, "task-042:chaser", "grant", "human:carter", at(2), granted.options).ok,
    true,
  );
  const late = asRefusal(
    withdraw(granted.logPath, "task-042:chaser", "agent:claude", at(3), granted.options),
  );
  assert.equal(late.code, "already-decided");
  assert.match(late.message, /erase the answer/u);
  assertClean(granted);

  const twice = newCase();
  attest(twice);
  registerTask(twice);
  requestChaser(twice);
  assert.equal(
    withdraw(twice.logPath, "task-042:chaser", "agent:claude", at(2), twice.options).ok,
    true,
  );
  assert.equal(
    asRefusal(withdraw(twice.logPath, "task-042:chaser", "agent:claude", at(3), twice.options)).code,
    "request-withdrawn",
  );
  assert.equal(
    eventTypes(twice).filter((event) => event === "approval.withdrawn").length,
    1,
    "a refused second withdrawal must append nothing",
  );
  assertClean(twice);
});

test("withdraw: an unrequested key is not-requested and a lapsed one is expired", () => {
  const never = newCase();
  attest(never);
  registerTask(never);
  assert.equal(
    asRefusal(withdraw(never.logPath, "task-042:chaser", "agent:claude", at(2), never.options)).code,
    "not-requested",
  );
  assertClean(never);

  // Expiry is judged from the request's own ts, exactly as `decide` judges it,
  // and the lapse is materialised on the way past.
  const lapsed = newCase();
  attest(lapsed);
  registerTask(lapsed);
  requestChaser(lapsed);
  const refusal = asRefusal(
    withdraw(lapsed.logPath, "task-042:chaser", "agent:claude", at(200), lapsed.options),
  );
  assert.equal(refusal.code, "expired");
  assert.equal(refusal.record?.event, "approval.expired");
  assert.equal(refusal.record?.actor, EXPIRY_ACTOR);
  assertClean(lapsed);
});

test("withdraw: every decision afterwards is refused request-withdrawn", () => {
  for (const decision of ["grant", "reject", "revoke"] as const) {
    const unit = newCase();
    attest(unit);
    registerTask(unit);
    requestChaser(unit);
    assert.equal(
      withdraw(unit.logPath, "task-042:chaser", "agent:claude", at(2), unit.options).ok,
      true,
    );
    const refusal = asRefusal(
      decide(unit.logPath, "task-042:chaser", decision, "human:carter", at(3), unit.options),
    );
    assert.equal(refusal.code, "request-withdrawn", `${decision} should refuse request-withdrawn`);
    assert.equal(refusal.state, "withdrawn");
    // Nothing was recorded: a late grant on a withdrawn request would be an
    // authorization with no process left to consume it.
    assert.equal(
      eventTypes(unit).filter((event) => event.startsWith("approval.")).length,
      2,
      "requested + withdrawn, and nothing else",
    );
    assertClean(unit);
  }
});

test("withdraw: a re-request after a withdrawal starts a fresh, decidable cycle", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(
    withdraw(unit.logPath, "task-042:chaser", "agent:claude", at(2), unit.options).ok,
    true,
  );
  // The request cycle resets, so the same key can be asked about again — which
  // is exactly what a retried tool call does.
  requestChaser(unit, at(3));
  assert.equal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(4), unit.options).ok,
    true,
  );
  assert.equal(requestState(records(unit), "task-042:chaser", at(5), 3_600_000).state, "granted");
  assertClean(unit);
});

// ===========================================================================
// harness-executed requests mint no token (APRV-106)
// ===========================================================================

test("a harness-executed request is granted completely and mints no token", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
      execution: "harness",
      wait_until: at(10),
    },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);

  const granted = decide(
    unit.logPath,
    "task-042:chaser",
    "grant",
    "human:carter",
    at(2),
    unit.options,
  );
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");

  // No token was returned to the caller and no digest reached the log: the
  // hook answers allow/deny and the harness runs the command, so a minted token
  // would be a live credential with no spender.
  assert.equal(granted.token, undefined, "a harness-executed grant must mint no token");
  const payload = granted.record.payload as Record<string, unknown>;
  assert.equal(payload["token_sha256"], undefined);
  assert.equal(payload["execution"], "harness");

  // Still a COMPLETE grant: the budgets contract and the content binding are
  // recorded exactly as they are for a token-bearing one.
  assert.equal(payload["class"], "communicate.email.external");
  assert.equal(payload["est_cost_usd"], "0.02");
  assert.equal(payload["payload_hash"], PAYLOAD_HASH);
  assert.equal(requestState(records(unit), "task-042:chaser", at(3), 3_600_000).state, "granted");
  assertClean(unit);
});

// ===========================================================================
// harness grant carryover (APRV-117)
// ===========================================================================

/** Register, request `execution: "harness"`, and grant, all through the gate. */
function harnessGrant(unit: Case, requestedAt = at(1), decidedAt = at(2)): void {
  attest(unit);
  registerTask(unit);
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
      execution: "harness",
    },
    requestedAt,
    "agent:claude",
    unit.options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);
  const granted = decide(
    unit.logPath,
    "task-042:chaser",
    "grant",
    "human:carter",
    decidedAt,
    unit.options,
  );
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
}

test("a harness grant is consumed once, and the second consumer is refused", () => {
  const unit = newCase();
  harnessGrant(unit);

  const first = consumeHarnessGrant(
    unit.logPath,
    "task-042:chaser",
    "agent:claude",
    at(3),
    unit.options,
  );
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  if (!first.ok) throw new Error("unreachable");
  assert.equal(first.record.event, "execution.started");
  // The marker says why no completion will ever follow it: the harness ran the
  // command and this runtime never learns the outcome.
  const payload = first.record.payload as Record<string, unknown>;
  assert.equal(payload["execution"], "harness");
  assert.equal(payload["class"], "communicate.email.external");
  assert.equal(payload["est_cost_usd"], "0.02");
  assert.equal(payload["payload_hash"], PAYLOAD_HASH);

  const second = consumeHarnessGrant(
    unit.logPath,
    "task-042:chaser",
    "agent:claude",
    at(4),
    unit.options,
  );
  assert.equal(second.ok, false);
  if (second.ok) throw new Error("unreachable");
  assert.equal(second.code, "already-executed");
  assert.deepEqual(
    eventTypes(unit).filter((event) => event === "execution.started"),
    ["execution.started"],
  );
  assertClean(unit);
});

test("a token-bearing grant cannot be consumed as a harness grant", () => {
  // The property: one authorization, one spender. If a harness could proceed on
  // an ordinary grant, the token minted for it would still be live and the same
  // approval would have authorized two different executions.
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options).ok,
    true,
  );

  const spent = consumeHarnessGrant(
    unit.logPath,
    "task-042:chaser",
    "agent:claude",
    at(3),
    unit.options,
  );
  assert.equal(spent.ok, false);
  if (spent.ok) throw new Error("unreachable");
  assert.equal(spent.code, "not-granted");
  assert.ok(!eventTypes(unit).includes("execution.started"));
  assertClean(unit);
});

test("a harness grant is not consumable past its request's TTL", () => {
  // An approval's shelf life is its parent request's TTL — the rule
  // `core/token.ts` applies to a token-bearing grant, applied here to the grant
  // that mints no token.
  const unit = newCase();
  harnessGrant(unit);
  const late = consumeHarnessGrant(
    unit.logPath,
    "task-042:chaser",
    "agent:claude",
    at(62),
    unit.options,
  );
  assert.equal(late.ok, false);
  if (late.ok) throw new Error("unreachable");
  assert.equal(late.code, "expired");
  assertClean(unit);
});

test("a pending harness request is not consumable", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  assert.equal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:chaser",
        payload_hash: PAYLOAD_HASH,
        cls: "communicate.email.external",
        summary: "Send deposit chaser",
        execution: "harness",
      },
      at(1),
      "agent:claude",
      unit.options,
    ).ok,
    true,
  );
  const early = consumeHarnessGrant(
    unit.logPath,
    "task-042:chaser",
    "agent:claude",
    at(2),
    unit.options,
  );
  assert.equal(early.ok, false);
  if (early.ok) throw new Error("unreachable");
  assert.equal(early.code, "not-granted");
  assertClean(unit);
});

test("findHarnessCarry: the bounds are bytes, class, harness, unspent, live", () => {
  const unit = newCase();
  harnessGrant(unit);
  const live = records(unit);
  const ttl = 3_600_000;

  // The grant carries: same hash, same class, unspent, inside the TTL.
  const carry = findHarnessCarry(live, PAYLOAD_HASH, "communicate.email.external", at(3), ttl);
  assert.equal(carry?.actionKey, "task-042:chaser");
  assert.equal(carry?.kind, "granted");

  // Different bytes, different class, and past the TTL each carry nothing.
  assert.equal(
    findHarnessCarry(live, "2".repeat(64), "communicate.email.external", at(3), ttl),
    null,
  );
  assert.equal(findHarnessCarry(live, PAYLOAD_HASH, "financial.spend", at(3), ttl), null);
  assert.equal(
    findHarnessCarry(live, PAYLOAD_HASH, "communicate.email.external", at(62), ttl),
    null,
  );

  // And once spent, it carries nothing either.
  assert.equal(
    consumeHarnessGrant(unit.logPath, "task-042:chaser", "agent:claude", at(3), unit.options).ok,
    true,
  );
  assert.equal(
    findHarnessCarry(records(unit), PAYLOAD_HASH, "communicate.email.external", at(4), ttl),
    null,
  );
  assertClean(unit);
});

test("findHarnessCarry ignores a request that is not harness-executed", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  assert.equal(
    findHarnessCarry(records(unit), PAYLOAD_HASH, "communicate.email.external", at(2), 3_600_000),
    null,
  );
  assertClean(unit);
});

test("findHarnessCarry offers a pending request for adoption", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  assert.equal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:chaser",
        payload_hash: PAYLOAD_HASH,
        cls: "communicate.email.external",
        summary: "Send deposit chaser",
        execution: "harness",
      },
      at(1),
      "agent:claude",
      unit.options,
    ).ok,
    true,
  );
  const carry = findHarnessCarry(
    records(unit),
    PAYLOAD_HASH,
    "communicate.email.external",
    at(2),
    3_600_000,
  );
  assert.equal(carry?.kind, "pending");
  assert.equal(carry?.actionKey, "task-042:chaser");

  // A withdrawn request offers nothing: it is terminal, and nothing will ever
  // be granted on it.
  assert.equal(
    withdraw(unit.logPath, "task-042:chaser", "agent:claude", at(3), unit.options).ok,
    true,
  );
  assert.equal(
    findHarnessCarry(records(unit), PAYLOAD_HASH, "communicate.email.external", at(4), 3_600_000),
    null,
  );
  assertClean(unit);
});

test("an ordinary request is unaffected: it still mints and records a token", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);
  const granted = decide(
    unit.logPath,
    "task-042:chaser",
    "grant",
    "human:carter",
    at(2),
    unit.options,
  );
  assert.equal(granted.ok, true);
  if (!granted.ok) throw new Error("unreachable");
  assert.match(String(granted.token), /^[a-f0-9]{64}$/u);
  assert.equal(
    (granted.record.payload as Record<string, unknown>)["token_sha256"],
    tokenHash(granted.token as string),
  );
  assertClean(unit);
});

test("the refusal-code union is frozen public API", () => {
  // Agents branch on these strings; adding one is a spec change and renaming
  // one is a breaking change, so the list is pinned here rather than assumed.
  assert.deepEqual([...GATE_REFUSAL_CODES], [
    "policy-not-attested",
    // APRV-118: the request pins the attested policy hash, and a grant under a
    // different attested policy is refused rather than recorded. An addition,
    // and deliberately not folded into `policy-not-attested`: that code says the
    // live file is unverified, this one says it is verified and is a different
    // file from the one the request was routed by.
    "policy-drift",
    "envelope-invalid",
    "task-file-unreadable",
    "task-already-registered",
    // APRV-63: a file with no envelope whose task the LOG registered has lost
    // one, and reads as an ordinary envelope-less task without a code of its
    // own. An addition to the union, not a rename.
    "envelope-missing",
    "not-registered",
    "action-not-registered",
    "duplicate-request",
    "already-executed",
    "budget-exceeded",
    // APRV-20 pass two, amendment A1: a manual action must bind to bytes, and
    // the schema cannot know autonomy, so intake enforces it. An addition.
    "payload-hash-required",
    // APRV-28, the payload store: two additions on the intake path, both about
    // material the caller supplied. `payload-mismatch` is the same word
    // `core/token.ts` uses at spend time, for the same reason — the bytes are
    // not the bytes the action declared — and `payload-store-failed` is the
    // filesystem's half, which fails closed rather than requesting anyway.
    "payload-mismatch",
    "payload-store-failed",
    // APRV-20 pass two: the grant path used to substitute an empty class and
    // record the authorization anyway. Its own code now.
    "grant-classless-request",
    // APRV-18 added this one: SPEC.md §10.2 loop safety, refused at intake for
    // the non-manual paths only. An addition to the union, not a rename.
    "loop-escalated",
    "not-requested",
    "already-decided",
    "not-granted",
    // APRV-106, both additions. `request-withdrawn` is the requester's
    // retraction seen from the decision side ("nobody answered and nobody can
    // now"), deliberately not folded into `already-decided`, which says the
    // opposite ("somebody answered and the answer stands"). `not-requester`
    // guards the retraction itself: if any actor could withdraw, the approver's
    // queue would be clearable by whoever reached the log first.
    "request-withdrawn",
    "not-requester",
    "expired",
    "not-expired",
    "actor-invalid",
    "actor-not-human",
    "log-unreadable",
    "log-torn-tail",
    // APRV-20 finding S1: the gate verifies the chain before it derives anything
    // from it, so "the log does not verify" needs a code of its own. An addition
    // to the union, not a rename.
    "log-corrupt",
    "append-failed",
  ]);
});

// ===========================================================================
// policy pinning (APRV-118)
// ===========================================================================

/** The same policy with a longer TTL: different bytes, different hash. */
const POLICY_EDITED = POLICY.replace('  approval_ttl: "1h"', '  approval_ttl: "4h"');

/** The SHA-256 of the live policy file's exact bytes — what attestation records. */
function policySha256(unit: Case): string {
  return createHash("sha256").update(readFileSync(unit.policyPath)).digest("hex");
}

function payloadFieldOf(record: EventRecord, field: string): unknown {
  return (record.payload as Record<string, unknown> | undefined)?.[field];
}

test("request and grant pin the attested policy hash", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const sha = policySha256(unit);

  const requested = requestChaser(unit);
  assert.equal(payloadFieldOf(requested, "policy_sha256"), sha);

  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  assert.equal(payloadFieldOf(granted.record, "policy_sha256"), sha);
  assertClean(unit);
});

test("the pinned hash is the runtime's, never the caller's", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);

  // `RequestInput` has no `policy_sha256` field, which is the compile-level half
  // of the guarantee — the same structural refusal amended SPEC.md §8 (A2) gives
  // caller-supplied timestamps. This cast reaches past the type to prove the
  // runtime half: a value that arrives anyway is not what gets recorded.
  const smuggled = {
    task: "task-042",
    actionKey: "task-042:chaser",
    payload_hash: PAYLOAD_HASH,
    cls: "communicate.email.external",
    est_cost_usd: "0.02",
    reversible: false,
    policy_sha256: "0".repeat(64),
  } as unknown as Parameters<typeof request>[1];

  const result = request(unit.logPath, smuggled, at(1), "agent:claude", unit.options);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok || result.record === null) throw new Error("expected a record");
  assert.equal(payloadFieldOf(result.record, "policy_sha256"), policySha256(unit));
  assertClean(unit);
});

test("a grant under a re-attested policy is refused policy-drift, and nothing is appended", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestChaser(unit);

  // The human edits the policy and attests the edit: everything is verified,
  // and the rules that routed this request are gone.
  writeFileSync(unit.policyPath, POLICY_EDITED, "utf8");
  attest(unit, at(2));

  const before = eventTypes(unit);
  const refusal = asRefusal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), unit.options),
  );
  // The code is the contract: agents branch on it, so it is pinned here.
  assert.equal(refusal.code, "policy-drift");
  assert.notEqual(refusal.code, "policy-not-attested");
  assert.deepEqual(eventTypes(unit), before);
  assert.equal(requestState(records(unit), "task-042:chaser", at(4), 3_600_000).state, "requested");
  assertClean(unit);

  // The stated repair: the requester takes the void question back and asks it
  // again, which routes it under the policy now in force and pins that hash.
  assert.equal(withdraw(unit.logPath, "task-042:chaser", "agent:claude", at(5), unit.options).ok, true);
  const reRequested = requestChaser(unit, at(6));
  assert.equal(payloadFieldOf(reRequested, "policy_sha256"), policySha256(unit));
  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(7), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  assert.equal(payloadFieldOf(granted.record, "policy_sha256"), policySha256(unit));
  assertClean(unit);
});

test("a request written before the field existed still validates, verifies, and grants", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);

  // Written through the real append path, and shaped as a pre-APRV-118 record:
  // the field is additive, so its absence must be an ordinary request rather
  // than drift. Reading the absence as a mismatch would void every pending
  // request in a log that predates the change.
  const appended = appendEvent(unit.logPath, {
    ts: at(1),
    event: "approval.requested",
    actor: "agent:claude",
    task: "task-042",
    action_key: "task-042:chaser",
    payload: {
      class: "communicate.email.external",
      est_cost_usd: "0.02",
      payload_hash: PAYLOAD_HASH,
    },
  });
  assert.equal(appended.ok, true, "a record without policy_sha256 must pass the write boundary");
  assertClean(unit);

  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  // The grant still records what the approver decided under.
  assert.equal(payloadFieldOf(granted.record, "policy_sha256"), policySha256(unit));
  assertClean(unit);
});

test("a malformed policy_sha256 is refused at the write boundary", () => {
  const unit = newCase();
  attest(unit);
  const appended = appendEvent(unit.logPath, {
    ts: at(1),
    event: "approval.requested",
    actor: "agent:claude",
    task: "task-042",
    action_key: "task-042:chaser",
    payload: { class: "communicate.email.external", policy_sha256: "not-a-digest" },
  });
  assert.equal(appended.ok, false);
  if (appended.ok) throw new Error("unreachable");
  assert.equal(appended.error.code, "validation");
  assertClean(unit);
});

// ===========================================================================
// harness grant spend under a re-attested policy (APRV-134)
// ===========================================================================

test("a harness grant spent under a re-attested policy is refused policy-drift", () => {
  // The gap APRV-118 left open. A harness grant is spent by a LATER process —
  // the retry that adopts it after the first invocation's wait timed out — so
  // there is real time between the human's tap and the spend, and a
  // re-attestation fits inside it. Everything here is verified; the policy in
  // force is simply not the policy the approver decided under.
  const unit = newCase();
  harnessGrant(unit);

  writeFileSync(unit.policyPath, POLICY_EDITED, "utf8");
  attest(unit, at(3));

  const before = eventTypes(unit);
  const refusal = asRefusal(
    consumeHarnessGrant(unit.logPath, "task-042:chaser", "agent:claude", at(4), unit.options),
  );
  assert.equal(refusal.code, "policy-drift");
  assert.notEqual(refusal.code, "policy-not-attested");
  assert.match(refusal.message, /must be requested again/u);
  assert.deepEqual(eventTypes(unit), before, "a refused spend appends nothing");
  assertClean(unit);
});

test("a harness grant with no pinned hash spends as it always did", () => {
  // The additive rule (SPEC.md §8): a pre-APRV-118 request and grant carry no
  // policy_sha256, and reading that absence as drift would strand every
  // carryover in a log written before the field existed. Both records go
  // through the real append path, shaped as the pair that predates it.
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  for (const event of [
    {
      ts: at(1),
      event: "approval.requested" as const,
      actor: "agent:claude",
      payload: {
        class: "communicate.email.external",
        est_cost_usd: "0.02",
        payload_hash: PAYLOAD_HASH,
        execution: "harness",
      },
    },
    {
      ts: at(2),
      event: "approval.granted" as const,
      actor: "human:carter",
      payload: { class: "communicate.email.external", est_cost_usd: "0.02" },
    },
  ]) {
    const appended = appendEvent(unit.logPath, {
      ...event,
      task: "task-042",
      action_key: "task-042:chaser",
    });
    assert.equal(appended.ok, true, `${event.event} must pass the write boundary`);
  }

  // Even a policy re-attested in between: absence is not a claim about which
  // rules governed, so there is nothing to disagree with.
  writeFileSync(unit.policyPath, POLICY_EDITED, "utf8");
  attest(unit, at(3));

  const spent = consumeHarnessGrant(
    unit.logPath,
    "task-042:chaser",
    "agent:claude",
    at(4),
    unit.options,
  );
  assert.equal(spent.ok, true, spent.ok ? "" : spent.message);
  if (!spent.ok) throw new Error("unreachable");
  assert.equal(spent.record.event, "execution.started");
  assertClean(unit);
});

// ===========================================================================
// one policy read per gate operation (APRV-142)
// ===========================================================================

/**
 * The gate used to read `APPROVAL.md` twice per operation — once to hash it for
 * attestation, once to parse it for the decision — with nothing holding the two
 * reads to the same bytes. The red team measured the window (946 of 3000 probes
 * saw the file change between the reads) without ever winning it, which is a
 * statement about their probe rather than about the code.
 *
 * These tests close the question structurally by driving the one read seam
 * `GateOptions.policy.read` with a reader that hands back *different bytes on
 * every call*: the worst file swap an attacker could hope to land, delivered on
 * schedule. A gate that reads once cannot be split by it, and the proof is that
 * the operation is decided under the bytes that were attested.
 */

/** The attested policy: the canonical manual class stays manual. */
const POLICY_ATTESTED = POLICY;

/** Same file, one word changed: the manual class becomes autonomous. */
const POLICY_SWAPPED = POLICY.replace(
  ["  communicate.email.external:", "    autonomy: manual"].join("\n"),
  ["  communicate.email.external:", "    autonomy: autonomous"].join("\n"),
);

/**
 * A reader that returns `first` once and `rest` forever after — the file swapped
 * in the instant between the two former read points. `calls` counts reads, so a
 * test can assert the seam was used exactly once.
 */
function swappingReader(first: string, rest: string): { read: (path: string) => Uint8Array; calls: () => number } {
  let calls = 0;
  return {
    read: () => {
      calls += 1;
      return Buffer.from(calls === 1 ? first : rest, "utf8");
    },
    calls: () => calls,
  };
}

function withReader(unit: Case, read: (path: string) => Uint8Array): GateOptions {
  return { ...unit.options, policy: { ...unit.options.policy, read } };
}

test("a swap after the attestation check cannot change the policy the request is decided under", () => {
  assert.notEqual(POLICY_SWAPPED, POLICY_ATTESTED, "the two policies must differ");
  const unit = newCase(POLICY_ATTESTED);
  attest(unit);
  registerTask(unit);

  const reader = swappingReader(POLICY_ATTESTED, POLICY_SWAPPED);
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
    },
    at(1),
    "agent:claude",
    withReader(unit, reader.read),
  );

  // Had the parse re-read the file, it would have seen the autonomous policy and
  // waved the action through with no approval.requested record at all.
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.autonomy, "manual");
  assert.equal(result.proceed, false);
  assert.notEqual(result.record, null);
  assert.equal(reader.calls(), 1, "a gate operation reads the policy file exactly once");
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered", "approval.requested"]);
  assertClean(unit);
});

test("the pinned hash is the hash of the bytes that were parsed", () => {
  const unit = newCase(POLICY_ATTESTED);
  attest(unit);
  registerTask(unit);

  const reader = swappingReader(POLICY_ATTESTED, POLICY_SWAPPED);
  const requested = requestChaser(unit, at(1));
  assert.equal(payloadFieldOf(requested, "policy_sha256"), policySha256(unit));

  const granted = decide(
    unit.logPath,
    "task-042:chaser",
    "grant",
    "human:carter",
    at(2),
    withReader(unit, reader.read),
  );
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  assert.equal(payloadFieldOf(granted.record, "policy_sha256"), policySha256(unit));
  assert.equal(reader.calls(), 1, "the grant reads the policy file exactly once");
  assertClean(unit);
});

test("a swap before the attestation check refuses rather than half-landing", () => {
  const unit = newCase(POLICY_ATTESTED);
  attest(unit);
  registerTask(unit);

  // The mirror image: the swapped bytes arrive first. There is no read left for
  // the attested bytes to arrive on, so the operation refuses on the bytes it
  // has. Fail closed, and nothing is appended.
  const reader = swappingReader(POLICY_SWAPPED, POLICY_ATTESTED);
  const before = eventTypes(unit);
  const refusal = asRefusal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:chaser",
        payload_hash: PAYLOAD_HASH,
        cls: "communicate.email.external",
        est_cost_usd: "0.02",
        reversible: false,
        summary: "Send deposit chaser",
      },
      at(1),
      "agent:claude",
      withReader(unit, reader.read),
    ),
  );
  assert.equal(refusal.code, "policy-not-attested");
  assert.equal(refusal.detail, "hash-mismatch");
  assert.equal(reader.calls(), 1);
  assert.deepEqual(eventTypes(unit), before);
  assertClean(unit);
});

test("an unreadable policy read is a refusal, not a pass", () => {
  const unit = newCase(POLICY_ATTESTED);
  attest(unit);
  registerTask(unit);

  const refusal = asRefusal(
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:chaser",
        payload_hash: PAYLOAD_HASH,
        cls: "read.file",
        est_cost_usd: "0",
        reversible: true,
        summary: "Read a file",
      },
      at(1),
      "agent:claude",
      withReader(unit, () => {
        throw new Error("EIO: simulated read failure");
      }),
    ),
  );
  // `read.file` is autonomous under the attested policy, so a permissive read
  // failure would have been a proceed:true. It is a refusal instead.
  assert.equal(refusal.code, "policy-not-attested");
  assert.equal(refusal.detail, "unreadable");
  assertClean(unit);
});


// ===========================================================================
// display_hash: the rendering the approver was shown (APRV-119, WYSIWYS)
// ===========================================================================

/** A material payload and the envelope that binds to it. */
const WYSIWYS_PAYLOAD = { to: ["agency@example.co.uk"], subject: "Deposit", body: "a\nb" };
const WYSIWYS_HASH = payloadHash(WYSIWYS_PAYLOAD);

function registerBound(unit: Case): void {
  const result = register(
    unit.logPath,
    {
      task: "task-119",
      envelope: {
        ...ENVELOPE,
        actions: [
          {
            ...ENVELOPE.actions[0],
            idempotency_key: "task-119:chaser",
            payload_hash: WYSIWYS_HASH,
          },
        ],
      },
    },
    T0,
    "agent:claude",
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

function requestBound(unit: Case, payload?: { value: unknown }): EventRecord {
  const result = request(
    unit.logPath,
    {
      task: "task-119",
      actionKey: "task-119:chaser",
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
      ...(payload === undefined ? {} : { payload }),
    },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok || result.record === null) throw new Error("expected an approval.requested record");
  return result.record;
}

test("approval.requested records the display hash of the canonical rendering", () => {
  const unit = newCase();
  attest(unit);
  registerBound(unit);

  const requested = requestBound(unit, { value: WYSIWYS_PAYLOAD });
  assert.equal(
    payloadFieldOf(requested, "display_hash"),
    canonicalRender(WYSIWYS_PAYLOAD, "communicate.email.external").display_hash,
    "the recorded display hash is not the one a channel will render",
  );
  // Beside the binding, never instead of it: one names the bytes, the other the
  // reading of them, and an auditor with the payload store can check both.
  assert.equal(payloadFieldOf(requested, "payload_hash"), WYSIWYS_HASH);
  assertClean(unit);
});

test("the display hash is the runtime's, never the requester's", () => {
  const unit = newCase();
  attest(unit);
  registerBound(unit);

  // `RequestInput` has no `display_hash` field. This cast reaches past the type
  // to prove the runtime half: a value arriving anyway is not what is recorded,
  // so a requester cannot claim a benign reading of a malicious payload.
  const smuggled = {
    task: "task-119",
    actionKey: "task-119:chaser",
    cls: "communicate.email.external",
    est_cost_usd: "0.02",
    reversible: false,
    payload: { value: WYSIWYS_PAYLOAD },
    display_hash: "0".repeat(64),
  } as unknown as Parameters<typeof request>[1];

  const result = request(unit.logPath, smuggled, at(1), "agent:claude", unit.options);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok || result.record === null) throw new Error("expected a record");
  assert.equal(
    payloadFieldOf(result.record, "display_hash"),
    canonicalRender(WYSIWYS_PAYLOAD, "communicate.email.external").display_hash,
  );
  assertClean(unit);
});

test("a request whose bytes nobody holds records no display hash rather than a guess", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);

  // `PAYLOAD_HASH` is a placeholder no store holds and no caller supplied, so
  // there is no material to render. Absence is the honest answer; a hash over
  // material nobody has would name a rendering nobody made.
  const requested = requestChaser(unit);
  assert.equal(payloadFieldOf(requested, "display_hash"), undefined);
  assertClean(unit);
});
