/**
 * `audit.gesture_refused` (APRV-355): the record a refused NON-DECISION leaves.
 *
 * What is proved here is the core half — the record's shape, the two cases that
 * append nothing, the closed vocabularies, and the claim the whole design rests
 * on, that no enforcement path reads it. The surface half, where a real tap on
 * a real mock Telegram server produces one of these, is proved where those taps
 * already live: `tests/checkpoint-tap.test.ts` for a signature and
 * `tests/channels-telegram.test.ts` for a review.
 *
 * Every log here is built through the REAL append path and read back through
 * the real verifier. Nothing writes a jsonl line by hand.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GESTURE_REFUSAL_ACTOR,
  isRefusedGestureCode,
  recordRefusedGesture,
  REFUSED_GESTURE_CODES,
  REFUSED_GESTURES,
  type RefusedGestureKind,
} from "../src/core/gesture-refusal.js";
import type { EventRecord } from "../src/core/log.js";
import { requestState } from "../src/core/gate.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { attest, fixedClock, newScenario, scratchRoot, T0, at, type Scenario } from "./scenario.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const scratch = scratchRoot("gesture-refusal");
after(scratch.cleanup);

const HUMAN = "human:carter";
const SENDER = { channel: "telegram", id: "5551234567" };

/** An attested policy and nothing else: a gesture needs no request. */
function world(): Scenario {
  const unit = newScenario(scratch.root);
  attest(unit, T0);
  return unit;
}

function records(unit: Scenario): EventRecord[] {
  const read = verifyWithRecords(unit.logPath);
  assert.equal(read.result.status, "clean", JSON.stringify(read.result));
  return read.records;
}

function payloadOf(record: EventRecord): Record<string, unknown> {
  return (record.payload ?? {}) as Record<string, unknown>;
}

function refuse(
  unit: Scenario,
  gesture: RefusedGestureKind,
  code: string,
  options: { actor?: string | null; sender?: { channel: string; id: string } } = {},
): ReturnType<typeof recordRefusedGesture> {
  return recordRefusedGesture(
    unit.logPath,
    {
      gesture,
      actor: options.actor === undefined ? null : options.actor,
      channel: "telegram",
      ...(options.sender === undefined ? {} : { sender: options.sender }),
    },
    { code, message: `refused ${code}` },
    { ...unit.options, clock: fixedClock(at(2)) },
  );
}

test("each gesture kind and each refusal code appends exactly one record", () => {
  for (const gesture of REFUSED_GESTURES) {
    for (const code of REFUSED_GESTURE_CODES) {
      const unit = world();
      const before = records(unit).length;
      const result = refuse(unit, gesture, code, { sender: SENDER });
      assert.equal(result.ok, true, JSON.stringify(result));

      const after = records(unit);
      assert.equal(after.length, before + 1, `${gesture}/${code} appended more than one record`);
      const record = after[after.length - 1] as EventRecord;
      assert.equal(record.event, "audit.gesture_refused");
      assert.equal(record.actor, GESTURE_REFUSAL_ACTOR);
      assert.equal(record.channel, "telegram");
      // Neither field a DECISION record requires, because a gesture has
      // neither and inventing one would be a false statement.
      assert.equal(record.action_key, undefined);
      const payload = payloadOf(record);
      assert.equal(payload["gesture"], gesture);
      assert.equal(payload["code"], code);
      assert.equal("decision" in payload, false);
      assert.deepEqual(payload["sender"], SENDER);
    }
  }
});

test("the person is named when the runtime could name one, and only then", () => {
  const named = world();
  assert.equal(refuse(named, "review", "policy-not-attested", { actor: HUMAN }).ok, true);
  const withActor = records(named).at(-1) as EventRecord;
  assert.equal(payloadOf(withActor)["actor"], HUMAN);
  assert.equal("sender" in payloadOf(withActor), false);

  // `sender-unmapped` is the refusal where naming a person is exactly what the
  // runtime could not do. The record carries the account and no person, and
  // the write boundary accepts it because of that account.
  const unnamed = world();
  assert.equal(refuse(unnamed, "review", "sender-unmapped", { sender: SENDER }).ok, true);
  const withSender = records(unnamed).at(-1) as EventRecord;
  assert.equal("actor" in payloadOf(withSender), false);
  assert.deepEqual(payloadOf(withSender)["sender"], SENDER);
});

test("nothing is appended when there is nothing true to say", () => {
  // No person and no account: the record would name neither the subject nor
  // the reason it could not.
  const blind = world();
  const before = records(blind).length;
  assert.equal(refuse(blind, "review", "sender-unmapped").ok, true);
  assert.equal(records(blind).length, before, "a record with no subject was appended");

  // A non-human actor is the misconfigured-surface case: nobody's attention
  // was spent, so there is no spend for a record to account for.
  const agent = world();
  assert.equal(
    refuse(agent, "review", "sender-unmapped", { actor: "agent:claude-code", sender: SENDER }).ok,
    true,
  );
  assert.equal(records(agent).length, before, "an agent's refusal was recorded");

  // A code this vocabulary does not name. Minting a member to fit it would
  // widen a closed union at the write boundary from inside a best-effort path.
  const unknown = world();
  assert.equal(refuse(unknown, "review", "attest-requires-terminal", { sender: SENDER }).ok, true);
  assert.equal(records(unknown).length, before, "an unnamed code was recorded");
  assert.equal(isRefusedGestureCode("attest-requires-terminal"), false);
});

test("the vocabularies are closed, and equal the ones the write boundary enforces", () => {
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schema", "event.schema.json"), "utf8"),
  ) as { properties: { event: { enum: string[] } }; allOf: unknown[] };

  // A type the runtime can produce and the schema refuses is an observation
  // that never reaches a human (APRV-358's reason, applied here).
  assert.ok(schema.properties.event.enum.includes("audit.gesture_refused"));

  const branch = (schema.allOf as Array<Record<string, unknown>>).find((entry) => {
    const guard = entry["if"] as { properties?: { event?: { const?: string } } } | undefined;
    const then = entry["then"] as Record<string, unknown> | undefined;
    return (
      guard?.properties?.event?.const === "audit.gesture_refused" &&
      then !== undefined &&
      JSON.stringify(then).includes('"gesture"')
    );
  });
  assert.ok(branch !== undefined, "the schema carries no shape rule for the type");
  const payload = (
    (branch["then"] as { properties: { payload: { properties: Record<string, { enum?: string[] }> } } })
      .properties.payload.properties
  );
  assert.deepEqual(payload["gesture"]?.enum, [...REFUSED_GESTURES]);
  assert.deepEqual(payload["code"]?.enum, [...REFUSED_GESTURE_CODES]);
});

test("no enforcement path reads the record: the module graph says so, not an intention", () => {
  // The claim is structural, so it is checked structurally. Every module that
  // decides, authorizes, charges, settles or samples is read, and none of them
  // may mention the type. A `grep` over the built tree would also catch a
  // reader that arrived by a clever route, and the source is what a human
  // reviews, so the source is what is read.
  const enforcement = [
    "src/core/gate.ts",
    "src/core/state.ts",
    "src/core/budgets.ts",
    "src/core/audit.ts",
    "src/core/policy-load.ts",
    "src/core/policy-match.ts",
    "src/core/token.ts",
    "src/core/attest.ts",
    "src/core/protected-path-guard.ts",
    "src/core/dark-session.ts",
    "src/cli/hook.ts",
  ];
  for (const path of enforcement) {
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    assert.equal(
      text.includes("audit.gesture_refused"),
      false,
      `${path} names the audit record; nothing on an enforcement path may read it`,
    );
    assert.equal(
      text.includes("gesture-refusal"),
      false,
      `${path} imports the module that writes it`,
    );
  }
});

test("the record settles nothing: a derivation taken across it does not move", () => {
  const unit = world();
  const before = requestState(records(unit), "task-042:chaser", at(3), null);
  assert.equal(refuse(unit, "checkpoint-signature", "sender-unmapped", { sender: SENDER }).ok, true);
  const after = requestState(records(unit), "task-042:chaser", at(3), null);
  assert.deepEqual(after, before);
});
