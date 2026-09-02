/**
 * The dark-session sweep (APRV-192): the appending half, and only that.
 *
 * `core/dark-session.ts` observes git, resolves the payload store and reaches
 * the verdict. This module does the one thing a reader must not: it writes the
 * observation down. The split is not decorative — `approval doctor` reports the
 * same findings from the same evaluator and must append nothing, and CLAUDE.md
 * names the daemon as the log's single writer.
 *
 * ## What it appends, and what it deliberately does not
 *
 * A `dark` verdict appends one `audit.dark_session` (SPEC.md §8's event set,
 * amended APRV-192), actor `system:daemon`, through `appendEvent` with
 * `expectedHead` (§11.1 invariant 5) and a `ts` read from the injected clock at
 * the write boundary (§11.1 invariant 2). The daemon records what IT saw, as
 * itself; it never writes a record on behalf of the session it is reporting on,
 * which would be fabricating exactly the evidence whose absence is the finding.
 *
 * An `undetermined` verdict appends NOTHING. It is reported on the daemon's
 * event stream, as a warning, and by `approval doctor`, which is where an
 * operator goes to ask what the runtime cannot see. The reasoning is the one
 * `daemon/audit.ts` gives for a disabled sampler: a condition that recurs every
 * tick and that nobody can act on from the record alone is noise, and a log full
 * of "I could not tell" is a log people stop reading. Fail-closed binds the
 * REPORT — an undetermined subject never counts as a pass and never clears
 * `settled` — and not the append.
 *
 * ## Idempotent without remembering anything
 *
 * Same discipline as the audit sweep: no cursor, no seen-set, no state. Each
 * finding carries an observation key (subject plus the state of the world it was
 * seen in), and a key the verified log already carries is not appended again.
 * A restarted daemon, a second daemon and an operator running a sweep by hand
 * all converge on the same set, and a worktree that stays dark across a hundred
 * ticks produces one record until it commits something new.
 */

import { tick as readClock } from "../core/clock.js";
import {
  reportDarkSessions,
  type DarkSessionFinding,
  type DarkSessionReport,
  type DarkSessionSweepOptions,
} from "../core/dark-session.js";
import { appendEvent, type EventRecord } from "../core/log.js";

export type { DarkSessionSweepOptions, DarkSessionWatch } from "../core/dark-session.js";
export {
  DEFAULT_DARK_INTERVAL_MS,
  DEFAULT_DARK_WINDOW_MS,
  reportDarkSessions,
} from "../core/dark-session.js";

/**
 * SPEC.md §8: runtime-originated events carry a `system:` actor, and the daemon
 * is the runtime. The same actor `envelope.drift` is written under, because the
 * same process observed both.
 */
export const DARK_SESSION_ACTOR = "system:daemon";

export interface DarkSessionSweepResult {
  report: DarkSessionReport;
  /** Findings that produced a new `audit.dark_session`, with its seq. */
  appended: readonly { finding: DarkSessionFinding; seq: number }[];
  /** Dark findings whose observation key the log already carried. */
  repeated: readonly DarkSessionFinding[];
  /** Findings that could not be established, with their codes. */
  undetermined: readonly DarkSessionFinding[];
  /** Appends that were refused, as messages for the caller's warning channel. */
  refusals: readonly string[];
}

/** Observation keys already in the verified log. */
function alreadyRecorded(records: readonly EventRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    if (record.event !== "audit.dark_session") continue;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const key = (payload as Record<string, unknown>)["observation_key"];
    if (typeof key === "string") keys.add(key);
  }
  return keys;
}

/**
 * One sweep: observe, judge, append what is new. Decides nothing of its own —
 * the verdict is `core/dark-session.ts`'s and the evidence rule is APRV-151's.
 */
export function sweepDarkSessions(options: DarkSessionSweepOptions): DarkSessionSweepResult {
  const { report, window } = reportDarkSessions(options);

  const appended: { finding: DarkSessionFinding; seq: number }[] = [];
  const repeated: DarkSessionFinding[] = [];
  const undetermined: DarkSessionFinding[] = [];
  const refusals: string[] = [];

  const seen = alreadyRecorded(options.records ?? []);
  for (const finding of report.findings) {
    if (finding.verdict === "undetermined") {
      undetermined.push(finding);
      continue;
    }
    if (finding.verdict !== "dark") continue;
    if (seen.has(finding.key)) {
      repeated.push(finding);
      continue;
    }

    const result = appendEvent(
      options.logPath,
      {
        ts: readClock(options.clock === undefined ? {} : { clock: options.clock }),
        event: "audit.dark_session",
        actor: DARK_SESSION_ACTOR,
        payload: {
          subject: finding.subject,
          code: finding.code ?? "no-records",
          observation_key: finding.key,
          commits: finding.commits,
          guarded_paths: [...finding.guardedPaths],
          window: { from: window.from, to: window.to },
        },
      },
      {
        ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
        // Compare-and-append (§11.1 invariant 5): the records this verdict was
        // computed from are the head it must land on. A log that moved under
        // the sweep refuses here and the next sweep re-derives.
        ...(options.records === null || options.records.length === 0
          ? {}
          : {
              expectedHead: {
                seq: (options.records[options.records.length - 1] as EventRecord).seq,
                hash: (options.records[options.records.length - 1] as EventRecord).hash,
              },
            }),
      },
    );
    if (!result.ok) {
      refusals.push(
        `the dark-session observation for ${finding.subject} was not appended (${result.error.code}): ${result.error.message}. The finding stands and the next sweep re-derives it.`,
      );
      continue;
    }
    appended.push({ finding, seq: result.record.seq });
    seen.add(finding.key);
  }

  return { report, appended, repeated, undetermined, refusals };
}
