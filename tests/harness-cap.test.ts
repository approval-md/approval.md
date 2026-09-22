/**
 * The harness cap and the TTL it narrows (APRV-423).
 *
 * The failure this suite pins: a harness holds a tool call for a bounded time
 * (Hermes will not let a `pre_tool_call` entry be configured past 300 seconds at
 * all), the hook's wait ends, the harness gives up, and the request is still
 * pending on somebody's phone. A tap after that point used to become an
 * `approval.granted` for a call nobody was holding — a live authorization
 * produced by answering a question that had already been abandoned.
 *
 * So a hook-originated request now carries how long its harness can hold the
 * call, and the TTL that governs it is the smaller of the policy's and that cap
 * minus a margin. Four properties, one per case group:
 *
 * 1. The arithmetic itself, in isolation: it narrows, it never widens, and a
 *    policy that bounds nothing is still bounded by a cap.
 * 2. The narrowing is applied in the LAZY judge, which is what keeps SPEC.md
 *    §10.2's "the sweep changes no verdict" true: the daemon appends
 *    `approval.expired` for a lapse the gate has already judged, rather than
 *    inventing an earlier deadline the gate does not know about.
 * 3. The daemon's expiry lands strictly before the cap elapses, on a fixed
 *    clock.
 * 4. A tap after that lands on an already-decided request and is refused with
 *    the code that already exists for one.
 *
 * Every log here is built through the real append path, with the clock injected
 * (SPEC.md §8, A2): no record is hand-written, and no gate-typed event takes a
 * caller's timestamp. The chain is verified at the end of every case that
 * writes.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  effectiveRequestTtlMs,
  HARNESS_CAP_MARGIN_MS,
  HARNESS_PROCESS_CAP_MS,
  harnessCapMs,
} from "../src/core/harness-wait.js";
import { requestState } from "../src/core/state.js";
import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";
import { lapsedRequests } from "../src/daemon/projection.js";
import { decide, expire, register, request } from "./clock-adapters.js";
import {
  assertClean,
  attest,
  fixedClock,
  newScenario,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const scratch = scratchRoot("harness-cap");

after(() => {
  scratch.cleanup();
});

/** The policy every scenario here runs under: a one-hour TTL, manual email. */
const POLICY_1H = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/** The same policy with no `approval_ttl` at all: nothing lapses on its own. */
const POLICY_NO_TTL = POLICY_1H.replace('  approval_ttl: "1h"\n', "");

const TASK = "task-cap";
const ACTION_KEY = `${TASK}:send`;
const CLASS = "communicate.email.external";
const BINDING = createHash("sha256").update("payload:harness-cap", "utf8").digest("hex");

/** `ms` after {@link T0}, as an RFC 3339 instant. The fixed clock of every case. */
function ms(offset: number): string {
  return new Date(Date.parse(T0) + offset).toISOString();
}

/**
 * A scenario with the policy attested and the task registered, both at T0.
 *
 * The registration declares the action the request below asks about, so the
 * request binds to a declaration the log holds rather than to a hash a caller
 * supplied.
 */
function ready(policyText: string = POLICY_1H): Scenario {
  const unit = newScenario(scratch.root, policyText);
  attest(unit, T0);
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "harness-cap-test", created_by: "agent:claude" },
        state: "proposed",
        actions: [
          {
            class: CLASS,
            summary: "Send the chaser",
            reversible: false,
            est_cost_usd: "0.02",
            idempotency_key: ACTION_KEY,
            payload_hash: BINDING,
          },
        ],
      },
    },
    T0,
    "agent:claude",
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return unit;
}

/** Open the request at T0, declaring `capMs` where one is given. */
function ask(unit: Scenario, capMs: number | null): void {
  const result = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: ACTION_KEY,
      cls: CLASS,
      summary: "Send the chaser",
      payload_hash: BINDING,
      execution: "harness",
      ...(capMs === null ? {} : { harnessCapMs: capMs }),
    },
    T0,
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}

/** The state of {@link ACTION_KEY} as of `ts`, under the policy's own 1h TTL. */
function stateAt(unit: Scenario, ts: string, policyTtlMs: number | null = 3_600_000) {
  return requestState(records(unit), ACTION_KEY, ts, policyTtlMs);
}

// ---------------------------------------------------------------------------
// 1. The arithmetic
// ---------------------------------------------------------------------------

test("the documented cap table names a number only where one was observed", () => {
  // Hermes is the one harness whose own documentation states a MAXIMUM rather
  // than a default (docs/hermes-hook.md: an entry's `timeout` may not exceed
  // 300s). Every other entry is null on purpose: a guessed ceiling would be a
  // guess in the one place a deadline is computed from.
  assert.equal(HARNESS_PROCESS_CAP_MS["hermes"], 300_000);
  assert.equal(HARNESS_PROCESS_CAP_MS["claude-code"], null);
  assert.equal(HARNESS_PROCESS_CAP_MS["cursor"], null);
  assert.equal(HARNESS_PROCESS_CAP_MS["codex"], null);
  assert.equal(HARNESS_PROCESS_CAP_MS["grok"], null);
  assert.equal(HARNESS_PROCESS_CAP_MS["muse"], null);
});

test("the cap in force is the smaller of the harness ceiling and the operator's", () => {
  // Neither: nothing is carried, and the policy TTL stays the only deadline.
  assert.equal(harnessCapMs("claude-code", null), null);
  // The operator's alone, where the project documents no ceiling.
  assert.equal(harnessCapMs("claude-code", 600_000), 600_000);
  // The harness's alone, where the operator states none.
  assert.equal(harnessCapMs("hermes", null), 300_000);
  // Both, and the smaller one bites — the two-timeout table of the Hermes doc.
  assert.equal(harnessCapMs("hermes", 120_000), 120_000);
  assert.equal(harnessCapMs("hermes", 900_000), 300_000);
  // Unusable operator values are dropped rather than trusted.
  assert.equal(harnessCapMs("hermes", 0), 300_000);
  assert.equal(harnessCapMs("hermes", -1), 300_000);
  assert.equal(harnessCapMs("claude-code", Number.NaN), null);
  assert.equal(harnessCapMs("claude-code", Number.POSITIVE_INFINITY), null);
});

test("a cap narrows the TTL and can never widen it (SPEC.md §11.1 invariant 4)", () => {
  const hour = 3_600_000;
  // The direction that matters: the cap is a field the party under oversight
  // puts on its own request, so an absurd one must buy it nothing.
  assert.equal(effectiveRequestTtlMs(hour, 10 * hour), hour);
  assert.equal(effectiveRequestTtlMs(hour, Number.MAX_SAFE_INTEGER), hour);
  // And the direction it is FOR: a cap shorter than the policy TTL governs.
  assert.equal(effectiveRequestTtlMs(hour, 300_000), 300_000 - HARNESS_CAP_MARGIN_MS);
  // A policy that bounds nothing is still bounded by a cap.
  assert.equal(effectiveRequestTtlMs(null, 300_000), 300_000 - HARNESS_CAP_MARGIN_MS);
  // With neither, nothing lapses: the behaviour every deployment had before.
  assert.equal(effectiveRequestTtlMs(null, null), null);
  assert.equal(effectiveRequestTtlMs(hour, null), hour);
  // A cap at or below the margin floors at zero rather than going negative: a
  // harness that cannot hold a call that long cannot hold one for a human.
  assert.equal(effectiveRequestTtlMs(hour, HARNESS_CAP_MARGIN_MS), 0);
  assert.equal(effectiveRequestTtlMs(hour, 1), 0);
});

test("the margin leaves a default-interval daemon a whole sweep to append in", () => {
  // The margin is two `DEFAULT_INTERVAL_MS`. One would only put the LAPSE before
  // the cap and let the append land on it; two put the append at `cap - 30s` at
  // the latest. The relation is what the guarantee rests on, so it is asserted
  // rather than left in prose.
  assert.equal(HARNESS_CAP_MARGIN_MS, 2 * 30_000);
});

// ---------------------------------------------------------------------------
// 2. The narrowing is applied by the lazy judge
// ---------------------------------------------------------------------------

test("a capped request is read as expired by the lazy judge before the cap elapses", () => {
  const unit = ready();
  const cap = 300_000;
  ask(unit, cap);
  const ttl = cap - HARNESS_CAP_MARGIN_MS;

  const live = stateAt(unit, ms(ttl));
  assert.equal(live.state, "requested", "the request lapses at the deadline, not before it");
  assert.equal(live.effectiveTtlMs, ttl);
  assert.equal(live.declared.harness_cap_ms, cap);

  const lapsed = stateAt(unit, ms(ttl + 1));
  assert.equal(lapsed.state, "expired");
  assert.equal(lapsed.expiredLazily, true);
  assert.equal(lapsed.expiredByEvent, false);
  // The property the whole task is about, stated as arithmetic: the moment the
  // gate calls this request dead is strictly earlier than the moment the harness
  // stops holding the call.
  assert.ok(ttl + 1 < cap, `${String(ttl + 1)} is not strictly before the cap ${String(cap)}`);

  assertClean(unit);
});

test("an uncapped request is unchanged: the policy TTL is the only deadline", () => {
  const unit = ready();
  ask(unit, null);
  const derived = stateAt(unit, ms(300_000));
  assert.equal(derived.state, "requested");
  assert.equal(derived.declared.harness_cap_ms, null);
  assert.equal(derived.effectiveTtlMs, 3_600_000);
  assertClean(unit);
});

test("a policy with no approval_ttl is still bounded by the request's cap", () => {
  const unit = ready(POLICY_NO_TTL);
  ask(unit, 300_000);
  // `null` is what `loadPolicy` hands the judge for a policy that declares no
  // TTL, and it is what the daemon and the gate both pass.
  assert.equal(stateAt(unit, ms(239_000), null).state, "requested");
  assert.equal(stateAt(unit, ms(241_000), null).state, "expired");
  assertClean(unit);
});

test("an absurd cap on the wire does not extend the policy TTL", () => {
  const unit = ready();
  ask(unit, 10 * 3_600_000);
  const past = stateAt(unit, ms(3_600_001));
  assert.equal(past.state, "expired", "a claimed cap must not keep a lapsed request alive");
  assert.equal(past.effectiveTtlMs, 3_600_000);
  assertClean(unit);
});

test("an unreadable cap reads as no cap at all", () => {
  // The write boundary drops a non-positive or non-finite cap rather than
  // recording it, so the payload never carries a number a reader would have to
  // reinterpret. Asserted on the record, because "the field is absent" is the
  // property, not "the field is present and ignored".
  const unit = ready();
  const result = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: ACTION_KEY,
      cls: CLASS,
      summary: "Send the chaser",
      payload_hash: BINDING,
      execution: "harness",
      harnessCapMs: -5,
    },
    T0,
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const opened = records(unit).filter((record) => record.event === "approval.requested");
  const payload = opened[0]?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.["harness_cap_ms"], undefined);
  assert.equal(stateAt(unit, ms(300_000)).state, "requested");
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// 3. The daemon appends the expiry before the cap elapses
// ---------------------------------------------------------------------------

/** One in-process daemon pass at `T0 + offset`, returning what it emitted. */
async function tick(unit: Scenario, offset: number): Promise<DaemonEvent[]> {
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
    clock: fixedClock(ms(offset)),
    sink: { emit: (event) => emitted.push(event) },
  });
  const outcome = await daemon.run();
  assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
  return emitted;
}

test("the daemon expires a capped request strictly before its harness cap elapses", async () => {
  const unit = ready();
  const cap = 300_000;
  ask(unit, cap);
  const ttl = cap - HARNESS_CAP_MARGIN_MS;

  // A pass inside the window appends nothing: the sweep re-derives its candidate
  // list from the log every time and this request is not on it yet.
  const early = await tick(unit, ttl - 1);
  assert.equal(
    early.filter((event) => event.event === "expired").length,
    0,
    "the sweep expired a request that had not lapsed",
  );
  assert.equal(
    records(unit).filter((record) => record.event === "approval.expired").length,
    0,
  );

  // The tick the daemon at its default interval would make next. A daemon
  // running at `DEFAULT_INTERVAL_MS` sweeps within one interval of the lapse,
  // and the margin is two of them, so this instant is inside the window the
  // margin buys and strictly before the cap.
  const sweepAt = ttl + 30_000;
  assert.ok(sweepAt < cap, `the sweep instant ${String(sweepAt)} is not before ${String(cap)}`);

  const emitted = await tick(unit, sweepAt);
  const expired = emitted.filter((event) => event.event === "expired");
  assert.equal(expired.length, 1, JSON.stringify(emitted));

  const written = records(unit).filter((record) => record.event === "approval.expired");
  assert.equal(written.length, 1);
  const at = Date.parse(written[0]?.ts ?? "");
  assert.ok(
    at - Date.parse(T0) < cap,
    `approval.expired landed at +${String(at - Date.parse(T0))}ms, not before the ${String(cap)}ms cap`,
  );

  // Idempotent with itself, exactly as SPEC.md §10.2 requires: a second pass
  // re-derives and finds nothing, because the candidate no longer satisfies the
  // predicate.
  const again = await tick(unit, sweepAt + 1_000);
  assert.equal(again.filter((event) => event.event === "expired").length, 0);
  assert.equal(records(unit).filter((record) => record.event === "approval.expired").length, 1);

  assertClean(unit);
});

test("the sweep changes no verdict: the candidate list agrees with the lazy judge", () => {
  const unit = ready();
  const cap = 300_000;
  ask(unit, cap);
  const ttl = cap - HARNESS_CAP_MARGIN_MS;
  const policyTtl = 3_600_000;

  // The two answers come from the same narrowing, so they cannot disagree. This
  // is what keeps SPEC.md §10.2's promise true for a capped request: the daemon
  // records a lapse the gate would already have judged, rather than one only the
  // daemon knows about.
  assert.deepEqual(lapsedRequests(records(unit), ms(ttl), policyTtl), []);
  const due = lapsedRequests(records(unit), ms(ttl + 1), policyTtl);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.actionKey, ACTION_KEY);
  assert.equal(stateAt(unit, ms(ttl + 1)).state, "expired");

  assertClean(unit);
});

// ---------------------------------------------------------------------------
// 4. A tap after the expiry authorizes nothing
// ---------------------------------------------------------------------------

test("a tap after the cap-derived expiry is refused and never becomes a grant", () => {
  const unit = ready();
  const cap = 300_000;
  ask(unit, cap);
  const ttl = cap - HARNESS_CAP_MARGIN_MS;

  // The daemon's record, written through the gate's own verb at an instant
  // inside the window and before the cap.
  const expired = expire(unit.logPath, ACTION_KEY, ms(ttl + 30_000), unit.options);
  assert.equal(expired.ok, true, JSON.stringify(expired));

  // The tap. Late by the cap's reckoning and early by the policy's — which is
  // precisely the interval this task closes.
  const tap = decide(unit.logPath, ACTION_KEY, "grant", "human:carter", ms(cap + 5_000), {
    ...unit.options,
  });
  assert.equal(tap.ok, false, "a tap on an expired request produced a decision");
  // The code that already existed for "this request is no longer pending
  // because it lapsed". APRV-423 adds no refusal to the frozen union (SPEC.md
  // §11.1 invariant 6); it moves the instant at which this one starts firing.
  if (!tap.ok) assert.equal(tap.code, "expired");

  assert.equal(records(unit).filter((record) => record.event === "approval.granted").length, 0);
  assertClean(unit);
});

test("expire's not-expired refusal names the deadline it actually judged", () => {
  const unit = ready();
  const cap = 300_000;
  ask(unit, cap);
  const early = expire(unit.logPath, ACTION_KEY, ms(1_000), unit.options);
  assert.equal(early.ok, false);
  if (!early.ok) {
    assert.equal(early.code, "not-expired");
    // The number an operator reads has to be the number that refused them: the
    // narrowed TTL, and the cap that narrowed it, rather than the policy line.
    assert.match(early.message, /240000ms TTL/);
    assert.match(early.message, /300000ms harness cap/);
  }
  assertClean(unit);
});
