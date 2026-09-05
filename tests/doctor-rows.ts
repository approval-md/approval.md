/**
 * The ordered roster of `approval doctor` rows, in one place.
 *
 * Two tests need this list and they need it for different reasons.
 * `tests/cli-doctor.test.ts` asserts that a healthy run emits exactly these
 * checks in exactly this order, which is the behavioural claim. The README
 * tells a reader how many rows doctor prints and which of them skip in a fresh
 * directory, and `tests/docs-guard.test.ts` holds the prose to that number.
 *
 * Both used to be free to drift: the list lived inside the doctor suite, so a
 * row appended there changed the runtime's contract and left the README saying
 * a count that had been true once. One exported constant makes the second
 * assertion derive from the first.
 *
 * APPEND, never insert. Every row here was added at the end of the list on
 * purpose, so a reader's position-based expectations survive the next one, and
 * the per-row rationale stays beside its name.
 */

/** Every check `approval doctor` emits, in the order its failures cascade. */
export const DOCTOR_ROW_ORDER = [
  "build-freshness",
  "identity",
  "attestation",
  "log",
  "telegram",
  "web-port",
  "payload-store",
  "audit-sampling",
  // APRV-63: the envelope-loss check, appended to the list rather than
  // inserted, so a reader's position-based expectations still hold.
  "envelope-integrity",
  // APRV-68: the credential vault, appended for the same reason.
  "vault",
  // APRV-75: the environment source map, appended for the same reason.
  "environment",
  // APRV-125: the working-vs-committed chain comparison, appended for the
  // same reason. It shares one implementation with `approval log sync`'s
  // reconcile (core/log-reconcile.ts).
  "log-drift",
  // APRV-127: the reconciliation backlog, appended for the same reason. A
  // retrospective denial cannot undo anything, so the obligation it opens is
  // worth nothing unless somebody is told about it.
  "reconciliation",
  // APRV-145: harness hook outcome reporting, appended for the same reason.
  // It names the one configuration in which SPEC.md §10.2 loop escalation
  // cannot accrue at all: the pre-execution hook registered and the
  // post-execution one not.
  "harness-hook-outcomes",
  // APRV-151: whether THIS worktree's settings file carries the
  // pre-execution hook entry at all, appended for the same reason. Advisory
  // and never a failure: the two bypasses it exists for happened in
  // worktrees carrying exactly that entry, so the row reports what it can
  // see from disk and says plainly that this is not proof the session
  // loaded it. The check that does not trust session wiring is the CI-side
  // grant cross-check in core/protected-path-guard.ts.
  "harness-hook-wiring",
  // APRV-178: whose keystore items this instance's own file names, appended
  // for the same reason. The sharing it reports is what put a demo gate on
  // the production bot and had a human's tap answered by the wrong listener.
  "keychain-scope",
  // APRV-204: how far the log has run ahead of any records branch and how
  // the daemon's last cadence advance ended, appended for the same reason.
  // It is the status surface the cadence needed: the daemon's own event
  // stream is gone once nobody is tailing it, and this row answers from the
  // log and from local refs, in whatever process asks.
  "log-advance-cadence",
  // APRV-192: the detective complement to harness-hook-wiring, appended for
  // the same reason. That row asks this checkout's settings file whether the
  // hook is registered; this one asks git what happened and the log whether
  // it was told, and asks a session nothing at all.
  "dark-sessions",
  // APRV-188: whether the daemon's verified-head snapshot is in place, so
  // an operator can see whether hook invocations are re-proving a digest or
  // re-walking the chain. Appended for the same reason, and it can only
  // ever be a latency fact: every reader re-proves the snapshot, and one it
  // refuses is one that never existed.
  "verified-snapshot",
  // APRV-217: which prefix proof this policy configures for its long-lived
  // readers, appended for the same reason. A configuration row: it reads
  // the policy and never a running daemon's memory, and it can only ever be
  // a pass or a skip — both modes are correct.
  "read-proof",
  // APRV-215: the report half of `approval up`'s startup preflight,
  // appended for the same reason. It is the ONE row that reads the
  // remote-tracking refs, and it fetches nothing: the answer is as fresh as
  // the operator's last fetch, and outside a repository it is a skip.
  "main-behind-origin",
  // APRV-227: whether the harness binary hosting the hook changed since the
  // log last saw a record from it, appended for the same reason. The only
  // row that asks anything about a program outside this repository.
  "harness-version-unverified",
  // APRV-208: whether a daemon is answering live draws for this log,
  // appended for the same reason. It is the one row that reports whether
  // `supervised-live` is actually live on this machine rather than gating
  // at 100%, a difference invisible from inside the policy file.
  "live-draw",
  // APRV-238: whether the optional values block parses, appended for the
  // same reason. It is the only row that would ever report a broken one:
  // `policy check` says nothing about it on purpose, because guidance is
  // not enforcement and its answer is the enforcement trace.
  "values-block",
  // APRV-257: how this log stands against its own human-signed checkpoints,
  // appended for the same reason. The second witness's status surface,
  // beside log-drift's report of the first, running the same check
  // `log verify --checkpoints` and the daemon's full re-proof run.
  "checkpoint",
] as const;

/**
 * The rows that report `not applicable` when doctor runs in a directory `init`
 * has just scaffolded: no bot variables, no vault, no `.approval/env`, no
 * `daemon` block, no `supervised-live` class, no checkpoint key, no harness
 * settings file, no daemon snapshot, and no git repository.
 *
 * A subset of {@link DOCTOR_ROW_ORDER} and asserted to be one, so a renamed row
 * cannot leave a name here that doctor no longer emits. The README names these
 * so a reader meeting fifteen dashes on their first run can tell a configuration
 * from a fault.
 */
export const DOCTOR_FRESH_SKIPS: readonly string[] = [
  "telegram",
  "envelope-integrity",
  "vault",
  "environment",
  "log-drift",
  "harness-hook-outcomes",
  "harness-hook-wiring",
  "log-advance-cadence",
  "dark-sessions",
  "verified-snapshot",
  "read-proof",
  "main-behind-origin",
  "harness-version-unverified",
  "live-draw",
  "checkpoint",
];
