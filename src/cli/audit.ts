/**
 * `approval audit` — the retrospective-review verbs (SPEC.md §5.2, §9.1).
 *
 * Two subcommands, and neither of them samples:
 *
 * - `audit list` reads the open sampled-audit backlog and writes nothing;
 * - `audit review <seq|action-key>` appends `audit.reviewed` and is HUMAN-ONLY.
 *
 * There is deliberately no `approval audit sample`. Sampling is the runtime's
 * decision, made by the daemon from an operator-held secret, and a verb that let
 * a caller sample (or decline to sample) an action of its choosing would hand
 * the party under oversight the control that exists to oversee it. The daemon
 * samples on its tick; that is the only path.
 *
 * The CLI holds no logic, as everywhere else here: eligibility, matching, and
 * the human-only rule live in `core/audit.ts`, and this file is argument
 * parsing, output formatting, and the mapping from a core result to an exit code.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import {
  openSamples,
  parseSubjectRef,
  reviewSample,
  sampledSubjects,
  type AuditRefusal,
} from "../core/audit.js";
import { resolveHumanActor, HUMAN_ACTOR_ENV } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import { resolveSampler } from "../core/sampler.js";
import { readVerifiedRecords } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { AUDIT_HELP, AUDIT_LIST_HELP, AUDIT_REVIEW_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

const COMMON_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, helpText));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/**
 * Map an audit refusal onto the frozen exit table, by the same split every
 * other verb draws: filesystem facts are 4, a crashed write is 3, and every
 * decision the runtime itself made is 1.
 */
function refusalExitCode(refusal: AuditRefusal): number {
  switch (refusal.code) {
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    case "append-failed":
      switch (refusal.append?.code) {
        case "corrupt-tail":
          return EXIT_TORN_TAIL;
        case "io":
        case "lock-timeout":
          return EXIT_IO;
        default:
          return EXIT_INTEGRITY;
      }
    default:
      return EXIT_INTEGRITY;
  }
}

function emitRefusal(streams: Streams, json: boolean, refusal: AuditRefusal): number {
  if (json) {
    const error: Record<string, unknown> = { code: refusal.code, message: refusal.message };
    if (refusal.seq !== undefined) error["seq"] = refusal.seq;
    streams.err(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    streams.err(`approval: ${refusal.code}: ${refusal.message}\n`);
  }
  return refusalExitCode(refusal);
}

interface Front {
  flags: Record<string, string | boolean>;
  positionals: string[];
  json: boolean;
  logPath: string;
}

type FrontOutcome = { kind: "handled"; code: number } | ({ kind: "run" } & Front);

function front(
  argv: string[],
  spec: Record<string, FlagKind>,
  helpText: string,
  streams: Streams,
  cwd: string,
): FrontOutcome {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) {
    return { kind: "handled", code: usageError(streams, json, parsed.message, helpText) };
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${helpText}\n`);
    return { kind: "handled", code: EXIT_OK };
  }
  return {
    kind: "run",
    flags: parsed.flags,
    positionals: parsed.positionals,
    json,
    logPath: resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd),
  };
}

// ===========================================================================
// approval audit list
// ===========================================================================

/**
 * The open sampled-audit backlog: `audit.sampled` events with no later
 * `audit.reviewed`, oldest first.
 *
 * The same set `.approval/QUEUE.md` renders and the same set the daemon counts,
 * from the same projection, so the file, the daemon's `audit_backlog`, and this
 * verb cannot disagree. Reads a verified log and writes nothing anywhere.
 */
export function commandAuditList(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, "--all": "boolean", "--policy": "string", "--dir": "string" },
    AUDIT_LIST_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const extra = positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, AUDIT_LIST_HELP);
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    return emitRefusal(streams, json, { ok: false, code: read.code, message: read.message });
  }

  const all = boolFlag(flags, "--all");
  const samples = all ? sampledSubjects(read.records) : openSamples(read.records);
  const rows = samples.map((subject) => ({
    seq: subject.seq,
    ts: subject.ts,
    action_key: subject.actionKey,
    task: subject.task,
    subject_seq: subject.subjectSeq,
    reviewed_seq: subject.reviewedSeq,
  }));

  // The sampler's state is reported beside the backlog it explains: an empty
  // backlog means one thing when sampling is running and quite another when no
  // secret is configured, and an operator reading "empty" deserves to know
  // which. See core/sampler.ts on why a missing secret disables sampling.
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const sampler = resolveSampler(
    loadPolicy(
      policyFlag !== null
        ? { file: absolute(policyFlag, cwd) }
        : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
    ),
  );
  const sampling = sampler.enabled
    ? { enabled: true, rate: sampler.rate, secret_env: sampler.secretEnv, reason: null }
    : {
        enabled: false,
        rate: sampler.rate,
        secret_env: sampler.secretEnv,
        reason: sampler.reason,
      };

  if (json) {
    emitJson(streams, {
      ok: true,
      sampling,
      open: rows.filter((row) => row.reviewed_seq === null).length,
      samples: rows,
    });
  } else {
    streams.out(
      sampler.enabled
        ? `sampling: on, rate ${String(sampler.rate)}, secret from ${sampler.secretEnv}\n`
        : `sampling: OFF (${sampler.reason}) — ${sampler.message}\n`,
    );
    if (rows.length === 0) {
      streams.out(
        all
          ? "no audit.sampled records in this log\n"
          : "sampled-audit backlog: empty (no audit.sampled event is waiting for a review)\n",
      );
    }
    for (const row of rows) {
      streams.out(
        `${String(row.seq)}\t${row.ts}\t${row.action_key ?? "-"}\t${
          row.reviewed_seq === null ? "open" : `reviewed at seq ${String(row.reviewed_seq)}`
        }\n`,
      );
    }
  }
  return EXIT_OK;
}

// ===========================================================================
// approval audit review
// ===========================================================================

/**
 * `approval audit review <seq|action-key> [--note "<text>"]`
 *
 * HUMAN-ONLY, enforced in `core/audit.ts` and checked here first so a malformed
 * invocation never reaches the log. `--note` is optional: the event's content is
 * that a person looked, and a note is the reviewer's own record of what they
 * concluded.
 *
 * No attestation is required, for the reason `execution resolve` states: review
 * records an observation, exercises no policy authority, authorizes nothing, and
 * spends no budget. A review blocked because a policy file was edited afterwards
 * would be a supervision backlog held open by an unrelated fact.
 */
export function commandAuditReview(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, "--note": "string", "--as": "string", "--policy": "string", "--dir": "string" },
    AUDIT_REVIEW_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const subject = positionals[0];
  if (subject === undefined) {
    return usageError(streams, json, "missing <seq|action-key> argument", AUDIT_REVIEW_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, AUDIT_REVIEW_HELP);
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; a review records that a PERSON looked, and an agent: or system: actor cannot perform it`,
      AUDIT_REVIEW_HELP,
    );
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const result = reviewSample(
    logPath,
    parseSubjectRef(subject),
    actor,
    stringFlag(flags, "--note"),
    {
      policy:
        policyFlag !== null
          ? { file: absolute(policyFlag, cwd) }
          : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
    },
  );
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      seq: result.record.seq,
      sample_seq: result.subject.seq,
      action_key: result.subject.actionKey,
      task: result.subject.task,
      actor,
    });
  } else {
    streams.out(
      `reviewed sample at seq ${String(result.subject.seq)} (action ${
        result.subject.actionKey ?? "-"
      }) at seq ${String(result.record.seq)} by ${actor}\n`,
    );
  }
  return EXIT_OK;
}

/** `approval audit <subcommand>` — `list` and `review`. */
export function commandAudit(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval audit`", AUDIT_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${AUDIT_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "list") return commandAuditList(rest, streams, cwd);
  if (sub === "review") return commandAuditReview(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval audit\``,
    AUDIT_HELP,
  );
}
