/**
 * One transport per gate, enforced locally (APRV-424, review finding 1).
 *
 * `core/channel-owner.ts` answers "does another INSTANCE on this machine hold
 * this bot", keyed on the instance id, and `getWebhookInfo` answers "what is
 * the Bot API delivering this bot's updates to". Between those two answers
 * there was a hole, and it is the one this file closes: two processes started
 * in the SAME gate, one `approval up` long-polling and one `approval channel
 * telegram webhook`, pass both checks. The registry compares instance ids and
 * both processes are the same instance; `getWebhookInfo` is empty when the
 * poller is the one already running. Each then runs its own dispatch cycle
 * over its own `DispatchState` against one log, so every pending request
 * reaches the phone twice under two nonces and only one of the two copies can
 * resolve a tap.
 *
 * ## What the lease is
 *
 * A lockfile in the gate's own derived state directory:
 *
 * ```
 * <instance home>/.approval/daemon/telegram-transport.lock
 * ```
 *
 * `daemon/` because that is where this runtime already keeps per-gate runtime
 * state that a clone must not inherit (`core/live-draw.ts`'s socket lives
 * beside it, and `.gitignore` holds the whole directory). It carries the
 * holder's pid, which transport it is running, and when it started, and it is
 * created with `O_EXCL` so two processes racing cannot both believe they took
 * it.
 *
 * ## Per PROCESS, and validated for liveness
 *
 * The holder is a pid, so:
 *
 * - **A second process refuses.** It reads the holder, sees a live pid, and is
 *   told which transport is running and under which pid. The refusal is the
 *   whole point: a channel that ran both transports would deliver twice.
 * - **A dead holder is reclaimed.** A crash, a `kill -9`, a laptop that slept
 *   through a power cycle: the lockfile outlives the process, and refusing
 *   forever over a file nobody owns would be an outage with no fault behind
 *   it. `process.kill(pid, 0)` is the probe; `EPERM` counts as alive, because
 *   a pid that belongs to somebody else is still a pid in use.
 * - **The same pid is never in conflict with itself.** One process holds one
 *   transport, and the in-process half of that rule is
 *   `TelegramChannel.claimTransport`, which refuses a second claim on one
 *   channel object. A re-take by the holding pid rewrites the record rather
 *   than refusing, so a supervisor that restarts its own channel part inside
 *   one process (`approval up`) is not fighting its own lockfile.
 *
 * A recycled pid is the acknowledged limit: a long-dead holder whose number
 * has been reused by an unrelated program reads as alive, and the operator
 * gets a refusal naming a pid that is not a gate. That is the safe direction
 * of the error (a refusal an operator can clear by deleting a named file,
 * rather than two pollers on one log), and it is the same trade
 * `core/live-draw.ts` makes when it validates the answering daemon's pid.
 *
 * ## Why an I/O failure is a refusal
 *
 * Every other local record in this runtime is a cache whose absence is the
 * status quo (`channel-owner.ts` says so at length). This one is not: it is
 * the only thing standing between a gate and two live transports, so a
 * directory it cannot create or a file it cannot write is a state in which
 * exclusion cannot be promised, and the stricter path is to say so and stop.
 * The refusal names the path, which is a thing an operator can fix.
 *
 * Nothing here is evidence. It is never read by an enforcement path, it
 * widens no permission, and the only thing it can produce is a refusal to
 * start.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { instanceHomeFor } from "./instance.js";

/** The lockfile's basename inside the gate's `daemon/` directory. */
export const CHANNEL_LEASE_FILE = "telegram-transport.lock";

/** The only format version this build writes, and the only one it reads. */
export const CHANNEL_LEASE_VERSION = 1;

/** How many times a take retries around a torn or reclaimed lockfile. */
export const CHANNEL_LEASE_ATTEMPTS = 5;

/** How long a take waits before re-reading a lockfile it could not parse. */
export const CHANNEL_LEASE_RETRY_MS = 20;

/**
 * Which transport a holder is running.
 *
 * The same two words `TelegramChannel.claimTransport` uses, deliberately: one
 * vocabulary for "how do updates reach this gate", so a refusal here and a
 * refusal there name the same thing.
 */
export type ChannelLeaseMode = "poll" | "webhook";

/**
 * Why a lease could not be taken. Frozen, per SPEC.md §11.1 invariant 6.
 *
 * Two of the three name the transport that already holds the gate, because
 * that is what decides the repair: stop the poller, or stop the webhook runner
 * (which also removes the registration as it exits). The third is the state in
 * which no promise can be made at all.
 */
export const CHANNEL_LEASE_REFUSAL_CODES = [
  /** A long-poll listener (`approval channel telegram listen`, `approval up`) holds it. */
  "telegram-poller-running",
  /** A webhook runner holds it. Same code the Bot API probe uses, same repair. */
  "webhook-registered",
  /** The lockfile could not be created, read or written, so exclusion cannot be promised. */
  "telegram-lease-unavailable",
] as const;

export type ChannelLeaseRefusalCode = (typeof CHANNEL_LEASE_REFUSAL_CODES)[number];

/** What one lockfile says. */
export interface ChannelLeaseHolder {
  /** The holding process. Probed for liveness, never signalled. */
  pid: number;
  /** Which transport that process is running. */
  mode: ChannelLeaseMode;
  /** When it took the lease, ISO-8601. Reported to the operator, never compared. */
  startedAt: string;
  /** The gate it took the lease in, absolute. One gate, one lockfile. */
  instanceHome: string;
}

/** A lease this process holds. {@link ChannelLease.release} is idempotent. */
export interface ChannelLease {
  /** The lockfile, absolute. Named in every refusal so it can be cleared by hand. */
  readonly path: string;
  readonly mode: ChannelLeaseMode;
  readonly pid: number;
  /**
   * Give the gate back.
   *
   * Removes the lockfile only while it still names this process: a release
   * that deleted somebody else's record would hand the gate to a third
   * process while the second was still running, which is the state the lease
   * exists to rule out. Safe to call twice, and safe to call after the file
   * has been removed by hand.
   */
  release(): void;
}

export type ChannelLeaseOutcome =
  | {
      ok: true;
      lease: ChannelLease;
      /** The dead holder whose lockfile this take reclaimed, when there was one. */
      reclaimed: ChannelLeaseHolder | null;
    }
  | {
      ok: false;
      code: ChannelLeaseRefusalCode;
      /** The live holder, when one was read. Absent for an I/O refusal. */
      holder: ChannelLeaseHolder | null;
      message: string;
    };

export interface ChannelLeaseOptions {
  /** This process's pid. Injectable so a test can stand in for a second process. */
  pid?: number;
  /** The clock the `started_at` field is read from. */
  now?: () => Date;
  /**
   * Is `pid` a running process?
   *
   * Injectable for the same reason: a test that needs a STALE lockfile cannot
   * produce one with a real pid without killing something.
   */
  alive?: (pid: number) => boolean;
}

/** The gate's `daemon/` directory for `logPath`, derived and never configured. */
export function channelLeaseDirFor(logPath: string): string {
  return join(instanceHomeFor(resolve(logPath)), "daemon");
}

/** Where the Telegram transport lease for `logPath` lives. */
export function channelLeasePathFor(logPath: string): string {
  return join(channelLeaseDirFor(logPath), CHANNEL_LEASE_FILE);
}

/**
 * Is `pid` a running process?
 *
 * `ESRCH` is the only answer that means "gone". `EPERM` means it exists and
 * belongs to another user, which is still a pid in use, and anything else is
 * unexpected enough that treating the holder as live is the stricter reading.
 */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Synchronous sleep with no dependency and no busy-spin. `core/log.ts`'s. */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

type HolderRead =
  | { state: "absent" }
  /** The file exists and could not be read as a whole record. */
  | { state: "torn" }
  | { state: "held"; holder: ChannelLeaseHolder };

function parseHolder(raw: unknown): ChannelLeaseHolder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== CHANNEL_LEASE_VERSION) return null;
  const pid = record["pid"];
  const mode = record["mode"];
  const startedAt = record["started_at"];
  const instanceHome = record["instance_home"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (mode !== "poll" && mode !== "webhook") return null;
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;
  if (typeof instanceHome !== "string") return null;
  return { pid, mode, startedAt, instanceHome };
}

function readHolder(path: string): HolderRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "torn" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "torn" };
  }
  const holder = parseHolder(parsed);
  return holder === null ? { state: "torn" } : { state: "held", holder };
}

/**
 * {@link readHolder}, re-read while it comes back unreadable.
 *
 * A record this build cannot parse is either a lockfile a crash tore in half
 * or one a process is writing right now, and for as long as that write takes
 * the two look alike. So an unreadable file is re-read before it is judged,
 * and only one that stays unreadable is reported as torn.
 */
function readHolderSettled(path: string): HolderRead {
  let read = readHolder(path);
  for (let attempt = 1; read.state === "torn" && attempt < CHANNEL_LEASE_ATTEMPTS; attempt += 1) {
    sleepSync(CHANNEL_LEASE_RETRY_MS);
    read = readHolder(path);
  }
  return read;
}

/** What the lockfile for `logPath` currently says, or `null`. Diagnostics only. */
export function readChannelLease(logPath: string): ChannelLeaseHolder | null {
  const read = readHolder(channelLeasePathFor(logPath));
  return read.state === "held" ? read.holder : null;
}

/** The code a refusal takes, given which transport holds the gate. */
function codeFor(mode: ChannelLeaseMode): ChannelLeaseRefusalCode {
  return mode === "webhook" ? "webhook-registered" : "telegram-poller-running";
}

function refusalMessage(
  holder: ChannelLeaseHolder,
  wanted: ChannelLeaseMode,
  path: string,
): string {
  const held =
    holder.mode === "webhook"
      ? `a webhook runner (\`approval channel telegram webhook\`) is already receiving this gate's telegram updates`
      : `a long-poll listener (\`approval channel telegram listen\` or \`approval up\`) is already receiving this gate's telegram updates`;
  const same = holder.mode === wanted;
  const why = same
    ? "Two of them on one log both put every pending request on the phone, each under its own nonce, and only the copy whose process holds the delivery can resolve a tap"
    : "Long polling and a webhook are alternatives per bot: both processes would put every pending request on the phone under their own nonce, only one of the two copies could resolve a tap, and the Bot API refuses getUpdates outright while a webhook is set";
  return `${held} in ${holder.mode} mode, as pid ${String(holder.pid)}, since ${holder.startedAt}. ${why}. Stop that process (a clean stop removes its lease, and a webhook runner removes its registration as it exits), or give this instance its own bot with \`approval setup channel telegram\`. The lease is ${path}; a lease whose process is gone is reclaimed automatically, so deleting it by hand is only for a pid that no longer names a gate`;
}

/**
 * Take the gate's Telegram transport lease in `mode`, or say who holds it.
 *
 * Synchronous, like every other lockfile in this runtime: the take happens
 * once per process before anything is delivered, and a caller that had to
 * await it would be a caller that could interleave two takes in one process.
 */
export function takeChannelLease(
  logPath: string,
  mode: ChannelLeaseMode,
  options: ChannelLeaseOptions = {},
): ChannelLeaseOutcome {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? ((): Date => new Date());
  const alive = options.alive ?? pidIsAlive;
  const path = channelLeasePathFor(logPath);
  const instanceHome = instanceHomeFor(resolve(logPath));

  const unavailable = (detail: string): ChannelLeaseOutcome => ({
    ok: false,
    code: "telegram-lease-unavailable",
    holder: null,
    message: `the telegram transport lease ${path} could not be taken (${detail}). This lease is the only thing that keeps one gate from running a poller and a webhook at once, so a gate that cannot hold one does not start: make that directory writable, or point --log at the instance this process is meant to serve`,
  });

  try {
    mkdirSync(channelLeaseDirFor(logPath), { recursive: true, mode: 0o700 });
  } catch (cause) {
    return unavailable(cause instanceof Error ? cause.message : String(cause));
  }

  let reclaimed: ChannelLeaseHolder | null = null;
  for (let attempt = 0; attempt < CHANNEL_LEASE_ATTEMPTS; attempt += 1) {
    const body = `${JSON.stringify(
      {
        version: CHANNEL_LEASE_VERSION,
        pid,
        mode,
        started_at: now().toISOString(),
        instance_home: instanceHome,
      },
      null,
      2,
    )}\n`;

    let created = false;
    try {
      const handle = openSync(path, "wx", 0o600);
      try {
        writeFileSync(handle, body, { encoding: "utf8" });
      } finally {
        closeSync(handle);
      }
      created = true;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return unavailable(cause instanceof Error ? cause.message : String(cause));
      }
    }
    if (created) return { ok: true, lease: leaseFor(path, mode, pid), reclaimed };

    const read = readHolderSettled(path);
    if (read.state === "absent") continue;
    if (read.state === "torn") {
      // Unreadable after {@link CHANNEL_LEASE_ATTEMPTS} reads: nobody is
      // finishing a write, so this is a lockfile a crash left behind and
      // refusing forever over bytes nobody can read would be an outage with no
      // fault behind it.
      try {
        unlinkSync(path);
      } catch (cause) {
        return unavailable(`an unreadable lease could not be removed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`);
      }
      continue;
    }

    const { holder } = read;
    if (holder.pid === pid) {
      // This process already holds the gate. One process runs one transport,
      // and the in-process guard against two is `claimTransport`; rewriting
      // the record keeps it true rather than making a supervisor fight its own
      // lockfile across a restart of its channel part.
      try {
        writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
      } catch (cause) {
        return unavailable(cause instanceof Error ? cause.message : String(cause));
      }
      return { ok: true, lease: leaseFor(path, mode, pid), reclaimed };
    }
    if (alive(holder.pid)) {
      return {
        ok: false,
        code: codeFor(holder.mode),
        holder,
        message: refusalMessage(holder, mode, path),
      };
    }

    // The holder is gone. Reclaimed rather than refused, and reported to the
    // caller so the operator reads that a dead lease was cleared instead of
    // wondering why a file appeared.
    reclaimed = holder;
    try {
      unlinkSync(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        return unavailable(`a stale lease could not be removed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`);
      }
    }
  }

  return unavailable(
    `${String(CHANNEL_LEASE_ATTEMPTS)} attempts raced another process taking and releasing it`,
  );
}

function leaseFor(path: string, mode: ChannelLeaseMode, pid: number): ChannelLease {
  let released = false;
  return {
    path,
    mode,
    pid,
    release: (): void => {
      if (released) return;
      released = true;
      const read = readHolder(path);
      if (read.state !== "held" || read.holder.pid !== pid) return;
      try {
        unlinkSync(path);
      } catch {
        /* advisory: a lease that could not be removed is reclaimed by the next taker's liveness probe */
      }
    },
  };
}
