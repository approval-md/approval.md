/**
 * The policy `delegation` block (APRV-500, amended SPEC.md §5.2 proposed):
 * RESERVED in 0.4.2, validated and inert.
 *
 * The block will hold the judge: a pinned model that reviews supervised
 * samples, advises on manual cards, and decides manual cards in named classes
 * within a cap. None of that exists in this release. What exists is the
 * grammar, so it can be refuted before it holds any power, and one rule that
 * keeps the reservation honest: a block in anything but its OFF form fails the
 * load with `delegation-not-supported`.
 *
 * Why refuse rather than ignore. `policy.schema.json` is closed because an
 * unrecognised key is "a policy the author believed was in force and the
 * runtime did not understand". A core that accepted `daily_cap: 10` and did
 * nothing would break that promise with a key it DOES recognise. So every value
 * an author could believe is in force is refused, the policy fails closed, and
 * every class resolves `manual`, the strict direction.
 *
 * Two layers, checked in this order by `core/policy-load.ts`:
 *
 * 1. {@link delegationErrors}: the relationships between the block and the
 *    rest of the file that no JSON Schema can state (design rules 1 to 7).
 *    Failing one is `schema-invalid`, like every other relationship check on
 *    the load path.
 * 2. {@link delegationEngaged}: the keys not at their off value (design rule
 *    8). Any is `delegation-not-supported`. A later core drops this layer.
 *
 * The off form, with every key at its off value, passes rule layer 1 vacuously
 * (no classes, no reviewers, no model), so in 0.4.2 layer 1 only decides WHICH
 * code a refused block gets. It runs first anyway, so the grammar is exercised
 * now rather than on the day it starts to matter.
 *
 * Pure: no I/O, no clock.
 */

import { parseIdentity } from "./identity.js";
import type { DeclaredAutonomy, Policy } from "./policy-load.js";
import { STRICTNESS } from "./policy-match.js";
import type { ValidationError } from "./validate.js";

/** The judge outcomes that may be routed to a human instead of standing. */
export const DELEGATION_ESCALATIONS = ["deny", "low_confidence", "irreversible", "unknown_class"] as const;
export type DelegationEscalation = (typeof DELEGATION_ESCALATIONS)[number];

/** What `max_autonomy` may say. The schema's enum, in strictness order. */
export const DELEGATION_MAX_AUTONOMY = ["manual", "supervised-live", "supervised-retro"] as const;
export type DelegationMaxAutonomy = (typeof DELEGATION_MAX_AUTONOMY)[number];

/** The block as the schema admits it. Every key optional. */
export interface DelegationBlock {
  model?: string | null;
  classes?: string[];
  max_autonomy?: DelegationMaxAutonomy;
  daily_cap?: number;
  escalate_on?: DelegationEscalation[];
  advice?: boolean;
  reviewers?: string[];
}

/** The load code for a block that is not off (design rule 8). */
export const DELEGATION_NOT_SUPPORTED = "delegation-not-supported";

/**
 * The off value of every key, which is also what an absent key means. A block
 * whose every key is absent or equal to this loads and changes nothing.
 */
export const DELEGATION_OFF: Readonly<{
  model: null;
  classes: readonly string[];
  max_autonomy: "manual";
  daily_cap: 0;
  escalate_on: readonly DelegationEscalation[];
  advice: false;
  reviewers: readonly string[];
}> = Object.freeze({
  model: null,
  classes: Object.freeze([]) as readonly string[],
  max_autonomy: "manual",
  daily_cap: 0,
  escalate_on: Object.freeze([]) as readonly DelegationEscalation[],
  advice: false,
  reviewers: Object.freeze([]) as readonly string[],
});

/** The block's keys, in the order the design and the docs list them. */
export const DELEGATION_KEYS = [
  "model",
  "classes",
  "max_autonomy",
  "daily_cap",
  "escalate_on",
  "advice",
  "reviewers",
] as const;
export type DelegationKey = (typeof DELEGATION_KEYS)[number];

/** Is `key` of `block` at its off value (absent counts as off)? */
function keyIsOff(block: DelegationBlock, key: DelegationKey): boolean {
  switch (key) {
    case "model":
      return block.model === undefined || block.model === null;
    case "classes":
      return block.classes === undefined || block.classes.length === 0;
    case "max_autonomy":
      return block.max_autonomy === undefined || block.max_autonomy === "manual";
    case "daily_cap":
      return block.daily_cap === undefined || block.daily_cap === 0;
    case "escalate_on":
      return block.escalate_on === undefined || block.escalate_on.length === 0;
    case "advice":
      return block.advice === undefined || block.advice === false;
    case "reviewers":
      return block.reviewers === undefined || block.reviewers.length === 0;
  }
}

/**
 * The keys of `block` that are NOT at their off value, in {@link DELEGATION_KEYS}
 * order. Empty means the block is off. Absent block: empty.
 */
export function delegationEngaged(block: DelegationBlock | undefined): DelegationKey[] {
  if (block === undefined) return [];
  return DELEGATION_KEYS.filter((key) => !keyIsOff(block, key));
}

/** The engaged keys as load-failure errors, one per key, for display. */
export function delegationEngagedErrors(keys: readonly DelegationKey[]): ValidationError[] {
  return keys.map((key) => ({
    path: `/delegation/${key}`,
    keyword: DELEGATION_NOT_SUPPORTED,
    message: `delegation.${key} is not at its off value; this core reserves the delegation block and implements none of it, so a value here would be a setting nobody enforces`,
  }));
}

/**
 * The load-time checks on `delegation` that no JSON Schema can state (design
 * rules 1 to 7). Each error fails the WHOLE policy closed as `schema-invalid`.
 *
 * - `delegation-class-undeclared` (rule 1): every `classes` entry is an EXACT
 *   key of the policy's `classes`. A class reached only through a wildcard
 *   family is refused, as `agent_may_request` refuses one: the delegated set
 *   is a set of lines the operator wrote by name.
 * - `delegation-class-level` (rule 2): no delegated class declares
 *   `human-only` (invariant 9: no verb mints authority for it) or `autonomous`
 *   (there is nothing to judge).
 * - `delegation-max-autonomy-pin` (rule 3): every delegated class declares an
 *   autonomy at least as strict as `max_autonomy`, by the resolver's own
 *   {@link STRICTNESS} table. The deprecated `supervised` reads as
 *   `supervised-retro`, as it does everywhere.
 * - `delegation-escalation-floor` (rule 5): `daily_cap > 0` requires
 *   `escalate_on` to contain `irreversible` and `unknown_class`.
 * - `delegation-reviewer-model` (rule 6): a `model:` reviewer equals `model`.
 * - `delegation-reviewer-unknown` (rule 6): a `human:` reviewer names a key of
 *   `approvers`.
 * - `delegation-model-required` (rule 7): `advice: true`, `daily_cap > 0`
 *   or a `model:` reviewer with `model` null or absent.
 *
 * Rule 4 (`daily_cap` an integer, not negative) is the schema's.
 */
export function delegationErrors(policy: Policy): ValidationError[] {
  const block = policy.delegation;
  if (block === undefined) return [];
  const errors: ValidationError[] = [];
  const classes = policy.classes ?? {};
  const model = block.model ?? null;
  const ceiling = block.max_autonomy ?? "manual";

  (block.classes ?? []).forEach((cls, index) => {
    const at = `/delegation/classes/${String(index)}`;
    if (!Object.prototype.hasOwnProperty.call(classes, cls)) {
      errors.push({
        path: at,
        keyword: "delegation-class-undeclared",
        message: `class ${JSON.stringify(cls)} is not an exact key of classes; a delegated class must be a line the operator wrote by name, never one reached through a wildcard family`,
      });
      return;
    }
    const declared: DeclaredAutonomy | undefined = classes[cls]?.autonomy;
    if (declared === undefined) return;
    if (declared === "human-only" || declared === "autonomous") {
      errors.push({
        path: at,
        keyword: "delegation-class-level",
        message: `class ${JSON.stringify(cls)} declares ${declared}; a human-only class is reserved to human hands and an autonomous one has nothing to judge, so neither may be delegated`,
      });
      return;
    }
    if (STRICTNESS[declared] > STRICTNESS[ceiling]) {
      errors.push({
        path: at,
        keyword: "delegation-max-autonomy-pin",
        message: `class ${JSON.stringify(cls)} declares ${declared}, looser than delegation.max_autonomy ${ceiling}; the pin holds every delegated class at least as strict as max_autonomy, so loosening a delegated row needs the delegation block rewritten too`,
      });
    }
  });

  const cap = block.daily_cap ?? 0;
  if (cap > 0) {
    const escalations = new Set(block.escalate_on ?? []);
    for (const floor of ["irreversible", "unknown_class"] as const) {
      if (!escalations.has(floor)) {
        errors.push({
          path: "/delegation/escalate_on",
          keyword: "delegation-escalation-floor",
          message: `daily_cap ${String(cap)} needs escalate_on to contain ${floor}; the delegated approver cannot be configured without the irreversible and unknown_class floors`,
        });
      }
    }
  }

  let modelReviewer = false;
  (block.reviewers ?? []).forEach((reviewer, index) => {
    const at = `/delegation/reviewers/${String(index)}`;
    const identity = parseIdentity(reviewer, "reviewer");
    if (identity === null) {
      // Unreachable for a schema-valid file (the schema's pattern is this
      // parser's grammar); kept as a fail-closed backstop.
      errors.push({
        path: at,
        keyword: "delegation-reviewer-unknown",
        message: `reviewer ${JSON.stringify(reviewer)} is neither human:<approver id> nor model:<name>@<version>`,
      });
      return;
    }
    if (identity.kind === "model") {
      modelReviewer = true;
      if (model !== null && reviewer !== model) {
        errors.push({
          path: at,
          keyword: "delegation-reviewer-model",
          message: `model reviewer ${JSON.stringify(reviewer)} is not delegation.model ${JSON.stringify(model)}; the only model admitted to review is the judge the block names`,
        });
      }
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(policy.approvers ?? {}, identity.id)) {
      errors.push({
        path: at,
        keyword: "delegation-reviewer-unknown",
        message: `reviewer ${JSON.stringify(reviewer)} names no key of approvers`,
      });
    }
  });

  if (model === null) {
    const powers: string[] = [];
    if (block.advice === true) powers.push("advice: true");
    if (cap > 0) powers.push(`daily_cap: ${String(cap)}`);
    if (modelReviewer) powers.push("a model: reviewer");
    if (powers.length > 0) {
      errors.push({
        path: "/delegation/model",
        keyword: "delegation-model-required",
        message: `${powers.join(", ")} with no delegation.model; a power written with no judge named is an author error, so it is refused rather than ignored`,
      });
    }
  }
  return errors;
}

/**
 * One line describing the declared block for `approval policy check`, or
 * `null` when the policy declares none. Only ever called on a policy that
 * LOADED, which in 0.4.2 means the block is off.
 */
export function describeDelegation(policy: Policy): string | null {
  const block = policy.delegation;
  if (block === undefined) return null;
  const engaged = delegationEngaged(block);
  if (engaged.length === 0) {
    return "delegation (APRV-500): declared and off; the block is reserved in this core and no judge reviews, advises or decides any class";
  }
  // Unreachable for a loaded policy: an engaged block fails the load.
  return `delegation (APRV-500): ${engaged.map((key) => `delegation.${key}`).join(", ")} not off; this core does not support delegation`;
}
