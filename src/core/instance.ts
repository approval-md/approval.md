/**
 * Which gate instance this process is talking about (APRV-178).
 *
 * Everything else in this runtime is directory-scoped already: the policy is
 * the `APPROVAL.md` beside the working directory, the log is that directory's
 * `.approval/log/events.jsonl`, the vault and `.approval/env` sit next to it.
 * Two checkouts on one machine are two gates, and nothing they hold is shared.
 *
 * The OS keystore was the exception, and it cost a live incident: the item
 * names were three fixed strings, so a demo instance provisioned in another
 * directory stored its bot token over the production instance's item and then
 * read the production token back. Both gates then long-polled ONE bot, the
 * `getUpdates` offsets fought, and a human's approval tap was consumed by the
 * listener that had not asked for it. A keystore is machine-global; the names
 * put into it have to carry the scoping the filesystem gave everything else.
 *
 * ## What the identity is
 *
 * The absolute path of the instance's `.approval` directory, hashed. Not the
 * repository root (a gate may be configured with `--log` somewhere else), not
 * a random id written into a file (a file the operator can copy is an identity
 * that travels, which is the bug), and not the log path itself (a `--log` that
 * names the same instance's log by a different but equivalent spelling should
 * not mint a second identity, and `envFilePathFor` already normalises the two
 * spellings this runtime supports).
 *
 * Symlinks are deliberately NOT resolved. `realpathSync` would touch the
 * filesystem, so the identity of an instance would depend on whether its
 * directory currently exists — and `approval setup` must be able to name the
 * item it is about to create before anything is on disk. Two paths that reach
 * one directory by different routes are therefore two identities; that is the
 * safe direction of the error (two names, no sharing) rather than the unsafe
 * one.
 *
 * ## What the names look like
 *
 * ```
 * approval-tg-token-3f2a9c11
 * approval-vault-passphrase-3f2a9c11
 * approval-sampling-secret-3f2a9c11
 * ```
 *
 * Eight hex digits: long enough that two instances on one machine will not
 * collide by accident, short enough that an operator reading
 * `keychain:approval-tg-token-3f2a9c11` in `.approval/env` and the same suffix
 * in `approval doctor` can compare them at a glance. The suffix is not a
 * secret and is not derived from one — it is a hash of a directory path, which
 * `.approval/env` already carries in the open.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";

import {
  NON_RESOLVING_RUNNER,
  envFilePathFor,
  resolveEnvironment,
  type ResolvedVariable,
} from "./env-file.js";
import type { PolicyLoadResult } from "./policy-load.js";

/**
 * The unscoped item names this project used before APRV-178.
 *
 * Kept, and kept named, for two reasons: an instance provisioned before the
 * change still has its token under one of them, and the migration path is to
 * READ them as a fallback and say so out loud, never to silently adopt them.
 */
export const LEGACY_SERVICE_TELEGRAM_TOKEN = "approval-tg-token";
export const LEGACY_SERVICE_VAULT_PASSPHRASE = "approval-vault-passphrase";
export const LEGACY_SERVICE_SAMPLING_SECRET = "approval-sampling-secret";

/** Every unscoped name, for the "is this the legacy one?" test. */
export const LEGACY_SERVICES: readonly string[] = [
  LEGACY_SERVICE_TELEGRAM_TOKEN,
  LEGACY_SERVICE_VAULT_PASSPHRASE,
  LEGACY_SERVICE_SAMPLING_SECRET,
];

/** How many hex digits of the digest a scoped name carries. */
export const INSTANCE_ID_LENGTH = 8;

/** A scoped name is a legacy base plus exactly that many hex digits. */
const SCOPED_SUFFIX = new RegExp(`^-[0-9a-f]{${String(INSTANCE_ID_LENGTH)}}$`, "u");

/**
 * The `.approval` directory this log path belongs to, absolute as given.
 *
 * `envFilePathFor` already answers "which instance is this log in", by walking
 * up out of `log/` when it is there; the env file's own directory IS the
 * instance home, so this is that answer with the filename removed rather than
 * a second rule that could disagree with it.
 */
export function instanceHomeFor(logPath: string): string {
  return dirname(envFilePathFor(logPath));
}

/** The instance's short identity: {@link INSTANCE_ID_LENGTH} hex digits. */
export function instanceIdFor(logPath: string): string {
  return createHash("sha256")
    .update(instanceHomeFor(logPath), "utf8")
    .digest("hex")
    .slice(0, INSTANCE_ID_LENGTH);
}

/** The keystore item name `base` takes in the instance owning `logPath`. */
export function scopedService(base: string, logPath: string): string {
  return `${base}-${instanceIdFor(logPath)}`;
}

/**
 * How a service name relates to the instance owning `logPath`.
 *
 * Answered from the NAME alone, with no keystore lookup: `approval doctor`
 * reports on this and a diagnostic may not pop a keychain-unlock prompt (see
 * `cli/doctor.ts`'s `NON_RESOLVING_RUNNER`). The name is enough, because the
 * name is what decides which item a lookup would find.
 *
 * - `mine` — the scoped name this instance writes.
 * - `legacy` — one of the unscoped pre-APRV-178 names, which every instance on
 *   the machine resolves to the same item.
 * - `other-instance` — a scoped name whose suffix is some other instance's.
 * - `unknown` — a name this runtime never wrote; the operator chose it, and
 *   nothing here can say whose it is.
 */
export type ServiceScope = "mine" | "legacy" | "other-instance" | "unknown";

export function scopeOfService(service: string, logPath: string): ServiceScope {
  for (const base of LEGACY_SERVICES) {
    if (service === base) return "legacy";
    if (service.startsWith(base)) {
      const suffix = service.slice(base.length);
      if (!SCOPED_SUFFIX.test(suffix)) continue;
      return suffix === `-${instanceIdFor(logPath)}` ? "mine" : "other-instance";
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * One way this instance's credentials can belong to somebody else.
 *
 * - `foreign-instance` — `.approval/env` names a keystore item whose scope
 *   suffix is another instance's. Two gates then hold one credential, which is
 *   the incident: one bot, two long pollers, and a human's tap consumed by the
 *   listener that did not ask the question. This is WRONG, not a state.
 * - `legacy-shared` — the file names one of the unscoped pre-APRV-178 items.
 *   Correct on a machine with one gate and a trap on a machine with two, so it
 *   is reported and not failed: it is what every existing installation looks
 *   like, and the repair is one re-run of `approval setup channel telegram`.
 * - `ambient-bleed` — the value came from the shell while the file names a
 *   source of its own. The shell wins on purpose (invariant 7); what was
 *   missing is anyone saying so. This is the half of the incident that survived
 *   fixing the file: the operator's rc exported the production token, so every
 *   fresh terminal kept using the production bot.
 */
export type InstanceFindingKind = "foreign-instance" | "legacy-shared" | "ambient-bleed";

export interface InstanceFinding {
  kind: InstanceFindingKind;
  /** The environment variable the finding is about. */
  variable: string;
  /** The item name, for the two name-shaped findings. */
  service?: string;
  /** One sentence, and never a value. */
  detail: string;
}

/**
 * What is wrong with WHOSE credentials this instance is using (APRV-178).
 *
 * Answered from names alone. No keystore is consulted ({@link
 * NON_RESOLVING_RUNNER}), so this may be called from `approval doctor` and from
 * `approval up`'s start-up without either of them blocking on an unlock dialog.
 * No value is read, compared or printed on any path: the inputs are a service
 * name, a scheme and a variable name, all of which `.approval/env` carries in
 * the open.
 *
 * A file this runtime cannot read at all produces no findings rather than a
 * guess; `approval env --check` and doctor's `environment` row are what report
 * an unreadable or wrong-moded file, and saying it twice in different words is
 * how two commands come to disagree.
 */
export function instanceFindings(
  logPath: string,
  load: PolicyLoadResult,
  ambientEnv: NodeJS.ProcessEnv = process.env,
): InstanceFinding[] {
  const resolved = resolveEnvironment(
    load,
    envFilePathFor(logPath),
    NON_RESOLVING_RUNNER,
    ambientEnv,
  );
  return resolved.ok ? findingsFor(logPath, resolved.variables) : [];
}

/** The name-only rules, over an already-resolved variable set. */
export function findingsFor(
  logPath: string,
  variables: readonly ResolvedVariable[],
): InstanceFinding[] {
  const home = instanceHomeFor(logPath);
  const findings: InstanceFinding[] = [];
  for (const variable of variables) {
    const source = variable.fileSource;
    if (source === undefined) continue;

    if (variable.status === "set-in-environment") {
      findings.push({
        kind: "ambient-bleed",
        variable: variable.name,
        detail: `${variable.name} is exported in this environment, so ${home}'s own line ${String(source.line)} was not consulted: the value in use is not the one this instance configured`,
      });
      continue;
    }

    const service = source.service;
    if (service === undefined) continue;
    const scope = scopeOfService(service, logPath);
    if (scope === "other-instance") {
      findings.push({
        kind: "foreign-instance",
        variable: variable.name,
        service,
        detail: `${variable.name} names ${service}, whose scope suffix is not this instance's (${instanceIdFor(logPath)}, ${home}): two gates on this machine are pointed at one credential`,
      });
    } else if (scope === "legacy") {
      findings.push({
        kind: "legacy-shared",
        variable: variable.name,
        service,
        detail: `${variable.name} names ${service}, the unscoped item name every gate on this machine resolves to the same value`,
      });
    }
  }
  return findings;
}
