/**
 * Which instance owns which bot (APRV-390).
 *
 * APRV-178 scoped the OS keystore's ITEM NAMES to an instance, which closed the
 * half of the incident where two gates read one item. It did not close the
 * other half: two instances can still be handed the same bot token under two
 * perfectly distinct names. `core/instance.ts` answers its questions from names
 * alone, on purpose, and a name cannot tell you that two different names hold
 * one value.
 *
 * Observed again on 2026-09-19: the primary daemon and the demo gate in
 * `~/demo-gate` both long-polled one bot, both printed `getUpdates` HTTP 409
 * Conflict on every poll, and neither phone channel worked. The only thing that
 * distinguishes those two processes is what the Bot API says the token IS, and
 * the only call that asks is `getMe`. So this module records `getMe`'s answer
 * and makes the second claim on one bot a refusal instead of a 409.
 *
 * ## The two records
 *
 * ```
 * <instance>/.approval/channel-owner.json     one instance's own bots
 * <state dir>/approval/bots.json              every instance's claims, per machine
 * ```
 *
 * The per-instance file is this instance's copy of what it probed, gitignored
 * and rebuildable by one `getMe`. The registry is the part that has to be
 * SHARED, because the question is "does anything else on this machine hold this
 * bot", and no file inside one instance can answer that.
 *
 * ## Why the registry is a plain file, and why it is not under `.approval`
 *
 * **Not the OS keystore.** Every reader of this registry is a diagnostic or a
 * start-up preflight, and neither may block on an unlock dialog — that is
 * `NON_RESOLVING_RUNNER`'s rule in `core/env-file.ts`, and `approval doctor`
 * already answers the whole keychain-scope row from names for exactly this
 * reason. A machine with no keystore backend at all still needs this refusal,
 * and would get nothing from a store it does not have. And there is no secret
 * here to justify one: a bot id, a `@username`, an instance id and a directory
 * path are all things `.approval/env` carries in the open.
 *
 * **Not a `.approval` directory under the home directory**, which was the other
 * candidate. This project's own policy reserves anything under `.approval/` to
 * the human's ceremony (`policy.core`, human-only), and the hook classifier
 * applies that to the name wherever it appears. A file the runtime rewrites on
 * every listener start does not belong in the directory the policy holds shut.
 *
 * So it goes where this runtime already puts per-user state that is derived
 * rather than evidence: the same platform split `cli/setup-service.ts` uses for
 * a service's console output. {@link APPROVAL_STATE_DIR_ENV} overrides it, which
 * is what the test suite sets — a suite that wrote the operator's real registry
 * would be the mistake the Muse probe's suite made with its live pointer.
 *
 * ## What it is not
 *
 * Not evidence, and never consulted by an enforcement path. Nothing in here
 * widens a permission, and losing the whole file costs one re-probe. It answers
 * one question — "is another instance on this machine already polling this
 * bot?" — and that answer only ever produces a REFUSAL. A registry that could
 * be edited into granting something would be a policy file; this one can be
 * edited into letting a 409 happen, which is the state without it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { instanceHomeFor, instanceIdFor } from "./instance.js";

/** The per-instance record's filename, inside `.approval/`. Gitignored. */
export const CHANNEL_OWNER_FILE = "channel-owner.json";

/** The per-machine registry's filename, inside the state directory. */
export const BOT_REGISTRY_FILE = "bots.json";

/**
 * Where the per-machine registry lives, overriding the platform default.
 *
 * Set by the test suite, and available to an operator running two gates under
 * one account who wants them in separate state trees. An empty or unset value
 * means the platform default.
 */
export const APPROVAL_STATE_DIR_ENV = "APPROVAL_STATE_DIR";

/** The only format version this build writes, and the only one it reads. */
export const CHANNEL_OWNER_VERSION = 1;

/**
 * The channels this registry knows about.
 *
 * One entry today. It is a union rather than a bare string because the registry
 * is per-machine and long-lived: a second channel with a bot-like identity
 * (APRV-383's hosted daemon id is the named candidate) has to be able to land
 * beside Telegram's rows without either one's reader guessing what a row means.
 */
export type OwnedChannel = "telegram";

/** What one `getMe` said, reduced to the fields that identify a bot. */
export interface BotIdentity {
  channel: OwnedChannel;
  /** The Bot API's own numeric id, as a string. Stable for the life of a bot. */
  botId: string;
  /** `@name`, for the human reading the refusal. Never matched on. */
  username: string;
  /**
   * The Bot API deployment that issued `botId`, normalised.
   *
   * Part of the identity rather than a note beside it: a bot id is unique
   * within one Bot API, and nothing more. Two gates pointed at two different
   * API bases — a self-hosted Bot API server and Telegram's own, or two local
   * ones — hold two different bots however their ids compare, and refusing the
   * second would be refusing a configuration that cannot conflict. Both of the
   * gates in the incident this task is named after used the default base, so
   * this narrows nothing that mattered there.
   */
  apiBase: string;
}

/**
 * One Bot API base, reduced so two spellings of one deployment compare equal.
 *
 * Lowercased and stripped of trailing slashes, which are the two ways the same
 * base is written. Nothing more is attempted: a host that resolves to the same
 * server under two names is two names here, and that is the safe direction of
 * the error — two identities, so the second gate is allowed to start, exactly
 * as it was before this module existed.
 */
export function normaliseApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/u, "").toLowerCase();
}

/** One instance's claim on one bot. */
export interface BotClaim extends BotIdentity {
  /** The claiming instance's short id, as `approval doctor` prints it. */
  instanceId: string;
  /** That instance's `.approval` directory, absolute. */
  instanceHome: string;
  /** When the claim was made or last re-proved, ISO-8601. */
  claimedAt: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The per-user state directory for this runtime.
 *
 * The split is `cli/setup-service.ts`'s `defaultLogsDir`, one level up: macOS
 * keeps user application state under `Library/Application Support` and Linux
 * under `.local/state` (XDG's state home, which is where "state that should
 * persist between restarts but is not config and is not a cache" belongs).
 */
export function stateDirFor(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[APPROVAL_STATE_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "approval");
  }
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "approval");
}

/** The per-machine registry's path. */
export function registryPathFor(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirFor(env), BOT_REGISTRY_FILE);
}

/** The per-instance record's path, for the instance owning `logPath`. */
export function ownerPathFor(logPath: string): string {
  return join(instanceHomeFor(logPath), CHANNEL_OWNER_FILE);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse one claim, or `null`.
 *
 * Strict field by field, and `null` for anything short of complete: a
 * half-readable claim is one this build cannot say whose bot it names, and the
 * safe direction for THAT is to forget it (the preflight then re-probes and
 * re-claims) rather than to refuse a start-up over a row nobody can read.
 */
function parseClaim(raw: unknown): BotClaim | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const channel = record["channel"];
  const botId = record["bot_id"];
  const username = record["username"];
  const apiBase = record["api_base"];
  const instanceId = record["instance_id"];
  const instanceHome = record["instance_home"];
  const claimedAt = record["claimed_at"];
  if (channel !== "telegram") return null;
  if (typeof botId !== "string" || botId.length === 0) return null;
  if (typeof username !== "string") return null;
  if (typeof apiBase !== "string" || apiBase.length === 0) return null;
  if (typeof instanceId !== "string" || instanceId.length === 0) return null;
  if (typeof instanceHome !== "string" || instanceHome.length === 0) return null;
  if (typeof claimedAt !== "string") return null;
  return { channel, botId, username, apiBase, instanceId, instanceHome, claimedAt };
}

function serialiseClaim(claim: BotClaim): Record<string, unknown> {
  return {
    channel: claim.channel,
    bot_id: claim.botId,
    username: claim.username,
    api_base: claim.apiBase,
    instance_id: claim.instanceId,
    instance_home: claim.instanceHome,
    claimed_at: claim.claimedAt,
  };
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Every claim recorded on this machine, newest write last.
 *
 * An unreadable, absent or malformed registry is an EMPTY one. It is a cache of
 * probes, so "I do not know of any claim" is the honest answer and it costs one
 * `getMe` to rebuild — whereas failing a listener start-up because a JSON file
 * in a state directory got truncated would take the phone channel down for a
 * reason that has nothing to do with the gate.
 */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): BotClaim[] {
  const parsed = readJson(registryPathFor(env));
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== CHANNEL_OWNER_VERSION) return [];
  const claims = record["claims"];
  if (!Array.isArray(claims)) return [];
  return claims
    .map((entry) => parseClaim(entry))
    .filter((claim): claim is BotClaim => claim !== null);
}

/** What this instance last recorded about its own channels. */
export function readOwner(logPath: string): BotClaim[] {
  const parsed = readJson(ownerPathFor(logPath));
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== CHANNEL_OWNER_VERSION) return [];
  const claims = record["claims"];
  if (!Array.isArray(claims)) return [];
  return claims
    .map((entry) => parseClaim(entry))
    .filter((claim): claim is BotClaim => claim !== null);
}

/**
 * The claim this instance holds on `channel`, or `null`.
 *
 * Read from the per-instance file, which is what `approval channel telegram
 * health` and `approval doctor` report from: both are offline, and both must
 * answer without a network call or a keystore lookup.
 */
export function ownedBot(logPath: string, channel: OwnedChannel): BotClaim | null {
  return readOwner(logPath).find((claim) => claim.channel === channel) ?? null;
}

/**
 * Every OTHER instance on this machine that has claimed `botId`.
 *
 * "Other" is decided by instance id, so a re-run in the same instance is never
 * reported against itself, and two directories that reach one gate by different
 * spellings are two instances — which is `core/instance.ts`'s deliberate choice
 * of the safe error direction, and this module inherits it rather than adding a
 * second rule that could disagree.
 */
export function otherOwnersOf(
  logPath: string,
  botId: string,
  apiBase: string,
  env: NodeJS.ProcessEnv = process.env,
): BotClaim[] {
  const mine = instanceIdFor(logPath);
  const base = normaliseApiBase(apiBase);
  return readRegistry(env).filter(
    (claim) =>
      claim.botId === botId && normaliseApiBase(claim.apiBase) === base && claim.instanceId !== mine,
  );
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Why a claim was refused. Machine-readable and distinct (SPEC §11.1 inv. 6). */
export type ClaimRefusalCode = "bot-owned-elsewhere";

export type ClaimResult =
  | { ok: true; claim: BotClaim }
  | { ok: false; code: ClaimRefusalCode; owners: BotClaim[]; message: string };

/**
 * One sentence naming who else holds this bot, for a refusal or a 409 report.
 *
 * Exported because three surfaces print it — the listener preflight, `approval
 * setup channel telegram`, and the runtime 409 report — and three spellings of
 * "another instance owns this bot" is three chances for them to name different
 * instances for one fact.
 */
export function describeOwners(owners: readonly BotClaim[]): string {
  return owners
    .map((claim) => `${claim.instanceHome} (instance ${claim.instanceId})`)
    .join(" and ");
}

/**
 * Record this instance as `identity`'s owner, unless somebody else already is.
 *
 * Read-then-write rather than compare-and-append: this is a local cache of
 * probes and not the log, so the property it needs is "two instances racing
 * both see a refusal or one of them wins", which a same-machine read-then-write
 * over a file rewritten in whole gives. It is deliberately NOT passed through
 * the log's append path — nothing here is evidence, and putting a re-probe on
 * every listener start into the hash chain would be writing a heartbeat into
 * the record the project's whole argument says must stay small and meaningful.
 *
 * The refusal names the other instance, because "this bot is taken" without
 * saying by what is a message that sends an operator looking through `ps`.
 */
export function claimBot(
  logPath: string,
  identity: BotIdentity,
  options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): ClaimResult {
  const env = options.env ?? process.env;
  const now = options.now ?? ((): Date => new Date());
  const instanceId = instanceIdFor(logPath);
  const instanceHome = instanceHomeFor(logPath);

  const registry = readRegistry(env);
  const base = normaliseApiBase(identity.apiBase);
  const owners = registry.filter(
    (claim) =>
      claim.botId === identity.botId &&
      normaliseApiBase(claim.apiBase) === base &&
      claim.instanceId !== instanceId,
  );
  if (owners.length > 0) {
    return {
      ok: false,
      code: "bot-owned-elsewhere",
      owners,
      message: `${identity.username} (bot id ${identity.botId}) is already recorded on this machine as ${describeOwners(owners)}, and this instance is ${instanceHome} (instance ${instanceId}). Two gates polling one bot is the HTTP 409 loop: their getUpdates offsets acknowledge each other's updates and an approval tap is answered by whichever listener asked first. Give this instance its own bot from @BotFather, or retire the other instance`,
    };
  }

  const claim: BotClaim = {
    ...identity,
    apiBase: base,
    instanceId,
    instanceHome,
    claimedAt: now().toISOString(),
  };

  // This instance's rows for this channel are replaced, never appended to: an
  // instance pointed at a new bot owns the new one and stops owning the old,
  // and a registry that accumulated every bot an instance ever had would refuse
  // a bot the operator deliberately moved between two gates.
  const kept = registry.filter(
    (entry) => !(entry.instanceId === instanceId && entry.channel === identity.channel),
  );
  writeRegistry([...kept, claim], env);
  writeOwner(logPath, claim);
  return { ok: true, claim };
}

/**
 * Drop this instance's claim on `channel`, from both records.
 *
 * Used by nothing on the happy path. It exists because the alternative to a way
 * out is an operator hand-editing a JSON file in a state directory to recover
 * from a stale claim, and a recovery step that is not a command is a recovery
 * step that gets done wrong.
 */
export function releaseBot(
  logPath: string,
  channel: OwnedChannel,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const instanceId = instanceIdFor(logPath);
  writeRegistry(
    readRegistry(env).filter(
      (claim) => !(claim.instanceId === instanceId && claim.channel === channel),
    ),
    env,
  );
  writeOwnerClaims(
    logPath,
    readOwner(logPath).filter((claim) => claim.channel !== channel),
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write `path` by rename, so a reader never sees half a file.
 *
 * A best-effort write: a state directory that cannot be created (a read-only
 * home, a container with no writable state tree) leaves the runtime exactly
 * where it was before this module existed, which is a machine that can still
 * get a 409. Failing a listener start-up over it would trade a recoverable
 * conflict for an unrecoverable one.
 */
function writeAtomic(path: string, body: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    /* see the doc above: the registry is a cache, and its absence is the status quo ante */
  }
}

function writeRegistry(claims: readonly BotClaim[], env: NodeJS.ProcessEnv): void {
  const body = `${JSON.stringify(
    { version: CHANNEL_OWNER_VERSION, claims: claims.map((claim) => serialiseClaim(claim)) },
    null,
    2,
  )}\n`;
  writeAtomic(registryPathFor(env), body);
}

function writeOwnerClaims(logPath: string, claims: readonly BotClaim[]): void {
  const body = `${JSON.stringify(
    { version: CHANNEL_OWNER_VERSION, claims: claims.map((claim) => serialiseClaim(claim)) },
    null,
    2,
  )}\n`;
  writeAtomic(ownerPathFor(logPath), body);
}

/** Record one claim in this instance's own file, replacing its channel's row. */
function writeOwner(logPath: string, claim: BotClaim): void {
  const kept = readOwner(logPath).filter((entry) => entry.channel !== claim.channel);
  writeOwnerClaims(logPath, [...kept, claim]);
}
