/**
 * Prompt layout: which INFORMATIONAL rows a channel puts in front of an
 * approver, as a policy decision rather than a code decision (APRV-218).
 *
 * SPEC.md §5.2 gains `channels.<name>.prompt`; SPEC.md §10.3 already says a
 * channel holds no truth, and this module is what keeps that so — the block
 * decides what is SHOWN, never what is true, and every field it can reach was
 * already on the `ChannelRequest` and already in `--json`, `approval queue` and
 * the web page. Nothing here reads the log, and no key added here lets a
 * channel learn anything about it.
 *
 * ## Why this is a policy key at all
 *
 * The Telegram prompt was slimmed deliberately: APRV-143 dropped the `ttl` row
 * because the `waiting … expires HH:MM UTC` line already states the deadline,
 * and APRV-163 dropped six bookkeeping rows and made three health rows render
 * only when abnormal. That layout fits ONE operator's workflow. Another wants
 * the budget line on every prompt, or the TTL as a duration, or the task id
 * always visible. Those are preferences about a screen, and preferences about a
 * screen belong in the policy file beside the other things an operator chooses,
 * not in a `git blame` argument about a default.
 *
 * ## What a layout may NOT do
 *
 * A layout chooses among rows the approver may read. It cannot touch what the
 * approver SIGNS. Three things are therefore out of its reach entirely:
 *
 * 1. **The canonical block** (SPEC.md §9's "what you see is what you sign") is
 *    not a row. It carries the payload bytes, the renderer version, the class,
 *    the kind and the bound `payload sha256`, it is rendered verbatim, and no
 *    key in this module can reorder, shorten, or remove it.
 * 2. **The computed/claimed split.** A row's side of the boundary is a property
 *    of the field (`TaggedField.kind`), not of the layout. `rows` reorders; it
 *    cannot move a claimed line into the computed block, because a channel
 *    partitions by kind AFTER it applies the order. That is the property
 *    APRV-144's CLAIMED heading exists for, and a test pins it.
 * 3. **{@link REQUIRED_PROMPT_ROWS}**, the rows the contract marks as required
 *    for a decision. Naming one in `hide` is a policy that fails to load.
 *
 * The buttons are not a row either, for the same reason the block is not: a
 * prompt with no way to answer it is not a prompt.
 *
 * ## Fail directions
 *
 * Soft on ABSENCE, closed on INVALIDITY, which is the split every other policy
 * key in this runtime keeps. No `prompt` block, or a policy that did not load,
 * means today's rows: a layout is not a permission, and an unrelated typo in a
 * class rule must not silently redecorate a phone screen. An unknown row name
 * or a required row in `hide` is a statement the runtime cannot honour, so the
 * WHOLE policy fails schema validation and every class resolves to `manual` —
 * the operator repairs the file, and until they do the gate is at its
 * strictest.
 *
 * Pure: no clock, no IO, no environment. It sits in `core/` rather than in
 * `channels/` for `core/telegram-config.ts`'s reason — more than one layer asks
 * "which rows does this policy want?" and none of them may answer differently —
 * and it imports nothing from `channels/`, so `tests/layering.test.ts` stays
 * true. The row names below are the `ChannelRequest` member names spelled as
 * plain strings for exactly that reason.
 */

import type { Policy, PolicyLoadResult } from "./policy-load.js";
import type { ValidationError } from "./validate.js";

/**
 * The row vocabulary: every `ChannelRequest` member a channel renders as a row.
 *
 * Closed, and closed for `delivery`'s reason (APRV-216): a name this runtime
 * cannot place is a row the author believes is in force that nothing reads, and
 * guessing at it would be the silent no-op the whole policy schema is shaped to
 * prevent.
 *
 * `fullPayload` is deliberately ABSENT. The canonical block is not a row.
 */
export const PROMPT_ROWS = [
  "action_key",
  "task",
  "class",
  "command_breakdown",
  "protected_path",
  "policy_diff",
  "policy_load",
  "autonomy",
  "provenance",
  "state",
  "requested_ts",
  "waiting",
  "ttl_remaining_ms",
  "payload_hash",
  "attestation",
  "budgets",
  "chain",
  "token_delivery",
  "est_cost_usd",
  "gloss",
  "summary",
  "rationale",
  "confidence",
] as const;

/** One row name from {@link PROMPT_ROWS}. */
export type PromptRow = (typeof PROMPT_ROWS)[number];

/** Whether a string is a row name this runtime knows how to place. */
export function isPromptRow(value: unknown): value is PromptRow {
  return typeof value === "string" && (PROMPT_ROWS as readonly string[]).includes(value);
}

/**
 * The rows an operator may reorder but never remove.
 *
 * Each is required for a DECISION rather than for a screen. `action_key`
 * identifies which request the gesture answers; `class` is the resolution the
 * whole gate turns on; `command_breakdown` and `protected_path` are APRV-144
 * and APRV-143's answer to "what does this command actually do, and which
 * protected path earned the class", derived from the bound bytes by the same
 * classifier the hook decided with; `policy_diff` and `policy_load` are what
 * SPEC.md §10.3 requires of an attestation prompt, where "a prompt carrying
 * only a hash asks a human to sign for sixty-four characters and is a
 * conformance failure".
 *
 * `payload_hash` is NOT here, and its absence is not an oversight. The bound
 * hash is stated inside the canonical block on every channel, and the block is
 * out of a layout's reach, so an operator who hides the row removes a
 * duplicate rather than the binding. Telegram's default layout already does
 * exactly that (APRV-163).
 *
 * A required row a request does not CARRY renders nothing, as it does today.
 * Requirement is about what a policy may instruct, not about what a particular
 * request happens to hold.
 */
export const REQUIRED_PROMPT_ROWS: readonly PromptRow[] = [
  "action_key",
  "class",
  "command_breakdown",
  "protected_path",
  "policy_diff",
  "policy_load",
];

/**
 * How a row renders when nothing in the policy says otherwise.
 *
 * - `always` — on every prompt the request carries the field for.
 * - `abnormal` — only when the value is the reason to look. APRV-163's
 *   argument: a row that says "everything is fine" on every ordinary request is
 *   a row a reader learns to skip, and the skipping does not stop on the one
 *   request where it says something else.
 * - `off` — the channel does not render it by default. The field still travels
 *   on the request, so `--json`, `approval queue` and the web page carry it.
 */
export type RowVisibility = "always" | "abnormal" | "off";

/** A resolved layout: the order rows render in, and each row's visibility. */
export interface PromptLayout {
  /** Every row in {@link PROMPT_ROWS}, in render order. */
  order: readonly PromptRow[];
  /** Visibility per row. Total: every row name has an entry. */
  visibility: Readonly<Record<PromptRow, RowVisibility>>;
}

/** The channels this runtime ships (SPEC.md §10.3). */
export const PROMPT_CHANNELS = ["cli", "web", "telegram"] as const;

/** One of the three shipped channel names. */
export type PromptChannel = (typeof PROMPT_CHANNELS)[number];

function layoutOf(order: readonly PromptRow[], visibility: Partial<Record<PromptRow, RowVisibility>>): PromptLayout {
  const full = {} as Record<PromptRow, RowVisibility>;
  for (const row of PROMPT_ROWS) full[row] = visibility[row] ?? "off";
  return { order, visibility: full };
}

/**
 * Telegram's default layout: the slimmed phone prompt, exactly as APRV-143 and
 * APRV-163 left it.
 *
 * The ORDER of the rows that render is load-bearing and must not drift: it is
 * the sequence a reader's eye has learned. The `off` rows are interleaved where
 * they belong if an operator turns them on, which costs nothing while they are
 * off and saves an operator from writing a `rows` list to get a sensible
 * position.
 *
 * `action_key` is `off` here because Telegram renders it STRUCTURALLY, as the
 * message's second line in a `<code>` span. It is required, so it cannot be
 * hidden, and it is not a bullet, so promoting it changes nothing.
 */
export const TELEGRAM_PROMPT_LAYOUT: PromptLayout = layoutOf(
  [
    "action_key",
    "task",
    "class",
    "command_breakdown",
    "protected_path",
    "policy_diff",
    "policy_load",
    "autonomy",
    "budgets",
    "attestation",
    "provenance",
    "state",
    "requested_ts",
    "waiting",
    "ttl_remaining_ms",
    "payload_hash",
    "chain",
    "token_delivery",
    "gloss",
    "summary",
    "est_cost_usd",
    "rationale",
    "confidence",
  ],
  {
    class: "always",
    command_breakdown: "always",
    protected_path: "always",
    policy_diff: "always",
    policy_load: "always",
    autonomy: "abnormal",
    budgets: "abnormal",
    attestation: "abnormal",
    waiting: "always",
    gloss: "always",
    summary: "always",
    est_cost_usd: "always",
    rationale: "always",
    confidence: "always",
  },
);

/**
 * The order the terminal and the page have used since APRV-23: computed
 * identity and authority first, claimed persuasion last, so a reader who stops
 * halfway has read the runtime's answer and not the agent's pitch.
 *
 * `token_delivery` sits at the end because that is where it lands today —
 * neither channel's `FIELD_ORDER` named it, and both append a member they do
 * not list. Naming it here makes it reachable by `hide` and `rows` without
 * moving it.
 */
const FULL_ROW_ORDER: readonly PromptRow[] = [
  "action_key",
  "task",
  "class",
  "command_breakdown",
  "protected_path",
  "policy_diff",
  "policy_load",
  "autonomy",
  "provenance",
  "state",
  "requested_ts",
  "waiting",
  "ttl_remaining_ms",
  "payload_hash",
  "attestation",
  "budgets",
  "chain",
  "est_cost_usd",
  "gloss",
  "summary",
  "rationale",
  "confidence",
  "token_delivery",
];

const ALL_ALWAYS: Partial<Record<PromptRow, RowVisibility>> = Object.fromEntries(
  PROMPT_ROWS.map((row) => [row, "always" as RowVisibility]),
);

/**
 * The CLI channel's default layout: every row the request carries.
 *
 * A terminal has room, and a one-shot rendering an operator asked for by typing
 * a verb is not the place to economise on lines the way a push notification is.
 */
export const CLI_PROMPT_LAYOUT: PromptLayout = layoutOf(FULL_ROW_ORDER, ALL_ALWAYS);

/** The web channel's default layout. Same reasoning as the CLI's: a page scrolls. */
export const WEB_PROMPT_LAYOUT: PromptLayout = layoutOf(FULL_ROW_ORDER, ALL_ALWAYS);

/** Default layout per shipped channel. What an absent `prompt` block means. */
export const DEFAULT_PROMPT_LAYOUTS: Readonly<Record<PromptChannel, PromptLayout>> = {
  cli: CLI_PROMPT_LAYOUT,
  web: WEB_PROMPT_LAYOUT,
  telegram: TELEGRAM_PROMPT_LAYOUT,
};

/**
 * A `channels.<name>.prompt` block as a policy may write it.
 *
 * Three keys, and each does ONE thing, because a key that both orders and
 * hides would leave an operator guessing which of the two a short list meant:
 *
 * - `rows` — ORDER ONLY. The rows it names render in that order, ahead of every
 *   row it does not name; those keep their default relative order behind them.
 *   It is never a whitelist, so a `ChannelRequest` widened by a later task
 *   cannot silently lose a field to a list written before that field existed —
 *   the same property `orderedFields` has held since APRV-23.
 * - `always` — visibility UP. A row that is `abnormal` or `off` by default
 *   renders on every prompt.
 * - `hide` — visibility DOWN. A row never renders. Refused for
 *   {@link REQUIRED_PROMPT_ROWS}.
 *
 * `always` and `hide` naming the same row is refused rather than resolved by
 * precedence: a policy that says both things about one row has an author who
 * believes one of them, and picking for them is the guess this schema does not
 * make.
 */
export interface PromptBlock {
  rows?: PromptRow[];
  always?: PromptRow[];
  hide?: PromptRow[];
}

/**
 * The layout in force for `channel`.
 *
 * Fail-soft in the same direction as `telegramDeliveryFor`: a policy that did
 * not load declares nothing, an absent block declares nothing, and a layout is
 * not a permission. Anything structurally wrong that reaches here (a hand-built
 * load result, a key from a later version) falls back to the default rather
 * than being guessed at — a LOADED policy cannot carry such a block, because
 * {@link promptBlockErrors} refuses it at load.
 */
export function promptLayoutFor(load: PolicyLoadResult, channel: string): PromptLayout {
  const base = DEFAULT_PROMPT_LAYOUTS[channel as PromptChannel] ?? CLI_PROMPT_LAYOUT;
  if (!load.ok) return base;
  const block = readBlock(load.policy.channels?.[channel]);
  if (block === null) return base;
  return applyPromptBlock(base, block);
}

/**
 * Apply a block to a layout. Pure, total, and exported so the tests and the
 * `approval policy explain` path can show the result without a policy file.
 */
export function applyPromptBlock(base: PromptLayout, block: PromptBlock): PromptLayout {
  const named = (block.rows ?? []).filter(isPromptRow);
  const order: PromptRow[] = [];
  for (const row of named) if (!order.includes(row)) order.push(row);
  for (const row of base.order) if (!order.includes(row)) order.push(row);

  const visibility = { ...base.visibility } as Record<PromptRow, RowVisibility>;
  for (const row of block.always ?? []) if (isPromptRow(row)) visibility[row] = "always";
  for (const row of block.hide ?? []) if (isPromptRow(row)) visibility[row] = "off";
  return { order, visibility };
}

/**
 * The `prompt` block under one channel entry, or `null` when there is none.
 *
 * Structural only. Every semantic check lives in {@link promptBlockErrors} and
 * has already run at load, so a block reaching here from a loaded policy is
 * known-good; this function's `null` returns are for the hand-built and
 * future-version cases the fail-soft rule above covers.
 */
function readBlock(entry: unknown): PromptBlock | null {
  if (entry === null || typeof entry !== "object") return null;
  const raw = (entry as Record<string, unknown>)["prompt"];
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  const list = (key: string): PromptRow[] | undefined => {
    const value = block[key];
    if (!Array.isArray(value)) return undefined;
    return value.filter(isPromptRow);
  };
  const rows = list("rows");
  const always = list("always");
  const hide = list("hide");
  return {
    ...(rows === undefined ? {} : { rows }),
    ...(always === undefined ? {} : { always }),
    ...(hide === undefined ? {} : { hide }),
  };
}

/** The machine-readable reasons a `prompt` block refuses (APRV-218). */
export const PROMPT_BLOCK_ERROR_KEYWORDS = [
  /** A row name this runtime cannot place. */
  "prompt-row-unknown",
  /** {@link REQUIRED_PROMPT_ROWS} named in `hide`. */
  "prompt-row-required",
  /** `rows`, `always` or `hide` is not an array of strings. */
  "prompt-block-shape",
  /** One row named by both `always` and `hide`. */
  "prompt-row-conflict",
  /** A key the `prompt` block does not define. */
  "prompt-key-unknown",
] as const;

const PROMPT_BLOCK_KEYS = ["rows", "always", "hide"] as const;

/**
 * Validate every `channels.<name>.prompt` in a policy. Empty means clean.
 *
 * This runs on top of the JSON Schema rather than instead of it, and the
 * duplication is deliberate. The schema types the three channels this runtime
 * ships and closes the row enum there, which is where SPEC.md §8's
 * validate-at-the-write-boundary rule wants it; but `channels` admits UNKNOWN
 * channel names as free-form objects on purpose, so a third-party transport
 * plugin does not invalidate a whole policy, and a `prompt` block written under
 * such a name would otherwise reach a renderer unchecked. Both nets return the
 * same verdict — the policy does not load, everything is `manual` — so an
 * operator never has to know which one caught them.
 */
export function promptBlockErrors(policy: Policy): ValidationError[] {
  const errors: ValidationError[] = [];
  const channels = policy.channels;
  if (channels === undefined || channels === null || typeof channels !== "object") return errors;

  for (const channel of Object.keys(channels).sort()) {
    const entry = channels[channel];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = (entry as Record<string, unknown>)["prompt"];
    if (raw === undefined) continue;
    const at = `/channels/${channel}/prompt`;

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({
        path: at,
        keyword: "prompt-block-shape",
        message: "expected an object with any of `rows`, `always`, `hide`",
      });
      continue;
    }

    const block = raw as Record<string, unknown>;
    for (const key of Object.keys(block).sort()) {
      if (!(PROMPT_BLOCK_KEYS as readonly string[]).includes(key)) {
        errors.push({
          path: `${at}/${key}`,
          keyword: "prompt-key-unknown",
          message: `unknown key; the prompt block defines ${PROMPT_BLOCK_KEYS.join(", ")}`,
        });
      }
    }

    const seen: Record<string, Set<string>> = {};
    for (const key of PROMPT_BLOCK_KEYS) {
      const value = block[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        errors.push({
          path: `${at}/${key}`,
          keyword: "prompt-block-shape",
          message: "expected an array of row names",
        });
        continue;
      }
      const names = new Set<string>();
      value.forEach((row, index) => {
        if (!isPromptRow(row)) {
          errors.push({
            path: `${at}/${key}/${String(index)}`,
            keyword: "prompt-row-unknown",
            message: `unknown row name ${JSON.stringify(row)}; known rows are ${PROMPT_ROWS.join(", ")}`,
          });
          return;
        }
        names.add(row);
        if (key === "hide" && REQUIRED_PROMPT_ROWS.includes(row)) {
          errors.push({
            path: `${at}/${key}/${String(index)}`,
            keyword: "prompt-row-required",
            message: `row ${JSON.stringify(row)} is required for a decision and may be reordered but not hidden; required rows are ${REQUIRED_PROMPT_ROWS.join(", ")}`,
          });
        }
      });
      seen[key] = names;
    }

    for (const row of seen["always"] ?? new Set<string>()) {
      if (seen["hide"]?.has(row) === true) {
        errors.push({
          path: `${at}/hide`,
          keyword: "prompt-row-conflict",
          message: `row ${JSON.stringify(row)} is named by both \`always\` and \`hide\`; say one of them`,
        });
      }
    }
  }
  return errors;
}
