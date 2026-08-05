/**
 * Process exit codes for the `approval` CLI — **frozen public API**.
 *
 * SPEC.md §10.1 makes the CLI the primary interface for humans *and* agents.
 * An agent branches on the exit code before it ever looks at stdout, so these
 * five numbers are part of the contract: they are defined once, here, and every
 * `--help` text prints them. Adding a code is a spec change; changing the
 * meaning of an existing one is a breaking change.
 *
 * The distinction that matters most is {@link EXIT_INTEGRITY} vs
 * {@link EXIT_IO}. "I could not read the file" and "the file has been tampered
 * with" are different facts about the world, and conflating them either cries
 * wolf over a permission bit or — far worse — lets real tampering read as a
 * transient filesystem hiccup. The core `verify()` reports a non-ENOENT read
 * failure as `corrupt`, because from inside the chain walker an unreadable log
 * is indistinguishable from a broken one; the CLI boundary therefore checks
 * readability *itself* before calling core, and reports I/O as I/O. Messages on
 * this path must never use the word "corrupt".
 */

/**
 * Success. `verify`: the chain is clean. `tail`/`export`: the requested records
 * were produced — including the torn-tail case, where the intact prefix is
 * printed and the tear is a stderr warning. `reindex`: the index was built.
 */
export const EXIT_OK = 0;

/**
 * Integrity failure. `verify`: the log is corrupt. `tail`/`export`: refused to
 * print records from a corrupt log. `reindex`: refused to index one
 * (`not-clean`).
 */
export const EXIT_INTEGRITY = 1;

/** Usage error: unknown command, unknown flag, missing or invalid value. */
export const EXIT_USAGE = 2;

/**
 * Torn tail — the log's final line is unterminated, the signature of a crashed
 * write rather than of tampering. `verify` reports it; `reindex` refuses
 * without `--force`. Nothing is ever repaired: truncating a torn line is a
 * human decision.
 */
export const EXIT_TORN_TAIL = 3;

/**
 * I/O error: the log or the index path could not be read, created, or
 * replaced. Never used for anything the log itself says about its own
 * contents.
 */
export const EXIT_IO = 4;

/**
 * No valid execution token — **`approval run` only** (APRV-18, human-settled
 * 2026-08-06: "refuses without a valid token at a distinct exit code").
 *
 * An addition to the table above, not a redefinition of anything in it: every
 * command that existed before APRV-18 still uses 0–4 and none of them can emit
 * 5. It is distinct from {@link EXIT_INTEGRITY} because the repair is distinct.
 * A generic gate refusal means "ask a human what to do"; a 5 means "you are
 * holding no key to this door" — request the action, get it granted, and pass
 * the token that grant printed. An agent that could not tell those apart would
 * escalate when it should retry with a token, or retry forever when it should
 * escalate.
 */
export const EXIT_NO_TOKEN = 5;

/**
 * Timeout — **`approval wait` only** (APRV-18). The wait elapsed with the
 * task's requests still undecided. Nothing was appended and nothing is implied
 * about the request: it is still live, and waiting again is legitimate.
 *
 * Distinct from every decision code, because "no answer yet" is not an answer.
 * `wait` is the one verb whose exit code encodes a *decision* rather than a
 * runtime outcome (SPEC.md §10.1: "exit code = decision"), so its mapping is
 * documented in full in its own `--help`.
 */
export const EXIT_TIMEOUT = 6;

/** The frozen table, for help text and for tests that pin it. */
export const EXIT_CODE_TABLE: ReadonlyArray<readonly [number, string]> = [
  [EXIT_OK, "success"],
  [EXIT_INTEGRITY, "integrity failure (corrupt log)"],
  [EXIT_USAGE, "usage error"],
  [EXIT_TORN_TAIL, "torn tail"],
  [EXIT_IO, "I/O error"],
  [EXIT_NO_TOKEN, "no valid execution token (approval run only)"],
  [EXIT_TIMEOUT, "timeout (approval wait only)"],
];
