/**
 * The CLI edge of `approval log unlock` (APRV-479).
 *
 * A writer takes `events.jsonl.lock` back by itself only from a holder it can
 * prove gone: a dead pid in its own pid namespace and boot. Every other lock a
 * dead writer leaves (one written in another container, under another boot, by
 * a pid this process cannot check) stays, and the writer's `lock-timeout`
 * refusal names this verb with the pid. A person who knows that holder is gone
 * runs it; `core/log.ts`'s `unlockAppendLock` takes the lock with the same
 * claim and take a writer's reclaim uses and records `audit.lock_reclaimed`
 * under the person's `human:` actor, first under the lock it took.
 *
 * Human-only in three places: the actor is resolved here (`--as` or
 * `APPROVAL_HUMAN`), the schema refuses an `agent:` actor on the record, and
 * `core/command-class.ts` classifies the invocation `policy.core`, which the
 * reference policy holds human-only, so the harness hook denies an agent that
 * tries it.
 */

import { isAbsolute, resolve } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { unlockAppendLock } from "../core/log.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { LOG_UNLOCK_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { refusal as renderRefusal, style } from "./style.js";
import { usageErrorText } from "./usage.js";

const UNLOCK_FLAGS: Record<string, FlagKind> = {
  "--pid": "string",
  "--log": "string",
  "--as": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const DEFAULT_LOG_PATH = ".approval/log/events.jsonl";

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, LOG_UNLOCK_HELP));
  return EXIT_USAGE;
}

function report(streams: Streams, json: boolean, code: string, message: string): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  else streams.err(`${renderRefusal(style({ json }), code, message)}\n`);
  return EXIT_IO;
}

export function commandLogUnlock(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, UNLOCK_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${LOG_UNLOCK_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);

  const pidFlag = stringFlag(parsed.flags, "--pid");
  if (pidFlag === null) {
    return usageError(streams, json, "--pid is required: the pid the lockfile names (the lock-timeout refusal prints it), or `none` for a lockfile that names no holder");
  }
  let pid: number | null;
  if (pidFlag === "none") pid = null;
  else if (/^[1-9]\d{0,9}$/u.test(pidFlag) && Number(pidFlag) <= 2 ** 31 - 1) pid = Number(pidFlag);
  else return usageError(streams, json, `--pid expects a pid or \`none\`, got ${JSON.stringify(pidFlag)}`);

  const asFlag = stringFlag(parsed.flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; \`approval log unlock\` is human-only`,
    );
  }

  const logFlag = stringFlag(parsed.flags, "--log");
  const relative = logFlag ?? DEFAULT_LOG_PATH;
  const logPath = isAbsolute(relative) ? relative : resolve(cwd, relative);

  const result = unlockAppendLock(logPath, pid, actor);
  switch (result.kind) {
    case "none":
      if (json) streams.out(`${JSON.stringify({ ok: true, unlocked: false })}\n`);
      else streams.out(`no lock: ${logPath}.lock does not exist; nothing to do\n`);
      return EXIT_OK;
    case "refused":
      return report(streams, json, "unlock-refused", result.message);
    case "failed":
      return report(streams, json, result.error.code, result.error.message);
    case "unlocked":
      if (json) {
        streams.out(
          `${JSON.stringify({ ok: true, unlocked: true, seq: result.record.seq, holder: result.note.holder ?? null, age_ms: result.note.age_ms, actor: result.record.actor })}\n`,
        );
      } else {
        const holder = result.note.holder === undefined ? "a lockfile that named no holder" : `pid ${String(result.note.holder.pid)} (${result.note.holder.op}, since ${result.note.holder.created})`;
        streams.out(`unlocked: took over ${result.note.lockfile} from ${holder}; recorded as audit.lock_reclaimed seq ${String(result.record.seq)} by ${result.record.actor}\n`);
      }
      return EXIT_OK;
  }
}
