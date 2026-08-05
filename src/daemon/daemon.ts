/**
 * `approvald` — the daemon loop of SPEC.md §10.2 (APRV-39).
 *
 * > "`approvald` watches the backlog folder and the log: validates new/changed
 * > envelopes, applies policy, dispatches channel notifications, expires TTLs,
 * > samples supervised actions for audit, re-renders projections, and
 * > (optionally) polls upstream sources."
 *
 * This module is the loop's core: watch, envelope drift, TTL sweep, queue
 * regeneration, and loop-escalation surfacing. Channel dispatch belongs to the
 * channel verbs (APRV-23/25/26), audit sampling to APRV-40, and payload-retention
 * pruning to APRV-41; each is its own task and none of them is smuggled in here.
 *
 * ## It decides nothing of its own
 *
 * Every judgement the daemon makes is one some other module already owns:
 *
 * - approval state per action is `core/state.ts`'s `requestState`, rolled up to
 *   the task by `daemon/projection.ts` and never re-derived;
 * - expiry is `core/gate.ts`'s `expire`, the system verb, which re-reads the log,
 *   re-judges the TTL, and refuses anything that is not a live lapsed request;
 * - the queue is `channels/render-queue.ts`'s `writeQueue`, the same renderer
 *   `approval render` calls, writing the same file the same atomic way;
 * - loop escalation is `core/loop.ts`'s projection, which the gate and the
 *   executor already enforce. The daemon **surfaces** it and enforces nothing.
 *
 * What is new here is scheduling: when to look, how often, and how not to append
 * the same fact twice.
 *
 * ## Watching, and why correctness never depends on it
 *
 * `fs.watch` is bursty, coalescing, and platform-dependent: one editor save can
 * produce three events or one, a rename can arrive as a delete plus a create,
 * and on some filesystems nothing arrives at all. So the watcher is treated as a
 * **latency optimization and nothing else**. Every tick re-scans the task folder
 * and re-derives everything from the verified log, and a periodic tick runs on
 * `intervalMs` whether or not any watcher ever fires. A daemon whose watchers all
 * failed to attach is a slower daemon, never a wrong one — which is also what
 * makes the behavior testable without depending on any platform's watch
 * semantics.
 *
 * Watch events are debounced (`debounceMs`) so a burst collapses into one tick.
 * Ticks are synchronous end to end, so they cannot interleave.
 *
 * ## Single writer, in intent only
 *
 * CLAUDE.md's rule is that the daemon is the sole writer while it runs. That is
 * an operational stance, not a lock this module takes: the CLI verbs remain
 * appendable at any moment, `core/log.ts`'s advisory lockfile serializes the
 * writes, and every append here passes `expectedHead` so a check made against one
 * log cannot land on another (compare-and-append, SPEC.md §11.1 invariant 5).
 *
 * The daemon therefore **tolerates external appends by re-reading**: a
 * `head-moved` refusal is reported and dropped, never retried in place, because
 * the next tick re-derives the whole question from the log as it now is. It holds
 * no lock of its own and leaves no lockfile behind — the only lockfile in this
 * system is the one `appendEvent` creates and releases inside a single call.
 *
 * ## Fail closed, loudly
 *
 * A log that does not verify stops the daemon rather than degrading it. Nothing
 * may be appended onto a chain that does not verify, projections built from one
 * would be screenshots of something nobody should read, and a daemon that kept
 * running while reporting corruption would train an operator to ignore it.
 */

import { watch, type FSWatcher } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { writeQueue } from "../channels/render-queue.js";
import { tick as readClock, type Clock } from "../core/clock.js";
import { readTaskFile } from "../core/frontmatter.js";
import { expire, type GateOptions } from "../core/gate.js";
import { appendEvent, type EventRecord } from "../core/log.js";
import { loopEscalation } from "../core/loop.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy, type LoadPolicyOptions } from "../core/policy-load.js";
import {
  readVerifiedRecords,
  type LogReadRefusal,
  type ReadRecordsResult,
} from "../core/state.js";
import { validate } from "../core/validate.js";
import type { GitEvidenceRecorder } from "./git-evidence.js";
import { prunePayloads } from "./prune.js";
import {
  driftAlreadyLogged,
  lapsedRequests,
  taskEnvelopeState,
  type DriftFacts,
} from "./projection.js";

/**
 * SPEC.md §8: runtime-originated events carry a `system:` actor. The daemon is
 * the runtime, and `envelope.drift` is its own event — distinct from
 * `system:gate`, which `core/gate.ts` stamps on the expiries it appends, so a
 * reader can tell which part of the runtime spoke.
 */
export const DAEMON_ACTOR = "system:daemon";

/** Backlog.md's conventional task folder, relative to the working directory. */
export const DEFAULT_TASKS_DIR = "backlog/tasks";

/** How often the daemon looks, absent any watcher event. */
export const DEFAULT_INTERVAL_MS = 30_000;

/** How long a burst of watcher events is allowed to settle before a tick. */
export const DEFAULT_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// The output stream
// ---------------------------------------------------------------------------

/**
 * One line of daemon output. **Frozen shape** in the same sense every `--json`
 * shape in this CLI is frozen: an operator's log pipeline and an agent's
 * supervisor branch on `event`, so entries may be added and none may be
 * repurposed. Each is printed as one JSON object per line under `--json`, and as
 * one human sentence otherwise.
 */
export type DaemonEvent =
  | {
      event: "started";
      log: string;
      tasks: string;
      queue: string;
      interval_ms: number;
      debounce_ms: number;
      watching: boolean;
    }
  | {
      event: "drift";
      task: string;
      file: string;
      declared_state: string | null;
      derived_state: string;
      seq: number;
    }
  | { event: "expired"; action_key: string; task: string | null; seq: number }
  | {
      event: "rendered";
      path: string;
      bytes: number;
      pending: number;
      skipped: number;
      audit_backlog: number;
    }
  | { event: "escalated"; task: string; consecutive_failures: number }
  | { event: "escalation_cleared"; task: string }
  | {
      event: "tick";
      n: number;
      head: number | null;
      drift: number;
      expired: number;
      escalated: number;
    }
  | { event: "warning"; code: DaemonWarningCode; message: string }
  | {
      event: "stopped";
      reason: string;
      ticks: number;
      drift: number;
      expired: number;
      renders: number;
    };

/**
 * Why the daemon complained without stopping. Machine-readable and distinct, per
 * SPEC.md §11.1 invariant 6, and a closed union for the same reason the gate's
 * refusal codes are: a supervisor that branches on them needs them stable.
 */
export const DAEMON_WARNING_CODES = [
  /** A task file could not be read (permissions, a vanished file). */
  "task-unreadable",
  /** A task file's frontmatter does not parse. */
  "frontmatter-invalid",
  /** The `approval:` envelope failed `envelope.schema.json`. */
  "envelope-invalid",
  /** The frontmatter carries no usable `id`, so no drift can be keyed to it. */
  "task-id-missing",
  /** The task folder could not be listed; the next tick tries again. */
  "tasks-dir-unreadable",
  /** An append was refused. The next tick re-derives and may try again. */
  "append-refused",
  /** The TTL sweep's `expire` refused for a reason other than a race. */
  "expire-refused",
  /** The queue could not be written. The log is untouched. */
  "render-failed",
  /** A watcher could not attach; the periodic tick covers the folder anyway. */
  "watch-unavailable",
  /**
   * A payload-retention prune did not complete (APRV-41). The store keeps the
   * file, and the next tick re-derives; nothing is ever deleted unlogged.
   */
  "prune-refused",
] as const;

export type DaemonWarningCode = (typeof DAEMON_WARNING_CODES)[number];

/** Where daemon output goes. Injected, so the loop itself writes to nothing. */
export interface DaemonSink {
  emit(event: DaemonEvent): void;
}

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  /** The append-only log (SPEC.md §9). Read every tick, appended rarely. */
  logPath: string;
  /** The Backlog.md task folder to watch. */
  tasksDir: string;
  /** Where `QUEUE.md` is regenerated (SPEC.md §9.1). */
  queuePath: string;
  /** Policy location, with `loadPolicy`'s semantics. */
  policy: { dir?: string; file?: string };
  /** Schema directory, passed to validation and to every append. */
  schemaDir?: string;
  /** Directory paths in output are reported relative to this. */
  cwd: string;
  /** Periodic tick, in milliseconds. Also the poll-assisted watcher fallback. */
  intervalMs: number;
  /** Watcher debounce, in milliseconds. */
  debounceMs: number;
  /** Run exactly one tick and stop. The cron-shaped invocation, and the tests'. */
  once: boolean;
  /** The write-boundary clock, injected by tests (amended SPEC.md §8). */
  clock?: Clock;
  /**
   * SPEC.md §8's optional git hardening (APRV-42), off unless the operator asked
   * for it. When present, it is handed the verified head at the end of each
   * tick; it decides everything else, reports through its own sink, and cannot
   * change any verdict this loop reaches. See `daemon/git-evidence.ts`.
   */
  gitEvidence?: GitEvidenceRecorder;
  sink: DaemonSink;
}

/**
 * How the loop ended.
 *
 * `stopped` is a clean shutdown (a signal, or `once` completing). The three
 * failures mirror the CLI's frozen exit table exactly, so the verb maps them
 * without inventing a code: an unreadable log is I/O, a torn tail is a crashed
 * write, and a chain that does not verify is an integrity failure.
 */
export type DaemonOutcome =
  | { kind: "stopped"; reason: string }
  | { kind: "log-unreadable"; message: string }
  | { kind: "log-torn-tail"; message: string }
  | { kind: "log-corrupt"; message: string };

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface RenderSummary {
  pending: number;
  skipped: number;
  auditBacklog: number;
  head: number | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The daemon.
 *
 * One instance owns one working set (a log, a task folder, a queue file) and one
 * set of timers. {@link run} resolves when the loop stops; {@link stop} is what a
 * signal handler calls.
 */
export class Daemon {
  private readonly options: DaemonOptions;
  private readonly watchers: FSWatcher[] = [];
  private watchAttempted = false;
  private watching = false;
  private interval: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private ticking = false;
  private ticks = 0;
  private drifts = 0;
  private expiries = 0;
  private renders = 0;
  private lastRender: RenderSummary | null = null;
  private reportedEscalations = new Set<string>();
  private settle: ((outcome: DaemonOutcome) => void) | null = null;
  private finished = false;

  constructor(options: DaemonOptions) {
    this.options = options;
  }

  /** Run until stopped (or, with `once`, for exactly one tick). */
  run(): Promise<DaemonOutcome> {
    return new Promise<DaemonOutcome>((resolve) => {
      this.settle = resolve;

      if (!this.options.once) this.attachWatchers();
      this.emit({
        event: "started",
        log: this.display(this.options.logPath),
        tasks: this.display(this.options.tasksDir),
        queue: this.display(this.options.queuePath),
        interval_ms: this.options.intervalMs,
        debounce_ms: this.options.debounceMs,
        watching: this.watching,
      });

      const outcome = this.tick();
      if (outcome !== null) {
        this.finish(outcome);
        return;
      }
      if (this.options.once) {
        this.finish({ kind: "stopped", reason: "once" });
        return;
      }

      this.interval = setInterval(() => {
        const periodic = this.tick();
        if (periodic !== null) this.finish(periodic);
      }, this.options.intervalMs);
    });
  }

  /** Stop cleanly: timers cleared, watchers closed, nothing half-written. */
  stop(reason: string): void {
    this.finish({ kind: "stopped", reason });
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private finish(outcome: DaemonOutcome): void {
    if (this.finished) return;
    this.finished = true;

    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // A watcher that is already closed, or whose directory vanished, has
        // nothing left to release. Shutdown must not fail on it.
      }
    }
    this.watchers.length = 0;

    this.emit({
      event: "stopped",
      reason: outcome.kind === "stopped" ? outcome.reason : outcome.kind,
      ticks: this.ticks,
      drift: this.drifts,
      expired: this.expiries,
      renders: this.renders,
    });

    const settle = this.settle;
    this.settle = null;
    if (settle !== null) settle(outcome);
  }

  /**
   * Attach watchers to the task folder and the log's directory.
   *
   * The log's *directory* rather than the log file: an append to a file is
   * observable either way, but a log that does not exist yet cannot be watched at
   * all, and a rename (which `writeQueue` and any future rotation perform) leaves
   * a file watcher pointed at an inode nobody writes to again.
   *
   * Failure is a warning, never fatal — see the module header on why the periodic
   * tick makes watching optional.
   */
  private attachWatchers(): void {
    if (this.watchAttempted) return;
    this.watchAttempted = true;
    const trigger = (): void => this.schedule();
    for (const [label, dir] of [
      ["tasks", this.options.tasksDir],
      ["log", dirname(this.options.logPath)],
    ] as const) {
      try {
        const watcher = watch(dir, { persistent: true }, trigger);
        watcher.on("error", () => {
          // A watcher that errors (its directory was removed, the platform ran
          // out of handles) is simply dropped. The periodic tick continues to
          // cover everything it was watching.
        });
        this.watchers.push(watcher);
        this.watching = true;
      } catch (cause) {
        this.warn(
          "watch-unavailable",
          `the ${label} directory ${this.display(dir)} could not be watched (${errorMessage(
            cause,
          )}); the daemon still re-scans it every ${String(this.options.intervalMs)}ms, so this costs latency and never correctness`,
        );
      }
    }
  }

  /** Coalesce a burst of watcher events into one tick. */
  private schedule(): void {
    if (this.finished) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const outcome = this.tick();
      if (outcome !== null) this.finish(outcome);
    }, this.options.debounceMs);
  }

  // -------------------------------------------------------------------------
  // One tick
  // -------------------------------------------------------------------------

  /**
   * One full pass: drift scan, TTL sweep, escalation surfacing, queue render.
   *
   * Returns `null` to continue, or the outcome that must stop the loop. Every
   * step re-reads the verified log rather than sharing one snapshot across the
   * pass, because each append invalidates the head the next one would build on
   * and because an external writer may have moved the log in between. Reading is
   * O(n) per call at v0.1 (`core/state.ts` documents the deferral); the head
   * cache is APRV-43, and correctness comes first.
   */
  private tick(): DaemonOutcome | null {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      this.ticks += 1;
      // Late-attaching watchers: a log directory (or a task folder) created after
      // startup becomes watchable, and the operator gets the latency back.
      if (!this.options.once && !this.watching) {
        this.watchAttempted = false;
        this.attachWatchers();
      }

      const opening = this.read();
      if (!opening.ok) return this.fatal(opening);

      const drift = this.scanForDrift();
      if (drift.stop !== null) return drift.stop;

      const expired = this.sweepTtl();
      if (expired.stop !== null) return expired.stop;

      // Payload retention (APRV-41), after the TTL sweep so a request expired on
      // this tick is judged against the record the sweep just wrote. The pruner
      // owns the rule, the append and the unlink; the daemon owns only the
      // scheduling, which is the one thing `daemon/prune.ts` deliberately lacks.
      this.prune();

      const closing = this.read();
      if (!closing.ok) return this.fatal(closing);
      const escalated = this.surfaceEscalations(closing.records);

      this.render();
      this.options.gitEvidence?.commit(closing.head);

      this.emit({
        event: "tick",
        n: this.ticks,
        head: closing.head === null ? null : closing.head.seq,
        drift: drift.appended,
        expired: expired.appended,
        escalated,
      });
      return null;
    } finally {
      this.ticking = false;
    }
  }

  private fatal(read: LogReadRefusal): DaemonOutcome {
    switch (read.code) {
      case "log-unreadable":
        return { kind: "log-unreadable", message: read.message };
      case "log-torn-tail":
        return { kind: "log-torn-tail", message: read.message };
      case "log-corrupt":
        return { kind: "log-corrupt", message: read.message };
    }
  }

  private read(): ReadRecordsResult {
    return readVerifiedRecords(
      this.options.logPath,
      this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir },
    );
  }

  /** The TTL in force right now, re-read every pass: policy files change. */
  private ttlMs(): number | null {
    const where: LoadPolicyOptions =
      this.options.policy.file !== undefined
        ? { file: this.options.policy.file }
        : { dir: this.options.policy.dir ?? this.options.cwd };
    if (this.options.schemaDir !== undefined) where.schemaDir = this.options.schemaDir;
    const load = loadPolicy(where);
    // Fail closed exactly as the gate does: an unloadable policy declares no
    // TTL, so nothing lapses and nothing is expired on its behalf.
    return load.ok ? load.durations.approvalTtlMs : null;
  }

  private gateOptions(): GateOptions {
    const options: GateOptions = { policy: this.options.policy };
    if (this.options.schemaDir !== undefined) options.schemaDir = this.options.schemaDir;
    if (this.options.clock !== undefined) options.clock = this.options.clock;
    return options;
  }

  // -------------------------------------------------------------------------
  // Envelope drift (SPEC.md §6.3)
  // -------------------------------------------------------------------------

  /**
   * Read every task file, compare its claimed `state:` against the log, and
   * append `envelope.drift` for each file that contradicts it.
   *
   * §6.3: "`state` is a projection of log events; the file is updated by the
   * daemon after the event is appended, never the reverse. A file edit that
   * contradicts the log is itself logged (`envelope.drift`) and surfaced."
   *
   * The daemon **does not repair the file**. Rewriting a task file is M6's
   * round-trip work (unknown-key preservation is a hard requirement there), and a
   * daemon that silently corrected a human's edit would be resolving a
   * disagreement it is only supposed to record.
   *
   * A schema-invalid envelope is warned about and skipped, not logged as drift: a
   * malformed file is not a *contradiction* of the log, it is a file the runtime
   * cannot read a claim out of at all, and inventing a `declared_state` for it
   * would put a fact in the log that nobody wrote.
   */
  private scanForDrift(): { appended: number; stop: DaemonOutcome | null } {
    let appended = 0;
    for (const file of this.taskFiles()) {
      const outcome = this.checkOneFile(file);
      if (outcome.stop !== null) return { appended, stop: outcome.stop };
      if (outcome.appended) appended += 1;
    }
    return { appended, stop: null };
  }

  /** Every `*.md` under the task folder, sorted, non-recursive. */
  private taskFiles(): string[] {
    let entries;
    try {
      entries = readdirSync(this.options.tasksDir, { withFileTypes: true });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.warn(
          "tasks-dir-unreadable",
          `task folder ${this.display(this.options.tasksDir)} could not be listed: ${errorMessage(
            cause,
          )}; the next tick tries again`,
        );
      }
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(this.options.tasksDir, entry.name))
      .sort();
  }

  private checkOneFile(file: string): { appended: boolean; stop: DaemonOutcome | null } {
    const read = readTaskFile(file);
    if (!read.ok) {
      if (read.code === "no-frontmatter") {
        // SPEC.md §6: a task with no envelope is valid markdown. Silent by design.
        return { appended: false, stop: null };
      }
      this.warn(
        read.code === "io" ? "task-unreadable" : "frontmatter-invalid",
        `${this.display(file)}: ${read.message}`,
      );
      return { appended: false, stop: null };
    }

    const envelope = read.data["approval"];
    if (envelope === undefined) return { appended: false, stop: null };

    const id = read.data["id"];
    if (typeof id !== "string" || id.length === 0) {
      this.warn(
        "task-id-missing",
        `${this.display(file)} carries an approval: envelope but no usable \`id\`; the task id is the key every log record is written under, so drift cannot be attributed to this file`,
      );
      return { appended: false, stop: null };
    }

    const validation = validate(
      "envelope",
      envelope,
      this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir },
    );
    if (!validation.ok) {
      this.warn(
        "envelope-invalid",
        `${this.display(file)}: the approval: envelope failed envelope.schema.json (${
          validation.errors.length
        } error(s), first: ${validation.errors[0]?.message ?? "unknown"}); nothing was appended, because a malformed envelope makes no claim the log could contradict`,
      );
      return { appended: false, stop: null };
    }

    // Re-read immediately before deciding, so the head this append is compared
    // against is the head the decision was made from.
    const records = this.read();
    if (!records.ok) return { appended: false, stop: this.fatal(records) };

    const ts = readClock(this.options.clock === undefined ? {} : { clock: this.options.clock });
    const projection = taskEnvelopeState(records.records, id, ts, this.ttlMs());
    const declaredRaw = (envelope as { state?: unknown }).state;
    const declaredState = typeof declaredRaw === "string" ? declaredRaw : null;
    if (declaredState === projection.state) return { appended: false, stop: null };

    const facts: DriftFacts = {
      declaredState,
      derivedState: projection.state,
      envelopeDigest: digestOf(envelope),
    };
    if (driftAlreadyLogged(records.records, id, facts)) return { appended: false, stop: null };

    const payload: Record<string, unknown> = {
      file: this.display(file),
      declared_state: declaredState,
      derived_state: facts.derivedState,
      registered: projection.registered,
      reason: "state-mismatch",
    };
    if (facts.envelopeDigest !== null) payload["envelope_sha256"] = facts.envelopeDigest;

    const result = appendEvent(
      this.options.logPath,
      {
        ts,
        event: "envelope.drift",
        actor: DAEMON_ACTOR,
        task: id,
        payload,
      },
      {
        ...(this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir }),
        expectedHead: records.head,
      },
    );
    if (!result.ok) {
      this.warn(
        "append-refused",
        `envelope.drift for ${id} was not appended (${result.error.code}): ${result.error.message}`,
      );
      return { appended: false, stop: null };
    }

    this.drifts += 1;
    this.emit({
      event: "drift",
      task: id,
      file: this.display(file),
      declared_state: declaredState,
      derived_state: facts.derivedState,
      seq: result.record.seq,
    });
    return { appended: true, stop: null };
  }

  // -------------------------------------------------------------------------
  // TTL sweep (SPEC.md §5.2, §6.3)
  // -------------------------------------------------------------------------

  /**
   * Append `approval.expired` for every live request whose TTL has lapsed.
   *
   * The sweep changes no verdict. `core/gate.ts` already judges the TTL lazily at
   * decision time, so a late grant is refused with or without an expiry record;
   * what the sweep adds is *visibility* — the queue, the index, and anyone
   * reading the log see a terminal fact rather than a request that looks live and
   * is not.
   *
   * Idempotent three ways over, and none of them is a remembered flag:
   *
   * - with lazy expiry, because `expire` refuses `already-decided` for anything a
   *   human (or the lazy path) already settled;
   * - with itself, because the candidate list is re-derived from the verified log
   *   each sweep and an expired request no longer appears in it;
   * - across restarts, because the daemon carries no state between runs at all.
   *
   * A `head-moved` refusal is expected traffic, not a fault: a CLI verb decided
   * the same request between this candidate list and this append. It is reported
   * at `debug` weight (a single warning line) and the next tick re-derives.
   */
  private sweepTtl(): { appended: number; stop: DaemonOutcome | null } {
    const records = this.read();
    if (!records.ok) return { appended: 0, stop: this.fatal(records) };

    const ts = readClock(this.options.clock === undefined ? {} : { clock: this.options.clock });
    const candidates = lapsedRequests(records.records, ts, this.ttlMs());
    let appended = 0;

    for (const candidate of candidates) {
      const result = expire(this.options.logPath, candidate.actionKey, this.gateOptions());
      if (!result.ok) {
        // `not-expired` and `already-decided` mean the log moved under the
        // candidate list — someone decided it, or the clock the gate read differs
        // by a hair from the one this list was built with. Neither is an error,
        // and neither is retried here.
        this.warn(
          "expire-refused",
          `approval.expired for ${candidate.actionKey} was not appended (${result.code}): ${result.message}`,
        );
        continue;
      }
      appended += 1;
      this.expiries += 1;
      this.emit({
        event: "expired",
        action_key: candidate.actionKey,
        task: candidate.task,
        seq: result.record.seq,
      });
    }

    return { appended, stop: null };
  }

  // -------------------------------------------------------------------------
  // Payload retention (amended SPEC.md §5.2, APRV-41)
  // -------------------------------------------------------------------------

  /**
   * Hand one pass to `daemon/prune.ts` and surface whatever it could not do.
   *
   * The daemon adds nothing to the rule: with `payload_retention` absent the
   * pass is a no-op, and with it present the pruner appends `payload.pruned`
   * before every unlink and re-derives the whole question from the verified log.
   * Warnings never stop the loop — a store that could not be pruned is a store
   * holding more evidence than the policy asked it to, which is the safe side.
   */
  private prune(): void {
    const options: Parameters<typeof prunePayloads>[0] = {
      logPath: this.options.logPath,
      // The same resolution `ttlMs` uses: an unset directory means the daemon's
      // own working directory, never the process's.
      policy:
        this.options.policy.file !== undefined
          ? { file: this.options.policy.file }
          : { dir: this.options.policy.dir ?? this.options.cwd },
    };
    if (this.options.schemaDir !== undefined) options.schemaDir = this.options.schemaDir;
    if (this.options.clock !== undefined) options.clock = this.options.clock;
    for (const warning of prunePayloads(options).warnings) {
      this.warn("prune-refused", `${warning.code}: ${warning.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Loop escalation (SPEC.md §10.2)
  // -------------------------------------------------------------------------

  /**
   * Report tasks that loop safety has escalated to manual, and tasks that have
   * come back.
   *
   * The projection is `core/loop.ts`'s and the enforcement is the gate's and the
   * executor's; this makes the state *visible* to whoever is watching the daemon,
   * which is the one thing neither of them does. `approval status` reports the
   * same set, from the same projection, for an operator who is not.
   *
   * Reported on change rather than every tick: a standing escalation restated
   * every interval is noise that trains an operator to scroll past it.
   */
  private surfaceEscalations(records: EventRecord[]): number {
    const current = new Set<string>();
    for (const state of loopEscalation(records)) {
      if (!state.escalated) continue;
      current.add(state.task);
      if (!this.reportedEscalations.has(state.task)) {
        this.emit({
          event: "escalated",
          task: state.task,
          consecutive_failures: state.consecutiveFailures,
        });
      }
    }
    for (const task of this.reportedEscalations) {
      if (!current.has(task)) this.emit({ event: "escalation_cleared", task });
    }
    this.reportedEscalations = current;
    return current.size;
  }

  // -------------------------------------------------------------------------
  // The queue projection (SPEC.md §9.1)
  // -------------------------------------------------------------------------

  /**
   * Regenerate `QUEUE.md` through the real renderer.
   *
   * Never partial: `writeQueue` writes a temp file and renames it, so a reader
   * sees either the previous queue or the new one and never a half-written file,
   * and a crashed daemon leaves no torn queue behind.
   *
   * The file is rewritten every tick, because TTL countdowns move even when the
   * log does not. The *event* is emitted only when the summary changes, so a
   * standing queue does not fill an operator's terminal with identical lines.
   */
  private render(): void {
    const now = readClock(this.options.clock === undefined ? {} : { clock: this.options.clock });
    const result = writeQueue(
      this.options.logPath,
      this.options.queuePath,
      { policy: this.options.policy },
      now,
    );
    if (!result.ok) {
      this.warn(
        "render-failed",
        `${this.display(this.options.queuePath)} was not regenerated (${result.code}): ${result.message}`,
      );
      return;
    }
    this.renders += 1;

    const summary: RenderSummary = {
      pending: result.pending,
      skipped: result.skipped,
      auditBacklog: result.auditBacklog,
      head: result.head === null ? null : result.head.seq,
    };
    const previous = this.lastRender;
    this.lastRender = summary;
    if (
      previous !== null &&
      previous.pending === summary.pending &&
      previous.skipped === summary.skipped &&
      previous.auditBacklog === summary.auditBacklog &&
      previous.head === summary.head
    ) {
      return;
    }

    this.emit({
      event: "rendered",
      path: this.display(this.options.queuePath),
      bytes: result.bytes,
      pending: result.pending,
      skipped: result.skipped,
      audit_backlog: result.auditBacklog,
    });
  }

  // -------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------

  private emit(event: DaemonEvent): void {
    this.options.sink.emit(event);
  }

  private warn(code: DaemonWarningCode, message: string): void {
    this.emit({ event: "warning", code, message });
  }

  /** A path as the operator typed it: relative to cwd when it is inside it. */
  private display(path: string): string {
    const rel = relative(this.options.cwd, path);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  }
}

/**
 * SHA-256 over the RFC 8785 form of the envelope, part of the drift dedupe key.
 *
 * `null` when the value cannot be canonicalized. A YAML mapping that survived the
 * hardened parser and `envelope.schema.json` always can, so this is a backstop
 * rather than a live branch — and a backstop that degrades to "dedupe on the
 * state pair alone" rather than to a thrown error inside a watcher callback.
 */
function digestOf(envelope: unknown): string | null {
  try {
    return payloadHash(envelope);
  } catch {
    return null;
  }
}

/** Does this path exist and is it a directory? Used by the verb's preflight. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
