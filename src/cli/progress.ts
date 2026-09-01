/**
 * Saying what is taking so long, on stderr (APRV-167).
 *
 * `approval policy amend` sat silent for thirty-three seconds before it printed
 * anything: a chain re-verification and a baseline recovery over a three
 * thousand record log, all of it ahead of the first line of output. It read as
 * frozen. An operator nearly abandoned a live ceremony over it, and an earlier
 * one DID abandon a run mid-flight, which left the repository's own gate
 * fail-closed for every agent session until somebody tried again. The fix is not
 * to make the work faster; it is to stop the work being invisible.
 *
 * ## Three rules this module exists to keep
 *
 * **Stderr, always.** `--json` puts one object on stdout and callers parse it.
 * Progress that shared that stream would corrupt every machine consumer, so
 * there is no path here that writes to stdout — the reporter is not even given
 * the handle.
 *
 * **A terminal gets a repaint; anything else gets lines.** A pipe, a CI log and
 * a file have no cursor to move, and `\r` in them is not a progress bar: it is
 * a corrupted line that tools mangle differently and that a bug report then
 * carries. So the carriage return is used only when stderr is a TTY, and the
 * non-terminal form is ordinary newline-terminated lines that a log reader can
 * grep — fewer of them, because they are not being erased.
 *
 * **The first line is immediate; the rest are throttled.** {@link
 * ProgressReporter.phase} writes as it is called, because AC #1 is a line
 * within a second of invocation and a throttle on the FIRST line would be a
 * throttle on the entire point. Counts are rate-limited: a repaint per record
 * over three thousand records is three thousand writes to make one sentence
 * change.
 */

import type { Streams } from "./main.js";

/** How often a count may be repainted, in milliseconds. */
export const PROGRESS_THROTTLE_MS = 200;

/**
 * Somewhere to say what is happening while it happens.
 *
 * A phase is opened by name, advanced with counts, and closed. Calls that
 * arrive out of that order are ignored rather than refused: this is a comfort
 * feature on a diagnostic path, and a progress reporter that could fail a
 * ceremony would be a strictly worse bargain than the silence it replaces.
 */
export interface ProgressReporter {
  /** Announce a step by name. Written immediately, never throttled. */
  phase(text: string): void;
  /** Advance the open phase. Throttled, and skipped when nothing is open. */
  step(done: number, total: number): void;
  /** Close the open phase, optionally with a closing summary. */
  done(text?: string): void;
  /** Is anything actually being written? False for the silent reporter. */
  readonly active: boolean;
}

/** A reporter that writes nothing. For callers with no terminal to spare. */
export const silentProgress: ProgressReporter = {
  phase(): void {
    // Nothing: this is the whole contract.
  },
  step(): void {
    // Nothing.
  },
  done(): void {
    // Nothing.
  },
  active: false,
};

export interface ProgressOptions {
  /**
   * Is stderr a terminal? `process.stderr.isTTY` by default.
   *
   * Note that it is STDERR's tty-ness and not stdout's. `cli/style.ts` asks
   * about stdout because that is where its colour goes; this module writes to
   * the other stream, and `approval policy amend --json > report.json` in a
   * terminal is exactly the case where the two answers differ.
   */
  tty?: boolean;
  /** The clock the throttle reads. Injectable so a test owns time. */
  now?: () => number;
  /** Throttle interval. {@link PROGRESS_THROTTLE_MS} by default. */
  throttleMs?: number;
}

/** The width a repainted line is padded to, so a shorter line erases a longer. */
const REPAINT_WIDTH = 78;

/**
 * A reporter over `streams.err`.
 *
 * Returns {@link silentProgress} for nothing: even with no terminal the phase
 * lines are worth having, because they are what a CI log or a bug report shows
 * when somebody asks where the thirty seconds went.
 */
export function createProgress(
  streams: Streams,
  options: ProgressOptions = {},
): ProgressReporter {
  const tty = options.tty ?? process.stderr.isTTY === true;
  const now = options.now ?? (() => Date.now());
  const throttleMs = options.throttleMs ?? PROGRESS_THROTTLE_MS;

  /** The open phase's name, or `null` when nothing is open. */
  let open: string | null = null;
  /** When the last count was painted. */
  let painted = 0;
  /** Has anything been drawn over the current line? TTY bookkeeping only. */
  let dirty = false;

  const erase = (): void => {
    if (tty && dirty) {
      streams.err(`\r${" ".repeat(REPAINT_WIDTH)}\r`);
      dirty = false;
    }
  };

  return {
    active: true,

    phase(text: string): void {
      erase();
      open = text;
      painted = 0;
      // Newline-terminated on BOTH paths. On a terminal the counts that follow
      // repaint a line of their own beneath it, so the phase name stays on
      // screen: the operator's question is "what is it doing", and an answer
      // that is overwritten by its own progress meter does not answer it.
      streams.err(`${text}\n`);
    },

    step(done: number, total: number): void {
      if (open === null) return;
      const at = now();
      // The first count of a phase is always drawn (`painted` is 0), so a fast
      // walk still shows its scale before it finishes.
      if (painted !== 0 && at - painted < throttleMs && done < total) return;
      painted = at;
      const text = `  ${String(done)}/${String(total)} records`;
      if (tty) {
        streams.err(`\r${text.padEnd(REPAINT_WIDTH)}`);
        dirty = true;
      } else {
        streams.err(`${text}\n`);
      }
    },

    done(text?: string): void {
      erase();
      if (open !== null && text !== undefined) streams.err(`${text}\n`);
      open = null;
      painted = 0;
    },
  };
}
