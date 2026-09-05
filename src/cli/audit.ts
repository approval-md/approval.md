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
  openObligations,
  openSamples,
  parseSubjectRef,
  reconciliationObligations,
  isReaction,
  REACTIONS,
  reviewSample,
  sampledSubjects,
  satisfyObligation,
  type AuditRefusal,
} from "../core/audit.js";
import { resolveHumanActor, HUMAN_ACTOR_ENV } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import { classSampling, resolveSampler } from "../core/sampler.js";
import { readVerifiedRecords } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import {
  AUDIT_HELP,
  AUDIT_LIST_HELP,
  AUDIT_OBLIGATIONS_HELP,
  AUDIT_RECONCILE_HELP,
  AUDIT_REVIEW_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { refusal as renderRefusal, style } from "./style.js";
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
    // APRV-102: the one refusal shape, and no `fix:` — an audit refusal names a
    // state of the log or of the backlog, not a command that repairs it.
    streams.err(`${renderRefusal(style({ json }), refusal.code, refusal.message)}\n`);
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
  const samplingLoad = loadPolicy(
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
  );
  const sampler = resolveSampler(samplingLoad);
  // APRV-183. `rate` is the GLOBAL fallback and `classes` is the coverage: with
  // a per-class `retro_rate` in the grammar, one number can no longer describe
  // what is sampled, and a backlog explained by one number would be explained
  // wrongly. Additive to the existing object, so every reader of `enabled`,
  // `rate`, `secret_env` and `reason` keeps reading what it read.
  const classes = classSampling(samplingLoad, sampler).map((entry) => ({
    pattern: entry.pattern,
    autonomy: entry.autonomy,
    rate: entry.rate,
    source: entry.source,
    enabled: entry.enabled,
    reason: entry.reason,
  }));
  const sampling = sampler.enabled
    ? {
        enabled: true,
        rate: sampler.rate,
        secret_env: sampler.secretEnv,
        reason: null,
        classes,
      }
    : {
        enabled: false,
        rate: sampler.rate,
        secret_env: sampler.secretEnv,
        reason: sampler.reason,
        classes,
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
    for (const entry of classes) {
      streams.out(
        entry.enabled
          ? `  ${entry.pattern}: rate ${String(entry.rate)} (${entry.source})\n`
          : `  ${entry.pattern}: not sampled (${entry.reason ?? "rate-absent"})\n`,
      );
    }
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
    {
      ...COMMON_FLAGS,
      "--note": "string",
      "--deny": "boolean",
      "--reaction": "string",
      "--as": "string",
      "--policy": "string",
      "--dir": "string",
    },
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

  // Closed vocabulary, refused at exit 2 rather than defaulted or passed
  // through, exactly as `withdraw --reason` is. A misspelling that silently
  // became `indifferent` would put a word in the reviewer's mouth in an
  // append-only log; one that reached the core would be answered as a refusal
  // when what happened is that a person typed "love" for "loved".
  const reactionFlag = stringFlag(flags, "--reaction");
  if (reactionFlag !== null && !isReaction(reactionFlag)) {
    return usageError(
      streams,
      json,
      `--reaction expects one of ${REACTIONS.join(" | ")}, got ${JSON.stringify(reactionFlag)}`,
      AUDIT_REVIEW_HELP,
    );
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const deny = boolFlag(flags, "--deny");
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
      // Explicit rather than defaulted through: the ABSENCE of --deny is "ok",
      // and it must be this file that says so, once, where a reader can see it.
      verdict: deny ? "denied" : "ok",
      // Absent means absent (APRV-239). No default is substituted here or
      // downstream: `indifferent` is a thing a person had to actually say.
      ...(reactionFlag === null ? {} : { reaction: reactionFlag }),
    },
  );
  if (!result.ok) return emitRefusal(streams, json, result);

  const obligation = result.obligation;
  if (json) {
    emitJson(streams, {
      ok: true,
      seq: result.record.seq,
      sample_seq: result.subject.seq,
      action_key: result.subject.actionKey,
      task: result.subject.task,
      verdict: deny ? "denied" : "ok",
      // Always present, `null` when the reviewer gave none: a consumer reading
      // this shape must be able to tell "no reaction" from "the key is missing
      // because this build predates the field".
      reaction: reactionFlag,
      obligation_seq: obligation === null ? null : obligation.seq,
      actor,
    });
  } else {
    streams.out(
      `reviewed sample at seq ${String(result.subject.seq)} (action ${
        result.subject.actionKey ?? "-"
      }) at seq ${String(result.record.seq)} by ${actor}${deny ? " — DENIED" : ""}${
        reactionFlag === null ? "" : ` — reaction: ${reactionFlag} (guidance, not policy)`
      }\n`,
    );
    if (obligation !== null) {
      const shape = String((obligation.payload as Record<string, unknown> | undefined)?.["obligation"] ?? "");
      streams.out(
        shape === "gated-revert"
          ? `reconciliation obligation at seq ${String(obligation.seq)}: GATED REVERT. The action was declared reversible, so undo it through the gate and close this with \`approval audit reconcile ${String(obligation.seq)} --revert <action-key> --note "…"\`.\n`
          : `reconciliation obligation at seq ${String(obligation.seq)}: POLICY FINDING. Nothing can be reverted, so what is owed is a review of the class that permitted this. Close it with \`approval audit reconcile ${String(obligation.seq)} --note "…"\` once that review has happened.\n`,
      );
    }
  }
  return EXIT_OK;
}

// ===========================================================================
// approval audit obligations
// ===========================================================================

/**
 * The open reconciliation backlog: `reconciliation.required` records with no
 * later `reconciliation.satisfied`.
 *
 * Reads a verified log and writes nothing. The same projection `status` and
 * `doctor` read, so the three can never disagree about what is outstanding.
 */
export function commandAuditObligations(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(argv, { ...COMMON_FLAGS, "--all": "boolean" }, AUDIT_OBLIGATIONS_HELP, streams, cwd);
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const extra = positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      AUDIT_OBLIGATIONS_HELP,
    );
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    return emitRefusal(streams, json, { ok: false, code: read.code, message: read.message });
  }

  const all = boolFlag(flags, "--all");
  const items = all ? reconciliationObligations(read.records) : openObligations(read.records);
  const rows = items.map((item) => ({
    seq: item.seq,
    ts: item.ts,
    action_key: item.actionKey,
    task: item.task,
    class: item.class,
    review_seq: item.reviewSeq,
    obligation: item.obligation,
    reversible: item.reversible,
    satisfied_seq: item.satisfiedSeq,
  }));

  if (json) {
    emitJson(streams, {
      ok: true,
      open: rows.filter((row) => row.satisfied_seq === null).length,
      obligations: rows,
    });
    return EXIT_OK;
  }

  if (rows.length === 0) {
    streams.out(
      all
        ? "no reconciliation.required records in this log\n"
        : "reconciliation backlog: empty (no retrospective denial is waiting to be reconciled)\n",
    );
    return EXIT_OK;
  }
  for (const row of rows) {
    streams.out(
      `${String(row.seq)}\t${row.ts}\t${row.action_key}\t${row.class}\t${row.obligation}\t${
        row.satisfied_seq === null ? "OPEN" : `satisfied at seq ${String(row.satisfied_seq)}`
      }\n`,
    );
  }
  return EXIT_OK;
}

// ===========================================================================
// approval audit reconcile
// ===========================================================================

/**
 * `approval audit reconcile <obligation-seq> --note "<text>" [--revert <key>]`
 *
 * HUMAN-ONLY, enforced in `core/audit.ts` and again by the event schema, and
 * checked here first so a malformed invocation never reaches the log.
 */
export function commandAuditReconcile(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, "--note": "string", "--revert": "string", "--as": "string" },
    AUDIT_RECONCILE_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const subject = positionals[0];
  if (subject === undefined) {
    return usageError(streams, json, "missing <obligation-seq> argument", AUDIT_RECONCILE_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      AUDIT_RECONCILE_HELP,
    );
  }
  if (!/^[1-9][0-9]*$/u.test(subject)) {
    return usageError(
      streams,
      json,
      `<obligation-seq> is the SEQ of the reconciliation.required record, a positive integer, got ${JSON.stringify(subject)}; run \`approval audit obligations\` for the open ones`,
      AUDIT_RECONCILE_HELP,
    );
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; satisfying an obligation records that a PERSON discharged it, and an agent: or system: actor cannot perform it`,
      AUDIT_RECONCILE_HELP,
    );
  }

  const note = stringFlag(flags, "--note");
  if (note === null || note.trim().length === 0) {
    return usageError(
      streams,
      json,
      `--note is required: this record asserts that an obligation was discharged, and a discharge nobody described is one no auditor can check`,
      AUDIT_RECONCILE_HELP,
    );
  }

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const revert = stringFlag(flags, "--revert");
  const result = satisfyObligation(logPath, Number(subject), actor, {
    note,
    ...(revert === null ? {} : { revertActionKey: revert }),
  });
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      seq: result.record.seq,
      obligation_seq: result.obligation.seq,
      action_key: result.obligation.actionKey,
      task: result.obligation.task,
      class: result.obligation.class,
      obligation: result.obligation.obligation,
      actor,
    });
  } else {
    streams.out(
      `reconciled the obligation at seq ${String(result.obligation.seq)} (${
        result.obligation.obligation
      } for ${result.obligation.actionKey}) at seq ${String(result.record.seq)} by ${actor}\n`,
    );
  }
  return EXIT_OK;
}

/** `approval audit <subcommand>` — `list`, `review`, `obligations`, `reconcile`. */
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
  if (sub === "obligations") return commandAuditObligations(rest, streams, cwd);
  if (sub === "reconcile") return commandAuditReconcile(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval audit\``,
    AUDIT_HELP,
  );
}
