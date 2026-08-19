/**
 * `approval daemon run` — the foreground daemon verb (SPEC.md §10.2, APRV-39).
 *
 * As everywhere else in this CLI, **no logic lives here**. The loop, the drift
 * comparison, the TTL sweep, and the queue regeneration are `daemon/daemon.ts`
 * and `daemon/projection.ts`; every append they make goes through the same
 * `core/gate.ts` and `core/log.ts` paths every other verb uses. This file
 * resolves paths, validates two durations, renders the daemon's event stream as
 * text or JSON, installs the signal handlers, and chooses an exit code.
 *
 * ## Foreground, deliberately
 *
 * `approval daemon run` runs in the foreground and stops on SIGINT/SIGTERM. It
 * does not fork, write a pidfile, or manage its own lifecycle: in v0.1
 * backgrounding is the operator's business, and `systemd`, `launchd`, `tmux`,
 * and `&` all already do it better than a bespoke daemonizer would. That is
 * stated in `--help` because an operator has to know it before they type it, and
 * it is exactly the stance `approval channel telegram listen` takes for the same
 * reason.
 *
 * ## What the exit code means
 *
 * A clean stop is 0 — a signal is how this verb is *supposed* to end. The three
 * non-zero endings are the log's, mapped onto the frozen table exactly as every
 * other verb maps them: 4 when the log cannot be read, 3 when its tail is torn,
 * 1 when the chain does not verify. The daemon stops rather than degrades on all
 * three, because nothing may be appended onto a log that does not verify and a
 * projection of one would be a screenshot of something nobody should read.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TASKS_DIR,
  Daemon,
  isDirectory,
  type DaemonEvent,
  type DaemonOptions,
  type DaemonOutcome,
} from "../daemon/daemon.js";
import { enableGitEvidence, type GitEvidenceEvent } from "../daemon/git-evidence.js";
import { parseDuration } from "../core/policy-load.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { DAEMON_HELP, DAEMON_RUN_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { DEFAULT_QUEUE_PATH } from "./render.js";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const RUN_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--tasks": "string",
  "--out": "string",
  "--policy": "string",
  "--dir": "string",
  "--interval": "string",
  "--debounce": "string",
  "--once": "boolean",
  "--git-evidence": "boolean",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, help: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, help));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

/** A duration flag, in the policy's own `<n><unit>` vocabulary (SPEC.md §5.2). */
function durationFlag(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
): { ok: true; ms: number } | { ok: false; message: string } {
  const raw = stringFlag(flags, name);
  if (raw === null) return { ok: true, ms: fallback };
  const ms = parseDuration(raw);
  if (ms === null || ms <= 0) {
    return {
      ok: false,
      message: `${name} expects a duration like 30s, 5m or 250ms (a positive integer and one unit of ms|s|m|h|d|w), got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, ms };
}

/**
 * One daemon event as a human sentence.
 *
 * Warnings go to stderr and everything else to stdout, so `approval daemon run >
 * daemon.log` keeps the narrative and leaves the complaints on the terminal.
 */
function describe(event: DaemonEvent): { text: string; stderr: boolean } {
  switch (event.event) {
    case "started":
      return {
        text: `daemon: watching ${event.tasks} and ${event.log}; queue ${event.queue}; tick every ${String(
          event.interval_ms,
        )}ms${event.watching ? "" : " (fs watch unavailable — polling only)"}`,
        stderr: false,
      };
    case "drift":
      // The envelope-missing case (APRV-63) reads differently on purpose: there
      // is no claim to quote, and the repair is a restoration a human makes.
      if (event.reason === "envelope-missing") {
        return {
          text: `envelope.drift: ${event.task} (${event.file}) has NO approval: envelope, but the log registered it — the log says state ${event.derived_state}; recorded at seq ${String(
            event.seq,
          )}. Restore the envelope by hand from the log; the runtime never rewrites the file`,
          stderr: false,
        };
      }
      return {
        text: `envelope.drift: ${event.task} (${event.file}) claims state ${
          event.declared_state === null ? "<none>" : event.declared_state
        }, the log says ${event.derived_state} — recorded at seq ${String(
          event.seq,
        )}; the file is repaired to match the log later in this tick`,
        stderr: false,
      };
    case "write_back":
      return {
        text: `write-back: ${event.task} (${event.file}) state ${
          event.from === null ? "<none>" : event.from
        } -> ${event.to}, ${String(event.bytes)} bytes; the file now says what the log says`,
        stderr: false,
      };
    case "expired":
      return {
        text: `approval.expired: ${event.action_key} lapsed its TTL — recorded at seq ${String(event.seq)}`,
        stderr: false,
      };
    case "sampled":
      return {
        text: `audit.sampled: ${event.action_key} drawn for review (execution.started at seq ${String(
          event.subject_seq,
        )}) — recorded at seq ${String(event.seq)}`,
        stderr: false,
      };
    case "pruned":
      return {
        text: `payload.pruned: ${event.payload_hash} removed (${event.reason}${
          event.action_key === null ? "" : `, ${event.action_key}`
        }) — recorded at seq ${String(event.seq)}`,
        stderr: false,
      };
    case "rendered":
      return {
        text: `queue: ${event.path} regenerated (${String(event.bytes)} bytes, ${String(
          event.pending,
        )} pending, ${String(event.skipped)} not summarized, ${String(
          event.audit_backlog,
        )} awaiting audit review)`,
        stderr: false,
      };
    case "escalated":
      return {
        text: `loop escalation: ${event.task} has ${String(
          event.consecutive_failures,
        )} consecutive execution.failed and is escalated to manual; its supervised and autonomous actions are refused until an execution.completed lands`,
        stderr: false,
      };
    case "escalation_cleared":
      return {
        text: `loop escalation cleared: ${event.task} recorded an execution.completed`,
        stderr: false,
      };
    case "tick":
      return {
        text: `tick ${String(event.n)}: head ${
          event.head === null ? "none" : `seq ${String(event.head)}`
        }, ${String(event.drift)} drift, ${String(event.expired)} expired, ${String(
          event.escalated,
        )} escalated`,
        stderr: false,
      };
    case "warning":
      return { text: renderRefusal(style(), event.code, event.message), stderr: true };
    case "stopped":
      return {
        text: `daemon: stopped (${event.reason}) after ${String(event.ticks)} tick(s): ${String(
          event.drift,
        )} drift, ${String(event.expired)} expired, ${String(event.renders)} render(s)`,
        stderr: false,
      };
  }
}

/**
 * One git-evidence line as a human sentence (APRV-42).
 *
 * Its own function rather than a branch of {@link describe}, because the
 * hardening layer has its own frozen event shape and `daemon/daemon.ts`'s union
 * is untouched by the opt-in. Failures go to stderr with everything else that
 * complains.
 */
function describeGitEvidence(event: GitEvidenceEvent): { text: string; stderr: boolean } {
  if (event.event === "git_evidence_failed") {
    return { text: renderRefusal(style(), "git-evidence", event.message), stderr: true };
  }
  const covered =
    event.records === null
      ? "the log as it stands"
      : `${String(event.records)} record(s) since the previous commit`;
  return {
    text: `git evidence: commit ${event.commit} witnesses seq ${String(event.seq)} (${covered})`,
    stderr: false,
  };
}

/** The outcome → frozen exit code mapping, drawn where every other verb draws it. */
function exitFor(outcome: DaemonOutcome): number {
  switch (outcome.kind) {
    case "stopped":
      return EXIT_OK;
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    case "log-corrupt":
      return EXIT_INTEGRITY;
  }
}

/**
 * `approval daemon run`. Returns a promise, so `main` treats `daemon` the way it
 * treats `channel`: the CLI is synchronous by contract, and the two long-lived
 * verbs report their eventual code through `process.exitCode`.
 */
export function commandDaemonRun(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, RUN_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, DAEMON_RUN_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${DAEMON_RUN_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      DAEMON_RUN_HELP,
    );
  }

  const flags = parsed.flags;
  const interval = durationFlag(flags, "--interval", DEFAULT_INTERVAL_MS);
  if (!interval.ok) return usageError(streams, json, interval.message, DAEMON_RUN_HELP);
  const debounce = durationFlag(flags, "--debounce", DEFAULT_DEBOUNCE_MS);
  if (!debounce.ok) return usageError(streams, json, debounce.message, DAEMON_RUN_HELP);

  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const queuePath = resolvePath(stringFlag(flags, "--out"), DEFAULT_QUEUE_PATH, cwd);
  const tasksFlag = stringFlag(flags, "--tasks");
  const tasksDir = resolvePath(tasksFlag, DEFAULT_TASKS_DIR, cwd);

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  // An explicitly named task folder that does not exist is a typo, and a daemon
  // that watched nothing while reporting success would hide it. The DEFAULT
  // folder is allowed to be absent: a repository with no `backlog/` is a
  // legitimate log-only deployment, and it is warned about, not refused.
  if (!isDirectory(tasksDir)) {
    if (tasksFlag !== null) {
      return ioError(
        streams,
        json,
        `--tasks ${tasksDir} is not a directory; nothing would be watched for envelope drift`,
      );
    }
    streams.err(
      `approval: task folder ${tasksDir} does not exist, so no envelope drift can be detected; the TTL sweep and the queue projection run anyway (pass --tasks <dir> if your task files live elsewhere)\n`,
    );
  }

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  const options: DaemonOptions = {
    logPath,
    tasksDir,
    queuePath,
    policy,
    cwd,
    intervalMs: interval.ms,
    debounceMs: debounce.ms,
    once: boolFlag(flags, "--once"),
    sink: {
      emit: (event) => {
        if (json) {
          const line = `${JSON.stringify(event)}\n`;
          if (event.event === "warning") streams.err(line);
          else streams.out(line);
          return;
        }
        const rendered = describe(event);
        if (rendered.stderr) streams.err(`${rendered.text}\n`);
        else streams.out(`${rendered.text}\n`);
      },
    },
  };

  // SPEC.md §8's optional git hardening (APRV-42). Opt-in, checked here and
  // never later: an operator who asked for a second evidence layer and silently
  // did not get one is worse off than one who was refused at startup, so every
  // precondition is judged before the first tick and a failure ends the verb.
  if (boolFlag(flags, "--git-evidence")) {
    const enabled = enableGitEvidence(logPath, (event) => {
      if (json) {
        const line = `${JSON.stringify(event)}\n`;
        if (event.event === "git_evidence_failed") streams.err(line);
        else streams.out(line);
        return;
      }
      const rendered = describeGitEvidence(event);
      if (rendered.stderr) streams.err(`${rendered.text}\n`);
      else streams.out(`${rendered.text}\n`);
    });
    if (!enabled.ok) {
      if (json) {
        streams.err(
          `${JSON.stringify({ error: { code: enabled.code, message: enabled.message } })}\n`,
        );
      } else {
        streams.err(`approval: ${enabled.message}\n`);
      }
      // A missing binary or a missing directory is the environment failing to
      // match the request (I/O); a repository in the wrong shape is the request
      // failing to match a valid deployment (usage). The repair differs, and so
      // does the code an operator's supervisor branches on.
      return enabled.code === "git-unavailable" || enabled.code === "log-dir-missing"
        ? EXIT_IO
        : EXIT_USAGE;
    }
    options.gitEvidence = enabled.recorder;
  }

  const daemon = new Daemon(options);
  const stop = (signal: NodeJS.Signals): void => daemon.stop(signal);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return daemon.run().then(
    (outcome) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (outcome.kind !== "stopped") {
        if (json) {
          streams.err(
            `${JSON.stringify({ error: { code: outcome.kind, message: outcome.message } })}\n`,
          );
        } else {
          streams.err(`approval: ${outcome.message}\n`);
        }
      }
      return exitFor(outcome);
    },
    (cause: unknown) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      throw cause;
    },
  );
}

/** `approval daemon <subcommand>` — `run`, and nothing else at v0.1. */
export function commandDaemon(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval daemon`", DAEMON_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${DAEMON_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "run") return commandDaemonRun(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval daemon\``,
    DAEMON_HELP,
  );
}
