/**
 * `approval study withdraw` (APRV-527, amended SPEC.md §8, the study record): a hosted
 * study operator denies ONE still-pending request before it can run.
 *
 * As everywhere in this CLI, no logic lives here: the switch, the replay, the
 * pending check and the deny are `core/study-withdraw.ts`, and the deny itself
 * is the gate's `decide`. This file parses argv, refuses a malformed operator
 * id or ref as a usage error, and prints one JSON line.
 *
 * What it deliberately has NO flag for: an actor (`human:study-team` is a
 * constant), a decision (it is `reject`, a constant), a note, a reason. An
 * operator can only say which request, who they are (as an 8-hex digest of
 * their staff email, never the email) and the ref that makes a retry safe.
 *
 * Its output never names the action key: an action key can carry text an
 * agent wrote, and the control plane that calls this answers its own operator
 * with ids only. The success line is `{"ok":true,"idempotent":<b>,"seq":<n>}`;
 * a refusal is the CLI's standard `{"ok":false,"error":{code,message,...}}` on
 * stderr, with `state`, `gate_code` or `matches` when they apply.
 */

import {
  STUDY_ACTION_REF_PATTERN,
  STUDY_OPERATOR_PATTERN,
  STUDY_REF_PATTERN,
  STUDY_MODE_ENV,
  studyModeOn,
  studyWithdraw,
  type StudyWithdrawRefusal,
  type StudyWithdrawTarget,
} from "../core/study-withdraw.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_TORN_TAIL, EXIT_USAGE } from "./exit-codes.js";
import { STUDY_HELP, STUDY_WITHDRAW_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const WITHDRAW_FLAGS: Record<string, FlagKind> = {
  "--action-ref": "string",
  "--operator": "string",
  "--ref": "string",
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, helpText));
  return EXIT_USAGE;
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function exitCodeOf(refused: StudyWithdrawRefusal): number {
  switch (refused.code) {
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    default:
      return EXIT_INTEGRITY;
  }
}

function emitRefusal(streams: Streams, json: boolean, refused: StudyWithdrawRefusal): number {
  if (json) {
    const error: Record<string, unknown> = { code: refused.code, message: refused.message };
    if (refused.state !== undefined) error["state"] = refused.state;
    if (refused.gateCode !== undefined) error["gate_code"] = refused.gateCode;
    if (refused.matches !== undefined) error["matches"] = refused.matches;
    streams.err(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    streams.err(`${renderRefusal(style({ json }), refused.code, refused.message)}\n`);
  }
  return exitCodeOf(refused);
}

export function commandStudy(
  argv: string[],
  streams: Streams,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const sub = argv[0];
  const json = argv.includes("--json");
  if (sub === undefined || sub === "--help" || sub === "-h") {
    if (sub === undefined) return usageError(streams, json, "missing subcommand", STUDY_HELP);
    streams.out(`${STUDY_HELP}\n`);
    return EXIT_OK;
  }
  if (sub !== "withdraw") {
    return usageError(
      streams,
      json,
      `unknown subcommand ${JSON.stringify(sub)} for \`approval study\``,
      STUDY_HELP,
    );
  }
  return commandStudyWithdraw(argv.slice(1), streams, cwd, env);
}

function commandStudyWithdraw(
  argv: string[],
  streams: Streams,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, WITHDRAW_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, STUDY_WITHDRAW_HELP);
  const { flags, positionals } = parsed;
  // `--help` answers whatever the switch says: it is how a control plane
  // probes whether the installed CLI has this verb at all.
  if (boolFlag(flags, "--help") || boolFlag(flags, "-h")) {
    streams.out(`${STUDY_WITHDRAW_HELP}\n`);
    return EXIT_OK;
  }

  // 1. The switch, before any argument is judged and before the log is opened.
  if (!studyModeOn(env)) {
    return emitRefusal(streams, json, {
      ok: false,
      code: "study-mode-off",
      message: `study mode is off: this process was not launched with ${STUDY_MODE_ENV}=1, so no study withdrawal can be recorded. Nothing was appended.`,
    });
  }

  // 2. The arguments. Malformed is a usage error (exit 2), never a refusal.
  const key = positionals[0];
  if (positionals[1] !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(positionals[1])}`,
      STUDY_WITHDRAW_HELP,
    );
  }
  const actionRef = stringFlag(flags, "--action-ref");
  if ((key === undefined) === (actionRef === null)) {
    return usageError(
      streams,
      json,
      "name the request by exactly one of <action-key> or --action-ref <12 hex>",
      STUDY_WITHDRAW_HELP,
    );
  }
  if (actionRef !== null && !STUDY_ACTION_REF_PATTERN.test(actionRef)) {
    return usageError(
      streams,
      json,
      "--action-ref expects the first 12 lowercase hex of sha256(action key)",
      STUDY_WITHDRAW_HELP,
    );
  }
  if (key !== undefined && key.length === 0) {
    return usageError(streams, json, "the <action-key> is empty", STUDY_WITHDRAW_HELP);
  }
  const operator = stringFlag(flags, "--operator");
  if (operator === null || !STUDY_OPERATOR_PATTERN.test(operator)) {
    return usageError(
      streams,
      json,
      "--operator expects 8 lowercase hex: the first 8 of sha256(the lower-cased staff email), never the email",
      STUDY_WITHDRAW_HELP,
    );
  }
  const ref = stringFlag(flags, "--ref");
  if (ref === null || !STUDY_REF_PATTERN.test(ref)) {
    return usageError(
      streams,
      json,
      "--ref expects 16 to 64 characters of [A-Za-z0-9_-]",
      STUDY_WITHDRAW_HELP,
    );
  }

  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const target: StudyWithdrawTarget =
    key !== undefined ? { actionKey: key } : { actionRef: actionRef as string };

  const result = studyWithdraw(logPath, { target, operator, ref }, { policy, env });
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    streams.out(`${JSON.stringify({ ok: true, idempotent: result.idempotent, seq: result.seq })}\n`);
  } else {
    streams.out(
      result.idempotent
        ? `already withdrawn by the study team at seq ${String(result.seq)}; nothing appended\n`
        : `withdrawn by the study team at seq ${String(result.seq)}\n`,
    );
  }
  return EXIT_OK;
}
