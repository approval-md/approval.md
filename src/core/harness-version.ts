/**
 * Which harness binary issued a hook-written record (APRV-227).
 *
 * ## The hole
 *
 * A harness upgrade — `claude update`, a global npm install, an unattended
 * updater on a launchd timer — swaps the binary that hosts the PreToolUse hook
 * without a line anywhere. A new harness release can change the hook envelope
 * semantics and quietly stop the gate firing, and the first evidence would be
 * an action nobody was asked about. The gate cannot stop a person upgrading
 * their own machine, and should not. What it can do is notice the effect: the
 * records the hook writes name the harness that issued them, and `approval
 * doctor` says so when the installed binary no longer matches the last one the
 * log saw.
 *
 * ## What this field is, and what it is emphatically not
 *
 * It is INFORMATIONAL. Nothing in the runtime reads it back as an input:
 * no class resolution, no irreversibility floor, no loop-escalation streak, no
 * budget arithmetic, no sampling draw. SPEC.md §11.1 invariant 4 says a
 * self-reported field never reduces scrutiny, and the discipline that keeps
 * that true here is that the value has exactly one reader — a doctor row that
 * can only ADD a red line — and exactly one direction it can move a human's
 * attention, which is toward the log rather than away from it. A harness that
 * lies about its own version buys itself nothing: the row it defeats is a row
 * that would have asked for a look.
 *
 * It is also OPTIONAL and additive. A record written before the field existed
 * carries neither half and still validates and still verifies; a hook that
 * cannot establish a version writes neither half rather than a guess.
 *
 * ## Where the value comes from, in order
 *
 * 1. The hook event's own version field, where the harness supplies one.
 *    Claude Code's PreToolUse event may carry it; Cursor's does not.
 * 2. `<binary> --version`, read at most ONCE per process ({@link
 *    installedHarnessVersion} memoizes, including the failures) with a short
 *    hard timeout.
 * 3. Absent.
 *
 * Step 2 is why this module is careful about cost. A hook process exists per
 * gated tool call, and APRV-186/188/212 each removed a term from what that
 * process pays. So the probe is reached only on a path that is about to WRITE a
 * record — a registration or a bypass — and never on the pass-through path that
 * answers `cat README.md`. The memo makes a multi-class command pay once.
 *
 * ## Why the binary name is not configurable
 *
 * `cli/gloss.ts` already settled this: a runtime that let a policy or an
 * environment variable name the executable it runs would have invented a new
 * way to be told what to execute. The map below is the whole list, PATH is the
 * only seam, and a test puts a stub binary in front of it.
 */

import { spawnSync } from "node:child_process";

import { childEnvironment } from "./child-env.js";

/** The harnesses this runtime speaks a hook protocol for. */
export const HARNESS_KINDS = [
  "claude-code",
  "cursor",
  "codex",
  "grok",
  "muse",
  "hermes",
] as const;

export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** Is `value` one of the harnesses this runtime knows? */
export function isHarnessKind(value: unknown): value is HarnessKind {
  return typeof value === "string" && (HARNESS_KINDS as readonly string[]).includes(value);
}

/**
 * The executable each harness installs on PATH.
 *
 * Not configurable, deliberately (see the header). A harness whose binary is
 * not one of these has no version to read here, and the field is simply absent.
 */
export const HARNESS_BINARY: Readonly<Record<HarnessKind, string>> = {
  "claude-code": "claude",
  cursor: "cursor-agent",
  codex: "codex",
  grok: "grok",
  muse: "muse",
  hermes: "hermes",
};

/**
 * How long a version string may be, and the reason there is a cap at all.
 *
 * `<binary> --version` is the output of a third-party process, and this value
 * is appended to an append-only log. SPEC.md §11.1 invariant 3 has no exception
 * for provenance: a field that accepted arbitrary bytes is a field where a
 * banner, a stack trace, or the credential quoted inside one arrives and stays
 * forever. So the write boundary takes one line, printable ASCII only, capped.
 */
export const HARNESS_VERSION_LIMIT = 64;

/** Printable ASCII, no control characters, no newline. The schema pins the same. */
const PRINTABLE = /^[\x20-\x7e]+$/u;

/**
 * The one spelling of a harness version this runtime ever writes or compares.
 *
 * First line, trimmed, and nothing else: `claude --version` prints
 * `2.0.14 (Claude Code)` and a future release may add a second line of banner.
 * Both the hook (which records) and doctor (which compares) call this, so the
 * comparison is between two values normalized identically — a row that failed
 * because one side kept a trailing newline would be a false alarm, and a false
 * alarm in a health check trains an operator to ignore it.
 *
 * Returns `null` for anything that is not a usable version: empty output, a
 * line that is not printable ASCII, or one longer than the cap. Absence is
 * always available and always honest.
 */
export function normalizeHarnessVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.split("\n", 1)[0] ?? "";
  const text = first.trim();
  if (text.length === 0 || text.length > HARNESS_VERSION_LIMIT) return null;
  return PRINTABLE.test(text) ? text : null;
}

/**
 * How long the probe may take before it is killed and reported as absent.
 *
 * A bound against a HUNG binary, not a latency target: `<binary> --version`
 * answers in milliseconds on any machine that is not already in trouble, and
 * this number is only ever reached by one that is. It is generous for the same
 * reason `cli/gloss.ts`'s is (20s there): a timeout tuned to a healthy machine
 * turns a loaded one into a silent, intermittent absence, and an absence that
 * appears under load is the least useful failure a provenance field could have.
 * The cost is bounded by the fact that this runs only where a record is being
 * written, and at most once per process.
 */
export const HARNESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long the RAW first line of `<binary> --version` may be.
 *
 * Wider than {@link HARNESS_VERSION_LIMIT} because it holds a different kind of
 * value for a different reader: nothing capped by this number is ever appended to
 * the log (only {@link normalizeHarnessVersion}'s output is), and what needs the
 * raw line is a diagnostic that must be able to read a build stamp a harness
 * prints beside its semver. Hermes prints
 * `Hermes Agent v0.21.3 (2026.9.14) · upstream 913d4098`, which the log's own
 * rule rejects on the non-ASCII separator alone. Capped and stripped of control
 * characters all the same: this is third-party output on its way to a terminal.
 */
export const HARNESS_RAW_VERSION_LIMIT = 200;

/**
 * The first line of a `--version` output, as a line a diagnostic may print.
 *
 * One line, trimmed, control characters removed, capped. `null` for empty output
 * or a line past the cap. It keeps non-ASCII bytes, which is the whole difference
 * from {@link normalizeHarnessVersion}: a build stamp behind a typographic
 * separator is exactly the fact a version floor has to read, and it is exactly
 * the fact the write boundary will not accept.
 */
export function rawHarnessVersionLine(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.split("\n", 1)[0] ?? "";
  // `\p{Cc}` rather than an escaped range: the class is the Unicode CONTROL
  // category, which is the thing being removed, and it reads as that.
  const text = first.replace(/\p{Cc}/gu, "").trim();
  if (text.length === 0 || text.length > HARNESS_RAW_VERSION_LIMIT) return null;
  return text;
}

/**
 * Run `<binary> --version` once, uncached, and return its raw first line.
 *
 * Every failure is a value rather than an exception, in the manner of
 * {@link spawnGloss}: a missing binary, a non-zero exit and a timeout kill are
 * all reported on the result object, and all of them are simply "no version".
 *
 * The child is STARVED, for the reason the gloss runner is: this is a
 * third-party CLI spawned by a process that may be holding a bot token and a
 * vault passphrase, and it has no use for either. Nothing is declared, because
 * reading a version is not a granted action.
 */
export function probeHarnessVersionRaw(kind: HarnessKind): string | null {
  let result;
  try {
    result = spawnSync(HARNESS_BINARY[kind], ["--version"], {
      encoding: "utf8",
      env: childEnvironment().env,
      timeout: HARNESS_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      // A version is a few dozen bytes. A binary that answers with a megabyte
      // is a binary whose answer is dropped rather than buffered.
      maxBuffer: 64 * 1024,
    });
  } catch {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) return null;
  return rawHarnessVersionLine(result.stdout);
}

/**
 * Run `<binary> --version` once, uncached, and normalize what came back.
 *
 * The recordable form: one line, printable ASCII, capped. Exported for the test
 * that proves the memo below is a memo.
 */
export function probeHarnessVersion(kind: HarnessKind): string | null {
  return normalizeHarnessVersion(probeHarnessVersionRaw(kind));
}

/**
 * The memo. Holds the FAILURES too: a harness that is not on PATH is not on
 * PATH, and asking a second time in the same process would pay a second spawn
 * for the same `null`.
 *
 * It holds the RAW line rather than the recordable one, so the two readers — the
 * provenance field and the version floor — still cost ONE spawn per process
 * between them. A harness whose raw line the write boundary rejects has a
 * `null` recordable version and a readable raw one, which is precisely Hermes's
 * case and precisely why the floor is not read off a record.
 */
const probed = new Map<HarnessKind, string | null>();

/** The raw first line of `<binary> --version`, read at most once per process. */
export function installedHarnessVersionRaw(kind: HarnessKind): string | null {
  const memo = probed.get(kind);
  if (memo !== undefined) return memo;
  const value = probeHarnessVersionRaw(kind);
  probed.set(kind, value);
  return value;
}

/**
 * The installed version of `kind`, read at most once per process.
 *
 * This is the only entry point callers should use for a RECORDABLE version.
 * `probeHarnessVersion` is exported for the test that proves the memo is a memo.
 */
export function installedHarnessVersion(kind: HarnessKind): string | null {
  return normalizeHarnessVersion(installedHarnessVersionRaw(kind));
}

/** Drop the memo. TEST ONLY: a process reads a version once, by design. */
export function resetHarnessVersionCache(): void {
  probed.clear();
}

// ---------------------------------------------------------------------------
// The Hermes fail-closed version floor (APRV-415)
// ---------------------------------------------------------------------------

/**
 * The build at which Hermes Agent starts honouring `fail_closed` (APRV-415).
 *
 * ## Why a floor exists at all, and why it is a DATE rather than a version
 *
 * `approval hook hermes` is enforcement rather than a backstop only because of a
 * per-entry `fail_closed: true` that makes a hook crash, a hook timeout and
 * unparseable hook output BLOCK. The live probe measured both halves of that on
 * two builds of the same harness, and the answer differs between them:
 *
 * - `main` at `118984d7`, built 2026-09-20: crash, garbage and hang were all
 *   REFUSED (the hang at the 300s per-entry cap). The key works;
 * - `v0.21.3`, built 2026.9.14: all three PROCEEDED. That build does not know the
 *   key and ignores it SILENTLY. `hermes hooks list` renders no `fail_closed`
 *   flag on either build, so the listing cannot be used to tell them apart.
 *
 * The two builds report the SAME semver. `hermes --version` on the older one
 * prints `Hermes Agent v0.21.3 (2026.9.14) · upstream 913d4098`, and the update
 * that fixed the behaviour moved 670 commits without moving `0.21.3`. So a floor
 * expressed as a semantic version would compare the one field that did not
 * change, and would pass a build that fails open. The build DATE and the upstream
 * commit are the two fields that did move, and they are what this compares.
 *
 * ## What it can and cannot do
 *
 * It can only ADD a red line to `approval doctor` (SPEC.md §11.1 invariant 4: a
 * self-reported field never reduces scrutiny). A build claiming a later date buys
 * nothing — it defeats a row that would have asked a human to look — and nothing
 * in the runtime reads this to widen a verdict, skip a wait or lower a class. The
 * refusals the adapter emits are the same on every build; what changes below the
 * floor is whether a BROKEN hook stops the call, which no code in this repository
 * can observe from inside the hook it is broken in.
 */
export const HERMES_FAIL_CLOSED_FLOOR = {
  /** The first build observed to honour the key, by upstream commit. */
  upstream: "118984d7",
  /** That build's date, in the `YYYY.M.D` stamp `hermes --version` prints. */
  date: { year: 2026, month: 9, day: 20 },
  /** The one sentence every surface quotes, so they cannot drift apart. */
  statement:
    "a build at or after main 118984d7 of 2026-09-20; v0.21.3 (2026.9.14) fails open silently",
} as const;

/** A build stamp, as `hermes --version` prints one. */
export interface HermesBuildDate {
  year: number;
  month: number;
  day: number;
}

/** What `hermes --version`'s first line states, field by field. */
export interface HermesVersionFields {
  /** The semver, which did NOT move across the fail-closed fix. */
  semver: string | null;
  /** The build date, `(2026.9.14)`, which did. */
  date: HermesBuildDate | null;
  /** The upstream commit, `· upstream 913d4098`, which did. */
  upstream: string | null;
}

/**
 * Read the fields out of `hermes --version`'s first line, or `null`.
 *
 * Shape-only and forgiving in one direction: a field this cannot find is `null`
 * rather than a guess, and a line naming none of the three is not a Hermes
 * version line at all. The observed line is
 * `Hermes Agent v0.21.3 (2026.9.14) · upstream 913d4098`; the separator is read
 * past rather than required, because a release that changes its punctuation must
 * not silently turn the floor check into an unknown.
 */
export function parseHermesVersion(raw: unknown): HermesVersionFields | null {
  const line = rawHarnessVersionLine(raw);
  if (line === null) return null;
  const semver = /\bv(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u.exec(line);
  const stamp = /\((\d{4})\.(\d{1,2})\.(\d{1,2})\)/u.exec(line);
  const upstream = /\bupstream\s+([0-9a-f]{7,40})\b/iu.exec(line);
  if (semver === null && stamp === null && upstream === null) return null;
  return {
    semver: semver?.[1] ?? null,
    date:
      stamp === null
        ? null
        : {
            year: Number(stamp[1]),
            month: Number(stamp[2]),
            day: Number(stamp[3]),
          },
    upstream: upstream?.[1]?.toLowerCase() ?? null,
  };
}

/**
 * Does this Hermes build honour `fail_closed`?
 *
 * - `"honours"` — its upstream commit IS the floor's, or its build date is on or
 *   after the floor's date;
 * - `"ignores"` — its build date is BEFORE the floor's. This is the one answer
 *   that names a fault, and it is the state a live probe measured rather than
 *   inferred;
 * - `"unknown"` — no version could be read, or the line carries neither a build
 *   date nor the floor's commit. Two commit hashes cannot be ORDERED without a
 *   repository, so a build stamped with an unfamiliar commit and no date is
 *   honestly unknown rather than quietly either.
 *
 * `"unknown"` is not a synonym for `"ignores"`, deliberately. This value feeds a
 * health check, and a health check that cried fault on every unreadable banner
 * would train an operator to stop reading it, which costs more than the case it
 * would catch. What guards the unknown case instead is the doc, the help block
 * and the probe's own report, all of which state {@link
 * HERMES_FAIL_CLOSED_FLOOR.statement} verbatim.
 */
export function hermesFailClosedSupport(raw: unknown): "honours" | "ignores" | "unknown" {
  const fields = parseHermesVersion(raw);
  if (fields === null) return "unknown";
  const floor = HERMES_FAIL_CLOSED_FLOOR;
  if (fields.upstream !== null && fields.upstream.startsWith(floor.upstream)) return "honours";
  if (fields.date === null) return "unknown";
  const asNumber = (date: HermesBuildDate): number =>
    date.year * 10_000 + date.month * 100 + date.day;
  return asNumber(fields.date) >= asNumber(floor.date) ? "honours" : "ignores";
}

/**
 * The provenance pair a hook-written record carries, or `null` when this
 * process could not establish one.
 *
 * Both halves or neither. A version with no harness beside it is a string
 * doctor cannot attribute to a binary — one log holds the records of every
 * harness that ever wrote to it — and a harness with no version is a field that
 * says nothing.
 */
export interface HarnessProvenance {
  harness: HarnessKind;
  harness_version: string;
}

/**
 * Build the pair for `kind`, preferring the version the hook event supplied.
 *
 * `eventVersion` is whatever the harness put in its own event, unvalidated:
 * it goes through {@link normalizeHarnessVersion} exactly as the probe's
 * output does, because it arrives from the same untrusted side of the boundary
 * and the write boundary does not have two standards.
 */
export function harnessProvenance(
  kind: HarnessKind,
  eventVersion: unknown = null,
): HarnessProvenance | null {
  const stated = normalizeHarnessVersion(eventVersion);
  const version = stated ?? installedHarnessVersion(kind);
  return version === null ? null : { harness: kind, harness_version: version };
}

/**
 * The provenance pair carried by an already-written record's payload, or
 * `null` when it carries none (or carries half of one).
 *
 * The read side of the same contract, used by `approval doctor`. Strict on
 * purpose: a record whose `harness` is a string this runtime does not know is a
 * record from a harness this build cannot probe, so it is not evidence about
 * any binary here and is skipped rather than guessed at.
 */
export function readHarnessProvenance(payload: unknown): HarnessProvenance | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;
  const kind = fields["harness"];
  if (!isHarnessKind(kind)) return null;
  const version = fields["harness_version"];
  if (typeof version !== "string" || normalizeHarnessVersion(version) !== version) return null;
  return { harness: kind, harness_version: version };
}
