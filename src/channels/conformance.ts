/**
 * The shared channel conformance suite (SPEC.md §9, §10.3, §10.4).
 *
 * SPEC.md §9 states the display rule and then names its consequence in the same
 * breath: rendering claimed fields with the visual authority of computed fields
 * "is a conformance failure for a channel". This module is what that sentence
 * points at. It ships with the contract rather than with any one channel, so
 * `cli`, `web` and `telegram` (APRV-23/25/26) are held to one standard written
 * once, and a fourth channel written by someone else can import it and find out
 * in a single test whether it is a channel or merely a message sender.
 *
 * ## What it checks
 *
 * 1. **Tagging.** Every member of the request handed to the channel is a
 *    {@link TaggedField} ({@link assertTagged}), and every field the channel
 *    reports rendering carries the *same* kind the request gave it. A channel
 *    that presents a claimed summary as computed fails here.
 * 2. **The full payload** (§10.4). A manual request's rendering contains the
 *    payload text verbatim, in a region distinct from the claimed summary.
 * 3. **Decision round-trip.** A gesture driven through the harness lands
 *    exactly one correctly-shaped event in a real log, through the real gate.
 * 4. **Batch semantics** (§10.3, B7). A batch notify plus two decisions lands
 *    two events, each carrying the batch delivery id; and the forbidden mix is
 *    refused at {@link assembleBatch} before anything is delivered.
 * 5. **Terminal requests are neither pending nor armed** (APRV-113). A request
 *    the log has settled is absent from the derivation every channel builds its
 *    queue from, and a second gesture on it is refused and appends nothing.
 *
 * ## How it is run
 *
 * ```ts
 * test("my channel conforms", async (t) => {
 *   await runChannelConformance(t, () => new MyChannel(), harness);
 * });
 * ```
 *
 * `t` is a `node:test` context and is used only for `diagnostic()` labels: the
 * checks run inline and **throw** on the first failure rather than being split
 * into subtests. That is deliberate. A subtest's promise resolves even when the
 * subtest fails, so a suite built from `t.test()` could not itself be tested —
 * and a conformance suite nobody has watched fail is a suite that might pass
 * anything. Throwing means `tests/channels-contract.test.ts` can assert the
 * suite goes RED against deliberately broken channels.
 *
 * The suite writes to whatever log the harness gives it, through the real gate.
 * It never hand-writes a log line.
 */

import assert from "node:assert/strict";

import { withdraw, type DecideOptions } from "../core/gate.js";
import { readVerifiedRecords, requestState } from "../core/state.js";
import { assembleBatch } from "./batch.js";
import {
  assertTagged,
  batchDeliveryIdOf,
  isTaggedField,
  isTestableChannel,
  recordChannelDecision,
  type Channel,
  type ChannelActorOptions,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
  type RenderedRequest,
} from "./contract.js";

/** Anything with a `diagnostic` method — `node:test`'s `TestContext` qualifies. */
export interface ConformanceContext {
  diagnostic?(message: string): void;
}

/**
 * One scenario the harness prepares: a real log with `count` live manual
 * requests, and the identity that will decide them.
 */
export interface ConformanceCase {
  /** Path to a real `events.jsonl`, built through the gate. */
  logPath: string;
  /** The pending requests, as `channels/tagging.ts` built them. */
  requests: ChannelRequest[];
  /** The approver. Must be `human:…`; the gate refuses anything else. */
  actor: ChannelActorOptions;
  /** Gate options for recording (policy location, injected clock). */
  gateOptions?: DecideOptions;
  /** Called when the suite is done with this case. */
  cleanup?(): void;
}

/**
 * What a channel's test file must provide.
 *
 * `setup(count)` returns a *fresh* case each call — the suite decides requests,
 * and a decided request cannot be decided again. `setup(2)` MUST return two
 * requests with **distinct** payload hashes; the batch checks assert that and
 * would otherwise be vacuous.
 *
 * `decide` is the harness's simulation of the human gesture: press the button,
 * answer the prompt, POST the webhook — whatever makes the channel invoke the
 * handler it was given. It is optional; without it the suite calls the
 * registered handler directly, which still exercises the runtime path but not
 * the channel's own callback wiring, so a real channel should provide it.
 */
export interface ConformanceHarness {
  setup(count: number): ConformanceCase | Promise<ConformanceCase>;
  decide?(
    channel: Channel,
    decision: ChannelDecision,
  ): DecisionOutcome | Promise<DecisionOutcome>;
}

type Handler = (decision: ChannelDecision) => DecisionOutcome;

function say(t: ConformanceContext, message: string): void {
  t.diagnostic?.(`channel conformance: ${message}`);
}

/** The runtime's decision handler: the only thing a channel's callback may do. */
function handlerFor(unit: ConformanceCase): Handler {
  return (decision) =>
    recordChannelDecision(unit.logPath, decision, unit.actor, unit.gateOptions ?? {}).outcome;
}

/** Records currently in the log; the suite counts them before and after. */
function recordsOf(logPath: string) {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `conformance log does not verify: ${JSON.stringify(read)}`);
  return read.ok ? read.records : [];
}

async function deliver(
  harness: ConformanceHarness,
  channel: Channel,
  handler: Handler,
  decision: ChannelDecision,
): Promise<DecisionOutcome> {
  if (harness.decide === undefined) return handler(decision);
  return await harness.decide(channel, decision);
}

function renderedFor(channel: Channel, actionKey: string): RenderedRequest | null {
  if (!isTestableChannel(channel)) return null;
  return channel.lastRendered().find((entry) => entry.action_key === actionKey) ?? null;
}

/**
 * Check one rendering against the request it came from.
 *
 * The rule being enforced is SPEC.md §9's: a field's *kind* must survive the
 * trip to the screen. A rendered field naming a member the request does not
 * have is also a failure — that is a channel inventing a datum, which is the
 * same defect wearing a different hat.
 */
function assertRenderingFaithful(request: ChannelRequest, rendered: RenderedRequest): void {
  assert.equal(
    rendered.action_key,
    request.action_key.value,
    "the channel rendered a different action key than it was given",
  );
  assert.ok(rendered.fields.length > 0, "the channel reported rendering no fields at all");

  const members = request as unknown as Record<string, unknown>;
  for (const field of rendered.fields) {
    const member = members[field.field];
    assert.ok(
      member !== undefined,
      `the channel rendered a field ${JSON.stringify(field.field)} that the request does not carry`,
    );
    assert.ok(
      isTaggedField(member),
      `request member ${JSON.stringify(field.field)} is not a tagged field`,
    );
    assert.equal(
      field.kind,
      (member as { kind: string }).kind,
      `the channel rendered ${JSON.stringify(field.field)} as ${field.kind}, but it is ${(member as { kind: string }).kind} (SPEC.md §9: claimed fields must not be given the visual authority of computed ones)`,
    );
  }
}

/** §10.4: the full payload is present, verbatim, and not the summary. */
function assertFullPayloadPresented(request: ChannelRequest, rendered: RenderedRequest): void {
  const rendering = request.fullPayload.value;
  assert.notEqual(
    rendering,
    null,
    "a manual request reached the channel with no full payload; construction should have refused it",
  );
  if (rendering === null) return;

  assert.ok(
    rendered.fullPayloadText !== null,
    `the channel rendered no full payload for manual action ${request.action_key.value} (SPEC.md §10.4)`,
  );
  assert.ok(
    (rendered.fullPayloadText ?? "").includes(rendering.text),
    "the channel's full-payload region does not contain the payload text it was given",
  );

  const summary = request.summary.value;
  if (typeof summary === "string" && summary.length > 0) {
    assert.notEqual(
      rendered.fullPayloadText,
      summary,
      "the channel presented the agent's summary as the full payload (SPEC.md §10.4: the payload must be clearly delineated from any agent-written summary)",
    );
    const summaryField = rendered.fields.find((field) => field.field === "summary");
    if (summaryField !== undefined) {
      assert.equal(summaryField.kind, "claimed", "the summary must be rendered as claimed");
    }
  }
}

/**
 * Run the suite. Resolves when every check passes; throws (an `AssertionError`)
 * on the first failure.
 */
export async function runChannelConformance(
  t: ConformanceContext,
  makeChannel: () => Channel,
  harness: ConformanceHarness,
): Promise<void> {
  await checkTaggingAndPayload(t, makeChannel, harness);
  await checkDecisionRoundTrip(t, makeChannel, harness);
  await checkBatchSemantics(t, makeChannel, harness);
  await checkWithdrawal(t, makeChannel, harness);
  await checkTerminalNotArmed(t, makeChannel, harness);
}

// ---------------------------------------------------------------------------
// (f) a decided request is not presented as pending — APRV-113
// ---------------------------------------------------------------------------

/**
 * A channel does not present a terminal request as pending, and does not leave
 * a decision affordance armed for one.
 *
 * The withdrawal check above says this for one terminal state. This says it for
 * the ordinary one: the request the human just answered. A pull channel passes
 * by construction — `cli` and `web` build their view from the log every time
 * they render, so a granted request is simply absent from the next one. A push
 * channel has already put a message somewhere it cannot re-derive, and this is
 * the check that says leaving it looking live is a conformance failure, not a
 * cosmetic debt (`telegram` answers it by editing the message and forgetting
 * the delivery — APRV-113).
 *
 * Two assertions, and the second is the one with teeth:
 *
 * 1. The request is terminal by the derivation every channel's queue is built
 *    from, so nothing re-derived from the log can show it as pending.
 * 2. A second gesture on it is REFUSED and appends nothing. An affordance that
 *    is still on a screen somewhere must be inert — a channel cannot promise a
 *    button is gone from a phone, but it must not be able to collect a second
 *    decision through one.
 */
async function checkTerminalNotArmed(
  t: ConformanceContext,
  makeChannel: () => Channel,
  harness: ConformanceHarness,
): Promise<void> {
  say(t, "a decided request is neither pending nor armed");
  const unit = await harness.setup(1);
  try {
    const request = unit.requests[0];
    assert.ok(request !== undefined, "harness.setup(1) returned no request");
    const actionKey = request.action_key.value;

    const channel = makeChannel();
    const handler = handlerFor(unit);
    channel.onDecision(handler);
    const deliveryId = await channel.notify(request);

    const decided = await deliver(harness, channel, handler, {
      action_key: actionKey,
      decision: "grant",
      deliveryId,
    });
    assert.equal(decided.ok, true, `the decision was refused: ${JSON.stringify(decided)}`);

    const state = requestState(recordsOf(unit.logPath), actionKey, new Date().toISOString(), null)
      .state;
    assert.equal(
      state,
      "granted",
      'the decision did not settle the request; every channel derives its queue from `state === "requested"`, so a channel would keep presenting it',
    );

    const before = recordsOf(unit.logPath).length;
    const second = recordChannelDecision(
      unit.logPath,
      { action_key: actionKey, decision: "grant", deliveryId },
      unit.actor,
      unit.gateOptions ?? {},
    ).outcome;
    assert.equal(
      second.ok,
      false,
      "a decided request must not be decidable again; an affordance left on a screen has to be inert",
    );
    if (!second.ok) {
      assert.equal(
        second.code,
        "already-decided",
        `a second decision must refuse already-decided, got ${second.code}`,
      );
    }
    assert.equal(
      recordsOf(unit.logPath).length,
      before,
      "the refused second decision appended something",
    );
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (e) withdrawal — APRV-106
// ---------------------------------------------------------------------------

/**
 * A withdrawn request is not pending, and the age/deadline line is computed.
 *
 * Two checks, one scenario, both about the same failure: a channel that keeps
 * asking a question nobody is waiting on. The first is structural — the request
 * is withdrawn through the real gate, and the channel must not be able to
 * collect a decision on it. The second is the line that tells an approver
 * looking at a live request how long an answer still has to reach anyone; it
 * MUST be presented as computed, because a channel that rendered it as claimed
 * would be inviting a reader to discount the one number that says whether their
 * attention is about to be wasted.
 *
 * What is deliberately NOT required: that a channel retract a delivery it
 * already made. `Channel.retract` is optional (see the contract), because a
 * withdrawn request leaves every queue by derivation and a pull channel has
 * nothing to retract. What every channel must do is refuse to present one.
 */
async function checkWithdrawal(
  t: ConformanceContext,
  makeChannel: () => Channel,
  harness: ConformanceHarness,
): Promise<void> {
  say(t, "withdrawn requests are not pending, and the age/deadline line is computed");
  const unit = await harness.setup(1);
  try {
    const request = unit.requests[0];
    assert.ok(request !== undefined, "harness.setup(1) returned no request");
    const actionKey = request.action_key.value;

    // The line, on a live request, before anything is withdrawn.
    assert.ok(
      isTaggedField(request.waiting),
      "the request carries no `waiting` field; SPEC.md §6.3 (APRV-106) asks a channel to show how old a question is and how long an answer still has",
    );
    assert.equal(
      request.waiting.kind,
      "computed",
      "the age/deadline line must be presented as COMPUTED: it is arithmetic on the log's own timestamps against the display instant, and a reader who took it for an agent's claim would discount the one number that says whether their attention is about to be wasted",
    );
    assert.match(
      request.waiting.value,
      /requested/u,
      "the age/deadline line does not say when the request was made",
    );

    const channel = makeChannel();
    channel.onDecision(handlerFor(unit));
    await channel.notify(request);

    const rendered = renderedFor(channel, actionKey);
    if (rendered !== null) {
      const shown = rendered.fields.find((field) => field.field === "waiting");
      assert.ok(
        shown !== undefined,
        "the channel rendered no `waiting` line; an approver cannot see whether an answer now still reaches anyone",
      );
      assert.equal(
        shown.kind,
        "computed",
        "the channel rendered the age/deadline line as claimed; it is computed",
      );
    }

    // Withdraw through the real gate, as the party that requested.
    const requester = requesterOf(unit.logPath, actionKey);
    assert.notEqual(requester, null, "the conformance log holds no approval.requested actor");
    const gone = withdraw(unit.logPath, actionKey, requester ?? "", {
      ...unit.gateOptions,
      reason: "timeout",
    });
    assert.equal(gone.ok, true, `withdraw refused: ${JSON.stringify(gone)}`);

    // The one requirement: it is not pending any more, by the same derivation
    // every channel builds its queue from.
    const state = requestState(recordsOf(unit.logPath), actionKey, new Date().toISOString(), null)
      .state;
    assert.equal(
      state,
      "withdrawn",
      "the withdrawal did not settle the request; every channel's queue is derived from `state === \"requested\"`, so a channel would keep presenting it",
    );

    // And a gesture on it is refused by the gate rather than recorded. This is
    // the tap that races the withdrawal, which every push channel will see.
    const before = recordsOf(unit.logPath).length;
    const outcome = recordChannelDecision(
      unit.logPath,
      { action_key: actionKey, decision: "grant", deliveryId: "conformance" },
      unit.actor,
      unit.gateOptions ?? {},
    ).outcome;
    assert.equal(outcome.ok, false, "a withdrawn request must not be grantable");
    if (!outcome.ok) {
      assert.equal(
        outcome.code,
        "request-withdrawn",
        `a decision on a withdrawn request must refuse request-withdrawn, got ${outcome.code}`,
      );
    }
    assert.equal(
      recordsOf(unit.logPath).length,
      before,
      "the refused decision appended something",
    );
  } finally {
    unit.cleanup?.();
  }
}

/** The actor on the latest `approval.requested` for `actionKey`. */
function requesterOf(logPath: string, actionKey: string): string | null {
  let actor: string | null = null;
  for (const record of recordsOf(logPath)) {
    if (record.event === "approval.requested" && record.action_key === actionKey) {
      actor = record.actor;
    }
  }
  return actor;
}

// ---------------------------------------------------------------------------
// (a) + (b) tagging and the full payload
// ---------------------------------------------------------------------------

async function checkTaggingAndPayload(
  t: ConformanceContext,
  makeChannel: () => Channel,
  harness: ConformanceHarness,
): Promise<void> {
  say(t, "tagging and full-payload presentation");
  const unit = await harness.setup(1);
  try {
    const request = unit.requests[0];
    assert.ok(request !== undefined, "harness.setup(1) returned no request");

    const channel = makeChannel();
    assert.equal(typeof channel.name, "string", "a channel must have a name");
    const health = channel.health();
    assert.equal(typeof health.ok, "boolean", "health() must report a boolean ok");

    channel.onDecision(handlerFor(unit));
    assertTagged(request);

    const before = recordsOf(unit.logPath).length;
    const deliveryId = await channel.notify(request);
    assert.equal(typeof deliveryId, "string", "notify() must return a delivery id");
    assert.ok(deliveryId.length > 0, "notify() returned an empty delivery id");
    assert.equal(
      recordsOf(unit.logPath).length,
      before,
      "notify() wrote to the log; channels are transport and hold no state (SPEC.md §10.3)",
    );

    const rendered = renderedFor(channel, request.action_key.value);
    assert.ok(
      rendered !== null,
      "the channel is not a TestableChannel, or reported no rendering for the request it was notified with; conformance cannot inspect a screen, so a channel under test must expose lastRendered()",
    );
    assertRenderingFaithful(request, rendered);
    if (request.autonomy.value === "manual") assertFullPayloadPresented(request, rendered);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (c) decision round-trip
// ---------------------------------------------------------------------------

async function checkDecisionRoundTrip(
  t: ConformanceContext,
  makeChannel: () => Channel,
  harness: ConformanceHarness,
): Promise<void> {
  say(t, "decision round-trip through the real gate");
  const unit = await harness.setup(1);
  try {
    const request = unit.requests[0];
    assert.ok(request !== undefined, "harness.setup(1) returned no request");
    const actionKey = request.action_key.value;

    const channel = makeChannel();
    const handler = handlerFor(unit);
    channel.onDecision(handler);
    const deliveryId = await channel.notify(request);

    const before = recordsOf(unit.logPath);
    const outcome = await deliver(harness, channel, handler, {
      action_key: actionKey,
      decision: "grant",
      deliveryId,
    });

    assert.equal(
      outcome.ok,
      true,
      `the decision was refused: ${JSON.stringify(outcome)}`,
    );
    const after = recordsOf(unit.logPath);
    assert.equal(
      after.length,
      before.length + 1,
      "a single decision must append exactly one event",
    );
    const appended = after[after.length - 1];
    assert.ok(appended !== undefined, "no record was appended");
    assert.equal(appended.event, "approval.granted", "the wrong event type was appended");
    assert.equal(appended.action_key, actionKey, "the event names the wrong action key");
    assert.match(
      appended.actor,
      /^human:/u,
      "an approval decision must be recorded against a human actor (SPEC.md §10.1)",
    );
    assert.equal(
      batchDeliveryIdOf(appended),
      null,
      "a unit decision must not carry a batch delivery id",
    );
    if (outcome.ok) {
      assert.equal(outcome.record.seq, appended.seq, "the outcome names a different record");
      assert.equal(
        Object.prototype.hasOwnProperty.call(outcome, "token"),
        false,
        "the outcome handed back to the channel must not carry the raw execution token",
      );
    }
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (d) batch semantics — B7
// ---------------------------------------------------------------------------

async function checkBatchSemantics(
  t: ConformanceContext,
  makeChannel: () => Channel,
  harness: ConformanceHarness,
): Promise<void> {
  say(t, "batch delivery, per-member events, and the forbidden mix");
  const unit = await harness.setup(2);
  try {
    const [first, second] = unit.requests;
    assert.ok(
      first !== undefined && second !== undefined,
      "harness.setup(2) must return two requests",
    );
    assert.notEqual(
      first.payload_hash.value,
      second.payload_hash.value,
      "harness.setup(2) must return two requests with distinct payload hashes, or the B7 checks are vacuous",
    );

    const assembled = assembleBatch([first, second]);
    assert.equal(
      assembled.ok,
      true,
      `two whole payloads must assemble into a batch: ${JSON.stringify(assembled)}`,
    );
    if (!assembled.ok) return;

    const channel = makeChannel();
    const handler = handlerFor(unit);
    channel.onDecision(handler);
    const batchDeliveryId = await channel.notify(assembled.batch);
    assert.equal(typeof batchDeliveryId, "string", "a batch notify must return a delivery id");

    if (isTestableChannel(channel)) {
      const rendered = channel.lastRendered();
      assert.equal(
        rendered.length,
        2,
        "a batch must be rendered member by member; each request carries its own full payload (SPEC.md §10.3)",
      );
      for (const request of [first, second]) {
        const entry = rendered.find((item) => item.action_key === request.action_key.value);
        assert.ok(entry !== undefined, "a batch member was not rendered at all");
        assertRenderingFaithful(request, entry);
        if (request.autonomy.value === "manual") assertFullPayloadPresented(request, entry);
      }
    }

    const before = recordsOf(unit.logPath).length;
    for (const request of [first, second]) {
      const outcome = await deliver(harness, channel, handler, {
        action_key: request.action_key.value,
        decision: "grant",
        deliveryId: batchDeliveryId,
        batchDeliveryId,
      });
      assert.equal(outcome.ok, true, `a batch member was refused: ${JSON.stringify(outcome)}`);
    }

    const after = recordsOf(unit.logPath);
    assert.equal(
      after.length,
      before + 2,
      "the log never batches: two granted requests must produce two events (SPEC.md §10.3)",
    );
    for (const record of after.slice(before)) {
      assert.equal(
        batchDeliveryIdOf(record),
        batchDeliveryId,
        "each event of a batched gesture must carry the batch delivery id",
      );
    }

    // B7: the same two requests, one of them no longer whole.
    const truncated: ChannelRequest = {
      ...second,
      fullPayload: {
        kind: "computed",
        source: "payload-binding",
        value:
          second.fullPayload.value === null
            ? null
            : { ...second.fullPayload.value, truncated: true },
      },
    };
    const mixed = assembleBatch([first, truncated]);
    assert.equal(
      mixed.ok,
      false,
      "a batch mixing distinct payloads where one is truncated must be refused (SPEC.md §10.3, B7)",
    );
    if (!mixed.ok) {
      assert.equal(mixed.code, "batch-forbidden-mix", "the wrong refusal code was returned");
    }
  } finally {
    unit.cleanup?.();
  }
}
