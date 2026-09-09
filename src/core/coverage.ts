/**
 * Coverage of observed side effects (APRV-245, SPEC.md §10.1).
 *
 * ## Why a verb that witnesses rather than gates
 *
 * MCP use is voluntary. An agent connected to `approval mcp serve --http` can
 * call `request`, `wait` and `run`, or it can simply act. Nothing in this
 * runtime observes the act, because the runtime is not in the path: a gate an
 * agent may route around reports only on the actions routed through it, and a
 * report that counts only its own inputs is a report that cannot go down.
 *
 * What makes the arrangement honest is that side effects leave witnesses THIS
 * PROJECT DOES NOT WRITE. Git history records commits, merges and tags. `gh`
 * records pull requests. AgentMail records the messages an inbox actually sent.
 * None of those are appended by approval.md, none of them are reachable by an
 * agent editing its own log, and each of them can be read back and joined
 * against the verified records to ask one question per effect: does the log say
 * a human, or a policy, ever saw this?
 *
 * This module is that join, and nothing else. It performs no IO, reads no clock,
 * spawns nothing and appends nothing. The sources under `coverage-sources/`
 * gather the effects; `cli/coverage.ts` prints the answer.
 *
 * ## What counts as evidence, stated exactly
 *
 * The strongest answer first (APRV-251): an `execution.completed` may carry
 * `payload.provider_ref`, the identifier the provider filed the effect under
 * (SPEC.md §8), and an effect whose source and id match one is covered by that
 * record, reported as `provider-ref`. No window is applied to it, because an id
 * names one effect and a class in a span of time names a period. That is the
 * whole difference the reference buys: without it, a gated send covers an
 * ungated one of the same class sitting beside it in the window, and with it
 * the log answers about the message actually in front of the reader.
 *
 * Otherwise, for one {@link ObservedEffect}, evidence is the EARLIEST record
 * that is all three of:
 *
 * 1. one of `task.registered`, `approval.granted`, `execution.started`,
 *    `execution.completed` — the four records that mean "this runtime was told
 *    about an action of this class", from the declaration through the human's
 *    decision to the spend;
 * 2. of a matching class: EXACT first ({@link classesOf} against the effect's
 *    class), and only if nothing matches exactly, a FAMILY match on the first
 *    two dotted segments, reported distinctly as `family` so a reader is never
 *    shown a weaker match dressed as a strong one;
 * 3. inside the window `[at - 24h, at + 5m]`.
 *
 * The window is asymmetric on purpose and both halves are arguable, so both are
 * written down. **24 hours back**, because the ordinary shape is register →
 * request → grant → act, and the gap between the human's tap and the effect is
 * a working day at worst; a week back would let one grant carry every later
 * effect of its class, which is the laundering hole APRV-202 closed in the
 * protected-path guard. **5 minutes forward**, because that is clock skew
 * between git's author date (or a provider's timestamp) and this log, and not an
 * ordering allowance: a record appended an hour after an effect is a record
 * about some other action, whatever its class.
 *
 * The one place this rule is not used is a protected FILE path. Those already
 * have a stronger answer: `core/protected-path-guard.ts` matches a change's
 * BYTES against the material a grant bound, and its `attested` and
 * `granted-file` verdicts are content-level rather than time-level. So an effect
 * carrying a `path` takes the guard's verdict when the caller supplies a report
 * that covers it, and the class-and-window rule is what everything else gets.
 *
 * ## Verified records only, and no writes
 *
 * The caller reads through `readVerifiedRecords` (SPEC.md §11.1 invariant 1);
 * this function is handed records that already passed chain verification and has
 * no way to read any others. It writes nothing anywhere, which is what lets it be
 * informational: the whole report is derived, and running it changes no state
 * that any later verdict depends on.
 *
 * ## What a green line does NOT say
 *
 * Coverage is a witness, not a control. An effect made with a credential the
 * AGENT itself holds — an API key pasted into a chat surface, a token in a
 * shell profile — leaves a witness only where the provider keeps one this verb
 * can read. The remedy for that tier is custody (SPEC.md §10.4: adapters hold
 * the credentials and answer only to a token), not a bigger report, and
 * `docs/cli-reference.md#coverage` writes the three tiers out so that a green
 * coverage line is never read as the claim that nothing else happened.
 */

import type { EventRecord } from "./log.js";
import type { GuardReport } from "./protected-path-guard.js";
import { payloadOf } from "./state.js";

/**
 * One side effect a witness outside this runtime recorded.
 *
 * Every field is a FACT ABOUT THE WORLD, gathered from git, `gh` or a provider,
 * and none of it is self-reported by the party under oversight. `actorHint` is
 * named a hint deliberately: a commit author email is whatever the committer
 * configured, so it is printed for a reader and never matched on (SPEC.md §11.1
 * invariant 4 — a self-reported field never reduces scrutiny).
 */
export interface ObservedEffect {
  /** Which source saw it: `git`, `gh`, `agentmail`. */
  source: string;
  /** The witness's own identifier: a commit sha, a PR number, a message id. */
  id: string;
  /** The side-effect class (SPEC.md §7) this effect would have been declared under. */
  class: string;
  /** When the witness says it happened, RFC 3339. */
  at: string;
  /** Who the witness says did it, or `null`. Printed, never matched on. */
  actorHint: string | null;
  /** One line a person can read. Never a message body, never a secret. */
  detail: string;
  /** For a file effect, the repository-relative path it changed. */
  path?: string;
}

/**
 * The span an observation covers, as two RFC 3339 instants.
 *
 * Both ends are supplied by the caller and neither is read from a clock here,
 * so two runs over the same window ask every provider the same question.
 */
export interface ObservationWindow {
  since: string;
  until: string;
}

/**
 * What the log says about one effect.
 *
 * `null` is a GAP: no record of a matching class sits in the window. The two
 * shapes carry different kinds of proof, so they are different shapes rather
 * than one object with optional halves — a record seq is something a reader can
 * paste into `approval log tail`, and a guard verdict is a statement about
 * bytes.
 */
export type Evidence =
  | { seq: number; event: string }
  | { verdict: "attested" | "granted-file" }
  | null;

/** How the evidence was found, so a weaker match is never read as a stronger one. */
export type CoverageMatch =
  /**
   * An `execution.completed` names this exact effect by the provider's own
   * identifier (APRV-251). The strongest answer this join can give: it is about
   * one effect rather than about a class in a span of time.
   */
  | "provider-ref"
  /** The record's declared class equals the effect's class. */
  | "exact"
  /** Only the class FAMILY matched (the first two dotted segments). */
  | "family"
  /** The protected-path guard answered for this path, on bytes rather than time. */
  | "protected-path"
  /** Nothing matched. `evidence` is `null`. */
  | "none";

/** One effect, and what the log had to say about it. */
export interface CoverageEntry {
  effect: ObservedEffect;
  evidence: Evidence;
  match: CoverageMatch;
}

/** Observed and covered counts for one grouping key. */
export interface CoverageTotals {
  key: string;
  observed: number;
  covered: number;
}

export interface CoverageReport {
  entries: readonly CoverageEntry[];
  /** Totals per source, sorted by source name. */
  bySource: readonly CoverageTotals[];
  /** Totals per class, sorted by class name. */
  byClass: readonly CoverageTotals[];
  observed: number;
  covered: number;
}

/** How far BACK of an effect a record may sit and still be about it: 24 hours. */
export const COVERAGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How far AHEAD of an effect a record may sit: five minutes.
 *
 * A skew allowance between two clocks, not an ordering allowance. See the
 * module note for why the window is asymmetric.
 */
export const COVERAGE_AHEAD_MS = 5 * 60 * 1000;

/** The record types that can be evidence, in the order they occur in a life. */
export const EVIDENCE_EVENTS: readonly string[] = [
  "task.registered",
  "approval.granted",
  "execution.started",
  "execution.completed",
];

export interface CoverageOptions {
  /** Override {@link COVERAGE_LOOKBACK_MS}. */
  lookbackMs?: number;
  /** Override {@link COVERAGE_AHEAD_MS}. */
  aheadMs?: number;
  /**
   * The protected-path guard's report for the same range, when the caller ran
   * one. An effect whose `path` has a passing finding there takes that verdict
   * instead of the class-and-window rule: it is content-level evidence, and
   * content beats time.
   */
  guard?: GuardReport | null;
}

/**
 * The classes a record declares, as a set.
 *
 * Four shapes, because four record types say it four ways and one reader is
 * better than four:
 *
 * - `payload.class` — what `approval.requested`, `approval.granted` and
 *   `execution.started` carry;
 * - `payload.actions[].class` — what `task.registered` carries, because one
 *   registration declares every action of the task;
 * - the class of the `execution.started` sharing this record's `action_key`,
 *   for an `execution.completed`, which records an outcome and not a class;
 * - nothing, for a record that declares none. Such a record is evidence for no
 *   effect, which is the fail-closed direction: an unclassified record must not
 *   cover an effect of a class it never named.
 */
function classesOf(record: EventRecord, startedClasses: Map<string, Set<string>>): Set<string> {
  const found = new Set<string>();
  const payload = payloadOf(record);
  const direct = payload["class"];
  if (typeof direct === "string" && direct.length > 0) found.add(direct);
  const actions = payload["actions"];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (typeof action !== "object" || action === null || Array.isArray(action)) continue;
      const cls = (action as Record<string, unknown>)["class"];
      if (typeof cls === "string" && cls.length > 0) found.add(cls);
    }
  }
  if (found.size === 0) {
    const key = record.action_key;
    if (typeof key === "string") {
      for (const cls of startedClasses.get(key) ?? []) found.add(cls);
    }
  }
  return found;
}

/**
 * The family of a class: its first two dotted segments.
 *
 * `vcs.push.main` and `vcs.push.branch` are one family; `vcs.push.main` and
 * `vcs.commit.branch` are not. Two segments rather than one, because a single
 * segment would make every `vcs.*` record evidence for every other, and the
 * pushes and the commits are different decisions. A class with fewer than two
 * segments is its own family.
 */
export function classFamily(cls: string): string {
  const parts = cls.split(".");
  return parts.length <= 2 ? cls : `${parts[0] as string}.${parts[1] as string}`;
}

/**
 * The provider references the log carries, keyed by adapter and id (APRV-251).
 *
 * Built from `execution.completed` records alone, because that is the only event
 * SPEC.md §8 lets carry one. EARLIEST wins, on the same reasoning the
 * class-and-window rule uses: records arrive in seq order, and a later record
 * naming the same effect cannot improve on the first one that did.
 *
 * The key is the pair. An id alone would let one provider's identifier be read
 * as evidence about another provider's effect that happens to share the string,
 * and the pair costs nothing: the source name a witness reports (`agentmail`) is
 * the adapter name the contract wrote (`agentmail`), because the same adapter is
 * both the executor and the observer. A source whose name does not match the
 * adapter that executed simply falls through to the class-and-window rule, which
 * is the weaker answer rather than a wrong one.
 */
function providerRefIndex(records: readonly EventRecord[]): Map<string, { seq: number; event: string }> {
  const found = new Map<string, { seq: number; event: string }>();
  for (const record of records) {
    if (record.event !== "execution.completed") continue;
    const ref = payloadOf(record)["provider_ref"];
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const { adapter, id } = ref as Record<string, unknown>;
    if (typeof adapter !== "string" || adapter.length === 0) continue;
    if (typeof id !== "string" || id.length === 0) continue;
    const key = providerRefKey(adapter, id);
    if (!found.has(key)) found.set(key, { seq: record.seq, event: record.event });
  }
  return found;
}

/** The index key: a NUL separator, which neither half can contain. */
function providerRefKey(adapter: string, id: string): string {
  return `${adapter}\u0000${id}`;
}

/** The guard's verdict for `path`, or `null` when the report has none that passed. */
function guardVerdict(
  guard: GuardReport | null | undefined,
  path: string | undefined,
): "attested" | "granted-file" | null {
  if (guard === undefined || guard === null || path === undefined) return null;
  for (const finding of guard.findings) {
    if (finding.path !== path || !finding.ok) continue;
    // `granted-command` is deliberately not surfaced here. It is the guard's
    // weakest verdict — a run attributed by time rather than by bytes — and
    // reporting it beside `attested` under one column would flatten exactly the
    // distinction the guard spent its module note drawing. Such a path falls
    // through to the class-and-window rule below, which is the same strength of
    // claim and is labelled as such.
    if (finding.evidence === "attested" || finding.evidence === "granted-file") {
      return finding.evidence;
    }
  }
  return null;
}

/** A timestamp in milliseconds, or `null` when it does not parse. */
function instant(ts: string): number | null {
  const at = Date.parse(ts);
  return Number.isNaN(at) ? null : at;
}

/**
 * Join observed effects against verified records.
 *
 * Deterministic and total: the same effects and the same records produce the
 * same report, in the same order, every time. Entries come back in the order the
 * effects were given, and the totals are sorted by key so that a `--json`
 * consumer can pin the whole object with a `deepEqual`.
 *
 * @param effects what the witnesses outside this runtime saw
 * @param records records that have ALREADY passed chain verification
 */
export function coverageReport(
  effects: readonly ObservedEffect[],
  records: readonly EventRecord[],
  options: CoverageOptions = {},
): CoverageReport {
  const lookbackMs = options.lookbackMs ?? COVERAGE_LOOKBACK_MS;
  const aheadMs = options.aheadMs ?? COVERAGE_AHEAD_MS;

  // One pass to learn which class each action key was started under, so an
  // `execution.completed` (which records an outcome and no class) can be read
  // as evidence for the class its own start declared.
  const startedClasses = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.event !== "execution.started") continue;
    const key = record.action_key;
    const cls = payloadOf(record)["class"];
    if (typeof key !== "string" || typeof cls !== "string" || cls.length === 0) continue;
    const bucket = startedClasses.get(key);
    if (bucket === undefined) startedClasses.set(key, new Set([cls]));
    else bucket.add(cls);
  }

  /** The candidate records, pre-reduced to (seq, event, ts, classes). */
  const candidates = records
    .filter((record) => EVIDENCE_EVENTS.includes(record.event))
    .map((record) => ({
      seq: record.seq,
      event: record.event as string,
      at: instant(record.ts),
      classes: classesOf(record, startedClasses),
    }))
    .filter((candidate) => candidate.at !== null && candidate.classes.size > 0);

  // APRV-251. Read once, consulted per effect.
  const references = providerRefIndex(records);

  const entries: CoverageEntry[] = [];
  for (const effect of effects) {
    // The id-level answer outranks both the guard's and the window's, and it is
    // the only one of the three that is about this effect rather than about a
    // class, a path or a span of time.
    const named = references.get(providerRefKey(effect.source, effect.id));
    if (named !== undefined) {
      entries.push({ effect, evidence: named, match: "provider-ref" });
      continue;
    }

    const verdict = guardVerdict(options.guard, effect.path);
    if (verdict !== null) {
      entries.push({ effect, evidence: { verdict }, match: "protected-path" });
      continue;
    }

    const when = instant(effect.at);
    if (when === null) {
      // An effect whose timestamp does not parse cannot be placed against any
      // record, and inventing a placement would be the report asserting
      // something no witness said. It is a gap, and it is a gap for a reason a
      // reader can see in the detail line the source wrote.
      entries.push({ effect, evidence: null, match: "none" });
      continue;
    }

    const family = classFamily(effect.class);
    let exact: { seq: number; event: string } | null = null;
    let loose: { seq: number; event: string } | null = null;
    for (const candidate of candidates) {
      const at = candidate.at as number;
      if (at < when - lookbackMs || at > when + aheadMs) continue;
      if (candidate.classes.has(effect.class)) {
        // EARLIEST wins: records arrive in seq order, so the first exact match
        // seen is the earliest one and nothing later can improve on it.
        if (exact === null) exact = { seq: candidate.seq, event: candidate.event };
        break;
      }
      if (loose === null) {
        for (const cls of candidate.classes) {
          if (classFamily(cls) === family) {
            loose = { seq: candidate.seq, event: candidate.event };
            break;
          }
        }
      }
    }

    if (exact !== null) entries.push({ effect, evidence: exact, match: "exact" });
    else if (loose !== null) entries.push({ effect, evidence: loose, match: "family" });
    else entries.push({ effect, evidence: null, match: "none" });
  }

  const bySource = totalsBy(entries, (entry) => entry.effect.source);
  const byClass = totalsBy(entries, (entry) => entry.effect.class);
  return {
    entries,
    bySource,
    byClass,
    observed: entries.length,
    covered: entries.filter((entry) => entry.evidence !== null).length,
  };
}

/** Observed and covered counts per key, sorted by key. */
function totalsBy(
  entries: readonly CoverageEntry[],
  keyOf: (entry: CoverageEntry) => string,
): CoverageTotals[] {
  const totals = new Map<string, CoverageTotals>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const existing = totals.get(key) ?? { key, observed: 0, covered: 0 };
    existing.observed += 1;
    if (entry.evidence !== null) existing.covered += 1;
    totals.set(key, existing);
  }
  return [...totals.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
