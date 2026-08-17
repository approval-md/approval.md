/**
 * The daemon's pure projections (SPEC.md §6.3, §10.2).
 *
 * Everything the daemon *decides* lives here, and everything it *does* lives in
 * `daemon.ts`. The split is the same one `core/loop.ts` draws for loop safety:
 * a projection over verified records is a pure function of (records, instant,
 * TTL), so it can be replayed, unit-tested against an injected clock, and never
 * disagrees with itself between two callers.
 *
 * Nothing here reads the clock, the filesystem, or the network, and nothing
 * here appends. Three questions are answered:
 *
 * 1. **What does the log say a task's envelope `state:` should be?**
 *    {@link taskEnvelopeState}. §6.3: "`state` is a projection of log events;
 *    the file is updated by the daemon after the event is appended, never the
 *    reverse." The daemon compares the file's claim against this answer, and a
 *    file that contradicts it is `envelope.drift`.
 * 2. **Which live requests have lapsed with no `approval.expired` on record?**
 *    {@link lapsedRequests}. The gate already judges TTL lazily at decision
 *    time (a late grant is refused whether or not an expiry event exists), so
 *    the sweep changes no verdict; it makes the verdict *visible* in the log
 *    and in every projection built from it.
 * 3. **Has this exact drift already been recorded?** {@link driftAlreadyLogged}.
 *    A watcher fires on every save and the periodic tick re-scans regardless,
 *    so without a dedupe rule one unfixed file would append an unbounded run of
 *    identical events. The rule is stated on that function.
 *
 * The state derivation itself is NOT reimplemented here: every action's state
 * comes from `core/state.ts`'s `requestState`, the same derivation the gate,
 * the token module, and the executor read. This module only rolls action states
 * up to the task level, and that rollup is the one new rule it owns.
 */

import type { EventRecord } from "../core/log.js";
import { payloadOf, requestState, type RequestDerivation } from "../core/state.js";

/**
 * The envelope's `state:` vocabulary (`envelope.schema.json`, SPEC.md §6.3).
 *
 * Spelled here rather than imported from the schema because the schema is data
 * read at runtime and this is a type; `tests/daemon-projection.test.ts` pins the
 * two against each other so they cannot drift apart.
 */
export const ENVELOPE_STATES = [
  "proposed",
  "awaiting",
  "approved",
  "executed",
  "rejected",
  "expired",
  "revoked",
] as const;

export type EnvelopeState = (typeof ENVELOPE_STATES)[number];

/** Is this the envelope's `state:` value? Used to read an untrusted file. */
export function isEnvelopeState(value: unknown): value is EnvelopeState {
  return typeof value === "string" && (ENVELOPE_STATES as readonly string[]).includes(value);
}

/** One declared action of a task, as the log records it, with its derived state. */
export interface ActionProjection {
  actionKey: string;
  derivation: RequestDerivation;
}

/** What the log says about one task. */
export interface TaskProjection {
  task: string;
  /** A `task.registered` record exists for this task id. */
  registered: boolean;
  /** The envelope `state:` the log implies (SPEC.md §6.3). */
  state: EnvelopeState;
  /** Every action key the latest registration declared, with its derivation. */
  actions: ActionProjection[];
}

/** Every action key the latest `task.registered` for `task` declared, in order. */
export function registeredActionKeys(records: EventRecord[], task: string): string[] {
  let latest: EventRecord | null = null;
  for (const record of records) {
    if (record.event === "task.registered" && record.task === task) latest = record;
  }
  if (latest === null) return [];
  const declared = payloadOf(latest)["actions"];
  if (!Array.isArray(declared)) return [];
  const keys: string[] = [];
  for (const entry of declared) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = (entry as Record<string, unknown>)["idempotency_key"];
    if (typeof key === "string" && key.length > 0 && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The envelope `state:` the log implies for `task`, at instant `ts`.
 *
 * ## The rollup rule, stated once
 *
 * §6.3's lifecycle is drawn for one action; a task may declare several, so the
 * projection needs a rule for a task whose actions disagree. It is this, in
 * order, and the order is the point:
 *
 * 1. any action with a live request → **awaiting**. A human owes an answer, and
 *    that fact outranks every other, because it is the only state that asks
 *    something of a person.
 * 2. else any granted action that has not executed → **approved**.
 * 3. else any action with an `execution.completed` → **executed**.
 * 4. else **revoked**, then **rejected**, then **expired** — human decisions
 *    outrank a runtime lapse, so a task with one revoked and one expired action
 *    reads as revoked, naming the decision a person actually made.
 * 5. else **proposed**: registered (or not) and nothing has happened.
 *
 * A task with exactly one action — the common case — collapses to §6.3's
 * lifecycle exactly, which is the property the rule was chosen for.
 *
 * An unregistered task projects to `proposed`: the log knows of no declaration,
 * so nothing has been proposed *to the gate* yet. A file claiming `approved`
 * for a task the log never registered therefore contradicts the log, which is
 * exactly the reading §6.3 wants.
 */
export function taskEnvelopeState(
  records: EventRecord[],
  task: string,
  ts: string,
  ttlMs: number | null,
): TaskProjection {
  const keys = registeredActionKeys(records, task);
  const registered = keys.length > 0 || records.some(
    (record) => record.event === "task.registered" && record.task === task,
  );

  const actions: ActionProjection[] = keys.map((actionKey) => ({
    actionKey,
    derivation: requestState(records, actionKey, ts, ttlMs),
  }));

  const any = (predicate: (entry: ActionProjection) => boolean): boolean =>
    actions.some(predicate);

  let state: EnvelopeState = "proposed";
  if (any((entry) => entry.derivation.state === "requested")) state = "awaiting";
  else if (
    any(
      (entry) =>
        entry.derivation.state === "granted" && entry.derivation.execution.completed === null,
    )
  ) {
    state = "approved";
  } else if (any((entry) => entry.derivation.execution.completed !== null)) state = "executed";
  else if (any((entry) => entry.derivation.state === "revoked")) state = "revoked";
  else if (any((entry) => entry.derivation.state === "rejected")) state = "rejected";
  else if (any((entry) => entry.derivation.state === "expired")) state = "expired";

  return { task, registered, state, actions };
}

/** One request the TTL sweep would materialise an `approval.expired` for. */
export interface LapsedRequest {
  actionKey: string;
  task: string | null;
  /** The `ts` of the `approval.requested` that lapsed. */
  requestedTs: string | null;
}

/**
 * Live requests whose TTL has lapsed and which carry no `approval.expired`.
 *
 * Idempotence is structural rather than remembered: the answer is re-derived
 * from the verified log every sweep, and an action whose expiry has been
 * appended no longer satisfies the predicate. Two sweeps over the same log
 * therefore produce the same list, and a sweep that follows a successful one
 * produces an empty list — with no state carried between them, and no way for a
 * restarted daemon to expire something twice.
 *
 * `ttlMs === null` (a policy that declares no `defaults.approval_ttl`) yields no
 * candidates at all: nothing lapses when nothing was bounded, and inventing a
 * deadline is not the daemon's to invent.
 *
 * Returned in first-request order, so a sweep's appends land in a deterministic
 * sequence.
 */
export function lapsedRequests(
  records: EventRecord[],
  ts: string,
  ttlMs: number | null,
): LapsedRequest[] {
  if (ttlMs === null) return [];

  const keys: string[] = [];
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    const key = record.action_key;
    if (typeof key === "string" && key.length > 0 && !keys.includes(key)) keys.push(key);
  }

  const lapsed: LapsedRequest[] = [];
  for (const actionKey of keys) {
    const derivation = requestState(records, actionKey, ts, ttlMs);
    // `expiredLazily` is precisely "the TTL has passed and no event says so".
    // Anything decided, revoked, or already expired by event fails it.
    if (derivation.state === "expired" && derivation.expiredLazily && !derivation.expiredByEvent) {
      lapsed.push({
        actionKey,
        task: derivation.task,
        requestedTs: derivation.requestTs,
      });
    }
  }
  return lapsed;
}

/**
 * Why an `envelope.drift` record was written (APRV-63).
 *
 * `state-mismatch` is the original reading of SPEC.md §6.3: the file makes a
 * claim about `state:` and the log implies another one. `envelope-missing` is
 * the loss case observed live in APRV-60: the log holds a `task.registered` for
 * the task, and the file that declared it now carries no `approval:` key at all.
 * They are separated because they call for different human actions — one is an
 * edit to reconcile, the other is a *deletion to restore* — and a reader who
 * could not tell them apart would treat a lost envelope as a stale one.
 *
 * `reason` is absent from records written before this vocabulary existed;
 * readers (including {@link driftAlreadyLogged}) treat absence as
 * `state-mismatch`, which is what every such record was.
 */
export const DRIFT_REASONS = ["state-mismatch", "envelope-missing"] as const;

export type DriftReason = (typeof DRIFT_REASONS)[number];

/** What an `envelope.drift` payload's `reason` says, defaulting for old records. */
function reasonOf(payload: Record<string, unknown>): string {
  const value = payload["reason"];
  return typeof value === "string" ? value : "state-mismatch";
}

export { latestRegistration } from "../core/registration.js";

/** The facts one `envelope.drift` record carries, and the dedupe key. */
export interface DriftFacts {
  /** The `state:` the file claims, or `null` when it declares none. */
  declaredState: string | null;
  /** The state the log implies (SPEC.md §6.3). */
  derivedState: EnvelopeState;
  /**
   * SHA-256 over the RFC 8785 form of the file's whole `approval:` envelope, or
   * `null` when the envelope could not be canonicalized. Part of the dedupe key
   * so that editing a file from one contradiction into a different one is a new
   * drift and not a suppressed one.
   */
  envelopeDigest: string | null;
  /**
   * Which kind of drift this is (APRV-63). Part of the dedupe key: a file that
   * contradicts the log and a file that lost its envelope are different facts
   * about the same task, and neither may suppress the other. Absent means
   * `state-mismatch`, matching every record written before the vocabulary
   * existed.
   */
  reason?: DriftReason;
}

/**
 * Has this exact drift already been recorded for `task`?
 *
 * The rule: compare against the **latest** `envelope.drift` for the task. Equal
 * `(reason, declared_state, derived_state, envelope_sha256)` means the situation
 * the log already describes is the situation now, so nothing is appended. Any
 * difference
 * — the human edited the file again, or the log moved and the derived state
 * changed — is a new fact and is recorded.
 *
 * Comparing against the latest record rather than against any record is
 * deliberate: a task that drifts, is repaired, and drifts the same way again has
 * genuinely drifted twice, and an audit that collapsed those into one would be
 * hiding a repetition from the person whose attention this system spends.
 *
 * For `envelope-missing` (APRV-63) the same rule reads as: one record per
 * episode of loss, re-derived every tick from the file and the log rather than
 * remembered, and a new record when the derived state moves underneath a file
 * that is still stripped. Its limit is stated where it is felt: a file whose
 * envelope is restored by hand *in agreement with the log* leaves no record of
 * the restoration, so a second loss at the same derived state reads as the same
 * episode and is not appended twice. Recording the restoration would need an
 * event nobody has specified; detection does not invent one.
 */
export function driftAlreadyLogged(
  records: EventRecord[],
  task: string,
  facts: DriftFacts,
): boolean {
  let latest: EventRecord | null = null;
  for (const record of records) {
    if (record.event === "envelope.drift" && record.task === task) latest = record;
  }
  if (latest === null) return false;
  const payload = payloadOf(latest);
  const declared = payload["declared_state"];
  const derived = payload["derived_state"];
  const digest = payload["envelope_sha256"];
  return (
    reasonOf(payload) === (facts.reason ?? "state-mismatch") &&
    (declared === undefined ? null : declared) === facts.declaredState &&
    derived === facts.derivedState &&
    (digest === undefined ? null : digest) === facts.envelopeDigest
  );
}
