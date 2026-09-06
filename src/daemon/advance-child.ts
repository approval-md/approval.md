/**
 * The daemon's advance, run in a child process (APRV-211).
 *
 * ## Why this file exists
 *
 * `approval up` runs the daemon loop and the Telegram listener in one process,
 * and `cli/log-advance.ts` is `spawnSync` from end to end. So an advance run on
 * the daemon's own stack blocks the loop for as long as `git fetch`, the
 * scratch-index commit, `git push` and `gh pr create` take, and every callback
 * that arrived meanwhile was answered past Telegram's window: the
 * `answerCallbackQuery: HTTP 400`s Carter saw on 2026-09-02. Nothing that runs
 * on that loop can fix it, because synchronous work does not yield. Another
 * process can.
 *
 * ## What it is allowed to do, and what it is not
 *
 * It runs the verb. That is the entire remit.
 *
 * It does NOT touch the gate, and it could not if it tried: `core/child-env.ts`
 * strips `APPROVAL_*` from a child's environment (APRV-205), which is where the
 * `supervised-live` draw's secret lives, so a child that asked the gate would
 * fail closed on every tick. The register/request/start half happens in the
 * daemon before this is spawned and the `execution.completed`/`failed` is
 * appended by the daemon after it exits. This process appends nothing, decides
 * nothing, and holds no authority: if it were replaced wholesale by something
 * hostile, the worst it could do is refuse to advance the log or report a
 * failure that did not happen — it cannot authorise anything, because by the
 * time it runs the authorisation is already in the log and already spent.
 *
 * ## The protocol
 *
 * One argument: the JSON `LogAdvanceOptions` subset the daemon chose. One line
 * on stdout: the `LogAdvanceResult` verbatim, `{ok:true,report}` or
 * `{ok:false,code,message}`. The parent VALIDATES that line rather than
 * trusting it, and treats anything else as a failed advance with a
 * machine-readable reason. Nothing is written to stdout but that line, which is
 * why the verb is given no progress reporter.
 */

import { logAdvance } from "../cli/log-advance.js";

interface ChildRequest {
  cwd: string;
  remote: string;
  base: string | null;
  pr: boolean;
  /** APRV-284. Absent from an older parent's request, which means "arm it". */
  autoMerge?: boolean;
  branch: string;
  today: string;
}

function fail(code: string, message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(0);
}

function main(): void {
  const raw = process.argv[2];
  if (raw === undefined) {
    fail("log-advance-child-unreadable", "the advance child was given no request to run");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    fail(
      "log-advance-child-unreadable",
      `the advance child could not read its request: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    fail("log-advance-child-unreadable", "the advance child's request was not an object");
  }
  const requested = parsed as unknown as ChildRequest;

  let result;
  try {
    result = logAdvance({
      cwd: requested.cwd,
      remote: requested.remote,
      base: requested.base,
      pr: requested.pr,
      autoMerge: requested.autoMerge !== false,
      branch: requested.branch,
      today: requested.today,
    });
  } catch (cause) {
    fail(
      "log-advance-git-failed",
      `the advance threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
