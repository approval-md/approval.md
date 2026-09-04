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
export const HARNESS_KINDS = ["claude-code", "cursor"] as const;

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

/** How long the probe may take before it is killed and reported as absent. */
export const HARNESS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Run `<binary> --version` once, uncached, and normalize what came back.
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
export function probeHarnessVersion(kind: HarnessKind): string | null {
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
  return normalizeHarnessVersion(result.stdout);
}

/**
 * The memo. Holds the FAILURES too: a harness that is not on PATH is not on
 * PATH, and asking a second time in the same process would pay a second spawn
 * for the same `null`.
 */
const probed = new Map<HarnessKind, string | null>();

/**
 * The installed version of `kind`, read at most once per process.
 *
 * This is the only entry point callers should use. `probeHarnessVersion` is
 * exported for the test that proves the memo is a memo.
 */
export function installedHarnessVersion(kind: HarnessKind): string | null {
  const memo = probed.get(kind);
  if (memo !== undefined) return memo;
  const value = probeHarnessVersion(kind);
  probed.set(kind, value);
  return value;
}

/** Drop the memo. TEST ONLY: a process reads a version once, by design. */
export function resetHarnessVersionCache(): void {
  probed.clear();
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
