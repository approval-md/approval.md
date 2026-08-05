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

import type { DecideOptions } from "../core/gate.js";
import { readVerifiedRecords } from "../core/state.js";
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
