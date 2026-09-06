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
// Export provenance (APRV-278)
// ---------------------------------------------------------------------------

/**
 * The variable `approval env`'s export block uses to say what it exported.
 *
 * ## The bug this exists to close
 *
 * The bleed rule below reads no values, on purpose: it runs inside `approval
 * doctor` and `approval up`, neither of which may pop a keystore-unlock dialog
 * to produce a diagnostic (`NON_RESOLVING_RUNNER`). So it saw "this variable is
 * exported, and the file has a line for it" and reported that the value in use
 * was not the one the instance configured. It could not know that. The
 * documented start ritual is
 *
 * ```sh
 * eval "$(approval env)"
 * ```
 *
 * which exports THIS instance's own values from THIS instance's own file, and
 * leaves behind exactly the state the rule was calling an incident: exported,
 * with a file line naming a source. Observed on 2026-09-06 in the primary,
 * where `unset APPROVAL_SAMPLING_SECRET && eval "$(approval env)" && approval
 * up` printed the finding for the variable the eval had just resolved from the
 * gate's own keychain item. A check that asserts a fact it never tested is
 * worse than no check: it teaches the operator to skip the line.
 *
 * ## What is exported, and why it is value-free
 *
 * ```
 * APPROVAL_ENV_PROVENANCE=1:3f2a9c11:<64 hex>:APPROVAL_TG_TOKEN,APPROVAL_TG_CHAT
 *                         │ │        │        └ the NAMES it exported from the file
 *                         │ │        └ sha256 of the env file bytes it read
 *                         │ └ the instance whose file that was
 *                         └ the format version
 * ```
 *
 * Four colon-separated fields; the names are shell variable names, which cannot
 * contain a colon or a comma, so the shape needs no escaping. Every field is a
 * NAME, an id or a digest: the same three kinds of thing `.approval/env` already
 * carries in the open, and none of them is a value. The rule stays as value-free
 * after this change as it was before it, which is the point — a check that had
 * to read the secret to decide whether to complain about the secret would be a
 * worse trade than the false positive.
 *
 * ## What it does NOT weaken
 *
 * Invariant 7 (no verb loads `.approval/env` implicitly) is untouched: this
 * variable reaches a shell only when a human evaluates `approval env`'s output,
 * exactly like every other line in that block, and no verb gains the ability to
 * read the file for its values. And it cannot launder a foreign export, because
 * `approval env` lists only the names it resolved FROM THE FILE. A value that
 * was already in the environment is re-exported by that block for fidelity, and
 * deliberately left out of this list, so a bled variable stays reported however
 * many times the ritual is run over it.
 *
 * Trusting the variable is safe in the only direction that matters. Anything
 * able to set it in this process's environment could already set the credential
 * variables themselves, so it buys an attacker nothing; and being wrong here
 * silences a WARNING rather than opening a gate. The reverse default — believing
 * the exported value is foreign — is the bug being fixed.
 */
export const ENV_PROVENANCE_VAR = "APPROVAL_ENV_PROVENANCE";

/** The only format version this build writes, and the only one it reads. */
export const ENV_PROVENANCE_VERSION = "1";

const PROVENANCE_INSTANCE_ID = new RegExp(`^[0-9a-f]{${String(INSTANCE_ID_LENGTH)}}$`, "u");
const PROVENANCE_DIGEST = /^[0-9a-f]{64}$/u;
const PROVENANCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** What one `approval env` export block claims about itself. */
export interface EnvProvenance {
  /** The instance whose env file it resolved from. */
  instanceId: string;
  /** `envFileDigest` of the bytes it resolved from (`core/env-file.ts`). */
  digest: string;
  /** The names it exported FROM that file. Never the ones it passed through. */
  names: ReadonlySet<string>;
}

/**
 * The value for {@link ENV_PROVENANCE_VAR}, for an export block that resolved
 * `names` out of the file `digest` identifies.
 */
export function formatEnvProvenance(
  logPath: string,
  digest: string,
  names: readonly string[],
): string {
  return [ENV_PROVENANCE_VERSION, instanceIdFor(logPath), digest, [...names].join(",")].join(":");
}

/**
 * Read the claim back, or `null` for anything this build does not recognise.
 *
 * Strict on every field, and `null` rather than a partial answer: a malformed
 * claim is an unverified one, an unverified one earns no credit, and no credit
 * means the finding is still reported. That is the fail-closed direction (the
 * check stays loud) for a value whose whole job is to make the check quieter.
 */
export function parseEnvProvenance(raw: string | undefined): EnvProvenance | null {
  if (raw === undefined) return null;
  const fields = raw.split(":");
  if (fields.length !== 4) return null;
  const [version, instanceId, digest, joined] = fields as [string, string, string, string];
  if (version !== ENV_PROVENANCE_VERSION) return null;
  if (!PROVENANCE_INSTANCE_ID.test(instanceId)) return null;
  if (!PROVENANCE_DIGEST.test(digest)) return null;
  const names = joined.length === 0 ? [] : joined.split(",");
  if (names.some((name) => !PROVENANCE_NAME.test(name))) return null;
  return { instanceId, digest, names: new Set(names) };
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
 * - `ambient-bleed` — the value was exported before this process started, the
 *   file names a source of its own, and the export is NOT one this instance's
 *   `approval env` made (see {@link ENV_PROVENANCE_VAR}). The shell wins on
 *   purpose (invariant 7); what was missing is anyone saying so. This is the
 *   half of the incident that survived fixing the file: the operator's rc
 *   exported the production token, so every fresh terminal kept using the
 *   production bot.
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
 * name, a scheme, a variable name, and (since APRV-278) an instance id, a file
 * digest and a list of variable names out of {@link ENV_PROVENANCE_VAR} — all of
 * which `.approval/env` and `approval env --check` carry in the open. The
 * exported VALUES this reports on are still never read, compared or printed.
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
  return resolved.ok
    ? findingsFor(logPath, resolved.variables, {
        ambientEnv,
        // The digest of the file THIS call read, which is what the provenance
        // claim is checked against: an env file edited since the operator's
        // `eval` earns no credit for the export it no longer describes.
        envFileDigest: resolved.digest,
      })
    : [];
}

/**
 * What the rule may consult beyond the names (APRV-278).
 *
 * Both fields are optional and an absent one only ever makes the report LOUDER:
 * a caller that supplies neither gets the pre-APRV-278 behaviour, where every
 * exported variable with a file line is reported.
 */
export interface FindingsContext {
  /** The environment the report is about. Read for {@link ENV_PROVENANCE_VAR}. */
  ambientEnv?: NodeJS.ProcessEnv;
  /** `envFileDigest` of this instance's env file as it now reads. */
  envFileDigest?: string;
}

/** How far {@link ENV_PROVENANCE_VAR} can be trusted for this instance. */
interface ProvenanceView {
  /** It names this instance's id. */
  claimsThisInstance: boolean;
  /** ...and the digest of the file as it now reads. */
  claimsThisFile: boolean;
  /** The names it claims, whether or not the two above hold. */
  names: ReadonlySet<string>;
}

function provenanceView(logPath: string, context: FindingsContext): ProvenanceView {
  const claim = parseEnvProvenance(context.ambientEnv?.[ENV_PROVENANCE_VAR]);
  if (claim === null) {
    return { claimsThisInstance: false, claimsThisFile: false, names: new Set<string>() };
  }
  const claimsThisInstance = claim.instanceId === instanceIdFor(logPath);
  return {
    claimsThisInstance,
    // An unknown digest is not a match: the rule may only vouch for what it has
    // verified, and "the caller did not tell me" is not verification.
    claimsThisFile:
      claimsThisInstance &&
      context.envFileDigest !== undefined &&
      claim.digest === context.envFileDigest,
    names: claim.names,
  };
}

/**
 * The exported names this instance's OWN current `approval env` vouches for
 * (APRV-278).
 *
 * Empty unless {@link ENV_PROVENANCE_VAR} parses, names this instance, and
 * matches the env file as it now reads. `approval env --check` and the finding
 * rule below both answer "is this export the documented ritual's?" from this one
 * function, because two spellings of that question are two chances for `approval
 * env --check` and `approval up` to say different things about one shell.
 */
export function ownEnvExports(
  logPath: string,
  context: FindingsContext = {},
): ReadonlySet<string> {
  const view = provenanceView(logPath, context);
  return view.claimsThisFile ? view.names : new Set<string>();
}

/** The name-only rules, over an already-resolved variable set. */
export function findingsFor(
  logPath: string,
  variables: readonly ResolvedVariable[],
  context: FindingsContext = {},
): InstanceFinding[] {
  const home = instanceHomeFor(logPath);
  const { claimsThisInstance, claimsThisFile, names } = provenanceView(logPath, context);

  const findings: InstanceFinding[] = [];
  for (const variable of variables) {
    const source = variable.fileSource;
    if (source === undefined) continue;

    if (variable.status === "set-in-environment") {
      const claimed = names.has(variable.name);
      // The documented ritual: this instance's own `approval env`, run against
      // the file as it now reads, exported this name out of it. The exported
      // value IS the one the file configures, so there is nothing to report.
      if (claimsThisFile && claimed) continue;
      findings.push({
        kind: "ambient-bleed",
        variable: variable.name,
        detail:
          claimsThisInstance && claimed
            ? // This instance's own export, but of some other version of the
              // file. Which version is not knowable from here, so the finding
              // says only that, and does not claim the value is a stranger's.
              `${variable.name} was exported by an \`approval env\` run this process cannot match to ${home}'s env file as it now reads, so line ${String(source.line)} as it now reads was not consulted`
            : `${variable.name} was exported before this process started and is not this instance's own \`approval env\` export; line ${String(source.line)} of ${home}'s env file was not consulted`,
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
