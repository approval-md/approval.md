/**
 * The gate verbs of SPEC.md §10.1: `approval register`, `approval request`,
 * `approval grant|reject|revoke`, and `approval expire`.
 *
 * As everywhere else in this CLI, **no logic lives here.** State derivation,
 * transition legality, TTL arithmetic, attestation, and budgets are all
 * `core/gate.ts`; frontmatter reading is `core/frontmatter.ts`; the append is
 * `core/log.ts`. This file resolves paths and identity, chooses an exit code,
 * and formats output.
 *
 * Four choices are load-bearing enough to state plainly.
 *
 * **A gate refusal is exit 1, not exit 2.** "You may not do that" is not a
 * usage error — the command was well-formed, the runtime understood it, and the
 * answer is no. Grouping refusals with typos would train agents to retry with
 * different flags when the correct response is to ask a human. Exit 2 stays what
 * it has always been: an unknown flag, a missing argument, an unresolvable
 * identity. The frozen `error.code` inside `--json` is what a caller branches on
 * to tell *which* refusal it was.
 *
 * **The log supplies the action's declaration, not flags.** `approval request
 * <task> --action <key>` reads the action's class, cost, reversibility and
 * summary from the `task.registered` record in the log — the same record
 * `approval register` wrote from the envelope. There are no `--class` /
 * `--cost` flags, deliberately: an agent that could name its own class at
 * request time could declare `read.web` for an action registered as
 * `financial.spend`, and SPEC.md §7's "class MUST be declared before a token can
 * be requested" would mean nothing. Register once from the file; request against
 * what was registered. A task file edited after registration is `envelope.drift`
 * (M5), not a silent re-declaration.
 *
 * **`register` reads task files but never writes them.** Unknown frontmatter
 * keys are preserved trivially here because nothing is rewritten at all;
 * round-trip rewriting is M6.
 *
 * **grant / reject / revoke are human-only**, via `resolveHumanActor` — `--as
 * human:<id>` or `APPROVAL_HUMAN`, refused at exit 2 when absent or when it
 * names an agent. `expire` takes no identity at all: it is the system verb, and
 * `core/gate.ts` stamps `system:gate`.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import {
  decide,
  expire,
  register,
  registeredAction,
  request,
  readGateRecords,
  type Decision,
  type GateOptions,
  type GateRefusal,
} from "../core/gate.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import {
  EXPIRE_HELP,
  GRANT_HELP,
  REGISTER_HELP,
  REJECT_HELP,
  REQUEST_HELP,
  REVOKE_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";

/** Identity accepted by the proposing verbs: a person or an agent. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

const COMMON_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const POLICY_FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
};

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

/**
 * Map a core refusal onto the frozen exit table.
 *
 * Everything the gate itself decided is {@link EXIT_INTEGRITY}. Only facts about
 * the filesystem are {@link EXIT_IO}, and only a crashed write is
 * {@link EXIT_TORN_TAIL} — the same split the log commands already draw.
 */
function refusalExitCode(refusal: GateRefusal): number {
  switch (refusal.code) {
    case "log-unreadable":
    case "task-file-unreadable":
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

/** Emit a refusal in the frozen shape and return its exit code. */
function emitRefusal(streams: Streams, json: boolean, refusal: GateRefusal): number {
  if (json) {
    const error: Record<string, unknown> = { code: refusal.code, message: refusal.message };
    if (refusal.detail !== undefined) error["detail"] = refusal.detail;
    if (refusal.state !== undefined) error["state"] = refusal.state;
    if (refusal.verdicts !== undefined) error["verdicts"] = refusal.verdicts;
    if (refusal.errors !== undefined) error["errors"] = refusal.errors;
    if (refusal.record !== undefined) error["seq"] = refusal.record.seq;
    streams.err(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    streams.err(`approval: ${refusal.code}: ${refusal.message}\n`);
  }
  return refusalExitCode(refusal);
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/** Where policy lives, from `--policy` / `--dir`, with the CLI's cwd default. */
function gateOptions(
  flags: Record<string, string | boolean>,
  cwd: string,
): GateOptions {
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  if (policyFlag !== null) return { policy: { file: absolute(policyFlag, cwd) } };
  return { policy: { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) } };
}

/** The clock is read here, at the edge, and handed to core. */
function now(): string {
  return new Date().toISOString();
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
  const json = wantsJson(argv);
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

/**
 * Identity for the proposing verbs (`register`, `request`).
 *
 * `--as` accepts `human:<id>` or `agent:<id>` — an agent proposing an action is
 * the normal case, and the whole point of the gate is that proposing is not
 * deciding. `APPROVAL_HUMAN` is the fallback and, being a *human* variable,
 * supplies only a human identity. There is no default: an unattributed request
 * is a request nobody can be asked about.
 */
function resolvePrincipalActor(asFlag: string | null): string | null {
  if (asFlag !== null) return PRINCIPAL_ACTOR.test(asFlag) ? asFlag : null;
  return resolveHumanActor();
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export function commandRegister(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, "--as": "string" },
    REGISTER_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const file = positionals[0];
  if (file === undefined) return usageError(streams, json, "missing <task-file> argument", REGISTER_HELP);
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, REGISTER_HELP);
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolvePrincipalActor(asFlag);
  if (actor === null) return identityUsageError(streams, json, asFlag, REGISTER_HELP);

  const result = register(logPath, { file: absolute(file, cwd) }, now(), actor);
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      seq: result.record.seq,
      task: result.task,
      actions: result.actions.length,
    });
  } else {
    streams.out(
      `registered ${result.task} at seq ${result.record.seq}: ${result.actions.length} action(s)\n`,
    );
  }
  return EXIT_OK;
}

function identityUsageError(
  streams: Streams,
  json: boolean,
  asFlag: string | null,
  helpText: string,
): number {
  if (asFlag !== null) {
    return usageError(
      streams,
      json,
      `--as expects human:<id> or agent:<id>, got ${JSON.stringify(asFlag)}`,
      helpText,
    );
  }
  return usageError(
    streams,
    json,
    `no identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id> | agent:<id>`,
    helpText,
  );
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

export function commandRequest(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, ...POLICY_FLAGS, "--as": "string", "--action": "string" },
    REQUEST_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const task = positionals[0];
  if (task === undefined) return usageError(streams, json, "missing <task> argument", REQUEST_HELP);
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, REQUEST_HELP);
  }
  const actionKey = stringFlag(flags, "--action");
  if (actionKey === null) {
    return usageError(streams, json, "missing --action <key>", REQUEST_HELP);
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolvePrincipalActor(asFlag);
  if (actor === null) return identityUsageError(streams, json, asFlag, REQUEST_HELP);

  // The action's declaration comes from the log's task.registered record, never
  // from flags — see the module header.
  const read = readGateRecords(logPath);
  if (!read.ok) return emitRefusal(streams, json, read);
  const declared = registeredAction(read.records, task, actionKey);
  if (!declared.ok) return emitRefusal(streams, json, declared);

  const options = gateOptions(flags, cwd);
  const result = request(
    logPath,
    {
      task,
      actionKey,
      cls: declared.action.class,
      ...(declared.action.est_cost_usd === undefined
        ? {}
        : { est_cost_usd: declared.action.est_cost_usd }),
      ...(declared.action.reversible === undefined
        ? {}
        : { reversible: declared.action.reversible }),
      ...(declared.action.summary === undefined ? {} : { summary: declared.action.summary }),
    },
    now(),
    actor,
    options,
  );
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      task,
      action_key: actionKey,
      class: declared.action.class,
      autonomy: result.autonomy,
      proceed: result.proceed,
      requested: result.record !== null,
      seq: result.record === null ? null : result.record.seq,
    });
  } else if (result.record === null) {
    streams.out(
      `${actionKey}: ${result.autonomy} — no approval required, proceed to execution (no approval.* event, per SPEC.md §6.3)\n`,
    );
  } else {
    streams.out(`requested ${task} ${actionKey} at seq ${result.record.seq} (manual)\n`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// grant / reject / revoke
// ---------------------------------------------------------------------------

const DECISION_HELP: Readonly<Record<Decision, string>> = {
  grant: GRANT_HELP,
  reject: REJECT_HELP,
  revoke: REVOKE_HELP,
};

export function commandDecide(
  decision: Decision,
  argv: string[],
  streams: Streams,
  cwd: string,
): number {
  const helpText = DECISION_HELP[decision];
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, ...POLICY_FLAGS, "--as": "string", "--note": "string" },
    helpText,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", helpText);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, helpText);
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    if (asFlag !== null) {
      return usageError(
        streams,
        json,
        `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; ${decision} is human-only and an agent: or system: actor cannot perform it`,
        helpText,
      );
    }
    return usageError(
      streams,
      json,
      `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`,
      helpText,
    );
  }

  const note = stringFlag(flags, "--note");
  const result = decide(logPath, actionKey, decision, actor, now(), {
    ...gateOptions(flags, cwd),
    ...(note === null ? {} : { note }),
  });
  if (!result.ok) return emitRefusal(streams, json, result);

  // APRV-17: a grant mints the single-use token and this is the ONLY place it is
  // ever printed. The log holds sha256(token) alone, so once this output is gone
  // the value is unrecoverable — hence the warning beside it.
  if (json) {
    emitJson(streams, {
      ok: true,
      decision,
      state: result.state,
      action_key: actionKey,
      seq: result.record.seq,
      ...(result.token === undefined ? {} : { token: result.token }),
    });
  } else {
    streams.out(`${result.state} ${actionKey} at seq ${result.record.seq} by ${actor}\n`);
    if (result.token !== undefined) {
      streams.out(
        `token: ${result.token}\n` +
          `(single-use execution token, shown ONCE: the log records only its SHA-256 and nothing can recover it. Spend it with \`approval run\`; if lost, revoke and request again.)\n`,
      );
    }
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// expire
// ---------------------------------------------------------------------------

export function commandExpire(argv: string[], streams: Streams, cwd: string): number {
  const outcome = front(
    argv,
    { ...COMMON_FLAGS, ...POLICY_FLAGS },
    EXPIRE_HELP,
    streams,
    cwd,
  );
  if (outcome.kind === "handled") return outcome.code;
  const { flags, positionals, json, logPath } = outcome;

  const actionKey = positionals[0];
  if (actionKey === undefined) {
    return usageError(streams, json, "missing <action-key> argument", EXPIRE_HELP);
  }
  const extra = positionals[1];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`, EXPIRE_HELP);
  }

  const result = expire(logPath, actionKey, now(), gateOptions(flags, cwd));
  if (!result.ok) return emitRefusal(streams, json, result);

  if (json) {
    emitJson(streams, {
      ok: true,
      action_key: actionKey,
      actor: result.record.actor,
      seq: result.record.seq,
    });
  } else {
    streams.out(`expired ${actionKey} at seq ${result.record.seq} by ${result.record.actor}\n`);
  }
  return EXIT_OK;
}
