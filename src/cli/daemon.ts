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
import { defaultCadence, type AdvanceCadence } from "../daemon/advance.js";
import { drawServerFor } from "../daemon/draw.js";
import { enableGitEvidence, type GitEvidenceEvent } from "../daemon/git-evidence.js";
import {
  DEFAULT_DARK_INTERVAL_MS,
  DEFAULT_DARK_WINDOW_MS,
} from "../daemon/dark-session.js";
import {
  DEFAULT_POLICY_DAEMON_READ,
  loadPolicy,
  parseDuration,
  type LoadPolicyOptions,
} from "../core/policy-load.js";
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
import { useReadProof } from "../core/state.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import {
  describePreflightEvent,
  reexecFreshBuild,
  startupPreflight,
} from "./preflight.js";
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
  // The watcher trace (APRV-230). A diagnostic: it prints one line per
  // filesystem event, ignored ones included, and changes nothing else.
  "--trace-watch": "boolean",
  "--git-evidence": "boolean",
  // The cadence advance (APRV-204). Opt-in, like `--git-evidence`: it pushes to
  // a remote and opens pull requests, which a daemon must never start doing
  // because a default moved under an operator who did not ask.
  "--advance": "boolean",
  "--advance-interval": "string",
  "--advance-after": "string",
  "--advance-remote": "string",
  "--advance-base": "string",
  "--no-advance-pr": "boolean",
  // The dark-session sweep (APRV-192). Opt-in for the reason above, in a milder
  // form: it runs `git log` over every worktree of the checkout on a cadence.
  "--dark-sessions": "boolean",
  // The live draw (APRV-208). A way OUT only: serving draws needs the sampling
  // secret in this process's environment, which is already an operator's
  // deliberate act, so there is nothing to opt into. This is here so an operator
  // can take the control back without unsetting a variable their shell profile
  // exports.
  "--no-draw": "boolean",
  "--dark-window": "string",
  "--dark-interval": "string",
  // The prefix proof (APRV-217). A flag here beats the `daemon` policy block
  // for this run and nothing else; the policy is what an unattended service
  // reads.
  "--read-proof": "string",
  "--full-reproof-every": "string",
  "--full-reproof-after": "string",
  // The startup preflight (APRV-215), spelled identically on `approval up`.
  "--no-preflight": "boolean",
  "--preflight-remote": "string",
  "--preflight-base": "string",
  // Test-only, spelled exactly as doctor's and `up`'s.
  "--root": "string",
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

/**
 * A duration flag, in the policy's own `<n><unit>` vocabulary (SPEC.md §5.2).
 *
 * Exported for `approval up` (APRV-110), which accepts the same three durations
 * and must refuse a typo in exactly the same words.
 */
export function durationFlag(
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
 * The cadence-advance flags, as one cadence or none (APRV-204).
 *
 * Exported for `approval up`, which accepts every `daemon run` flag and must
 * refuse a typo in exactly the same words — the reason {@link durationFlag} is
 * exported, and the reason this parsing is not written twice.
 *
 * Every duration and count is judged HERE, before the first tick: a daemon that
 * accepted `--advance-after twenty` and quietly advanced on the default would be
 * lying about its own configuration for as long as it ran.
 */
export function advanceFlags(
  flags: Record<string, string | boolean>,
): { ok: true; cadence: AdvanceCadence | null } | { ok: false; message: string } {
  if (!boolFlag(flags, "--advance")) return { ok: true, cadence: null };
  const fallback = defaultCadence();

  const interval = durationFlag(flags, "--advance-interval", fallback.intervalMs);
  if (!interval.ok) return { ok: false, message: interval.message };

  const afterRaw = stringFlag(flags, "--advance-after");
  const after = afterRaw === null ? fallback.afterRecords : Number.parseInt(afterRaw, 10);
  if (!Number.isInteger(after) || after < 1) {
    return {
      ok: false,
      message: `--advance-after expects a positive whole number of records, got ${JSON.stringify(afterRaw)}`,
    };
  }

  return {
    ok: true,
    cadence: {
      intervalMs: interval.ms,
      afterRecords: after,
      remote: stringFlag(flags, "--advance-remote") ?? fallback.remote,
      base: stringFlag(flags, "--advance-base"),
      pr: !boolFlag(flags, "--no-advance-pr"),
    },
  };
}

/**
 * The prefix-proof flags, resolved against the policy (APRV-217).
 *
 * Precedence is the one every override in this CLI uses: the flag wins for this
 * run, the policy governs when no flag was typed, and an unloadable policy
 * yields the default — which here is `full`, the strictest and most expensive
 * proof, so a policy nobody could read cannot buy a cheaper one.
 *
 * Exported for `approval up`, which accepts every `daemon run` flag and must
 * refuse a typo in exactly the same words — the reason {@link durationFlag} and
 * {@link advanceFlags} are exported.
 */
export function readProofFlags(
  flags: Record<string, string | boolean>,
  policy: LoadPolicyOptions,
):
  | { ok: true; readProof: { mode: "full" | "incremental"; everyReads: number; afterMs: number } }
  | { ok: false; message: string } {
  const loaded = loadPolicy(policy);
  const configured = loaded.ok ? loaded.daemon : DEFAULT_POLICY_DAEMON_READ;

  const modeRaw = stringFlag(flags, "--read-proof");
  if (modeRaw !== null && modeRaw !== "full" && modeRaw !== "incremental") {
    return {
      ok: false,
      message: `--read-proof expects full or incremental, got ${JSON.stringify(modeRaw)}`,
    };
  }
  const mode = modeRaw === null ? configured.readProof : modeRaw;

  const everyRaw = stringFlag(flags, "--full-reproof-every");
  const everyReads = everyRaw === null ? configured.fullReproofEvery : Number.parseInt(everyRaw, 10);
  if (!Number.isInteger(everyReads) || everyReads < 1) {
    return {
      ok: false,
      message: `--full-reproof-every expects a positive whole number of reads, got ${JSON.stringify(everyRaw)}`,
    };
  }

  const after = durationFlag(flags, "--full-reproof-after", configured.fullReproofAfterMs);
  if (!after.ok) return { ok: false, message: after.message };

  return { ok: true, readProof: { mode, everyReads, afterMs: after.ms } };
}

/**
 * One daemon event as a human sentence.
 *
 * Warnings go to stderr and everything else to stdout, so `approval daemon run >
 * daemon.log` keeps the narrative and leaves the complaints on the terminal.
 */
export function describeDaemonEvent(event: DaemonEvent): { text: string; stderr: boolean } {
  switch (event.event) {
    case "started":
      return {
        // The prefix proof is named on the line an operator already reads
        // (APRV-217): which proof the reads of this run pay is configuration,
        // and configuration nobody is told about is the failure mode this
        // project exists to prevent.
        text: `daemon: watching ${event.tasks} and ${event.log}; queue ${event.queue}; tick every ${String(
          event.interval_ms,
        )}ms; read proof ${event.read_proof}; anchor ${
          // APRV-219: named for the reason the prefix proof is. Which external
          // witness this run holds its log to is not something an operator
          // should have to ask a running process about, and "none" is a fact
          // worth printing rather than a blank.
          event.anchor.rev === null
            ? `none (${event.anchor.reason ?? "no committed copy of the log"})`
            : `${event.anchor.rev} seq ${String(event.anchor.seq ?? 0)}`
        }${event.watching ? "" : " (fs watch unavailable — polling only)"}`,
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
    case "advance":
      // The refused and gated outcomes go to stderr beside their warning, for
      // the reason every warning does: a records branch that did not move is a
      // complaint, and a complaint belongs where an operator's eye is.
      return {
        text:
          event.outcome === "advanced"
            ? `log advance: ${event.message}${event.flush ? " (shutdown flush)" : ""}${
                event.pr_created ? " — pull request opened" : ""
              }`
            : `log advance ${event.outcome}${event.code === null ? "" : ` (${event.code})`}: ${
                event.message
              } — ${String(event.records_pending)} record(s) still off ${
                event.records_branch ?? "any records branch"
              }`,
        stderr: event.outcome !== "advanced",
      };
    case "dark_session":
      // Both verdicts go to stderr. A dark session is the loudest thing this
      // loop can say — git activity nobody was told about — and an undetermined
      // one is a gap in the detector's own sight; neither belongs in the stream
      // an operator scrolls past.
      return {
        text: renderRefusal(
          style(),
          event.verdict === "dark" ? `dark-session:${event.code}` : `dark-session-undetermined:${event.code}`,
          `${event.subject}${event.branch === null ? "" : ` (branch ${event.branch})`}: ${
            event.message
          }${
            event.seq === null
              ? event.already_recorded
                ? " — already recorded in this log; nothing appended"
                : ""
              : ` — recorded at seq ${String(event.seq)}`
          }`,
        ),
        stderr: true,
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
    case "watch":
      // APRV-230's trace, off unless the operator asked for it. On stdout with
      // the rest of the narrative: it is an observation, not a complaint, and an
      // operator who turned it on is reading it.
      return {
        text: `watch: ${event.watcher} ${event.type} ${event.file ?? "<unnamed>"} — ${
          event.action === "scheduled" ? "tick scheduled" : `ignored (${event.reason ?? "?"})`
        }`,
        stderr: false,
      };
    case "tick":
      return {
        // The cost of the tick is on the line an operator already reads
        // (APRV-211): a tick that takes seconds, or that reads the log dozens of
        // times, is the shape of the incident this field exists to make obvious.
        // What WOKE it is on the same line for the same reason (APRV-230): a
        // tick nobody asked for costs exactly as much as one somebody did.
        text: `tick ${String(event.n)}: head ${
          event.head === null ? "none" : `seq ${String(event.head)}`
        }, ${String(event.drift)} drift, ${String(event.expired)} expired, ${String(
          event.escalated,
        )} escalated (${String(event.ms)} ms, ${String(event.reads)} reads, woke by ${
          event.woke_by
        }${event.woke_file === undefined ? "" : ` ${event.woke_file}`})`,
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
export function describeGitEvidence(event: GitEvidenceEvent): { text: string; stderr: boolean } {
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
export function exitForDaemonOutcome(outcome: DaemonOutcome): number {
  switch (outcome.kind) {
    case "stopped":
      return EXIT_OK;
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    case "log-corrupt":
      return EXIT_INTEGRITY;
    // APRV-219. Drawn where `log-corrupt` is drawn, and for the same reason: a
    // log that contradicts its own committed copy is an integrity failure, and
    // a supervisor that restarts on 4 and stops on 1 must stop on this.
    case "anchor-diverged":
      return EXIT_INTEGRITY;
    // APRV-220. The same place again, for the third witness: a log that
    // contradicts a signature a human made over it is an integrity failure,
    // whatever the chain walk and the committed copy say about it.
    case "checkpoint-invalid":
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
  // APRV-110. `--with-channels` is the same verb as `approval up`, spelled from
  // the daemon's side for an operator who already has the daemon invocation in a
  // unit file. Answered BEFORE the flag table below, because the ambient runtime
  // accepts flags this one does not (an approver identity, a Bot API base, a
  // port), and a parse against this table would refuse them first. The import is
  // dynamic so that `cli/up.ts` can go on statically importing this module for
  // its daemon-event renderers without an ESM cycle between the two.
  if (argv.includes("--with-channels")) {
    const rest = argv.filter((word) => word !== "--with-channels");
    return import("./up.js").then((module) => module.commandUp(rest, streams, cwd));
  }

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

  // The startup preflight (APRV-215), the same one `approval up` runs, from the
  // same module, printing the same two lines. It is here as well as there
  // because the daemon is the writer: a daemon started against a stale checkout
  // is the failure this preflight exists to catch, and `--with-channels` is not
  // the only way an operator reaches it. `--no-preflight` opts out on both.
  if (!boolFlag(flags, "--no-preflight")) {
    const rootFlag = stringFlag(flags, "--root");
    const cleared = startupPreflight({
      logPath,
      queuePath,
      root: rootFlag === null ? null : absolute(rootFlag, cwd),
      remote: stringFlag(flags, "--preflight-remote"),
      branch: stringFlag(flags, "--preflight-base"),
      json,
      emit: (event) => {
        if (json) {
          const line = `${JSON.stringify(event)}\n`;
          if (event.event === "preflight_warning") streams.err(line);
          else streams.out(line);
          return;
        }
        const rendered = describePreflightEvent(event);
        if (rendered.stderr) streams.err(`${rendered.text}\n`);
        else streams.out(`${rendered.text}\n`);
      },
      refuse: (text) => streams.err(text),
    });
    // Exit 1, "the runtime decided": nothing failed to read or write, and a
    // supervisor that read this as an I/O fault would retry a checkout state
    // only a human can resolve.
    if (!cleared.ok) return EXIT_INTEGRITY;
    // The same handover `approval up` makes, for the same reason: a rebuild
    // means this process is the stale build, and the daemon is the writer. See
    // `cli/preflight.ts`'s `reexecFreshBuild`.
    if (cleared.reexec !== null) return reexecFreshBuild(cleared.reexec, cwd);
  }

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
    traceWatch: boolFlag(flags, "--trace-watch"),
    sink: {
      emit: (event) => {
        if (json) {
          const line = `${JSON.stringify(event)}\n`;
          if (event.event === "warning") streams.err(line);
          else streams.out(line);
          return;
        }
        const rendered = describeDaemonEvent(event);
        if (rendered.stderr) streams.err(`${rendered.text}\n`);
        else streams.out(`${rendered.text}\n`);
      },
    },
  };

  const cadence = advanceFlags(flags);
  if (!cadence.ok) return usageError(streams, json, cadence.message, DAEMON_RUN_HELP);
  if (cadence.cadence !== null) options.advance = cadence.cadence;

  // APRV-217. Resolved here, before the first tick, for the reason every other
  // configuration is: a daemon that accepted `--read-proof incrementel` and
  // quietly ran the default would be lying about its own proof for as long as
  // it ran, and the mode it resolves to is printed on its first line.
  const proof = readProofFlags(flags, policy);
  if (!proof.ok) return usageError(streams, json, proof.message, DAEMON_RUN_HELP);
  options.readProof = proof.readProof;
  // Process-wide as well as per-read: the loop's own reads carry the option,
  // and the queue renderer's reads — same process, same log, no options of
  // their own — pick it up from here. Set only in this long-lived operator
  // process, and never by a CLI verb an agent runs.
  useReadProof(proof.readProof);

  // The dark-session sweep (APRV-192). Its two durations are refused for a typo
  // in exactly the words every other duration flag is, for the reason
  // `advanceFlags` states: a daemon that accepted `--dark-window twelve` and
  // quietly swept the default would be lying about what it looked at.
  const darkWindow = durationFlag(flags, "--dark-window", DEFAULT_DARK_WINDOW_MS);
  if (!darkWindow.ok) return usageError(streams, json, darkWindow.message, DAEMON_RUN_HELP);
  const darkInterval = durationFlag(flags, "--dark-interval", DEFAULT_DARK_INTERVAL_MS);
  if (!darkInterval.ok) return usageError(streams, json, darkInterval.message, DAEMON_RUN_HELP);
  if (boolFlag(flags, "--dark-sessions")) {
    options.darkSessions = { windowMs: darkWindow.ms, intervalMs: darkInterval.ms };
  }

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

  // APRV-208. The live draw, served over an owner-only socket under the
  // approval home so a hook that holds no sampling secret can ask the process
  // that does. Attempted whenever the secret resolves in THIS process's
  // environment — the operator's own act, `eval "$(approval env)"` in the
  // terminal they start the daemon from — and skipped, with a line saying so,
  // when it does not. `--no-draw` is the way out; there is no way in other than
  // holding the secret, which is the point.
  if (!boolFlag(flags, "--no-draw")) {
    const draw = drawServerFor({ logPath, policy });
    if (draw.ok) options.draw = draw.server;
    // `no-live-class` is silent: the policy declares nothing live, so nothing is
    // gating that would not have gated anyway and there is no operator decision
    // to inform. Every other refusal names a class this policy declared live and
    // is now gating at 100%, which is a thing to be told once at startup rather
    // than to infer from a month of taps.
    else if (draw.reason !== "no-live-class") {
      streams.err(
        `approval: live draws will not be served (${draw.reason}): ${draw.message} Every supervised-live action gates to a human until the sampling secret resolves in this daemon's own environment.\n`,
      );
    }
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
      return exitForDaemonOutcome(outcome);
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
