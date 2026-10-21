/**
 * The study operator's withdraw (APRV-527, amended SPEC.md §8, the study record):
 * `approval study withdraw` and `core/study-withdraw.ts`.
 *
 * A hosted study operator DENIES one still-pending request before it can run.
 * Every case builds its log through the real gate (never a hand-written line)
 * and, where it writes, ends by walking the chain. The properties under test:
 * off is a no-op; deny-only and pending-only; a too-late withdraw on a request
 * that exists appends ONE `audit.decision_refused` with the gate's own code,
 * and every other refusal leaves the log byte-identical; the same ref is
 * idempotent, a concurrent retry of it included; a resident's tap that lands
 * first wins; no transport publishes the verb; the
 * resident's card reads "WITHDRAWN BY THE STUDY TEAM · nothing ran"; and the
 * requester's `wait` sees an ordinary rejection.
 *
 * No resident text anywhere: payloads and summaries are fixed placeholders.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPendingQueue } from "../src/channels/tagging.js";
import {
  studyLogRefOf,
  TELEGRAM_STUDY_WITHDRAWN_HEADLINE,
  TELEGRAM_TERMINAL_HEADLINES,
} from "../src/channels/telegram.js";
import {
  dispatchPending,
  newDispatchState,
  STUDY_MODE_ENV as LISTENER_STUDY_MODE_ENV,
} from "../src/cli/channel-telegram.js";
import { main } from "../src/cli/main.js";
import { VERB_REGISTRY, verbLabel } from "../src/cli/verb-registry.js";
import {
  register as registerNow,
  request as requestNow,
} from "../src/core/gate.js";
import { appendAttestation } from "../src/core/attest.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import {
  STUDY_MODE_ENV,
  STUDY_WITHDRAW_REFUSAL_CODES,
  studyActionRefOf,
  studyWithdraw,
  type StudyWithdrawOptions,
} from "../src/core/study-withdraw.js";
import { publishedVerbs, toolName } from "../src/mcp/server.js";
import { AGENT_TOKEN_ENV, resolveServeCredentials, TENANT_TOKEN_ENV } from "../src/serve/credentials.js";
import { serveApproval, serveCatalog } from "../src/serve/server.js";
import { decide, expire, register, request, withdraw } from "./clock-adapters.js";
import { assertClean, at, attest, fixedClock, newScenario, payloadOf, records, scratchRoot, T0, type Scenario } from "./scenario.js";
import { cardListener, oneCard, plainRejectFlow } from "./study-withdraw-cards.js";

const scratch = scratchRoot("study-withdraw");
after(() => scratch.cleanup());

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** The repository root, from `dist/tests/` at runtime. */
const GOLDEN = join(fileURLToPath(new URL("../../", import.meta.url)), "tests", "fixtures", "study-withdraw");

const AGENT = "agent:drafter";
const TASK = "task-study-withdraw";
const CLS = "communicate.email.external";
const PAYLOAD = { to: ["v@vendor.example"], subject: "s" };
const PAYLOAD_HASH = payloadHash(PAYLOAD);
const OPERATOR = createHash("sha256").update("ops@example.org", "utf8").digest("hex").slice(0, 8);
const REF = "wd_7Hq2LmX9pR4sT1vB";
const ON = { [STUDY_MODE_ENV]: "1" } as const;

const logBytes = (unit: Scenario): string => readFileSync(unit.logPath, "utf8");

/** A fresh attested log with `count` pending requests at at(1), on the injected clock. */
function pending(count: number, task = TASK, named?: readonly string[]): { unit: Scenario; keys: string[] } {
  const unit = newScenario(scratch.root);
  attest(unit, T0);
  const keys = named !== undefined ? [...named] : Array.from({ length: count }, (_, index) => `${task}:send-${String(index)}`);
  const registered = register(
    unit.logPath,
    {
      task,
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
      { task, actionKey: key, cls: CLS, est_cost_usd: "0", reversible: false, summary: "s", payload_hash: PAYLOAD_HASH },
      at(1),
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, JSON.stringify(requested));
  }
  return { unit, keys };
}

/** The same world on the REAL clock, for the cases that run the built CLI. */
function pendingNow(count: number): { unit: Scenario; keys: string[] } {
  const unit = newScenario(scratch.root);
  const attested = appendAttestation(unit.logPath, unit.policyPath, "human:carter", {});
  assert.equal(attested.ok, true, "attestation append failed");
  const keys = Array.from({ length: count }, (_, index) => `${TASK}:now-${String(index)}`);
  const registered = registerNow(
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
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  for (const key of keys) {
    const requested = requestNow(
      unit.logPath,
      { task: TASK, actionKey: key, cls: CLS, est_cost_usd: "0", reversible: false, summary: "s", payload_hash: PAYLOAD_HASH },
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, JSON.stringify(requested));
  }
  return { unit, keys };
}

/** Options for a core withdraw at `ts`, study mode on unless `env` says otherwise. */
function opts(unit: Scenario, ts: string, env: Record<string, string | undefined> = ON): StudyWithdrawOptions {
  return { ...unit.options, clock: fixedClock(ts), env };
}

function decisionsOf(unit: Scenario, key: string) {
  return records(unit).filter(
    (record) =>
      record.action_key === key &&
      record.event !== "approval.requested" &&
      record.event !== "task.registered" &&
      record.event !== "audit.decision_refused",
  );
}

/** The `audit.decision_refused` records, all keys. */
function refusalsOf(unit: Scenario): EventRecord[] {
  return records(unit).filter((record) => record.event === "audit.decision_refused");
}

/** The one audit record a refused study withdraw leaves, in its whole shape. */
function assertStudyRefusalRecord(record: EventRecord | undefined, key: string, code: string): void {
  assert.ok(record !== undefined, "no audit.decision_refused was appended");
  assert.equal(record.event, "audit.decision_refused");
  assert.equal(record.actor, "system:gate");
  assert.equal(record.action_key, key);
  assert.equal(record.channel, "study");
  const payload = payloadOf(record);
  assert.equal(payload["actor"], "human:study-team");
  assert.equal(payload["decision"], "reject");
  assert.equal(payload["code"], code);
  assert.equal(payload["study"], undefined, "the audit record carries a study payload");
  assert.equal(JSON.stringify(record).includes(OPERATOR), false, "the operator id reached the audit record");
}

/** Run the built CLI, with exactly the environment given (plus PATH). */
function runCli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// G1-1: the withdrawal
// ---------------------------------------------------------------------------

test("G1-1 withdraws a pending request: one approval.rejected, actor human:study-team, channel study, payload.study {study_withdrawn, operator, ref}; the chain verifies after", () => {
  const { unit, keys } = pending(1);
  const key = keys[0] as string;
  const result = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.idempotent, false);

  const decided = decisionsOf(unit, key);
  assert.equal(decided.length, 1, JSON.stringify(decided));
  const record = decided[0]!;
  assert.equal(record.event, "approval.rejected");
  assert.equal(record.seq, result.seq);
  assert.equal(record.actor, "human:study-team");
  assert.equal(record.channel, "study");
  assert.equal(record.ts, at(3), "the gate's clock, not a caller's");
  assert.deepEqual(payloadOf(record), {
    note: "withdrawn by the study team",
    study: { reason: "study_withdrawn", operator: OPERATOR, ref: REF },
  });
  assert.equal(logBytes(unit).includes("ops@example.org"), false, "the email reached the log");
  assertClean(unit);

  // `approval log verify` through the CLI, exactly as an operator would run it.
  const verify = runCli(["log", "verify", "--log", unit.logPath, "--json"], unit.dir);
  assert.equal(verify.code, 0, verify.stderr);
});

test("G1-1b the built CLI withdraws by action ref with APPROVAL_STUDY_MODE=1 and prints no action key", () => {
  const { unit, keys } = pendingNow(2);
  const key = keys[1] as string;
  const ref12 = studyActionRefOf(key);
  assert.equal(ref12, studyLogRefOf(key), "the operator's ref and the listener's Looks-wrong ref are one vocabulary");
  const run = runCli(
    ["study", "withdraw", "--action-ref", ref12, "--operator", OPERATOR, "--ref", REF, "--policy", unit.policyPath, "--log", unit.logPath, "--json"],
    unit.dir,
    ON,
  );
  assert.equal(run.code, 0, run.stderr);
  const line = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ["idempotent", "ok", "seq"]);
  assert.equal(line["ok"], true);
  assert.equal(line["idempotent"], false);
  for (const text of [run.stdout, run.stderr]) {
    for (const each of keys) assert.equal(text.includes(each), false, "the output named an action key");
  }
  const decided = decisionsOf(unit, key);
  assert.equal(decided.length, 1);
  assert.equal(decided[0]?.seq, line["seq"]);
  assert.equal(decisionsOf(unit, keys[0] as string).length, 0, "the other request was touched");
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// G1-2 / G1-3: not pending, and replay
// ---------------------------------------------------------------------------

test("G1-2 a granted, rejected, expired or withdrawn key is refused not-pending with the gate's code and ONE audit.decision_refused; an unknown key or ref appends nothing", () => {
  const { unit, keys } = pending(4);
  const [granted, rejected, expiring, withdrawnKey] = keys as [string, string, string, string];
  assert.equal(decide(unit.logPath, granted, "grant", "human:carter", at(2), unit.options).ok, true);
  assert.equal(decide(unit.logPath, rejected, "reject", "human:carter", at(2), unit.options).ok, true);
  assert.equal(withdraw(unit.logPath, withdrawnKey, AGENT, at(2), unit.options).ok, true);

  const cases: Array<[string, string, string, string]> = [
    ["granted", granted, at(3), "already-decided"],
    ["rejected", rejected, at(3), "already-decided"],
    // The policy's TTL is 1h; at(90) the request has lapsed by arithmetic and
    // NO approval.expired exists yet. The verb must not materialise one.
    ["expired", expiring, at(90), "expired"],
    ["withdrawn", withdrawnKey, at(3), "request-withdrawn"],
  ];
  for (const [state, key, ts, gateCode] of cases) {
    const before = records(unit).length;
    const result = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: `${REF}-${state}` }, opts(unit, ts));
    assert.equal(result.ok, false, `${state}: ${JSON.stringify(result)}`);
    if (result.ok) continue;
    assert.equal(result.code, "not-pending", state);
    assert.equal(result.state, state, state);
    assert.equal(result.gateCode, gateCode, state);
    const added = records(unit).slice(before);
    assert.deepEqual(added.map((record) => record.event), ["audit.decision_refused"], `${state}: ${JSON.stringify(added)}`);
    assertStudyRefusalRecord(added[0], key, gateCode);
    assert.equal(result.auditSeq, added[0]?.seq, state);
  }
  // A key that names no request has no request to account the attempt to.
  let before = logBytes(unit);
  const unknown = studyWithdraw(unit.logPath, { target: { actionKey: `${TASK}:never-requested` }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.code, "not-pending");
    assert.equal(unknown.state, "none");
  }
  assert.equal(logBytes(unit), before, "an unknown key appended");
  // Nor does a ref that names no request at all.
  const nowhere = studyWithdraw(unit.logPath, { target: { actionRef: "0123456789ab" }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
  assert.equal(nowhere.ok, false);
  if (!nowhere.ok) assert.equal(nowhere.code, "not-pending");
  assert.equal(logBytes(unit), before, "a ref naming nothing appended");
  // An expiry the daemon DID record is refused the same way, and audited.
  assert.equal(expire(unit.logPath, expiring, at(91), unit.options).ok, true);
  before = logBytes(unit);
  const count = records(unit).length;
  const expired = studyWithdraw(unit.logPath, { target: { actionKey: expiring }, operator: OPERATOR, ref: REF }, opts(unit, at(92)));
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.code, "not-pending");
    assert.equal(expired.gateCode, "expired");
  }
  assert.equal(records(unit).length, count + 1);
  assertStudyRefusalRecord(records(unit).at(-1), expiring, "expired");
  // No decision was ever recorded by the study team, and no lazy expiry by the verb.
  assert.equal(records(unit).some((record) => record.actor === "human:study-team"), false);
  assert.equal(records(unit).filter((record) => record.event === "approval.expired").length, 1);
  assertClean(unit);
  const verify = runCli(["log", "verify", "--log", unit.logPath, "--json"], unit.dir);
  assert.equal(verify.code, 0, verify.stderr);
});

test("G1-2b a too-late withdraw BY ACTION REF (the control plane's only form) is resolved to the settled request and audited under its key; the CLI says not-pending with the gate's code and no key", () => {
  const live = pendingNow(2);
  const [decidedKey, other] = live.keys as [string, string];
  const tapped = decideNowCli(live.unit, decidedKey);
  assert.equal(tapped, 0);
  const before = records(live.unit).length;
  const run = runCli(
    ["study", "withdraw", "--action-ref", studyActionRefOf(decidedKey), "--operator", OPERATOR, "--ref", REF, "--policy", live.unit.policyPath, "--log", live.unit.logPath, "--json"],
    live.unit.dir,
    ON,
  );
  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.stdout, "");
  const error = (JSON.parse(run.stderr) as { error: Record<string, unknown> }).error;
  assert.equal(error["code"], "not-pending");
  assert.equal(error["gate_code"], "already-decided");
  assert.equal(error["state"], "rejected", "the ref was resolved to the settled request (not state none)");
  for (const each of live.keys) assert.equal(run.stderr.includes(each), false, "the refusal named an action key");
  const added = records(live.unit).slice(before);
  assert.equal(added.length, 1, JSON.stringify(added));
  assertStudyRefusalRecord(added[0], decidedKey, "already-decided");
  assert.equal(decisionsOf(live.unit, other).length, 0, "the other request was touched");
  assertClean(live.unit);
  const verify = runCli(["log", "verify", "--log", live.unit.logPath, "--json"], live.unit.dir);
  assert.equal(verify.code, 0, verify.stderr);
});

/** A resident's reject through the CLI on the real clock; the exit code. */
function decideNowCli(unit: Scenario, key: string): number {
  return runCli(["reject", key, "--as", "human:carter", "--policy", unit.policyPath, "--log", unit.logPath, "--json"], unit.dir).code;
}

test("G1-3 replaying the same ref after success answers idempotent:true with the first seq and the log is byte-identical; a new ref on the withdrawn card is not-pending", () => {
  const { unit, keys } = pending(1);
  const key = keys[0] as string;
  const first = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  const after = logBytes(unit);

  const again = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, opts(unit, at(4)));
  assert.deepEqual(again, { ok: true, idempotent: true, seq: first.seq, actionKey: key });
  const byRef = studyWithdraw(unit.logPath, { target: { actionRef: studyActionRefOf(key) }, operator: OPERATOR, ref: REF }, opts(unit, at(5)));
  assert.equal(byRef.ok && byRef.idempotent && byRef.seq === first.seq, true, JSON.stringify(byRef));
  assert.equal(logBytes(unit), after, "a replay appended");

  // A NEW ref on the withdrawn card is a too-late withdraw: refused, and on the record once.
  const count = records(unit).length;
  const other = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: "another_ref_0123456789" }, opts(unit, at(6)));
  assert.equal(other.ok, false);
  if (!other.ok) {
    assert.equal(other.code, "not-pending");
    assert.equal(other.state, "rejected");
    assert.equal(other.gateCode, "already-decided");
  }
  const added = records(unit).slice(count);
  assert.equal(added.length, 1, JSON.stringify(added));
  assertStudyRefusalRecord(added[0], key, "already-decided");
  // ...and the replay still answers idempotent after it, appending nothing.
  const afterRefusal = logBytes(unit);
  const replay = studyWithdraw(unit.logPath, { target: { actionRef: studyActionRefOf(key) }, operator: OPERATOR, ref: REF }, opts(unit, at(7)));
  assert.deepEqual(replay, { ok: true, idempotent: true, seq: first.seq, actionKey: key });
  assert.equal(logBytes(unit), afterRefusal);
  assertClean(unit);
});

test("G1-3b a ref reused on a SECOND card is a new withdrawal of that card, never the first card's replay", () => {
  const { unit, keys } = pending(2);
  const [one, two] = keys as [string, string];
  const first = studyWithdraw(unit.logPath, { target: { actionRef: studyActionRefOf(one) }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = studyWithdraw(unit.logPath, { target: { actionRef: studyActionRefOf(two) }, operator: OPERATOR, ref: REF }, opts(unit, at(4)));
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!first.ok || !second.ok) return;
  assert.equal(second.idempotent, false, "the second card read as the first card's replay");
  assert.equal(second.actionKey, two);
  assert.notEqual(second.seq, first.seq);
  assert.equal(decisionsOf(unit, two).length, 1, "the second card was not withdrawn");
  assert.equal(decisionsOf(unit, two)[0]?.actor, "human:study-team");
  // By key as well.
  const { unit: unit2, keys: keys2 } = pending(2);
  assert.equal(studyWithdraw(unit2.logPath, { target: { actionKey: keys2[0] as string }, operator: OPERATOR, ref: REF }, opts(unit2, at(3))).ok, true);
  const byKey = studyWithdraw(unit2.logPath, { target: { actionKey: keys2[1] as string }, operator: OPERATOR, ref: REF }, opts(unit2, at(4)));
  assert.equal(byKey.ok && !byKey.idempotent, true, JSON.stringify(byKey));
  assert.equal(decisionsOf(unit2, keys2[1] as string).length, 1);
  assertClean(unit);
  assertClean(unit2);
});

// ---------------------------------------------------------------------------
// G1-4: the race
// ---------------------------------------------------------------------------

test("G1-4 the race: a resident reject lands between the read and the append, so the result is not-pending (gate_code already-decided), the log holds one decision, and ONE audit.decision_refused records the study team's attempt", () => {
  const { unit, keys } = pending(1);
  const key = keys[0] as string;
  const policyFile = unit.policyPath;
  let reads = 0;
  // The policy-read seam is called once by the verb's own pending check and
  // then once per `decide` attempt, after `decide` has read the log. The
  // resident's tap is appended on the first `decide` read: the verb has
  // already judged the request pending, and `decide`'s append will find the
  // head moved.
  const racing: StudyWithdrawOptions = {
    ...opts(unit, at(3)),
    policy: {
      file: policyFile,
      read: (path) => {
        reads += 1;
        if (reads === 2) {
          const tap = decide(unit.logPath, key, "reject", "human:carter", at(3), {
            ...unit.options,
            channel: "telegram",
            note: "rejected via telegram (callback cb-race)",
          });
          assert.equal(tap.ok, true, JSON.stringify(tap));
        }
        return readFileSync(path);
      },
    },
  };
  const result = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, racing);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) return;
  assert.equal(result.code, "not-pending");
  assert.equal(result.gateCode, "already-decided");
  assert.ok(reads >= 3, `the gate did not retry after the head moved (reads ${String(reads)})`);

  const decided = decisionsOf(unit, key);
  assert.equal(decided.length, 1, JSON.stringify(decided));
  assert.equal(decided[0]?.actor, "human:carter", "the resident's answer is the one that stands");
  assert.equal(payloadOf(decided[0]!)["study"], undefined);
  const refusals = refusalsOf(unit);
  assert.equal(refusals.length, 1, JSON.stringify(refusals));
  assertStudyRefusalRecord(refusals[0], key, "already-decided");
  assert.ok((refusals[0]?.seq ?? 0) > (decided[0]?.seq ?? 0), "the audit record precedes the decision it was refused by");
  assertClean(unit);
});

test("G1-4b a concurrent retry of the SAME ref that loses the race to its own first run answers idempotent and appends nothing (no false refusal)", () => {
  const { unit, keys } = pending(1);
  const key = keys[0] as string;
  let reads = 0;
  let firstSeq = -1;
  // The first run of this ref lands on the first `decide` read of the second
  // run: exactly a control plane's retry after a box_timeout whose first call
  // was still running.
  const racing: StudyWithdrawOptions = {
    ...opts(unit, at(3)),
    policy: {
      file: unit.policyPath,
      read: (path) => {
        reads += 1;
        if (reads === 2) {
          const winner = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
          assert.equal(winner.ok, true, JSON.stringify(winner));
          if (winner.ok) firstSeq = winner.seq;
        }
        return readFileSync(path);
      },
    },
  };
  const retry = studyWithdraw(unit.logPath, { target: { actionRef: studyActionRefOf(key) }, operator: OPERATOR, ref: REF }, racing);
  assert.deepEqual(retry, { ok: true, idempotent: true, seq: firstSeq, actionKey: key });
  assert.equal(decisionsOf(unit, key).length, 1);
  assert.equal(refusalsOf(unit).length, 0, "a concurrent same-ref retry wrote a false refusal");

  // A DIFFERENT ref losing the same way is a real too-late attempt: audited.
  const { unit: unit2, keys: keys2 } = pending(1);
  const key2 = keys2[0] as string;
  let reads2 = 0;
  const racing2: StudyWithdrawOptions = {
    ...opts(unit2, at(3)),
    policy: {
      file: unit2.policyPath,
      read: (path) => {
        reads2 += 1;
        if (reads2 === 2) {
          assert.equal(studyWithdraw(unit2.logPath, { target: { actionKey: key2 }, operator: OPERATOR, ref: REF }, opts(unit2, at(3))).ok, true);
        }
        return readFileSync(path);
      },
    },
  };
  const late = studyWithdraw(unit2.logPath, { target: { actionKey: key2 }, operator: OPERATOR, ref: "another_ref_0123456789" }, racing2);
  assert.equal(late.ok, false, JSON.stringify(late));
  if (!late.ok) assert.equal(late.gateCode, "already-decided");
  assert.equal(refusalsOf(unit2).length, 1);
  assertClean(unit);
  assertClean(unit2);
});

test("G1-4c a log fault passes through under the gate's own code and appends nothing (no audit record, no decision)", () => {
  const { unit, keys } = pending(1);
  const key = keys[0] as string;
  // A record whose hash no longer chains: the verified read refuses log-corrupt.
  const lines = logBytes(unit).split("\n").filter((line) => line.length > 0);
  const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
  last["ts"] = at(9);
  lines[lines.length - 1] = JSON.stringify(last);
  writeFileSync(unit.logPath, `${lines.join("\n")}\n`);
  const before = logBytes(unit);
  for (const target of [{ actionKey: key }, { actionRef: studyActionRefOf(key) }]) {
    const result = studyWithdraw(unit.logPath, { target, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) continue;
    assert.equal(result.code, "log-corrupt", JSON.stringify(result));
    assert.equal(result.gateCode, undefined);
    assert.equal(logBytes(unit), before, "a log fault appended");
  }
  // The CLI: the code rides as itself, never not-pending.
  const run = runCli(
    ["study", "withdraw", key, "--operator", OPERATOR, "--ref", REF, "--policy", unit.policyPath, "--log", unit.logPath, "--json"],
    unit.dir,
    ON,
  );
  assert.notEqual(run.code, 0);
  assert.equal((JSON.parse(run.stderr) as { error: { code: string } }).error.code, "log-corrupt");
  assert.equal(logBytes(unit), before);
});

// ---------------------------------------------------------------------------
// G1-5: off is a no-op
// ---------------------------------------------------------------------------

test("G1-5 APPROVAL_STUDY_MODE unset, 0, true, ' 1' or anything but exactly 1 refuses study-mode-off, nothing appended (core and CLI)", () => {
  const { unit, keys } = pending(1);
  const key = keys[0] as string;
  const before = logBytes(unit);
  for (const env of [{}, { [STUDY_MODE_ENV]: "0" }, { [STUDY_MODE_ENV]: "true" }, { [STUDY_MODE_ENV]: " 1" }, { [STUDY_MODE_ENV]: "" }, { APPROVAL_STUDY: "1" }]) {
    const result = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, opts(unit, at(3), env));
    assert.equal(result.ok, false, JSON.stringify(env));
    if (!result.ok) assert.equal(result.code, "study-mode-off");
    assert.equal(logBytes(unit), before);
  }
  // The listener reads the same variable (G2), so one switch covers both.
  assert.equal(STUDY_MODE_ENV, LISTENER_STUDY_MODE_ENV);

  const live = pendingNow(1);
  const liveBefore = logBytes(live.unit);
  const args = ["study", "withdraw", live.keys[0] as string, "--operator", OPERATOR, "--ref", REF, "--policy", live.unit.policyPath, "--log", live.unit.logPath, "--json"];
  for (const env of [{}, { [STUDY_MODE_ENV]: "0" }]) {
    const run = runCli(args, live.unit.dir, env);
    assert.equal(run.code, 1, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal((JSON.parse(run.stderr) as { error: { code: string } }).error.code, "study-mode-off");
    assert.equal(logBytes(live.unit), liveBefore);
  }
  // Off is checked before the arguments: a malformed call says off, not usage.
  const malformed = runCli(["study", "withdraw", "--operator", "Ops@Example.org", "--json"], live.unit.dir, {});
  assert.equal(malformed.code, 1);
  assert.equal((JSON.parse(malformed.stderr) as { error: { code: string } }).error.code, "study-mode-off");
  // `--help` answers either way: it is the control plane's capability probe.
  const help = runCli(["study", "withdraw", "--help"], live.unit.dir, {});
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^approval study withdraw — /u);
  assertClean(unit);
});

test("G1-5b with study mode on, a malformed operator, ref or target is a usage error (exit 2) and nothing is appended", () => {
  const live = pendingNow(1);
  const key = live.keys[0] as string;
  const before = logBytes(live.unit);
  const base = ["--policy", live.unit.policyPath, "--log", live.unit.logPath, "--json"];
  const bad: string[][] = [
    ["study", "withdraw", key, "--operator", "ops@example.org", "--ref", REF, ...base],
    ["study", "withdraw", key, "--operator", OPERATOR.toUpperCase(), "--ref", REF, ...base],
    ["study", "withdraw", key, "--operator", OPERATOR, "--ref", "short", ...base],
    ["study", "withdraw", key, "--operator", OPERATOR, "--ref", `${REF} space`, ...base],
    ["study", "withdraw", key, "--operator", OPERATOR, ...base],
    ["study", "withdraw", "--operator", OPERATOR, "--ref", REF, ...base],
    ["study", "withdraw", key, "--action-ref", studyActionRefOf(key), "--operator", OPERATOR, "--ref", REF, ...base],
    ["study", "withdraw", "--action-ref", "ABCDEF012345", "--operator", OPERATOR, "--ref", REF, ...base],
    ["study", "withdraw", key, "--as", "human:carter", "--operator", OPERATOR, "--ref", REF, ...base],
    ["study", "grant", key, ...base],
  ];
  for (const args of bad) {
    const run = runCli(args, live.unit.dir, ON);
    assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.equal((JSON.parse(run.stderr) as { error: { code: string } }).error.code, "usage");
    assert.equal(logBytes(live.unit), before);
  }
});

/**
 * Two action keys whose SHA-256 share their first 12 hex (51aa7eade4c7), found
 * once by a birthday search over 2^25 keys of this shape and pinned here. A
 * 48-bit collision is not something a live box meets by chance, and that is
 * exactly why the refusal needs a fixture rather than an argument.
 */
const COLLIDING = ["task-study-withdraw:collide-11015210", "task-study-withdraw:collide-15551713"] as const;

test("G1-5c an action ref naming two pending requests is action-ref-ambiguous and nothing is decided; once one is decided, the ref names the other", () => {
  assert.equal(studyActionRefOf(COLLIDING[0]), studyActionRefOf(COLLIDING[1]), "the fixture keys no longer collide");
  assert.equal(studyActionRefOf(COLLIDING[0]), "51aa7eade4c7");
  const { unit, keys } = pending(2, TASK, COLLIDING);
  const before = logBytes(unit);
  const ambiguous = studyWithdraw(unit.logPath, { target: { actionRef: "51aa7eade4c7" }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
  assert.equal(ambiguous.ok, false, JSON.stringify(ambiguous));
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, "action-ref-ambiguous");
    assert.equal(ambiguous.matches, 2);
  }
  assert.equal(logBytes(unit), before, "an ambiguous ref decided something");

  // The resident answers one of them; the ref now names exactly one pending request.
  assert.equal(decide(unit.logPath, keys[0] as string, "reject", "human:carter", at(4), unit.options).ok, true);
  const one = studyWithdraw(unit.logPath, { target: { actionRef: "51aa7eade4c7" }, operator: OPERATOR, ref: REF }, opts(unit, at(5)));
  assert.equal(one.ok, true, JSON.stringify(one));
  if (one.ok) assert.equal(one.actionKey, keys[1]);
  assert.equal(payloadOf(decisionsOf(unit, keys[1] as string)[0]!)["study"] !== undefined, true);
  assert.deepEqual([...STUDY_WITHDRAW_REFUSAL_CODES], ["study-mode-off", "not-pending", "action-ref-ambiguous"]);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// G1-6: no transport publishes it
// ---------------------------------------------------------------------------

test("G1-6 the verb is not reachable through approval serve or MCP: human_only, absent from every catalog, nothing there imports it, and a serve call is refused", async () => {
  const spec = VERB_REGISTRY.find((entry) => verbLabel(entry) === "study withdraw");
  assert.ok(spec !== undefined, "the verb is not registered");
  assert.equal(spec.human_only, true);
  for (const guest of [false, true]) {
    assert.equal(publishedVerbs(guest).some((entry) => /study/u.test(toolName(entry))), false, `MCP (guest ${String(guest)}) publishes it`);
  }
  assert.equal(serveCatalog().some((entry) => /study/u.test(entry.name)), false, "serve publishes it");

  const root = fileURLToPath(new URL("../../src/", import.meta.url));
  for (const dir of ["serve", "mcp"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true })) {
      const name = String(entry);
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, dir, name), "utf8");
      assert.equal(/study-withdraw|cli\/study/u.test(source), false, `${dir}/${name} imports the study verb`);
    }
  }

  // A live serve call, with the TENANT credential (the stronger of the two),
  // even with study mode on in the server's environment.
  const { unit, keys } = pendingNow(1);
  const credentials = resolveServeCredentials({
    [AGENT_TOKEN_ENV]: "agent-token-for-the-study-suite-0000",
    [TENANT_TOKEN_ENV]: "tenant-token-for-the-study-suite-000",
  });
  assert.equal(credentials.ok, true);
  if (!credentials.ok) return;
  const server = await serveApproval({
    actor: AGENT,
    cwd: unit.dir,
    credentials: credentials.credentials,
    env: { APPROVAL_DAEMON_ID: "daemon-study-test", ...ON },
    port: 0,
  });
  try {
    const before = logBytes(unit);
    // The agent credential reaches the verb lookup and finds nothing; the
    // tenant credential is refused one step earlier, because a verb route is
    // the agent's door and never the tenant's.
    for (const [name, token, code] of [
      ["study_withdraw", "agent-token-for-the-study-suite-0000", "serve-unknown-verb"],
      ["study", "agent-token-for-the-study-suite-0000", "serve-unknown-verb"],
      ["study_withdraw", "tenant-token-for-the-study-suite-000", "serve-tenant-forbidden"],
    ] as const) {
      const response = await fetch(`http://${server.host}:${String(server.port)}/verb/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ positionals: [keys[0]], flags: { "--operator": OPERATOR, "--ref": REF } }),
      });
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, code, `${name}: ${String(response.status)} ${JSON.stringify(body)}`);
      assert.ok(response.status >= 400, `${name}: ${String(response.status)}`);
    }
    assert.equal(logBytes(unit), before, "a serve call appended");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// G1-7: the resident's card
// ---------------------------------------------------------------------------

const quietStreams = { out: () => undefined, err: () => undefined };

async function settledCard(
  how: "withdrawn" | "rejected" | "looks_wrong",
): Promise<{ text: string; body: Record<string, unknown>; unit: Scenario }> {
  const withdrawn = how === "withdrawn";
  const { unit, key } = oneCard(scratch.root, `task-card-${how.replace("_", "-")}`);
  const { setup, calls } = cardListener(unit);
  const state = newDispatchState();
  const first = await dispatchPending(setup, quietStreams, state, at(2));
  assert.deepEqual(first.delivered.map((entry) => entry.action_key), [key], JSON.stringify(first));
  const armedCards = calls.filter((call) => call.method === "sendMessage" && call.body["reply_markup"] !== undefined);
  assert.equal(armedCards.length, 1, "the card went out without buttons, or twice");

  if (withdrawn) {
    const result = studyWithdraw(unit.logPath, { target: { actionKey: key }, operator: OPERATOR, ref: REF }, opts(unit, at(3)));
    assert.equal(result.ok, true, JSON.stringify(result));
  } else if (how === "looks_wrong") {
    // The resident's own study deny (G2): a study payload, but not the study team's.
    const flagged = decide(unit.logPath, key, "reject", "human:carter", at(3), {
      ...unit.options,
      channel: "telegram",
      note: "rejected via telegram (callback cb-lw)",
      study: { reason: "looks_wrong" },
    });
    assert.equal(flagged.ok, true, JSON.stringify(flagged));
  } else {
    assert.equal(decide(unit.logPath, key, "reject", "human:carter", at(3), { ...unit.options, channel: "cli" }).ok, true);
  }
  const next = await dispatchPending(setup, quietStreams, state, at(4));
  assert.deepEqual(next.annotated.map((entry) => [entry.action_key, entry.outcome]), [[key, "rejected"]]);
  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 1, JSON.stringify(calls.map((call) => call.method)));
  return { text: String(edits[0]?.body["text"]), body: edits[0]!.body, unit };
}

test("G1-7 the next dispatch cycle edits the card to WITHDRAWN BY THE STUDY TEAM with \"nothing ran\", buttons removed, no operator id; a plain reject still reads ✗ REJECTED", async () => {
  const withdrawnCard = await settledCard("withdrawn");
  assert.ok(withdrawnCard.text.startsWith(`<b>${TELEGRAM_STUDY_WITHDRAWN_HEADLINE}</b>`), withdrawnCard.text);
  assert.match(withdrawnCard.text, /withdrawn by the study team at 10:03 UTC · nothing ran/u);
  assert.equal(withdrawnCard.text.includes(TELEGRAM_TERMINAL_HEADLINES.rejected), false);
  assert.equal(withdrawnCard.text.includes(OPERATOR), false, "the operator id reached the resident");
  assert.equal(withdrawnCard.text.includes(REF), false, "the ref reached the resident");
  assert.equal(withdrawnCard.text.includes("human:study-team"), false);
  assert.equal(withdrawnCard.body["reply_markup"], undefined, "the buttons stayed");

  const rejectedCard = await settledCard("rejected");
  assert.ok(rejectedCard.text.startsWith(`<b>${TELEGRAM_TERMINAL_HEADLINES.rejected}</b>`), rejectedCard.text);
  assert.match(rejectedCard.text, /by human:carter at 10:03 UTC \(seq \d+\)/u);
  assert.equal(rejectedCard.text.includes(TELEGRAM_STUDY_WITHDRAWN_HEADLINE), false);
  assert.equal(rejectedCard.body["reply_markup"], undefined);

  // A resident's own "Looks wrong" deny carries payload.study too, and must
  // still read as the resident's REJECTED, never as the study team's withdrawal.
  const flaggedCard = await settledCard("looks_wrong");
  assert.ok(flaggedCard.text.startsWith(`<b>${TELEGRAM_TERMINAL_HEADLINES.rejected}</b>`), flaggedCard.text);
  assert.equal(flaggedCard.text.includes(TELEGRAM_STUDY_WITHDRAWN_HEADLINE), false, "a looks_wrong card read WITHDRAWN");
  assert.equal(flaggedCard.text.includes("nothing ran"), false);
});

test("G1-7b off the study path the annotation is byte-identical to the base: a person's reject at another surface edits the card exactly as the stacked base build did", async () => {
  const golden = readFileSync(join(GOLDEN, "plain-reject.golden.jsonl"), "utf8");
  assert.equal(await plainRejectFlow(scratch.root), golden);
});

// ---------------------------------------------------------------------------
// G1-8: the agent sees a plain deny
// ---------------------------------------------------------------------------

test("G1-8 wait on the withdrawn request exits 1 (rejected), the queue drops it, and nothing can execute", async () => {
  const live = pendingNow(1);
  const key = live.keys[0] as string;
  const run = runCli(
    ["study", "withdraw", key, "--operator", OPERATOR, "--ref", REF, "--policy", live.unit.policyPath, "--log", live.unit.logPath, "--json"],
    live.unit.dir,
    ON,
  );
  assert.equal(run.code, 0, run.stderr);

  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["wait", TASK, "--timeout", "0", "--policy", live.unit.policyPath, "--log", live.unit.logPath, "--json"],
    { cwd: live.unit.dir, streams: { out: (text) => out.push(text), err: (text) => err.push(text) } },
  );
  assert.equal(code, 1, `${out.join("")}${err.join("")}`);
  const said = `${out.join("")}${err.join("")}`;
  assert.match(said, /rejected/u);
  // The task id here happens to contain the word, so the check is for what
  // the RECORD says that a plain reject does not: actor, reason, note.
  for (const phrase of ["study-team", "study_withdrawn", "study team", OPERATOR, REF]) {
    assert.equal(said.includes(phrase), false, `"${phrase}" reached the agent's wait`);
  }

  const queue = buildPendingQueue(live.unit.logPath, { policy: { file: live.unit.policyPath } }, new Date().toISOString());
  assert.equal(queue.ok, true);
  if (queue.ok) assert.equal(queue.requests.length, 0, "the withdrawn request is still in the queue");

  const token = runCli(["token", key, "--policy", live.unit.policyPath, "--log", live.unit.logPath, "--json"], live.unit.dir, ON);
  assert.equal(token.code, 1, "a token exists for a withdrawn request");
  assert.equal(records(live.unit).some((record) => record.event === "execution.started"), false);
  assertClean(live.unit);
});
