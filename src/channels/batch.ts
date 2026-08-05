/**
 * Batching: one human gesture over many requests, without losing audit
 * granularity (SPEC.md §10.3, requirement B7).
 *
 * > Channels MAY present multiple pending requests as a batch and collect one
 * > human gesture over the set, and SHOULD for high-volume `record.*` classes.
 * > The log never batches: each granted or rejected request receives its own
 * > `approval.granted` or `approval.rejected` event carrying the batch's channel
 * > delivery id in its payload, so audit granularity survives ergonomic
 * > grouping. A batch MUST NOT mix `manual` classes with differing
 * > payload-display requirements in a way that hides any full payload behind the
 * > fold of another.
 *
 * Two halves, and this module is both: {@link assembleBatch} enforces the
 * forbidden mix *before* anything is delivered, and {@link recordBatchDecisions}
 * records one gate decision per member afterwards.
 *
 * ## The B7 operationalization — FLAGGED FOR HUMAN REVIEW
 *
 * "Hides any full payload behind the fold of another" is a sentence about
 * rendering, and rendering is the one thing the runtime cannot inspect. So B7 is
 * operationalized here as a property of the *batch material* rather than of the
 * pixels:
 *
 * > A batch MUST carry every member's full payload whole. The forbidden mix is
 * > any member whose `fullPayload` is absent or truncated while the batch
 * > contains more than one distinct payload — because with one payload there is
 * > no "another" to hide behind, and with two or more, a member the channel was
 * > not given in full is a member the approver cannot have read.
 *
 * Concretely, {@link assembleBatch} refuses when the batch holds more than one
 * distinct `payload_hash` **and** any member's `fullPayload` is `null` or
 * `truncated`. A single-payload batch (the same bytes requested twice, or one
 * request) is always assemblable, and a multi-payload batch is assemblable
 * exactly when every member arrives whole.
 *
 * What this deliberately does **not** try to be: a judgment about whether a
 * particular channel's layout actually put payload #2 below the fold. That is a
 * per-channel rendering property, and `channels/conformance.ts` checks the
 * observable half of it (every member's full payload text present in the
 * rendering, delineated from the claimed summary). The interpretation to
 * confirm is the reduction of "differing payload-display requirements" to
 * "distinct payload bytes": it is the reading that makes the rule mechanical,
 * and it is stricter than the spec's letter in one direction (two whole payloads
 * are fine only if both are whole) and silent in another (it says nothing about
 * a channel that renders both whole and then collapses one). A human should
 * confirm this is the intended reading before APRV-23/25/26 build against it.
 */

import type { DecideOptions } from "../core/gate.js";
import {
  recordChannelDecision,
  type ChannelActorOptions,
  type ChannelBatch,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
  type DeliveryId,
} from "./contract.js";

export {
  BATCH_DELIVERY_ID_FIELD,
  BATCH_DELIVERY_NOTE_PREFIX,
  batchDeliveryIdOf,
  batchNote,
  type ChannelBatch,
} from "./contract.js";

// ---------------------------------------------------------------------------
// assembleBatch
// ---------------------------------------------------------------------------

/** The one way a batch can be refused (SPEC.md §10.3, B7). */
export const BATCH_REFUSAL_CODE = "batch-forbidden-mix";

export interface BatchRefusal {
  ok: false;
  code: typeof BATCH_REFUSAL_CODE;
  message: string;
}

export type AssembleBatchResult = { ok: true; batch: ChannelBatch } | BatchRefusal;

/**
 * Assemble `requests` into a batch, or refuse the forbidden mix.
 *
 * The returned batch carries every member request **whole** — the same
 * {@link ChannelRequest} objects a channel would receive individually, tags and
 * full payloads included. A channel therefore has everything it needs to render
 * each member in full; if it chooses not to, that is a rendering defect the
 * conformance suite catches, not a gap in the material it was handed.
 *
 * `deliveryId` is left unset: it is assigned by the channel at `notify`.
 */
export function assembleBatch(requests: ChannelRequest[]): AssembleBatchResult {
  const hashes = new Set(requests.map((request) => request.payload_hash.value));

  if (hashes.size > 1) {
    const hidden = requests.filter((request) => {
      const rendering = request.fullPayload.value;
      return rendering === null || rendering.truncated;
    });
    if (hidden.length > 0) {
      const keys = hidden.map((request) => request.action_key.value).join(", ");
      return {
        ok: false,
        code: BATCH_REFUSAL_CODE,
        message: `batch refused: it carries ${hashes.size} distinct payloads and ${hidden.length} member(s) whose full payload is absent or truncated (${keys}). SPEC.md §10.3 forbids a batch that hides any full payload behind the fold of another; a member the channel was never given in full is a member the approver cannot have read, so the set is refused before delivery rather than approved in part.`,
      };
    }
  }

  return { ok: true, batch: { requests } };
}

// ---------------------------------------------------------------------------
// recordBatchDecisions
// ---------------------------------------------------------------------------

/** One member's outcome. `token` is held back from the channel, as always. */
export interface BatchMemberResult {
  action_key: string;
  outcome: DecisionOutcome;
  /** The raw execution token for a successful grant. Runtime-only. */
  token?: string;
}

export interface BatchDecisionsResult {
  /** True when every member was recorded. */
  ok: boolean;
  /** One entry per input decision, in input order. */
  results: BatchMemberResult[];
  batchDeliveryId: DeliveryId;
}

/**
 * Record one gate decision per batch member.
 *
 * **Unit decisions mean unit outcomes.** The log never batches (SPEC.md §10.3),
 * so this is a loop over `decide()` and not a transaction: each member is
 * checked and appended on its own, each carries the batch delivery id in its
 * payload as the first-class `batch_delivery_id` field (amended SPEC.md §10.3,
 * APRV-38), and a member that refuses does **not** stop the rest. That is
 * deliberate and it is the only coherent semantics available — an "all or
 * nothing" batch would have to un-append events the log forbids un-appending,
 * and abandoning the remaining members because the third one expired would
 * discard a human's answer to the other four. So: partial success is a real
 * outcome, `ok` is false when any member refused, and `results` says exactly
 * which ones landed. A caller that wants atomicity does not want a batch.
 *
 * Ordering: members are recorded in the order given. Each append passes the
 * gate's compare-and-append precondition against the head *it* read, so a
 * concurrent writer refuses one member with `append-failed`/`head-moved`
 * rather than corrupting the set.
 */
export function recordBatchDecisions(
  logPath: string,
  decisions: ChannelDecision[],
  batchDeliveryId: DeliveryId,
  actorOptions: ChannelActorOptions,
  gateOptions: DecideOptions = {},
): BatchDecisionsResult {
  const results: BatchMemberResult[] = [];
  for (const decision of decisions) {
    const recorded = recordChannelDecision(
      logPath,
      { ...decision, batchDeliveryId },
      actorOptions,
      gateOptions,
    );
    results.push({
      action_key: decision.action_key,
      outcome: recorded.outcome,
      ...(recorded.token === undefined ? {} : { token: recorded.token }),
    });
  }
  return {
    ok: results.every((entry) => entry.outcome.ok),
    results,
    batchDeliveryId,
  };
}
