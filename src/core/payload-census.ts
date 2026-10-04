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

import { readFileSync } from "node:fs";

import type { EventRecord } from "./log.js";
import { isPayloadHash, payloadHash } from "./payload.js";
import { listStoredPayloadHashes, loadPayload, payloadPath } from "./payload-store.js";
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

// ---------------------------------------------------------------------------
// Integrity of the payloads verified records bind (APRV-457)
// ---------------------------------------------------------------------------

/**
 * One bound payload the store does not hold intact.
 *
 * - `torn`: the file is there and is empty or every byte is NUL. That is what a
 *   crash before writeback leaves (the name reached the disk, the data did
 *   not), and it is the only reading this module gives the crash signature. No
 *   valid payload can look like it: an RFC 8785 serialization is never empty
 *   and never carries a raw NUL byte.
 * - `lost`: the file is absent although a record proves the store held it when
 *   the record was appended (see {@link heldAtAppend}). That is the other half of
 *   the same crash: the name never reached the disk.
 * - `mismatch`: the file holds at least one non-NUL byte and does not verify
 *   against its name. Not the crash signature, by construction: a crash does not
 *   write bytes nobody wrote. Read as tampering or corruption.
 * - `unreadable`: the file exists and could not be read (a permission, an I/O
 *   error); nothing about its bytes is known.
 */
export type PayloadDamage =
  | { kind: "torn"; hash: string; seq: number; bytes: number; path: string }
  | { kind: "lost"; hash: string; seq: number; event: string; path: string }
  | { kind: "mismatch"; hash: string; seq: number; detail: string; path: string }
  | { kind: "unreadable"; hash: string; seq: number; detail: string; path: string };

/**
 * Hashes a record proves the store HELD when that record was appended, mapped
 * to the first such record. Only these make an absent file evidence of loss;
 * every other binding (a `task.registered` declaration, a request made without
 * material) may name bytes this runtime never held, and its absence says
 * nothing.
 *
 * - `policy.proposed` and `policy.updated` with a `payload_hash`: both verbs
 *   store the text first and refuse the append when they cannot (SPEC.md
 *   §10.4, APRV-356).
 * - `approval.requested` carrying `display_hash`: the runtime assigns it only
 *   when it held the material, supplied (and stored before the append) or read
 *   from the store (APRV-119).
 */
function heldAtAppend(records: EventRecord[]): Map<string, EventRecord> {
  const held = new Map<string, EventRecord>();
  for (const record of records) {
    const payload = payloadOf(record);
    const hash = payload["payload_hash"];
    if (!isPayloadHash(hash) || held.has(hash)) continue;
    const proves =
      record.event === "policy.proposed" ||
      record.event === "policy.updated" ||
      (record.event === "approval.requested" && typeof payload["display_hash"] === "string");
    if (proves) held.set(hash, record);
  }
  return held;
}

/**
 * Whether bytes whose JSON is `{"$ref": …}` are themselves the material bound:
 * `storePayload` of such a value writes exactly that, and it hashes to its
 * name. `loadPayload` reports the reference form before hashing, so the check
 * is made here.
 */
function hashesToItsName(bytes: Buffer, hash: string): boolean {
  try {
    return payloadHash(JSON.parse(bytes.toString("utf8")) as unknown) === hash;
  } catch {
    return false;
  }
}

/** The first record that binds each hash, for naming it in a report. */
function firstBindingSeq(records: EventRecord[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const record of records) {
    if (record.event === "payload.pruned") continue;
    const mentioned = new Set<string>();
    hashesWithin(payloadOf(record), mentioned);
    for (const hash of mentioned) if (!first.has(hash)) first.set(hash, record.seq);
  }
  return first;
}

/**
 * Every payload a verified record binds that the store does not hold intact,
 * in log order. Reads files; writes, moves and deletes nothing.
 *
 * `records` must be the verified chain (doctor passes the records of its one
 * verified walk). A hash a `payload.pruned` record names is skipped whatever
 * its file holds: retention removed it on purpose and the log says so.
 */
export function payloadIntegrity(records: EventRecord[], storeDir: string): PayloadDamage[] {
  const pruned = prunedHashes(records);
  const held = heldAtAppend(records);
  const firstSeq = firstBindingSeq(records);
  const damage: PayloadDamage[] = [];

  for (const [hash, seq] of firstSeq) {
    if (pruned.has(hash)) continue;
    const path = payloadPath(storeDir, hash);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        const holder = held.get(hash);
        if (holder !== undefined) {
          damage.push({ kind: "lost", hash, seq: holder.seq, event: holder.event, path });
        }
        continue;
      }
      damage.push({
        kind: "unreadable",
        hash,
        seq,
        detail: cause instanceof Error ? cause.message : String(cause),
        path,
      });
      continue;
    }

    if (bytes.every((byte) => byte === 0)) {
      damage.push({ kind: "torn", hash, seq, bytes: bytes.length, path });
      continue;
    }

    const loaded = loadPayload(storeDir, hash);
    if (loaded.ok) continue;
    if (loaded.code === "reference") {
      // A `{"$ref": …}` pointer is a legitimate store form for material this
      // runtime never held, and `loadPayload` reports it before hashing. Where
      // a record PROVES the runtime held the real bytes, a pointer under that
      // name is a replacement, not a reference: tampering, read as such.
      if (!held.has(hash) || hashesToItsName(bytes, hash)) continue;
      damage.push({
        kind: "mismatch",
        hash,
        seq,
        detail: `${path} holds an external reference although a record proves the store held the material itself; the bytes were replaced`,
        path,
      });
      continue;
    }
    damage.push({ kind: "mismatch", hash, seq, detail: loaded.message, path });
  }
  return damage.sort((a, b) => a.seq - b.seq);
}
