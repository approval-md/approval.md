/**
 * The CLI edge of `approval log sync` and `approval log advance` (APRV-125).
 *
 * As everywhere else in this CLI, no logic lives here. The ceremonies are
 * `cli/log-sync.ts` and `cli/log-advance.ts`; this file splits argv, reads the
 * clock once at the edge, maps a result onto the frozen exit table, and decides
 * what a terminal sees.
 *
 * The refusals that a human has to ACT on are rendered as runbooks (APRV-129):
 * `log-diverged` above all, because it is the one outcome that ends with a
 * person deciding which of two chains is the log, and a paragraph is the wrong
 * shape for that.
 */

import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { LOG_ADVANCE_HELP, LOG_SYNC_HELP } from "./help.js";
import { logAdvance, type LogAdvanceResult } from "./log-advance.js";
import { logSync, short, type LogSyncResult } from "./log-sync.js";
import type { Streams } from "./main.js";
import { createProgress, silentProgress } from "./progress.js";
import { describeHead } from "../core/log-reconcile.js";
import { relPath, refusal as renderRefusal, runbook, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const SYNC_FLAGS: Record<string, FlagKind> = {
  "--remote": "string",
  "--branch": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const ADVANCE_FLAGS: Record<string, FlagKind> = {
  "--remote": "string",
  "--branch": "string",
  "--base": "string",
  "--pr": "boolean",
  "--dry-run": "boolean",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function usageError(streams: Streams, json: boolean, message: string, help: string): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, help));
  return EXIT_USAGE;
}

/**
 * The exit code for a refusal.
 *
 * Drawn exactly where every other verb draws it: a divergence is a statement
 * about the log's integrity and is exit 1; everything else here is a
 * filesystem or a git fact, which is exit 4. A usage error never reaches this.
 */
function refusalExit(code: string): number {
  return code === "log-diverged" || code.endsWith("unverified") ? EXIT_INTEGRITY : EXIT_IO;
}

// ===========================================================================
// log sync
// ===========================================================================

export function commandLogSync(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const st = style({ json });
  const parsed = parseFlags(argv, SYNC_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, LOG_SYNC_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${LOG_SYNC_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, LOG_SYNC_HELP);
  }

  const remote = stringFlag(parsed.flags, "--remote");
  const branch = stringFlag(parsed.flags, "--branch");
  const result = logSync({
    cwd,
    ...(remote === null ? {} : { remote }),
    ...(branch === null ? {} : { branch }),
  });

  if (!result.ok) return reportSyncRefusal(result, streams, cwd, json, st);

  const report = result.report;
  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        root: report.root,
        log: report.logPath,
        remote: report.remote,
        branch: report.branch,
        commit: { before: report.commitBefore, after: report.commitAfter, pulled: report.pulled },
        head: { before: report.headBefore, after: report.headAfter },
        relation: report.relation,
        ahead: report.ahead,
        behind: report.behind,
        restored: report.restored,
        payloads: { reconciled: report.payloadsReconciled },
        queue: report.queue,
        index: report.index,
      })}\n`,
    );
    return EXIT_OK;
  }

  streams.out(`${st.glyph("ok")} log sync — the working chain is intact\n`);
  for (const line of st
    .table([
      { left: "checkout", right: relPath(report.root, cwd) },
      { left: "pulled", right: `${String(report.pulled)} commit(s)  ${st.muted(`${short(report.commitBefore)} → ${short(report.commitAfter)}`)}` },
      { left: "chain", right: describeRelation(report.relation, report.ahead, report.behind) },
      { left: "head", right: describeHead(report.headAfter) },
      { left: "snapshot", right: report.restored ? "restored over the pulled baseline" : "not needed" },
      {
        left: "payloads",
        right:
          report.payloadsReconciled === 0
            ? "none in the fast-forward's way"
            : `${String(report.payloadsReconciled)} untracked file(s) proved identical to the incoming commit`,
      },
      {
        left: "projections",
        right: `QUEUE.md rebuilt (${String(report.queue.bytes)} bytes), index ${report.index}`,
      },
    ])
    .split("\n")) {
    streams.out(`  ${line}\n`);
  }
  return EXIT_OK;
}

function describeRelation(relation: string, ahead: number, behind: number): string {
  switch (relation) {
    case "ahead":
      return `working ahead by ${String(ahead)} record(s); the committed baseline was a prefix`;
    case "behind":
      return `the pull brought ${String(behind)} record(s) this checkout did not have`;
    default:
      return "committed and working are the same chain";
  }
}

function reportSyncRefusal(
  result: Extract<LogSyncResult, { ok: false }>,
  streams: Streams,
  cwd: string,
  json: boolean,
  st: ReturnType<typeof style>,
): number {
  if (json) {
    streams.err(
      `${JSON.stringify({
        ok: false,
        error: { code: result.code, message: result.message },
        step: result.step,
        restored: result.restored,
        ...(result.drift === undefined ? {} : { drift: result.drift }),
      })}\n`,
    );
    return refusalExit(result.code);
  }

  if (result.code === "log-diverged" && result.drift !== undefined) {
    const drift = result.drift;
    streams.err(
      `${runbook(st, "log-diverged", "the committed log and the working log are two different chains", {
        state: [
          `they agree through seq ${String((drift.firstDivergentSeq ?? 1) - 1)} and part at seq ${String(drift.firstDivergentSeq)}`,
          `working  ${describeHead(drift.workingHead)}`,
          `committed ${describeHead(drift.committedHead)}`,
          "your working log is EXACTLY as it was found: the snapshot was restored",
          "nothing was merged and nothing was re-chained",
        ],
        steps: [
          { command: "approval log verify", note: "the working chain, end to end" },
          { command: "approval doctor", note: "the log-drift check names the same seq" },
          {
            command: "git log --oneline -- .approval/log/events.jsonl",
            note: "who committed the other chain",
          },
        ],
        footer: [
          "hash chains do not merge: one of these two is the log, and choosing is a human decision",
          "why: docs/cli-reference.md#log-sync",
        ],
      })}\n`,
    );
    return refusalExit(result.code);
  }

  streams.err(`${renderRefusal(st, result.code, result.message)}\n`);
  for (const line of result.quote ?? []) streams.err(`    ${st.muted(line)}\n`);
  return refusalExit(result.code);
}

// ===========================================================================
// log advance
// ===========================================================================

export function commandLogAdvance(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const st = style({ json });
  const parsed = parseFlags(argv, ADVANCE_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, LOG_ADVANCE_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${LOG_ADVANCE_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, LOG_ADVANCE_HELP);
  }

  const remote = stringFlag(parsed.flags, "--remote");
  const branch = stringFlag(parsed.flags, "--branch");
  if (branch !== null && branch.trim().length === 0) {
    return usageError(streams, json, "--branch expects a branch name", LOG_ADVANCE_HELP);
  }

  // The one clock read on this path: the default records branch carries the
  // date, and a verb that read the clock twice could name two different days.
  const base = stringFlag(parsed.flags, "--base");
  if (base !== null && base.trim().length === 0) {
    return usageError(streams, json, "--base expects a branch name", LOG_ADVANCE_HELP);
  }

  const result = logAdvance({
    cwd,
    today: new Date().toISOString(),
    // APRV-167/APRV-203: the phases go to stderr, and `--json` gets none.
    progress: json ? silentProgress : createProgress(streams),
    ...(remote === null ? {} : { remote }),
    ...(branch === null ? {} : { branch }),
    ...(base === null ? {} : { base }),
    ...(boolFlag(parsed.flags, "--pr") ? { pr: true } : {}),
    ...(boolFlag(parsed.flags, "--dry-run") ? { dryRun: true } : {}),
  });

  if (!result.ok) return reportAdvanceRefusal(result, streams, json, st);

  const report = result.report;
  if (json) {
    streams.out(
      `${JSON.stringify({
        ok: true,
        root: report.root,
        branch: report.branch,
        recordsBranch: report.recordsBranch,
        remote: report.remote,
        base: report.base,
        parent: report.parent ?? null,
        reusedRecordsBranch: report.reusedRecordsBranch ?? false,
        range: report.range,
        head: { committed: report.committedHead, working: report.workingHead },
        staged: report.staged,
        message: report.message,
        commit: report.commit,
        pushed: report.pushed,
        prUrl: report.prUrl,
        prCreated: report.prCreated ?? false,
        dryRun: report.dryRun,
      })}\n`,
    );
    return EXIT_OK;
  }

  const range = report.range;
  if (range === null) {
    streams.out(
      `nothing to advance: the committed log already carries every record in ${relPath(
        `${report.root}/.approval/log/events.jsonl`,
        cwd,
      )} (${describeHead(report.workingHead)})\n`,
    );
    return EXIT_OK;
  }
  streams.out(
    report.dryRun
      ? `${st.warn("--dry-run:")} nothing was staged, committed or pushed. The advance would carry:\n`
      : `${st.glyph("ok")} log advance — seq ${String(range.from)}..${String(range.to)} is on ${report.recordsBranch}\n`,
  );
  for (const line of st
    .table([
      { left: "message", right: report.message },
      {
        left: "based on",
        right:
          report.base === null
            ? "(unknown)"
            : `${report.remote}/${report.base.branch}  ${st.muted(short(report.base.sha))}`,
      },
      ...(report.parent === undefined || report.parent.ref === `${report.remote}/${report.base?.branch ?? ""}`
        ? []
        : [
            {
              left: "parent",
              right: `${report.parent.ref}  ${st.muted(
                `${short(report.parent.sha)} — the day's records branch, updated rather than re-created`,
              )}`,
            },
          ]),
      { left: "carries", right: report.staged.join(", ") },
      { left: "commit", right: report.commit === null ? "(dry run)" : short(report.commit) },
      {
        left: "pushed",
        right: report.pushed ? `${report.remote} ${report.recordsBranch}` : "not pushed",
      },
      ...(report.prUrl === null ? [] : [{ left: "pull request", right: report.prUrl }]),
    ])
    .split("\n")) {
    streams.out(`  ${line}\n`);
  }
  if (!report.dryRun && report.pushed) {
    streams.out(
      `\n  ${st.muted(`your checkout is exactly as you left it, on ${report.branch}: nothing was checked out, staged or moved`)}\n`,
    );
    if (report.prUrl === null) {
      streams.out(
        `  ${st.muted("open the pull request and merge it with a MERGE COMMIT (--pr opens it for you)")}\n`,
      );
    }
  }
  return EXIT_OK;
}

function reportAdvanceRefusal(
  result: Extract<LogAdvanceResult, { ok: false }>,
  streams: Streams,
  json: boolean,
  st: ReturnType<typeof style>,
): number {
  if (json) {
    streams.err(
      `${JSON.stringify({
        ok: false,
        error: { code: result.code, message: result.message },
        ...(result.offending === undefined ? {} : { offending: result.offending }),
      })}\n`,
    );
    return advanceExit(result.code);
  }

  if (result.code === "log-advance-dirty-stage" && result.offending !== undefined) {
    streams.err(
      `${runbook(st, result.code, "paths are staged that an advance may not carry", {
        state: [
          "an advance commits the log, QUEUE.md and .approval/payloads/, and nothing else",
          `staged and not allowed: ${result.offending.join(", ")}`,
          "nothing was staged, committed or pushed by this run",
        ],
        steps: result.offending.map((path) => ({ command: `git restore --staged ${path}` })),
        footer: [
          "a log commit that rides other work is what the one-commit rule forbids",
          "why: docs/cli-reference.md#log-advance",
        ],
      })}\n`,
    );
    return advanceExit(result.code);
  }

  streams.err(`${renderRefusal(st, result.code, result.message)}\n`);
  for (const line of result.quote ?? []) streams.err(`    ${st.muted(line)}\n`);
  return advanceExit(result.code);
}

function advanceExit(code: string): number {
  return code.endsWith("unverified") ? EXIT_INTEGRITY : EXIT_IO;
}
