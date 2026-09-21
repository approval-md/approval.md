/**
 * WHICH daemon wrote this record, and the check the write boundary runs on it
 * (APRV-383).
 *
 * ## The fact this module is about
 *
 * `core/daemon-actor.ts` answers "is this process the daemon". Every record the
 * daemon appends carried that and nothing more: a generic `system:daemon` actor,
 * one string, identical on every machine that ever ran one. That is enough while
 * a gate's daemon is the operator's own process in the operator's own checkout,
 * and it stops being enough the moment one party HOSTS a daemon for another.
 * Three properties of that arrangement already hold: authority comes from the
 * tenant's attested policy and never from the host (§5.2, APRV-324 and 356),
 * credentials come from the launch environment so one process holds one tenant's
 * token, and a decision arrives only through the tenant's own sender mapping so
 * the host cannot mint one. What was missing is the smallest of the four and the
 * one a tenant reads first: opening their own log and seeing which daemon acted
 * on their behalf.
 *
 * So a daemon-written record carries a `daemon` field naming the instance that
 * wrote it, and an attested policy MAY list the ids permitted to write
 * (`daemons`, read by `core/daemon-host.ts`). An id the list does not name is
 * refused at the write boundary.
 *
 * ## What the id is NOT, and this is the important half
 *
 * It is a SELF-REPORTED field, so SPEC.md §11.1 invariant 4 governs it
 * completely: it may raise scrutiny and may never lower it. Concretely, in this
 * runtime:
 *
 * - a listed id gains NOTHING. No verdict, no autonomy, no budget, no floor, no
 *   sampling draw, no token and no TTL reads this field or the list. Being named
 *   in `daemons` buys a daemon exactly the ability it had before the key existed;
 * - an unlisted id is REFUSED, which is the only direction the field moves
 *   anything, and it moves it strictly towards writing less;
 * - the id never enters a payload hash and never enters a token. It is a
 *   top-level record field, so the record's own chain hash covers it the way it
 *   covers `actor` (a record's provenance has to be part of what the chain
 *   protects, or it could be edited without breaking the chain), and no bound
 *   payload, no `payload_hash` and no `token_sha256` is computed over it.
 *
 * And it is ATTRIBUTION rather than authorization. A hostile host process holds
 * the tenant's log handle and can call anything in this module the daemon calls,
 * exactly as it can call {@link markDaemonProcess}; `core/daemon-actor.ts` states
 * that boundary and this module inherits it word for word. What the allowlist
 * catches is the likelier failure and the one nothing caught before: a daemon
 * started against the wrong tenant's log, a second daemon nobody meant to leave
 * running, a container rebuilt with a new id, each of which used to write records
 * indistinguishable from the intended daemon's.
 *
 * ## Why the state is module state and not an argument
 *
 * For the reason `core/daemon-actor.ts` gives for taking no arguments: a field a
 * caller passes is a field a caller chooses, and an `appendEvent` option naming
 * the writing daemon would let any process in this runtime claim to be one. The
 * daemon runtime declares its own identity once, at construction, through
 * `core/daemon-host.ts`, and `core/log.ts` READS it. `EventInput` deliberately
 * has no `daemon` member, and `buildRecord` composes a record field by field, so
 * a caller that puts the property on its input object anyway is ignored rather
 * than obeyed.
 *
 * ## Why this module imports almost nothing
 *
 * `core/log.ts` imports it, and `core/log.ts` is the bottom of this codebase's
 * import graph: `core/instance.ts` (where the derived id comes from) reaches
 * `core/attest.ts` through `core/env-file.ts`, and `core/attest.ts` spreads
 * `APPEND_ERROR_CODES` at module scope, so importing the
 * derivation here would close a cycle whose evaluation order throws before any
 * test ran. The split is also the right seam on its own terms: what the write
 * boundary needs is a grammar, a state and one question, and everything that
 * reads a policy or a filesystem to ANSWER that question lives in
 * `core/daemon-host.ts`.
 */

import { isDaemonProcess } from "./daemon-actor.js";

/**
 * The environment variable a launch may declare the daemon's id in.
 *
 * Beside `APPROVAL_HUMAN` and the credential variables, and in the launch
 * environment for the same reason they are: SPEC.md §11.1 invariant 7 keeps this
 * runtime from reading configuration out of the working tree, and a hosted
 * daemon's id is configuration its OPERATOR sets, never something the tenant's
 * repository tells the host about itself.
 */
export const DAEMON_ID_ENV = "APPROVAL_DAEMON_ID";

/** The longest id this runtime writes or admits. */
export const DAEMON_ID_MAX_LENGTH = 64;

/**
 * The shape an id takes: lowercase alphanumerics, dots, dashes and underscores,
 * starting with an alphanumeric.
 *
 * Narrow on purpose, and for the reason `payload.harness_version` is narrow
 * (APRV-227): the value is a string from a launch environment being written into
 * an append-only log, so a banner, a path, a newline or a shell fragment must not
 * be able to arrive through it. It is also a value an operator COMPARES by eye
 * against `approval doctor` and against the `daemons` list in their policy, and
 * two ids differing only in case are two ids nobody can tell apart on a phone.
 */
const DAEMON_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/** Is `value` a well-formed daemon id? */
export function isDaemonId(value: string): boolean {
  return value.length <= DAEMON_ID_MAX_LENGTH && DAEMON_ID_PATTERN.test(value);
}

/**
 * The two ways an append can be refused for the identity of the daemon making
 * it, spread into `APPEND_ERROR_CODES` by `core/log.ts`.
 *
 * Two codes rather than one, because the repairs have nothing in common and
 * SPEC.md §11.1 invariant 6 is about a caller being able to act on the answer:
 * one is a line to add to an attested policy, the other is a variable to fix in
 * the launch environment of a process that should not have started.
 *
 * Declared here rather than in `core/log.ts`'s literal list so that the codes and
 * the logic that emits them cannot drift apart; the union there spreads this one,
 * exactly as `ATTEST_ERROR_CODES` spreads it.
 */
export const DAEMON_APPEND_REFUSAL_CODES = [
  /**
   * The daemon declared an id through {@link DAEMON_ID_ENV} that is not a
   * well-formed id at all, so no record it wrote could be attributed to anything.
   *
   * Refused rather than silently falling back to the derived id, which is the
   * fail-closed direction twice over: an operator who set the variable meant the
   * value they set, and a runtime that quietly used a different one would write
   * records under a name nobody chose, against an allowlist nobody wrote for it.
   */
  "daemon-id-invalid",
  /**
   * The attested policy lists the daemon ids that may write to this log, and this
   * daemon's id is not among them.
   *
   * An ABSENT list is no restriction, not an empty one: a policy that never
   * declares the key behaves exactly as every policy written before it existed.
   */
  "daemon-not-allowed",
] as const;

export type DaemonAppendRefusalCode = (typeof DAEMON_APPEND_REFUSAL_CODES)[number];

/** Where this process's id came from. */
export type DaemonIdSource = "environment" | "derived";

/**
 * What a daemon process has declared about itself, or `null` in a process that
 * has declared nothing.
 *
 * `id` is `null` exactly when {@link DAEMON_ID_ENV} held something unusable: the
 * state is still declared, because a daemon that cannot name itself must be
 * REFUSED rather than left unmarked and writing.
 */
export interface DaemonIdentity {
  /** The resolved id, or `null` when the declared one is unusable. */
  id: string | null;
  /** The raw value {@link DAEMON_ID_ENV} held, when it held one. */
  declared: string | null;
  /** Where {@link id} came from; `null` when there is no id. */
  source: DaemonIdSource | null;
  /**
   * The ids the attested policy admits, or `null` for no restriction.
   *
   * `null` is the state a process starts in and the state an attested policy
   * declaring no `daemons` key resolves to. The difference between them matters
   * to nothing here, deliberately: neither is a restriction, and a runtime that
   * refused because it had not looked yet would refuse every deployment that
   * never adopts the key.
   */
  allowed: readonly string[] | null;
}

/** The declaring process's own state. Never set on another process's behalf. */
let identity: DaemonIdentity | null = null;

/**
 * Declare the id this process's records carry. Called by the daemon runtime
 * through `core/daemon-host.ts`, and by nothing else.
 *
 * Takes the RESOLVED values rather than resolving them, because resolution reads
 * the environment and the filesystem and this module is the one `core/log.ts`
 * imports (see the header). Idempotent, and a second call replaces the first: a
 * runtime that re-resolves its identity is reporting a fact about itself, and the
 * newest reading is the one in force.
 */
export function declareDaemonIdentity(state: {
  id: string | null;
  declared?: string | null;
  source: DaemonIdSource | null;
}): void {
  identity = {
    id: state.id,
    declared: state.declared ?? null,
    source: state.source,
    // A fresh declaration carries no allowlist. The daemon resolves one from its
    // attested policy and sets it separately, so an identity re-declared mid-run
    // cannot silently drop a restriction that was in force.
    allowed: identity === null ? null : identity.allowed,
  };
}

/**
 * Record which daemon ids this log's ATTESTED policy admits.
 *
 * Called only after a successful resolution: the daemon loaded its policy, read
 * the verified log, and the attestation matched (`core/daemon-host.ts`). A
 * resolution that FAILED calls nothing, so the restriction last resolved stays in
 * force rather than lapsing — a policy that becomes unreadable must not be a way
 * to escape the list it carried a moment ago.
 *
 * `null` means the attested policy declares none, which is no restriction.
 */
export function setDaemonAllowlist(allowed: readonly string[] | null): void {
  if (identity === null) return;
  identity = { ...identity, allowed: allowed === null ? null : [...allowed] };
}

/** Forget the declaration. For tests, and for a runtime that stops being one. */
export function clearDaemonIdentity(): void {
  identity = null;
}

/** What this process has declared about itself, or `null`. */
export function daemonIdentity(): DaemonIdentity | null {
  return identity;
}

/** What {@link daemonStampForAppend} answers. */
export type DaemonStamp =
  /** Not a declaring daemon process: the record is written as it always was. */
  | { kind: "absent" }
  /** Stamp this id onto the record. */
  | { kind: "stamp"; id: string }
  /** Refuse the append; nothing is written. */
  | { kind: "refuse"; code: DaemonAppendRefusalCode; message: string };

/**
 * The write boundary's question, answered from this process's own state
 * (APRV-383).
 *
 * Both halves of the answer are here rather than in two functions, because they
 * are one decision made in one order: a process that cannot name itself is
 * refused before anything asks whether its name is allowed.
 *
 * A process that marked itself the daemon and declared NO identity gets
 * `absent`, not a refusal. That is the pre-APRV-383 daemon, and the records it
 * writes are the records it always wrote; turning an undeclared mark into a dead
 * log would make an unrelated module's `markDaemonProcess` call a stop-the-world
 * bug. The daemon runtime declares both together.
 */
export function daemonStampForAppend(): DaemonStamp {
  if (!isDaemonProcess()) return { kind: "absent" };
  const state = identity;
  if (state === null) return { kind: "absent" };

  if (state.id === null) {
    return {
      kind: "refuse",
      code: "daemon-id-invalid",
      message: `this daemon declared ${DAEMON_ID_ENV}=${JSON.stringify(state.declared ?? "")}, which is not a usable daemon id (lowercase letters, digits, \`.\`, \`-\` and \`_\`, starting with a letter or digit, at most ${String(DAEMON_ID_MAX_LENGTH)} characters), so no record it wrote could name which daemon wrote it. Nothing was written: fix ${DAEMON_ID_ENV} in this process's launch environment, or unset it and let the id derive from this instance`,
    };
  }

  const allowed = state.allowed;
  if (allowed !== null && !allowed.includes(state.id)) {
    return {
      kind: "refuse",
      code: "daemon-not-allowed",
      message: `this daemon's id is ${state.id} and the attested policy's \`daemons\` list admits ${allowed.length === 0 ? "no daemon at all" : allowed.join(", ")}, so it may not write to this log. Nothing was written: add ${state.id} to \`daemons\` and re-attest the policy, or run the daemon whose id the list already names`,
    };
  }

  return { kind: "stamp", id: state.id };
}
