/**
 * The daemon's audit-sampling sweep (SPEC.md §10.2: "samples supervised actions
 * for audit").
 *
 * `daemon/daemon.ts` calls {@link sweepAuditSampling} once per tick and nothing
 * else. The scheduling question — when to look — is the daemon's; every other
 * question is answered in `core/audit.ts` and `core/sampler.ts`, which is the
 * same division the drift scan and the TTL sweep already follow: the daemon
 * decides nothing of its own.
 *
 * ## Why the sweep is idempotent without remembering anything
 *
 * `core/audit.ts` re-derives the candidate set from the verified log every call
 * and subtracts the subjects already sampled. A tick that samples nothing new is
 * the normal case; a restarted daemon, a second daemon, and an operator running
 * a sweep by hand all converge on exactly the same set. This module therefore
 * holds no state that any APPEND depends on: no seen-set, no cursor, no cache.
 * The two process-lifetime sets below are output bookkeeping (which notice has
 * been printed, which deferral was promised), and every decision about what to
 * append is made from the log on every call.
 *
 * ## Reporting, and why it goes through `warning`
 *
 * The sweep reports failures through the daemon's existing `warning` channel.
 * Successful samples were originally left implicit, visible only as `QUEUE.md`'s
 * sampled-audit backlog and the `rendered` event's `audit_backlog` growing later
 * in the same tick, which is what let APRV-40 leave `DaemonEvent` untouched.
 * APRV-57 grew that union additively, so a sample now also reports through the
 * optional {@link AuditSweepOptions.sampled} sink, which the daemon renders as
 * its `sampled` line. Both channels remain the caller's: this module names no
 * event and writes to no stream.
 *
 * ## A deferred sample is not a lost one (APRV-381)
 *
 * On 2026-09-19 a tick printed `append-refused audit sampling: append-failed:
 * audit.sampled for hook:…:vcs.push.main was not appended (lock-timeout)` while a
 * lane's hook append and a records advance were writing the same log. Nothing was
 * lost, and the next ticks appended the sample; the operator reading the window
 * had no way to know that, because the line said an audit record had not been
 * written and stopped there.
 *
 * So the two outcomes are now said differently. `core/audit.ts` classifies
 * `lock-timeout` and `head-moved` as transient (see its `TRANSIENT_APPEND_CODES`)
 * and hands them back on `deferred`; this module reports each on {@link
 * AuditSweepOptions.defer} with the action key and the fact that the next tick
 * retries it, and reports everything else on {@link AuditSweepOptions.warn} in
 * the form it always had. When the caller passes no `defer` sink the deferral
 * goes to `warn` instead: a deferral nobody prints is indistinguishable, to the
 * person who has to trust this log, from a sample that was dropped.
 *
 * The retry is then named as one. `pendingSamples` re-derives pendency from the
 * verified log, so the retry needs no memory to HAPPEN; saying "this is the retry
 * of what I deferred" is a fact about this process's own output, and it is kept
 * here as such (see {@link rememberDeferral}).
 *
 * ## The lock wait: skip and retry, at `core/log.ts`'s own 2000 ms (APRV-381)
 *
 * The daemon is the one writer that could afford to wait longer, and it
 * deliberately does not. Four reasons, recorded here because the number itself is
 * a one-line change and the reasoning is not:
 *
 * 1. A tick is serial. This sweep sits between the TTL sweep and the queue
 *    render, so every millisecond it blocks is a millisecond an expiry line, a
 *    `state:` write-back and `QUEUE.md` wait. A longer wait spends latency a
 *    person notices on a record that costs nothing to postpone.
 * 2. The contenders hold the lock for spans no polite wait covers. `approval log
 *    advance` holds it across a whole verify-and-commit, `approval log sync`
 *    across a baseline move. A wait long enough to win those races reliably is a
 *    wait long enough to stall the loop for seconds, and it would still time out
 *    sometimes, so the transient path has to exist either way.
 * 3. Deferring loses nothing, provably. The sample's pendency is a property of
 *    the log (eligible, selected, no `audit.sampled` yet), not of this process, so
 *    the retry bound is the tick interval, and an append by anyone else also wakes
 *    the log watcher, which usually makes it the next debounce.
 * 4. The appends this sweep contends with are the ones somebody is waiting on: a
 *    hook's gate verdict, a lane's execution record, an advance's commit. The
 *    writer with nobody blocked on it is the writer that should yield.
 *
 * "Skip" here means letting the append refuse and classifying the refusal. It
 * explicitly does NOT mean peeking at `events.jsonl.lock` before sweeping: that
 * read can be wrong in both directions (a lock released a microsecond later, a
 * lock taken a microsecond after the peek), and `appendEvent`'s own acquisition
 * under the lock is the only authority on whether an append can be made.
 *
 * ## A disabled sampler is not a failure
 *
 * When no sampling secret is configured, `core/sampler.ts` returns a disabled
 * sampler with a machine-readable reason. That is a standing configuration fact,
 * not an error, so it is NOT routed through the failure channel: a warning that
 * fires every tick for something the operator chose is noise that trains them to
 * scroll past the channel that also carries real refusals. It is reported
 * instead through the optional {@link AuditSweepOptions.notice} sink (once per
 * reason per process), and standingly by `approval status`, which is where an
 * operator goes to ask what is switched on. See `core/sampler.ts` for why an
 * unconfigured sampler disables sampling rather than escalating everything.
 */

import {
  sampleSupervised,
  type AuditOptions,
  type SampleAppended,
  type SampleDeferred,
} from "../core/audit.js";
import type { Clock } from "../core/clock.js";
import type { SamplerDisabledReason } from "../core/sampler.js";

/** What the daemon hands the sweep. Everything is injected; nothing is ambient. */
export interface AuditSweepOptions {
  logPath: string;
  /** Policy location, with `loadPolicy`'s semantics. */
  policy: { dir?: string; file?: string };
  /** Reported relative to this, and the fallback policy directory. */
  cwd: string;
  schemaDir?: string;
  /** The write-boundary clock (amended SPEC.md §8). */
  clock?: Clock;
  /** Environment the sampling secret is read from. Injected by tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * One FAILURE line: an append the sampler could not make for a reason retrying
   * cannot fix, or a log it could not read. Mapped by the caller onto its own
   * warning vocabulary.
   */
  warn(message: string): void;
  /**
   * One TRANSIENT line: an append that did not happen because another writer held
   * the lock or moved the head, and that the next sweep will make (APRV-381).
   *
   * Optional, and a caller that passes none gets the same text on {@link
   * AuditSweepOptions.warn}: the one thing this module will not do is let a
   * deferral go unsaid. Callers that have a quieter channel for "later" should
   * pass one; the daemon maps it onto its own `sample-deferred` warning code.
   */
  defer?(message: string): void;
  /**
   * One CONFIGURATION line: sampling is switched off and here is why. Optional,
   * and the daemon does not pass it — see the module header. `approval status`
   * reports the same fact standingly, from the same resolver.
   */
  notice?(message: string): void;
  /**
   * One SUCCESS line per `audit.sampled` appended (APRV-57). Optional, and
   * injected exactly as {@link AuditSweepOptions.warn} is, so the sweep still
   * reports in the caller's vocabulary and owns no output of its own.
   *
   * `retry` is true when THIS process deferred this same sample earlier and is
   * now making the append it promised (APRV-381), so the caller can say so. It is
   * a statement about output, never about the record: the appended event is
   * byte-identical either way.
   */
  sampled?(sample: SampleAppended, retry: boolean): void;
}

export interface AuditSweepSummary {
  /** How many `audit.sampled` events this sweep appended. */
  sampled: number;
  /** `null` when sampling ran; the reason when it did not. */
  disabled: SamplerDisabledReason | null;
}

/**
 * Disablement reasons already reported in this process, so a standing
 * configuration fact is stated once rather than every tick. Process-lifetime and
 * memory-only: it is a de-duplicator for *output*, never for appends, and
 * losing it costs one extra warning line and nothing else.
 */
const reported = new Set<string>();

/**
 * Samples this process deferred and has not yet seen appended (APRV-381), keyed
 * by log path and subject hash.
 *
 * Exactly the same standing as {@link reported}: process-lifetime, memory-only,
 * and a de-duplicator for OUTPUT. Nothing here is consulted before an append,
 * gates nothing, and suppresses no line. Losing it (a restart, a second daemon,
 * an operator sweeping by hand) costs the word "retry" on one line and nothing
 * else, which is why the retry itself is derived from the log and never from
 * here.
 *
 * Bounded so a long run cannot accumulate: an entry is dropped when its sample
 * lands, and the oldest is evicted past {@link DEFERRAL_MEMORY_LIMIT} for the
 * candidate that is deferred and then stops being a candidate (a policy edit that
 * drops its class, a rate that no longer selects it). A `Set` iterates in
 * insertion order, so "the oldest" needs no timestamp.
 */
const deferrals = new Set<string>();

/** How many deferred samples this process will remember for the retry wording. */
const DEFERRAL_MEMORY_LIMIT = 256;

function deferralKey(logPath: string, subjectHash: string): string {
  return JSON.stringify([logPath, subjectHash]);
}

function rememberDeferral(logPath: string, subjectHash: string): void {
  const key = deferralKey(logPath, subjectHash);
  if (deferrals.has(key)) return;
  if (deferrals.size >= DEFERRAL_MEMORY_LIMIT) {
    const oldest = deferrals.values().next();
    if (!oldest.done) deferrals.delete(oldest.value);
  }
  deferrals.add(key);
}

/** Whether this process deferred this sample, consuming the memory of it. */
function takeDeferral(logPath: string, subjectHash: string): boolean {
  return deferrals.delete(deferralKey(logPath, subjectHash));
}

/**
 * Reset the once-per-process notice and the deferral memory. Exported for tests,
 * used nowhere else: both are output bookkeeping, so a suite that shares a
 * process needs to be able to start from nothing.
 */
export function resetAuditSweepNotices(): void {
  reported.clear();
  deferrals.clear();
}

/** One sampling sweep. Appends through `core/audit.ts` and decides nothing. */
export function sweepAuditSampling(options: AuditSweepOptions): AuditSweepSummary {
  const auditOptions: AuditOptions = { policy: options.policy };
  if (options.schemaDir !== undefined) auditOptions.schemaDir = options.schemaDir;
  if (options.clock !== undefined) auditOptions.clock = options.clock;
  if (options.env !== undefined) auditOptions.env = options.env;

  const result = sampleSupervised(options.logPath, options.cwd, auditOptions);

  if (!result.ok) {
    // The log is unreadable, torn, or corrupt. The daemon's own read at the top
    // of the tick already stops the loop on all three, so reaching this branch
    // means the log changed mid-tick; it is reported and the next tick decides.
    options.warn(
      `the audit sampling sweep read no usable log (${result.code}): ${result.message}`,
    );
    return { sampled: 0, disabled: null };
  }

  if (!result.sampler.enabled) {
    const key = `${options.logPath}:${result.sampler.reason}`;
    const notice = options.notice;
    if (notice !== undefined && !reported.has(key)) {
      reported.add(key);
      notice(
        `audit sampling is OFF (${result.sampler.reason}): ${result.sampler.message} Supervised actions still execute and are still logged; what is missing is the retrospective human review sample of SPEC.md §5.2. This notice is printed once per reason.`,
      );
    }
    return { sampled: 0, disabled: result.sampler.reason };
  }

  for (const refusal of result.refusals) {
    options.warn(`audit sampling: ${refusal.code}: ${refusal.message}`);
  }

  // The transient half (APRV-381). Said BEFORE the successes of this same sweep
  // are said, because the sweep stops at the first deferral: anything it did
  // append, it appended before the contention, and the reading order should match
  // the order it happened in.
  for (const entry of result.deferred) {
    rememberDeferral(options.logPath, entry.candidate.hash);
    (options.defer ?? options.warn)(deferralLine(entry));
  }

  const sampled = options.sampled;
  for (const entry of result.appended) {
    // Consumed whether or not anyone is listening, so a caller with no `sampled`
    // sink cannot leave a stale deferral behind to mislabel a later sample.
    const retry = takeDeferral(options.logPath, entry.candidate.hash);
    if (sampled !== undefined) sampled(entry, retry);
  }
  return { sampled: result.appended.length, disabled: null };
}

/**
 * The deferral line: what was not appended, why, and that it is coming.
 *
 * "retries it on the next tick" is load-bearing wording. The line an
 * operator read before APRV-381 ended at "was not appended", which is true and
 * reads as a loss; this one has to answer the question that sentence provokes
 * before they go looking for a missing audit record.
 */
function deferralLine(entry: SampleDeferred): string {
  return `audit sampling deferred ${entry.candidate.actionKey} (${entry.append.code}): ${entry.append.message} The sample is NOT lost: it is still pending in the log's own terms (eligible, drawn, no audit.sampled yet), and the sweep retries it on the next tick.`;
}
