/**
 * Semantic policy diff (APRV-30) — what an edit to `APPROVAL.md` actually
 * *changes about the runtime's answers*, computed by the real engine on both
 * versions of the file.
 *
 * ## Why this module exists: two live incidents
 *
 * **seq 2 of this repository's own log.** An amendment was attested and then
 * superseded eleven minutes later, because the operator attested a policy edit
 * that broke a pinned dogfood assertion — a fact nobody learned until the test
 * suite ran, well after the bytes had been signed for. Nothing in the ceremony
 * had asked "what does this edit change?" before recording "a human saw these
 * bytes".
 *
 * **The unsigned interregnum.** Commit `f829e6c` edited the policy file; its
 * attestation landed in a later commit. In between, the repository was carrying
 * an *inoperative* policy: `checkAttestation` reported `hash-mismatch`, and
 * every gate operation refused. The edit and the attestation were two acts when
 * they should have been one.
 *
 * Both incidents share a shape: the policy edit was treated as a text change
 * rather than as an amendment with consequences. This module supplies the
 * missing half of the ceremony — the consequences — and `cli/amend.ts` supplies
 * the ceremony itself.
 *
 * ## What is compared, and how
 *
 * Nothing here re-implements matching, specificity, the irreversibility floor,
 * or defaulting. {@link diffPolicies} calls `resolve()` from
 * `core/policy-match.ts` on **both** loads for the same probe class, and reports
 * the pairs that differ. A diff that computed the answer a second way could
 * disagree with the engine, and the diff would be the more convincing lie.
 *
 * Four sections:
 *
 * - **classes** — resolution changes (autonomy, provenance, matched pattern)
 *   over a probe set: every key of either version's `classes` map, plus the
 *   caller's `sampleClasses` (the CLI passes SPEC.md §7's top-level namespaces).
 * - **approvers** — approvers added, removed, or whose channel reachability
 *   changed, plus the class rules left naming an approver the policy no longer
 *   defines. Losing the only human who can be reached for a class is an
 *   availability change disguised as a config tweak.
 * - **defaults** — `autonomy`, `channel`, `approval_ttl`, `on_expiry`.
 * - **budgets** — every `(scope, limit)` pair, old -> new. Scopes are the
 *   `budgets` map's keys plus `classes.<pattern>` for a rule's `limits`.
 *
 * ## Probes are a report, not a proof
 *
 * The class space is infinite; a diff over it cannot be exhaustive. The probe
 * set is stated in the output ({@link PolicyDiff.probes}) precisely so a reader
 * knows what was *not* examined. Wildcard keys (`read.*`) are probed as the
 * literal strings they are, which is the honest thing to do without inventing
 * action classes that nobody declared: both versions are asked the same
 * question, so a difference in the answers is a real difference, and a class
 * outside the probe set may still have changed.
 *
 * ## Fail-closed sides are rendered honestly
 *
 * A side that fails to load is not "an empty policy". It resolves **every**
 * class to `manual` with provenance `fail-closed`, and `resolve()` already says
 * so, so the class section stays truthful with no special case. The structural
 * sections are different: a failed load has no `approvers`, `defaults` or
 * `budgets` to read, and reporting them as removed would assert a change the
 * file never made. So when either side failed, those three sections are empty
 * and {@link PolicyDiff.structuralComparable} is `false`, with
 * {@link PolicyDiff.beforeFailure} / {@link PolicyDiff.afterFailure} carrying
 * the codes a renderer prints as "everything manual (fail-closed: <code>)".
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Probe order is
 * sorted, so the same two loads always produce a byte-identical diff.
 */

import type { Autonomy, Policy, PolicyLoadErrorCode, PolicyLoadResult } from "./policy-load.js";
import { resolve, type Provenance } from "./policy-match.js";

/**
 * SPEC.md §7's reserved top-level namespaces, in table order.
 *
 * Exported here rather than in the CLI because they are a fact about the spec's
 * taxonomy, not about a command's flags, and because a diff that only probed
 * the classes a policy happens to name would go quiet on exactly the edit that
 * matters most: one that *stops* naming a dangerous namespace and lets it fall
 * through to `defaults.autonomy`.
 */
export const SPEC_NAMESPACES: readonly string[] = [
  "read.*",
  "files.write.*",
  "communicate.*",
  "calendar.write.*",
  "financial.*",
  "public.*",
  "data.delete",
  "account.*",
  "physical.*",
  "record.*",
];

/** One version's answer for one probe class. */
export interface ResolutionSnapshot {
  autonomy: Autonomy;
  provenance: Provenance;
  /** The pattern that matched, or `null` for a default / fail-closed answer. */
  pattern: string | null;
}

/** A probe class whose resolution differs between the two versions. */
export interface ClassResolutionChange {
  /** The probe string that was resolved under both versions. */
  class: string;
  before: ResolutionSnapshot;
  after: ResolutionSnapshot;
}

/** How an approver entry changed. */
export type ApproverChangeKind = "added" | "removed" | "channels-changed";

/** An approver added, removed, or re-channelled. */
export interface ApproverChange {
  approver: string;
  change: ApproverChangeKind;
  /** Channels before; `null` when the approver did not exist. */
  beforeChannels: string[] | null;
  /** Channels after; `null` when the approver no longer exists. */
  afterChannels: string[] | null;
  /**
   * Class patterns in the AFTER policy that still name this approver although
   * the AFTER `approvers` map no longer defines them — a rule whose decider is
   * reachable on nothing.
   *
   * `policy.schema.json` already forbids an approver with an empty `channels`
   * list ("an approver reachable nowhere can never grant"), so the only
   * reachability hole a *loadable* policy can have is this dangling reference:
   * the schema says explicitly that the rule-to-approver cross-reference is a
   * runtime check, not a schema constraint. Empty for every other change.
   */
  danglingRules: string[];
}

/** A `defaults` field whose value changed. `null` means "absent". */
export interface DefaultsChange {
  field: "autonomy" | "channel" | "approval_ttl" | "on_expiry";
  before: string | null;
  after: string | null;
}

/** A budget or class limit whose value changed. `null` means "absent". */
export interface BudgetChange {
  /** `budgets` key (e.g. `global`) or `classes.<pattern>` for a rule limit. */
  scope: string;
  /** The limit's name, e.g. `daily_usd`, `daily_actions`, `max_usd`. */
  limit: string;
  before: number | null;
  after: number | null;
}

/** The result of {@link diffPolicies}. Frozen shape: the CLI prints it as JSON. */
export interface PolicyDiff {
  /** Non-null when the BEFORE side failed to load: everything was manual. */
  beforeFailure: { code: PolicyLoadErrorCode; message: string } | null;
  /** Non-null when the AFTER side failed to load: everything becomes manual. */
  afterFailure: { code: PolicyLoadErrorCode; message: string } | null;
  /**
   * False when either side failed to load, in which case `approvers`,
   * `defaults` and `budgets` are empty because a failed load has no structure
   * to compare — not because nothing changed.
   */
  structuralComparable: boolean;
  /** Every probe class that was resolved, sorted; the stated scope of the diff. */
  probes: string[];
  classes: ClassResolutionChange[];
  approvers: ApproverChange[];
  defaults: DefaultsChange[];
  budgets: BudgetChange[];
  /** True when no section reported a change. */
  unchanged: boolean;
}

const DEFAULT_FIELDS: ReadonlyArray<DefaultsChange["field"]> = [
  "autonomy",
  "channel",
  "approval_ttl",
  "on_expiry",
];

function policyOf(load: PolicyLoadResult): Policy | null {
  return load.ok ? load.policy : null;
}

function failureOf(
  load: PolicyLoadResult,
): { code: PolicyLoadErrorCode; message: string } | null {
  return load.ok ? null : { code: load.code, message: load.message };
}

function snapshot(load: PolicyLoadResult, probe: string): ResolutionSnapshot {
  const resolution = resolve(load, probe);
  return {
    autonomy: resolution.autonomy,
    provenance: resolution.provenance,
    pattern: resolution.matched?.pattern ?? null,
  };
}

function sameSnapshot(a: ResolutionSnapshot, b: ResolutionSnapshot): boolean {
  return a.autonomy === b.autonomy && a.provenance === b.provenance && a.pattern === b.pattern;
}

/** Sorted, de-duplicated union of the given string lists. */
function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const item of list) seen.add(item);
  return [...seen].sort();
}

function classKeys(policy: Policy | null): string[] {
  return policy?.classes === undefined ? [] : Object.keys(policy.classes);
}

function channelsOf(policy: Policy | null, approver: string): string[] | null {
  const entry = policy?.approvers?.[approver];
  return entry === undefined ? null : [...entry.channels];
}

function sameChannels(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function defaultValue(policy: Policy | null, field: DefaultsChange["field"]): string | null {
  const defaults = policy?.defaults;
  if (defaults === undefined) return null;
  const value = defaults[field];
  return value === undefined ? null : String(value);
}

/**
 * Key separator for the `(scope, limit)` table below. A control character, not
 * a dot or a space: scope names come from a policy file and limit names are
 * open-ended (SPEC.md §7's taxonomy grows), so any printable separator could
 * one day appear inside a key and split it in the wrong place.
 */
const SEPARATOR = "\u0000";

/**
 * Every `(scope, limit)` pair a policy declares: `budgets.<scope>.<limit>`
 * flattened to `(scope, limit)`, and each class rule's `limits` flattened to
 * `(classes.<pattern>, limit)`.
 */
function limitTable(policy: Policy | null): Map<string, number> {
  const table = new Map<string, number>();
  if (policy === null) return table;
  for (const [scope, entry] of Object.entries(policy.budgets ?? {})) {
    for (const [limit, value] of Object.entries(entry)) {
      if (typeof value === "number") table.set(`${scope}${SEPARATOR}${limit}`, value);
    }
  }
  for (const [pattern, rule] of Object.entries(policy.classes ?? {})) {
    for (const [limit, value] of Object.entries(rule.limits ?? {})) {
      table.set(`classes.${pattern}${SEPARATOR}${limit}`, value);
    }
  }
  return table;
}

/** Class patterns whose rule names `approver`, sorted. */
function rulesNaming(policy: Policy | null, approver: string): string[] {
  const patterns: string[] = [];
  for (const [pattern, rule] of Object.entries(policy?.classes ?? {})) {
    if ((rule.approvers ?? []).includes(approver)) patterns.push(pattern);
  }
  return patterns.sort();
}

function diffApprovers(before: Policy | null, after: Policy | null): ApproverChange[] {
  const names = union(
    Object.keys(before?.approvers ?? {}),
    Object.keys(after?.approvers ?? {}),
  );
  const changes: ApproverChange[] = [];
  for (const approver of names) {
    const beforeChannels = channelsOf(before, approver);
    const afterChannels = channelsOf(after, approver);
    if (sameChannels(beforeChannels, afterChannels)) continue;
    const change: ApproverChangeKind =
      beforeChannels === null ? "added" : afterChannels === null ? "removed" : "channels-changed";
    changes.push({
      approver,
      change,
      beforeChannels,
      afterChannels,
      danglingRules: afterChannels === null ? rulesNaming(after, approver) : [],
    });
  }
  return changes;
}

function diffDefaults(before: Policy | null, after: Policy | null): DefaultsChange[] {
  const changes: DefaultsChange[] = [];
  for (const field of DEFAULT_FIELDS) {
    const previous = defaultValue(before, field);
    const next = defaultValue(after, field);
    if (previous === next) continue;
    changes.push({ field, before: previous, after: next });
  }
  return changes;
}

function diffBudgets(before: Policy | null, after: Policy | null): BudgetChange[] {
  const beforeTable = limitTable(before);
  const afterTable = limitTable(after);
  const keys = union([...beforeTable.keys()], [...afterTable.keys()]);
  const changes: BudgetChange[] = [];
  for (const key of keys) {
    const previous = beforeTable.get(key) ?? null;
    const next = afterTable.get(key) ?? null;
    if (previous === next) continue;
    const separator = key.indexOf(SEPARATOR);
    changes.push({
      scope: key.slice(0, separator),
      limit: key.slice(separator + 1),
      before: previous,
      after: next,
    });
  }
  return changes;
}

/**
 * Diff two loaded policies by what the engine answers under each.
 *
 * `before` and `after` are whole {@link PolicyLoadResult}s, failures included —
 * see the module header for why a failed side is reported rather than treated
 * as empty. `sampleClasses` widens the probe set beyond the two policies' own
 * class keys; the CLI supplies {@link SPEC_NAMESPACES}.
 */
export function diffPolicies(
  before: PolicyLoadResult,
  after: PolicyLoadResult,
  sampleClasses: readonly string[] = [],
): PolicyDiff {
  const beforePolicy = policyOf(before);
  const afterPolicy = policyOf(after);

  const probes = union(classKeys(beforePolicy), classKeys(afterPolicy), sampleClasses);
  const classes: ClassResolutionChange[] = [];
  for (const probe of probes) {
    const previous = snapshot(before, probe);
    const next = snapshot(after, probe);
    if (sameSnapshot(previous, next)) continue;
    classes.push({ class: probe, before: previous, after: next });
  }

  const structuralComparable = before.ok && after.ok;
  const approvers = structuralComparable ? diffApprovers(beforePolicy, afterPolicy) : [];
  const defaults = structuralComparable ? diffDefaults(beforePolicy, afterPolicy) : [];
  const budgets = structuralComparable ? diffBudgets(beforePolicy, afterPolicy) : [];

  return {
    beforeFailure: failureOf(before),
    afterFailure: failureOf(after),
    structuralComparable,
    probes,
    classes,
    approvers,
    defaults,
    budgets,
    unchanged:
      classes.length === 0 &&
      approvers.length === 0 &&
      defaults.length === 0 &&
      budgets.length === 0,
  };
}

/**
 * Render a {@link PolicyDiff} as the lines the CLI prints.
 *
 * Lives beside the diff rather than in the CLI for the same reason
 * `decisionPath` lives in `policy-explain.ts`: the human rendering and the
 * machine shape must be derived from one value, or they will eventually
 * disagree about what changed.
 */
export function renderDiff(diff: PolicyDiff): string[] {
  const lines: string[] = [];

  if (diff.beforeFailure !== null) {
    lines.push(
      `before: everything manual (fail-closed: ${diff.beforeFailure.code}) — ${diff.beforeFailure.message}`,
    );
  }
  if (diff.afterFailure !== null) {
    lines.push(
      `after: everything manual (fail-closed: ${diff.afterFailure.code}) — ${diff.afterFailure.message}`,
    );
  }

  if (diff.unchanged) {
    lines.push(`no semantic change over ${diff.probes.length} probed class(es)`);
    return lines;
  }

  if (diff.classes.length > 0) {
    lines.push(`class resolutions changed (${diff.classes.length}):`);
    for (const change of diff.classes) {
      lines.push(
        `  ${change.class}: ${describeSnapshot(change.before)} -> ${describeSnapshot(change.after)}`,
      );
    }
  }
  if (diff.approvers.length > 0) {
    lines.push(`approvers changed (${diff.approvers.length}):`);
    for (const change of diff.approvers) {
      lines.push(
        `  ${change.approver}: ${change.change} [${(change.beforeChannels ?? []).join(", ")}] -> [${(
          change.afterChannels ?? []
        ).join(", ")}]${
          change.danglingRules.length === 0
            ? ""
            : ` (UNREACHABLE: still named by ${change.danglingRules.join(", ")})`
        }`,
      );
    }
  }
  if (diff.defaults.length > 0) {
    lines.push(`defaults changed (${diff.defaults.length}):`);
    for (const change of diff.defaults) {
      lines.push(`  ${change.field}: ${change.before ?? "(absent)"} -> ${change.after ?? "(absent)"}`);
    }
  }
  if (diff.budgets.length > 0) {
    lines.push(`limits changed (${diff.budgets.length}):`);
    for (const change of diff.budgets) {
      lines.push(
        `  ${change.scope}.${change.limit}: ${change.before ?? "(absent)"} -> ${change.after ?? "(absent)"}`,
      );
    }
  }
  if (!diff.structuralComparable) {
    lines.push(
      "approvers, defaults and limits were NOT compared: a policy that fails to load has no structure to read, and reporting it as empty would claim removals that never happened",
    );
  }
  return lines;
}

function describeSnapshot(snap: ResolutionSnapshot): string {
  const source =
    snap.pattern === null ? snap.provenance : `${snap.provenance} ${snap.pattern}`;
  return `${snap.autonomy} (${source})`;
}
