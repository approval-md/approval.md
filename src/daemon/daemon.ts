/**
 * `approvald` — the daemon loop of SPEC.md §10.2 (APRV-39).
 *
 * > "`approvald` watches the backlog folder and the log: validates new/changed
 * > envelopes, applies policy, dispatches channel notifications, expires TTLs,
 * > samples supervised actions for audit, re-renders projections, and
 * > (optionally) polls upstream sources."
 *
 * This module is the loop's core: watch, envelope drift, TTL sweep, projection
 * write-back, queue regeneration, and loop-escalation surfacing. Channel dispatch
 * belongs to the channel verbs (APRV-23/25/26), audit sampling to APRV-40, and
 * payload-retention pruning to APRV-41; each is its own task and none of them is
 * smuggled in here.
 *
 * ## Drift, then repair (SPEC.md §6.3, §10.2, APRV-62)
 *
 * A task file's `state:` is a projection and the log is the truth, so the two
 * halves of that sentence are two steps of one tick. The drift scan runs first
 * and appends `envelope.drift` for every file whose claim the log contradicts;
 * the write-back pass runs after every append this tick could make and rewrites
 * those files through `core/task-file.ts` so the projection matches the log
 * again. Write-back never appends and never precedes an append: it only copies a
 * fact the log already carries into a file that disagreed with it.
 *
 * So a drift record marks the moment a file was found wrong **and fixed**, not a
 * standing disagreement. That reading is what makes the records worth watching:
 * a file that keeps drifting after repair is a file some other writer is fighting
 * the daemon over, and the repeated records are how an operator sees it. One
 * record per transition is the healthy shape (the log moved, the file caught up);
 * a run of identical records against an unmoving log is not.
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { writeQueue } from "../channels/render-queue.js";
import { tick as readClock, type Clock } from "../core/clock.js";
import { parseFrontmatter, readTaskFile } from "../core/frontmatter.js";
import { expire, type GateOptions } from "../core/gate.js";
import { appendEvent, type EventRecord } from "../core/log.js";
import { loopEscalation } from "../core/loop.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy, type LoadPolicyOptions } from "../core/policy-load.js";
import { rewriteTaskFile, writeTaskFileAtomic, type RewriteOptions } from "../core/task-file.js";
import {
  processReadCache,
  readVerifiedRecords,
  type LogReadRefusal,
  type ReadRecordsResult,
} from "../core/state.js";
import { validate } from "../core/validate.js";
import { publishedState } from "../cli/log-advance.js";
import { isAdvanceBookkeeping } from "../core/advance-cycle.js";
import {
  authorizeAdvance,
  reconcileDanglingAdvance,
  runAdvanceAsync,
  runAdvanceSync,
  settleAdvanceFinish,
  type AdvanceAttempt,
  type AdvanceCadence,
  type AdvanceInput,
  type AdvanceOutcome,
  type PendingAdvanceFinish,
} from "./advance.js";
import { sweepAuditSampling } from "./audit.js";
import {
  sweepDarkSessions,
  type DarkSessionSweepOptions,
  type DarkSessionWatch,
} from "./dark-session.js";
import type { GitEvidenceRecorder } from "./git-evidence.js";
import { prunePayloads, type PruneReason } from "./prune.js";
import {
  driftAlreadyLogged,
  lapsedRequests,
  latestRegistration,
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
export { DEFAULT_TASKS_DIR } from "../core/registration.js";

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
      /**
       * Which prefix proof this run's verified reads run (APRV-217). Additive,
       * like every other growth of this union. It is on the FIRST line the
       * daemon prints because it is a configuration an operator has to be able
       * to see without asking the process anything.
       */
      read_proof: "full" | "incremental";
    }
  | {
      event: "drift";
      task: string;
      file: string;
      declared_state: string | null;
      derived_state: string;
      seq: number;
      /**
       * Why (APRV-63). Present only for `envelope-missing`: a `state-mismatch`
       * line is what every `drift` line has always been, and a field that
       * appeared on all of them would change a shape supervisors already parse.
       */
      reason?: "envelope-missing";
    }
  | {
      /**
       * A task file's `state:` was rewritten to match the log (SPEC.md §6.3).
       * Additive (APRV-62): the union grows, and no existing entry changes
       * meaning. A rewritten file is a change to a human's working tree, so it
       * gets a line of its own rather than hiding inside the drift record that
       * preceded it.
       */
      event: "write_back";
      task: string;
      file: string;
      /** The `state:` the file claimed, or `null` when it declared none. */
      from: string | null;
      /** The state the log implies, now on disk. */
      to: string;
      bytes: number;
    }
  | { event: "expired"; action_key: string; task: string | null; seq: number }
  | {
      /**
       * A supervised execution was drawn for retrospective review (APRV-40,
       * SPEC.md §5.2). Additive (APRV-57): the union grows and no existing entry
       * changes meaning. APRV-40 left successful samples visible only as a
       * `rendered` backlog that grew, which tells an operator that *something*
       * was sampled without telling them what; this names it.
       */
      event: "sampled";
      action_key: string;
      task: string | null;
      /** `seq` of the appended `audit.sampled` record. */
      seq: number;
      /** `seq` of the `execution.started` record the sample named. */
      subject_seq: number;
    }
  | {
      /**
       * A payload's bytes were removed under `payload_retention` (APRV-41,
       * amended SPEC.md §5.2). Additive (APRV-57), and emitted only for a prune
       * that both appended its `payload.pruned` and unlinked the file: a prune
       * that appended and could not unlink is already a `prune-refused` warning,
       * and a crash-window completion appends nothing, so it has no `seq` to
       * name and stays out of this line.
       *
       * No byte count: `daemon/prune.ts` unlinks by hash and never stats the
       * file, and a size read here would be a fresh filesystem question asked
       * after the answer stopped existing.
       */
      event: "pruned";
      payload_hash: string;
      reason: PruneReason;
      /** The action whose terminal state released the bytes; `null` for an orphan. */
      action_key: string | null;
      task: string | null;
      /** `seq` of the appended `payload.pruned` record. */
      seq: number;
    }
  | {
      event: "rendered";
      path: string;
      bytes: number;
      pending: number;
      skipped: number;
      audit_backlog: number;
    }
  | {
      /**
       * The log was advanced onto a records branch, or an attempt to advance it
       * ended some other way (APRV-204). Additive: the union grows and no
       * existing entry changes meaning.
       *
       * One line per ATTEMPT, including the refused and gated ones, because the
       * thing an operator needs to see is that the cadence is running and what
       * it met — an advance that silently did not happen is the failure mode
       * this whole feature exists to remove.
       */
      event: "advance";
      outcome: AdvanceOutcome;
      /** Records not yet on a records branch, at the moment of the attempt. */
      records_pending: number;
      records_branch: string | null;
      /** The seq range this attempt published, or `null` when it published none. */
      range: { from: number; to: number } | null;
      commit: string | null;
      pr_url: string | null;
      /** True when this attempt opened the day's pull request rather than updating it. */
      pr_created: boolean;
      /**
       * True when the day's records branch was REBUILT on the base rather than
       * stacked on its own tip, and the ref it was rebuilt on (APRV-234).
       *
       * A branch the trunk has moved under cannot be fast-forwarded into it,
       * and a daemon that kept stacking on it produced a pull request only a
       * hand merge could land. Rebuilding is the repair, and an operator reading
       * this stream should not have to infer that it happened from a sha.
       */
      rebuilt: boolean;
      rebuilt_on: string | null;
      /** The refusal or failure code, when the outcome carries one. */
      code: string | null;
      message: string;
      /** True when this attempt was the graceful-shutdown flush. */
      flush: boolean;
    }
  | {
      /**
       * One subject of a dark-session sweep (APRV-192). Additive: the union
       * grows and no existing entry changes meaning.
       *
       * One line per subject that is NOT clean — dark, or undetermined —
       * because the sweep's whole point is the thing nobody was told about, and
       * a line per healthy worktree would bury it. A `dark` line names the
       * `audit.dark_session` record it appended, or says the log already
       * carried this observation; an `undetermined` line names what could not
       * be established, which is never reported as a pass.
       */
      event: "dark_session";
      verdict: "dark" | "undetermined";
      /** The checkout: a worktree directory's name, or `primary`. */
      subject: string;
      branch: string | null;
      code: string;
      /** Commits observed on this subject inside the window. */
      commits: number;
      /** `seq` of the appended record, `null` when nothing was appended. */
      seq: number | null;
      /** True when a prior record already carried this observation key. */
      already_recorded: boolean;
      message: string;
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
      /**
       * What the tick cost (APRV-211). Additive, like every other growth of this
       * union: the fields below were appended and nothing above them changed
       * meaning. A tick is the daemon's unit of work and it was possible for one
       * to pin a core for three seconds while every line it printed looked
       * healthy; these three fields are how that is visible without a profiler.
       */
      /** Wall-clock duration of the whole tick, in milliseconds. */
      ms: number;
      /** Verified log reads this tick made. Bounded by structure, not by size. */
      reads: number;
      /**
       * Which path this tick's reads took (APRV-217). Additive. `full` when any
       * read this tick hashed the whole prefix — a full re-proof, a cadence
       * boundary, a guard failure, or a cold walk — and `incremental` when
       * every one of them was served from a carried hash state. Under
       * `read_proof: full` it is `full` on every tick, which is the honest
       * report: that is the path those reads took.
       */
      reproof: "full" | "incremental";
      /** Per-phase duration in milliseconds, in the order the tick runs them. */
      phases: {
        drift: number;
        ttl: number;
        audit: number;
        dark: number;
        prune: number;
        write_back: number;
        advance: number;
        escalations: number;
        render: number;
      };
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
  /**
   * The projection write-back was refused by the writer, or the rewritten bytes
   * could not be placed (APRV-62). The file is left exactly as it was and the
   * log is untouched; the message carries `core/task-file.ts`'s own code.
   */
  "write-back-refused",
  /**
   * A cadence advance did not publish (APRV-204): the gate sent it to a human,
   * refused it, or the verb itself failed. Nothing was committed, the outcome
   * is on the `advance` line beside this warning, and the next tick tries
   * again — the cadence interval is the retry bound, so there is no hot loop.
   */
  "advance-refused",
  /**
   * A dark-session sweep (APRV-192) found git activity it could not judge, or
   * could not append the observation it did reach. Uncertainty is reported as
   * uncertainty and never as a pass; nothing is escalated on it, because a
   * detector reports and the gate decides.
   */
  "dark-session-undetermined",
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
  /**
   * The cadence advance (APRV-204), off unless the operator asked for it.
   *
   * Opt-in for the reason `gitEvidence` is: it pushes commits and opens pull
   * requests on a remote, and a daemon that started doing that on an upgrade
   * because a default changed under it would be the surprise this project
   * exists to prevent. `approval daemon run --advance` turns it on.
   */
  advance?: AdvanceCadence;
  /**
   * The child that runs a periodic tick's advance (APRV-211). A test seam;
   * production spawns `daemon/advance-child.js`. See {@link AdvanceInput.runner}.
   */
  advanceRunner?: { command: string; args: readonly string[] };
  /**
   * The dark-session sweep (APRV-192), off unless the operator asked for it.
   *
   * Opt-in for the reason `gitEvidence` and `advance` are, though a milder one:
   * it runs `git log` over every worktree of the checkout on a cadence, which
   * on a large repository is real work, and a daemon that started doing it
   * because a default moved under an operator would be the surprise this
   * project exists to prevent. `approval daemon run --dark-sessions` turns it
   * on. It is READ-ONLY against git and appends only its own observations.
   */
  darkSessions?: DarkSessionWatch;
  /**
   * Test seam for the sweep's observer: an answer that does not run git. The
   * daemon never sets it, exactly as it never sets `today`.
   */
  observeGit?: DarkSessionSweepOptions["observe"];
  /** The day the records branch is named for. Injected by tests. */
  today?: string;
  /**
   * Publish a verified-head snapshot beside the log on every clean read
   * (APRV-188). On unless explicitly set to `false`.
   *
   * On by default, unlike `gitEvidence` and `advance`, because it changes
   * nothing outside this machine: the file is derived, local, byte-endorsing
   * state that every reader re-proves and any reader may ignore. Turning it off
   * costs hook latency and nothing else.
   */
  snapshot?: boolean;
  /**
   * Which prefix proof this loop's verified reads run (APRV-217).
   *
   * Absent means `full`: every read re-hashes the whole proved prefix, which is
   * the behaviour of every release before this one. The CLI resolves it from
   * the `daemon` policy block and the `--read-proof` family, flag first, and
   * hands the answer down here so the loop itself reads no policy for it and
   * cannot drift from the mode its `started` line printed.
   */
  readProof?: { mode: "full" | "incremental"; everyReads: number; afterMs: number };
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

/**
 * A verified read that came back clean: the records and the head the drift scan
 * decides from (APRV-211). Never the evidence an append is compared against —
 * see {@link Daemon.scanForDrift} on why that is always a fresh read.
 */
type VerifiedRead = Extract<ReadRecordsResult, { ok: true }>;

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
 * The Backlog.md board key a task file's name begins with (`task-3 - Slug.md`).
 *
 * Used for one question only (APRV-63): a file that has lost its frontmatter
 * entirely leaves no id anywhere, so the name is the only handle left with
 * which to ask the log whether this task ever registered anything. The answer,
 * and the id every record is written under, come from the log.
 */
function taskIdFromFileName(path: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)/u.exec(basename(path));
  return match?.[1] ?? null;
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
  /** Epoch ms of the last advance ATTEMPT, refusals included (APRV-204). */
  private lastAdvanceAt: number | null = null;
  private lastAdvance: AdvanceAttempt | null = null;
  /** How many substantive records were owed at the last attempt. */
  private lastAdvanceOwed: number | null = null;
  /**
   * Where the owed span ENDED at the last attempt (APRV-233).
   *
   * The count trigger measures against this inside the interval, so records an
   * attempt has already tried to publish are not counted a second time towards
   * publishing them again.
   */
  private lastAdvanceSpanEnd: number | null = null;
  /**
   * The advance whose git work is still running in a child (APRV-211).
   *
   * One slot, and a tick that finds it taken makes no attempt at all: two
   * advances against one log would race for the append lock and for the records
   * branch, and the second would have nothing to publish anyway.
   */
  private advanceInFlight: Promise<void> | null = null;
  /**
   * An advance outcome this process observed and could not record (APRV-233).
   *
   * The 2026-09-02 residue: a hook's record landed between `recordFinish`'s
   * read and its append, the bounded retry was spent, and the execution stayed
   * open. The outcome is a fact this process holds and the log does not, so it
   * is carried here and settled at the top of the next tick, before any trigger
   * is looked at. Nothing else may advance while it stands.
   */
  private pendingAdvanceFinish: PendingAdvanceFinish | null = null;
  /** The dangling advance cycle this process has already warned about once. */
  private reportedDangling: string | null = null;
  /** Epoch ms of the last dark-session sweep (APRV-192); `null` before the first. */
  private lastDarkSweepAt: number | null = null;
  private reportedEscalations = new Set<string>();
  /** Verified reads made during the current tick (APRV-211). Reset at tick start. */
  private reads = 0;
  /** Did any of this tick's own reads hash the whole prefix (APRV-217)? */
  private fullReproofThisTick = false;
  /** Basenames {@link writeBack} placed this tick, so the watcher can ignore them. */
  private selfWrites = new Set<string>();
  /** The previous tick's, kept one generation: watch events arrive after the write. */
  private previousSelfWrites = new Set<string>();
  private settle: ((outcome: DaemonOutcome) => void) | null = null;
  private finished = false;

  constructor(options: DaemonOptions) {
    this.options = options;
  }

  /** Run until stopped (or, with `once`, for exactly one tick). */
  run(): Promise<DaemonOutcome> {
    return new Promise<DaemonOutcome>((resolve) => {
      this.settle = resolve;
      // The cadence clock starts when the daemon does (APRV-204), so a restart
      // does not publish a records branch the moment it comes up: a daemon
      // restarted in a loop would otherwise open a pull request per restart.
      // The RECORD-COUNT trigger is unaffected, which is what keeps a busy
      // repository from waiting out an interval it does not need to.
      const started = Date.parse(readClock(this.clockOptions()));
      this.lastAdvanceAt = Number.isNaN(started) ? 0 : started;

      if (!this.options.once) this.attachWatchers();
      this.emit({
        event: "started",
        log: this.display(this.options.logPath),
        tasks: this.display(this.options.tasksDir),
        queue: this.display(this.options.queuePath),
        interval_ms: this.options.intervalMs,
        debounce_ms: this.options.debounceMs,
        watching: this.watching,
        read_proof: this.options.readProof?.mode ?? "full",
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

    // The shutdown flush (APRV-204). A clean stop with unpublished records
    // publishes them before it goes: the daemon is the log's writer, and a
    // writer that exits leaving hours of records on nobody's branch hands the
    // problem back to whoever has to remember. Only on a CLEAN stop — the three
    // failure outcomes are all "this log is not fit to be committed from", and
    // the advance would refuse them a second time anyway.
    //
    // Synchronous, inside the shutdown path, before the `stopped` line: the
    // advance is `spawnSync` throughout, so there is nothing to await and
    // nothing that could outlive the process.
    if (outcome.kind === "stopped") {
      // An advance whose child is still running (APRV-211). The flush below
      // declines to start a second one, and this says so rather than letting a
      // dangling `execution.started` be discovered later by a reader of the log:
      // the child settles and the execution is closed if this process outlives
      // it, and does not if it does not.
      if (this.advanceInFlight !== null) {
        this.warn(
          "advance-refused",
          "an advance was still running in a child when the daemon stopped; its outcome is recorded only if this process outlives it, and `approval status` shows the execution as open until then",
        );
      }
      try {
        this.advanceIfDue(true);
      } catch (cause) {
        // A flush that throws must not stop the daemon from stopping.
        this.warn("advance-refused", `the shutdown flush threw: ${errorMessage(cause)}`);
      }
    }

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
   *
   * ## Ignoring the daemon's own hand (APRV-211)
   *
   * Two of the files in these directories are written by this loop itself: the
   * verified-head snapshot beside the log (`verified-head.json` and its temp
   * file, published on every clean read) and the task files {@link writeBack}
   * repairs. A watcher that fires on those schedules a tick whose only cause was
   * the previous tick, and the daemon wakes itself forever: measured at 18 ticks
   * in 45 seconds against a ten-minute interval, with no other writer.
   *
   * So the log-directory watcher schedules only for the log file itself (or for
   * an event that names no file, which is the platform saying "something here
   * changed" and must still be believed), and the tasks watcher ignores the
   * basenames this daemon just placed.
   *
   * This is safe for exactly the reason stated in the module header: correctness
   * never depended on the watcher. Every tick re-scans the folder and re-derives
   * everything from the verified log, and the periodic tick runs regardless
   * (SPEC.md §10.2). The worst an over-eager filter can cost is latency on a
   * change that arrives inside the same window as one of the daemon's own
   * writes, and the next periodic tick collects it.
   */
  private attachWatchers(): void {
    if (this.watchAttempted) return;
    this.watchAttempted = true;
    const logName = basename(this.options.logPath);
    const ownTempFile = new RegExp(`^\\..*\\.tmp-${String(process.pid)}-\\d+$`, "u");
    const triggers = {
      // A rename or a save the daemon did not make. `null` (or an undefined
      // name) is a platform that will not say which file moved: believe it.
      tasks: (_event: string, name: string | null): void => {
        if (name !== null && name !== undefined) {
          if (this.selfWrites.has(name) || this.previousSelfWrites.has(name)) return;
          // `core/task-file.ts` places a file through `.<name>.tmp-<pid>-<n>`
          // in the same directory, and that temp file's create and rename are
          // two more events about a write this process made.
          if (ownTempFile.test(name)) return;
        }
        this.schedule();
      },
      log: (_event: string, name: string | null): void => {
        if (name !== null && name !== undefined && name !== logName) return;
        this.schedule();
      },
    };
    for (const [label, dir] of [
      ["tasks", this.options.tasksDir],
      ["log", dirname(this.options.logPath)],
    ] as const) {
      try {
        const watcher = watch(dir, { persistent: true }, triggers[label]);
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
   * One full pass: drift scan, TTL sweep, write-back, escalation surfacing,
   * queue render.
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
    const startedAt = performance.now();
    const phases = {
      drift: 0,
      ttl: 0,
      audit: 0,
      dark: 0,
      prune: 0,
      write_back: 0,
      advance: 0,
      escalations: 0,
      render: 0,
    };
    /** Time `step`, add it to `phase`, and hand back what it returned. */
    const timed = <T>(phase: keyof typeof phases, step: () => T): T => {
      const from = performance.now();
      try {
        return step();
      } finally {
        phases[phase] += performance.now() - from;
      }
    };
    try {
      this.ticks += 1;
      this.reads = 0;
      this.fullReproofThisTick = false;
      // One generation of the daemon's own task-file writes is kept, because a
      // watch event arrives after the write that caused it and often after the
      // tick that made it has ended.
      this.previousSelfWrites = this.selfWrites;
      this.selfWrites = new Set<string>();
      // Late-attaching watchers: a log directory (or a task folder) created after
      // startup becomes watchable, and the operator gets the latency back.
      if (!this.options.once && !this.watching) {
        this.watchAttempted = false;
        this.attachWatchers();
      }

      const opening = this.read();
      if (!opening.ok) return this.fatal(opening);

      const drift = timed("drift", () => this.scanForDrift());
      if (drift.stop !== null) return drift.stop;

      const expired = timed("ttl", () => this.sweepTtl());
      if (expired.stop !== null) return expired.stop;

      // Audit sampling (APRV-40, SPEC.md §5.2/§10.2). Placed before the closing
      // read and the render so a sample appended here is counted by this tick's
      // head and shows up in this tick's `audit_backlog`. It decides nothing:
      // `daemon/audit.ts` re-derives eligibility from the verified log and every
      // append is a compare-and-append.
      timed("audit", () =>
        sweepAuditSampling({
          logPath: this.options.logPath,
          policy: this.options.policy,
          cwd: this.options.cwd,
          ...(this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir }),
          ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
          warn: (message) => this.warn("append-refused", message),
          // One line per sample appended (APRV-57). The sweep names no event; it
          // hands back what it wrote and the loop says it in the loop's own words.
          sampled: (sample) =>
            this.emit({
              event: "sampled",
              action_key: sample.candidate.actionKey,
              task: sample.candidate.task,
              seq: sample.record.seq,
              subject_seq: sample.candidate.seq,
            }),
        }),
      );

      // The dark-session sweep (APRV-192), on its own cadence. Placed with the
      // audit sweep because it is the same kind of thing — a detective control
      // that re-derives its whole question from the verified log and the world,
      // appends what is new, and changes no verdict. It runs BEFORE the prune so
      // that an observation it appends is counted by this tick's closing head.
      timed("dark", () => {
        this.sweepDark();
      });

      // Payload retention (APRV-41), after the TTL sweep so a request expired on
      // this tick is judged against the record the sweep just wrote. The pruner
      // owns the rule, the append and the unlink; the daemon owns only the
      // scheduling, which is the one thing `daemon/prune.ts` deliberately lacks.
      timed("prune", () => {
        this.prune();
      });

      // Projection write-back (SPEC.md §6.3, APRV-62). Last, because it copies
      // the log into the files and every append this tick can make has now been
      // made: a request expired by the sweep above is reflected on disk by this
      // same tick rather than surfacing as drift on the next one. It appends
      // nothing itself, so its position cannot affect any record.
      const wrote = timed("write_back", () => this.writeBack());
      if (wrote !== null) return wrote;

      // The cadence advance (APRV-204), after every append this tick can make
      // and before the closing read, so the head this tick reports is the head
      // the advance published against. It appends through the gate rather than
      // through this loop, and everything it appends is picked up by the read
      // below like any other writer's.
      timed("advance", () => {
        this.advanceIfDue(false);
      });

      const closing = this.read();
      if (!closing.ok) return this.fatal(closing);
      const escalated = timed("escalations", () => this.surfaceEscalations(closing.records));

      timed("render", () => {
        this.render();
      });
      this.options.gitEvidence?.commit(closing.head);

      this.emit({
        event: "tick",
        n: this.ticks,
        head: closing.head === null ? null : closing.head.seq,
        drift: drift.appended,
        expired: expired.appended,
        escalated,
        ms: Math.round((performance.now() - startedAt) * 10) / 10,
        reads: this.reads,
        reproof: this.fullReproofThisTick ? "full" : "incremental",
        phases: {
          drift: Math.round(phases.drift * 10) / 10,
          ttl: Math.round(phases.ttl * 10) / 10,
          audit: Math.round(phases.audit * 10) / 10,
          dark: Math.round(phases.dark * 10) / 10,
          prune: Math.round(phases.prune * 10) / 10,
          write_back: Math.round(phases.write_back * 10) / 10,
          advance: Math.round(phases.advance * 10) / 10,
          escalations: Math.round(phases.escalations * 10) / 10,
          render: Math.round(phases.render * 10) / 10,
        },
      });
      return null;
    } finally {
      this.ticking = false;
    }
  }

  // -------------------------------------------------------------------------
  // The dark-session sweep (APRV-192)
  // -------------------------------------------------------------------------

  /**
   * Ask git what happened, and the log whether it was told.
   *
   * On its own interval rather than every tick: the tick is 30 seconds by
   * default and a `git log` per worktree at that rate is work spent to re-read
   * an unchanged answer. The interval is a floor and never a ceiling — a sweep
   * missed because the daemon was down is simply made by the next one, since
   * the sweep holds no cursor and re-derives its whole question from the window
   * it is given.
   *
   * The daemon owns the SCHEDULING and nothing else, which is the division the
   * drift scan, the TTL sweep and the audit sweep already keep.
   */
  private sweepDark(): void {
    const watch = this.options.darkSessions;
    if (watch === undefined) return;

    const now = Date.parse(readClock(this.clockOptions()));
    if (
      this.lastDarkSweepAt !== null &&
      !Number.isNaN(now) &&
      now - this.lastDarkSweepAt < watch.intervalMs
    ) {
      return;
    }
    this.lastDarkSweepAt = Number.isNaN(now) ? 0 : now;

    const read = this.read();
    const result = sweepDarkSessions({
      logPath: this.options.logPath,
      root: this.options.cwd,
      policy: this.options.policy,
      ...(this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir }),
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.observeGit === undefined ? {} : { observe: this.options.observeGit }),
      windowMs: watch.windowMs,
      records: read.ok ? read.records : null,
      ...(read.ok ? {} : { logDetail: read.message }),
    });

    for (const entry of result.appended) {
      this.emit({
        event: "dark_session",
        verdict: "dark",
        subject: entry.finding.subject,
        branch: entry.finding.branch,
        code: entry.finding.code ?? "no-records",
        commits: entry.finding.commits,
        seq: entry.seq,
        already_recorded: false,
        message: entry.finding.detail,
      });
    }
    for (const finding of result.repeated) {
      this.emit({
        event: "dark_session",
        verdict: "dark",
        subject: finding.subject,
        branch: finding.branch,
        code: finding.code ?? "no-records",
        commits: finding.commits,
        seq: null,
        already_recorded: true,
        message: finding.detail,
      });
    }
    for (const finding of result.undetermined) {
      this.emit({
        event: "dark_session",
        verdict: "undetermined",
        subject: finding.subject,
        branch: finding.branch,
        code: finding.code ?? "git-unavailable",
        commits: finding.commits,
        seq: null,
        already_recorded: false,
        message: finding.detail,
      });
      this.warn(
        "dark-session-undetermined",
        `the dark-session sweep could not establish ${finding.subject} (${finding.code ?? "?"}): ${finding.detail}`,
      );
    }
    for (const message of result.refusals) this.warn("append-refused", message);
  }

  // -------------------------------------------------------------------------
  // The cadence advance (APRV-204)
  // -------------------------------------------------------------------------

  /**
   * Advance the log if the cadence says it is due, or if this is the flush.
   *
   * The trigger, in one place: enough SUBSTANTIVE records have accrued
   * (`afterRecords`), or the interval has elapsed since the last attempt and at
   * least one substantive record is owed. "Substantive" excludes the advance
   * cycle's own bookkeeping — see `daemon/advance.ts` on why counting it would
   * make an idle repository advance forever.
   *
   * The last-attempt clock is set for every attempt, successful or not, which
   * is what keeps a refusal off the hot path: a gate that says no costs one
   * attempt per interval and no more.
   *
   * The flush ignores the interval and the count, and only the interval and the
   * count: it still asks the gate, and it still does nothing when nothing is
   * owed.
   */
  private advanceIfDue(flush: boolean): void {
    const cadence = this.options.advance;
    if (cadence === undefined) return;
    // An advance is already running in a child (APRV-211). Its records are not
    // on a branch yet and its execution is not closed yet, so a second attempt
    // now would ask about work that is already authorised and already moving.
    if (this.advanceInFlight !== null) return;

    const read = this.read();
    if (!read.ok) return;
    const root = this.options.cwd;
    const today = this.options.today ?? readClock(this.clockOptions());
    const input: AdvanceInput = {
      logPath: this.options.logPath,
      cwd: root,
      policy: this.options.policy,
      cadence,
      ...(this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir }),
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.today === undefined ? {} : { today: this.options.today }),
      ...(this.options.advanceRunner === undefined ? {} : { runner: this.options.advanceRunner }),
    };

    // APRV-233, first: an outcome this process observed and could not record.
    // It is settled BEFORE any trigger is evaluated, on the head as it stands
    // now, and this tick does nothing else either way — a tick that both closed
    // an old cycle and opened a new one would be reasoning about a log it read
    // before it wrote to it.
    if (this.pendingAdvanceFinish !== null) {
      const settled = settleAdvanceFinish(input, this.pendingAdvanceFinish);
      if (settled.ok) {
        this.pendingAdvanceFinish = null;
        this.emit({
          event: "advance",
          outcome: "nothing-owed",
          records_pending: 0,
          records_branch: null,
          range: null,
          commit: null,
          pr_url: null,
          pr_created: false,
          rebuilt: false,
          rebuilt_on: null,
          code: "advance-settled",
          message: settled.message,
          flush,
        });
      } else {
        this.warn("advance-refused", settled.message);
      }
      return;
    }

    // APRV-233, and the same rule for a cycle this process does not remember:
    // an advance whose outcome nobody recorded is reconciled from the git
    // evidence before anything else is attempted, and refused (never re-run)
    // when the evidence is not there. On 2026-09-02 the absence of this made
    // the next tick's authorization reach `startExecution` on the open key and
    // come back `already-executed`, which reported a failure and fixed nothing.
    const reconciled = reconcileDanglingAdvance(input, read.records);
    if (reconciled !== null) {
      if (reconciled.settled) {
        this.emit({
          event: "advance",
          outcome: "nothing-owed",
          records_pending: 0,
          records_branch: null,
          range: null,
          commit: null,
          pr_url: null,
          pr_created: false,
          rebuilt: false,
          rebuilt_on: null,
          code: "advance-reconciled",
          message: reconciled.message,
          flush,
        });
      } else if (this.reportedDangling !== reconciled.actionKey) {
        // Once per cycle, not once per tick: an operator needs to be told, and
        // being told every thirty seconds forever is how a warning stops being
        // read.
        this.reportedDangling = reconciled.actionKey;
        this.warn("advance-refused", reconciled.message);
      }
      return;
    }
    this.reportedDangling = null;

    const state = publishedState(root, this.options.logPath, read.records, cadence, today);
    if (state.substantive === 0) return;

    // The flush does not re-ask a question this process just asked. A tick
    // whose advance was gated or refused leaves a request in the queue; a flush
    // a moment later, against the same owed records, would put a SECOND
    // identical question in front of the same human. Measured in SUBSTANTIVE
    // records rather than in head seq, because the gated attempt's own request
    // moved the head and answered nothing. The retry is the next tick's
    // business, and the next daemon's.
    if (
      flush &&
      this.lastAdvance !== null &&
      this.lastAdvance.outcome !== "advanced" &&
      this.lastAdvanceOwed !== null &&
      state.substantive <= this.lastAdvanceOwed
    ) {
      return;
    }

    const now = Date.parse(readClock(this.clockOptions()));
    const elapsed = this.lastAdvanceAt === null || Number.isNaN(now) || now - this.lastAdvanceAt >= cadence.intervalMs;

    // APRV-233, second: an advance that ALREADY HAPPENED does not get made
    // again inside the interval, and the record-count trigger does not run
    // around the interval for a span an earlier attempt already carried.
    //
    // The 2026-09-02 shape. The advance pushed `records-log-2026-09-02` and its
    // `execution.completed` lost the append race, so the only thing left saying
    // that a branch had just been pushed was an in-process clock — and the
    // count trigger, alone among the two, never consulted it. Ticks two, five
    // and eight each pushed the same branch again, ninety seconds apart, under
    // a fifteen-minute interval (the three-tick spacing is the one in-flight
    // slot: the two ticks in between found a child still running).
    //
    // An advance cycle still open in the log has already returned above, so
    // what is left is the trigger itself: inside the interval, the count
    // trigger fires only on records this process has not already attempted to
    // publish. `afterRecords` is the busy-hour trigger and it keeps working;
    // what it no longer does is count the same owed span over and over, which
    // is how four fresh records re-pushed the branch every ninety seconds while
    // the published head stood still.
    const fresh =
      this.lastAdvanceSpanEnd === null
        ? state.substantive
        : read.records.filter(
            (record) =>
              record.seq > Math.max(state.publishedSeq, this.lastAdvanceSpanEnd ?? 0) &&
              !isAdvanceBookkeeping(record),
          ).length;
    if (!flush && fresh < cadence.afterRecords && !elapsed) return;

    this.lastAdvanceAt = Number.isNaN(now) ? 0 : now;
    this.lastAdvanceOwed = state.substantive;
    this.lastAdvanceSpanEnd = state.substantiveSeq;

    // The gate, always here: the `supervised-live` draw reads a secret that
    // `core/child-env.ts` strips from every child, so authorization cannot
    // leave this process (APRV-205, APRV-211).
    const auth = authorizeAdvance(input, read.records);
    if (!auth.authorized) {
      this.reportAdvance(auth.attempt, flush);
      return;
    }

    // The git side effect, which may leave. A blocking `git push` on this stack
    // is a Telegram callback answered past its window (APRV-211), so the
    // periodic tick hands the verb to a child and returns to the loop. The
    // shutdown flush and `--once` keep the synchronous path: the first has no
    // loop left to return to, and the second is a process that exits at the end
    // of this tick, where an advance settling afterwards would be an advance
    // nobody recorded.
    if (flush || this.options.once === true) {
      this.reportAdvance(runAdvanceSync(input, auth), flush);
      return;
    }
    this.advanceInFlight = runAdvanceAsync(input, auth)
      .then((attempt) => {
        this.reportAdvance(attempt, flush);
      })
      .catch((cause: unknown) => {
        this.warn("advance-refused", `the advance child could not be settled: ${errorMessage(cause)}`);
      })
      .finally(() => {
        this.advanceInFlight = null;
      });
  }

  /** Record and report one finished attempt, from either runner. */
  private reportAdvance(attempt: AdvanceAttempt, flush: boolean): void {
    this.lastAdvance = attempt;
    // APRV-233. Held whatever the outcome was, and before the early return: an
    // outcome nobody recorded is the one thing this loop must not forget.
    this.pendingAdvanceFinish = attempt.pendingFinish;
    if (attempt.outcome === "nothing-owed" && attempt.pendingFinish === null) return;

    this.emit({
      event: "advance",
      outcome: attempt.outcome,
      records_pending: attempt.recordsPending,
      records_branch: attempt.recordsBranch,
      range: attempt.range,
      commit: attempt.commit,
      pr_url: attempt.prUrl,
      pr_created: attempt.prCreated,
      rebuilt: attempt.rebuilt,
      rebuilt_on: attempt.rebuiltOn,
      code: attempt.code,
      message: attempt.message,
      flush,
    });
    if (attempt.outcome !== "advanced") {
      this.warn(
        "advance-refused",
        `the cadence advance did not publish (${attempt.outcome}${
          attempt.code === null ? "" : `, ${attempt.code}`
        }): ${attempt.message}`,
      );
    }
  }

  /** The clock this loop reads, as the options every core writer takes it. */
  private clockOptions(): { clock?: Clock } {
    return this.options.clock === undefined ? {} : { clock: this.options.clock };
  }

  /** The last attempt this process made, for a caller that wants to assert on it. */
  lastAdvanceAttempt(): AdvanceAttempt | null {
    return this.lastAdvance;
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

  /**
   * The verified log, and — since APRV-188 — the publication of what was
   * verified.
   *
   * The daemon holds a warm {@link VerifiedReadCache} and re-verifies only the
   * appended tail on every tick. Every hook process, by contrast, starts with an
   * empty cache and walks the whole chain before it may decide anything. So on
   * each clean read this loop publishes a verified-head snapshot beside the log:
   * an endorsement of the exact bytes it just walked, which the next hook
   * process re-proves for itself (one SHA-256) instead of re-walking. See
   * `core/verified-snapshot.ts` for what that endorsement claims and what a
   * reader still checks.
   *
   * The publication rides on the read rather than following it, so the bytes
   * endorsed are the bytes verified: a publisher that re-read the file to hash
   * it could endorse a digest of bytes nobody walked.
   */
  private read(): ReadRecordsResult {
    this.reads += 1;
    // APRV-217. Measured around THIS read, so the tick line reports the path
    // the loop's own reads took: other readers in the same process (the queue
    // renderer) have their own answer and their own line to be judged on.
    const fullBefore = processReadCache.stats.fullReproofs;
    try {
      return this.readOnce();
    } finally {
      if (processReadCache.stats.fullReproofs > fullBefore) this.fullReproofThisTick = true;
    }
  }

  private readOnce(): ReadRecordsResult {
    return readVerifiedRecords(this.options.logPath, {
      ...(this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir }),
      publishSnapshot: this.options.snapshot !== false,
      // APRV-217. Absent on the options means absent here, which the read cache
      // reads as `full`: the daemon asks for the cheaper proof only when an
      // operator's policy or flag said so.
      ...(this.options.readProof === undefined ? {} : { readProof: this.options.readProof }),
    });
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
   * This scan **only records**. The repair is {@link writeBack}, later in the
   * same tick: the disagreement is written to the log first and copied into the
   * file second, in that order, so nothing is ever corrected off the record. A
   * drift record therefore names a moment, not a standing condition.
   *
   * A schema-invalid envelope is warned about and skipped, not logged as drift: a
   * malformed file is not a *contradiction* of the log, it is a file the runtime
   * cannot read a claim out of at all, and inventing a `declared_state` for it
   * would put a fact in the log that nobody wrote.
   */
  private scanForDrift(): { appended: number; stop: DaemonOutcome | null } {
    // ONE verified read for the whole scan (APRV-211). The scan asks the same
    // question of every file — "what does the log say about this task?" — and
    // asking it per file re-verified and re-walked the log once per task file:
    // 210 reads a tick in this repository, 45% of a three-second tick.
    //
    // The read below is the DECISION's evidence. It never becomes an append's:
    // a file the decision finds in drift is re-derived against a fresh read
    // immediately before the append, and that fresh head is the `expectedHead`
    // the append is compared against (SPEC.md §11.1 invariant 5, unchanged).
    // Deciding from a slightly older log can therefore only cost a decision that
    // the fresh derivation then declines to act on; it can never place a record
    // against a head it did not see.
    const scan = this.read();
    if (!scan.ok) return { appended: 0, stop: this.fatal(scan) };

    let appended = 0;
    for (const file of this.taskFiles()) {
      const outcome = this.checkOneFile(file, scan);
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

  private checkOneFile(
    file: string,
    scan: VerifiedRead,
  ): { appended: boolean; stop: DaemonOutcome | null } {
    const read = readTaskFile(file);
    if (!read.ok) {
      if (read.code === "no-frontmatter") {
        // SPEC.md §6: a task with no envelope is valid markdown. Silent by
        // design — unless the log says this task once declared actions, which
        // makes it a loss rather than an absence (APRV-63). The file name is
        // the only id such a file leaves; the log decides whether it means
        // anything.
        const hint = taskIdFromFileName(file);
        if (hint === null) return { appended: false, stop: null };
        return this.reportEnvelopeLoss(file, hint, true, "no-frontmatter", scan);
      }
      this.warn(
        read.code === "io" ? "task-unreadable" : "frontmatter-invalid",
        `${this.display(file)}: ${read.message}`,
      );
      return { appended: false, stop: null };
    }

    const envelope = read.data["approval"];
    if (envelope === undefined) {
      // Frontmatter, no `approval:` key. Ordinary for a task that never had
      // one; envelope loss for a task the log registered (APRV-63).
      const declaredId = read.data["id"];
      const id =
        typeof declaredId === "string" && declaredId.length > 0
          ? declaredId
          : taskIdFromFileName(file);
      if (id === null) return { appended: false, stop: null };
      return this.reportEnvelopeLoss(
        file,
        id,
        typeof declaredId !== "string" || declaredId.length === 0,
        "no-approval-key",
        scan,
      );
    }

    const id = read.data["id"];
    if (typeof id !== "string" || id.length === 0) {
      this.warn(
        "task-id-missing",
        `${this.display(file)} carries an approval: envelope but no usable \`id\`; the task id is the key every log record is written under, so drift cannot be attributed to this file`,
      );
      return { appended: false, stop: null };
    }

    // The read boundary, deliberately (APRV-148). This scan validates envelopes
    // it will never register: a pre-APRV-121 envelope carrying numeric monetary
    // fields was valid when its task was registered and must keep validating
    // here, or drift and loss detection turn silently off for exactly the
    // historical artifacts APRV-121's compatibility rule protects. `approval
    // register` still validates at the strict write boundary.
    const validation = validate(
      "envelope",
      envelope,
      this.options.schemaDir === undefined
        ? { mode: "historical" }
        : { schemaDir: this.options.schemaDir, mode: "historical" },
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

    const ts = readClock(this.options.clock === undefined ? {} : { clock: this.options.clock });
    const ttlMs = this.ttlMs();
    const declaredRaw = (envelope as { state?: unknown }).state;
    const declaredState = typeof declaredRaw === "string" ? declaredRaw : null;
    const envelopeDigest = digestOf(envelope);

    // The decision, from the scan's read.
    const decided = taskEnvelopeState(scan.records, id, ts, ttlMs);
    if (declaredState === decided.state) return { appended: false, stop: null };
    if (
      driftAlreadyLogged(scan.records, id, {
        declaredState,
        derivedState: decided.state,
        envelopeDigest,
      })
    ) {
      return { appended: false, stop: null };
    }

    // Re-read immediately before appending, so the head this append is compared
    // against is the head the RECORDED fact was derived from. The whole decision
    // is remade against those fresh records: a log that moved between the scan
    // and here may have removed the drift (someone decided the request, another
    // writer recorded the same drift), and a record about a disagreement that no
    // longer exists is a record nobody wrote.
    const records = this.read();
    if (!records.ok) return { appended: false, stop: this.fatal(records) };

    const projection = taskEnvelopeState(records.records, id, ts, ttlMs);
    if (declaredState === projection.state) return { appended: false, stop: null };

    const facts: DriftFacts = {
      declaredState,
      derivedState: projection.state,
      envelopeDigest,
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

  /**
   * A task file with no envelope whose task the log registered: the envelope was
   * lost (APRV-63, the defense half of APRV-60).
   *
   * Recorded as `envelope.drift` with `payload.reason: "envelope-missing"` —
   * the same event type, because it is the same §6.3 question ("the file and
   * the log disagree"), and a distinct reason, because the answer is different:
   * a state mismatch is an edit to reconcile, a missing envelope is a deletion
   * to restore. `declared_state` is `null` because the file makes no claim at
   * all, and `envelope_sha256` is absent because there is no envelope to digest.
   *
   * **Nothing is repaired.** The registration in the log holds every action the
   * envelope declared, so a writer *could* re-emit it — and that would turn a
   * projection into a source, which is the one thing the log's authority rests
   * on not happening. The daemon reports; a human restores by hand.
   *
   * `loose` says the id came from the file name rather than from frontmatter;
   * it relaxes only the *matching*, and the record is written under the id the
   * log itself holds.
   */
  private reportEnvelopeLoss(
    file: string,
    id: string,
    loose: boolean,
    kind: "no-frontmatter" | "no-approval-key",
    scan: VerifiedRead,
  ): { appended: boolean; stop: DaemonOutcome | null } {
    // The decision, from the scan's read (APRV-211). This is the path the vast
    // majority of task files take — a plain Backlog.md task the log never
    // registered — and it used to cost one full verified read per file.
    const scanned = latestRegistration(scan.records, id, loose);
    if (scanned === null) {
      // The log has never heard of this task. SPEC.md §6: a task with no
      // envelope is valid markdown, and this one is exactly that.
      return { appended: false, stop: null };
    }

    const ts = readClock(this.options.clock === undefined ? {} : { clock: this.options.clock });
    const ttlMs = this.ttlMs();

    // Re-read immediately before appending, exactly as the mismatch path does:
    // the head this append is compared against is the head the recorded fact was
    // derived from, and the whole decision is remade against it.
    const records = this.read();
    if (!records.ok) return { appended: false, stop: this.fatal(records) };

    const registration = latestRegistration(records.records, id, loose);
    if (registration === null) return { appended: false, stop: null };
    const task = registration.task;
    if (typeof task !== "string" || task.length === 0) return { appended: false, stop: null };

    const projection = taskEnvelopeState(records.records, task, ts, ttlMs);
    const facts: DriftFacts = {
      declaredState: null,
      derivedState: projection.state,
      envelopeDigest: null,
      reason: "envelope-missing",
    };
    if (driftAlreadyLogged(records.records, task, facts)) return { appended: false, stop: null };

    const payload: Record<string, unknown> = {
      file: this.display(file),
      declared_state: null,
      derived_state: facts.derivedState,
      registered: projection.registered,
      reason: "envelope-missing",
      missing: kind,
      registered_seq: registration.seq,
    };

    const result = appendEvent(
      this.options.logPath,
      { ts, event: "envelope.drift", actor: DAEMON_ACTOR, task, payload },
      {
        ...(this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir }),
        expectedHead: records.head,
      },
    );
    if (!result.ok) {
      this.warn(
        "append-refused",
        `envelope.drift (envelope-missing) for ${task} was not appended (${result.error.code}): ${result.error.message}`,
      );
      return { appended: false, stop: null };
    }

    this.drifts += 1;
    this.emit({
      event: "drift",
      task,
      file: this.display(file),
      declared_state: null,
      derived_state: facts.derivedState,
      seq: result.record.seq,
      reason: "envelope-missing",
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
    const report = prunePayloads(options);
    // Successes first, so the narrative reads in the order the pass ran them: a
    // prune that appended and could not unlink is a warning below, never a line
    // here (APRV-57).
    for (const done of report.pruned) {
      this.emit({
        event: "pruned",
        payload_hash: done.candidate.hash,
        reason: done.candidate.reason,
        action_key: done.candidate.actionKey,
        task: done.candidate.task,
        seq: done.seq,
      });
    }
    for (const warning of report.warnings) {
      this.warn("prune-refused", `${warning.code}: ${warning.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Projection write-back (SPEC.md §6.3, §10.2, APRV-62)
  // -------------------------------------------------------------------------

  /**
   * Rewrite every task file whose `state:` disagrees with the log, so the
   * projection says what the log says.
   *
   * §6.3: "`state` is a projection of log events; the file is updated by the
   * daemon after the event is appended, never the reverse." Both halves are
   * enforced structurally here. *After the event*: this runs at the end of the
   * tick, when the drift scan and the TTL sweep have appended everything they
   * are going to. *Never the reverse*: this method appends nothing at all, reads
   * the state it writes from `daemon/projection.ts`'s rollup over the verified
   * log, and produces bytes only through `core/task-file.ts`. A file can no more
   * teach the log a state than a screenshot can teach a database a row.
   *
   * Four rules, each of which is a way of not making things worse:
   *
   * 1. **Only files that already have an envelope.** `set-state` refuses
   *    `no-envelope`, and that refusal is honoured silently: a task with no
   *    `approval:` key is a plain Backlog.md task (SPEC.md §6 requires tolerating
   *    it), and a daemon that gave one an envelope would be enrolling a task
   *    nobody enrolled. The register path is where an envelope comes from.
   * 2. **No write when the bytes would not change.** The writer reports
   *    `changed`, and the bytes are compared besides. An unnecessary write moves
   *    an mtime, which wakes the watcher, which schedules a tick — a loop that
   *    costs nothing but looks exactly like one that does not terminate.
   * 3. **A refusal leaves the file alone.** Anything the round-trip writer will
   *    not do — corrupt YAML, an `approval:` key that is not a mapping, a
   *    self-check that failed — becomes one `write-back-refused` warning carrying
   *    the writer's own code. Nothing partial is ever written, because
   *    `rewriteTaskFile` produces bytes or a refusal and `writeTaskFileAtomic`
   *    renames a complete temp file into place.
   * 4. **Silence where the drift scan already spoke.** An unreadable file, a
   *    frontmatter that does not parse, a missing `id`, a schema-invalid
   *    envelope: each was warned about a few milliseconds ago by
   *    {@link scanForDrift} over the same folder. Repeating it here would double
   *    every line an operator reads without adding a fact.
   *
   * Loop safety comes from the comparison, not from a remembered flag: the next
   * tick derives the same state from the same log, finds the file already
   * declaring it, and does nothing — no drift, no write, no event. A file that
   * *keeps* needing repair is being rewritten by something else, and the drift
   * records are the trail of that fight.
   */
  private writeBack(): DaemonOutcome | null {
    const files = this.taskFiles();
    if (files.length === 0) return null;

    const records = this.read();
    if (!records.ok) return this.fatal(records);
    const ts = readClock(this.options.clock === undefined ? {} : { clock: this.options.clock });
    const ttlMs = this.ttlMs();
    const rewriteOptions: RewriteOptions =
      this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir };

    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // Warned by the drift scan, or a file that vanished between the two
        // passes. Either way the next tick re-scans.
        continue;
      }

      const parsed = parseFrontmatter(text);
      if (!parsed.ok) continue;

      const envelope = parsed.data["approval"];
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) continue;

      const id = parsed.data["id"];
      if (typeof id !== "string" || id.length === 0) continue;

      // Read boundary, as in the drift scan above (APRV-148): a historical
      // envelope the scan just read a claim out of must also be repairable, or
      // the drift it records stands forever.
      const validation = validate(
        "envelope",
        envelope,
        this.options.schemaDir === undefined
          ? { mode: "historical" }
          : { schemaDir: this.options.schemaDir, mode: "historical" },
      );
      if (!validation.ok) continue;

      const declaredRaw = (envelope as { state?: unknown }).state;
      const declaredState = typeof declaredRaw === "string" ? declaredRaw : null;
      const derived = taskEnvelopeState(records.records, id, ts, ttlMs).state;
      if (declaredState === derived) continue;

      const rewritten = rewriteTaskFile(text, { kind: "set-state", state: derived }, rewriteOptions);
      if (!rewritten.ok) {
        if (rewritten.code === "no-envelope") continue;
        this.warn(
          "write-back-refused",
          `${this.display(file)}: the state: line could not be rewritten to ${derived} (${
            rewritten.code
          }): ${rewritten.message} The file is exactly as it was, the log is unchanged, and the envelope.drift record stands.`,
        );
        continue;
      }
      if (!rewritten.changed || rewritten.bytes === text) continue;

      const written = writeTaskFileAtomic(file, rewritten.bytes);
      if (!written.ok) {
        this.warn(
          "write-back-refused",
          `${this.display(file)}: the rewritten task file could not be placed (${written.code}): ${
            written.message
          }`,
        );
        continue;
      }

      // The watcher is about to see this file change; the change was ours
      // (APRV-211). Recorded by basename because that is what `fs.watch` reports.
      this.selfWrites.add(basename(file));

      this.emit({
        event: "write_back",
        task: id,
        file: this.display(file),
        from: declaredState,
        to: derived,
        bytes: written.bytes,
      });
    }

    return null;
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
