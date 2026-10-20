/**
 * The study record on a reject (APRV-528, amended SPEC.md §8).
 *
 * `DecideOptions.study` reaches a record as `payload.study` on
 * `approval.rejected` alone, in a fixed shape; `ChannelDecision.study` reaches
 * it through `recordChannelDecision`, which lets a channel say `looks_wrong`
 * and nothing else; the schema admits the two record shapes and refuses the
 * rest. Every log here is built through the real gate and verified after.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { recordChannelDecision, type ChannelDecision } from "../src/channels/contract.js";
import { CHANNEL_DECISION_REFUSAL_CODES } from "../src/core/sender-identity.js";
import { payloadHash } from "../src/core/payload.js";
import { DEFAULT_SCHEMA_DIR, validate } from "../src/core/validate.js";
import { decide, register, request } from "./clock-adapters.js";
import { assertClean, at, attest, fixedClock, newScenario, payloadOf, records, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("gate-study");
after(() => scratch.cleanup());

const AGENT = "agent:drafter";
const TASK = "task-study";
const CLS = "communicate.email.external";
/** The bytes every request here binds to. No resident text: a fixed placeholder. */
const PAYLOAD_HASH = payloadHash({ to: ["v@vendor.example"], subject: "s" });

/** A fresh attested log with `count` pending requests; returns the unit and the keys. */
function pending(count: number): { unit: Scenario; keys: string[] } {
  const unit = newScenario(scratch.root);
  attest(unit, T0);
  const keys = Array.from({ length: count }, (_, index) => `${TASK}:send-${String(index)}`);
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: keys.map((key) => ({
          class: CLS,
          idempotency_key: key,
          summary: "s",
          reversible: false,
          est_cost_usd: "0",
          payload_hash: PAYLOAD_HASH,
        })),
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  for (const key of keys) {
    const requested = request(
      unit.logPath,
      { task: TASK, actionKey: key, cls: CLS, est_cost_usd: "0", reversible: false, summary: "s", payload_hash: PAYLOAD_HASH },
      at(1),
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, JSON.stringify(requested));
  }
  return { unit, keys };
}

function decisionRecord(unit: Scenario, key: string) {
  const found = records(unit).filter(
    (record) => record.action_key === key && record.event.startsWith("approval.") && record.event !== "approval.requested",
  );
  return found;
}

const logBytes = (unit: Scenario): string => readFileSync(unit.logPath, "utf8");

test("S0-1 reject with study writes payload.study in the fixed shape; extra keys on the object never reach the record", () => {
  const { unit, keys } = pending(2);
  const [flagged, withdrawn] = keys as [string, string];

  const loose = { reason: "looks_wrong", card: "study-card-7", operator: undefined } as unknown as {
    reason: "looks_wrong";
  };
  const one = decide(unit.logPath, flagged, "reject", "human:carter", at(2), {
    ...unit.options,
    channel: "telegram",
    note: "rejected via telegram (callback cb-1)",
    study: loose,
  });
  assert.equal(one.ok, true, JSON.stringify(one));
  const first = decisionRecord(unit, flagged);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.event, "approval.rejected");
  assert.deepEqual(payloadOf(first[0]!)["study"], { reason: "looks_wrong" });
  assert.equal(payloadOf(first[0]!)["note"], "rejected via telegram (callback cb-1)", "the note is untouched");

  const two = decide(unit.logPath, withdrawn, "reject", "human:study-team", at(3), {
    ...unit.options,
    channel: "study",
    note: "withdrawn by the study team",
    study: {
      reason: "study_withdrawn",
      operator: "3f9a01c2",
      ref: "wd_7Hq2LmX9pR4sT1vB",
      // Not part of the type; a caller hanging it on must not reach the log.
      ...({ email: "ops@example.org" } as unknown as Record<string, never>),
    },
  });
  assert.equal(two.ok, true, JSON.stringify(two));
  const second = decisionRecord(unit, withdrawn);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.actor, "human:study-team");
  assert.equal(second[0]?.channel, "study");
  assert.deepEqual(payloadOf(second[0]!)["study"], {
    reason: "study_withdrawn",
    operator: "3f9a01c2",
    ref: "wd_7Hq2LmX9pR4sT1vB",
  });
  assert.equal(logBytes(unit).includes("ops@example.org"), false, "an extra key reached the log");
  assertClean(unit);
});

test("S0-1b a study shape the schema refuses is refused at the write boundary and nothing is appended", () => {
  const { unit, keys } = pending(1);
  const before = logBytes(unit);
  // looks_wrong is the resident's telegram deny; on `cli` the schema refuses it.
  const result = decide(unit.logPath, keys[0]!, "reject", "human:carter", at(2), {
    ...unit.options,
    channel: "cli",
    study: { reason: "looks_wrong" },
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(logBytes(unit), before, "a refused study reject appended something");
  assertClean(unit);
});

test("S0-2 grant/revoke with a study option write no study key", () => {
  const { unit, keys } = pending(1);
  const key = keys[0]!;
  const study = { reason: "looks_wrong" as const };

  const granted = decide(unit.logPath, key, "grant", "human:carter", at(2), {
    ...unit.options,
    channel: "telegram",
    study,
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const revoked = decide(unit.logPath, key, "revoke", "human:carter", at(3), {
    ...unit.options,
    channel: "cli",
    study: { reason: "study_withdrawn", operator: "3f9a01c2", ref: "wd_7Hq2LmX9pR4sT1vB" },
  });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));

  const decided = decisionRecord(unit, key);
  assert.deepEqual(
    decided.map((record) => record.event),
    ["approval.granted", "approval.revoked"],
  );
  for (const record of decided) {
    assert.equal("study" in payloadOf(record), false, `${record.event} carried a study key`);
  }
  assert.equal(logBytes(unit).includes("\"study\""), false);
  assertClean(unit);
});

test("S0-3 schema refuses study on approval.granted, an unknown reason, study_withdrawn without operator/ref or with an actor other than human:study-team, looks_wrong with an operator; admits the two §3 shapes", () => {
  const dir = join(DEFAULT_SCHEMA_DIR, "fixtures", "event");
  const read = (kind: string, name: string): unknown =>
    JSON.parse(readFileSync(join(dir, kind, `${name}.json`), "utf8"));
  for (const name of ["approval-rejected-study-withdrawn", "approval-rejected-looks-wrong"]) {
    const result = validate("event", read("valid", name));
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  }
  const refused: [string, RegExp][] = [
    ["approval-granted-study", /event/u],
    ["approval-revoked-study", /event/u],
    ["approval-rejected-study-unknown-reason", /reason/u],
    ["approval-rejected-study-extra-key", /additional/u],
    ["approval-rejected-study-withdrawn-no-operator", /operator/u],
    ["approval-rejected-study-withdrawn-no-ref", /ref/u],
    ["approval-rejected-study-withdrawn-email-operator", /operator/u],
    ["approval-rejected-study-withdrawn-wrong-actor", /actor/u],
    ["approval-rejected-study-withdrawn-wrong-channel", /channel/u],
    ["approval-rejected-looks-wrong-operator", /operator/u],
    ["approval-rejected-looks-wrong-cli-channel", /channel/u],
  ];
  for (const [name, why] of refused) {
    const result = validate("event", read("invalid", name));
    assert.equal(result.ok, false, `${name} was admitted`);
    const text = result.ok ? "" : JSON.stringify(result.errors);
    assert.match(text, why, `${name} was refused for another reason: ${text}`);
  }
});

function channelDecision(key: string, extra: Partial<ChannelDecision> = {}): ChannelDecision {
  return {
    action_key: key,
    decision: "reject",
    deliveryId: "501",
    note: "rejected via telegram (callback cb-1)",
    ...extra,
  };
}

test("S0-5 recordChannelDecision copies ChannelDecision.study; a channel passing study_withdrawn is refused study-reason-not-channel, nothing appended", () => {
  assert.ok(
    (CHANNEL_DECISION_REFUSAL_CODES as readonly string[]).includes("study-reason-not-channel"),
    "the surface union does not carry the code",
  );
  const { unit, keys } = pending(3);
  const [copied, forged, runtime] = keys as [string, string, string];
  const gate = { ...unit.options, clock: fixedClock(at(2)) };

  const ok = recordChannelDecision(
    unit.logPath,
    channelDecision(copied, { study: { reason: "looks_wrong" } }),
    { actor: "human:carter", channel: "telegram" },
    gate,
  );
  assert.equal(ok.outcome.ok, true, JSON.stringify(ok.outcome));
  const record = decisionRecord(unit, copied)[0];
  assert.equal(record?.event, "approval.rejected");
  assert.deepEqual(payloadOf(record!)["study"], { reason: "looks_wrong" });

  const before = logBytes(unit);
  const refused = recordChannelDecision(
    unit.logPath,
    channelDecision(forged, {
      study: { reason: "study_withdrawn", operator: "3f9a01c2", ref: "wd_7Hq2LmX9pR4sT1vB" } as unknown as {
        reason: "looks_wrong";
      },
    }),
    { actor: "human:carter", channel: "telegram" },
    gate,
  );
  assert.equal(refused.outcome.ok, false);
  assert.equal(refused.outcome.ok === false ? refused.outcome.code : "", "study-reason-not-channel");
  assert.equal(logBytes(unit), before, "a refused study reason appended something");

  // A study value on the runtime's own gate options never reaches a record:
  // the one that may is the gesture's, checked above.
  const plain = recordChannelDecision(
    unit.logPath,
    channelDecision(runtime),
    { actor: "human:carter", channel: "telegram" },
    { ...gate, study: { reason: "study_withdrawn", operator: "3f9a01c2", ref: "wd_7Hq2LmX9pR4sT1vB" } },
  );
  assert.equal(plain.outcome.ok, true, JSON.stringify(plain.outcome));
  assert.equal("study" in payloadOf(decisionRecord(unit, runtime)[0]!), false);
  assertClean(unit);
});
