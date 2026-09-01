/**
 * Progress on stderr for the verbs that go quiet before they speak (APRV-167).
 *
 * ## The incident
 *
 * `approval policy amend` sat silent for ~33 seconds on this repository's own
 * ~3000-record log before printing the Policy/Changes/Load block. It was not
 * hung: it was re-verifying the whole hash chain and recovering the diff
 * baseline, both of which happen before there is anything to print. An operator
 * read it as frozen and nearly abandoned a live ceremony, and an earlier run
 * WAS abandoned mid-flight, which left the repository's gate fail-closed for
 * every agent session until somebody tried again. Silence during a slow step is
 * therefore not a cosmetic problem here; it is how the gate got left broken.
 *
 * ## What this prints, and what it refuses to print
 *
 * Plain lines in the CLI's existing `approval: …` stderr shape, one per line,
 * nothing else:
 *
 *     approval: verifying the log chain: 3000 records
 *     approval: verifying the log chain: 150/3000 records
 *     …
 *     approval: verifying the log chain: 3000/3000 records, done
 *
 * NO spinner, no carriage returns, no cursor movement, no progress bar. Those
 * read well on one terminal and shred every pipe, log file, and CI transcript
 * the output lands in, and this stream is the one an operator screenshots when
 * a ceremony goes wrong. Colour follows the process's usual {@link Style}
 * decision and carries nothing: strip every escape byte and the lines still say
 * the same thing.
 *
 * NO TIMES either. Not because elapsed time is uninteresting, but because these
 * lines are asserted in tests, and a line whose text depends on the machine it
 * ran on is a line the suite has to match loosely, forever. Counts are the
 * honest measure of a chain walk anyway: they are what the walk is doing.
 *
 * ## Quiet by default
 *
 * A step that finishes fast says nothing at all. The chain sink stays silent
 * below {@link MIN_ANNOUNCED_RECORDS} records, which is roughly where a cold
 * verification starts to exceed a couple of seconds (schemas are re-read and
 * re-compiled per record by design, so the cost is ~10ms a record, not the
 * microseconds a hash walk alone would take). Above it, the opening line is
 * printed as soon as the file has been read and split — before the first schema
 * compile — so it lands inside milliseconds of the read rather than after the
 * walk it is describing.
 *
 * The steps that carry no count (baseline recovery: a `git show` and a policy
 * load) are announced only once the chain sink has spoken. On a log small
 * enough to keep the sink quiet the whole verb returns quickly, and a lone
 * "recovering the baseline" line on a run that never paused is noise.
 */

import type { VerifyProgress } from "../core/verify.js";
import type { Style } from "./style.js";

/**
 * Below this many records, the chain sink prints nothing at all.
 *
 * Calibrated against the real cost of a cold verification (see the header): 100
 * records is about a second and a half, which is the point where a human starts
 * wondering whether the process is alive.
 */
export const MIN_ANNOUNCED_RECORDS = 100;

/** No fewer records than this between two progress lines. */
const MIN_RECORDS_BETWEEN_LINES = 100;

/**
 * At most this many progress lines between the opening one and the closing one,
 * whatever the size of the log. A million-record log is not a reason to write a
 * thousand lines to somebody's CI transcript.
 */
const MAX_LINES = 20;

export interface ProgressSinks {
  /** Where the lines go. Always stderr in production; captured in tests. */
  err(text: string): void;
  /** The process's style decision, so colour follows the same rules as stdout. */
  style: Style;
}

export interface Progress {
  /**
   * A sink for {@link VerifyProgress}, to hand to `readVerifiedRecords` or
   * `verify` as `onProgress`.
   *
   * `label` names the step in the operator's words ("verifying the log chain").
   */
  chain(label: string): (progress: VerifyProgress) => void;
  /**
   * Announce a step that has no count to report, once something slow has
   * already been announced. Silent otherwise; see the header.
   */
  step(text: string): void;
  /** Whether anything has been printed — i.e. whether this run is a slow one. */
  readonly announced: boolean;
}

/** How many records apart two progress lines are, for a log of `total`. */
function strideFor(total: number): number {
  return Math.max(MIN_RECORDS_BETWEEN_LINES, Math.ceil(total / MAX_LINES));
}

/**
 * A progress reporter writing plain lines to `sinks.err`.
 *
 * Stateful in exactly one way: it remembers whether it has spoken, which is
 * what {@link Progress.step} keys off.
 */
export function makeProgress(sinks: ProgressSinks): Progress {
  const st = sinks.style;
  let announced = false;

  const line = (text: string): void => {
    announced = true;
    sinks.err(`${st.muted(`approval: ${text}`)}\n`);
  };

  return {
    get announced(): boolean {
      return announced;
    },

    step(text: string): void {
      if (!announced) return;
      line(text);
    },

    chain(label: string): (progress: VerifyProgress) => void {
      let stride = 0;
      let opened = false;
      return ({ verified, total }) => {
        if (total < MIN_ANNOUNCED_RECORDS) return;
        if (!opened) {
          opened = true;
          stride = strideFor(total);
          line(`${label}: ${total} records`);
          // The opening call reports the records already behind the walk: zero
          // on a cold read (nothing to say), the reused prefix on a walk
          // resumed behind the verified-read cache — which is worth a line of
          // its own, or the next checkpoint would look like a stall from zero.
          if (verified === 0) return;
          if (verified < total) {
            line(`${label}: ${verified}/${total} records`);
            return;
          }
        }
        // The closing line says the walk covered every record, and stops there.
        // Whether the LOG is clean is a verdict this sink does not have: the
        // torn-tail and anchored-head checks run after the last record.
        if (verified === total) {
          line(`${label}: ${verified}/${total} records, done`);
          return;
        }
        if (verified % stride === 0) line(`${label}: ${verified}/${total} records`);
      };
    },
  };
}
