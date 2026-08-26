/**
 * Runtime-assigned timestamps on gate-typed events (amended SPEC.md §8, A2).
 *
 * > Events written through the gate (`approval.*`, `execution.*`, `budget.*`,
 * > `audit.*`, `policy.updated`) have `ts` assigned by the runtime at the write
 * > boundary. Caller-supplied timestamps on these types MUST be refused.
 * > Because TTL judgment and budget windows read `ts`, a party subject to those
 * > controls must never author the clock they are judged by.
 *
 * Two halves, both covered here:
 *
 * - **Compile-level.** The refusal is structural: no public gate/token/execute/
 *   attest function has a `ts` parameter any more, so there is nothing to pass
 *   and nothing to forget to refuse. A test cannot assert the absence of a
 *   parameter at runtime; what it *can* do is pin the arity of each function, so
 *   that re-adding a positional `ts` breaks a test as well as the build. That is
 *   the first case below, and `tests/clock-adapters.ts` is the honest record of
 *   what the migration actually did to the call sites.
 * - **Runtime.** The recorded `ts` comes from the injected clock, and with no
 *   clock injected it comes from the real one — never from a caller.
 *
 * The carve-out is tested too: `appendEvent` still accepts `ts`, because
 * SPEC.md §8 leaves direct log writers outside the gate free to supply one (an
 * importer replaying history is the obvious case). The rule binds the gate.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { systemClock, tick } from "../src/core/clock.js";
import { finishExecution, startExecution } from "../src/core/execute.js";
import { decide, expire, register, request } from "../src/core/gate.js";
import { appendEvent } from "../src/core/log.js";
import { consumeToken } from "../src/core/token.js";
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

const { root, cleanup } = scratchRoot("clock");
after(cleanup);

const BOUND = "c".repeat(64);
const KEY = "task-042:chaser";

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: KEY,
      payload_hash: BOUND,
    },
  ],
};

function ready(): Scenario {
  const unit = newScenario(root);
  attest(unit);
  assert.equal(
    register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, "agent:claude", {
      ...unit.options,
      clock: fixedClock(T0),
    }).ok,
    true,
  );
  return unit;
}

// ---------------------------------------------------------------------------
// The compile-level half, pinned as arity
// ---------------------------------------------------------------------------

test("no gate-typed writer takes a positional ts any more", () => {
  // `Function.length` counts parameters before the first optional/default one,
  // which is exactly the positional prefix a caller must supply. Re-adding a
  // `ts` parameter to any of these changes the number and fails here — and,
  // because there is no such parameter to pass, fails the build at every call
  // site too. Two independent alarms for one regression.
  assert.equal(register.length, 3, "register(logPath, source, actor)");
  assert.equal(request.length, 3, "request(logPath, input, actor)");
  assert.equal(decide.length, 4, "decide(logPath, actionKey, decision, actor)");
  assert.equal(expire.length, 2, "expire(logPath, actionKey)");
  assert.equal(consumeToken.length, 4, "consumeToken(logPath, key, token, actor)");
  assert.equal(startExecution.length, 4, "startExecution(logPath, key, options, actor)");
  assert.equal(finishExecution.length, 4, "finishExecution(logPath, key, exitCode, actor)");
  assert.equal(appendAttestation.length, 3, "appendAttestation(logPath, policyPath, actor)");
});

test("appendEvent keeps its ts: the §8 carve-out for direct writers is intact", () => {
  const unit = newScenario(root);
  const historical = "2020-01-01T00:00:00.000Z";
  const appended = appendEvent(unit.logPath, {
    ts: historical,
    event: "route.proposed",
    actor: "agent:importer",
    task: "task-042",
    payload: { note: "replayed from an older system" },
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.ok && appended.record.ts, historical);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The runtime half
// ---------------------------------------------------------------------------

test("every gate-typed append stamps the ts the injected clock returned", () => {
  const unit = ready();

  assert.equal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: KEY, cls: "communicate.email.external", est_cost_usd: "0.02" },
      "agent:claude",
      { ...unit.options, clock: fixedClock(at(1)) },
    ).ok,
    true,
  );
  const granted = decide(unit.logPath, KEY, "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");

  assert.equal(
    consumeToken(unit.logPath, KEY, granted.token, "agent:claude", {
      policyFile: unit.policyPath,
      presentedPayloadHash: BOUND,
      clock: fixedClock(at(3)),
    }).ok,
    true,
  );
  assert.equal(
    finishExecution(unit.logPath, KEY, 0, "agent:claude", {
      ...unit.options,
      clock: fixedClock(at(4)),
    }).ok,
    true,
  );

  assert.deepEqual(
    records(unit).map((record) => [record.event, record.ts]),
    [
      ["policy.updated", T0],
      ["task.registered", T0],
      ["approval.requested", at(1)],
      ["approval.granted", at(2)],
      ["execution.started", at(3)],
      ["execution.completed", at(4)],
    ],
  );
  assertClean(unit);
});

test("startExecution and the spend it delegates share ONE reading of the clock", () => {
  // One moment per operation: a start event and the token spend inside it must
  // not disagree about when this happened.
  const unit = ready();
  assert.equal(
    request(
      unit.logPath,
      { task: "task-042", actionKey: KEY, cls: "communicate.email.external", est_cost_usd: "0.02" },
      "agent:claude",
      { ...unit.options, clock: fixedClock(at(1)) },
    ).ok,
    true,
  );
  const granted = decide(unit.logPath, KEY, "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");

  let reads = 0;
  const started = startExecution(
    unit.logPath,
    KEY,
    {
      ...unit.options,
      token: granted.token,
      presentedPayloadHash: BOUND,
      clock: () => {
        reads += 1;
        return at(3);
      },
    },
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  assert.equal(started.ok && started.record.ts, at(3));
  assert.equal(reads, 1, "the clock was read more than once for one operation");
  assertClean(unit);
});

test("with no clock injected the runtime reads the real one, not the caller's", () => {
  const unit = newScenario(root);
  const before = Date.now();
  const appended = appendAttestation(unit.logPath, unit.policyPath, "human:carter");
  const after_ = Date.now();

  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
  if (!appended.ok) return;
  const stamped = Date.parse(appended.record.ts);
  assert.ok(
    stamped >= before - 1000 && stamped <= after_ + 1000,
    `runtime stamp ${appended.record.ts} is not "now"`,
  );
  assertClean(unit);
});

test("tick defaults to the system clock and honors an injection", () => {
  assert.equal(tick({ clock: fixedClock(T0) }), T0);
  assert.match(tick(), /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(systemClock(), /^\d{4}-\d{2}-\d{2}T/u);
});
