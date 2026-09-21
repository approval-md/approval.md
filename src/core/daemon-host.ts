/**
 * How a daemon process learns its own id, and which ids its policy admits
 * (APRV-383).
 *
 * The other half of `core/daemon-identity.ts`, which holds the grammar, the
 * process state and the one question the write boundary asks. This half does the
 * reading: the launch environment, the instance the log belongs to, and the
 * `daemons` list in an attested policy. It is deliberately NOT imported by
 * `core/log.ts` — see that module's header for the import cycle this separation
 * avoids and for why the seam is the right one anyway.
 *
 * ## The id
 *
 * Two sources, in this order:
 *
 * 1. `APPROVAL_DAEMON_ID` in the launch environment. An operator hosting several
 *    tenants names their processes, and a name a person chose is the one a person
 *    can recognise on a card, in a log and in an allowlist. It is in the
 *    environment rather than in a file for the reason every other launch fact is
 *    (SPEC.md §11.1 invariant 7): the process's operator establishes it, and no
 *    verb reads it out of the working tree.
 * 2. Otherwise DERIVED from the instance: `daemon-` plus the eight hex digits
 *    `core/instance.ts` already computes from the absolute path of the instance's
 *    `.approval` directory, which `approval doctor` prints as its `keychain-scope`
 *    suffix and `.approval/env` carries in the open.
 *
 * The derived form is what makes AC1's "stable across restarts on the same
 * machine and keystore" true without storing anything: the input is a directory
 * path, so a restart, a rebuild of the process and a second daemon started in the
 * same checkout all derive one id, while a different checkout on the same machine
 * derives a different one. It is the same identity the keystore items are scoped
 * by, which is the point — an operator reading `daemon-3f2a9c11` in a record and
 * `approval-tg-token-3f2a9c11` in `.approval/env` is looking at one gate.
 *
 * A random id written to a file was rejected for the reason `core/instance.ts`
 * rejects it: a file an operator can copy is an identity that travels, and an id
 * that changed on every restart would make the `daemons` allowlist unwritable.
 *
 * ## The allowlist
 *
 * Read from the ATTESTED policy and from nothing else, which is invariant 1 doing
 * its ordinary work: the bytes a human signed are the only bytes a refusal may be
 * derived from, and a policy file edited since is inoperative. The daemon resolves
 * it against its own verified read and its own attestation check, never against a
 * claim from a caller.
 */

import { checkAttestation } from "./attest.js";
import {
  DAEMON_ID_ENV,
  declareDaemonIdentity,
  isDaemonId,
  setDaemonAllowlist,
  type DaemonIdSource,
} from "./daemon-identity.js";
import { instanceIdFor } from "./instance.js";
import type { EventRecord } from "./log.js";
import type { PolicyLoadResult } from "./policy-load.js";

/** The prefix a derived id wears, so the string says what kind of id it is. */
export const DERIVED_DAEMON_ID_PREFIX = "daemon-";

/** The id this instance derives when the launch environment declares none. */
export function derivedDaemonId(logPath: string): string {
  return `${DERIVED_DAEMON_ID_PREFIX}${instanceIdFor(logPath)}`;
}

/** The id a daemon started against `logPath` would write, or why it has none. */
export type DaemonIdResolution =
  | { ok: true; id: string; source: DaemonIdSource }
  | {
      ok: false;
      code: "daemon-id-invalid";
      /** What the variable held, so a message can quote it back. */
      declared: string;
      message: string;
    };

/**
 * Resolve the id, preferring an explicit declaration and otherwise deriving one.
 *
 * A declared id that fails the grammar is a REFUSAL rather than a fall back to
 * the derived form: the operator meant the value they set, and a runtime that
 * quietly substituted another would write records under a name nobody chose and
 * check them against an allowlist nobody wrote for it. A blank or
 * whitespace-only value is treated as unset, because an empty variable is how a
 * shell spells "I did not set this".
 */
export function resolveDaemonId(
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): DaemonIdResolution {
  const raw = env[DAEMON_ID_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return { ok: true, id: derivedDaemonId(logPath), source: "derived" };
  }
  if (!isDaemonId(raw)) {
    return {
      ok: false,
      code: "daemon-id-invalid",
      declared: raw,
      message: `${DAEMON_ID_ENV}=${JSON.stringify(raw)} is not a usable daemon id: lowercase letters, digits, \`.\`, \`-\` and \`_\`, starting with a letter or digit, at most 64 characters. Unset it to derive ${derivedDaemonId(logPath)} from this instance`,
    };
  }
  return { ok: true, id: raw, source: "environment" };
}

/**
 * Declare this process's identity into `core/daemon-identity.ts`, and hand back
 * what was resolved.
 *
 * Called by the daemon runtime at construction, beside `markDaemonProcess()`. An
 * UNUSABLE declared id is still declared — as an identity with no id — because a
 * daemon that cannot name itself must be refused at the write boundary rather
 * than left unmarked and writing: the CLI verbs refuse to start on the same
 * resolution, and this is what closes the gap for a `Daemon` constructed
 * directly.
 */
export function declareDaemonIdentityFor(
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): DaemonIdResolution {
  const resolved = resolveDaemonId(logPath, env);
  if (resolved.ok) {
    declareDaemonIdentity({ id: resolved.id, source: resolved.source });
  } else {
    declareDaemonIdentity({ id: null, declared: resolved.declared, source: null });
  }
  return resolved;
}

/**
 * The `daemons` list a LOADED policy declares, or `null` for no restriction.
 *
 * `null` for a policy that does not load at all, which looks like a widening and
 * is not: this function answers "what does this document say", and every caller
 * that could refuse on the answer requires an ATTESTED policy first
 * ({@link resolveDaemonAllowlist}). A policy that fails to load restricts
 * nothing here and makes every class `manual` everywhere else, which is where the
 * fail-closed behaviour of an unreadable policy lives.
 */
export function daemonAllowlistOf(load: PolicyLoadResult): readonly string[] | null {
  if (!load.ok) return null;
  const declared = load.policy.daemons;
  return declared === undefined ? null : declared;
}

/** Why a resolution could not be made, or `null` when one was. */
export type DaemonAllowlistRefusal = "policy-unloadable" | "policy-not-attested";

/** The outcome of {@link resolveDaemonAllowlist}. */
export type DaemonAllowlistResolution =
  | { ok: true; allowed: readonly string[] | null }
  | { ok: false; reason: DaemonAllowlistRefusal; detail: string };

/**
 * The allowlist in force, from the attested policy and the verified log.
 *
 * `records` are the caller's own VERIFIED records (invariant 1) and `load` its
 * own policy load; both are passed in rather than read here so that the daemon's
 * tick does one verified read and one policy load, and so that this function is
 * pure and exhaustively testable.
 *
 * A failure is reported and is NOT a restriction of its own: the caller leaves
 * whatever was last resolved in force (`core/daemon-identity.ts`'s
 * `setDaemonAllowlist` is simply not called), so a policy that becomes unreadable
 * cannot be a way out of the list it carried a moment ago, and a deployment whose
 * policy was never attested is unrestricted exactly as it was before this key
 * existed.
 */
export function resolveDaemonAllowlist(
  records: readonly EventRecord[],
  load: PolicyLoadResult,
): DaemonAllowlistResolution {
  if (!load.ok) {
    return {
      ok: false,
      reason: "policy-unloadable",
      detail: `the policy could not be loaded (${load.code}), so no \`daemons\` list could be read from it`,
    };
  }
  const attestation = checkAttestation([...records], load.source.path);
  if (attestation.status !== "attested") {
    return {
      ok: false,
      reason: "policy-not-attested",
      detail: `the policy at ${load.source.path} is not attested (${attestation.status}), so its \`daemons\` list is not a list a human signed`,
    };
  }
  return { ok: true, allowed: daemonAllowlistOf(load) };
}

/**
 * Resolve the allowlist and put it in force, or leave the previous one standing.
 *
 * The one call the daemon's tick makes. It returns the resolution so the caller
 * can say what happened, and it never widens: on a failure nothing is set.
 */
export function refreshDaemonAllowlist(
  records: readonly EventRecord[],
  load: PolicyLoadResult,
): DaemonAllowlistResolution {
  const resolution = resolveDaemonAllowlist(records, load);
  if (resolution.ok) setDaemonAllowlist(resolution.allowed);
  return resolution;
}
