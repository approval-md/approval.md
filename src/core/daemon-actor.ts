/**
 * Is THIS process the daemon? (APRV-382.)
 *
 * One fact, held in one place, so the gated advance path can ask it without
 * being told it. `log.advance.daemon` is autonomous in this repository's policy
 * and `log.advance` is not, which means something has to decide which of the
 * two a cycle asks under — and that decision must not be an argument a caller
 * passes, because a field a caller sets is a self-reported field, and SPEC.md
 * §11.1 invariant 4 says a self-reported field never reduces scrutiny.
 *
 * So the mark is set by the daemon runtime itself, at construction, and read
 * from module state that no exported function will set on another process's
 * behalf: {@link markDaemonProcess} takes no arguments and records
 * `process.pid`, and {@link isDaemonProcess} answers true only while that
 * recorded pid is still this process's own. A child inherits nothing — module
 * state does not cross a `spawn` — so the advance child, which holds no
 * authority by design, answers false here as it should.
 *
 * What this is NOT: a security boundary against code already running in the
 * daemon's process. Anything executing there can call {@link markDaemonProcess}
 * the way the daemon does. The boundary that keeps an agent out of this process
 * is elsewhere and unchanged: `approval daemon run` and `approval up` classify
 * `gate.self`, which this repository's policy leaves at the fail-closed manual
 * default, so an agent cannot start a daemon unattended in the first place.
 * What this module removes is the smaller and likelier failure — a future
 * caller wiring the autonomous route through a struct field, in a session, by
 * accident.
 */

/** The pid of the process that declared itself the daemon, or `null`. */
let daemonPid: number | null = null;

/**
 * Declare this process the daemon runtime. Called by the daemon, and only by it.
 *
 * Idempotent, and argument-free on purpose: there is no spelling of this call
 * that marks a process other than the caller's own.
 */
export function markDaemonProcess(): void {
  daemonPid = process.pid;
}

/**
 * Forget the mark. For tests, and for a runtime that stops being a daemon.
 *
 * Present so a suite can exercise both actors in one file without a second
 * process. Clearing is always the STRICTER direction — an unmarked process
 * takes the supervised route — so nothing widens by calling it.
 */
export function clearDaemonProcess(): void {
  daemonPid = null;
}

/** Is this process the daemon runtime? */
export function isDaemonProcess(): boolean {
  return daemonPid !== null && daemonPid === process.pid;
}
