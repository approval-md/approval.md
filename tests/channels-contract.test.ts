/**
 * Channel contract tests (APRV-22).
 *
 * Same discipline as every other suite here: nothing hand-writes a log line.
 * The policy is attested through `core/attest.ts`, tasks are registered and
 * requested through `core/gate.ts`, and every decision goes through the real
 * human-only `decide()`. The one file written by hand is a *copy* of a real log
 * with a record tampered, which is how `tests/state.test.ts` exercises
 * `log-corrupt` — the corruption is the fixture, not a fabricated authorization.
 *
 * Timestamps are injected as clocks (amended SPEC.md §8, A2).
 *
 * The last two tests are the ones that matter most: they run the shared
 * conformance suite against deliberately broken channels and assert it goes
 * RED. A conformance suite nobody has watched fail is a suite that might pass
 * anything.
 */

import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  assembleBatch,
  batchDeliveryIdOf,
  batchNote,
  recordBatchDecisions,
} from "../src/channels/batch.js";
import {
  BATCH_DELIVERY_ID_FIELD,
  CHANNEL_REQUEST_REFUSAL_CODES,
  COMPUTED_SOURCES,
  claimed,
  computed,
  createChannelRequest,
  isTaggedField,
  recordChannelDecision,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
  type DeliveryId,
  type RenderedField,
  type RenderedRequest,
  type TestableChannel,
} from "../src/channels/contract.js";
import { payloadRegionText } from "../src/channels/payload-view.js";
import {
  runChannelConformance,
  type ConformanceCase,
  type ConformanceHarness,
} from "../src/channels/conformance.js";
import {
  buildChannelRequest,
  buildPendingQueue,
  CHANNEL_TAG_REFUSAL_CODES,
  type TagOptions,
} from "../src/channels/tagging.js";
import { evaluateBudgetsWithTask } from "../src/core/budgets.js";
import { payloadHash } from "../src/core/payload.js";
import { explain } from "../src/core/policy-explain.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { proposeAttestation } from "../src/core/policy-proposal.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { decide, register, request } from "./clock-adapters.js";
import { assertClean, at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("channels-contract");
after(scratch.cleanup);

/**
 * A policy with real limits, so the budget snapshot a channel would render is
 * something more than an empty array.
 */
const POLICY_WITH_LIMITS = [
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
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "      daily_actions: 5",
  "```",
  "",
].join("\n");

const TASK = "task-100";
const ACTOR = "agent:drafter";
const HUMAN = "human:carter";

/** Distinct payloads: distinct bytes, distinct bindings, distinct hashes. */
function payloadFor(index: number): Record<string, unknown> {
  return {
    to: [`ap-${index}@vendor.example`],
    subject: `Invoice ${41 + index} chaser`,
    body: `Following up on invoice ${41 + index}, now ${14 + index} days overdue.`,
  };
}

function actionKeyFor(index: number): string {
  return `${TASK}:chaser-${index}:2026-08-05`;
}

interface Live {
  unit: Scenario;
  keys: string[];
  payloads: Map<string, unknown>;
  tagOptions: TagOptions;
}

/**
 * `count` live manual requests in a fresh log, built through the real gate.
 *
 * Registration at {@link T0}, requests at `at(1)`, and every action declares a
 * `payload_hash` because amended SPEC.md §6.2 makes the binding mandatory on
 * the manual path.
 */
function live(count: number, policyText: string = POLICY_WITH_LIMITS): Live {
  const unit = newScenario(scratch.root, policyText);
  attest(unit, T0);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = actionKeyFor(index);
    const payload = payloadFor(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${41 + index}`,
      reversible: false,
      est_cost_usd: "0.02",
      payload_hash: payloadHash(payload),
    });
  }

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: ACTOR },
        state: "awaiting",
        actions,
      },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, "registration failed");

  for (const key of keys) {
    const requested = request(
      unit.logPath,
      {
        task: TASK,
        actionKey: key,
        cls: "communicate.email.external",
        est_cost_usd: "0.02",
        reversible: false,
        summary: `chase invoice ${41 + keys.indexOf(key)}`,
      },
      at(1),
      ACTOR,
      unit.options,
    );
    assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);
  }

  return {
    unit,
    keys,
    payloads,
    tagOptions: {
      policy: { file: unit.policyPath },
      payload: (key) => payloads.get(key),
    },
  };
}

const NOW = at(2);

function recordsOf(logPath: string) {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, "log did not verify");
  return read.ok ? read.records : [];
}

// ---------------------------------------------------------------------------
// The tagger
// ---------------------------------------------------------------------------

test("computed fields are derived from the engines, not restated", () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const built = buildChannelRequest(world.unit.logPath, key, world.tagOptions, NOW);
  assert.equal(built.ok, true, JSON.stringify(built));
  if (!built.ok) return;
  const request_ = built.request;

  const load = loadPolicy({ file: world.unit.policyPath });
  const explanation = explain(load, "communicate.email.external", { reversible: false });
  const resolution = resolve(load, "communicate.email.external", { reversible: false });
  const records = recordsOf(world.unit.logPath);

  assert.deepEqual(request_.action_key, computed(key, "log"));
  assert.deepEqual(request_.task, computed(TASK, "log"));
  assert.deepEqual(request_.class, computed("communicate.email.external", "log"));
  assert.deepEqual(request_.autonomy, computed(explanation.outcome.autonomy, "policy-match"));
  assert.deepEqual(request_.provenance, computed(explanation.provenance, "policy-match"));
  assert.equal(request_.autonomy.value, "manual");

  // Budgets: the same call the gate makes, at the same instant, deep-equal.
  const expected = evaluateBudgetsWithTask(
    records,
    {
      classLimits: resolution.limits,
      classPattern: resolution.matched === null ? null : resolution.matched.pattern,
      globalBudgets: load.ok ? load.policy.budgets ?? null : null,
    },
    { class: "communicate.email.external", est_cost_usd: "0.02" },
    NOW,
    TASK,
  );
  assert.deepEqual(request_.budgets, computed(expected.verdicts, "budgets"));
  assert.ok(expected.verdicts.length >= 2, "the fixture policy should produce real verdicts");

  assert.equal(request_.attestation.kind, "computed");
  assert.equal(request_.attestation.value.status, "attested");

  const requestRecord = records.find((record) => record.event === "approval.requested");
  assert.ok(requestRecord !== undefined);
  assert.deepEqual(request_.chain.value, {
    seq: requestRecord.seq,
    hash: requestRecord.hash,
    head_seq: records[records.length - 1]?.seq,
  });

  assert.deepEqual(request_.requested_ts, computed(at(1), "log"));
  // 1h TTL, one minute of it spent.
  assert.deepEqual(request_.ttl_remaining_ms, computed(3_540_000, "clock"));
  assert.deepEqual(request_.state, computed("requested", "log"));
});

test("claimed fields carry the actor who authored them", () => {
  const world = live(1);
  const built = buildChannelRequest(
    world.unit.logPath,
    world.keys[0] as string,
    world.tagOptions,
    NOW,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.deepEqual(built.request.summary, claimed("chase invoice 41", ACTOR));
  assert.deepEqual(built.request.est_cost_usd, claimed(0.02, ACTOR));
  assert.equal(built.request.summary.kind, "claimed");
  assert.equal(built.request.est_cost_usd.kind, "claimed");
});

// ---------------------------------------------------------------------------
// The deadline says which day (APRV-143 #1)
// ---------------------------------------------------------------------------

/** {@link POLICY_WITH_LIMITS} with a different `approval_ttl`. */
function policyWithTtl(ttl: string): string {
  return POLICY_WITH_LIMITS.replace('approval_ttl: "1h"', `approval_ttl: ${JSON.stringify(ttl)}`);
}

/** The `waiting` line of the first request of a world, rendered at `now`. */
function waitingAt(world: Live, now: string): string {
  const built = buildChannelRequest(world.unit.logPath, world.keys[0] as string, world.tagOptions, now);
  assert.equal(built.ok, true, JSON.stringify(built));
  if (!built.ok) return "";
  assert.equal(built.request.waiting.kind, "computed");
  return built.request.waiting.value;
}

test("a same-day deadline renders the time alone, exactly as it always did", () => {
  // Requested 10:01, a 1h TTL, read one minute in: 11:01 on the same UTC day.
  // The unqualified form is the one an approver already knows how to read, and
  // APRV-143 must not have made the common case noisier.
  const world = live(1, policyWithTtl("1h"));
  assert.equal(waitingAt(world, at(2)), "requested 1 min ago · expires 11:01 UTC");
  assertClean(world.unit);
});

test("a deadline on the next UTC day says tomorrow", () => {
  // The observed failure, and the reason this task exists: a 24h TTL rendered
  // as `expires 10:01 UTC` beside `requested 1 min ago`, so the approver did
  // the arithmetic, landed nine minutes in the past, and read the question as
  // already dead.
  const world = live(1, policyWithTtl("24h"));
  assert.equal(waitingAt(world, at(2)), "requested 1 min ago · expires tomorrow 10:01 UTC");
  assertClean(world.unit);
});

test("a deadline further out names the date", () => {
  // Requested 2026-08-05T10:01, a 72h TTL: 2026-08-08.
  const world = live(1, policyWithTtl("72h"));
  assert.equal(waitingAt(world, at(2)), "requested 1 min ago · expires 8 Aug 10:01 UTC");
  assertClean(world.unit);
});

test("the day word tracks the calendar boundary, not the hours remaining", () => {
  // One request, one TTL, two reading instants. At at(2) the deadline is three
  // days out and dated; at at(2761) — 46 hours later, so 08:02 on 7 August with
  // 26 hours still to run — the same deadline is "tomorrow". A word derived
  // from the duration would have said the same thing twice; this one is
  // computed from the UTC day boundary, which is the boundary the clock beside
  // it is printed in.
  const world = live(1, policyWithTtl("72h"));
  assert.match(waitingAt(world, at(2)), /expires 8 Aug 10:01 UTC$/u);
  assert.match(waitingAt(world, at(2761)), /expires tomorrow 10:01 UTC$/u);
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// The protected path is named (APRV-143 #3)
// ---------------------------------------------------------------------------

/**
 * One live `policy.edit` request carrying `payload`, built through the real
 * gate, in the shape `cli/hook.ts` writes.
 *
 * The point of going through the gate rather than hand-building a request is
 * the point of this whole suite: the protected-path line is derived from bytes
 * that {@link buildChannelRequest} has hash-checked against what the log
 * recorded, so a test that skipped the log would not be testing the derivation
 * that runs in production.
 */
function edit(payload: unknown, policyText: string = POLICY_WITH_LIMITS): Live {
  const unit = newScenario(scratch.root, policyText);
  attest(unit, T0);
  const key = "hook:sess-1:tu-1:policy.edit";

  const registered = register(
    unit.logPath,
    {
      task: "hook:sess-1:tu-1",
      envelope: {
        origin: { app: "claude-code-hook", created_by: ACTOR },
        state: "proposed",
        actions: [
          {
            class: "policy.edit",
            idempotency_key: key,
            summary: "a protected file",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const requested = request(
    unit.logPath,
    {
      task: "hook:sess-1:tu-1",
      actionKey: key,
      cls: "policy.edit",
      summary: "a protected file",
      payload_hash: payloadHash(payload),
      payload: { value: payload },
      execution: "harness",
    },
    at(1),
    ACTOR,
    unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  return {
    unit,
    keys: [key],
    payloads: new Map([[key, payload]]),
    tagOptions: { policy: { file: unit.policyPath }, payload: () => payload },
  };
}

/** The `protected_path` field of the one request in `world`, or `undefined`. */
function protectedPathOf(world: Live) {
  const built = buildChannelRequest(world.unit.logPath, world.keys[0] as string, world.tagOptions, NOW);
  assert.equal(built.ok, true, JSON.stringify(built));
  return built.ok ? built.request.protected_path : undefined;
}

test("a shell payload names the protected path its class came from", () => {
  // The command edits two files and only one of them is protected. Before
  // APRV-143 the prompt said `class: policy.edit` and left the approver to work
  // out which — the whole complaint, in one line.
  const world = edit({
    command: "cp notes.md docs/notes.md && cp draft.md .github/workflows/ci.yml",
    cwd: "/repo",
  });
  const field = protectedPathOf(world);
  assert.deepEqual(field, computed(".github/workflows/ci.yml (rule protected-path)", "classifier"));
  assertClean(world.unit);
});

test("a redirection onto a protected path is named too, with its own rule", () => {
  const world = edit({ command: "echo hi > CLAUDE.md", cwd: "/repo" });
  assert.deepEqual(
    protectedPathOf(world),
    computed("CLAUDE.md (rule redirect-protected)", "classifier"),
  );
  assertClean(world.unit);
});

test("a file-tool payload names its target, and keeps the hook's tier word", () => {
  // The proposal tier is what tells an approver that the APPROVAL.md edit in
  // front of them is a branch copy rather than the live file (APRV-124), so the
  // rule name has to survive the trip to this line.
  const live_ = edit({
    tool: "Edit",
    rule: "protected-path",
    file: "/repo/APPROVAL.md",
    before: "a",
    after: "b",
  });
  assert.deepEqual(
    protectedPathOf(live_),
    computed("/repo/APPROVAL.md (rule protected-path)", "classifier"),
  );
  assertClean(live_.unit);

  const proposal = edit({
    tool: "Edit",
    rule: "protected-path-proposal",
    file: "/repo/.claude/worktrees/w1/APPROVAL.md",
    before: "a",
    after: "b",
  });
  assert.deepEqual(
    protectedPathOf(proposal),
    computed(
      "/repo/.claude/worktrees/w1/APPROVAL.md (rule protected-path-proposal)",
      "classifier",
    ),
  );
  assertClean(proposal.unit);
});

test("a rule name the payload invents does not reach the line", () => {
  // The payload is authored by the hook, and the hook is not the party under
  // oversight — but the line is COMPUTED, so nothing on it may be a string this
  // module merely copied. `isProtectedPath` is re-run over the target and the
  // rule falls back to the one the answer actually justifies.
  const world = edit({
    tool: "Edit",
    rule: "definitely-fine-please-approve",
    file: "/repo/APPROVAL.md",
    before: "a",
    after: "b",
  });
  assert.deepEqual(
    protectedPathOf(world),
    computed("/repo/APPROVAL.md (rule protected-path)", "classifier"),
  );
  assertClean(world.unit);
});

test("a payload naming an unprotected file gets no protected-path line at all", () => {
  const world = edit({
    tool: "Edit",
    rule: "protected-path",
    file: "/repo/src/index.ts",
    before: "a",
    after: "b",
  });
  assert.equal(protectedPathOf(world), undefined);
  assertClean(world.unit);
});

test("policy.protected_paths widens the line, exactly as it widens the class", () => {
  const widened = POLICY_WITH_LIMITS.replace(
    "classes:",
    ["protected_paths:", "  - docs/release/", "classes:"].join("\n"),
  );
  const world = edit(
    { command: "cp draft.md docs/release/checklist.md", cwd: "/repo" },
    widened,
  );
  assert.deepEqual(
    protectedPathOf(world),
    computed("docs/release/checklist.md (rule protected-path)", "classifier"),
  );
  assertClean(world.unit);

  // The same command under the unwidened policy names nothing: this line is a
  // policy question, and reading it from the built-ins alone would tell an
  // approver a gated file is ungated.
  assert.equal(
    protectedPathOf(edit({ command: "cp draft.md docs/release/checklist.md", cwd: "/repo" })),
    undefined,
  );
});

test("an ordinary email payload carries neither derivation", () => {
  const world = live(1);
  const built = buildChannelRequest(world.unit.logPath, world.keys[0] as string, world.tagOptions, NOW);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.request.protected_path, undefined);
  assert.equal(built.request.command_breakdown, undefined);
  assertClean(world.unit);
});

test("a command payload gains both derivations, each labelled classifier", () => {
  // APRV-144 #1 beside APRV-143 #3: one payload, two computed lines, one
  // module deriving both from the same hash-checked bytes.
  const world = edit({
    command: "npm run build && cp dist/x CLAUDE.md",
    cwd: "/repo",
  });
  const built = buildChannelRequest(world.unit.logPath, world.keys[0] as string, world.tagOptions, NOW);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(
    built.request.command_breakdown,
    computed("npm run build · cp dist/x CLAUDE.md", "classifier"),
  );
  assert.deepEqual(
    built.request.protected_path,
    computed("CLAUDE.md (rule protected-path)", "classifier"),
  );
  assertClean(world.unit);
});

test("the tagger never attaches a gloss", () => {
  // A model's sentence is not derived from the log, the policy or the bound
  // bytes, so it has no business on the runtime side of the boundary. The
  // listener attaches it at render time; nothing here does.
  const world = edit({ command: "git status", cwd: "/repo" });
  const built = buildChannelRequest(world.unit.logPath, world.keys[0] as string, world.tagOptions, NOW);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.request.gloss, undefined);
  assertClean(world.unit);
});

test("every member of a built request is a tagged field", () => {
  const world = live(1);
  const built = buildChannelRequest(
    world.unit.logPath,
    world.keys[0] as string,
    world.tagOptions,
    NOW,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  for (const [name, field] of Object.entries(built.request)) {
    assert.ok(isTaggedField(field), `${name} is not tagged`);
  }
});

test("the full payload is verified against the recorded binding", () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const built = buildChannelRequest(world.unit.logPath, key, world.tagOptions, NOW);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendering = built.request.fullPayload.value;
  assert.ok(rendering !== null);
  assert.equal(rendering.hash, built.request.payload_hash.value);
  assert.equal(rendering.hash, payloadHash(world.payloads.get(key)));
  assert.equal(rendering.truncated, false);
  assert.match(rendering.text, /Invoice 41 chaser/u);
  assert.equal(built.request.fullPayload.kind, "computed");
});

test("payload material that does not hash to the binding is refused", () => {
  const world = live(1);
  const built = buildChannelRequest(
    world.unit.logPath,
    world.keys[0] as string,
    { ...world.tagOptions, payload: () => ({ to: ["attacker@example.test"] }) },
    NOW,
  );
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.code, "payload-mismatch");
  assert.match(built.message, /bound to/u);
});

test("a manual request with no payload material never reaches a channel", () => {
  const world = live(1);
  const built = buildChannelRequest(
    world.unit.logPath,
    world.keys[0] as string,
    { policy: { file: world.unit.policyPath } },
    NOW,
  );
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.code, "payload-unavailable");
  assert.match(built.message, /§10\.4/u);
});

test("createChannelRequest refuses a manual request with a null full payload", () => {
  const world = live(1);
  const built = buildChannelRequest(
    world.unit.logPath,
    world.keys[0] as string,
    world.tagOptions,
    NOW,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const stripped = createChannelRequest({
    ...built.request,
    fullPayload: computed(null, "payload-binding"),
  });
  assert.equal(stripped.ok, false);
  if (stripped.ok) return;
  assert.equal(stripped.code, "manual-payload-required");

  // And an untagged member is refused too, from a caller TypeScript did not see.
  const untagged = createChannelRequest({
    ...built.request,
    summary: "just a string" as unknown as ChannelRequest["summary"],
  });
  assert.equal(untagged.ok, false);
  if (untagged.ok) return;
  assert.equal(untagged.code, "untagged-field");
});

test("unknown and already-decided keys are refused, not rendered", () => {
  const world = live(1);
  const key = world.keys[0] as string;

  const unknown = buildChannelRequest(
    world.unit.logPath,
    "task-100:nope:2026-08-05",
    world.tagOptions,
    NOW,
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "not-requested");

  const decided = decide(world.unit.logPath, key, "reject", HUMAN, NOW, world.unit.options);
  assert.equal(decided.ok, true);

  const after_ = buildChannelRequest(world.unit.logPath, key, world.tagOptions, at(3));
  assert.equal(after_.ok, false);
  if (!after_.ok) assert.equal(after_.code, "not-awaiting");
  assertClean(world.unit);
});

test("an expired request is not rendered as pending", () => {
  const world = live(1);
  // 1h TTL; ask two hours later.
  const built = buildChannelRequest(
    world.unit.logPath,
    world.keys[0] as string,
    world.tagOptions,
    at(121),
  );
  assert.equal(built.ok, false);
  if (!built.ok) assert.equal(built.code, "not-awaiting");
});

test("a log that does not verify renders nothing", () => {
  const world = live(1);
  const tampered = `${world.unit.logPath}.tampered`;
  copyFileSync(world.unit.logPath, tampered);
  const lines = readFileSync(tampered, "utf8").split("\n");
  const record = JSON.parse(lines[1] as string) as Record<string, unknown>;
  record["payload"] = { note: "forged" };
  lines[1] = JSON.stringify(record);
  writeFileSync(tampered, lines.join("\n"));

  const built = buildChannelRequest(tampered, world.keys[0] as string, world.tagOptions, NOW);
  assert.equal(built.ok, false);
  if (!built.ok) assert.equal(built.code, "log-corrupt");

  const queue = buildPendingQueue(tampered, world.tagOptions, NOW);
  assert.equal(queue.ok, false);
  if (!queue.ok) assert.equal(queue.code, "log-corrupt");
});

test("the pending queue holds every live request and skips what it cannot render", () => {
  const world = live(2);
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, NOW);
  assert.equal(queue.ok, true);
  if (!queue.ok) return;
  assert.deepEqual(
    queue.requests.map((entry) => entry.action_key.value),
    world.keys,
  );
  assert.deepEqual(queue.skipped, []);

  // Decide one: the queue drops it, and keeps the other.
  const decided = decide(
    world.unit.logPath,
    world.keys[0] as string,
    "grant",
    HUMAN,
    NOW,
    world.unit.options,
  );
  assert.equal(decided.ok, true, JSON.stringify(decided));

  const after_ = buildPendingQueue(world.unit.logPath, world.tagOptions, at(3));
  assert.equal(after_.ok, true);
  if (!after_.ok) return;
  assert.deepEqual(
    after_.requests.map((entry) => entry.action_key.value),
    [world.keys[1]],
  );

  // With no payload material, the live request is skipped *visibly*.
  const blind = buildPendingQueue(
    world.unit.logPath,
    { policy: { file: world.unit.policyPath } },
    at(3),
  );
  assert.equal(blind.ok, true);
  if (!blind.ok) return;
  assert.deepEqual(blind.requests, []);
  assert.equal(blind.skipped.length, 1);
  assert.equal(blind.skipped[0]?.code, "payload-unavailable");
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Batching (B7)
// ---------------------------------------------------------------------------

function queueOf(world: Live, now: string = NOW): ChannelRequest[] {
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, now);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return queue.ok ? queue.requests : [];
}

test("two whole payloads assemble; a truncated one is the forbidden mix", () => {
  const world = live(2);
  const requests = queueOf(world);
  assert.equal(requests.length, 2);

  const ok = assembleBatch(requests);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.batch.requests, requests);
    assert.equal(ok.batch.deliveryId, undefined, "the delivery id is the channel's to assign");
  }

  const first = requests[0] as ChannelRequest;
  const second = requests[1] as ChannelRequest;
  assert.notEqual(first.payload_hash.value, second.payload_hash.value);

  const truncated: ChannelRequest = {
    ...second,
    fullPayload: computed(
      { ...(second.fullPayload.value as NonNullable<typeof second.fullPayload.value>), truncated: true },
      "payload-binding",
    ),
  };
  const mixed = assembleBatch([first, truncated]);
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.equal(mixed.code, "batch-forbidden-mix");
    assert.match(mixed.message, /§10\.3/u);
  }
});

test("one payload requested twice is never a forbidden mix", () => {
  const world = live(1);
  const requests = queueOf(world);
  const only = requests[0] as ChannelRequest;
  const truncated: ChannelRequest = {
    ...only,
    fullPayload: computed(
      { ...(only.fullPayload.value as NonNullable<typeof only.fullPayload.value>), truncated: true },
      "payload-binding",
    ),
  };
  // Same bytes: there is no "another" for it to hide behind.
  assert.equal(assembleBatch([only, truncated]).ok, true);
  assert.equal(assembleBatch([]).ok, true);
});

// ---------------------------------------------------------------------------
// Recording decisions
// ---------------------------------------------------------------------------

test("recordChannelDecision lands exactly one event through the real gate", () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const before = recordsOf(world.unit.logPath).length;

  const result = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "mock-1", note: "looks right" },
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );

  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  assert.equal(typeof result.token, "string", "a grant mints a token for the runtime");

  const records = recordsOf(world.unit.logPath);
  assert.equal(records.length, before + 1);
  const appended = records[records.length - 1];
  assert.equal(appended?.event, "approval.granted");
  assert.equal(appended?.action_key, key);
  assert.equal(appended?.actor, HUMAN);
  assert.equal(batchDeliveryIdOf(appended as NonNullable<typeof appended>), null);
  if (result.outcome.ok) {
    assert.equal(result.outcome.tokenIssued, true);
    assert.equal("token" in result.outcome, false, "the token must not reach the channel");
  }
  assertClean(world.unit);
});

test("a non-human actor cannot record a decision, and a duplicate is refused", () => {
  const world = live(1);
  const key = world.keys[0] as string;

  const byAgent = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "mock-1" },
    { actor: ACTOR },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );
  assert.equal(byAgent.outcome.ok, false);
  if (!byAgent.outcome.ok) assert.equal(byAgent.outcome.code, "actor-not-human");
  assert.equal(byAgent.token, undefined);

  const first = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "mock-1" },
    { actor: HUMAN },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );
  assert.equal(first.outcome.ok, true);

  const before = recordsOf(world.unit.logPath).length;
  const again = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "mock-1" },
    { actor: HUMAN },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(again.outcome.ok, false);
  if (!again.outcome.ok) assert.equal(again.outcome.code, "already-decided");
  assert.equal(recordsOf(world.unit.logPath).length, before, "a refused duplicate appends nothing");
  assertClean(world.unit);
});

test("a batch gesture produces one event per member, each carrying the batch id", () => {
  const world = live(2);
  const before = recordsOf(world.unit.logPath).length;
  const decisions: ChannelDecision[] = world.keys.map((key) => ({
    action_key: key,
    decision: "grant" as const,
    deliveryId: "mock-batch-1",
  }));

  const result = recordBatchDecisions(
    world.unit.logPath,
    decisions,
    "mock-batch-1",
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );
  assert.equal(result.ok, true, JSON.stringify(result.results));
  assert.equal(result.results.length, 2);

  const records = recordsOf(world.unit.logPath);
  assert.equal(records.length, before + 2, "the log never batches");
  for (const record of records.slice(before)) {
    assert.equal(record.event, "approval.granted");
    assert.equal(batchDeliveryIdOf(record), "mock-batch-1");
  }
  assertClean(world.unit);
});

test("a batch member that refuses does not stop the rest", () => {
  const world = live(2);
  const first = world.keys[0] as string;
  // Decide one member out of band, so the batch pass finds it terminal.
  assert.equal(decide(world.unit.logPath, first, "reject", HUMAN, NOW, world.unit.options).ok, true);

  const before = recordsOf(world.unit.logPath).length;
  const result = recordBatchDecisions(
    world.unit.logPath,
    world.keys.map((key) => ({ action_key: key, decision: "grant" as const, deliveryId: "d" })),
    "mock-batch-2",
    { actor: HUMAN },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );

  assert.equal(result.ok, false, "a partially refused batch is not ok");
  assert.equal(result.results[0]?.outcome.ok, false);
  if (result.results[0]?.outcome.ok === false) {
    assert.equal(result.results[0].outcome.code, "already-decided");
  }
  assert.equal(result.results[1]?.outcome.ok, true, "the second member still landed");

  const records = recordsOf(world.unit.logPath);
  assert.equal(records.length, before + 1, "exactly the member that could be recorded was");
  assert.equal(batchDeliveryIdOf(records[records.length - 1] as never), "mock-batch-2");
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// The batch delivery id: first-class field, and the v0.1 dual-read window
// (amended SPEC.md §10.3, APRV-38)
// ---------------------------------------------------------------------------

/** The payload of `record`, as a plain bag. */
function payloadOf(record: { payload?: Record<string, unknown> }): Record<string, unknown> {
  return record.payload ?? {};
}

test("a batch decision records batch_delivery_id as a payload field, and leaves the note to the human", () => {
  const world = live(1);
  const key = world.keys[0] as string;

  const result = recordBatchDecisions(
    world.unit.logPath,
    [{ action_key: key, decision: "grant", deliveryId: "d", note: "fine by me" }],
    "mock-batch-3",
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );
  assert.equal(result.ok, true, JSON.stringify(result.results));

  const records = recordsOf(world.unit.logPath);
  const record = records[records.length - 1] as NonNullable<(typeof records)[number]>;
  const payload = payloadOf(record);
  assert.equal(payload[BATCH_DELIVERY_ID_FIELD], "mock-batch-3");
  assert.equal(
    payload["note"],
    "fine by me",
    "the human's note carries the human's words and nothing else now that the id has its own field",
  );
  assert.equal(batchDeliveryIdOf(record), "mock-batch-3");
  assertClean(world.unit);
});

test("batchDeliveryIdOf still resolves the pre-APRV-38 note encoding", () => {
  const world = live(1);
  const key = world.keys[0] as string;

  // Written through the real gate: the legacy encoding was only ever a note,
  // so reproducing it needs no fabricated log line, just the note a v0.1 build
  // would have passed.
  const decided = decide(
    world.unit.logPath,
    key,
    "grant",
    HUMAN,
    NOW,
    { ...world.unit.options, note: batchNote("legacy-batch-9", "go ahead") },
  );
  assert.equal(decided.ok, true, JSON.stringify(decided));

  const records = recordsOf(world.unit.logPath);
  const record = records[records.length - 1] as NonNullable<(typeof records)[number]>;
  assert.equal(
    BATCH_DELIVERY_ID_FIELD in payloadOf(record),
    false,
    "the legacy shape carries no first-class field; that is what makes the fallback load-bearing",
  );
  assert.equal(batchDeliveryIdOf(record), "legacy-batch-9");
  assertClean(world.unit);
});

test("the first-class field wins over a note that disagrees with it", () => {
  const world = live(1);
  const key = world.keys[0] as string;

  const result = recordChannelDecision(
    world.unit.logPath,
    {
      action_key: key,
      decision: "grant",
      deliveryId: "d",
      batchDeliveryId: "field-batch",
      // A human whose note happens to begin with the legacy prefix, or a
      // relayed note from an older channel build. The field is the record the
      // runtime wrote; the note is text that arrived with the gesture.
      note: batchNote("note-batch", "go"),
    },
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));

  const records = recordsOf(world.unit.logPath);
  const record = records[records.length - 1] as NonNullable<(typeof records)[number]>;
  assert.equal(batchDeliveryIdOf(record), "field-batch");
  assertClean(world.unit);
});

test("a unit decision records no batch delivery id at all", () => {
  const world = live(1);
  const key = world.keys[0] as string;

  const result = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "reject", deliveryId: "mock-1", note: "no" },
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(NOW) },
  );
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));

  const records = recordsOf(world.unit.logPath);
  const record = records[records.length - 1] as NonNullable<(typeof records)[number]>;
  assert.equal(BATCH_DELIVERY_ID_FIELD in payloadOf(record), false);
  assert.equal(batchDeliveryIdOf(record), null);
  assertClean(world.unit);
});

test("the refusal-code unions and computed sources are frozen public API", () => {
  assert.deepEqual([...CHANNEL_REQUEST_REFUSAL_CODES], [
    "manual-payload-required",
    "untagged-field",
  ]);
  assert.deepEqual([...CHANNEL_TAG_REFUSAL_CODES], [
    "log-unreadable",
    "log-torn-tail",
    "log-corrupt",
    "not-requested",
    "not-awaiting",
    "class-missing",
    "payload-hash-missing",
    "payload-unavailable",
    "payload-mismatch",
    "payload-unrenderable",
    "request-invalid",
    // APRV-109: an attestation prompt whose policy bytes moved after it was
    // rendered is skipped rather than shown.
    "proposal-stale",
  ]);
  assert.deepEqual([...COMPUTED_SOURCES], [
    "log",
    "policy-match",
    "budgets",
    "attestation",
    // APRV-109: the load advisory on an attestation prompt, recomputed from the
    // live bytes at display time.
    "policy-load",
    "payload-binding",
    "classifier",
    "clock",
  ]);
});

// ---------------------------------------------------------------------------
// A mock channel, and the conformance suite run against it
// ---------------------------------------------------------------------------

/**
 * How a mock channel misbehaves.
 *
 * `correct` renders each field with the kind the request gave it and shows the
 * full payload verbatim. The other two are the two conformance failures SPEC.md
 * names: presenting a claimed field with the authority of a computed one (§9),
 * and collecting a manual decision without presenting the payload (§10.4).
 */
type MockMode = "correct" | "claimed-as-computed" | "no-full-payload";

class MockChannel implements TestableChannel {
  readonly name = "mock";
  private handler: ((decision: ChannelDecision) => DecisionOutcome) | null = null;
  private rendered: RenderedRequest[] = [];
  private counter = 0;

  constructor(private readonly mode: MockMode = "correct") {}

  notify(request_: ChannelRequest | { requests: ChannelRequest[] }): DeliveryId {
    this.counter += 1;
    const id = `mock-${this.name}-${this.counter}`;
    const isBatch = "requests" in request_;
    const members = isBatch ? request_.requests : [request_];
    this.rendered = members.map((member) => this.render(member, isBatch ? id : undefined));
    return id;
  }

  onDecision(handler: (decision: ChannelDecision) => DecisionOutcome): void {
    this.handler = handler;
  }

  health() {
    return { ok: true };
  }

  lastRendered(): RenderedRequest[] {
    return this.rendered;
  }

  /** The harness's simulated human gesture. */
  press(decision: ChannelDecision): DecisionOutcome {
    assert.ok(this.handler !== null, "no decision handler was registered");
    return this.handler(decision);
  }

  private render(request_: ChannelRequest, batchDeliveryId?: DeliveryId): RenderedRequest {
    const lie = this.mode === "claimed-as-computed";
    const fields: RenderedField[] = [
      { field: "class", kind: request_.class.kind, text: request_.class.value },
      { field: "autonomy", kind: request_.autonomy.kind, text: request_.autonomy.value },
      {
        field: "summary",
        kind: lie ? "computed" : request_.summary.kind,
        text: request_.summary.value ?? "(none)",
      },
      {
        field: "est_cost_usd",
        kind: lie ? "computed" : request_.est_cost_usd.kind,
        text: `$${request_.est_cost_usd.value.toFixed(2)}`,
      },
      { field: "payload_hash", kind: request_.payload_hash.kind, text: request_.payload_hash.value },
      // APRV-106: the age/deadline line. A conforming channel shows it, and
      // shows it as computed.
      { field: "waiting", kind: request_.waiting.kind, text: request_.waiting.value },
    ];
    const rendering = request_.fullPayload.value;
    return {
      action_key: request_.action_key.value,
      fields,
      // APRV-119: a conforming channel presents the CANONICAL rendering, which
      // carries the payload text inside it. Building the region from
      // `rendering.text` alone was conforming before WYSIWYS and is not now.
      fullPayloadText:
        this.mode === "no-full-payload" || rendering === null
          ? null
          : `--- payload ---\n${payloadRegionText(rendering, request_.class.value)}`,
      ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
    };
  }
}

let caseCounter = 0;

const harness: ConformanceHarness = {
  setup(count: number): ConformanceCase {
    caseCounter += 1;
    const world = live(count);
    const requests = queueOf(world);
    assert.equal(requests.length, count, "the harness could not build the requested queue");
    return {
      logPath: world.unit.logPath,
      requests,
      actor: { actor: HUMAN, channel: "mock" },
      gateOptions: { ...world.unit.options, clock: fixedClock(at(2 + caseCounter)) },
    };
  },
  decide(channel, decision) {
    return (channel as MockChannel).press(decision);
  },
};

test("a correct channel passes the shared conformance suite", async (t) => {
  await runChannelConformance(t, () => new MockChannel("correct"), harness);
});

test("the suite goes RED for a channel that renders a claimed field as computed", async () => {
  await assert.rejects(
    () => runChannelConformance({}, () => new MockChannel("claimed-as-computed"), harness),
    /rendered "summary" as computed, but it is claimed/u,
  );
});

test("the suite goes RED for a channel that drops the full payload", async () => {
  await assert.rejects(
    () => runChannelConformance({}, () => new MockChannel("no-full-payload"), harness),
    /rendered no full payload for manual action/u,
  );
});

// ---------------------------------------------------------------------------
// Attestation prompts (APRV-109)
// ---------------------------------------------------------------------------

/**
 * A live attestation prompt: the policy is attested, then edited, then proposed.
 *
 * The edit is a real one — `read.*` moves from autonomous to manual — so the
 * semantic diff has something to say, which is the whole point of the prompt
 * carrying more than a hash.
 */
function proposedWorld(): { world: Live; seq: number; actionKey: string } {
  const world = live(1);
  const baseline = readFileSync(world.unit.policyPath);
  writeFileSync(
    world.unit.policyPath,
    POLICY_WITH_LIMITS.replace(
      "  read.*:\n    autonomy: autonomous",
      "  read.*:\n    autonomy: manual",
    ),
    "utf8",
  );
  const proposal = proposeAttestation(
    world.unit.logPath,
    { policyPath: world.unit.policyPath, baseline, note: "tighten read.*" },
    ACTOR,
    { ...world.unit.options, clock: fixedClock(at(2)) },
  );
  assert.equal(proposal.ok, true, proposal.ok ? "" : proposal.message);
  if (!proposal.ok) throw new Error("the proposal fixture could not be built");
  return { world, seq: proposal.record.seq, actionKey: proposal.record.action_key as string };
}

test("an attestation prompt renders as an ordinary request, with the diff and the advisory", () => {
  const { world, actionKey } = proposedWorld();
  const built = buildChannelRequest(world.unit.logPath, actionKey, world.tagOptions, NOW);
  assert.equal(built.ok, true, JSON.stringify(built));
  if (!built.ok) return;

  const request_ = built.request;
  assert.equal(request_.class.value, "policy.edit");
  // Manual by FLOOR, not by a rule: attestation is human-only in code and the
  // act is irreversible, so the prompt reports a floor the policy cannot lower.
  assert.equal(request_.autonomy.value, "manual");
  assert.equal(request_.provenance.value, "floor");

  // The two additive members, both COMPUTED. A prompt carrying only a hash is
  // the failure this task exists to prevent.
  assert.notEqual(request_.policy_diff, undefined);
  assert.equal(request_.policy_diff?.kind, "computed");
  assert.match(String(request_.policy_diff?.value), /read\./u);
  assert.equal(request_.policy_load?.kind, "computed");
  assert.match(String(request_.policy_load?.value), /loads clean/u);

  // The proposer's words are the one CLAIMED field on the prompt.
  assert.equal(request_.summary.kind, "claimed");
  assert.equal(request_.summary.value, "tighten read.*");

  // And the whole policy text is reachable, which SPEC.md §10.4 requires before
  // any decision is collected.
  const rendering = request_.fullPayload.value;
  assert.notEqual(rendering, null, "an attestation prompt with no policy text to show");
  assert.equal(rendering?.truncated, false);
  assert.match(rendering?.text ?? "", /approval-policy/u);
});

test("the queue carries attestation prompts after the approvals whose rules they change", () => {
  const { world, actionKey } = proposedWorld();
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, NOW);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  if (!queue.ok) return;

  const keys = queue.requests.map((entry) => entry.action_key.value);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], world.keys[0]);
  assert.equal(keys[1], actionKey);
});

test("a tap on an attestation prompt appends the attestation, not a grant", () => {
  const { world, actionKey } = proposedWorld();
  const result = recordChannelDecision(
    world.unit.logPath,
    { action_key: actionKey, decision: "grant", deliveryId: "mock-1", note: "yes" },
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  if (!result.outcome.ok) return;

  // No token: an attestation authorizes no side effect, so there is nothing for
  // one to be spent on.
  assert.equal(result.outcome.tokenIssued, false);
  assert.equal(result.token, undefined);

  const record = result.outcome.record;
  assert.equal(record.event, "policy.updated");
  // Under the human identity the LISTENER holds, exactly as a grant lands.
  assert.equal(record.actor, HUMAN);
  assert.equal(record.ts, at(3));

  // The policy is now attested, and the prompt has left the queue.
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, at(3));
  assert.equal(queue.ok, true);
  assert.equal(
    queue.ok && queue.requests.some((entry) => entry.action_key.value === actionKey),
    false,
  );
});

test("a reject on an attestation prompt attests nothing", () => {
  const { world, actionKey } = proposedWorld();
  const result = recordChannelDecision(
    world.unit.logPath,
    { action_key: actionKey, decision: "reject", deliveryId: "mock-1", note: "not yet" },
    { actor: HUMAN, channel: "mock" },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  if (!result.outcome.ok) return;

  assert.equal(result.outcome.record.event, "policy.declined");
  assert.equal(result.outcome.record.actor, HUMAN);
  assert.equal(
    recordsOf(world.unit.logPath).filter((record) => record.event === "policy.updated").length,
    1,
    "a decline appended a second attestation",
  );
});

test("a prompt whose policy bytes moved is skipped rather than shown", () => {
  const { world, actionKey } = proposedWorld();
  writeFileSync(world.unit.policyPath, `${POLICY_WITH_LIMITS}\n# a later edit\n`, "utf8");

  const built = buildChannelRequest(world.unit.logPath, actionKey, world.tagOptions, NOW);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.code, "proposal-stale");

  // And in the queue it is reported as skipped, exactly as an approval that
  // cannot be rendered is.
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, NOW);
  assert.equal(queue.ok, true);
  assert.equal(
    queue.ok && queue.skipped.some((entry) => entry.action_key === actionKey),
    true,
  );
});
