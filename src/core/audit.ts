/**
 * The audit lifecycle (SPEC.md §5.2, §9.1, §12): `audit.sampled` →
 * `audit.reviewed` → (on a denial) `reconciliation.required` →
 * `reconciliation.satisfied`.
 *
 * ## What a retrospective denial can and cannot do (amended SPEC.md §5.2, APRV-127)
 *
 * The action already happened. The runtime cannot undo it, and any design that
 * pretended otherwise would be lying to the person who denied it. What it can do
 * is **oblige and record**: a denial appends an obligation naming the action, its
 * class, and the review that denied, and the obligation stays open, and loud,
 * until a HUMAN says it is discharged. Which obligation depends on whether the
 * action was declared reversible — see {@link obligationFor}, including why a
 * self-reported `reversible` may choose the shape and can never remove one.
 *
 * This is also why the autonomy split has a floor. `supervised-retro` refuses an
 * action declaring `reversible: false` (`core/policy-match.ts`'s irreversibility
 * floor pushes it to `manual`), because retrospective review of something that
 * cannot be undone is regret with a paper trail. The floor is a floor and not a
 * proof: it acts on a claim the acting party makes about itself, so it catches
 * the honest declaration and never the lie. The obligation machinery here is what
 * remains when the floor did not apply and the review said no anyway.
 *
 * Two halves, deliberately asymmetric:
 *
 * - **Sampling is the runtime's.** It is mechanical, it is retrospective, and it
 *   escalates a supervised action that already executed into a human's review
 *   queue. {@link sampleSupervised} appends `audit.sampled` with a `system:`
 *   actor. Selection is `core/sampler.ts`'s keyed HMAC, so no agent can predict
 *   or steer it.
 * - **Review is a human's.** {@link reviewSample} appends `audit.reviewed` and
 *   refuses any actor that is not `human:<id>`, by the same rule that governs
 *   `grant`, `reject`, `revoke`, `policy attest`, and `execution resolve`. A
 *   runtime that could mark its own samples reviewed would be a supervision
 *   backlog that empties itself, which is precisely the failure the sampled
 *   backlog exists to make visible.
 *
 * ## Eligibility is derived, never self-reported (global invariant 4)
 *
 * A candidate is an `execution.started` record whose action's class, as recorded
 * in the `task.registered` declaration the log already holds, resolves to
 * `supervised` under the live policy. Two things follow, both load-bearing:
 *
 * - the class comes from the registration record rather than from the
 *   `execution.started` payload, and the autonomy comes from re-running
 *   `core/policy-match.ts` rather than from any field claiming an autonomy. No
 *   payload key an authoring party writes can move an action out of the
 *   candidate set;
 * - eligibility is recomputed from the log every sweep, so it does not depend on
 *   any remembered flag, and a candidate cannot exclude itself by writing
 *   anything into its own event.
 *
 * The manual path is excluded because it never resolves `supervised`: a manual
 * action's start is authorized by a token and its class resolves `manual`, so it
 * is not a candidate and is not double-counted.
 *
 * ## Exactly once, without remembering anything
 *
 * Every sweep re-derives the whole candidate set and subtracts the subjects the
 * log already carries an `audit.sampled` for, keyed on the subject record's
 * `hash` (unique per record by construction, and stable across re-reads). A
 * daemon restart, a second daemon, and a manual sweep all converge on the same
 * set, and none of them can double-sample. Every append passes `expectedHead`,
 * so a check made against one log cannot land on another (SPEC.md §11.1
 * invariant 5).
 *
 * ## Time
 *
 * `audit.*` is gate-typed (SPEC.md §8), so no public function here takes a `ts`:
 * the timestamp is read from the injected clock at the write boundary, and the
 * party being audited does not author the clock it is judged by.
 */

import { tick, type ClockOptions } from "./clock.js";
import { declaringTasks, findDeclaration, hasApprovalCycle } from "./execute.js";
import {
  appendEvent,
  type AppendError,
  type EventRecord,
  type LogHead,
} from "./log.js";
import { loadPolicy, type LoadPolicyOptions, type PolicyLoadResult } from "./policy-load.js";
import { resolve } from "./policy-match.js";
import { resolveSampler, type Sampler } from "./sampler.js";
import { payloadOf, readVerifiedRecords } from "./state.js";
import type { ValidateOptions } from "./validate.js";

/**
 * SPEC.md §8: the sampler is the runtime, so its actor is `system:`. Distinct
 * from `system:gate` (expiries) and `system:daemon` (envelope drift) so a reader
 * can tell which part of the runtime spoke without reading the payload.
 */
export const AUDIT_ACTOR = "system:audit";

/** `human:<id>`, the only actor a review may carry. */
const HUMAN_ACTOR = /^human:.+/u;

/**
 * The closed set of audit refusal codes. Frozen public API in the same sense the
 * gate's and the executor's are: a supervisor branches on these strings, so
 * adding one is a spec change and renaming one is a breaking change.
 */
export const AUDIT_REFUSAL_CODES = [
  /** Review was attempted by an actor that is not `human:<id>`. */
  "actor-not-human",
  /** No `audit.sampled` record matches the subject named. */
  "not-sampled",
  /** That sample already has a later `audit.reviewed`. */
  "already-reviewed",
  /** An action key with more than one unreviewed sample; name the seq instead. */
  "ambiguous-subject",
  /** No `reconciliation.required` record at the seq named (APRV-127). */
  "not-obliged",
  /** That obligation already has a `reconciliation.satisfied` (APRV-127). */
  "already-satisfied",
  /** A satisfaction with no note: an assertion nobody can check (APRV-127). */
  "note-required",
  /**
   * A `gated-revert` obligation whose satisfaction names no completed revert
   * (APRV-127). The obligation is to undo the action THROUGH THE GATE, and the
   * evidence of that is an `execution.completed` in this same log.
   */
  "revert-required",
  /**
   * The denial was recorded and its obligation was not (APRV-127). The log is
   * NOT inconsistent — `audit.reviewed` stands and says `denied` — but the
   * obligation it should have created is missing and must be created by
   * reviewing again once the head settles.
   */
  "obligation-not-appended",
  /** The log could not be read, or holds a line that is not a record. */
  "log-unreadable",
  /** The log's final line is unterminated (a crashed write). */
  "log-torn-tail",
  /** The chain does not verify; nothing is derived from an untrustworthy log. */
  "log-corrupt",
  /** The append itself failed; `append` carries the underlying error. */
  "append-failed",
] as const;

export type AuditRefusalCode = (typeof AUDIT_REFUSAL_CODES)[number];

export interface AuditRefusal {
  ok: false;
  code: AuditRefusalCode;
  message: string;
  /** The seq of the record that produced the refusal, when there is one. */
  seq?: number;
  /** The underlying append error, when `code` is `append-failed`. */
  append?: AppendError;
}

/** Options shared by the audit verbs. No `ts`: `audit.*` is gate-typed. */
export interface AuditOptions extends ClockOptions, ValidateOptions {
  /** Policy location, with `loadPolicy`'s semantics. */
  policy?: { dir?: string; file?: string };
  /** Environment the sampling secret is read from. Injected by tests. */
  env?: NodeJS.ProcessEnv;
}

function refuse(code: AuditRefusalCode, message: string, extra: Partial<AuditRefusal> = {}): AuditRefusal {
  return { ok: false, code, message, ...extra };
}

function policyFor(options: AuditOptions, cwd: string): PolicyLoadResult {
  const where: LoadPolicyOptions =
    options.policy?.file !== undefined
      ? { file: options.policy.file }
      : { dir: options.policy?.dir ?? cwd };
  if (options.schemaDir !== undefined) where.schemaDir = options.schemaDir;
  return loadPolicy(where);
}

// ---------------------------------------------------------------------------
// Projections (pure)
// ---------------------------------------------------------------------------

/** One supervised execution eligible for retrospective review. */
export interface AuditCandidate {
  /** `seq` of the `execution.started` record. */
  seq: number;
  /** `hash` of that record: the HMAC input and the dedupe key. */
  hash: string;
  ts: string;
  actionKey: string;
  task: string | null;
  /** The class the registration declared, re-resolved to `supervised`. */
  class: string;
}

/**
 * Every `execution.started` whose action resolves `supervised` under `load`, in
 * log order.
 *
 * Pure: no I/O, no clock, no environment. Records with no action key, and keys
 * no `task.registered` record declares, are skipped rather than guessed at — an
 * undeclared key has no class, and inventing one would put a fact in the sample
 * that nobody wrote.
 */
export function supervisedExecutions(
  records: readonly EventRecord[],
  load: PolicyLoadResult,
): AuditCandidate[] {
  const all = records as EventRecord[];
  const autonomyByClass = new Map<string, string>();
  const candidates: AuditCandidate[] = [];

  for (const record of all) {
    if (record.event !== "execution.started") continue;
    const actionKey = record.action_key;
    if (typeof actionKey !== "string" || actionKey.length === 0) continue;

    // A key declared by more than one task is a refused collision (APRV-138);
    // do not sample from an ambiguous declaration.
    if (declaringTasks(all, actionKey).length > 1) continue;

    // APRV-127. An action a human was already asked about is not a candidate for
    // review of an unreviewed decision — there was a decision. The case is a
    // `supervised-live` action the live draw selected: it executed on a grant,
    // through the manual path, and its class still resolves `supervised`, so
    // without this line it would be drawn a second time into a backlog asking a
    // person to review the answer they themselves gave. Costs nothing for every
    // other supervised action, which never carries an approval cycle.
    if (hasApprovalCycle(all, actionKey)) continue;
    const declared = findDeclaration(all, actionKey);
    if (declared === null) continue;

    let autonomy = autonomyByClass.get(declared.class);
    if (autonomy === undefined) {
      autonomy = resolve(load, declared.class).autonomy;
      autonomyByClass.set(declared.class, autonomy);
    }
    if (autonomy !== "supervised") continue;

    candidates.push({
      seq: record.seq,
      hash: record.hash,
      ts: record.ts,
      actionKey,
      task: typeof record.task === "string" ? record.task : declared.task,
      class: declared.class,
    });
  }
  return candidates;
}

/** One `audit.sampled` record, with the review that closes it (or none). */
export interface SampledSubject {
  /** `seq` of the `audit.sampled` record itself. */
  seq: number;
  ts: string;
  actionKey: string | null;
  task: string | null;
  /** `hash` of the subject record the sample named, when it named one. */
  subjectHash: string | null;
  /** `seq` of the subject record the sample named, when it named one. */
  subjectSeq: number | null;
  /** `seq` of the later `audit.reviewed`, or `null` when still open. */
  reviewedSeq: number | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Every `audit.sampled` in the log, each tagged with the `audit.reviewed` that
 * closes it.
 *
 * A review closes a sample only when it comes **after** it in the chain and
 * names the same action key. An earlier review is a review of an earlier sample;
 * treating it as covering this one would silently empty the backlog, which is
 * exactly the failure a sampled-audit backlog exists to prevent. This mirrors
 * `channels/render-queue.ts`'s matching rule, so the CLI and the queue
 * projection never disagree about what is outstanding.
 */
export function sampledSubjects(records: readonly EventRecord[]): SampledSubject[] {
  const subjects: SampledSubject[] = [];
  for (const record of records) {
    if (record.event !== "audit.sampled") continue;
    const payload = payloadOf(record);
    const actionKey = stringOrNull(record.action_key) ?? stringOrNull(payload["action_key"]);
    const subjectSeq = payload["subject_seq"];
    subjects.push({
      seq: record.seq,
      ts: record.ts,
      actionKey,
      task: stringOrNull(record.task) ?? stringOrNull(payload["task"]),
      subjectHash: stringOrNull(payload["subject_hash"]),
      subjectSeq:
        typeof subjectSeq === "number" && Number.isInteger(subjectSeq) ? subjectSeq : null,
      reviewedSeq: null,
    });
  }

  for (const subject of subjects) {
    for (const record of records) {
      if (record.event !== "audit.reviewed" || record.seq <= subject.seq) continue;
      const payload = payloadOf(record);
      const key = stringOrNull(record.action_key) ?? stringOrNull(payload["action_key"]);
      const reviewedSeq = payload["subject_seq"];
      const namesThisSample =
        typeof reviewedSeq === "number" && reviewedSeq === subject.seq
          ? true
          : subject.actionKey !== null && key !== null && key === subject.actionKey;
      if (!namesThisSample) continue;
      subject.reviewedSeq = record.seq;
      break;
    }
  }
  return subjects;
}

/** Samples with no later review, oldest first. The human's audit backlog. */
export function openSamples(records: readonly EventRecord[]): SampledSubject[] {
  return sampledSubjects(records).filter((subject) => subject.reviewedSeq === null);
}

/** The candidates a sweep would sample now: eligible, selected, not yet sampled. */
export function pendingSamples(
  records: readonly EventRecord[],
  load: PolicyLoadResult,
  sampler: Sampler,
): AuditCandidate[] {
  if (!sampler.enabled) return [];
  const alreadySampled = new Set<string>();
  for (const subject of sampledSubjects(records)) {
    if (subject.subjectHash !== null) alreadySampled.add(subject.subjectHash);
  }
  // APRV-183. The draw is per class: a class declaring its own `retro_rate` is
  // compared against that rate, and one that declares none against
  // `audit.supervised_sample_rate`. Same secret, same HMAC, same input; only the
  // threshold moves, so there is still exactly one selection mechanism.
  return supervisedExecutions(records, load).filter(
    (candidate) =>
      !alreadySampled.has(candidate.hash) &&
      sampler.selectsFor(candidate.class, candidate.hash),
  );
}

// ---------------------------------------------------------------------------
// sampleSupervised
// ---------------------------------------------------------------------------

/** One `audit.sampled` this sweep appended. */
export interface SampleAppended {
  record: EventRecord;
  candidate: AuditCandidate;
}

export interface SampleSweepResult {
  ok: true;
  /** The sampler in force. Carries the reason when sampling is off. */
  sampler: Sampler;
  appended: SampleAppended[];
  /** Appends that were refused. Reported, never retried in place. */
  refusals: AuditRefusal[];
}

export type SampleResult = SampleSweepResult | AuditRefusal;

/**
 * Sample every supervised execution the log does not yet carry an
 * `audit.sampled` for, and append one event per selection.
 *
 * Re-reads the verified log before every append so the head each
 * compare-and-append is made against is the head the decision was made from. A
 * `head-moved` refusal is collected and reported rather than retried: only the
 * next sweep, which re-derives the whole question from the log as it now is,
 * knows whether the candidate is still a candidate.
 *
 * Returns `ok` with an empty `appended` list when sampling is disabled; the
 * reason travels on `sampler`. A disabled sampler is not a refusal, because
 * nothing was asked for and nothing failed. See `core/sampler.ts` on why a
 * missing secret disables sampling rather than escalating everything.
 */
export function sampleSupervised(
  logPath: string,
  cwd: string,
  options: AuditOptions = {},
): SampleResult {
  const load = policyFor(options, cwd);
  const sampler = resolveSampler(load, options.env ?? process.env);
  if (!sampler.enabled) return { ok: true, sampler, appended: [], refusals: [] };

  const appended: SampleAppended[] = [];
  const refusals: AuditRefusal[] = [];
  const validate: ValidateOptions =
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir };

  for (;;) {
    const read = readVerifiedRecords(logPath, validate);
    if (!read.ok) {
      // A log that cannot be read is reported whole: partial progress is already
      // in the log (each append is its own record) and nothing is rolled back.
      return appended.length === 0
        ? refuse(read.code, read.message)
        : { ok: true, sampler, appended, refusals: [...refusals, refuse(read.code, read.message)] };
    }

    const pending = pendingSamples(read.records, load, sampler);
    const next = pending.find(
      (candidate) => !appended.some((done) => done.candidate.hash === candidate.hash),
    );
    if (next === undefined) break;

    const result = appendSample(logPath, next, sampler, read.head, options);
    if (!result.ok) {
      refusals.push(result);
      break;
    }
    appended.push({ record: result.record, candidate: next });
  }

  return { ok: true, sampler, appended, refusals };
}

function appendSample(
  logPath: string,
  candidate: AuditCandidate,
  sampler: Sampler & { enabled: true },
  head: LogHead | null,
  options: AuditOptions,
): { ok: true; record: EventRecord } | AuditRefusal {
  const payload: Record<string, unknown> = {
    // What was sampled, named by the chain's own identifiers so a reviewer (and
    // a reproducing operator) can find the subject without a projection.
    subject_seq: candidate.seq,
    subject_hash: candidate.hash,
    subject_event: "execution.started",
    subject_ts: candidate.ts,
    class: candidate.class,
    // Why it was sampled. The selection VALUE is deliberately absent: it is
    // derived from the operator's secret, an operator holding the secret can
    // recompute it from subject_hash at will, and a value in the log is an
    // oracle nobody needs.
    reason: "supervised-sample",
    selection: "hmac-sha256/event-hash",
    // APRV-183: the rate this candidate was actually drawn at — the class's own
    // `retro_rate` when it declared one, the global fallback otherwise. The
    // record states the number the verdict was compared against, so a
    // reproducing operator needs no second lookup and no guess about which key
    // was in force.
    rate: sampler.rateFor(candidate.class).rate ?? sampler.rate,
    autonomy: "supervised",
  };

  const result = appendEvent(
    logPath,
    {
      ts: tick(options),
      event: "audit.sampled",
      actor: AUDIT_ACTOR,
      ...(candidate.task === null ? {} : { task: candidate.task }),
      action_key: candidate.actionKey,
      payload,
    },
    {
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      expectedHead: head,
    },
  );
  if (!result.ok) {
    return refuse(
      "append-failed",
      `audit.sampled for ${candidate.actionKey} was not appended (${result.error.code}): ${result.error.message}`,
      { append: result.error },
    );
  }
  return { ok: true, record: result.record };
}

// ---------------------------------------------------------------------------
// reviewSample
// ---------------------------------------------------------------------------

/** How a caller named the sample to review. */
export type SubjectRef =
  | { kind: "seq"; seq: number }
  | { kind: "action-key"; actionKey: string };

/** Parse the CLI's one positional: a bare integer is a seq, anything else a key. */
export function parseSubjectRef(text: string): SubjectRef {
  return /^[1-9][0-9]*$/u.test(text)
    ? { kind: "seq", seq: Number(text) }
    : { kind: "action-key", actionKey: text };
}

export interface ReviewResult {
  ok: true;
  record: EventRecord;
  subject: SampledSubject;
  /**
   * The `reconciliation.required` this review created, on a denial only
   * (APRV-127). `null` for an `ok` verdict, which obliges nothing.
   */
  obligation: EventRecord | null;
}

/** What a reviewer concluded (amended SPEC.md §5.2, APRV-127). */
export type ReviewVerdict = "ok" | "denied";

/** The shape a denial's obligation takes. */
export type Obligation = "gated-revert" | "policy-finding";

export interface ReviewOptions extends AuditOptions {
  /**
   * The verdict. Defaults to `"ok"`: a review whose caller says nothing about
   * what it concluded records the observation it always did, and the ABSENCE of
   * a verdict is never read as a denial.
   */
  verdict?: ReviewVerdict;
}

/**
 * The obligation a denial creates, chosen by the action's DECLARED
 * reversibility (amended SPEC.md §5.2/§7, APRV-127).
 *
 * - `reversible: true` → `gated-revert`. The action can be undone, so the
 *   obligation is to undo it *through the gate*: the revert is itself a
 *   side-effecting action, and routing it through the gate is what closes the
 *   loop inside the log rather than inside a promise.
 * - `reversible: false` → `policy-finding`. There is nothing to revert. What is
 *   left is the finding that the class should not have permitted this without a
 *   human, and the sanctioned response is tightening the class; the obligation
 *   is the review of that tightening.
 * - **declared nothing** → `policy-finding`, the same as `false`. This is the
 *   fail-closed direction, and the reason is worth stating: obliging a revert of
 *   an action nobody said could be reverted would record an obligation that may
 *   be impossible to discharge, and an impossible obligation is one that gets
 *   closed dishonestly. A policy finding is always dischargeable, and it is the
 *   heavier of the two: it puts the CLASS on the table rather than one action.
 *
 * ## Self-reported, and only ever in the safe direction
 *
 * `reversible` is written by the party whose action is under review, so global
 * invariant 4 applies: it may never reduce scrutiny. Here it does not. It
 * selects the SHAPE of an obligation that exists either way; it cannot remove
 * one, delay one, or decide whether the denial happened. The one thing a false
 * `reversible: true` buys is a revert obligation instead of a policy finding —
 * and the revert obligation is the one whose satisfaction this runtime checks
 * against the log (`revert-required`), so the lie makes the claimant's own exit
 * harder rather than easier.
 */
export function obligationFor(reversible: boolean | null): Obligation {
  return reversible === true ? "gated-revert" : "policy-finding";
}

/**
 * Append `audit.reviewed` for one open sample.
 *
 * HUMAN-ONLY, by the same rule as `grant`/`reject`/`revoke`: the whole content
 * of the event is that a person looked. An agent- or system-authored review
 * would be the party under oversight closing its own audit item, and a backlog
 * that can be emptied by the thing it supervises measures nothing.
 *
 * No attestation is required, for the reason `execution resolve` states: review
 * records an observation and exercises no policy authority. It authorizes
 * nothing, spends no budget, and mints no token.
 *
 * `--note` is optional and recorded verbatim when present. It is not mandatory
 * the way `execution resolve`'s is, because that verb writes an *outcome* the
 * runtime does not know while this one writes only "seen".
 */
export function reviewSample(
  logPath: string,
  ref: SubjectRef,
  actor: string,
  note: string | null,
  options: ReviewOptions = {},
): ReviewResult | AuditRefusal {
  const verdict: ReviewVerdict = options.verdict ?? "ok";
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `audit review is human-only: the event's entire content is that a person looked at a sampled action, and a runtime that could mark its own samples reviewed would be a supervision backlog that empties itself. The actor must match human:<id>, got ${JSON.stringify(actor)}.`,
    );
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  const subjects = sampledSubjects(read.records);
  const located = locate(subjects, ref);
  if (!located.ok) return located;
  const subject = located.subject;

  const payload: Record<string, unknown> = {
    subject_seq: subject.seq,
    subject_event: "audit.sampled",
    reviewed: true,
    verdict,
  };
  if (subject.subjectHash !== null) payload["sampled_subject_hash"] = subject.subjectHash;
  if (note !== null && note.trim().length > 0) payload["note"] = note;

  const result = appendEvent(
    logPath,
    {
      ts: tick(options),
      event: "audit.reviewed",
      actor,
      ...(subject.task === null ? {} : { task: subject.task }),
      ...(subject.actionKey === null ? {} : { action_key: subject.actionKey }),
      payload,
    },
    {
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      expectedHead: read.head,
    },
  );
  if (!result.ok) {
    return refuse(
      "append-failed",
      `audit.reviewed for the sample at seq ${String(subject.seq)} was not appended (${result.error.code}): ${result.error.message}`,
      { append: result.error },
    );
  }

  if (verdict !== "denied") {
    return { ok: true, record: result.record, subject, obligation: null };
  }

  // APRV-127. The denial is recorded; now record what it obliges. Two events,
  // not one, because they are two facts with two authors: a human concluded the
  // action should not have happened, and the runtime derived — mechanically,
  // from the declaration the log already holds — what must now be done about it.
  // Collapsing them would let the reviewer's own words decide the obligation.
  //
  // Compare-and-append against the review itself: the obligation must land
  // directly on the record it names, so nothing can slip between a denial and
  // the obligation it creates.
  const obliged = appendObligation(logPath, read.records, subject, result.record, options);
  if (!obliged.ok) return obliged;
  return { ok: true, record: result.record, subject, obligation: obliged.record };
}

/**
 * Append the `reconciliation.required` that a denial creates.
 *
 * Actor `system:audit`, not the reviewer. The obligation is a derivation, not an
 * opinion: it follows from the denial and the action's declared reversibility by
 * the rule {@link obligationFor} states, and the event schema refuses any actor
 * that is not `system:`. A human-authored obligation would be one a human could
 * word into something easier to discharge, and the party under oversight would
 * then be describing its own homework.
 */
function appendObligation(
  logPath: string,
  records: readonly EventRecord[],
  subject: SampledSubject,
  review: EventRecord,
  options: AuditOptions,
): { ok: true; record: EventRecord } | AuditRefusal {
  const actionKey = subject.actionKey;
  if (actionKey === null) {
    return refuse(
      "not-sampled",
      `the sample at seq ${String(subject.seq)} names no action key, so a denial of it can oblige nothing: a reconciliation names the action it concerns, and there is none to name. The denial itself was recorded at seq ${String(review.seq)}.`,
      { seq: subject.seq },
    );
  }

  // The class and the reversibility come from the REGISTRATION, never from the
  // review and never from the execution's own payload (global invariant 4). The
  // party whose action was denied does not get to describe the action.
  const declared = findDeclaration(records as EventRecord[], actionKey);
  const cls = declared?.class ?? null;
  if (cls === null || cls.length === 0) {
    return refuse(
      "not-obliged",
      `action ${actionKey} has no task.registered declaration carrying a class, so the obligation its denial creates cannot name one. A policy finding tightens a CLASS; an obligation that names none is one nobody can act on. The denial itself was recorded at seq ${String(review.seq)}.`,
      { seq: review.seq },
    );
  }
  const reversible = declared?.reversible ?? null;

  const result = appendEvent(
    logPath,
    {
      ts: tick(options),
      event: "reconciliation.required",
      actor: AUDIT_ACTOR,
      ...(subject.task === null ? {} : { task: subject.task }),
      action_key: actionKey,
      payload: {
        action_key: actionKey,
        class: cls,
        review_seq: review.seq,
        obligation: obligationFor(reversible),
        reversible,
        // Restated so a reader of this record alone knows what the runtime could
        // and could not do about it. The gate cannot undo anything; it obliges.
        reason: "retrospective-denial",
      },
    },
    {
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      expectedHead: { seq: review.seq, hash: review.hash },
    },
  );
  if (!result.ok) {
    return refuse(
      "obligation-not-appended",
      `the denial of ${actionKey} was recorded at seq ${String(review.seq)} and its reconciliation obligation was NOT appended (${result.error.code}): ${result.error.message}. The log is consistent — the review stands and says denied — but nothing yet records what the denial requires. Review the sample again once the head settles, or open the obligation by hand through a human-authored process; an unreconciled denial is exactly what \`approval status\` and \`approval doctor\` are meant to shout about.`,
      { seq: review.seq, append: result.error },
    );
  }
  return { ok: true, record: result.record };
}

// ---------------------------------------------------------------------------
// Reconciliation obligations (amended SPEC.md §5.2 — APRV-127)
// ---------------------------------------------------------------------------

/** One `reconciliation.required`, with the satisfaction that closes it. */
export interface ReconciliationObligation {
  /** `seq` of the `reconciliation.required` record. */
  seq: number;
  ts: string;
  actionKey: string;
  task: string | null;
  class: string;
  /** `seq` of the `audit.reviewed` that denied. */
  reviewSeq: number;
  obligation: Obligation;
  reversible: boolean | null;
  /** `seq` of the `reconciliation.satisfied`, or `null` while still open. */
  satisfiedSeq: number | null;
}

function obligationOf(record: EventRecord): ReconciliationObligation | null {
  const payload = payloadOf(record);
  const actionKey = stringOrNull(record.action_key) ?? stringOrNull(payload["action_key"]);
  const cls = stringOrNull(payload["class"]);
  const reviewSeq = payload["review_seq"];
  const shape = payload["obligation"];
  if (actionKey === null || cls === null) return null;
  if (typeof reviewSeq !== "number" || !Number.isInteger(reviewSeq)) return null;
  if (shape !== "gated-revert" && shape !== "policy-finding") return null;
  const reversible = payload["reversible"];
  return {
    seq: record.seq,
    ts: record.ts,
    actionKey,
    task: stringOrNull(record.task) ?? stringOrNull(payload["task"]),
    class: cls,
    reviewSeq,
    obligation: shape,
    reversible: typeof reversible === "boolean" ? reversible : null,
    satisfiedSeq: null,
  };
}

/**
 * Every reconciliation obligation the log carries, each tagged with the
 * satisfaction that closes it.
 *
 * A satisfaction closes an obligation only when it comes **after** it in the
 * chain and names its seq — the same "later, and names it" rule
 * {@link sampledSubjects} applies to reviews, and for the same reason: a
 * backlog that an earlier record could close is a backlog that empties itself.
 *
 * A malformed `reconciliation.required` (no action key, no class, no usable
 * obligation shape) is SKIPPED rather than guessed at. Such a record cannot
 * reach the log through this runtime — the event schema requires all three — so
 * one that is there arrived some other way, and inventing the missing field
 * would put a fact in the backlog that nobody wrote.
 */
export function reconciliationObligations(
  records: readonly EventRecord[],
): ReconciliationObligation[] {
  const found: ReconciliationObligation[] = [];
  for (const record of records) {
    if (record.event !== "reconciliation.required") continue;
    const parsed = obligationOf(record);
    if (parsed !== null) found.push(parsed);
  }

  for (const item of found) {
    for (const record of records) {
      if (record.event !== "reconciliation.satisfied" || record.seq <= item.seq) continue;
      if (payloadOf(record)["obligation_seq"] !== item.seq) continue;
      item.satisfiedSeq = record.seq;
      break;
    }
  }
  return found;
}

/** Obligations with no later satisfaction, oldest first. The loud backlog. */
export function openObligations(records: readonly EventRecord[]): ReconciliationObligation[] {
  return reconciliationObligations(records).filter((item) => item.satisfiedSeq === null);
}

export interface SatisfyResult {
  ok: true;
  record: EventRecord;
  obligation: ReconciliationObligation;
}

/** What a human says they did to discharge an obligation. */
export interface SatisfyInput {
  /** What was done. REQUIRED — see the event schema on why. */
  note: string;
  /**
   * For a `gated-revert` obligation, the action key of the revert. The log must
   * carry an `execution.completed` for it.
   */
  revertActionKey?: string;
}

/**
 * Close one reconciliation obligation.
 *
 * **HUMAN-ONLY**, by the same rule that governs `grant`, `reject`, `revoke` and
 * `audit.reviewed`, and enforced twice: here in code and again by the event
 * schema. The entire content of the record is that a person judged the
 * obligation discharged. A runtime that could satisfy its own obligations would
 * be a reconciliation backlog that empties itself, which is precisely the
 * silence an unreconciled denial exists to break.
 *
 * Two checks beyond the actor, and both are about evidence rather than trust:
 *
 * - **A note is required.** `audit.reviewed` may record only "seen"; this record
 *   asserts that something was DONE, and an assertion nobody described is one no
 *   auditor can check.
 * - **A `gated-revert` obligation requires a completed revert IN THIS LOG.** The
 *   obligation was "undo it through the gate", so the discharge is a gated
 *   action that ran, and the runtime looks for its `execution.completed` rather
 *   than accepting a sentence saying it happened. That is what closes the loop
 *   in the chain. A `policy-finding` obligation has no such artifact — the
 *   sanctioned response is a policy amendment, which is a separate human
 *   ceremony with its own `policy.updated` record — so the note is the discharge
 *   there, and the note is required.
 *
 * No attestation is required, for the reason `audit review` and `execution
 * resolve` state: this record exercises no policy authority, authorizes nothing,
 * spends no budget, and mints no token.
 */
export function satisfyObligation(
  logPath: string,
  obligationSeq: number,
  actor: string,
  input: SatisfyInput,
  options: AuditOptions = {},
): SatisfyResult | AuditRefusal {
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `satisfying a reconciliation obligation is human-only: the event's entire content is that a PERSON judged the obligation discharged, and a runtime that could close its own obligations would be a reconciliation backlog that empties itself. The actor must match human:<id>, got ${JSON.stringify(actor)}.`,
    );
  }

  const note = input.note.trim();
  if (note.length === 0) {
    return refuse(
      "note-required",
      `a reconciliation.satisfied must say what was done. Unlike \`audit review\`, whose whole content may be "a person looked", this record asserts that an obligation was DISCHARGED, and a discharge nobody described is one no auditor can check. Pass --note "<what you did>".`,
    );
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  const obligation = reconciliationObligations(read.records).find(
    (item) => item.seq === obligationSeq,
  );
  if (obligation === undefined) {
    return refuse(
      "not-obliged",
      `no reconciliation.required record at seq ${String(obligationSeq)}. \`approval audit reconcile\` names the OBLIGATION, not the action it concerns and not the review that created it. Run \`approval audit obligations\` for the open ones.`,
      { seq: obligationSeq },
    );
  }
  if (obligation.satisfiedSeq !== null) {
    return refuse(
      "already-satisfied",
      `the obligation at seq ${String(obligation.seq)} was already satisfied at seq ${String(obligation.satisfiedSeq)}; a second satisfaction would record a second discharge of one obligation, which the log cannot tell apart from the first`,
      { seq: obligation.satisfiedSeq },
    );
  }

  const revertKey = input.revertActionKey?.trim() ?? "";
  if (obligation.obligation === "gated-revert") {
    if (revertKey.length === 0) {
      return refuse(
        "revert-required",
        `the obligation at seq ${String(obligation.seq)} is a gated-revert: ${obligation.actionKey} was declared reversible, so the sanctioned response to its denial is to UNDO it through the gate. Name the revert with --revert <action-key>. The revert is itself a side-effecting action, and routing it through the gate is what closes this loop inside the log rather than inside a sentence.`,
        { seq: obligation.seq },
      );
    }
    const completed = read.records.some(
      (record) => record.event === "execution.completed" && record.action_key === revertKey,
    );
    if (!completed) {
      return refuse(
        "revert-required",
        `this log carries no execution.completed for ${JSON.stringify(revertKey)}, so the revert this obligation requires has not been shown to have run. Request the revert, have it granted, run it through \`approval run\`, and then satisfy the obligation naming it. The runtime checks the chain rather than the claim, because a discharge that could be asserted is a backlog that empties itself.`,
        { seq: obligation.seq },
      );
    }
  }

  const payload: Record<string, unknown> = {
    obligation_seq: obligation.seq,
    note,
    action_key: obligation.actionKey,
    class: obligation.class,
    obligation: obligation.obligation,
  };
  if (obligation.obligation === "gated-revert") payload["revert_action_key"] = revertKey;

  const result = appendEvent(
    logPath,
    {
      ts: tick(options),
      event: "reconciliation.satisfied",
      actor,
      ...(obligation.task === null ? {} : { task: obligation.task }),
      action_key: obligation.actionKey,
      payload,
    },
    {
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      expectedHead: read.head,
    },
  );
  if (!result.ok) {
    return refuse(
      "append-failed",
      `reconciliation.satisfied for the obligation at seq ${String(obligation.seq)} was not appended (${result.error.code}): ${result.error.message}`,
      { append: result.error },
    );
  }
  return { ok: true, record: result.record, obligation };
}

function locate(
  subjects: SampledSubject[],
  ref: SubjectRef,
): { ok: true; subject: SampledSubject } | AuditRefusal {
  if (ref.kind === "seq") {
    const subject = subjects.find((entry) => entry.seq === ref.seq);
    if (subject === undefined) {
      return refuse(
        "not-sampled",
        `no audit.sampled record at seq ${String(ref.seq)}; \`approval audit review\` names the SAMPLE, not the execution it sampled. Run \`approval audit list\` (or read .approval/QUEUE.md's sampled-audit backlog) for the open samples.`,
        { seq: ref.seq },
      );
    }
    if (subject.reviewedSeq !== null) {
      return refuse(
        "already-reviewed",
        `the sample at seq ${String(subject.seq)} was already reviewed at seq ${String(subject.reviewedSeq)}; a second review would record a second human observation of the same item, which the log cannot tell apart from the first`,
        { seq: subject.reviewedSeq },
      );
    }
    return { ok: true, subject };
  }

  const matching = subjects.filter((entry) => entry.actionKey === ref.actionKey);
  if (matching.length === 0) {
    return refuse(
      "not-sampled",
      `no audit.sampled record names action ${JSON.stringify(ref.actionKey)}; only a SAMPLED action can be reviewed, and sampling is the runtime's decision, never a caller's`,
    );
  }
  const open = matching.filter((entry) => entry.reviewedSeq === null);
  if (open.length === 0) {
    const last = matching[matching.length - 1];
    return refuse(
      "already-reviewed",
      `every audit.sampled for ${ref.actionKey} is reviewed (the latest, seq ${String(
        last?.seq ?? 0,
      )}, at seq ${String(last?.reviewedSeq ?? 0)})`,
      last?.reviewedSeq === undefined || last.reviewedSeq === null ? {} : { seq: last.reviewedSeq },
    );
  }
  if (open.length > 1) {
    return refuse(
      "ambiguous-subject",
      `action ${ref.actionKey} has ${String(open.length)} unreviewed samples (seq ${open
        .map((entry) => String(entry.seq))
        .join(", ")}); name the one you reviewed by its seq, because a review that could mean either would close the wrong item`,
    );
  }
  return { ok: true, subject: open[0] as SampledSubject };
}
