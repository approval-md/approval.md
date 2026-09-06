/**
 * The verb registry: ONE structured description of the CLI surface, for every
 * machine that has to consume it.
 *
 * SPEC.md §10.1 makes the CLI the primary interface for humans and agents, and
 * §10.5 gives the optional MCP wrapper "the same verbs as tools", sharing the
 * CLI's code paths. Two surfaces publishing the same contract from two hand-kept
 * lists is two surfaces that drift, so both read this one: `approval
 * instructions --schemas` prints it verbatim, and an MCP server maps it into
 * tool descriptions and input schemas without re-deriving anything.
 *
 * **This file restates; it does not replace.** Each `purpose` is a one-paragraph
 * agent-facing summary of what the verb's own `--help` says at length, and
 * `src/cli/help.ts` remains the authority on prose. A verb whose help text and
 * whose registry entry disagree is a defect in this file.
 *
 * **The schemas are the frozen shapes, written down.** The `--json` outputs are
 * frozen public API (see `exit-codes.ts` and every `--help`), and the existing
 * CLI suites pin them with `deepEqual` on whole objects. `output` here is the
 * same commitment in JSON Schema form, and `tests/cli-instructions.test.ts`
 * pins it in both directions: every schema must compile under the repo's Ajv
 * setup, and real `--json` output captured from a live CLI run must validate
 * against it. A shape change without a schema change fails there; a schema
 * change without a shape change fails the `deepEqual` suites.
 *
 * **`human_only` is a safety marker, not a convenience flag.** It means: this
 * verb records or establishes a human's authority, and an MCP wrapper MUST NOT
 * publish it as a tool an agent can call. The runtime enforces the human-only
 * verbs itself (in the CLI layer, again in core, again in the event schema);
 * this marker exists so a wrapper does not offer an agent a door the runtime
 * will only slam.
 */

/** A JSON Schema document, carried opaquely. Validated by Ajv, never by us. */
export type JsonSchema = { readonly [key: string]: unknown };

/** One exit code and what it means for this verb. */
export interface ExitCodeMeaning {
  readonly code: number;
  readonly meaning: string;
}

/** Everything a machine needs to call one verb and read its answer. */
export interface VerbSpec {
  /** The top-level verb, exactly as it appears in `main.ts`'s dispatch. */
  readonly name: string;
  /** The subcommand path under it, when there is one ("verify", "telegram listen"). */
  readonly subcommand?: string;
  /** One paragraph, agent-facing: what this verb is for and what it does not do. */
  readonly purpose: string;
  /**
   * True when the verb records or establishes a human's authority. An MCP
   * wrapper MUST NOT expose these as agent-callable tools.
   */
  readonly human_only: boolean;
  /** Why, for the cases where the answer needed an argument rather than a lookup. */
  readonly human_only_note?: string;
  /** Positional arguments, flags, and (where a verb takes one) the trailing argv. */
  readonly input: JsonSchema;
  /** The `--json` SUCCESS shape, or null for a verb that emits no single object. */
  readonly output: JsonSchema | null;
  /** The `--json` failure shape. Shared: every verb answers failures the same way. */
  readonly error: JsonSchema;
  /** The exit codes this verb can produce, with this verb's meaning for each. */
  readonly exit_codes: readonly ExitCodeMeaning[];
}

// ---------------------------------------------------------------------------
// Schema building blocks
// ---------------------------------------------------------------------------

const STRING: JsonSchema = { type: "string" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const INTEGER: JsonSchema = { type: "integer" };
const NUMBER: JsonSchema = { type: "number" };
const SHA256: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };

/**
 * A USD amount as the log holds it since APRV-121: a canonical decimal string.
 *
 * The `--json` surface reports what the record says, so it reports the same
 * spelling. A consumer that wants arithmetic parses it, which is the one thing
 * a decimal string makes unambiguous across languages.
 *
 * The pattern is spelled out rather than imported: this module is deliberately
 * free of runtime imports so that the frozen output shapes are readable as
 * data. `tests/money.test.ts` asserts it is character-for-character the
 * `USD_STRING_PATTERN` of `core/money.ts`, so the copy cannot drift.
 */
const USD_AMOUNT: JsonSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]*)(\\.[0-9]{0,5}[1-9])?$",
};

/**
 * `anyOf` rather than a union `type`, deliberately: the repo's Ajv runs
 * `strict: true`, which refuses union types unless `allowUnionTypes` is set,
 * and relaxing a strict flag to make a schema compile is the wrong trade.
 */
function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] };
}

function object(
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

/** An object whose keys are not enumerated here (a log record, a policy rule). */
const OPEN_OBJECT: JsonSchema = { type: "object" };

const arrayOf = (items: JsonSchema): JsonSchema => ({ type: "array", items });

/**
 * Positional arguments, named in order. `items: false` closes the tail: an
 * unexpected argument is a usage error in the CLI and is one here too.
 */
function positionals(
  names: readonly { readonly name: string; readonly description: string }[],
  requiredCount: number,
): JsonSchema {
  return {
    type: "array",
    prefixItems: names.map((entry) => ({
      type: "string",
      title: entry.name,
      description: entry.description,
    })),
    items: false,
    minItems: requiredCount,
    maxItems: names.length,
  };
}

const NO_POSITIONALS: JsonSchema = { type: "array", maxItems: 0 };

/** The argv after `--`, for the two verbs that take one. */
const TRAILING: JsonSchema = {
  type: "array",
  items: STRING,
  minItems: 1,
  description: "everything after the first `--`, passed through untouched",
};

/** Flags are `string | boolean` (see `args.ts`); nothing else can be parsed. */
function input(parts: {
  positionals?: JsonSchema;
  flags: Record<string, "string" | "boolean">;
  trailing?: JsonSchema;
}): JsonSchema {
  const flagProperties: Record<string, JsonSchema> = {};
  for (const [flag, kind] of Object.entries(parts.flags)) {
    flagProperties[flag] = kind === "string" ? STRING : BOOLEAN;
  }
  const properties: Record<string, JsonSchema> = {
    positionals: parts.positionals ?? NO_POSITIONALS,
    flags: {
      type: "object",
      properties: flagProperties,
      required: [],
      additionalProperties: false,
    },
  };
  if (parts.trailing !== undefined) properties["trailing"] = parts.trailing;
  return {
    type: "object",
    properties,
    required: [],
    additionalProperties: false,
  };
}

/** Flags every command accepts. */
const HELP_FLAGS = { "--help": "boolean", "-h": "boolean" } as const;
const JSON_FLAG = { "--json": "boolean" } as const;
const LOG_FLAG = { "--log": "string" } as const;
const POLICY_FLAGS = { "--policy": "string", "--dir": "string" } as const;
const AS_FLAG = { "--as": "string" } as const;

/**
 * The shared failure shape. Usage and I/O failures print
 * `{"error":{"code","message"}}`; a gate refusal prints the same object with
 * `ok:false` beside it and refusal-specific detail inside `error`. Both forms
 * go to stderr, and both are one object per invocation.
 */
export const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      properties: {
        code: STRING,
        message: STRING,
      },
      required: ["code", "message"],
      additionalProperties: true,
    },
  },
  required: ["error"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

const OK = { code: 0, meaning: "success" } as const;
const INTEGRITY = {
  code: 1,
  meaning:
    "integrity failure, or a GATE REFUSAL: the command was well-formed and the runtime said no",
} as const;
const USAGE = { code: 2, meaning: "usage error" } as const;
const TORN = { code: 3, meaning: "torn tail (the log's final line is unterminated)" } as const;
const IO = { code: 4, meaning: "I/O error; never reported as corruption" } as const;

/** The frozen 0–4 table, as it applies to most verbs. */
const BASE_EXIT_CODES: readonly ExitCodeMeaning[] = [OK, INTEGRITY, USAGE, TORN, IO];

/** Read-only verbs that cannot refuse: 0, 2 and 4 only. */
const READ_ONLY_EXIT_CODES: readonly ExitCodeMeaning[] = [OK, USAGE, IO];

// ---------------------------------------------------------------------------
// Shared output fragments
// ---------------------------------------------------------------------------

const HEAD = nullable(
  object({ seq: INTEGER, hash: SHA256 }, ["seq", "hash"]),
);

/** A stored log record. `event.schema.json` is the authority on its contents. */
const RECORD: JsonSchema = {
  type: "object",
  properties: {
    seq: INTEGER,
    ts: STRING,
    event: STRING,
    actor: STRING,
    hash: SHA256,
    alg: STRING,
    prev: nullable(SHA256),
  },
  required: ["seq", "ts", "event", "actor", "hash", "alg", "prev"],
  additionalProperties: true,
};

/**
 * The policy resolution answer, shared by `policy check` and `policy test`.
 *
 * They are one command under two names (SPEC.md §10.1 lists both), so they get
 * one schema object: an alias that could drift from its original is not an
 * alias.
 */
const POLICY_RESOLUTION_OUTPUT: JsonSchema = object(
  {
    class: STRING,
    reversible: nullable(BOOLEAN),
    outcome: object(
      {
        // APRV-185 adds `human-only`, the one enforced level for which no
        // request, grant, token or run exists: `approval policy explain` is
        // where an agent learns that before it tries.
        autonomy: { enum: ["autonomous", "supervised", "manual", "human-only"] },
        // APRV-127. These three say how a supervised class is supervised. An
        // agent that wants to know whether a prompt is possible reads
        // `supervision`.
        declaredAutonomy: {
          enum: [
            "autonomous",
            "supervised",
            "supervised-live",
            "supervised-retro",
            "manual",
            "human-only",
          ],
        },
        supervision: nullable({ enum: ["live", "retro"] }),
        liveRate: nullable(NUMBER),
        approvers: nullable(arrayOf(STRING)),
        limits: nullable(OPEN_OBJECT),
      },
      ["autonomy", "declaredAutonomy", "supervision", "liveRate", "approvers", "limits"],
    ),
    // `inherited` since APRV-266: a `policy.edit` sub-class the policy declares
    // no rule for, decided by the `policy.edit` line it is a sub-class of.
    provenance: { enum: ["rule", "default", "inherited", "fail-closed", "floor"] },
    manualBecause: nullable({
      enum: ["matched-rule", "irreversibility-floor", "load-failure"],
    }),
    loadFailure: nullable(object({ code: STRING, message: STRING }, ["code", "message"])),
    matched: nullable(object({ pattern: STRING, rule: OPEN_OBJECT }, ["pattern", "rule"])),
    overridden: nullable(
      object({ pattern: nullable(STRING), autonomy: STRING }, ["pattern", "autonomy"]),
    ),
    candidates: arrayOf(
      object(
        {
          pattern: STRING,
          specificity: { type: "array", items: INTEGER, minItems: 3, maxItems: 3 },
          autonomy: STRING,
          winner: BOOLEAN,
          tieBreak: STRING,
        },
        ["pattern", "specificity", "autonomy", "winner", "tieBreak"],
      ),
    ),
    decisionPath: arrayOf(STRING),
  },
  [
    "class",
    "reversible",
    "outcome",
    "provenance",
    "manualBecause",
    "loadFailure",
    "matched",
    "overridden",
    "candidates",
    "decisionPath",
  ],
);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const VERBS: VerbSpec[] = [
  {
    name: "instructions",
    purpose:
      "Print the agent-facing usage guide: what approval.md expects of an agent, the register/request/wait/run sequence, what a refusal means, and the invariants an agent must not route around. With --schemas it prints this registry as JSON instead, which is the machine-readable form of the same contract and the source an MCP wrapper builds its tools from. Reads no log, resolves no policy, writes nothing.",
    human_only: false,
    input: input({ flags: { "--schemas": "boolean", ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object(
      {
        guide: STRING,
        verbs: arrayOf(OPEN_OBJECT),
      },
      ["guide", "verbs"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, USAGE],
  },

  {
    name: "init",
    purpose:
      "Scaffold a working directory: APPROVAL.md (SPEC.md §5.1's canonical policy, to be read and edited), the empty .approval/log/ directory, .approval/QUEUE.md in its empty state, and the .gitignore lines for the index, the vault, the environment source map and the atomic-write temp files. It appends nothing, attests nothing, and overwrites nothing; a re-run writes nothing and reports what already exists.",
    human_only: true,
    human_only_note:
      "It writes the policy file a human must then read and attest, in a directory a human chose. Nothing it writes is operative, but a scaffold an agent could drop into a tree is a policy file nobody decided to have.",
    input: input({ flags: { "--dir": "string", ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object(
      {
        ok: { const: true },
        dir: STRING,
        written: arrayOf(STRING),
        existing: arrayOf(object({ path: STRING, code: STRING }, ["path", "code"])),
        next_steps: arrayOf(STRING),
      },
      ["ok", "dir", "written", "existing", "next_steps"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "log",
    subcommand: "verify",
    purpose:
      "Walk the hash chain end to end and report clean, torn-tail or corrupt. An absent file is an empty log and verifies clean; a torn tail is reported and never truncated. Timestamp anomalies are reported additively and DO NOT change the verdict: chain integrity is a proof, clock skew is a judgment for a human.",
    human_only: false,
    input: input({ flags: { ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS } }),
    output: {
      type: "object",
      properties: {
        status: { enum: ["clean", "torn-tail", "corrupt"] },
        records: nullable(INTEGER),
        head: HEAD,
        intactThroughSeq: INTEGER,
        firstBadSeq: nullable(INTEGER),
        reason: STRING,
        message: STRING,
        anomalies: arrayOf(OPEN_OBJECT),
      },
      required: ["status", "records", "head"],
      additionalProperties: false,
    },
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "clean" },
      { code: 1, meaning: "corrupt" },
      USAGE,
      { code: 3, meaning: "torn tail" },
      IO,
    ],
  },

  {
    name: "log",
    subcommand: "tail",
    purpose:
      "Print the last N records (default 10), oldest first. The chain is verified before anything is printed: a torn tail prints the intact records with a warning and exits 0, and a corrupt log prints nothing at all, because a tail of tampered data is worse than no tail.",
    human_only: false,
    input: input({ flags: { ...LOG_FLAG, "-n": "string", ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object(
      {
        status: { enum: ["ok", "torn-tail"] },
        records: arrayOf(RECORD),
        warning: STRING,
      },
      ["status", "records"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, { code: 1, meaning: "the log is corrupt; nothing was printed" }, USAGE, TORN, IO],
  },

  {
    name: "log",
    subcommand: "export",
    purpose:
      "Stream every stored record to stdout. Without --json the stored lines are written verbatim, byte for byte, so piping export to a file yields a copy of the log. The chain is verified first and the log is never modified.",
    human_only: false,
    input: input({ flags: { ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object({ records: arrayOf(RECORD), warning: STRING }, ["records"]),
    error: ERROR_SCHEMA,
    exit_codes: [OK, { code: 1, meaning: "the log is corrupt; nothing was printed" }, USAGE, TORN, IO],
  },

  // APRV-125. The two verbs that move the log FILE. `human_only` is false on
  // both: an agent may run them, and the policy decides whether it may — they
  // classify as `log.sync` and `log.advance` rather than as the gate's own
  // pass-through, precisely so a policy can hold them.
  {
    name: "log",
    subcommand: "sync",
    purpose:
      "Fast-forward the committed log and put the working chain back, safely. Holds the append lockfile for the WHOLE operation, verifies the chain, snapshots events.jsonl inside .approval/ (never `git stash`), fetches and merges --ff-only, then reconciles: the committed chain must be a prefix of the snapshot, equal to it, or an extension of it, and anything else refuses `log-diverged` naming both heads and the first divergent seq. Chains are never merged or re-chained. QUEUE.md and the index are REBUILT from the reconciled log rather than restored, any failure at any step restores the snapshot before exiting, and no event is appended. PRIMARY CHECKOUT ONLY.",
    human_only: false,
    input: input({
      flags: { "--remote": "string", "--branch": "string", ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        root: STRING,
        log: STRING,
        remote: STRING,
        branch: STRING,
        commit: object({ before: STRING, after: STRING, pulled: INTEGER }, [
          "before",
          "after",
          "pulled",
        ]),
        head: object({ before: HEAD, after: HEAD }, ["before", "after"]),
        relation: STRING,
        ahead: INTEGER,
        behind: INTEGER,
        restored: BOOLEAN,
        queue: object({ path: STRING, bytes: INTEGER }, ["path", "bytes"]),
        index: STRING,
      },
      [
        "ok",
        "root",
        "log",
        "remote",
        "branch",
        "commit",
        "head",
        "relation",
        "ahead",
        "behind",
        "restored",
        "queue",
        "index",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      { code: 1, meaning: "the chains diverged, or a log did not verify; nothing was changed" },
      USAGE,
      IO,
    ],
  },

  {
    name: "log",
    subcommand: "advance",
    purpose:
      "Commit the log's uncommitted records and push them to a records branch. Verifies the chain under the append lock, stages EXACTLY .approval/log/events.jsonl, .approval/QUEUE.md and .approval/payloads/ (any other staged path refuses `log-advance-dirty-stage` rather than being unstaged), commits on the branch you are standing on with the seq range in the message, and pushes that commit by refspec to `--branch` (default records-log-<date>), never to main. It CHECKS OUT NOTHING and appends no event. `--pr` opens the pull request through the ordinary gh path; `--dry-run` reports and writes nothing. PRIMARY CHECKOUT ONLY.",
    human_only: false,
    input: input({
      flags: {
        "--remote": "string",
        "--branch": "string",
        "--pr": "boolean",
        "--dry-run": "boolean",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        root: STRING,
        branch: STRING,
        recordsBranch: STRING,
        remote: STRING,
        range: nullable(object({ from: INTEGER, to: INTEGER }, ["from", "to"])),
        head: object({ committed: HEAD, working: HEAD }, ["committed", "working"]),
        staged: arrayOf(STRING),
        message: STRING,
        commit: nullable(STRING),
        pushed: BOOLEAN,
        prUrl: nullable(STRING),
        dryRun: BOOLEAN,
      },
      [
        "ok",
        "root",
        "branch",
        "recordsBranch",
        "remote",
        "range",
        "head",
        "staged",
        "message",
        "commit",
        "pushed",
        "prUrl",
        "dryRun",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      { code: 1, meaning: "the log did not verify, or the chains diverged; nothing was committed" },
      USAGE,
      IO,
    ],
  },

  {
    name: "policy",
    subcommand: "check",
    purpose:
      "Explain what APPROVAL.md does with one action class: the resolved autonomy, the rule that matched, every candidate with its specificity, and the decision path that produced the answer. Nothing is executed, requested or logged. A policy that fails to load is not an error here: a broken policy IS a manual-everything policy, and that answer is delivered on stdout at exit 0, so branch on manualBecause and provenance rather than on the exit code.",
    human_only: false,
    input: input({
      positionals: positionals(
        [{ name: "class", description: "a concrete action class, e.g. vcs.push.main" }],
        1,
      ),
      flags: { "--reversible": "string", ...POLICY_FLAGS, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: POLICY_RESOLUTION_OUTPUT,
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "the question was answered, INCLUDING the fail-closed answer" },
      USAGE,
      { code: 4, meaning: "a policy path that exists but cannot be read" },
    ],
  },

  {
    name: "policy",
    subcommand: "test",
    purpose:
      "An exact alias of `policy check`; SPEC.md §10.1 names both and they are the same command, with the same flags, the same answer and the same --json shape.",
    human_only: false,
    input: input({
      positionals: positionals(
        [{ name: "class", description: "a concrete action class, e.g. vcs.push.main" }],
        1,
      ),
      flags: { "--reversible": "string", ...POLICY_FLAGS, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: POLICY_RESOLUTION_OUTPUT,
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "the question was answered, INCLUDING the fail-closed answer" },
      USAGE,
      { code: 4, meaning: "a policy path that exists but cannot be read" },
    ],
  },

  {
    name: "policy",
    subcommand: "attest",
    purpose:
      "Record a human's sign-off on the policy file's exact bytes, as one policy.updated event carrying their SHA-256. Gate operations refuse while the live file is unattested or has changed since the last attestation, so an edited policy is inoperative until a human re-attests it. With --organ <path> it attests one of the gate's ORGANS instead — the harness files that install the hook — as one gate.organ.attested event no gate operation reads: those paths are human-only, so no grant for a hand edit to one can exist and this record is the only evidence the protected-path guard can accept (APRV-272).",
    human_only: true,
    input: input({
      flags: {
        ...POLICY_FLAGS,
        "--organ": "string",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        seq: INTEGER,
        sha256: SHA256,
        path: STRING,
        // Present on an --organ attestation and absent otherwise: the
        // repository-relative spelling the record carries, which is the
        // identity the guard matches on and is not derivable from `path`.
        organ_path: STRING,
      },
      ["ok", "seq", "sha256", "path"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "policy",
    subcommand: "amend",
    purpose:
      "The whole amendment ceremony in one verb: semantic diff of the edited policy against the last-attested bytes, load advisory, attestation, and the two-file git commit that lands the edit and its attestation together. Refuses to assume a confirmation it could not ask for.",
    human_only: true,
    input: input({
      flags: {
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...AS_FLAG,
        "--require-load": "boolean",
        "--dry-run": "boolean",
        "--commit": "boolean",
        "--yes": "boolean",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        noop: BOOLEAN,
        dryRun: BOOLEAN,
        aborted: BOOLEAN,
        policy: STRING,
        liveSha256: SHA256,
        attested: nullable(object({ sha256: SHA256, seq: INTEGER }, ["sha256", "seq"])),
        baseline: object({ mode: STRING, reason: nullable(STRING) }, ["mode", "reason"]),
        diff: nullable(OPEN_OBJECT),
        load: nullable(OPEN_OBJECT),
        attestation: nullable(object({ seq: INTEGER, sha256: SHA256 }, ["seq", "sha256"])),
        git: nullable(OPEN_OBJECT),
      },
      [
        "ok",
        "noop",
        "dryRun",
        "aborted",
        "policy",
        "liveSha256",
        "attested",
        "baseline",
        "diff",
        "load",
        "attestation",
        "git",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "register",
    purpose:
      "Validate a task file's `approval:` envelope against envelope.schema.json and append one task.registered event carrying the declared actions. FAIL CLOSED: an invalid envelope appends nothing. The file is read only. Registration is a proposal rather than a decision, so an agent may perform it, and it is the step that makes every later question about an action ('what class is this key?') answerable from the log.",
    human_only: false,
    input: input({
      positionals: positionals(
        [{ name: "task-file", description: "path to the task file to register" }],
        1,
      ),
      flags: { ...AS_FLAG, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object({ ok: { const: true }, seq: INTEGER, task: STRING, actions: INTEGER }, [
      "ok",
      "seq",
      "task",
      "actions",
    ]),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "request",
    purpose:
      "Ask the gate to admit one declared action. The class, cost, reversibility and summary come from the task.registered record in the LOG, never from a flag: an agent that could name its own class at request time could declare read.web for an action registered as financial.spend. A manual class appends approval.requested and reports proceed:false; a supervised or autonomous class appends NOTHING and reports proceed:true, so do not wait for a grant that will never come.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "task", description: "the task id" }], 1),
      flags: {
        "--action": "string",
        ...AS_FLAG,
        "--payload": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        task: STRING,
        action_key: STRING,
        class: STRING,
        autonomy: { enum: ["autonomous", "supervised", "manual"] },
        proceed: BOOLEAN,
        requested: BOOLEAN,
        seq: nullable(INTEGER),
      },
      ["ok", "task", "action_key", "class", "autonomy", "proceed", "requested", "seq"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "grant",
    purpose:
      "Record a human approval of a pending request and mint the single-use execution token for its action. The raw token is PRINTED ONCE here and stored nowhere: the log holds only its SHA-256, so nothing can recover it afterwards. Budgets are re-evaluated at grant time, because the moment that matters for a commitment is the moment the human commits.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--note": "string",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        decision: { const: "grant" },
        state: { const: "granted" },
        action_key: STRING,
        seq: INTEGER,
        token: SHA256,
      },
      ["ok", "decision", "state", "action_key", "seq", "token"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "reject",
    purpose:
      "Record a human refusal of a pending request. A refusal is terminal: the log is append-only, a second decision is refused already-decided, and no retry, rephrasing or re-request by the same agent changes it. Only a human acting again can.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--note": "string",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        decision: { const: "reject" },
        state: { const: "rejected" },
        action_key: STRING,
        seq: INTEGER,
      },
      ["ok", "decision", "state", "action_key", "seq"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "revoke",
    purpose:
      "Withdraw a granted approval that has not executed. Legal only on a granted, unexecuted request: an unexecuted grant can be withdrawn, an executed one cannot be un-sent. It withdraws authority rather than granting it, so no attestation is required and no budget is charged.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--note": "string",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        decision: { const: "revoke" },
        state: { const: "revoked" },
        action_key: STRING,
        seq: INTEGER,
      },
      ["ok", "decision", "state", "action_key", "seq"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "withdraw",
    purpose:
      "Take back a pending request you opened, appending one approval.withdrawn. REQUESTER-ONLY: the actor must be the one that appended the approval.requested, and any other actor is refused not-requester. Legal only while the request is pending, and terminal once appended — a later grant, reject or revoke is refused request-withdrawn. Withdraw when you can no longer consume an answer (your wait elapsed, you cancelled, a newer request supersedes this one); a decision nobody can act on is human attention spent for nothing.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "task", description: "the task id" }], 1),
      flags: {
        "--action": "string",
        "--reason": "string",
        "--note": "string",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        task: STRING,
        action_key: STRING,
        state: { const: "withdrawn" },
        reason: { enum: ["timeout", "cancelled", "superseded"] },
        seq: INTEGER,
      },
      ["ok", "task", "action_key", "state", "reason", "seq"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "expire",
    purpose:
      "Lapse a request whose TTL has passed, appending one approval.expired event with the actor system:gate. No identity is accepted or resolved: no human decides an expiry, the clock does. The gate already refuses a late decision whether or not this event exists, so the verb makes a lapse visible rather than changing a verdict.",
    human_only: true,
    human_only_note:
      "The system verb, run by the daemon's sweep or by an operator's hand. It takes no identity at all, so there is no sense in which an agent could be its actor, and it writes a state transition into the log. Marked human_only so no wrapper offers it as an agent tool; the daemon calls the same code path.",
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: { ...POLICY_FLAGS, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      { ok: { const: true }, action_key: STRING, actor: { const: "system:gate" }, seq: INTEGER },
      ["ok", "action_key", "actor", "seq"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "token",
    purpose:
      "Report whether a live, unspent execution token exists for an action key, and print its digest so an operator can match it against the log. IT DOES NOT PRINT THE TOKEN and no future version can: the raw value exists only in the output of the grant that minted it. Exit 0 means granted, unrevoked, unexpired and unconsumed; every other answer is a refusal naming which of the three deaths applied. Writes nothing.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: { ...POLICY_FLAGS, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        action_key: STRING,
        state: STRING,
        live: BOOLEAN,
        token_sha256: SHA256,
        grant_seq: INTEGER,
        class: STRING,
        est_cost_usd: USD_AMOUNT,
        payload_hash: nullable(SHA256),
        task: STRING,
      },
      ["ok", "action_key", "state", "live", "token_sha256", "grant_seq", "class", "est_cost_usd", "task"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "consume",
    purpose:
      "Spend an execution token and append one execution.started (INTERNAL PLUMBING). `approval run` wraps it, and that is what to reach for; this exists so the token boundary is testable and an adapter integration can be driven by hand. It is the only sanctioned appender of execution.started on the manual path: a manual action's start event cannot exist without a verified token behind it.",
    human_only: false,
    human_only_note:
      "Not human-only: it spends a token a human already granted, which is exactly the authority an executing agent is meant to hold. It is marked INTERNAL in its purpose instead, because a wrapper should publish `run`.",
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--token": "string",
        "--payload-hash": "string",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        action_key: STRING,
        event: { const: "execution.started" },
        seq: INTEGER,
        token_sha256: SHA256,
        grant_seq: INTEGER,
        class: STRING,
        est_cost_usd: USD_AMOUNT,
      },
      ["ok", "action_key", "event", "seq", "token_sha256", "grant_seq", "class", "est_cost_usd"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "run",
    purpose:
      "Execute a command behind the gate: append execution.started BEFORE spawning it, spawn it with inherited stdio, append execution.completed or execution.failed carrying the child's real exit code, and exit with that same code. A manual action must present the token its grant printed; supervised and autonomous actions have no token and are enforced here through attestation, loop escalation, idempotency and budgets. The --json summary goes to STDERR, because stdout belongs to the child.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--token": "string",
        "--payload-hash": "string",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
      trailing: TRAILING,
    }),
    output: object(
      {
        ok: { const: true },
        action_key: STRING,
        task: STRING,
        class: STRING,
        autonomy: STRING,
        started_seq: INTEGER,
        outcome: { enum: ["execution.completed", "execution.failed"] },
        outcome_seq: INTEGER,
        exit_code: nullable(INTEGER),
        payload_hash: nullable(SHA256),
      },
      [
        "ok",
        "action_key",
        "task",
        "class",
        "autonomy",
        "started_seq",
        "outcome",
        "outcome_seq",
        "exit_code",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "the child exited 0 (run is transparent: it exits with the child's code)" },
      INTEGRITY,
      USAGE,
      TORN,
      IO,
      {
        code: 5,
        meaning:
          "NO VALID EXECUTION TOKEN: the class resolves to manual and no usable token was presented. Nothing was appended",
      },
    ],
  },

  {
    name: "execution",
    subcommand: "resolve",
    purpose:
      "Record the outcome a HUMAN OBSERVED for a dangling execution — one that started and whose end nobody knows, the state a crash between execution.started and its outcome leaves. It demands a non-empty note, records exit_code null rather than inventing one, and marks attested_by_human so no reader mistakes an observation for a measurement. Nothing in this codebase closes a dangling execution automatically. --dangling is the BULK form: it lists every dangling execution with what this checkout can PROVE about each (the ref carrying the seq a daemon advance named, or nothing), asks once, and appends one human-attested completed per provable key with a note naming that ref. Keys nothing proves are listed with their own one-line command and left untouched.",
    human_only: true,
    input: input({
      // Exactly one action key without `--dangling`, and none with it, which
      // is a dependency between a positional and a flag that no positional
      // TUPLE can state: a 1-tuple whose `minItems` is 0 is not a tuple at all
      // under the strict Ajv this registry compiles with. So the arity is
      // spelled as a bounded list and which of the two forms was asked for is
      // checked in the verb, where the refusal can say so in a sentence.
      positionals: {
        type: "array",
        items: { type: "string", title: "action-key", description: "the action's idempotency_key" },
        maxItems: 1,
        description: "the action key, for the single form; absent with --dangling",
      },
      flags: {
        "--outcome": "string",
        "--note": "string",
        "--dangling": "boolean",
        "--class": "string",
        "--yes": "boolean",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    // Two shapes for two forms, and a reader branches on which keys are there:
    // the single form answers about ONE key it was given, the bulk form answers
    // with the LIST it derived. Collapsing them into one object with everything
    // optional would make `action_key` absent mean two different things.
    output: {
      anyOf: [
        object(
          {
            ok: { const: true },
            action_key: STRING,
            task: STRING,
            event: { enum: ["execution.completed", "execution.failed"] },
            outcome: { enum: ["completed", "failed"] },
            seq: INTEGER,
            attested_by_human: { const: true },
            actor: STRING,
          },
          ["ok", "action_key", "task", "event", "outcome", "seq", "attested_by_human", "actor"],
        ),
        object(
          {
            ok: BOOLEAN,
            dangling: arrayOf(
              object(
                {
                  action_key: STRING,
                  task: nullable(STRING),
                  class: nullable(STRING),
                  seq: INTEGER,
                  ts: STRING,
                  provable: BOOLEAN,
                  proven_by: nullable(STRING),
                  proven_seq: nullable(INTEGER),
                  fix: STRING,
                },
                ["action_key", "task", "class", "seq", "ts", "provable", "proven_by", "proven_seq"],
              ),
            ),
            resolved: arrayOf(
              object(
                { action_key: STRING, seq: INTEGER, proven_by: nullable(STRING) },
                ["action_key", "seq", "proven_by"],
              ),
            ),
            unresolved: arrayOf(STRING),
            failed: arrayOf(
              object({ action_key: STRING, code: STRING, message: STRING }, [
                "action_key",
                "code",
                "message",
              ]),
            ),
            attested_by_human: { const: true },
            actor: STRING,
          },
          ["ok", "dangling", "resolved", "unresolved", "actor"],
        ),
      ],
    },
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "execution",
    subcommand: "reconcile",
    purpose:
      "Record what a HUMAN ESTABLISHED about an INDETERMINATE execution — one whose side effect was attempted and whose outcome nobody knows, which is a different state from a dangling execution and from a failure. It appends execution.reconciled naming the execution.indeterminate record by seq and never rewriting it, so the doubt survives its own answer, and it demands the evidence as a non-empty note. Resolving not-executed re-opens the EFFECT and not this action: the idempotency key stays burned either way, so the repair is a fresh action and a fresh request. Nothing auto-resolves an indeterminate outcome, the daemon least of all.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--resolution": "string",
        "--note": "string",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        action_key: STRING,
        task: STRING,
        event: { const: "execution.reconciled" },
        resolution: { enum: ["executed", "not-executed"] },
        indeterminate_seq: INTEGER,
        seq: INTEGER,
        attested_by_human: { const: true },
        actor: STRING,
      },
      [
        "ok",
        "action_key",
        "task",
        "event",
        "resolution",
        "indeterminate_seq",
        "seq",
        "attested_by_human",
        "actor",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "audit",
    subcommand: "list",
    purpose:
      "The open sampled-audit backlog: audit.sampled records with no audit.reviewed after them. It reads a verified log, writes nothing, and reports beside the backlog whether sampling is running at all, because an empty backlog means one thing when the sampler is on and quite another when it is off.",
    human_only: false,
    input: input({
      flags: { "--all": "boolean", ...POLICY_FLAGS, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        sampling: object(
          {
            enabled: BOOLEAN,
            rate: nullable(NUMBER),
            secret_env: nullable(STRING),
            reason: nullable(STRING),
          },
          ["enabled", "rate", "secret_env", "reason"],
        ),
        open: INTEGER,
        samples: arrayOf(OPEN_OBJECT),
      },
      ["ok", "sampling", "open", "samples"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "audit",
    subcommand: "review",
    purpose:
      "Record that a human looked at one sampled supervised action. There is deliberately no `audit sample`: selection is the runtime's, made by the daemon from an operator-held secret, because a party that could sample could also decline to sample itself. A runtime that could mark its own samples reviewed would be a supervision backlog that empties itself.",
    human_only: true,
    input: input({
      positionals: positionals(
        [
          {
            name: "seq|action-key",
            description: "the seq of the audit.sampled record, or an action key with one open sample",
          },
        ],
        1,
      ),
      flags: {
        "--note": "string",
        "--deny": "boolean",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        seq: INTEGER,
        sample_seq: INTEGER,
        action_key: STRING,
        task: STRING,
        verdict: { enum: ["ok", "denied"] },
        obligation_seq: nullable(INTEGER),
        actor: STRING,
      },
      ["ok", "seq", "sample_seq", "action_key", "task", "verdict", "obligation_seq", "actor"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "audit",
    subcommand: "obligations",
    purpose:
      "The open reconciliation backlog: reconciliation.required records with no reconciliation.satisfied after them. An obligation is opened by a retrospective DENIAL and closed only by a person, because a runtime that could close its own obligations would be a backlog that empties itself. It reads a verified log and writes nothing.",
    human_only: false,
    input: input({
      flags: { "--all": "boolean", ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        open: INTEGER,
        obligations: arrayOf(OPEN_OBJECT),
      },
      ["ok", "open", "obligations"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "audit",
    subcommand: "reconcile",
    purpose:
      "Record that a human discharged one reconciliation obligation. A retrospective denial cannot undo anything, so what it creates is an obligation: revert a reversible action THROUGH THE GATE, or review the class that permitted an irreversible one. A gated-revert obligation is checked against the chain rather than the claim — without an execution.completed for the named revert this refuses and appends nothing.",
    human_only: true,
    input: input({
      positionals: positionals(
        [
          {
            name: "obligation-seq",
            description: "the seq of the reconciliation.required record, from `audit obligations`",
          },
        ],
        1,
      ),
      flags: {
        "--note": "string",
        "--revert": "string",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        seq: INTEGER,
        obligation_seq: INTEGER,
        action_key: STRING,
        task: nullable(STRING),
        class: STRING,
        obligation: { enum: ["gated-revert", "policy-finding"] },
        actor: STRING,
      },
      ["ok", "seq", "obligation_seq", "action_key", "class", "obligation", "actor"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "wait",
    purpose:
      "Block until every approval.requested of a task has a decision, or the timeout elapses. THE EXIT CODE IS THE DECISION: 0 granted, 1 rejected, revoked or withdrawn, 3 expired, 6 timeout. It writes nothing by default, not even the expiry it may derive; --withdraw-on-timeout is the one exception, appending approval.withdrawn for the requests this actor opened so a question nobody can answer to does not sit in a human's queue. Only the manual path produces requests to wait for, so a task with none returns immediately at exit 0. Under policy token_delivery: sealed, a granted action's --json entry also carries the raw execution token, opened from the grant's ciphertext with the private key this machine kept when it opened the request; that removes the terminal paste and works across machines. Recovering a minted token is not minting one: it still exists only because a human granted it, still binds to the payload bytes, and is still single-use.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "task", description: "the task id" }], 1),
      flags: {
        "--timeout": "string",
        "--interval": "string",
        "--withdraw-on-timeout": "boolean",
        ...AS_FLAG,
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: BOOLEAN,
        task: STRING,
        status: { enum: ["granted", "rejected", "withdrawn", "expired", "timeout"] },
        actions: arrayOf(
          object(
            {
              action_key: STRING,
              state: STRING,
              seq: nullable(INTEGER),
              // APRV-105: the raw execution token, when sealed delivery put one
              // within this process's reach. Optional and present only on a
              // granted action under `token_delivery: sealed`; `--json` only,
              // never the human render, which is a terminal.
              token: STRING,
            },
            ["action_key", "state", "seq"],
          ),
        ),
      },
      ["ok", "task", "status", "actions"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "granted (a task with no requests is granted vacuously)" },
      {
        code: 1,
        meaning:
          "NOT AUTHORIZED and terminal — a human said no (rejected/revoked), or the requester withdrew the request; or the log is corrupt. `status` says which",
      },
      USAGE,
      { code: 3, meaning: "EXPIRED — the TTL lapsed before a decision landed; or a torn tail" },
      IO,
      {
        code: 6,
        meaning:
          "TIMEOUT — the wait elapsed with request(s) undecided. Nothing was appended, they are still live, and waiting again is legitimate",
      },
    ],
  },

  {
    name: "queue",
    purpose:
      "The pending-decision INBOX: exactly the requests awaiting a human and inside their TTL, with the action key, task, class, declared cost, request time and TTL remaining. Nothing else — dangling executions, attestation state, budgets and escalations all live in `status`. Writes nothing, and exits 0 whenever the log could be read: an empty inbox is a healthy inbox.",
    human_only: false,
    input: input({ flags: { ...POLICY_FLAGS, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object(
      {
        ok: { const: true },
        pending: arrayOf(
          object(
            {
              action_key: STRING,
              task: STRING,
              class: STRING,
              est_cost_usd: nullable(USD_AMOUNT),
              requested_ts: STRING,
              seq: INTEGER,
              ttl_remaining_ms: nullable(INTEGER),
            },
            ["action_key", "task", "class", "est_cost_usd", "requested_ts", "seq", "ttl_remaining_ms"],
          ),
        ),
      },
      ["ok", "pending"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, USAGE, TORN, IO],
  },

  // APRV-214, amended SPEC.md §5.2: the open window. Three entries because the
  // three subcommands answer to different people — a person opening a bypass, a
  // person ending one, and anybody at all asking whether one stands.
  {
    name: "gate",
    subcommand: "open",
    purpose:
      "Open the harness gate for a bounded time so the gate itself can be debugged: while the window stands, the hook ALLOWS every gated shell command and file edit under the root, recording each as gate.bypassed, ahead of the policy load, the attestation check, the loop floor and the human gate. Default 30m, cap 24h, --reason required. The window's whole state is the log (gate.opened, closed by gate.closed or by lapsing, which appends nothing); no file holds it. It never reaches .approval/log/, a class the policy reserves to human hands, a command the classifier cannot read, or a log that cannot be verified. Bypassed calls are charged to no budget and enter no retrospective sample.",
    human_only: true,
    human_only_note:
      "It suspends the policy. There is no --yes and no --force: stdin must be a terminal and the word `understood` must be typed in full, which is what puts it out of reach of a harness shell tool. It also classifies `policy.core`, so a policy holding that human-only makes the hook refuse an agent that tries.",
    input: input({
      positionals: positionals(
        [{ name: "open", description: "the subcommand" }],
        1,
      ),
      flags: {
        "--for": "string",
        "--reason": "string",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...HELP_FLAGS,
      },
    }),
    // No `--json` success shape exists, and that is the contract: `--json` on
    // this verb is refused with `gate-stdin-not-tty`, because an answer shaped
    // for a machine implies a machine asking a question only a person answers.
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "gate",
    subcommand: "close",
    purpose:
      "End the open window now rather than at its expiry, appending gate.closed naming the seq of the gate.opened it ends. Human-only like the opening, though this half only ever TIGHTENS: there is no confirmation to type, because a ceremony guarding the safe direction is one people learn to type past. Refuses `gate-not-open` when no window stands, which includes one that has already lapsed — a lapse appends nothing and needs no closing record.",
    human_only: true,
    human_only_note:
      "The pair is one ceremony and both halves are the human's, so the actor rule is uniform. An agent closing a window could authorize nothing by it, and the uniformity is what makes the rule statable in one sentence.",
    input: input({
      positionals: positionals([{ name: "close", description: "the subcommand" }], 1),
      flags: { "--note": "string", ...AS_FLAG, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        seq: INTEGER,
        opened_seq: INTEGER,
        actor: STRING,
        bypassed: INTEGER,
      },
      ["ok", "seq", "opened_seq", "actor", "bypassed"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "gate",
    subcommand: "status",
    purpose:
      "Report whether a window is open, and if so which: the seq of the gate.opened, who opened it, their reason, when it expires, how long is left, and how many calls have been bypassed under it. Derived from the verified log alone, so it is the same fact the hook and `approval status` derive. Reads only; appends nothing and decides nothing.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "status", description: "the subcommand" }], 1),
      flags: { ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        open: BOOLEAN,
        window: nullable(
          object(
            {
              seq: INTEGER,
              opened_at: STRING,
              opened_by: STRING,
              reason: STRING,
              expires_at: STRING,
              remaining_ms: INTEGER,
              bypassed: INTEGER,
              scope: STRING,
            },
            [
              "seq",
              "opened_at",
              "opened_by",
              "reason",
              "expires_at",
              "remaining_ms",
              "bypassed",
              "scope",
            ],
          ),
        ),
      },
      ["ok", "open", "window"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, INTEGRITY, USAGE, TORN, IO],
  },

  {
    name: "status",
    purpose:
      "System HEALTH, from the log: attestation state, the latest chain verdict, dangling executions, indeterminate executions, budget headroom from a zero-cost probe, loop escalations, and the payload store's size. Exit 1 when any of those needs attention. `dangling` is executions the runtime meant to watch and did not, and never harness executions, which are terminal by design and gain no outcome; `indeterminate` is side effects that were attempted and whose fate nobody has established, and it appears only when there are some. This is what an operator must fix; `queue` is what a human must answer, and neither carries the other's content. Writes nothing.",
    human_only: false,
    input: input({ flags: { ...POLICY_FLAGS, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object(
      {
        ok: { const: true },
        healthy: BOOLEAN,
        attestation: object({ state: STRING, seq: nullable(INTEGER) }, ["state", "seq"]),
        verification: object({ status: STRING, records: nullable(INTEGER) }, ["status", "records"]),
        dangling: arrayOf(OPEN_OBJECT),
        indeterminate: arrayOf(OPEN_OBJECT),
        budgets: arrayOf(OPEN_OBJECT),
        // APRV-145: each entry gained a `scope` field naming which derivation
        // produced its key — `task`, `session` or `actor`.
        loop_escalations: arrayOf(OPEN_OBJECT),
        // APRV-145: how many harness starts carry an outcome and how many do
        // not. INFORMATIONAL, and outside `healthy` and the exit code for the
        // reason `anomalies` is: a coverage measurement, not a verdict.
        harness_outcomes: OPEN_OBJECT,
        // APRV-245: what git witnessed on this branch, and how much of it the
        // log can account for. INFORMATIONAL and outside `healthy` and the exit
        // code, exactly as `harness_outcomes` is. Always present, with
        // `available: false` and a reason where there is no checkout or no
        // trunk ref; the whole report is `approval coverage`.
        coverage: object(
          {
            available: BOOLEAN,
            reason: nullable(STRING),
            observed: INTEGER,
            covered: INTEGER,
          },
          ["available", "reason", "observed", "covered"],
        ),
        // APRV-127: reconciliation obligations opened by a retrospective denial
        // and not yet discharged. Counts toward `healthy`, like `dangling`.
        reconciliation: arrayOf(OPEN_OBJECT),
        payload_store: OPEN_OBJECT,
        anomalies: arrayOf(OPEN_OBJECT),
        // APRV-214: present only while a window stands, so a repository with
        // none emits the object it always emitted. It counts toward `healthy`,
        // which is why it is reported here rather than only by `gate status`.
        gate_window: OPEN_OBJECT,
      },
      [
        "ok",
        "healthy",
        "attestation",
        "verification",
        "dangling",
        "budgets",
        "loop_escalations",
        "harness_outcomes",
        "coverage",
        "reconciliation",
        "payload_store",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, { code: 1, meaning: "something needs attention" }, USAGE, IO],
  },

  {
    name: "coverage",
    purpose:
      "What the witnesses this project does NOT write say happened, joined to the verified log. Git history, `gh` and an adapter's provider each record side effects that no agent editing its own log can reach, and this verb reads them back and reports, per effect, the evidence in the log (a `task.registered`, `approval.granted`, `execution.started` or `execution.completed` of a matching class inside the effect's window) or `none`. It is INFORMATIONAL, exactly as the harness-start coverage in `status` is: exit 0 with or without gaps, because a coverage measurement is not an integrity verdict and a control an operator learns to silence is worse than one that reports beside the verdict. It writes nothing anywhere and reads only verified records. A source that could not be reached is reported unavailable with its reason, never as an absence of effects, and a green line says nothing about effects made with a credential the agent holds itself; the remedy for those is custody, not a bigger report.",
    human_only: false,
    input: input({
      flags: {
        "--base": "string",
        "--head": "string",
        "--since": "string",
        "--until": "string",
        "--source": "string",
        "--vault": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        window: object(
          { base: STRING, head: STRING, since: STRING, until: STRING },
          ["base", "head", "since", "until"],
        ),
        sources: arrayOf(
          object(
            {
              name: STRING,
              available: BOOLEAN,
              reason: nullable(STRING),
              effects: arrayOf(
                object(
                  {
                    id: STRING,
                    class: STRING,
                    at: STRING,
                    // A hint, printed and never matched on: a commit author
                    // email is whatever the committer configured (SPEC.md
                    // §11.1 invariant 4).
                    actor_hint: nullable(STRING),
                    detail: STRING,
                    path: nullable(STRING),
                    match: { enum: ["exact", "family", "protected-path", "none"] },
                    // Two kinds of proof under one key, and the null halves say
                    // which: a record seq a reader can paste into `approval log
                    // tail`, or the protected-path guard's byte-level verdict.
                    evidence: nullable(
                      object(
                        {
                          seq: nullable(INTEGER),
                          event: nullable(STRING),
                          verdict: nullable(STRING),
                        },
                        ["seq", "event", "verdict"],
                      ),
                    ),
                  },
                  ["id", "class", "at", "actor_hint", "detail", "path", "match", "evidence"],
                ),
              ),
              covered: INTEGER,
              observed: INTEGER,
            },
            ["name", "available", "reason", "effects", "covered", "observed"],
          ),
        ),
      },
      ["ok", "window", "sources"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, USAGE, TORN, IO],
  },

  {
    name: "doctor",
    purpose:
      "Is this MACHINE able to run the system? Fifteen checks in cascade order — build freshness, declared identity, policy attestation, chain health, Telegram, the web port, the payload store, audit sampling, envelope integrity, the vault, the environment, log drift, reconciliation, harness hook outcomes, harness hook wiring — each with a concrete repair that begins with a command you can paste. Appends nothing, sends nothing, repairs nothing. `status` reports the system's health; doctor reports whether this machine can run it at all.",
    human_only: false,
    input: input({
      flags: {
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        "--tasks": "string",
        "--api-base": "string",
        "--root": "string",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: BOOLEAN,
        checks: arrayOf(
          object(
            {
              check: STRING,
              status: { enum: ["pass", "fail", "skip"] },
              detail: STRING,
              fix: STRING,
            },
            ["check", "status", "detail"],
          ),
        ),
      },
      ["ok", "checks"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      { code: 1, meaning: "at least one check failed" },
      USAGE,
      { code: 4, meaning: "doctor itself could not look" },
    ],
  },

  {
    name: "channel",
    subcommand: "cli",
    purpose:
      "Render the pending queue in this terminal with the SPEC.md §9 [computed]/[claimed] markers and each manual action's full payload in delimiters, and — with a terminal — collect decisions through the same human-only gate `grant` and `reject` call. Without a TTY, and always with --json, it prints the queue and exits 0 without reading stdin.",
    human_only: true,
    human_only_note:
      "It records human decisions through the human-only gate, and its interactive path mints execution tokens. A wrapper offering it to an agent would be offering a route to approve.",
    input: input({
      flags: {
        ...LOG_FLAG,
        "--policy-dir": "string",
        "--policy": "string",
        "--payload-dir": "string",
        ...AS_FLAG,
        "--interactive": "boolean",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        channel: { const: "cli" },
        interactive: BOOLEAN,
        pending: arrayOf(OPEN_OBJECT),
        skipped: arrayOf(OPEN_OBJECT),
      },
      ["ok", "channel", "interactive", "pending", "skipped"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "channel",
    subcommand: "web",
    purpose:
      "Serve the pending queue as a page on 127.0.0.1 and nothing else, with Grant/Reject forms and a batch gesture, until interrupted. The loopback host is hard-coded because the page has NO AUTHENTICATION and the interface is the access control. Its --json output is one object per line, not one per invocation.",
    human_only: true,
    human_only_note:
      "Same reason as `channel cli`: it exists to collect a human's decision, and it displays minted execution tokens.",
    input: input({
      flags: {
        "--port": "string",
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        "--payload-dir": "string",
        ...AS_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "channel",
    subcommand: "telegram listen",
    purpose:
      "Deliver the pending queue to the configured Telegram chat on every poll cycle and long-poll for Approve/Reject taps, recording each through the same human-only gate. The bot token and chat id come from the environment variables the policy NAMES; there is no flag for either value. The raw execution token is printed on this terminal and is never sent to Telegram.",
    human_only: true,
    human_only_note:
      "It records human decisions. It is also long-lived and holds a transport credential, so it is an operator's process rather than a call an agent makes.",
    input: input({
      flags: {
        "--once": "boolean",
        ...AS_FLAG,
        "--payloads": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        "--api-base": "string",
        "--poll-timeout": "string",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "channel",
    subcommand: "telegram health",
    purpose:
      "Report whether the bot token and chat id variables this policy names are set. It makes NO network call and prints no value, only whether one is present. Exit 0 when both are configured, 1 when either is missing.",
    human_only: false,
    input: input({ flags: { ...POLICY_FLAGS, ...JSON_FLAG, ...HELP_FLAGS } }),
    output: object(
      {
        ok: BOOLEAN,
        channel: { const: "telegram" },
        token_env: STRING,
        token_set: BOOLEAN,
        chat_env: STRING,
        chat_id: nullable(STRING),
      },
      ["ok", "channel", "token_env", "token_set", "chat_env", "chat_id"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, { code: 1, meaning: "a credential variable is unset" }, USAGE],
  },

  {
    name: "daemon",
    subcommand: "run",
    purpose:
      "The SPEC.md §10.2 watch loop, in the foreground: record envelope.drift where a task file's state contradicts the log, append approval.expired for lapsed requests, write the log's state back into the task files, regenerate QUEUE.md, and surface loop escalations. It holds no lock; backgrounding is the operator's business. Its --json output is one object per line.",
    human_only: true,
    human_only_note:
      "An OPERATOR process, not a human-authority verb. It is the runtime's intended sole writer while it runs, it is long-lived, and an agent starting one would be starting a background writer against the log nobody supervises. Marked human_only so no wrapper publishes it as a tool.",
    input: input({
      flags: {
        ...LOG_FLAG,
        "--tasks": "string",
        "--out": "string",
        ...POLICY_FLAGS,
        "--interval": "string",
        "--debounce": "string",
        "--read-proof": "string",
        "--full-reproof-every": "string",
        "--full-reproof-after": "string",
        "--once": "boolean",
        "--trace-watch": "boolean",
        "--git-evidence": "boolean",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "up",
    purpose:
      "THE AMBIENT RUNTIME (APRV-110): the `daemon run` watch loop plus every channel this policy configures, in ONE supervised foreground process. `daemon run --with-channels` is the same verb spelled from the other side. A channel whose credential variable is unset is NOT started; the refusal is reported in `approval doctor`'s vocabulary and the parts that can run do. A channel that falls over is restarted with a doubling backoff, re-deriving its pending queue from the verified log, and the daemon loop never dies with it. Credentials and the approver identity come from the environment this process was launched with and from nowhere else. Its --json output is one object per line: every DaemonEvent and every listener line verbatim, plus this verb's own supervision lines.",
    human_only: true,
    human_only_note:
      "Everything `daemon run` is marked human_only for, and one more. It is a long-lived operator process and the runtime's intended sole writer while it runs, so an agent starting one would be starting an unsupervised writer against the log. It also HOLDS THE CHANNEL CREDENTIAL and records every decision against the human identity in its launch environment, which is the authority `channel telegram listen` is withheld for. An agent that could start it could put prompts on a human's phone under an identity it did not authenticate.",
    input: input({
      flags: {
        ...LOG_FLAG,
        "--tasks": "string",
        "--out": "string",
        ...POLICY_FLAGS,
        "--interval": "string",
        "--debounce": "string",
        "--read-proof": "string",
        "--full-reproof-every": "string",
        "--full-reproof-after": "string",
        ...AS_FLAG,
        "--payloads": "string",
        "--payload-dir": "string",
        "--api-base": "string",
        "--poll-timeout": "string",
        "--port": "string",
        "--no-telegram": "boolean",
        "--no-web": "boolean",
        "--restart-backoff": "string",
        "--once": "boolean",
        "--trace-watch": "boolean",
        "--git-evidence": "boolean",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "payload",
    subcommand: "hash",
    purpose:
      "Print the payload_hash of a JSON document: SHA-256 over its RFC 8785 canonical serialization, the value a declaration carries and a grant binds to. Bytes that do not parse as JSON are a usage error rather than a hash. Reads no log, writes no file, appends nothing. Most flows never need it, because `request --payload` hashes, verifies and stores the bytes in one step.",
    human_only: false,
    input: input({
      positionals: positionals(
        [{ name: "file", description: 'the JSON document, or "-" to read stdin' }],
        1,
      ),
      flags: { ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object({ ok: { const: true }, hash: SHA256 }, ["ok", "hash"]),
    error: ERROR_SCHEMA,
    exit_codes: READ_ONLY_EXIT_CODES,
  },

  {
    name: "payload",
    subcommand: "agentmail-draft",
    purpose:
      "Snapshot one AgentMail draft as the payload a grant can bind to: read the draft with the AGENT's own key (AGENTMAIL_API_KEY, from the environment, and this is the only verb that reads it) and print the canonical {inbox_id, draft_id, to, cc?, bcc?, subject, text} JSON that `approval adapter agentmail` re-reads the draft against at send time. It exists so a human approves THE WORDS rather than the id of a mutable server-side object: a draft edited after the snapshot is refused, not sent. Reads no log, writes no file, spends no token, touches no vault and sends nothing.",
    human_only: false,
    human_only_note:
      "Agent-facing by construction: it is the composing agent's own key that reads its own draft, before any approval exists. The key it reads cannot send — the sending key is in the vault and answers only to a grant — so the verb produces a proposal and no authority.",
    input: input({
      positionals: positionals(
        [
          { name: "inbox-id", description: "the inbox holding the draft" },
          { name: "draft-id", description: "the draft to snapshot" },
        ],
        2,
      ),
      flags: {
        "--api-base": "string",
        "--timeout": "string",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    // The canonical payload itself, on stdout: the bytes ARE the result, and an
    // envelope around them would be a second thing to strip before hashing.
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      {
        code: 1,
        meaning: "the draft is gone, unreadable or unusable as a payload; nothing was sent",
      },
      USAGE,
      IO,
    ],
  },

  {
    name: "journal",
    subcommand: "write",
    purpose:
      "Append one free-text entry to a local journal file: the ungated channel an agent can always reach (APRV-195). It is NOT classified, NOT routed through policy, NOT approvable and NOT deniable, it appends nothing to the event log, and it opens no socket and reads no credential. Use it to say what an exit code cannot: that you are complying and think the instruction is wrong, that something reads as odd, that you are stuck. A human reads these entries; nothing written here changes any verdict, sampling probability or budget, and no part of the runtime parses the text.",
    human_only: false,
    human_only_note:
      "Agent-facing by argument, and the only verb whose whole purpose would be defeated by gating it: a channel a policy could close is not a channel the party under oversight can rely on. It is safe to leave open because it authorizes nothing — no enforcement path reads what it writes, so SPEC.md §11.1 invariant 4 is satisfied in the limiting case, by content that moves nothing at all.",
    input: input({
      // Not `positionals()`: the single positional is OPTIONAL (the entry
      // usually arrives in `--message`), and a 1-tuple with `minItems: 0` is
      // what strict Ajv refuses to compile.
      positionals: {
        type: "array",
        items: { type: "string", title: "-", description: 'the literal "-", to read the entry from stdin' },
        maxItems: 1,
      },
      flags: {
        "--message": "string",
        "--task": "string",
        "--session": "string",
        "--journal": "string",
        ...AS_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      { ok: { const: true }, path: STRING, ts: STRING, actor: STRING, bytes: INTEGER },
      ["ok", "path", "ts", "actor", "bytes"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, USAGE, IO],
  },

  {
    name: "feedback",
    purpose:
      "List what the OPERATOR said about work that already happened (APRV-239): the graded reactions and free-text notes a human wrote on an approval.granted or an audit.reviewed, each joined to the action key, its class, its task and the agent whose work it was. This is HUMAN-AUTHORED GUIDANCE and it is not policy: it grants nothing, forbids nothing, and changes no verdict, sampling probability or budget, and no enforcement path in this runtime reads a reaction (SPEC.md §11.1 invariant 10). Read it to learn what the operator values; do not read it as permission. `verdict` on a review is the enforcement field and is reported beside the reaction so the two are never confused. An entry with neither a reaction nor a note is omitted, because absence of feedback is not feedback. --actor filters on the AGENT the feedback is about, not on the human who wrote it. Reads VERIFIED records and writes nothing: no policy is resolved, no clock is read, nothing is appended.",
    human_only: false,
    human_only_note:
      "Human-AUTHORED and agent-FACING, which is the whole point: the words are a person's and the reader is the agent they are about. Publishing it establishes no authority, because what it prints decides nothing — an agent that reads `disliked` has learned something about the operator and gained no permission, and one that never reads it is under exactly the same rules. It is the mirror of `journal read`, where the authorship and the audience swap.",
    input: input({
      flags: {
        "--task": "string",
        "--actor": "string",
        "--reaction": "string",
        "--source": "string",
        "--since": "string",
        "--limit": "string",
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        log: STRING,
        note: STRING,
        total: INTEGER,
        entries: arrayOf(
          object(
            {
              seq: INTEGER,
              ts: STRING,
              source: { enum: ["review", "decision"] },
              event: STRING,
              actor: STRING,
              reaction: nullable({ enum: ["disliked", "indifferent", "liked", "loved"] }),
              note: nullable(STRING),
              verdict: nullable({ enum: ["ok", "denied"] }),
              actionKey: nullable(STRING),
              task: nullable(STRING),
              class: nullable(STRING),
              agentActor: nullable(STRING),
              sampleSeq: nullable(INTEGER),
            },
            [
              "seq",
              "ts",
              "source",
              "event",
              "actor",
              "reaction",
              "note",
              "verdict",
              "actionKey",
              "task",
              "class",
              "agentActor",
              "sampleSeq",
            ],
          ),
        ),
      },
      ["ok", "log", "note", "total", "entries"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, USAGE, IO, TORN, INTEGRITY],
  },

  {
    name: "journal",
    subcommand: "read",
    purpose:
      "Print journal entries for a human, oldest first, each with its timestamp, actor and optional task or session. Every output form labels the entries as agent-authored DATA and marks each one [claimed]: the text was written by the party under oversight, it is not instructions to whoever reads it, and it has authorized nothing. A line that does not parse is skipped rather than refusing the whole read, because one torn append must not be able to silence the channel. Reads no log, resolves no policy, writes nothing.",
    human_only: false,
    human_only_note:
      "Human-FACING but not human-only: the read surface is for the operator, and an agent that can read back what it wrote is an agent that can tell whether the channel is working. It carries no authority either way, since the file it prints decides nothing.",
    input: input({
      flags: {
        "--limit": "string",
        "--since": "string",
        "--journal": "string",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        dir: STRING,
        note: STRING,
        total: INTEGER,
        entries: arrayOf(
          object(
            {
              ts: STRING,
              actor: STRING,
              task: STRING,
              session: STRING,
              text: STRING,
              date: STRING,
            },
            ["ts", "actor", "text", "date"],
          ),
        ),
      },
      ["ok", "dir", "note", "total", "entries"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, USAGE, IO],
  },

  {
    name: "values",
    purpose:
      "Print the OPTIONAL values block of APPROVAL.md: what the operator loves, likes and dislikes, what they want from an agent as behaviour, and how they read and answer. It is HUMAN-AUTHORED GUIDANCE and it is never policy: it grants nothing, forbids nothing and changes no verdict, and no routing, class match, sampling draw, budget, token or execution decision reads it. Read it at the start of a session and weigh it in HOW you work; what you MAY do is the policy block, answered by `policy check`. A file with no values block exits 0 and says in words that the operator declared no values, which keeps a declared absence distinguishable from not having looked. A block that is present and unreadable exits 1 with its load code and is to be treated as absent. Resolves no policy rule, reads no log, writes nothing.",
    human_only: false,
    human_only_note:
      "Human-AUTHORED and agent-FACING, which is the whole point: the block is the operator writing to the agent, so a surface that withheld it from agents would leave the words with no reader. It carries no authority in either direction. Nothing in it can widen what an agent may do, because no enforcement path reads it (SPEC.md §11.1 invariant 10), and an agent cannot write it: the block lives inside APPROVAL.md, which is `policy.core` and rides the whole-file attestation.",
    input: input({
      flags: { ...POLICY_FLAGS, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        path: STRING,
        present: BOOLEAN,
        note: STRING,
        values: nullable(OPEN_OBJECT),
      },
      ["ok", "path", "present", "note", "values"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      {
        code: 1,
        meaning:
          "a values block is present and could not be read; nothing about the policy changed, and the block grants nothing either way",
      },
      USAGE,
      { code: 4, meaning: "a policy path that exists but cannot be read" },
    ],
  },

  {
    name: "env",
    purpose:
      "Resolve .approval/env — the environment SOURCE MAP — and print an export block for a shell to evaluate. THE ONLY VERB THAT READS THAT FILE, and its default output CARRIES SECRETS by design. `env --check` prints a value-free table instead and exits 1 when a variable the policy named is unresolved.",
    human_only: true,
    human_only_note:
      "Its default output puts credential values on stdout for a human to eval into their own shell. That is the whole point of the verb (SPEC.md §11.1 invariant 7: no verb loads that file implicitly), and it is exactly why an agent must not be handed it as a tool.",
    input: input({
      flags: { "--check": "boolean", ...POLICY_FLAGS, ...LOG_FLAG, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: BOOLEAN,
        path: STRING,
        present: BOOLEAN,
        variables: arrayOf(
          object(
            {
              name: STRING,
              status: STRING,
              source: STRING,
              plaintext: BOOLEAN,
              declared: BOOLEAN,
              value: STRING,
              fix: STRING,
              refusal: OPEN_OBJECT,
            },
            ["name", "status", "source", "plaintext", "declared"],
          ),
        ),
      },
      ["ok", "path", "present", "variables"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [OK, { code: 1, meaning: "the file was refused, or --check found an unresolved variable" }, USAGE, IO],
  },

  {
    name: "setup",
    subcommand: "identity",
    purpose:
      "Declare who the human is (APPROVAL_HUMAN) and record it in .approval/env. INTERACTIVE ONLY: it refuses a non-terminal stdin and --json, printing the export line to use instead. The line it writes is inert until a human evaluates `approval env`.",
    human_only: true,
    input: input({ flags: { ...LOG_FLAG, ...POLICY_FLAGS, ...HELP_FLAGS } }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "setup",
    subcommand: "vault",
    purpose:
      "Mint the vault passphrase, store it in the OS keystore, and record where it lives. INTERACTIVE ONLY. It warns first when a vault already exists, because a vault cannot be re-keyed by changing a variable.",
    human_only: true,
    input: input({ flags: { ...AS_FLAG, ...LOG_FLAG, ...POLICY_FLAGS, ...HELP_FLAGS } }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "setup",
    subcommand: "sampling",
    purpose:
      "Mint the operator-held audit sampling secret of SPEC.md §5.2, store it, and print the policy line that turns sampling on. It does not edit an attested policy: it prints the `approval policy amend` ceremony instead. INTERACTIVE ONLY.",
    human_only: true,
    input: input({ flags: { ...AS_FLAG, ...LOG_FLAG, ...POLICY_FLAGS, ...HELP_FLAGS } }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "setup",
    subcommand: "checkpoint",
    purpose:
      "Mint the Ed25519 keypair a human signs the log's head with (APRV-220). The PRIVATE half goes into the vault under approval.checkpoint.key and is never printed; the PUBLIC half is printed with the exact audit.checkpoint_keys block to paste. It does not edit an attested policy, so the key is INERT until a human adds that block and re-attests. --rotate mints a new key and ADDS it to the list; --retire prints the block that drops one, and REFUSES any key that signed a checkpoint, naming the seqs that would stop verifying. INTERACTIVE ONLY.",
    human_only: true,
    human_only_note:
      "It mints the key that makes a checkpoint mean anything. An agent that could run it could mint a key, store it, and then vouch for a chain it had just written, so the verb classifies policy.core and the Claude Code hook denies it before a process starts — behind the terminal check and the --as gate this family already carries.",
    input: input({
      flags: {
        "--rotate": "boolean",
        "--retire": "string",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "setup",
    subcommand: "channel",
    purpose:
      "Configure one CHANNEL's transport credential: for telegram, collect the bot token, prove it with getMe, discover the approver chat, and record both variable sources. A channel holds no state, so what it needs goes to the OS keystore and .approval/env — never the vault. INTERACTIVE ONLY.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "name", description: "the channel name, e.g. telegram" }], 1),
      flags: { ...AS_FLAG, "--api-base": "string", ...LOG_FLAG, ...POLICY_FLAGS, ...HELP_FLAGS },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "setup",
    subcommand: "adapter",
    purpose:
      "Fill the VAULT with one adapter's credentials, asked for from the manifest that adapter declares, validated by the adapter's own rules, and proved against the service without sending anything. An adapter holds the credentials a side effect spends, so its setup fills .approval/vault.enc. INTERACTIVE ONLY.",
    human_only: true,
    input: input({
      positionals: positionals(
        [{ name: "name", description: "the adapter name: email or agentmail" }],
        1,
      ),
      flags: { ...AS_FLAG, ...LOG_FLAG, ...POLICY_FLAGS, ...HELP_FLAGS },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "setup",
    subcommand: "service",
    purpose:
      "Write the launchd user agent (macOS) or systemd user unit (Linux) that runs `approval up` at login. It PRINTS THE WHOLE UNIT for the operator to read before anything is written, and writes only on confirmation. IT NAMES VARIABLES AND NEVER COPIES A VALUE: the unit either evaluates `approval env` in a wrapper the human reads, or reads an EnvironmentFile the human authored and this verb never opens. It does NOT load the service, printing the one arming command instead. Console output goes where the operator chooses and a path inside .approval/ is refused. --uninstall prints the stop command and removes the file. INTERACTIVE ONLY. Appends nothing to the log.",
    human_only: true,
    human_only_note:
      "It installs a STANDING CAPABILITY on someone's machine: a process that starts at login, holds a channel credential, and can put approval prompts in front of a human. That is the one thing in this repo an agent must never arrange for itself, and the interactive refusal is the enforcement.",
    input: input({
      flags: {
        "--platform": "string",
        "--label": "string",
        "--logs": "string",
        "--env-file": "string",
        "--exec": "string",
        "--out": "string",
        "--uninstall": "boolean",
        ...AS_FLAG,
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "vault",
    subcommand: "set",
    purpose:
      "Store one credential in the encrypted vault, with the value read from stdin or from a variable named by --value-env. THE VALUE IS NEVER A COMMAND-LINE ARGUMENT. Appends nothing to the log: a credential's existence is configuration, not an authorized action.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "name", description: "the credential name" }], 1),
      flags: {
        "--value-env": "string",
        "--vault": "string",
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        ...AS_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      { ok: { const: true }, name: STRING, created: BOOLEAN, count: INTEGER, path: STRING },
      ["ok", "name", "created", "count", "path"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "vault",
    subcommand: "list",
    purpose:
      "Print the credential NAMES the vault holds, sorted, with a count and the file path. No value is printed on any path, and there is deliberately no `vault get`. A vault nobody created is a state and not a fault: it reports absent and exits 0.",
    human_only: true,
    human_only_note:
      "Names are not values, but the name set is a map of the machine's reach, and all three vault verbs resolve identity exactly as `policy attest` does. Keeping the noun human-only is what stops an agent's tooling from touching the credential store in passing.",
    input: input({
      flags: {
        "--vault": "string",
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        ...AS_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        present: BOOLEAN,
        path: STRING,
        count: INTEGER,
        names: arrayOf(STRING),
      },
      ["ok", "present", "path", "count", "names"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "vault",
    subcommand: "remove",
    purpose:
      "Delete one credential by name. A name the vault does not hold refuses credential-absent rather than reporting success, because an operator removing a credential wants to know they removed the one they meant.",
    human_only: true,
    input: input({
      positionals: positionals([{ name: "name", description: "the credential name" }], 1),
      flags: {
        "--vault": "string",
        ...LOG_FLAG,
        ...POLICY_FLAGS,
        ...AS_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object({ ok: { const: true }, name: STRING, count: INTEGER, path: STRING }, [
      "ok",
      "name",
      "count",
      "path",
    ]),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "adapter",
    subcommand: "email",
    purpose:
      "Execute one approved action through the email adapter: send a single RFC 5322 message over SMTP for a communicate.email.external action. The runtime — not the adapter — recomputes the payload hash, spends the token, and writes both execution events around the send, and the credentials leave the vault only inside that verified-token window. This is the hard boundary of SPEC.md §10.4.",
    human_only: false,
    human_only_note:
      "Agent-facing on purpose. It executes inside the token window with a token a human granted for these exact bytes, which is the authority an executing agent is meant to hold; the adapter refuses everything else. Making it human-only would move the send back to a human and leave the token doing nothing.",
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--token": "string",
        "--payload": "string",
        ...AS_FLAG,
        "--vault": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        "--timeout": "string",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        adapter: { const: "email" },
        action_key: STRING,
        task: STRING,
        class: STRING,
        autonomy: STRING,
        payload_hash: SHA256,
        started_seq: INTEGER,
        outcome: { enum: ["execution.completed", "execution.failed"] },
        outcome_seq: INTEGER,
        exit_code: nullable(INTEGER),
        detail: OPEN_OBJECT,
        redactions: INTEGER,
      },
      [
        "ok",
        "adapter",
        "action_key",
        "task",
        "class",
        "autonomy",
        "payload_hash",
        "started_seq",
        "outcome",
        "outcome_seq",
        "exit_code",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      INTEGRITY,
      USAGE,
      TORN,
      IO,
      { code: 5, meaning: "no valid execution token; nothing was appended and nothing was sent" },
    ],
  },

  {
    name: "adapter",
    subcommand: "agentmail",
    purpose:
      "Execute one approved action through the AgentMail adapter: a direct send over the AgentMail API, or the send of a draft the agent already composed. The draft mode re-reads the draft and refuses `agentmail-draft-drifted` when any approved field changed, because a grant is over a snapshot of the words and not over a mutable draft id. AgentMail has no per-message From — the inbox is the sender — so the approved `from` is checked against the inbox's own address before anything is sent. The runtime, not the adapter, recomputes the payload hash, spends the token and writes both execution events, and the vault's sending key leaves it only inside that window.",
    human_only: false,
    human_only_note:
      "Agent-facing for the reason `adapter email` is: it executes inside the token window with a token a human granted for these exact bytes. The split that makes it safe is in the keys, not in the caller — the agent's own AgentMail key cannot send, and the one that can lives in the vault.",
    input: input({
      positionals: positionals([{ name: "action-key", description: "the action's idempotency_key" }], 1),
      flags: {
        "--token": "string",
        "--payload": "string",
        ...AS_FLAG,
        "--vault": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        "--timeout": "string",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      {
        ok: { const: true },
        adapter: { const: "agentmail" },
        action_key: STRING,
        task: STRING,
        class: STRING,
        autonomy: STRING,
        payload_hash: SHA256,
        started_seq: INTEGER,
        outcome: { enum: ["execution.completed", "execution.failed"] },
        outcome_seq: INTEGER,
        exit_code: nullable(INTEGER),
        detail: OPEN_OBJECT,
        redactions: INTEGER,
      },
      [
        "ok",
        "adapter",
        "action_key",
        "task",
        "class",
        "autonomy",
        "payload_hash",
        "started_seq",
        "outcome",
        "outcome_seq",
        "exit_code",
      ],
    ),
    error: ERROR_SCHEMA,
    exit_codes: [
      OK,
      INTEGRITY,
      USAGE,
      TORN,
      IO,
      { code: 5, meaning: "no valid execution token; nothing was appended and nothing was sent" },
    ],
  },

  {
    name: "hook",
    subcommand: "claude-code",
    purpose:
      "Put the gate in front of an agent harness: read one Claude Code PreToolUse event on stdin, classify the command, resolve the class against APPROVAL.md, and answer allow or deny on stdout — waiting on a real decision when the class is manual. THE VERDICT IS NEVER 'ask': a decision taken outside the log is a decision nothing can audit. Exit 0 carries the verdict, and exit 2 means the hook itself is misconfigured.",
    human_only: false,
    human_only_note:
      "The agent harness surface, so agent-facing by construction: the harness invokes it around the agent's own tool calls. It records the agent's proposal and waits for a human; it never records a decision.",
    input: input({
      flags: {
        ...AS_FLAG,
        "--timeout": "string",
        "--interval": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "the verdict (allow OR deny) is the JSON object on stdout" },
      { code: 2, meaning: "the hook is misconfigured; the harness blocks and reads stderr" },
    ],
  },

  {
    name: "hook",
    subcommand: "cursor",
    purpose:
      "Put the gate in front of a local Cursor Agent: read one native preToolUse event on stdin, classify Shell commands and Write/Delete paths, resolve the class against APPROVAL.md, and answer native {permission: allow|deny} JSON on stdout — waiting on a real decision when the class is manual. THE VERDICT IS NEVER 'ask'. Exit 0 carries the verdict, and exit 2 means the hook itself is misconfigured.",
    human_only: false,
    human_only_note:
      "The agent harness surface, so agent-facing by construction: the harness invokes it around the agent's own tool calls. It records the agent's proposal and waits for a human; it never records a decision.",
    input: input({
      flags: {
        ...AS_FLAG,
        "--timeout": "string",
        "--interval": "string",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "the verdict (allow OR deny) is the JSON object on stdout" },
      { code: 2, meaning: "the hook is misconfigured; the harness blocks and reads stderr" },
    ],
  },

  {
    name: "hook",
    subcommand: "classify",
    purpose:
      "Print what the classifier makes of a command line: the segments it split it into, the class it assigned each, and the rule that decided. Reads no log, resolves no policy, writes nothing. The classifier is best effort and is not scheming-robust; it reads the command text and never the agent's own description of it.",
    human_only: false,
    input: input({ flags: { ...JSON_FLAG, ...HELP_FLAGS }, trailing: TRAILING }),
    output: object(
      {
        ok: BOOLEAN,
        segments: arrayOf(
          object({ text: STRING, class: nullable(STRING), rule: nullable(STRING) }, ["text"]),
        ),
        classes: arrayOf(STRING),
      },
      ["ok", "segments", "classes"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: READ_ONLY_EXIT_CODES,
  },

  {
    name: "import",
    subcommand: "agents-md",
    purpose:
      "Parse an AGENTS.md-style permissions section into DRAFT policy classes for a human to confirm (SPEC.md §12), by a fixed ordered keyword table with no model in the loop. THE DRAFT AUTHORIZES NOTHING: it never writes APPROVAL.md, never appends, never attests. A bullet the table cannot place is preserved verbatim and covered by defaults.autonomy.",
    human_only: false,
    input: input({
      positionals: positionals([{ name: "file", description: "the markdown file to parse" }], 1),
      flags: { "--out": "string", ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        source: STRING,
        out: nullable(STRING),
        classes: arrayOf(
          object({ class: STRING, autonomy: STRING, from: STRING, section: STRING }, [
            "class",
            "autonomy",
            "from",
            "section",
          ]),
        ),
        unmapped: arrayOf(object({ text: STRING, section: STRING }, ["text", "section"])),
        ignored: arrayOf(STRING),
        warnings: arrayOf(STRING),
        // APRV-240: the fenced DRAFT values block, or null when the source
        // named none of the four values headings. Null is a declaration and
        // not a gap; the verb never drafts a values block nobody asked for.
        values_draft: nullable(STRING),
      },
      ["ok", "source", "out", "classes", "unmapped", "ignored", "warnings", "values_draft"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "mcp",
    subcommand: "serve",
    purpose:
      "Serve the verbs of this registry as MCP tools, in the foreground, sharing the CLI's code paths (SPEC.md §10.5). Over stdio by default; `--http` serves the streamable-HTTP transport instead, one MCP session per connection, binding 127.0.0.1 unless `--listen` names another interface in full. The published tool list is this registry filtered by human_only false, less `consume` (internal plumbing) and `hook claude-code` / `hook cursor` (each reads a stdin this transport owns), and every tool's input schema is the verb's own with `--as` removed. Identity is the SERVER's under both transports and no tool call can supply or change it: one fixed agent identity by default, or, under `--http --guest`, one `agent:guest-<id>` minted per session before that session's transport exists.",
    human_only: true,
    human_only_note:
      "An OPERATOR process, like `daemon run`: long-lived, launched by a person, and holding the agent identity every tool call is recorded under. It publishes no human-only verb, so an agent that could start one would gain no authority it lacked; what it would gain is a second writer against the log nobody supervises, and a choice of identity that belongs to the human who launched the process. Marked human_only so no wrapper offers a wrapper.",
    input: input({
      flags: {
        ...AS_FLAG,
        "--http": "boolean",
        "--port": "string",
        "--listen": "string",
        "--guest": "boolean",
        ...POLICY_FLAGS,
        ...LOG_FLAG,
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: null,
    error: ERROR_SCHEMA,
    exit_codes: [
      { code: 0, meaning: "the server was interrupted and closed cleanly" },
      USAGE,
      { code: 4, meaning: "the transport did not close cleanly" },
    ],
  },

  {
    name: "reindex",
    purpose:
      "Rebuild the SQLite index projection from the log. The database is a cache and the log is the truth: the index is rebuilt from scratch at a temporary path and renamed into place. A corrupt log is refused outright and a torn tail is refused without --force. The log is never written to.",
    human_only: false,
    input: input({
      flags: {
        ...LOG_FLAG,
        "--index": "string",
        "--force": "boolean",
        ...JSON_FLAG,
        ...HELP_FLAGS,
      },
    }),
    output: object(
      { ok: { const: true }, records: INTEGER, head: HEAD, truncated: BOOLEAN },
      ["ok", "records", "head", "truncated"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },

  {
    name: "render",
    purpose:
      "Regenerate .approval/QUEUE.md, the read-only markdown queue projection of SPEC.md §9.1, whole, from the verified log. This is the screenshot and never the truth: editing the file authorizes nothing and the next render overwrites it. Writes exactly one file, atomically; a log that does not verify refuses and writes nothing.",
    human_only: false,
    input: input({
      flags: { ...LOG_FLAG, "--out": "string", ...POLICY_FLAGS, ...JSON_FLAG, ...HELP_FLAGS },
    }),
    output: object(
      {
        ok: { const: true },
        out: STRING,
        bytes: INTEGER,
        head: HEAD,
        pending: INTEGER,
        skipped: INTEGER,
        audit_backlog: INTEGER,
        now: STRING,
      },
      ["ok", "out", "bytes", "head", "pending", "skipped", "audit_backlog", "now"],
    ),
    error: ERROR_SCHEMA,
    exit_codes: BASE_EXIT_CODES,
  },
];

/** The registry. Order is the order the verb table prints in. */
export const VERB_REGISTRY: readonly VerbSpec[] = VERBS;

/** `<name>` or `<name> <subcommand>` — how a verb is written on a command line. */
export function verbLabel(spec: VerbSpec): string {
  return spec.subcommand === undefined ? spec.name : `${spec.name} ${spec.subcommand}`;
}
