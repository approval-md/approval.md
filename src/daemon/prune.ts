/**
 * Payload retention pruning — the enforcement half of amended SPEC.md §5.2
 * (APRV-38's vocabulary, APRV-41's daemon).
 *
 * > "A payload is prunable once the action it is bound to has been in a terminal
 * > state (`executed`, `rejected`, `expired`, `revoked`) for longer than the
 * > duration. A payload whose action is not terminal is never prunable, at any
 * > age […]. Orphaned payloads (bytes with no recorded binding) are prunable
 * > regardless of the key. […] Pruning is performed by the daemon and by nothing
 * > else, and each removal appends a `payload.pruned` event, so a log states what
 * > its store no longer holds."
 *
 * ## Write-ahead, always in that order
 *
 * For every file this module removes, the `payload.pruned` event lands in the
 * log **first** and the `unlink` follows. The ordering is the whole design: a
 * crash between the two leaves a file on disk that the log already says is gone,
 * which the next tick completes by unlinking it and appending nothing further
 * ({@link PrunePlan.completions}). The opposite order would leave the other
 * failure — bytes deleted with no record of the deletion — which is the one
 * outcome a store holding the material evidence of what a human approved cannot
 * afford. Deleting evidence is acceptable; deleting it silently is not.
 *
 * Idempotence needs no remembered state: a hash that already carries a
 * `payload.pruned` event is never given a second one, and the plan is re-derived
 * from the verified log on every tick.
 *
 * ## Terminal time comes from the log, never from the filesystem
 *
 * The clock that decides whether retention has elapsed reads the timestamp of the
 * event that made the action terminal (`execution.completed`, `approval.rejected`,
 * `approval.revoked`, `approval.expired`). File mtimes are not evidence: they are
 * rewritten by a copy, a checkout, a backup restore, or an `rsync`, and pruning on
 * them would let a routine filesystem operation decide when approval evidence
 * disappears.
 *
 * A **lazily** expired request (the TTL has arithmetically lapsed but no
 * `approval.expired` record exists) is deliberately not terminal here. The
 * daemon's own TTL sweep appends that event on the same tick; the payload becomes
 * prunable once the log says so, and retention is then measured from the recorded
 * moment rather than from one this module computed for itself.
 *
 * `execution.failed` is likewise not terminal: a failed action may be retried
 * against the very bytes in question, and loop escalation (SPEC.md §10.2) exists
 * precisely because failures recur.
 *
 * ## The orphan rule, resolved conservatively (flagged for review)
 *
 * §5.2 says orphaned payloads are "prunable regardless of the key", which reads
 * as though orphans could be swept even with `payload_retention` absent. APRV-41's
 * acceptance criteria say the absent key means no pruning at all. This module
 * takes the strictest reading that satisfies both:
 *
 * - **`payload_retention` absent: the pruning subsystem does not run.** Nothing is
 *   deleted, orphan or not, and no `payload.pruned` is appended. Retention is an
 *   operator's explicit choice to forget, and an operator who never made it never
 *   asked this runtime to delete anything.
 * - **`payload_retention` present: orphans are prunable at any age**, which is
 *   what "regardless of the key" then means — the duration governs bound payloads
 *   and does not gate residue nothing ever bound.
 *
 * An orphan is a file whose hash appears in **no** log record other than a
 * `payload.pruned` (head-moved residue: the gate stored the bytes, its append was
 * refused, and no request ever declared them). A hash mentioned by any other
 * record is bound, and a binding this module cannot attribute to an action key is
 * treated as live rather than as an orphan — fail closed in both directions.
 *
 * ## Nothing else here decides anything
 *
 * Approval state per action is `core/state.ts`'s `requestState`; the append is
 * `core/log.ts`'s `appendEvent` with `expectedHead` (compare-and-append, SPEC.md
 * §11.1 invariant 5); the unlink is `core/payload-store.ts`'s. The timestamp on
 * every `payload.pruned` is the runtime's, read from the injected clock at the
 * write boundary, and the actor is `system:daemon` — a party under oversight must
 * never be able to author either.
 */

import { tick as readClock, type Clock } from "../core/clock.js";
import { appendEvent, type EventRecord } from "../core/log.js";
import { isPayloadHash } from "../core/payload.js";
import {
  listStoredPayloadHashes,
  payloadStoreDirFor,
  removeStoredPayload,
} from "../core/payload-store.js";
import { loadPolicy, parseDuration, type LoadPolicyOptions } from "../core/policy-load.js";
import { payloadOf, readVerifiedRecords, requestState } from "../core/state.js";

/**
 * SPEC.md §8 and `event.schema.json`: `payload.pruned` carries a `system:` actor.
 * Declared here rather than imported from `daemon.ts` so the pruner has no
 * dependency on the loop that calls it.
 */
export const PRUNE_ACTOR = "system:daemon";

/** The terminal states of amended SPEC.md §5.2, and nothing beyond them. */
export type TerminalState = "executed" | "rejected" | "revoked" | "expired";

/** Why a payload is prunable. Mirrors `payload.pruned`'s `reason`. */
export type PruneReason = "payload_retention" | "orphaned";

/** One file the plan says may go, and the evidence for saying so. */
export interface PruneCandidate {
  hash: string;
  reason: PruneReason;
  /** The action whose terminal state released the bytes; `null` for an orphan. */
  actionKey: string | null;
  task: string | null;
  terminalState: TerminalState | null;
  /** The `ts` of the event that made it terminal; retention is measured from it. */
  terminalTs: string | null;
}

/**
 * What one tick would do.
 *
 * `completions` are hashes whose `payload.pruned` is already in the log while the
 * file is still on disk — a crash between the append and the unlink, or a store
 * that was restored from a backup taken before the prune. They are unlinked and
 * **no second event is appended**: the log already states the fact.
 */
export interface PrunePlan {
  candidates: PruneCandidate[];
  completions: string[];
}

/** A fresh empty plan each time: a shared one could be mutated by a caller. */
function emptyPlan(): PrunePlan {
  return { candidates: [], completions: [] };
}

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

/** Hashes a `payload.pruned` record already names. */
function prunedHashes(records: EventRecord[]): Set<string> {
  const pruned = new Set<string>();
  for (const record of records) {
    if (record.event !== "payload.pruned") continue;
    const hash = payloadOf(record)["payload_hash"];
    if (isPayloadHash(hash)) pruned.add(hash);
  }
  return pruned;
}

interface Binding {
  /** Action keys that declared this hash. */
  actionKeys: Set<string>;
  /** A record named the hash without an action key: bound, but unattributable. */
  unattributed: boolean;
}

/** Every payload-hash-shaped string anywhere inside a value. */
function hashesWithin(value: unknown, found: Set<string>): void {
  if (isPayloadHash(value)) {
    found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) hashesWithin(item, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) hashesWithin(item, found);
  }
}

/**
 * Every hash any record binds to, mapped to the actions that declared it.
 *
 * Two attributions are understood, because they are the two the runtime writes:
 * a `payload_hash` beside a record's own `action_key` (`approval.requested` and
 * `approval.granted` carry it there), and the `payload_hash` of each action
 * inside a `task.registered` envelope, attributed to that action's
 * `idempotency_key` — which is where a *registered but not yet requested* action
 * declares its bytes. Without the second, a payload stored at registration time
 * would look like residue nothing bound and be pruned out from under the request
 * about to be made for it.
 *
 * Everything else is caught by a deep scan and deliberately treated as a
 * binding this module cannot attribute: an unattributable binding is never
 * prunable, so an event shape nobody here anticipated makes a payload immortal
 * rather than making it disposable. The only event exempt from the scan is
 * `payload.pruned`, whose whole job is to name bytes that are going.
 */
function bindingsOf(records: EventRecord[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  const bindingFor = (hash: string): Binding => {
    let binding = bindings.get(hash);
    if (binding === undefined) {
      binding = { actionKeys: new Set<string>(), unattributed: false };
      bindings.set(hash, binding);
    }
    return binding;
  };

  for (const record of records) {
    if (record.event === "payload.pruned") continue;
    const payload = payloadOf(record);
    const attributed = new Set<string>();

    const own = payload["payload_hash"];
    const key = record.action_key;
    if (isPayloadHash(own) && typeof key === "string" && key.length > 0) {
      bindingFor(own).actionKeys.add(key);
      attributed.add(own);
    }

    const actions = payload["actions"];
    if (Array.isArray(actions)) {
      for (const action of actions) {
        if (typeof action !== "object" || action === null) continue;
        const item = action as Record<string, unknown>;
        const hash = item["payload_hash"];
        const declaredKey = item["idempotency_key"];
        if (!isPayloadHash(hash)) continue;
        if (typeof declaredKey === "string" && declaredKey.length > 0) {
          bindingFor(hash).actionKeys.add(declaredKey);
          attributed.add(hash);
        }
      }
    }

    const mentioned = new Set<string>();
    hashesWithin(payload, mentioned);
    for (const hash of mentioned) {
      if (attributed.has(hash)) continue;
      bindingFor(hash).unattributed = true;
    }
  }
  return bindings;
}

interface Terminal {
  state: TerminalState;
  ts: string;
}

/**
 * When (and whether) `actionKey` became terminal, per the log alone.
 *
 * `ttlMs` is passed as `null` to `requestState` on purpose: lazy expiry is
 * arithmetic this module refuses to prune on (see the module header), so the only
 * expiry that counts is one `approval.expired` recorded.
 *
 * A key whose request is live (`requested`) is never terminal, even when an older
 * execution completed: a fresh request binds to those bytes again and the earlier
 * outcome does not release them.
 */
function terminalOf(records: EventRecord[], actionKey: string, nowIso: string): Terminal | null {
  const derived = requestState(records, actionKey, nowIso, null);
  // A live request binds the bytes, whatever else the key's history holds.
  if (derived.state === "requested") return null;
  // `none` is not itself terminal: an action that was registered and never
  // requested still declares these bytes, and a request may yet be made for it.
  // It becomes terminal only by executing (the autonomous path, which requests
  // nothing), which the `execution.completed` branch below picks up.

  const seen: Terminal[] = [];
  const decision = derived.decision;
  if (decision === "rejected" || decision === "revoked") {
    if (derived.decisionTs !== null) seen.push({ state: decision, ts: derived.decisionTs });
  }
  if (decision === "expired" && derived.expiredByEvent && derived.decisionTs !== null) {
    seen.push({ state: "expired", ts: derived.decisionTs });
  }
  if (derived.execution.completed !== null) {
    const completed = records.find((record) => record.seq === derived.execution.completed);
    if (completed !== undefined) seen.push({ state: "executed", ts: completed.ts });
  }

  let terminal: Terminal | null = null;
  for (const entry of seen) {
    const at = Date.parse(entry.ts);
    if (Number.isNaN(at)) continue;
    if (terminal === null || at > Date.parse(terminal.ts)) terminal = entry;
  }
  return terminal;
}

/**
 * What may be pruned right now. Pure: no I/O, no clock, no policy loading.
 *
 * `retentionMs` is `null` when the policy declares no `payload_retention` — or
 * when the policy could not be loaded at all, which fails closed to the same
 * answer. Either way the plan is empty: the subsystem does not run.
 *
 * `nowIso` is the evaluation moment, injected. A pruner that read the clock
 * itself could not be replayed, and retention arithmetic that cannot be replayed
 * cannot be audited.
 */
export function planPrune(
  records: EventRecord[],
  presentHashes: string[],
  nowIso: string,
  retentionMs: number | null,
): PrunePlan {
  if (retentionMs === null) return emptyPlan();
  const now = Date.parse(nowIso);
  // An unparseable evaluation moment cannot be compared against anything, so
  // nothing is old enough for anything.
  if (Number.isNaN(now)) return emptyPlan();

  const pruned = prunedHashes(records);
  const bindings = bindingsOf(records);
  const candidates: PruneCandidate[] = [];
  const completions: string[] = [];

  for (const hash of [...presentHashes].sort()) {
    if (!isPayloadHash(hash)) continue;
    if (pruned.has(hash)) {
      completions.push(hash);
      continue;
    }

    const binding = bindings.get(hash);
    if (binding === undefined) {
      candidates.push({
        hash,
        reason: "orphaned",
        actionKey: null,
        task: null,
        terminalState: null,
        terminalTs: null,
      });
      continue;
    }
    // A binding nobody can attribute to an action key has no derivable terminal
    // state, so it is treated as live forever.
    if (binding.unattributed || binding.actionKeys.size === 0) continue;

    // EVERY action bound to these bytes must have released them. One live
    // request among ten settled ones keeps the payload.
    let latest: Terminal | null = null;
    let latestKey: string | null = null;
    let live = false;
    for (const key of [...binding.actionKeys].sort()) {
      const terminal = terminalOf(records, key, nowIso);
      if (terminal === null) {
        live = true;
        break;
      }
      if (latest === null || Date.parse(terminal.ts) > Date.parse(latest.ts)) {
        latest = terminal;
        latestKey = key;
      }
    }
    if (live || latest === null || latestKey === null) continue;
    if (!(now - Date.parse(latest.ts) > retentionMs)) continue;

    candidates.push({
      hash,
      reason: "payload_retention",
      actionKey: latestKey,
      task: taskOf(records, latestKey),
      terminalState: latest.state,
      terminalTs: latest.ts,
    });
  }

  return { candidates, completions };
}

/** The task an action key was last seen under, for the event's `task` field. */
function taskOf(records: EventRecord[], actionKey: string): string | null {
  let task: string | null = null;
  for (const record of records) {
    if (record.action_key === actionKey && typeof record.task === "string") task = record.task;
  }
  return task;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Why a prune pass complained. Reported to the caller; never thrown. */
export type PruneWarningCode =
  /** The verified read refused, so nothing was planned this pass. */
  | "log-unreadable"
  /** A `payload.pruned` append was refused; the file stays, untouched. */
  | "append-refused"
  /** The event landed but the file could not be removed. The next tick retries. */
  | "unlink-failed";

export interface PruneWarning {
  code: PruneWarningCode;
  message: string;
}

export interface PruneReport {
  /** `payload_retention` in milliseconds, or `null` when the subsystem is off. */
  retentionMs: number | null;
  /** Hashes for which a `payload.pruned` was appended this pass. */
  appended: PruneCandidate[];
  /** Hashes whose file was removed (appended-then-unlinked, plus completions). */
  removed: string[];
  /** Crash-window files finished without a second event. */
  completed: string[];
  warnings: PruneWarning[];
}

export interface PruneOptions {
  /** The append-only log. Re-read before every append. */
  logPath: string;
  /** The payload store. Defaults to the store beside `logPath`. */
  storeDir?: string;
  /** Policy location, with `loadPolicy`'s semantics. */
  policy: { dir?: string; file?: string };
  schemaDir?: string;
  /** The write-boundary clock (amended SPEC.md §8). Tests inject; production does not. */
  clock?: Clock;
}

/**
 * Read `payload_retention` from the policy in force right now.
 *
 * Fails closed to `null` exactly as the daemon's TTL read does: a policy that
 * cannot be loaded declares no retention, so nothing is pruned on its behalf. An
 * unparseable duration is likewise `null` — the schema's duration pattern makes
 * that unreachable through a validated policy, and a retention rule this module
 * cannot read is not one it may guess at.
 */
export function retentionMsOf(policy: { dir?: string; file?: string }, schemaDir?: string): number | null {
  const where: LoadPolicyOptions =
    policy.file !== undefined ? { file: policy.file } : { dir: policy.dir ?? process.cwd() };
  if (schemaDir !== undefined) where.schemaDir = schemaDir;
  const load = loadPolicy(where);
  if (!load.ok) return null;
  const text = load.policy.payload_retention;
  if (text === undefined) return null;
  return parseDuration(text);
}

/**
 * One pruning pass: plan, append, unlink, repeat.
 *
 * The log is re-read before each append rather than once for the pass, because
 * each append moves the head the next one is compared against and because a CLI
 * verb may have appended in between. `expectedHead` therefore always names the
 * head the decision was made from; a `head-moved` refusal drops the candidate and
 * the next tick re-derives it.
 *
 * Nothing is retried in place, and no state survives the call.
 */
export function prunePayloads(options: PruneOptions): PruneReport {
  const retentionMs = retentionMsOf(options.policy, options.schemaDir);
  const report: PruneReport = {
    retentionMs,
    appended: [],
    removed: [],
    completed: [],
    warnings: [],
  };
  if (retentionMs === null) return report;

  const storeDir = options.storeDir ?? payloadStoreDirFor(options.logPath);
  const readOptions = options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir };
  const clockOptions = options.clock === undefined ? {} : { clock: options.clock };

  // Hashes this pass has already acted on, so a plan re-derived after an append
  // cannot hand the same file back twice within one call.
  const handled = new Set<string>();

  for (;;) {
    const read = readVerifiedRecords(options.logPath, readOptions);
    if (!read.ok) {
      // A log that does not verify stops the *daemon* (its own tick refuses to
      // continue); here it simply means this pass plans nothing. Pruning never
      // appends onto a chain it could not read.
      report.warnings.push({ code: "log-unreadable", message: read.message });
      return report;
    }

    const now = readClock(clockOptions);
    const plan = planPrune(read.records, listStoredPayloadHashes(storeDir), now, retentionMs);

    // Crash-window completions first: they append nothing, so they cannot move
    // the head out from under the candidate below.
    for (const hash of plan.completions) {
      if (handled.has(hash)) continue;
      handled.add(hash);
      const removal = removeStoredPayload(storeDir, hash);
      if (!removal.ok) {
        report.warnings.push({ code: "unlink-failed", message: removal.message });
        continue;
      }
      report.completed.push(hash);
      if (removal.existed) report.removed.push(hash);
    }

    const candidate = plan.candidates.find((entry) => !handled.has(entry.hash));
    if (candidate === undefined) return report;
    handled.add(candidate.hash);

    const payload: Record<string, unknown> = {
      payload_hash: candidate.hash,
      reason: candidate.reason,
    };
    if (candidate.reason === "payload_retention") {
      payload["retention"] = durationText(retentionMs);
      if (candidate.terminalState !== null) payload["terminal_state"] = candidate.terminalState;
      if (candidate.terminalTs !== null) payload["terminal_ts"] = candidate.terminalTs;
    }

    const input: Parameters<typeof appendEvent>[1] = {
      ts: now,
      event: "payload.pruned",
      actor: PRUNE_ACTOR,
      payload,
    };
    if (candidate.task !== null) input.task = candidate.task;
    if (candidate.actionKey !== null) input.action_key = candidate.actionKey;

    const appended = appendEvent(options.logPath, input, {
      ...readOptions,
      expectedHead: read.head,
    });
    if (!appended.ok) {
      // WRITE-AHEAD: the file stays. An unlogged deletion is the one outcome
      // this module exists to prevent, so a refused append prunes nothing.
      report.warnings.push({
        code: "append-refused",
        message: `payload.pruned for ${candidate.hash} was not appended (${appended.error.code}): ${appended.error.message}; the file was left in place`,
      });
      continue;
    }
    report.appended.push(candidate);

    const removal = removeStoredPayload(storeDir, candidate.hash);
    if (!removal.ok) {
      // The event is in the log and the bytes are still on disk: the log is
      // ahead of the store, which is the safe direction. The next tick sees the
      // file as a completion and unlinks it without a second event.
      report.warnings.push({ code: "unlink-failed", message: removal.message });
      continue;
    }
    report.removed.push(candidate.hash);
  }
}

/**
 * The retention duration as the policy would have written it, for the event.
 *
 * Reconstructed from milliseconds rather than carried through from the policy
 * text so the value recorded is the one the arithmetic used: a log that says
 * `30d` when the code compared against something else would be worse than a log
 * that says nothing.
 */
function durationText(ms: number): string {
  const units: [number, string][] = [
    [604_800_000, "w"],
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [scale, unit] of units) {
    if (ms % scale === 0 && ms >= scale) return `${String(ms / scale)}${unit}`;
  }
  return `${String(ms)}ms`;
}

// ---------------------------------------------------------------------------
// Reporting (status, doctor)
// ---------------------------------------------------------------------------

export interface PayloadStoreCensus {
  /** Files the store currently holds, by hash. */
  files: number;
  /** Distinct hashes a `payload.pruned` event names — evidence that outlived bytes. */
  pruned: number;
  /** Files present that no record binds: head-moved residue, prunable when enabled. */
  orphans: number;
  /** Files present whose prune event is already logged (a crash mid-prune). */
  awaitingRemoval: number;
}

/**
 * Count what the store holds against what the log says about it.
 *
 * Honest in both directions and about both failure modes: `pruned` is a fact of
 * the log (it stays true forever, whatever the store does), `orphans` and
 * `awaitingRemoval` are facts about the disagreement between the two. None of
 * them is a health verdict; a reader is being told what is there.
 */
export function payloadStoreCensus(records: EventRecord[], storeDir: string): PayloadStoreCensus {
  const present = listStoredPayloadHashes(storeDir);
  const pruned = prunedHashes(records);
  const bindings = bindingsOf(records);
  let orphans = 0;
  let awaitingRemoval = 0;
  for (const hash of present) {
    if (pruned.has(hash)) awaitingRemoval += 1;
    else if (!bindings.has(hash)) orphans += 1;
  }
  return { files: present.length, pruned: pruned.size, orphans, awaitingRemoval };
}
