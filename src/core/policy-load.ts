/**
 * Policy loading: find `APPROVAL.md`, extract its single
 * ` ```yaml approval-policy ` fenced block, parse it, validate it, and resolve
 * its duration strings to milliseconds.
 *
 * SPEC.md §5: the policy file is "prose for humans plus exactly one fenced
 * block for machines". Implementations MUST parse the fenced block, MUST
 * ignore surrounding prose, and MUST accept `APPROVALS.md` as a fallback
 * filename with `APPROVAL.md` winning when both exist.
 *
 * ## Fail-closed contract (SPEC.md §5.2)
 *
 * Every failure mode of this module returns `{ ok: false, code, message }` —
 * nothing throws, and nothing returns a partially-understood policy. A not-ok
 * result places a hard obligation on the consumer (the APRV-11 class matcher
 * and everything downstream of it): **treat every class as `manual`.** There
 * is no "load what we could" path, because a policy the runtime only half
 * understood is a policy whose author believes constraints are in force that
 * are not. A missing file is not permission to run unattended; it is the
 * absence of any grant, which is `manual` for everything.
 *
 * ## YAML version stance
 *
 * The `yaml` package parses **YAML 1.2** by default and this module keeps that
 * default, additionally pinning `schema: "core"` — the YAML 1.2 core schema.
 * Consequences that matter for a policy file:
 *
 * - YAML 1.1-isms are **not** honored. `yes`, `no`, `on`, `off`, `y`, `n` parse
 *   as the plain strings `"yes"`, `"no"`, … and **not** as booleans; sexagesimal
 *   (`1:30`) is a string, not a number. This is deliberate. A policy file is a
 *   permission document: the difference between the string `"no"` and the
 *   boolean `false` must never depend on which YAML dialect an implementation
 *   happens to ship. Under YAML 1.2 core, only `true`/`false` are booleans, so
 *   a policy that writes `autonomy: no` yields the string `"no"`, fails the
 *   closed `autonomy` enum in `policy.schema.json`, and the whole policy fails
 *   closed to all-`manual` — a loud rejection instead of a silent coercion.
 * - No custom or implicit-typed tags are accepted. Any node carrying an
 *   explicit tag (`!!timestamp`, `!!binary`, `!Anything`) is rejected as
 *   `yaml-error`, so a policy value can only ever be a string, number, boolean,
 *   null, map, or sequence. Tag-driven type coercion (and any tag-driven
 *   construction in a future `yaml` release) can therefore never reach the
 *   schema validator.
 * - Anchors and aliases are permitted but bounded: {@link MAX_ALIAS_COUNT}
 *   caps alias expansion so a billion-laughs document fails closed as
 *   `yaml-error` instead of exhausting memory.
 * - Duplicate mapping keys are parse errors (the `yaml` default), not
 *   last-one-wins.
 *
 * Any parser error **or warning** fails the load closed. Warnings in `yaml`
 * flag constructs the parser recovered from (unsupported directives, deprecated
 * syntax); "recovered from" is exactly the silent reinterpretation a policy
 * file must not tolerate.
 *
 * ## Determinism
 *
 * `loadPolicy` is a pure function of the file bytes on disk plus the schema
 * directory. No clock, no network, no randomness, no cross-call caching.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { isNode, parseDocument, visit } from "yaml";

import { scanFences, type FenceScan } from "./md-fence.js";
import { promptBlockErrors } from "./prompt-layout.js";
import { validate, type ValidationError } from "./validate.js";

/**
 * Upper bound on alias expansions in one policy document.
 *
 * Anchors are legitimate in a hand-written policy (sharing an approver list
 * across a few class rules), so aliases are not banned outright — but alias
 * expansion is exponential in the number of nesting levels, which is the
 * "billion laughs" resource-exhaustion attack. 32 is far above what any
 * plausible hand-written APPROVAL.md needs and far below anything that costs
 * measurable memory. Exceeding it is a hard `yaml-error`.
 */
export const MAX_ALIAS_COUNT = 32;

/** Info string that marks the machine-readable policy block (SPEC.md §5). */
export const POLICY_INFO_STRING = "yaml approval-policy";

/** Policy filenames, in precedence order (SPEC.md §5). */
export const POLICY_FILENAMES = ["APPROVAL.md", "APPROVALS.md"] as const;

/** Duration grammar from SPEC.md §5.2: `<positive integer><unit>`. */
const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m|h|d|w)$/;

const MS_PER_UNIT: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * SPEC.md §5.2 autonomy levels, strictest first — the RESOLVED vocabulary.
 *
 * Deliberately unchanged by APRV-127. The autonomy split is a split of
 * *supervision*, not of autonomy: both supervised modes execute under
 * supervision, both are metered by the same budgets, and both are eligible for
 * the same retrospective review. Every consumer that asks "is this action
 * supervised?" keeps asking one question and getting one answer, and the mode
 * travels beside it as {@link SupervisionMode}. Widening this union instead
 * would have put a third case into every `switch` in the runtime, and a
 * `switch` that forgot it would have failed open.
 *
 * WIDENED by APRV-183's successor, APRV-185, and widened for the opposite
 * reason. `human-only` is not a supervision mode and cannot travel beside
 * anything: it says the action is reserved to human hands and is performed
 * outside agent execution entirely, so there is no gate path, no token, and no
 * record for an agent to produce. A member of this union is exactly what that
 * needs to be, because the failure mode the note above worries about runs the
 * other way here: a `switch` that forgets `human-only` reaches no allow, since
 * every enforcement path in this runtime opens by refusing it and the remaining
 * branches are all keyed to `manual`, `supervised` or `autonomous` by equality.
 */
export type Autonomy = "human-only" | "manual" | "supervised" | "autonomous";

/**
 * Amended SPEC.md §5.2 (APRV-127): how far a supervised class is supervised.
 *
 * - `live`: a declared fraction of the class's actions BLOCK on the human gate
 *   before executing, exactly as `manual` does. The rest proceed.
 * - `retro`: the pre-split behaviour. Every action proceeds immediately and a
 *   fraction is drawn afterwards into a human's review backlog.
 */
export type SupervisionMode = "live" | "retro";

/** What a class rule may WRITE. See {@link Autonomy} for what it resolves to. */
export type DeclaredAutonomy = Autonomy | "supervised-live" | "supervised-retro";

/**
 * What `defaults.autonomy` may write: {@link DeclaredAutonomy} less
 * `supervised-live`, which is meaningless without a `live_rate` and has nowhere
 * on `defaults` to declare one. Enforced by `policy.schema.json`.
 *
 * `human-only` IS admitted here (APRV-185), and the asymmetry with
 * `supervised-live` is the whole of the reason: `supervised-live` is excluded
 * because it carries a required rate `defaults` cannot hold, and `human-only`
 * carries nothing at all. An author who writes it as the default is declaring
 * maximal strictness for everything the policy did not name, which is a
 * statement a policy is entitled to make.
 *
 * What it is NOT is the fail-closed target. A policy that cannot be parsed
 * still resolves every class to `manual` (see `policy-match.ts`), because a
 * broken policy must stay recoverable through its own gate: an unparseable file
 * whose classes all became `human-only` would leave no gated path to the fix,
 * and the repair for a typo would sit behind a level that admits no repair.
 */
export type DefaultAutonomy = Exclude<DeclaredAutonomy, "supervised-live">;

/**
 * Amended SPEC.md §10.4 (APRV-105): how the raw execution token travels from the
 * mint site to the spend site.
 *
 * - `manual` — printed once on the granting surface and carried by a human.
 *   THE DEFAULT, and what an absent key means.
 * - `sealed` — additionally sealed to the requester's ephemeral public key and
 *   recorded as ciphertext, so `approval wait` can return it to the process
 *   that asked, across machines.
 */
export type TokenDelivery = "manual" | "sealed";

/** The delivery mode in force. Fail-closed: anything unusable is `manual`. */
export function tokenDeliveryOf(load: PolicyLoadResult): TokenDelivery {
  if (!load.ok) return "manual";
  return load.policy.defaults?.token_delivery === "sealed" ? "sealed" : "manual";
}

/** A class rule (SPEC.md §5.1); shape mirrors `policy.schema.json`. */
export interface PolicyClassRule {
  autonomy: DeclaredAutonomy;
  /**
   * Amended SPEC.md §5.2 (APRV-127): the fraction of `supervised-live` actions
   * that block on the human gate, in (0, 1]. Required by the schema for
   * `supervised-live` and forbidden for every other level, `human-only`
   * included (APRV-185): a level whose actions no agent may take has no
   * fraction of them to gate.
   */
  live_rate?: number;
  /**
   * Amended SPEC.md §5.2 (APRV-183): the fraction of this class's executed
   * actions drawn into the retrospective review backlog, in (0, 1]. Optional on
   * every supervised level (`supervised`, `supervised-retro`, `supervised-live`)
   * and a schema violation on `manual`, `autonomous` and `human-only`, none of
   * which has a retrospective pool. Absent means the class is sampled at
   * `audit.supervised_sample_rate`.
   */
  retro_rate?: number;
  approvers?: string[];
  limits?: Record<string, number>;
}

/**
 * A load-time observation about a policy that PARSED and VALIDATED.
 *
 * Not an error, and never a refusal: a policy carrying notes is fully in force.
 * The notes exist because APRV-127 gave an existing spelling a new name, and a
 * reinterpretation nobody is told about is the failure mode this project exists
 * to prevent. `approval policy check` and `doctor` print them; nothing branches
 * on them.
 */
export interface PolicyNote {
  /** Machine-readable and closed, so a reader can branch without regex. */
  code: "supervised-alias";
  /** Where the note applies: a class pattern, or `defaults.autonomy`. */
  where: string;
  message: string;
}

/** Parsed policy document. Structurally guaranteed by `policy.schema.json`. */
export interface Policy {
  version: string;
  defaults?: {
    autonomy?: DefaultAutonomy;
    channel?: string;
    approval_ttl?: string;
    /**
     * Amended SPEC.md §10.4 (APRV-105): how the raw execution token reaches the
     * process that will spend it. Absent means `manual`, and under `manual`
     * nothing about the pre-APRV-105 behaviour changes byte for byte.
     */
    token_delivery?: TokenDelivery;
    on_expiry?: "reject";
  };
  /**
   * Amended SPEC.md §5.2 (APRV-38): duration after which a payload whose action
   * reached a terminal state MAY be pruned from `.approval/payloads/`. Absent
   * means retain indefinitely. Read by the M5 daemon; nothing else prunes.
   */
  payload_retention?: string;
  /**
   * Amended SPEC.md §5.2 (APRV-107): repo-relative paths whose edit is
   * `policy.edit` in addition to the runtime's built-in set. Exact file paths
   * (`SPEC.md`) and directory prefixes ending in `/` (`design/`); no globs, no
   * negation. Purely ADDITIVE: the built-ins stay protected whatever this
   * list says, so a policy can widen the protected surface and never narrow
   * it.
   */
  protected_paths?: string[];
  approvers?: Record<string, { channels: string[] }>;
  classes?: Record<string, PolicyClassRule>;
  /**
   * Named budget scopes (SPEC.md §5.1/§5.2). `max_pending` has been in
   * `policy.schema.json` since v0.1 and was missing from this type until
   * APRV-173, which is what a key nobody read looks like from the inside: the
   * schema accepted it, the loader carried it, and no reader could see it.
   * `core/intake-limits.ts` evaluates it at intake; `core/budgets.ts` skips it.
   */
  budgets?: Record<
    string,
    { daily_usd?: number; daily_actions?: number; max_pending?: number }
  >;
  audit?: {
    supervised_sample_rate?: number;
    /**
     * Amended SPEC.md §5.2 (APRV-38): NAME of the environment variable holding
     * the operator's HMAC sampling secret. The name is what a policy carries;
     * the secret lives outside the repository and outside any agent-readable
     * path, because an agent that can read it can predict the sample.
     */
    sampling_secret_env?: string;
    /**
     * Amended SPEC.md §8 (APRV-58): how far a gate-typed `ts` may step backwards
     * from its gate-typed predecessor before `core/verify.ts` reports a
     * `gate-ts-regression`. Absent means the reference runtime's 2 seconds.
     * Report-only in every direction: it decides what a human is shown about a
     * log that already verified, and no verdict reads it.
     */
    skew_tolerance?: string;
    /**
     * Amended SPEC.md §9 (APRV-220): the PUBLIC halves of the keys permitted to
     * sign a `log.checkpoint`, base64 DER SPKI. The one key-shaped field in
     * this file holding material rather than the NAME of a variable, because a
     * public key is not a secret and the value of writing it here is that this
     * file is committed and attested.
     */
    checkpoint_keys?: string[];
    /**
     * Amended SPEC.md §9 (APRV-220): how long a log may go without a signed
     * checkpoint before verification says one is due. Report-only in every
     * direction; there is no path from due to refused.
     */
    checkpoint_every?: string;
  };
  /**
   * Amended SPEC.md §5.2 (APRV-217): how the long-lived readers of this log
   * prove a cached prefix. Latency only, and its strictest value is the
   * default, so an absent block is the behaviour that existed before it.
   */
  daemon?: {
    read_proof?: "full" | "incremental";
    full_reproof_every?: number;
    full_reproof_after?: string;
  };
  channels?: Record<string, Record<string, unknown>>;
  /**
   * Amended SPEC.md §5.2 (APRV-68): the credential vault's configuration. One
   * key, and it is a NAME: `passphrase_env` holds the name of the environment
   * variable the operator keeps the vault passphrase in, exactly as
   * `channels.telegram.token_env` and `audit.sampling_secret_env` do. A policy
   * that carried the passphrase itself would be a passphrase in a file agents
   * may read, which is the thing the vault exists to prevent.
   */
  vault?: {
    passphrase_env?: string;
  };
}

/**
 * Duration-valued policy fields pre-resolved to milliseconds, so callers never
 * re-parse a duration string (and so no two call sites can disagree about what
 * `24h` means). `null` means the field was absent from the policy.
 */
export interface PolicyDurations {
  /** `defaults.approval_ttl` in milliseconds, or `null` when unset. */
  approvalTtlMs: number | null;
  /**
   * `audit.skew_tolerance` in milliseconds, or `null` when unset (APRV-58).
   * `null` means the verifier's own default, never "no tolerance": a zero
   * allowance would report every healthy fleet's ordinary clock disagreement.
   */
  skewToleranceMs: number | null;
  /**
   * `audit.checkpoint_every` in milliseconds, or `null` when unset (APRV-220).
   * `null` means the cadence is off: nothing is ever reported as due, which is
   * the behaviour of every policy written before the key existed.
   */
  checkpointEveryMs: number | null;
}

/**
 * The `daemon` block resolved, with the reference runtime's defaults applied
 * (APRV-217), so no reader re-derives them and no two readers disagree.
 *
 * Every default is the strict end: `full` proves the whole prefix on every
 * read, which is what the runtime did before this block existed. The counts are
 * meaningful only under `incremental`.
 */
export interface PolicyDaemonRead {
  readProof: "full" | "incremental";
  /** Reads one full re-proof may cover, the anchoring read included. */
  fullReproofEvery: number;
  /** Wall-clock milliseconds one full re-proof may cover. */
  fullReproofAfterMs: number;
  /**
   * Whether the policy declared a `daemon` block at all. Display only — the
   * three fields above are complete either way — and read by `approval doctor`,
   * which skips its row rather than reporting a mode nobody wrote.
   */
  declared: boolean;
}

/** The defaults a policy that declares no `daemon` block is read under. */
export const DEFAULT_POLICY_DAEMON_READ: PolicyDaemonRead = Object.freeze({
  readProof: "full",
  fullReproofEvery: 50,
  fullReproofAfterMs: 60_000,
  declared: false,
});

/** Where the loaded policy came from. */
export interface PolicySource {
  /** Absolute or caller-relative path actually read. */
  path: string;
  /** Basename of that path, e.g. `APPROVAL.md`. */
  filename: string;
}

/** Discrete fail-closed reasons. Every one means "treat all classes manual". */
export type PolicyLoadErrorCode =
  | "file-missing"
  | "no-block"
  | "multiple-blocks"
  | "yaml-error"
  | "schema-invalid";

/**
 * Result of {@link loadPolicy}.
 *
 * Fail-closed contract: when `ok` is `false` the consumer MUST NOT fall back to
 * any permissive default. Per SPEC.md §5.2 an unparseable, unfindable, or
 * schema-invalid policy means **every class is `manual`** — the `code` is for
 * diagnostics and operator messaging only, never for choosing a softer path.
 */
export type PolicyLoadResult =
  | {
      ok: true;
      policy: Policy;
      source: PolicySource;
      durations: PolicyDurations;
      /**
       * The `daemon` block resolved (APRV-217), defaults applied. Present for
       * every loaded policy, declared or not, for the reason `durations` is:
       * one parse of the grammar, one number every reader shares.
       */
      daemon: PolicyDaemonRead;
      /**
       * Amended SPEC.md §5.2 (APRV-127): observations about a policy that is in
       * force. Empty for almost every policy. Never a reason to fail closed.
       */
      notes: PolicyNote[];
    }
  | {
      ok: false;
      code: PolicyLoadErrorCode;
      message: string;
      errors?: ValidationError[];
      /**
       * The parsed-but-rejected YAML value, when the failure happened AFTER a
       * successful parse (APRV-111). It exists for one consumer and one purpose:
       * `core/policy-diff.ts` renders the policy's key vocabulary, and the edit
       * most in need of rendering is the one that made the policy invalid — an
       * unknown top-level key, which this schema rejects outright. Without the
       * rejected value that edit is invisible to every reader, and a differ that
       * cannot see it would report "no semantic change" over bytes that took the
       * whole policy fail-closed.
       *
       * Absent for `file-missing`, `no-block`, `multiple-blocks` and
       * `yaml-error`: there is no value to carry. NOTHING may enforce against
       * it — a failed load is all-manual, full stop, and this field is for
       * DISPLAY only.
       */
      raw?: unknown;
    };

/** Options accepted by {@link loadPolicy}. */
export interface LoadPolicyOptions {
  /** Directory to search for `APPROVAL.md` / `APPROVALS.md`. Default: cwd. */
  dir?: string;
  /** Explicit policy file path. Overrides discovery entirely. */
  file?: string;
  /** Schema directory passed through to {@link validate}. Injectable for tests. */
  schemaDir?: string;
}

/**
 * Parse a SPEC.md §5.2 duration string to milliseconds.
 *
 * Accepts exactly `<positive integer><unit>` with unit in `ms|s|m|h|d|w`
 * (`w` = 7 days). Returns `null` for **any** deviation: zero, leading zeros,
 * negatives, fractions, compound forms (`1h30m`), surrounding whitespace,
 * empty input, unknown units. Deterministic and total — never throws.
 */
export function parseDuration(text: string): number | null {
  if (typeof text !== "string") return null;
  const match = DURATION_PATTERN.exec(text);
  if (match === null) return null;
  const digits = match[1];
  const unit = match[2];
  if (digits === undefined || unit === undefined) return null;
  const scale = MS_PER_UNIT[unit];
  if (scale === undefined) return null;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return value * scale;
}

function failure(
  code: PolicyLoadErrorCode,
  message: string,
  errors?: ValidationError[],
  raw?: unknown,
): PolicyLoadResult {
  const base: PolicyLoadResult = errors === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, errors };
  return raw === undefined ? base : { ...base, ok: false, code, message, raw };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Scan this file's markdown for policy fences.
 *
 * A one-line wrapper since APRV-238. The CommonMark rules, and the doc comment
 * arguing them, moved to {@link scanFences} in `core/md-fence.ts` so the values
 * reader of SPEC.md §5.3 could ask the same question about its own info string
 * without importing this module. Same rules, same results, one implementation.
 */
function scanPolicyFences(markdown: string): FenceScan {
  return scanFences(markdown, POLICY_INFO_STRING);
}

/** How a hardened parse should name itself in its failure messages. */
export interface HardenedYamlLabels {
  /** Subject of the message, e.g. `"policy YAML"` or `"frontmatter YAML"`. */
  subject: string;
  /** Where a tag was found, e.g. `"a policy block"` / `"a task envelope"`. */
  tagContext: string;
}

/** Outcome of {@link parseHardenedYaml}: a value, or one fail-closed message. */
export type HardenedYamlResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Parse YAML under the hardened settings described in the module header:
 * YAML 1.2 core schema, warnings fatal, duplicate keys fatal, explicitly tagged
 * nodes rejected, alias expansion bounded by {@link MAX_ALIAS_COUNT}.
 *
 * **This is the one implementation.** `core/frontmatter.ts` parses the *other*
 * half of the same permission surface — the task envelope declares the class,
 * cost, and reversibility that policy is matched against — and used to carry a
 * replica of these settings. APRV-20 (finding S5) deleted the replica: a task
 * envelope and a policy block are now hardened by the same code, so the two
 * cannot drift apart, and a hardening fix lands in both at once.
 *
 * Never throws; every failure is a message. Pure function of the source text.
 */
export function parseHardenedYaml(
  source: string,
  labels: HardenedYamlLabels,
): HardenedYamlResult {
  const { subject, tagContext } = labels;
  let document;
  try {
    document = parseDocument(source, {
      schema: "core",
      logLevel: "silent",
      prettyErrors: false,
    });
  } catch (cause) {
    return { ok: false, message: `${subject} could not be parsed: ${errorMessage(cause)}` };
  }

  if (document.errors.length > 0) {
    return {
      ok: false,
      message: `${subject} could not be parsed: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    };
  }
  if (document.warnings.length > 0) {
    return {
      ok: false,
      message: `${subject} parsed with warnings, which fail closed: ${document.warnings
        .map((warning) => warning.message)
        .join("; ")}`,
    };
  }

  // Reject explicitly tagged nodes outright: a value must only ever be a plain
  // string, number, boolean, null, map, or sequence.
  let taggedTag: string | null = null;
  visit(document, (_key, node) => {
    if (taggedTag === null && isNode(node) && typeof node.tag === "string") {
      taggedTag = node.tag;
    }
    return undefined;
  });
  if (taggedTag !== null) {
    return {
      ok: false,
      message: `${subject} uses an explicit tag (${String(taggedTag)}); tags are not accepted in ${tagContext}`,
    };
  }

  let value: unknown;
  try {
    // Alias expansion happens here, so this is where the bound belongs
    // (`maxAliasCount` is a ToJSOptions field): exceeding it throws.
    value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    return { ok: false, message: `${subject} could not be materialised: ${errorMessage(cause)}` };
  }

  return { ok: true, value };
}

/** {@link parseHardenedYaml} with this module's labels and error code. */
function parsePolicyYaml(source: string): PolicyLoadResult | { value: unknown } {
  const parsed = parseHardenedYaml(source, {
    subject: "policy YAML",
    tagContext: "a policy block",
  });
  return parsed.ok ? { value: parsed.value } : failure("yaml-error", parsed.message);
}

function resolveFile(options: LoadPolicyOptions): PolicyLoadResult | { path: string; text: string } {
  if (options.file !== undefined) {
    try {
      return { path: options.file, text: readFileSync(options.file, "utf8") };
    } catch (cause) {
      return failure(
        "file-missing",
        `policy file ${options.file} could not be read: ${errorMessage(cause)}`,
      );
    }
  }

  const dir = options.dir ?? process.cwd();
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    try {
      return { path: candidate, text: readFileSync(candidate, "utf8") };
    } catch {
      continue;
    }
  }
  return failure(
    "file-missing",
    `no policy file found in ${dir} (looked for ${POLICY_FILENAMES.join(", ")})`,
  );
}

/**
 * The fail-closed result for policy bytes that could not be read at all.
 *
 * Exported for callers that read the file themselves and still need a
 * {@link PolicyLoadResult} to hand `resolve` (APRV-142): a caller must never
 * have to invent one, because an invented result is where a permissive default
 * would creep in. `file-missing` is the same code {@link loadPolicy} reports
 * for the same fact.
 */
export function policyUnreadable(path: string, cause: string): PolicyLoadResult {
  return failure("file-missing", `policy file ${path} could not be read: ${cause}`);
}

/**
 * Extract, parse, and validate the policy block of an already-read policy file.
 *
 * The bytes-in form of {@link loadPolicy}, split out for APRV-142: a gate
 * operation reads `APPROVAL.md` **once** and feeds the same buffer to both the
 * attestation hash check and this parse, so no mid-operation file swap can
 * attest one policy and enforce another. `path` is used for messages and for
 * {@link PolicySource}; nothing here touches the filesystem.
 *
 * Fails closed on every error path and never throws, exactly as
 * {@link loadPolicy} does — it is the same code.
 */
export function loadPolicyText(
  path: string,
  text: string,
  options: { schemaDir?: string } = {},
): PolicyLoadResult {
  const resolved = { path, text };

  const scan = scanPolicyFences(resolved.text);
  if (scan.unterminated) {
    // CommonMark would close an unterminated fence at EOF; a policy file must
    // not be that forgiving, because the truncated tail of a policy is
    // indistinguishable from a complete one.
    return failure(
      "no-block",
      `${resolved.path}: unterminated \`\`\`${POLICY_INFO_STRING} fence (no closing fence before end of file)`,
    );
  }
  if (scan.blocks.length === 0) {
    return failure(
      "no-block",
      `${resolved.path}: no \`\`\`${POLICY_INFO_STRING} fenced block found`,
    );
  }
  if (scan.blocks.length > 1) {
    return failure(
      "multiple-blocks",
      `${resolved.path}: found ${scan.blocks.length} \`\`\`${POLICY_INFO_STRING} fenced blocks; SPEC.md §5 allows exactly one`,
    );
  }

  const parsed = parsePolicyYaml(scan.blocks[0] ?? "");
  if ("ok" in parsed) return parsed;

  const validation = validate(
    "policy",
    parsed.value,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!validation.ok) {
    return failure(
      "schema-invalid",
      `${resolved.path}: policy block failed schema validation`,
      validation.errors,
      parsed.value,
    );
  }

  const policy = parsed.value as Policy;

  // `channels.<name>.prompt` (APRV-218), checked once here for every channel
  // name including the untyped ones the schema admits as free-form objects.
  // Same fail direction as every other semantic check on this path: the WHOLE
  // policy fails closed to all-`manual` rather than one channel quietly
  // rendering a layout its author did not write. See `core/prompt-layout.ts`
  // for why both nets exist.
  const promptErrors = promptBlockErrors(policy);
  if (promptErrors.length > 0) {
    return failure(
      "schema-invalid",
      `${resolved.path}: channel prompt layout is not usable`,
      promptErrors,
      parsed.value,
    );
  }

  const ttlText = policy.defaults?.approval_ttl;
  let approvalTtlMs: number | null = null;
  if (ttlText !== undefined) {
    approvalTtlMs = parseDuration(ttlText);
    if (approvalTtlMs === null) {
      // Unreachable while the schema's duration pattern and the grammar here
      // agree; kept as a fail-closed backstop rather than an assertion.
      return failure(
        "schema-invalid",
        `${resolved.path}: defaults.approval_ttl "${ttlText}" is not a valid duration`,
        [
          {
            path: "/defaults/approval_ttl",
            keyword: "duration",
            message: "expected <positive integer><unit> with unit in ms|s|m|h|d|w",
          },
        ],
        parsed.value,
      );
    }
  }

  // The same treatment, for the same reason: one parse of the grammar, one
  // number every reader shares, and an unparseable duration fails the whole
  // policy rather than leaving one key quietly unread (APRV-58).
  const skewText = policy.audit?.skew_tolerance;
  let skewToleranceMs: number | null = null;
  if (skewText !== undefined) {
    skewToleranceMs = parseDuration(skewText);
    if (skewToleranceMs === null) {
      return failure(
        "schema-invalid",
        `${resolved.path}: audit.skew_tolerance "${skewText}" is not a valid duration`,
        [
          {
            path: "/audit/skew_tolerance",
            keyword: "duration",
            message: "expected <positive integer><unit> with unit in ms|s|m|h|d|w",
          },
        ],
        parsed.value,
      );
    }
  }

  // And once more for the checkpoint cadence (APRV-220). Report-only like the
  // skew tolerance, and parsed the same strict way for the same reason: an
  // operator who wrote `1 day` should be told, not quietly given no cadence at
  // all and left believing one is in force.
  const checkpointText = policy.audit?.checkpoint_every;
  let checkpointEveryMs: number | null = null;
  if (checkpointText !== undefined) {
    checkpointEveryMs = parseDuration(checkpointText);
    if (checkpointEveryMs === null) {
      return failure(
        "schema-invalid",
        `${resolved.path}: audit.checkpoint_every "${checkpointText}" is not a valid duration`,
        [
          {
            path: "/audit/checkpoint_every",
            keyword: "duration",
            message: "expected <positive integer><unit> with unit in ms|s|m|h|d|w",
          },
        ],
        parsed.value,
      );
    }
  }

  // The `daemon` block (APRV-217), read the same way: one parse here, defaults
  // applied once, and an unparseable duration fails the WHOLE policy rather
  // than leaving a key the author believed was in force quietly unread.
  const reproofText = policy.daemon?.full_reproof_after;
  let fullReproofAfterMs = DEFAULT_POLICY_DAEMON_READ.fullReproofAfterMs;
  if (reproofText !== undefined) {
    const parsedMs = parseDuration(reproofText);
    if (parsedMs === null) {
      return failure(
        "schema-invalid",
        `${resolved.path}: daemon.full_reproof_after "${reproofText}" is not a valid duration`,
        [
          {
            path: "/daemon/full_reproof_after",
            keyword: "duration",
            message: "expected <positive integer><unit> with unit in ms|s|m|h|d|w",
          },
        ],
        parsed.value,
      );
    }
    fullReproofAfterMs = parsedMs;
  }
  const daemonRead: PolicyDaemonRead = {
    readProof: policy.daemon?.read_proof ?? DEFAULT_POLICY_DAEMON_READ.readProof,
    fullReproofEvery:
      policy.daemon?.full_reproof_every ?? DEFAULT_POLICY_DAEMON_READ.fullReproofEvery,
    fullReproofAfterMs,
    declared: policy.daemon !== undefined,
  };

  return {
    ok: true,
    policy,
    source: { path: resolved.path, filename: basename(resolved.path) },
    durations: { approvalTtlMs, skewToleranceMs, checkpointEveryMs },
    daemon: daemonRead,
    notes: aliasNotes(policy),
  };
}

/**
 * Amended SPEC.md §5.2 (APRV-127): one note per place a policy still writes the
 * bare `supervised`.
 *
 * The alias keeps every pre-split policy meaning exactly what its author meant:
 * `supervised` was retrospective sampling, and `supervised-retro` is that same
 * behaviour under its honest name. What the alias must never be is quiet. An
 * author reading the split for the first time can reasonably believe `supervised`
 * now means "supervised somehow, possibly live"; the note says, in the one place
 * a reader is already looking, that it does not.
 *
 * Pure, total, and ordered: `defaults` first, then class patterns in sorted
 * order, so the notes of one policy are byte-stable across runs.
 */
function aliasNotes(policy: Policy): PolicyNote[] {
  const notes: PolicyNote[] = [];
  const say = (where: string): PolicyNote => ({
    code: "supervised-alias",
    where,
    message: `${where} declares the bare \`supervised\`, which parses as \`supervised-retro\`: the action executes immediately and is sampled for review AFTERWARDS. Nothing about it changed with the autonomy split — this is the same behaviour under its honest name. Write \`supervised-retro\` to say so explicitly, or \`supervised-live: <rate>\` to have a fraction of the class stop for a human FIRST.`,
  });

  if (policy.defaults?.autonomy === "supervised") notes.push(say("defaults.autonomy"));
  for (const pattern of Object.keys(policy.classes ?? {}).sort()) {
    if (policy.classes?.[pattern]?.autonomy === "supervised") {
      notes.push(say(`classes.${pattern}`));
    }
  }
  return notes;
}

/**
 * Load, extract, parse, and validate the policy block of an `APPROVAL.md`.
 *
 * Discovery: `options.file` when given, otherwise `APPROVAL.md` in
 * `options.dir` (default cwd), falling back to `APPROVALS.md`. `APPROVAL.md`
 * wins when both exist (SPEC.md §5).
 *
 * Fails closed on every error path — see {@link PolicyLoadResult}. Never
 * throws; a thrown error would be a policy bypass.
 *
 * This is discovery plus {@link loadPolicyText}. A caller that has already read
 * the bytes (the gate, since APRV-142) calls the latter directly rather than
 * paying for a second read that could see different bytes.
 */
export function loadPolicy(options: LoadPolicyOptions = {}): PolicyLoadResult {
  const resolved = resolveFile(options);
  if ("ok" in resolved) return resolved;
  return loadPolicyText(
    resolved.path,
    resolved.text,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
}
