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

import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 * The sibling file that serializes TAKE-OVERS of an existing lockfile.
 *
 * The lease itself is taken with `O_EXCL`, which settles the ordinary race by
 * itself: exactly one of two processes creating a file that is not there wins.
 * Reclaiming a lockfile that IS there cannot be settled that way, and the
 * first version of this module proved it. Two processes both read the same
 * dead holder, the first unlinked it and created its own live lease, and the
 * second, resuming inside its own read-then-unlink, deleted that live lease
 * and created its own. Both then believed they held the gate, which is the
 * exact state this file exists to rule out.
 *
 * So a take-over happens inside a critical section of its own, entered with
 * the same `O_EXCL` primitive, and what happens inside it is a re-read: the
 * record must still be the very one that was judged dead (same pid, same
 * `started_at`) or the take-over is abandoned. The loser of that race finds a
 * LIVE record on its next pass and refuses, which is the right answer.
 */
export const CHANNEL_LEASE_RECLAIM_SUFFIX = ".reclaim";

/**
 * How old a reclaim lock has to be before it is treated as abandoned.
 *
 * The critical section is a handful of syscalls, so a reclaim lock that is
 * seconds old belongs to a process that died inside it. Without this a single
 * crash in the wrong microsecond would wedge the gate for good, which is the
 * failure the whole liveness half of this module exists to avoid.
 */
export const CHANNEL_LEASE_RECLAIM_STALE_MS = 5_000;

/**
 * How much later than the lease a process may have started and still be its
 * holder.
 *
 * `started_at` is written just after the holder is running, so the holder's
 * own start time is at or before it. A pid whose process started AFTER the
 * lease was written is a pid the operating system handed to somebody else,
 * which is the case this tolerance exists to detect rather than to forgive.
 * The slack covers the coarse clock the fallback probe reports (`ps -o
 * lstart=` has one-second resolution) and small clock adjustments.
 */
export const CHANNEL_LEASE_START_TOLERANCE_MS = 2_000;

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
      /** The holder whose lockfile this take reclaimed, when there was one. */
      reclaimed: ChannelLeaseHolder | null;
      /**
       * Why that holder stopped being one.
       *
       * Carried beside the record rather than folded into it, because two
       * callers act on it: the operator's line says which of the three
       * happened, and `claimListenerBot` reads "a webhook runner in THIS gate
       * died" as the evidence that lets a restart re-register its own url
       * without `--reclaim` (APRV-424 review 2, finding 4).
       */
      reclaimedBecause: ChannelLeaseReclaimReason | null;
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
   * The coarse knob, and injectable for the same reason: a test that needs a
   * STALE lockfile cannot produce one with a real pid without killing
   * something. When it is given it DECIDES, so a test that wants the reuse and
   * foreign-owner questions asked passes {@link probe} instead.
   */
  alive?: (pid: number) => boolean;
  /**
   * The full pid probe: does it exist, can this process signal it, and when
   * did it start.
   *
   * Defaults to {@link probePid}. Injectable so the reused-pid and
   * foreign-owner judgements can be driven without arranging for the operating
   * system to hand out a particular number.
   */
  probe?: (pid: number) => PidProbe;
  /**
   * Run between judging a holder dead and taking its lockfile over.
   *
   * A seam, and it exists for one reason: the interleaving that made this
   * take-over a critical section can only be reproduced by letting a second
   * take run in the gap. A test plants a dead lease, starts one take, and runs
   * the whole of another from inside this callback; exactly one of the two
   * must come out holding the gate. Nothing in the runtime passes it.
   */
  beforeTakeOver?: () => void;
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
 * What a pid probe found.
 *
 * Three facts rather than one boolean, because "there is a process with that
 * number" is not the question. The question is whether that process is the one
 * that wrote this lease, and a pid on its own cannot answer it: pids are
 * reused, and a number that belonged to a webhook runner this morning can
 * belong to a text editor this afternoon.
 */
export interface PidProbe {
  /** Does a process with this number exist at all? */
  running: boolean;
  /**
   * Does it exist but belong to somebody this process cannot signal (`EPERM`)?
   *
   * Treated as NOT ours rather than as a live holder. A lease in this gate is
   * written by a process launched the way this one was, so a pid owned by
   * another user is a recycled number far more often than it is the holder;
   * and the alternative reading wedges the gate until a human deletes a file,
   * which is the outage this module is meant to prevent rather than cause.
   */
  foreign: boolean;
  /** When that process started, when the platform will say. */
  startedAt: Date | null;
}

/**
 * When the process with this pid started, or `null` when it cannot be learned.
 *
 * Two sources, in order of cost. On Linux `/proc/<pid>` is created with the
 * process and carries its start time, which needs no subprocess. Everywhere
 * else `ps -o lstart=` answers the same question; it costs one short-lived
 * child, paid once per lease take (which happens once per process start), and
 * a `ps` that is missing, slow or unhelpful returns `null` rather than
 * failing.
 *
 * `null` is the fail-CLOSED direction here: a holder whose start time cannot
 * be compared is judged by its pid alone, exactly as before this probe
 * existed, and a live pid then still refuses.
 */
export function processStartedAt(pid: number): Date | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return statSync(`/proc/${String(pid)}`).mtime;
    } catch {
      return null;
    }
  }
  try {
    const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    if (run.status !== 0) return null;
    const text = (run.stdout ?? "").trim();
    if (text.length === 0) return null;
    const when = new Date(text);
    return Number.isNaN(when.getTime()) ? null : when;
  } catch {
    return null;
  }
}

/** Ask the operating system about one pid. The default {@link ChannelLeaseOptions.probe}. */
export function probePid(pid: number): PidProbe {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: false, foreign: false, startedAt: null };
  }
  try {
    process.kill(pid, 0);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { running: false, foreign: false, startedAt: null };
    if (code === "EPERM") return { running: true, foreign: true, startedAt: processStartedAt(pid) };
    // Anything else is unexpected, and the stricter reading of an unexpected
    // answer is that the holder is there.
    return { running: true, foreign: false, startedAt: processStartedAt(pid) };
  }
  return { running: true, foreign: false, startedAt: processStartedAt(pid) };
}

/**
 * Is `pid` a running process?
 *
 * Kept for the callers that only want the coarse answer. The lease itself asks
 * {@link probePid}, because a pid alone cannot tell a holder from a number the
 * operating system has since handed to somebody else.
 */
export function pidIsAlive(pid: number): boolean {
  return probePid(pid).running;
}

/**
 * Why a lease stopped being its holder's.
 *
 * Three ways, and the operator is told which: the process is gone, the number
 * now belongs to somebody this process cannot signal, or the number is in use
 * by a process that started after the lease was written and therefore cannot
 * be the one that wrote it.
 */
export const CHANNEL_LEASE_RECLAIM_REASONS = ["gone", "foreign", "recycled"] as const;

export type ChannelLeaseReclaimReason = (typeof CHANNEL_LEASE_RECLAIM_REASONS)[number];

/** Is this holder still the process that wrote the lease? */
function judgeHolder(
  holder: ChannelLeaseHolder,
  probe: (pid: number) => PidProbe,
): { held: true } | { held: false; reason: ChannelLeaseReclaimReason } {
  const found = probe(holder.pid);
  if (!found.running) return { held: false, reason: "gone" };
  if (found.foreign) return { held: false, reason: "foreign" };
  if (found.startedAt !== null) {
    const wrote = Date.parse(holder.startedAt);
    if (
      !Number.isNaN(wrote) &&
      found.startedAt.getTime() > wrote + CHANNEL_LEASE_START_TOLERANCE_MS
    ) {
      return { held: false, reason: "recycled" };
    }
  }
  return { held: true };
}

/** How a reclaim is reported to the operator. */
export function reclaimDetail(
  holder: ChannelLeaseHolder,
  reason: ChannelLeaseReclaimReason,
): string {
  const why =
    reason === "gone"
      ? "that process is gone"
      : reason === "foreign"
        ? "that pid now belongs to a process this one cannot signal, so it is not the holder"
        : "that pid belongs to a process that started after the lease was written, so the number has been reused";
  return `the telegram transport lease was held by pid ${String(holder.pid)} in ${holder.mode} mode since ${holder.startedAt}, and ${why}; reclaimed`;
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
  const coarse = options.alive;
  const probe: (candidate: number) => PidProbe =
    options.probe ??
    (coarse === undefined
      ? probePid
      : (candidate: number): PidProbe => ({
          running: coarse(candidate),
          foreign: false,
          startedAt: null,
        }));
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
  let reclaimedBecause: ChannelLeaseReclaimReason | null = null;
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

    // The ordinary case, and the only one `O_EXCL` can settle on its own:
    // nothing holds the gate, and exactly one of any number of processes
    // creating this file wins.
    const created = createExclusive(path, body);
    if (created === "created") {
      return { ok: true, lease: leaseFor(path, mode, pid), reclaimed, reclaimedBecause };
    }
    if (created !== "exists") return unavailable(created.detail);

    const read = readHolderSettled(path);
    if (read.state === "absent") continue;

    if (read.state === "held" && read.holder.pid === pid) {
      // This process already holds the gate. One process runs one transport,
      // and the in-process guard against two is `claimTransport`; rewriting
      // the record keeps it true rather than making a supervisor fight its own
      // lockfile across a restart of its channel part. Written through a temp
      // and a rename, so a reader never sees half a record.
      const rewritten = writeAtomic(path, body, pid);
      if (rewritten !== null) return unavailable(rewritten);
      return { ok: true, lease: leaseFor(path, mode, pid), reclaimed, reclaimedBecause };
    }

    if (read.state === "held") {
      const verdict = judgeHolder(read.holder, probe);
      if (verdict.held) {
        return {
          ok: false,
          code: codeFor(read.holder.mode),
          holder: read.holder,
          message: refusalMessage(read.holder, mode, path),
        };
      }
      options.beforeTakeOver?.();
      const taken = takeOver(path, body, pid, { kind: "holder", holder: read.holder });
      if (taken === "taken") {
        reclaimed = read.holder;
        reclaimedBecause = verdict.reason;
        return { ok: true, lease: leaseFor(path, mode, pid), reclaimed, reclaimedBecause };
      }
      if (taken === "changed" || taken === "busy") {
        sleepSync(CHANNEL_LEASE_RETRY_MS);
        continue;
      }
      return unavailable(taken.detail);
    }

    // Unreadable after {@link CHANNEL_LEASE_ATTEMPTS} reads: nobody is
    // finishing a write, so this is a lockfile a crash tore in half, and
    // refusing forever over bytes nobody can read would be an outage with no
    // fault behind it. Replaced rather than deleted-then-created, so the path
    // is never absent and no third process can slip in through the gap.
    const replaced = takeOver(path, body, pid, { kind: "torn" });
    if (replaced === "taken") {
      return { ok: true, lease: leaseFor(path, mode, pid), reclaimed, reclaimedBecause };
    }
    if (replaced === "changed" || replaced === "busy") {
      sleepSync(CHANNEL_LEASE_RETRY_MS);
      continue;
    }
    return unavailable(replaced.detail);
  }

  return unavailable(
    `${String(CHANNEL_LEASE_ATTEMPTS)} attempts raced another process taking and releasing it`,
  );
}

/** `O_EXCL` create, the one race the file system settles by itself. */
function createExclusive(
  path: string,
  body: string,
): "created" | "exists" | { detail: string } {
  try {
    const handle = openSync(path, "wx", 0o600);
    try {
      writeFileSync(handle, body, { encoding: "utf8" });
    } finally {
      closeSync(handle);
    }
    return "created";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    return { detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Write `path` whole, by rename, never leaving it absent or half-written.
 *
 * `rename` replaces the destination in one step, so a reader either sees the
 * old record or the new one. Returns `null` on success and the detail of the
 * failure otherwise.
 */
function writeAtomic(path: string, body: string, pid: number): string | null {
  temporaryCounter += 1;
  const temporary = `${path}.${String(pid)}.${String(temporaryCounter)}.${String(Date.now())}.tmp`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return null;
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temp may never have been created; its absence is the desired state */
    }
    return cause instanceof Error ? cause.message : String(cause);
  }
}

let temporaryCounter = 0;

/** What a take-over must find before it replaces the lockfile. */
type TakeOverExpectation =
  | { kind: "holder"; holder: ChannelLeaseHolder }
  | { kind: "torn" };

/**
 * Replace a lockfile somebody else wrote, inside a critical section.
 *
 * The section is the whole of the fix for the interleaving in APRV-424's
 * second review: two processes that had both read one dead holder used to take
 * turns deleting each other's live lease. Inside it the record is read AGAIN
 * and must still be exactly what was judged (the same pid and the same
 * `started_at`), so the second reclaimer of a pair abandons its take-over,
 * finds a live record on the next pass, and refuses.
 *
 * `busy` means another process holds the section right now: the caller waits
 * and comes round again rather than forcing it, because forcing a critical
 * section is the same as not having one.
 */
function takeOver(
  path: string,
  body: string,
  pid: number,
  expect: TakeOverExpectation,
): "taken" | "changed" | "busy" | { detail: string } {
  const lockPath = `${path}${CHANNEL_LEASE_RECLAIM_SUFFIX}`;
  const entered = createExclusive(lockPath, `${JSON.stringify({ pid, at: Date.now() })}\n`);
  if (entered !== "created") {
    if (entered !== "exists") return entered;
    // A reclaim lock older than the handful of syscalls the section takes
    // belongs to a process that died inside it. One crash must not wedge the
    // gate for good.
    let age = 0;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      return "busy";
    }
    if (age < CHANNEL_LEASE_RECLAIM_STALE_MS) return "busy";
    try {
      unlinkSync(lockPath);
    } catch {
      /* somebody else cleared it first, which is the same outcome */
    }
    return "busy";
  }

  try {
    const fresh = readHolderSettled(path);
    if (fresh.state === "absent") {
      // The record went away while this process was entering the section: the
      // holder released it, or another take-over finished. Create rather than
      // rename, so a fresh taker that got there first is not overwritten.
      const created = createExclusive(path, body);
      if (created === "created") return "taken";
      return created === "exists" ? "changed" : created;
    }
    if (expect.kind === "torn") {
      if (fresh.state !== "torn") return "changed";
    } else {
      if (fresh.state !== "held") return "changed";
      // Identity is the pid AND the instant it wrote, so a reused pid holding
      // a fresh lease is not mistaken for the dead holder that was judged.
      if (fresh.holder.pid !== expect.holder.pid) return "changed";
      if (fresh.holder.startedAt !== expect.holder.startedAt) return "changed";
    }
    const written = writeAtomic(path, body, pid);
    return written === null ? "taken" : { detail: written };
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* advisory: an abandoned reclaim lock ages out above */
    }
  }
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
