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

/** SPEC.md §5.2 autonomy levels, strictest first. */
export type Autonomy = "manual" | "supervised" | "autonomous";

/** A class rule (SPEC.md §5.1); shape mirrors `policy.schema.json`. */
export interface PolicyClassRule {
  autonomy: Autonomy;
  approvers?: string[];
  limits?: Record<string, number>;
}

/** Parsed policy document. Structurally guaranteed by `policy.schema.json`. */
export interface Policy {
  version: string;
  defaults?: {
    autonomy?: Autonomy;
    channel?: string;
    approval_ttl?: string;
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
  budgets?: Record<string, { daily_usd?: number; daily_actions?: number }>;
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
}

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

/** Normalise a fence info string: trim ends, collapse internal whitespace. */
function normaliseInfoString(info: string): string {
  return info.trim().replace(/\s+/gu, " ");
}

interface FenceScan {
  /** Bodies of every block whose info string is the policy info string. */
  blocks: string[];
  /** True when a matching fence was opened and never closed before EOF. */
  unterminated: boolean;
}

/**
 * Scan CommonMark fenced code blocks and collect the bodies of those whose
 * info string is `yaml approval-policy`.
 *
 * CommonMark rules honoured, because they decide what is and is not a fence:
 * an opening fence is 3+ backticks indented at most 3 spaces; its info string
 * may not contain a backtick; the closing fence is at least as long as the
 * opener and carries nothing but whitespace. Every non-matching fenced block
 * (```js, ```yaml, …) is still scanned as a block, so text *inside* it can
 * never be mistaken for a policy fence. Everything outside a fence — including
 * yaml-looking prose and 4-space-indented code blocks, which are not fences —
 * is ignored entirely.
 */
function scanPolicyFences(markdown: string): FenceScan {
  const lines = markdown.split(/\r\n|\n|\r/u);
  const blocks: string[] = [];

  let openLength = 0;
  let openIsPolicy = false;
  let body: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (!inFence) {
      const open = /^ {0,3}(`{3,})(.*)$/u.exec(line);
      if (open === null) continue;
      const info = open[2] ?? "";
      // CommonMark: a backtick fence's info string may not contain a backtick.
      if (info.includes("`")) continue;
      inFence = true;
      openLength = (open[1] ?? "").length;
      openIsPolicy = normaliseInfoString(info) === POLICY_INFO_STRING;
      body = [];
      continue;
    }

    const close = /^ {0,3}(`{3,})[ \t]*$/u.exec(line);
    if (close !== null && (close[1] ?? "").length >= openLength) {
      if (openIsPolicy) blocks.push(body.join("\n"));
      inFence = false;
      openIsPolicy = false;
      body = [];
      continue;
    }
    body.push(line);
  }

  return { blocks, unterminated: inFence && openIsPolicy };
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
 * Load, extract, parse, and validate the policy block of an `APPROVAL.md`.
 *
 * Discovery: `options.file` when given, otherwise `APPROVAL.md` in
 * `options.dir` (default cwd), falling back to `APPROVALS.md`. `APPROVAL.md`
 * wins when both exist (SPEC.md §5).
 *
 * Fails closed on every error path — see {@link PolicyLoadResult}. Never
 * throws; a thrown error would be a policy bypass.
 */
export function loadPolicy(options: LoadPolicyOptions = {}): PolicyLoadResult {
  const resolved = resolveFile(options);
  if ("ok" in resolved) return resolved;

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

  return {
    ok: true,
    policy,
    source: { path: resolved.path, filename: basename(resolved.path) },
    durations: { approvalTtlMs, skewToleranceMs },
  };
}
