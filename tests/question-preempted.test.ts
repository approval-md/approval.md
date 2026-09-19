/**
 * `audit.question_preempted` (APRV-378): the record left when something other
 * than this gate answered a question this gate exists to ask.
 *
 * What is proved here is the core half — the record's shape, the cases that
 * append nothing, the closed `source` vocabulary pinned against the schema's
 * own, and the claim the whole design rests on, that no enforcement path reads
 * it. The surface half, where a real `approval codex bridge` run against the
 * stub app-server produces exactly one of these, is proved in
 * `tests/codex-bridge.test.ts` where that CLI already runs.
 *
 * Every log here is built through the REAL append path and read back through
 * the real verifier. Nothing writes a jsonl line by hand.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { requestState } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import {
  PREEMPTION_SOURCES,
  QUESTION_PREEMPTED_ACTOR,
  QUESTION_PREEMPTED_EVENT,
  recordPreemptedQuestion,
  type PreemptedQuestion,
} from "../src/core/question-preempted.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { attest, fixedClock, newScenario, scratchRoot, T0, at, type Scenario } from "./scenario.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const scratch = scratchRoot("question-preempted");
after(scratch.cleanup);

/** An attested policy and nothing else: this record answers to no request. */
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

/** The whole disclosure, as the bridge reads one off a notification. */
const FULL: PreemptedQuestion = {
  source: "codex-auto-reviewer",
  id: "item_01H9",
  method: "item/autoApprovalReview/completed",
  thread: "thread_7f2",
  turn: "turn_3",
  verdict: "approve",
};

function preempt(
  unit: Scenario,
  question: PreemptedQuestion = FULL,
): ReturnType<typeof recordPreemptedQuestion> {
  return recordPreemptedQuestion(unit.logPath, question, {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
}

test("the record names who answered, the question in their terms, and their verdict", () => {
  const unit = world();
  const written = preempt(unit);
  assert.equal(written.ok, true);

  const all = records(unit).filter((record) => record.event === QUESTION_PREEMPTED_EVENT);
  assert.equal(all.length, 1);
  const record = all[0] as EventRecord;
  // The runtime is the author, and neither party to the event is: a record of
  // an event authored by either party is one neither can be held to.
  assert.equal(record.actor, QUESTION_PREEMPTED_ACTOR);
  assert.match(record.actor, /^system:/u);

  const payload = payloadOf(record);
  assert.equal(payload["source"], "codex-auto-reviewer");
  assert.equal(payload["verdict"], "approve");
  assert.deepEqual(payload["question"], {
    id: "item_01H9",
    method: "item/autoApprovalReview/completed",
    thread: "thread_7f2",
    turn: "turn_3",
  });
  // No action key and no decision: the gate holds no key for a question it was
  // never asked, and inventing one would be a false statement in a record whose
  // whole purpose is to be true about what happened.
  assert.equal(record.action_key, undefined);
});

test("a verdict the disclosure did not state is ABSENT, never defaulted", () => {
  const unit = world();
  assert.equal(
    preempt(unit, {
      source: "codex-auto-reviewer",
      id: "item_01H9",
      method: "item/autoApprovalReview/completed",
    }).ok,
    true,
  );

  const record = records(unit).filter(
    (entry) => entry.event === QUESTION_PREEMPTED_EVENT,
  )[0] as EventRecord;
  const payload = payloadOf(record);
  assert.equal("verdict" in payload, false);
  // And the question keeps only what the other party named.
  assert.deepEqual(payload["question"], {
    id: "item_01H9",
    method: "item/autoApprovalReview/completed",
  });
});

test("a question the other party did not identify appends nothing", () => {
  const unit = world();
  const before = records(unit).length;
  const written = preempt(unit, { ...FULL, id: "" });
  assert.equal(written.ok, true);
  assert.equal(written.ok ? written.audit : "unreached", null);
  assert.equal(records(unit).length, before);
});

test("a source outside the closed set appends nothing rather than widening it", () => {
  const unit = world();
  const before = records(unit).length;
  // A caller reaching past the type, which is the only way this is reachable.
  const written = recordPreemptedQuestion(
    unit.logPath,
    { source: "some-other-reviewer" as (typeof PREEMPTION_SOURCES)[number], id: "item_01H9" },
    { ...unit.options, clock: fixedClock(at(2)) },
  );
  assert.equal(written.ok, true);
  assert.equal(written.ok ? written.audit : "unreached", null);
  assert.equal(records(unit).length, before);
});

test("the source vocabulary is the schema's own, member for member", () => {
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schema/event.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const branches = (schema["allOf"] ?? []) as Record<string, unknown>[];
  const branch = branches.find((entry) => {
    const when = (entry["if"] ?? {}) as Record<string, unknown>;
    const properties = (when["properties"] ?? {}) as Record<string, unknown>;
    const event = (properties["event"] ?? {}) as Record<string, unknown>;
    return event["const"] === QUESTION_PREEMPTED_EVENT;
  });
  assert.ok(branch !== undefined, "the schema carries no branch for the event type");
  const then = (branch["then"] ?? {}) as Record<string, unknown>;
  const properties = (then["properties"] ?? {}) as Record<string, unknown>;
  const payload = (properties["payload"] ?? {}) as Record<string, unknown>;
  const fields = (payload["properties"] ?? {}) as Record<string, unknown>;
  const source = (fields["source"] ?? {}) as Record<string, unknown>;
  // A member the runtime can produce and the write boundary refuses is an
  // observation that never reaches a human, which is the failure this pin
  // exists to stop (the APRV-358 lesson).
  assert.deepEqual(source["enum"], [...PREEMPTION_SOURCES]);
});

test("no enforcement path reads the record: the module graph says so, not an intention", () => {
  // The claim is structural, so it is checked structurally. Every module that
  // decides, authorizes, charges, settles or samples is read, and none of them
  // may mention the type. `src/cli/doctor.ts` is deliberately absent from this
  // list and IS a reader: a health row diagnoses, and a diagnosis authorizes
  // nothing and refuses nothing.
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
      text.includes(QUESTION_PREEMPTED_EVENT),
      false,
      `${path} names the audit record; nothing on an enforcement path may read it`,
    );
    assert.equal(
      text.includes("question-preempted"),
      false,
      `${path} imports the module that writes it`,
    );
  }
});

test("the record settles nothing: a derivation taken across it does not move", () => {
  const unit = world();
  const before = requestState(records(unit), "task-042:chaser", at(3), null);
  assert.equal(preempt(unit).ok, true);
  const after = requestState(records(unit), "task-042:chaser", at(3), null);
  assert.deepEqual(after, before);
});
