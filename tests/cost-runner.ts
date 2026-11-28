/**
 * How fast this runner is, for the tests that bound CPU time.
 *
 * A cost test says "this line is read in under N CPU seconds". N was set on
 * one kind of machine. CPU time does not depend on what else the machine is
 * doing, but it does depend on the machine: the node 20 floor job read the
 * same line in 11.7 CPU s that a node 22 job read in under 8, on code that
 * had not become slower. A bound that is right on one runner and a guess on
 * another fails for the runner, and the failure looks like a regression.
 *
 * So the bound follows the runner. Before the first cost test, a fixed piece
 * of work is timed here, in this process, on this runner: the kind of work
 * the classifier does (building, splitting and scanning strings, one
 * expression per word, a map of names). Its CPU time against
 * {@link REFERENCE_SECONDS} is the runner's factor, and every bound is
 * multiplied by it ({@link scaledBound}).
 *
 * - The factor is never below 1: a fast machine keeps the bound as written.
 * - It is never above {@link MOST}: the tests exist to catch a walk that has
 *   become quadratic, which is tens or hundreds of times slower, and no
 *   runner is allowed to excuse that.
 * - It is measured, logged and named in every failure, so a red says which
 *   it was: the code, or the runner.
 *
 * The work is not the code under test. A change that made the classifier
 * slow everywhere would otherwise raise its own bound.
 */

/** CPU seconds (user and system) spent in `run`. */
export function cpuSeconds(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

/**
 * What {@link calibrationWork} costs, in CPU seconds, on the runner the
 * bounds were set on: a GitHub-hosted runner under the node the full gate
 * uses. The factor is this runner's time over it.
 *
 * Measured, not chosen: the full gate's node 22 job logged 0.418 CPU s for it
 * (this PR's first CI run), and a laptop 0.17 to 0.30. The reference sits a
 * little above the measurement, so that runner keeps every bound exactly as
 * written (factor 1) and only a runner that is really slower stretches one.
 */
export const REFERENCE_SECONDS = 0.45;

/** The most a runner may stretch a bound. */
export const MOST = 4;

/** A fixed piece of string work, the same on every run. Returns a number so nothing is optimised away. */
export function calibrationWork(): number {
  let sum = 0;
  const words: string[] = [];
  for (let index = 0; index < 400_000; index += 1) {
    words.push(`w${((index * 2654435761) >>> 0).toString(36)}`);
  }
  const text = words.join(" ");
  const seen = new Map<string, number>();
  for (const word of text.split(" ")) {
    if (/^[a-z0-9]+$/u.test(word)) sum += word.length;
    const name = word.toUpperCase().toLowerCase();
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (name.includes("zz")) sum += name.indexOf("zz");
  }
  for (let at = 0; at < text.length; at += 3) sum += text.charCodeAt(at);
  let folded = "";
  for (const part of text.slice(0, 600_000).split("w")) folded = part.length > folded.length ? part : folded;
  return sum + seen.size + folded.length;
}

/** The factor for a runner on which {@link calibrationWork} took `seconds`: never under 1, never over {@link MOST}. */
export function factorOf(seconds: number): number {
  return Math.min(MOST, Math.max(1, seconds / REFERENCE_SECONDS));
}

/** The runner's measurement: made once, on first use. */
export interface Runner {
  /** The least CPU seconds {@link calibrationWork} took, of five timed runs after one that is not timed. */
  seconds: number;
  /** `seconds` over {@link REFERENCE_SECONDS}, held between 1 and {@link MOST}. */
  factor: number;
  /** One line that says both, for a log and for a failure. */
  line: string;
}

let measured: Runner | null = null;

/** This runner, measured on first use. */
export function runner(): Runner {
  if (measured !== null) return measured;
  calibrationWork();
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round += 1) least = Math.min(least, cpuSeconds(calibrationWork));
  const factor = factorOf(least);
  measured = {
    seconds: least,
    factor,
    line: `runner factor ${factor.toFixed(2)} (calibration ${least.toFixed(3)} CPU s, reference ${String(REFERENCE_SECONDS)}, node ${process.version})`,
  };
  return measured;
}

/**
 * The control of a line held by the RATIO rule (#720's list): the same line
 * with its costly part spelled as a plain word of the same length. The
 * line's head is kept (through its first `> ` when that comes early, else its
 * first word), then `filler` to the line's length.
 */
export function plainLike(command: string, filler = "a"): string {
  const redirect = command.indexOf("> ");
  const head = redirect >= 0 && redirect < 60 ? command.slice(0, redirect + 2) : command.slice(0, command.indexOf(" ") + 1);
  return `${head}${filler.repeat(Math.max(1, command.length - head.length))}`;
}

/** A line's readings beside its control's: the least of each, and their ratio. */
export interface PairReading {
  calls: number[];
  controls: number[];
  least: number;
  leastControl: number;
  ratio: number;
}

/**
 * `command`, first read at `first` CPU seconds, read twice more beside three
 * readings of its control ({@link plainLike}, or `control` when given), the
 * control first each round (#720's list, as #719 reads its lines). `variant`
 * gives the line for the k-th further reading (k = 1, 2) where the classifier
 * keeps an answer keyed on the line's own words between calls, so no reading
 * is served from it; without it every reading is of `command` itself.
 */
export function pairReading(first: number, command: string, run: (text: string) => unknown, control?: string, variant?: (k: number) => string): PairReading {
  const plain = control ?? plainLike(command);
  const calls = [first];
  const controls: number[] = [];
  for (let k = 1; k <= 2; k += 1) {
    controls.push(cpuSeconds(() => void run(plain)));
    const line = variant === undefined ? command : variant(k);
    calls.push(cpuSeconds(() => void run(line)));
  }
  controls.push(cpuSeconds(() => void run(plain)));
  const least = Math.min(...calls);
  const leastControl = Math.min(...controls);
  return { calls, controls, least, leastControl, ratio: least / Math.max(leastControl, 1e-6) };
}

/**
 * A line's RATIO rule (#718, #719, #720): the most it may cost of its
 * control (`ratioBound`), the control's figure on CI (`controlCi`, the unit
 * of its readings) and the most the control may read of it before the
 * runner's factor (`most`).
 */
export interface RatioRule {
  readonly ratioBound: number;
  readonly controlCi: number;
  readonly most: number;
}

/** A reading judged by its rule: whether the line is over its ratio, and whether the control is over its own bound. */
export function ratioJudged(ratio: number, control: number, rule: RatioRule, runnerFactor: number): { controlBound: number; lineOver: boolean; controlOver: boolean } {
  const controlBound = rule.most * rule.controlCi * runnerFactor;
  return { controlBound, lineOver: !(ratio < rule.ratioBound), controlOver: !(control < controlBound) };
}

/**
 * The text a held line prints, and what is over (empty when nothing is):
 * `fixed` is the bound the line held before, printed and not asserted.
 */
export function heldLine(id: string, label: string, reading: PairReading, rule: RatioRule, fixed: string): { text: string; over: string[] } {
  const factor = runner().factor;
  const { controlBound, lineOver, controlOver } = ratioJudged(reading.ratio, reading.leastControl, rule, factor);
  const text =
    `# cost-line: ${id} ${label}: ${reading.least.toFixed(3)} CPU s (the least of ${String(reading.calls.length)}; control ${reading.leastControl.toFixed(4)}, ratio ${reading.ratio.toFixed(2)} of ${String(rule.ratioBound)}; ` +
    `the control's own bound ${controlBound.toFixed(4)}; the fixed ${fixed} is printed, not asserted; ${runner().line})`;
  const over: string[] = [];
  if (lineOver) over.push(`${label}: ${reading.least.toFixed(3)} CPU s is ${reading.ratio.toFixed(2)} times its control (${reading.leastControl.toFixed(4)}), bound ${String(rule.ratioBound)}`);
  if (controlOver) over.push(`${label}'s control: ${reading.leastControl.toFixed(4)} CPU s, its own bound ${controlBound.toFixed(4)} (${String(rule.most)} times CI's ${String(rule.controlCi)}, by the runner's factor)`);
  return { text, over };
}

/**
 * The reading of a cell kept on its fixed bound (#720's list): `first`, then
 * `again(k)` for k = 1 and 2, and the least of the three, which is what the
 * bound judges. A cell whose input the classifier keeps between calls reads
 * a distinct input of the same shape and length each round.
 */
export function leastOfThree(first: number, again: (k: number) => number): { calls: number[]; least: number } {
  const calls = [first, again(1), again(2)];
  return { calls, least: Math.min(...calls) };
}

/** `bound` CPU seconds as written, stretched by this runner's factor. */
export function scaledBound(bound: number): number {
  return bound * runner().factor;
}
