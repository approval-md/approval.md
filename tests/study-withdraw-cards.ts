/**
 * The card flow the study-withdraw golden pins (amended SPEC.md §8, the study
 * record): every Bot API call one listener makes for one card that a person
 * then rejects at another surface, canonicalised (RFC 8785) one call per line.
 *
 * `tests/fixtures/study-withdraw/plain-reject.golden.jsonl` was written by this
 * module against the build at the stacked base (the "Looks wrong" head,
 * 658fbe45) BEFORE the withdraw's headline existed, and
 * `tests/study-withdraw.test.ts` requires the current build to produce the
 * same bytes. The module uses only what that base already had, so the capture
 * and the comparison run the same code. If the golden fails for a reason
 * unrelated to the study headline, stop and report it; never re-capture
 * quietly.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import assert from "node:assert/strict";

import { dispatchPending, newDispatchState, type ListenSetup } from "../src/cli/channel-telegram.js";
import { canonicalize } from "../src/core/jcs.js";
import { payloadHash } from "../src/core/payload.js";
import { decide, register, request } from "./clock-adapters.js";
import { at, attest, newScenario, T0, type Scenario } from "./scenario.js";
import { studyRecordingChannel, type StudyCall } from "./telegram-study-cards.js";

const AGENT = "agent:drafter";
const CLS = "communicate.email.external";
export const CARD_PAYLOAD = { to: ["v@vendor.example"], subject: "s" };

/** A fresh attested log with one pending request at at(1); the key is fixed. */
export function oneCard(root: string, task: string): { unit: Scenario; key: string } {
  const unit = newScenario(root);
  attest(unit, T0);
  const key = `${task}:send-0`;
  const hash = payloadHash(CARD_PAYLOAD);
  const registered = register(
    unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          { class: CLS, idempotency_key: key, summary: "s", reversible: false, est_cost_usd: "0", payload_hash: hash },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const requested = request(
    unit.logPath,
    { task, actionKey: key, cls: CLS, est_cost_usd: "0", reversible: false, summary: "s", payload_hash: hash },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));
  return { unit, key };
}

/** A listener over the recording Bot API, burst delivery, for `unit`'s log. */
export function cardListener(unit: Scenario): { setup: ListenSetup; calls: StudyCall[] } {
  const { channel, calls } = studyRecordingChannel();
  const tagOptions = { policy: { file: unit.policyPath }, payload: () => CARD_PAYLOAD };
  return {
    calls,
    setup: {
      channel,
      logPath: unit.logPath,
      actor: "human:carter",
      json: false,
      once: false,
      crossInstance: [],
      allowCrossInstance: false,
      apiBase: "http://127.0.0.1:9",
      delivery: "burst",
      gateOptions: unit.options,
      tagOptions,
      checkpoint: { logPath: unit.logPath, policy: tagOptions.policy, keyFile: null, vault: null },
    },
  };
}

const quiet = { out: () => undefined, err: () => undefined };

/**
 * One card delivered at at(2), rejected at the CLI at at(3) by a person, and the
 * next cycle at at(4) annotating it. Every Bot API call, one canonical line each.
 */
export async function plainRejectFlow(root: string): Promise<string> {
  const { unit, key } = oneCard(root, "task-card-golden");
  const { setup, calls } = cardListener(unit);
  const state = newDispatchState();
  await dispatchPending(setup, quiet, state, at(2));
  const rejected = decide(unit.logPath, key, "reject", "human:carter", at(3), { ...unit.options, channel: "cli" });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  await dispatchPending(setup, quiet, state, at(4));
  return calls.map((call) => `${canonicalize({ method: call.method, body: call.body })}\n`).join("");
}
