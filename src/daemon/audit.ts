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
 * holds no state at all — no seen-set, no cursor, no cache.
 *
 * ## Reporting, and why it goes through `warning`
 *
 * The sweep reports failures through the daemon's existing `warning` channel and
 * emits no event of its own. Successful samples are visible where they matter:
 * `QUEUE.md`'s sampled-audit backlog is regenerated later in the same tick, and
 * the daemon's `rendered` event carries `audit_backlog`, so a sample appended
 * here shows up as a backlog that grew. That keeps `DaemonEvent` — a frozen
 * shape an operator's log pipeline branches on — unchanged by this task.
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

import { sampleSupervised, type AuditOptions } from "../core/audit.js";
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
   * One FAILURE line: an append the sampler could not make, or a log it could
   * not read. Mapped by the caller onto its own warning vocabulary.
   */
  warn(message: string): void;
  /**
   * One CONFIGURATION line: sampling is switched off and here is why. Optional,
   * and the daemon does not pass it — see the module header. `approval status`
   * reports the same fact standingly, from the same resolver.
   */
  notice?(message: string): void;
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

/** Reset the once-per-process notice. Exported for tests, used nowhere else. */
export function resetAuditSweepNotices(): void {
  reported.clear();
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
  return { sampled: result.appended.length, disabled: null };
}
