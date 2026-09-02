/**
 * `approval up` — the ambient runtime: one process for the daemon and every
 * channel the policy configures (SPEC.md §10.2/§10.3, APRV-110).
 *
 * Until now a working gate was two foreground processes an operator had to
 * remember: `approval daemon run` to watch the files and expire what lapsed, and
 * `approval channel telegram listen` to put requests in front of a human and
 * collect the answer. Two terminals, two lifetimes, and a system that is half up
 * whenever one of them is not. This verb runs both, plus the local queue page,
 * under one supervisor, one set of signal handlers, and one event stream.
 *
 * **No logic lives here either.** The loop is still `daemon/daemon.ts`, the
 * dispatch cycle is still `cli/channel-telegram.ts`'s `dispatchPending`, and the
 * queue page is still `channel-web.ts`'s `startWebChannel` — which has said
 * "exported for the tests and for the M5 daemon" since APRV-25. What this file
 * adds is supervision: which parts to start, what to do when one falls over, and
 * how to stop them all at once.
 *
 * ## Per-part crash isolation
 *
 * A channel is a network client and the daemon is not. A Bot API that starts
 * refusing sends must not stop TTL expiry, write-back or the queue projection —
 * that inversion is exactly what the split into two processes bought, and it is
 * what this file has to buy back. So:
 *
 * - the DAEMON settles the verb. Its outcome chooses the exit code, exactly as
 *   `approval daemon run` maps it, and its failure stops everything;
 * - a CHANNEL that falls over is reported and restarted after a doubling
 *   backoff, forever. There is no attempt limit for the same reason
 *   `dispatchPending` has no send limit: giving up would turn an outage into a
 *   pending request no human ever sees;
 * - a channel that cannot start AT ALL — a credential the policy names is unset,
 *   no declared human identity — is not started, and the refusal is reported in
 *   `approval doctor`'s vocabulary (a `skip`, a detail, a fix). Fail closed, and
 *   then carry on with the parts that can run: a half-armed runtime that says
 *   nothing is the failure this project exists to prevent, and a runtime that
 *   refused to start the daemon because Telegram was unconfigured would be
 *   withholding the projection over a channel nobody asked for.
 *
 * ## The credentials come from the launch environment, and only from there
 *
 * SPEC.md §11.1 invariant 7: no verb loads `.approval/env` implicitly. This one
 * does not either. The bot token, the chat id and the approver identity are read
 * from `process.env` — the environment the operator launched this process with —
 * through exactly the same resolvers the separate listener uses. `approval setup
 * service` writes a unit that names those variables, or runs a wrapper that
 * evaluates `approval env`, and either way a human wrote the line that does it.
 *
 * ## The event stream is an additive union
 *
 * `--json` prints one object per line, and every object is one of three kinds:
 * a `DaemonEvent` verbatim, a listener line verbatim (`notified`, `decision`,
 * `annotated`, `listening`, `stopped`), or one of this file's own supervision
 * lines ({@link UpEvent}). Nothing is rewritten and no field is added to a shape
 * that already existed: the decision object is byte-identical to the one
 * `channel telegram listen` prints, because it is printed by the same function.
 * That is what makes the composed test suite an assertion about equivalence
 * rather than about a new format.
 *
 * The one shape that appears twice is `stopped`: the daemon's carries its tick
 * counters and a channel's carries its delivery counters, and a supervisor that
 * branches on `event` alone can tell them apart by their fields. Renaming either
 * would have broken a stream an operator already parses.
 *
 * ## What it does not do
 *
 * It does not fork, write a pidfile, or manage its own lifecycle, for the reason
 * `approval daemon run` gives: `launchd` and `systemd` do that better, and
 * `approval setup service` is the verb that hands them the unit.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { instanceFindings } from "../core/instance.js";
import { loadPolicy } from "../core/policy-load.js";
import { passphraseEnvFor } from "../core/vault.js";
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
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  prepareListen,
  startListener,
  type ListenSetup,
  type RunningListener,
} from "./channel-telegram.js";
import {
  payloadSource as webPayloadSource,
  policyWebPort,
  resolveWebPort,
  startWebChannel,
  type RunningWebChannel,
} from "./channel-web.js";
import {
  advanceFlags,
  describeDaemonEvent,
  describeGitEvidence,
  durationFlag,
  exitForDaemonOutcome,
  readProofFlags,
} from "./daemon.js";
import {
  DEFAULT_DARK_INTERVAL_MS,
  DEFAULT_DARK_WINDOW_MS,
} from "../daemon/dark-session.js";
import { useReadProof } from "../core/state.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { glossRunnerFor } from "./gloss.js";
import { UP_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { DEFAULT_QUEUE_PATH } from "./render.js";
import { skipNotice, style, type Style } from "./style.js";
import { usageErrorText } from "./usage.js";

// ---------------------------------------------------------------------------
// The supervision half of the stream
// ---------------------------------------------------------------------------

/** The parts one ambient runtime supervises. A closed set at v0.1. */
export type UpPart = "daemon" | "telegram" | "web";

/**
 * One supervision line. **Additive**: these `event` values are new, and no
 * existing `DaemonEvent` or listener line changes shape because they exist.
 *
 * `part_unavailable` deliberately carries `approval doctor`'s four fields —
 * `check`, `status`, `detail`, `fix` — rather than inventing a vocabulary for
 * the same fact. An operator who has read one report can read the other.
 */
export type UpEvent =
  | { event: "up_started"; parts: UpPart[]; log: string }
  | { event: "part_started"; part: UpPart; detail: string }
  | {
      event: "part_unavailable";
      part: UpPart;
      check: string;
      status: "skip";
      detail: string;
      fix: string | null;
    }
  | {
      event: "part_failed";
      part: UpPart;
      /** Consecutive failures for this part, counting this one. */
      attempt: number;
      message: string;
      /** How long the supervisor waits before starting it again. */
      restart_in_ms: number;
    }
  | { event: "part_restarted"; part: UpPart; attempt: number }
  | { event: "part_stopped"; part: UpPart; reason: string }
  | { event: "up_stopped"; reason: string };

/** The first backoff after a part falls over. Doubles to {@link UP_RESTART_MAX_MS}. */
export const UP_RESTART_BASE_MS = 1_000;

/** The ceiling the doubling stops at, so a long outage retries once a minute. */
export const UP_RESTART_MAX_MS = 60_000;

/**
 * How long a part must have been running before a failure is treated as a fresh
 * one rather than as the next step of a crash loop. A channel that ran for an
 * hour and then hit a network blip should retry in a second, not in a minute.
 */
export const UP_STABLE_MS = 60_000;

/**
 * One supervision line as a human sentence, and where it belongs.
 *
 * `st` is injectable for the render tests, exactly as doctor's renderer takes
 * one; the default asks the process, which is what the verb wants.
 */
export function describeUpEvent(
  event: UpEvent,
  st: Style = style(),
): { text: string; stderr: boolean } {
  switch (event.event) {
    case "up_started":
      return {
        text: `up: ${event.parts.join(", ")} in one process against ${event.log}; ctrl-c stops all of them`,
        stderr: false,
      };
    case "part_started":
      return { text: `up: ${event.part} started — ${event.detail}`, stderr: false };
    case "part_unavailable":
      // Doctor's skip, not a refusal: the part is absent by configuration, and
      // nothing failed (APRV-153). The JSON emit path is untouched.
      return {
        text: skipNotice(st, event.check, event.detail, event.fix ?? undefined),
        stderr: true,
      };
    case "part_failed":
      return {
        text: `approval: the ${event.part} channel stopped (attempt ${String(event.attempt)}): ${
          event.message
        } — restarting in ${String(event.restart_in_ms)}ms; the daemon loop is unaffected`,
        stderr: true,
      };
    case "part_restarted":
      return {
        text: `up: ${event.part} restarted (attempt ${String(
          event.attempt,
        )}); everything still pending is re-sent`,
        stderr: false,
      };
    case "part_stopped":
      return { text: `up: ${event.part} stopped (${event.reason})`, stderr: false };
    case "up_stopped":
      return { text: `up: stopped (${event.reason})`, stderr: false };
  }
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const UP_FLAGS: Record<string, FlagKind> = {
  // The daemon's own, spelled identically.
  "--log": "string",
  "--tasks": "string",
  "--out": "string",
  "--policy": "string",
  "--dir": "string",
  "--interval": "string",
  "--debounce": "string",
  "--once": "boolean",
  "--git-evidence": "boolean",
  // The cadence advance (APRV-204), spelled identically to `daemon run`'s.
  "--advance": "boolean",
  "--advance-interval": "string",
  "--advance-after": "string",
  "--advance-remote": "string",
  "--advance-base": "string",
  "--no-advance-pr": "boolean",
  // The dark-session sweep (APRV-192), spelled identically to `daemon run`'s.
  "--dark-sessions": "boolean",
  "--dark-window": "string",
  "--dark-interval": "string",
  // The prefix proof (APRV-217), spelled identically to `daemon run`'s.
  "--read-proof": "string",
  "--full-reproof-every": "string",
  "--full-reproof-after": "string",
  // The channels'.
  "--as": "string",
  "--payloads": "string",
  "--payload-dir": "string",
  "--api-base": "string",
  "--poll-timeout": "string",
  "--port": "string",
  "--no-telegram": "boolean",
  "--no-web": "boolean",
  "--gloss": "boolean",
  "--no-gloss": "boolean",
  // The supervisor's.
  "--restart-backoff": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, UP_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

// ---------------------------------------------------------------------------
// A cancellable wait
// ---------------------------------------------------------------------------

/**
 * A backoff that a shutdown can cut short.
 *
 * Without this, SIGTERM during a sixty-second restart wait would be a minute of
 * a process that has been asked to stop still being alive, which is exactly the
 * behaviour an operator reads as "it hung".
 */
class Wait {
  private timer: NodeJS.Timeout | null = null;
  private settle: (() => void) | null = null;

  for(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.settle = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.settle = null;
        resolve();
      }, ms);
    });
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const settle = this.settle;
    this.settle = null;
    if (settle !== null) settle();
  }
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * `approval up` (and `approval daemon run --with-channels`, which is the same
 * function reached from the other spelling).
 */
export function commandUp(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, UP_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${UP_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const flags = parsed.flags;
  const interval = durationFlag(flags, "--interval", DEFAULT_INTERVAL_MS);
  if (!interval.ok) return usageError(streams, json, interval.message);
  const debounce = durationFlag(flags, "--debounce", DEFAULT_DEBOUNCE_MS);
  if (!debounce.ok) return usageError(streams, json, debounce.message);
  const backoff = durationFlag(flags, "--restart-backoff", UP_RESTART_BASE_MS);
  if (!backoff.ok) return usageError(streams, json, backoff.message);

  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const queuePath = resolvePath(stringFlag(flags, "--out"), DEFAULT_QUEUE_PATH, cwd);
  const tasksFlag = stringFlag(flags, "--tasks");
  const tasksDir = resolvePath(tasksFlag, DEFAULT_TASKS_DIR, cwd);

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  // Same judgment `approval daemon run` makes: an explicitly named task folder
  // that does not exist is a typo, and the default folder's absence is a
  // legitimate log-only deployment that is warned about rather than refused.
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
  const load = loadPolicy(policy);

  const once = boolFlag(flags, "--once");

  const emit = (event: UpEvent): void => {
    if (json) {
      const line = `${JSON.stringify(event)}\n`;
      if (event.event === "part_unavailable" || event.event === "part_failed") streams.err(line);
      else streams.out(line);
      return;
    }
    const rendered = describeUpEvent(event);
    if (rendered.stderr) streams.err(`${rendered.text}\n`);
    else streams.out(`${rendered.text}\n`);
  };

  // -------------------------------------------------------------------------
  // Which parts can run
  // -------------------------------------------------------------------------

  const wantTelegram = !boolFlag(flags, "--no-telegram");
  const wantWeb = !boolFlag(flags, "--no-web");
  const portFlag = stringFlag(flags, "--port");
  const payloadsFlag = stringFlag(flags, "--payloads");
  const payloadDirFlag = stringFlag(flags, "--payload-dir");
  const asFlag = stringFlag(flags, "--as");

  /** Deferred so nothing is printed before the daemon's own `started` line. */
  const unavailable: UpEvent[] = [];
  const parts: UpPart[] = ["daemon"];

  let telegram: ListenSetup | null = null;
  if (wantTelegram) {
    const prepared = prepareListen({
      logPath,
      policy,
      as: asFlag,
      payloads: payloadsFlag === null ? null : absolute(payloadsFlag, cwd),
      apiBase: stringFlag(flags, "--api-base"),
      pollTimeout: stringFlag(flags, "--poll-timeout"),
      once,
      json,
      log: (message: string) => streams.err(`${message}\n`),
      // APRV-197: on by default, `--no-gloss` to turn it off, exactly as on
      // `channel telegram listen` — this IS that listener, and a flag that
      // meant different things on the two verbs that start it would be a trap.
      // The reasoning is at `glossWiring` there.
      //
      // APRV-207: the subprocess is spawned starved, and the policy already
      // loaded above names the passphrase variable the scrub must remove.
      ...(boolFlag(flags, "--no-gloss")
        ? {}
        : { gloss: glossRunnerFor(passphraseEnvFor(load)) }),
    });
    if (prepared.ok) {
      telegram = prepared.setup;
      parts.push("telegram");
      // APRV-178. The channel's credentials come from the launch environment
      // and only from there, which is invariant 7 and stays true — but an
      // exported value that this instance's own `.approval/env` disagrees with
      // is how a demo gate spent an evening sending through the production bot.
      // Said once, on stderr, before anything starts: a long-running process
      // that is quietly holding another instance's bot token should say so at
      // the moment it picks it up, not in a postmortem. It is a warning and not
      // a refusal, because an operator who feeds the primary daemon from a
      // shell profile is doing something deliberate and supported.
      for (const finding of instanceFindings(logPath, load)) {
        streams.err(`approval: cross-instance: ${finding.detail}\n`);
      }
    } else if (prepared.code === "poll-timeout" || prepared.code === "payloads-unreadable") {
      // A mistyped command line, not an unconfigured machine. Refused here, the
      // way every verb refuses one, rather than degraded into a missing channel
      // an operator would have to notice in a log.
      return prepared.code === "poll-timeout"
        ? usageError(streams, json, prepared.message)
        : ioError(streams, json, prepared.message);
    } else {
      unavailable.push({
        event: "part_unavailable",
        part: "telegram",
        check: "telegram",
        status: "skip",
        detail: prepared.message,
        fix:
          prepared.code === "no-identity"
            ? `approval setup identity — declare who the human is, then evaluate \`approval env\` in the environment this process is launched from (or export ${HUMAN_ACTOR_ENV} there yourself)`
            : "approval setup channel telegram — store the bot token and discover the approver chat, then evaluate `approval env` in the environment this process is launched from",
      });
    }
  }

  const webPort = resolveWebPort(portFlag, policyWebPort(load));
  if (!webPort.ok) return usageError(streams, json, webPort.message);
  const webActor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  const webDeclared = portFlag !== null || policyWebPort(load) !== null;

  let web: { port: number; actor: string } | null = null;
  if (wantWeb) {
    if (once) {
      // `--once` is one daemon tick and one poll cycle. A pull channel has no
      // cycle: its page is fetched when a human chooses to look, which is why
      // `approval channel web` has no `--once` either.
      unavailable.push({
        event: "part_unavailable",
        part: "web",
        check: "web-port",
        status: "skip",
        detail:
          "--once runs one daemon tick and one poll cycle, and the queue page is a pull channel with no cycle to run, so it is not served",
        fix: null,
      });
    } else if (!webDeclared) {
      unavailable.push({
        event: "part_unavailable",
        part: "web",
        check: "web-port",
        status: "skip",
        detail:
          "this policy declares no channels.web.port, so no queue page is served — which is a legitimate configuration and not a fault",
        fix: "pass --port <n> to serve it for this run, or add channels.web.port to APPROVAL.md via approval policy amend (an edited policy is inoperative until it is re-attested)",
      });
    } else if (webActor === null) {
      unavailable.push({
        event: "part_unavailable",
        part: "web",
        check: "web-port",
        status: "skip",
        detail: `no human identity: the queue page collects decisions and every one is recorded against ${HUMAN_ACTOR_ENV}, so a page whose buttons could record nothing is not served`,
        fix: `approval setup identity — declare who the human is, then evaluate \`approval env\` in the environment this process is launched from (or export ${HUMAN_ACTOR_ENV} there yourself)`,
      });
    } else {
      web = { port: webPort.port, actor: webActor };
      parts.push("web");
    }
  }

  // -------------------------------------------------------------------------
  // The daemon
  // -------------------------------------------------------------------------

  const options: DaemonOptions = {
    logPath,
    tasksDir,
    queuePath,
    policy,
    cwd,
    intervalMs: interval.ms,
    debounceMs: debounce.ms,
    once,
    sink: {
      emit: (event: DaemonEvent) => {
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

  // The cadence advance (APRV-204), parsed by `daemon run`'s own function so a
  // typo is refused in the same words on both spellings of this verb.
  const cadence = advanceFlags(flags);
  if (!cadence.ok) return usageError(streams, json, cadence.message);
  if (cadence.cadence !== null) options.advance = cadence.cadence;

  // The dark-session sweep (APRV-192), parsed by the same duration function for
  // the same reason: one typo, one sentence, on both spellings of this verb.
  const darkWindow = durationFlag(flags, "--dark-window", DEFAULT_DARK_WINDOW_MS);
  if (!darkWindow.ok) return usageError(streams, json, darkWindow.message);
  const darkInterval = durationFlag(flags, "--dark-interval", DEFAULT_DARK_INTERVAL_MS);
  if (!darkInterval.ok) return usageError(streams, json, darkInterval.message);
  if (boolFlag(flags, "--dark-sessions")) {
    options.darkSessions = { windowMs: darkWindow.ms, intervalMs: darkInterval.ms };
  }

  // The prefix proof (APRV-217), parsed by `daemon run`'s own function so the
  // flag beats the policy identically on both spellings of this verb.
  const proof = readProofFlags(flags, policy);
  if (!proof.ok) return usageError(streams, json, proof.message);
  options.readProof = proof.readProof;
  // Process-wide too, for the reason `daemon run` sets it: the channels and the
  // queue renderer in this process read the same log through paths that thread
  // no options of their own.
  useReadProof(proof.readProof);

  // SPEC.md §8's optional git hardening, judged before the first tick exactly as
  // `daemon run` judges it: an operator who asked for a second evidence layer and
  // silently did not get one is worse off than one who was refused at startup.
  if (boolFlag(flags, "--git-evidence")) {
    const enabled = enableGitEvidence(logPath, (event: GitEvidenceEvent) => {
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
      return enabled.code === "git-unavailable" || enabled.code === "log-dir-missing"
        ? EXIT_IO
        : EXIT_USAGE;
    }
    options.gitEvidence = enabled.recorder;
  }

  emit({ event: "up_started", parts, log: logPath });
  for (const event of unavailable) emit(event);

  const daemon = new Daemon(options);

  // -------------------------------------------------------------------------
  // Supervision
  // -------------------------------------------------------------------------

  let shuttingDown = false;
  let stopReason = "once";
  let listener: RunningListener | null = null;
  /** Set while a web server is up: resolving it lets that part close and return. */
  let stopWeb: (() => void) | null = null;
  const waits = new Set<Wait>();

  /** Wait, unless a shutdown has already begun or begins while waiting. */
  const pause = async (ms: number): Promise<void> => {
    const wait = new Wait();
    waits.add(wait);
    try {
      if (shuttingDown) return;
      await wait.for(ms);
    } finally {
      waits.delete(wait);
    }
  };

  const telegramPart = async (setup: ListenSetup): Promise<void> => {
    // `detail` is optional on the contract, and a health report that declines to
    // elaborate is not a fault. The fallback keeps `part_started` a fixed shape.
    emit({
      event: "part_started",
      part: "telegram",
      detail: setup.channel.health().detail ?? "configured",
    });
    let attempts = 0;
    for (;;) {
      const startedAt = Date.now();
      const running = startListener(setup, streams);
      listener = running;
      let message: string;
      try {
        const outcome = await running.done;
        if (outcome.kind === "stopped") {
          emit({
            event: "part_stopped",
            part: "telegram",
            reason: shuttingDown ? stopReason : setup.once ? "once" : "listener stopped",
          });
          return;
        }
        message =
          outcome.kind === "send-failed"
            ? `telegram sendMessage failed: ${outcome.message}`
            : `the pending queue could not be derived (${outcome.code}): ${outcome.message}`;
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      } finally {
        listener = null;
      }
      if (shuttingDown || setup.once) {
        emit({
          event: "part_stopped",
          part: "telegram",
          reason: shuttingDown ? stopReason : "once",
        });
        return;
      }

      // A part that ran for a while and then fell over is a fresh failure, not
      // the next rung of a crash loop.
      attempts = Date.now() - startedAt >= UP_STABLE_MS ? 1 : attempts + 1;
      const delay = Math.min(backoff.ms * 2 ** (attempts - 1), UP_RESTART_MAX_MS);
      emit({
        event: "part_failed",
        part: "telegram",
        attempt: attempts,
        message,
        restart_in_ms: delay,
      });
      await pause(delay);
      if (shuttingDown) {
        emit({ event: "part_stopped", part: "telegram", reason: stopReason });
        return;
      }
      emit({ event: "part_restarted", part: "telegram", attempt: attempts });
    }
  };

  const webPart = async (settings: { port: number; actor: string }): Promise<void> => {
    let attempts = 0;
    for (;;) {
      let running: RunningWebChannel;
      try {
        running = await startWebChannel({
          logPath,
          actor: settings.actor,
          policy,
          port: settings.port,
          ...(payloadDirFlag === null
            ? {}
            : {
                payload: webPayloadSource(absolute(payloadDirFlag, cwd), (message) =>
                  streams.err(`${message}\n`),
                ),
              }),
          log: (message: string) => streams.err(`${message}\n`),
        });
      } catch (cause) {
        if (shuttingDown) return;
        attempts += 1;
        const delay = Math.min(backoff.ms * 2 ** (attempts - 1), UP_RESTART_MAX_MS);
        emit({
          event: "part_failed",
          part: "web",
          attempt: attempts,
          message: `the web channel could not bind 127.0.0.1:${String(settings.port)}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          restart_in_ms: delay,
        });
        await pause(delay);
        if (shuttingDown) {
          emit({ event: "part_stopped", part: "web", reason: stopReason });
          return;
        }
        emit({ event: "part_restarted", part: "web", attempt: attempts });
        continue;
      }

      const url = `http://127.0.0.1:${String(running.port)}/`;
      emit({
        event: "part_started",
        part: "web",
        detail: `the pending queue is at ${url} (loopback only, NO authentication: anyone with access to this machine can decide as ${settings.actor})`,
      });
      // `channel web`'s own startup line, verbatim, so a supervisor already
      // parsing that stream reads the same object out of this one.
      if (json) {
        streams.out(
          `${JSON.stringify({
            event: "listening",
            channel: "web",
            url,
            host: "127.0.0.1",
            port: running.port,
            actor: settings.actor,
          })}\n`,
        );
      }

      // The server outlives this await only through a shutdown or its own
      // error: an HTTP server that is listening does not stop on its own.
      const failure = await new Promise<Error | null>((resolve) => {
        const onError = (cause: Error): void => resolve(cause);
        running.server.once("error", onError);
        const settle = (): void => {
          running.server.off("error", onError);
          resolve(null);
        };
        if (shuttingDown) settle();
        else stopWeb = settle;
      });
      stopWeb = null;
      if (failure === null || shuttingDown) {
        if (json) streams.out(`${JSON.stringify({ event: "stopped", ...running.channel.stats() })}\n`);
        emit({ event: "part_stopped", part: "web", reason: shuttingDown ? stopReason : "closed" });
        await running.close().catch(() => undefined);
        return;
      }

      await running.close().catch(() => undefined);
      attempts += 1;
      const delay = Math.min(backoff.ms * 2 ** (attempts - 1), UP_RESTART_MAX_MS);
      emit({
        event: "part_failed",
        part: "web",
        attempt: attempts,
        message: failure.message,
        restart_in_ms: delay,
      });
      await pause(delay);
      if (shuttingDown) {
        emit({ event: "part_stopped", part: "web", reason: stopReason });
        return;
      }
      emit({ event: "part_restarted", part: "web", attempt: attempts });
    }
  };

  const stopAll = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopReason = reason;
    daemon.stop(reason);
    listener?.stop();
    stopWeb?.();
    for (const wait of waits) wait.cancel();
  };

  const onSignal = (signal: NodeJS.Signals): void => stopAll(signal);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const channelParts: Promise<void>[] = [];
  if (telegram !== null) channelParts.push(telegramPart(telegram));
  if (web !== null) channelParts.push(webPart(web));

  return daemon
    .run()
    .then(async (outcome: DaemonOutcome) => {
      // `--once` is one tick AND one poll cycle: the daemon's tick finishes in
      // milliseconds and the channel's poll takes as long as the long poll does,
      // so the fast part waits for the slow one rather than cutting it short.
      if (once && outcome.kind === "stopped") await Promise.all(channelParts);

      // The daemon settles the verb. A failure of ITS OWN — an unreadable log, a
      // torn tail, a chain that does not verify — stops the channels too: a
      // queue page and a chat prompt derived from a log nobody could verify
      // would be a statement to a human about facts the runtime disowns.
      stopAll(outcome.kind === "stopped" ? outcome.reason : outcome.kind);
      await Promise.all(channelParts);
      emit({ event: "up_stopped", reason: stopReason });

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
    })
    .finally(() => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    });
}
