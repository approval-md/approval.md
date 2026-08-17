/**
 * What the payload store holds, read against what the log says about it
 * (APRV-41's counts, APRV-59's home for them).
 *
 * The census is a *reporting* question, asked by `approval doctor` and by
 * `approval status`, and answered from two sources that can disagree: the files
 * under `.approval/payloads/` and the records of `events.jsonl`. It decides
 * nothing and deletes nothing. The daemon's pruner (`daemon/prune.ts`) is the
 * only caller allowed to act on the same facts, and it derives its plan through
 * the two helpers exported here so that the counts a reader is shown and the
 * files the daemon would remove are computed by one piece of code.
 *
 * ## Why this lives in `core/` and not beside the pruner
 *
 * The CLI reports these numbers, and a CLI verb reaching into `daemon/` to do it
 * is the wrong direction: `daemon/` is a caller of the core, never a dependency
 * of the surfaces. This module is that shared core. Nothing here reads a clock,
 * loads a policy, appends an event, or unlinks a file.
 *
 * ## Why not in `core/payload-store.ts`
 *
 * The store module is deliberately ignorant of the log ("Nothing here opens
 * `events.jsonl`"): it addresses bytes by hash and verifies them, and that
 * narrowness is what makes it safe to call from every channel. The census is the
 * opposite kind of thing, a comparison between the log and the store, so it gets
 * its own module rather than teaching the store to read events.
 */

import type { EventRecord } from "./log.js";
import { isPayloadHash } from "./payload.js";
import { listStoredPayloadHashes } from "./payload-store.js";
import { payloadOf } from "./state.js";

/** Hashes a `payload.pruned` record already names. */
export function prunedHashes(records: EventRecord[]): Set<string> {
  const pruned = new Set<string>();
  for (const record of records) {
    if (record.event !== "payload.pruned") continue;
    const hash = payloadOf(record)["payload_hash"];
    if (isPayloadHash(hash)) pruned.add(hash);
  }
  return pruned;
}

export interface Binding {
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
export function bindingsOf(records: EventRecord[]): Map<string, Binding> {
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
