/**
 * The audit lifecycle (SPEC.md §5.2, §9.1, §12): `audit.sampled` →
 * `audit.reviewed`.
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
import { declaringTasks, findDeclaration } from "./execute.js";
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
  return supervisedExecutions(records, load).filter(
    (candidate) => !alreadySampled.has(candidate.hash) && sampler.selects(candidate.hash),
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
    rate: sampler.rate,
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
  options: AuditOptions = {},
): ReviewResult | AuditRefusal {
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

  return { ok: true, record: result.record, subject };
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
