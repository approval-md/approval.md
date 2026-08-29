/**
 * The attestation ceremony, collected through a channel (APRV-109, amended
 * SPEC.md §10.1/§10.3/§11).
 *
 * ## The problem
 *
 * Attestation is human-only (`core/attest.ts`), and identity is
 * config-declared, so the two policy ceremonies — `policy attest` and `policy
 * amend` — required the human to be at a terminal. Every other decision in this
 * system had already been reduced to a tap on a phone; the one act that decides
 * which rules are in force had not. This module is the missing half: an agent
 * prepares the policy edit and appends a *proposal*, a channel puts it in front
 * of the approver like any other manual prompt, and the tap appends the
 * `policy.updated` attestation under the human identity the listener holds,
 * exactly as a grant lands today.
 *
 * ## What is computed, and why it has to be
 *
 * A proposal carries three things a channel renders: the SHA-256 of the policy
 * file's exact bytes, the semantic diff of what those bytes change about class
 * resolution, and the load advisory. **All three are derived here from the
 * bytes** — none is accepted from the proposing agent. {@link ProposeInput}
 * has no field for a hash, a diff or a verdict, so the refusal of a
 * caller-authored value is structural in the same way the refusal of a
 * caller-supplied `ts` is (amended SPEC.md §8, A2). An agent that could author
 * the diff summary could show an approver one story and attest another file.
 *
 * The BASELINE the diff is taken against is the one place a caller supplies
 * material, and it is checked rather than trusted: bytes whose own SHA-256 is
 * not the latest attested hash are refused as a baseline and the proposal falls
 * to hash-only mode. That is `cli/amend.ts`'s rule ("a baseline nobody can
 * verify is not a baseline"), enforced here so every caller inherits it.
 *
 * ## Fail closed, in this order
 *
 * - A policy file that cannot be read proposes nothing.
 * - A live file that already matches its attestation proposes nothing: there is
 *   no amendment to sign, and a prompt for one would ask a human to re-attest
 *   bytes already in force.
 * - A rendered diff larger than {@link ATTESTATION_DIFF_MAX_CHARS} REFUSES
 *   (`diff-too-large`) rather than truncating. A phone that shows two thirds of
 *   a policy change collects a signature for the third it did not show, and the
 *   repair — read it at a terminal and run `approval policy amend` there — is a
 *   real repair rather than a smaller lie.
 * - A tap whose proposal's bytes are no longer the bytes on disk refuses
 *   `proposal-stale` and attests nothing. The hash the human was shown is the
 *   hash that gets attested, or nothing does.
 * - A decline, a supersession and a lapsed deadline all attest nothing. Only
 *   {@link decideAttestation}`(…, "attest", …)` ever appends a `policy.updated`.
 *
 * Everything that writes here goes through `core/log.ts`'s `appendEvent` with a
 * compare-and-append precondition and a runtime-assigned timestamp, so the new
 * records inherit the same write-boundary discipline as the rest of the gate.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  POLICY_HASH_FIELD,
  checkAttestationOfBytes,
  policyBytesHash,
  type AttestationStatus,
} from "./attest.js";
import { tick, type ClockOptions } from "./clock.js";
import {
  appendEvent,
  type AppendOptions,
  type EventInput,
  type EventRecord,
  type LogHead,
} from "./log.js";
import { payloadHash } from "./payload.js";
import { payloadStoreDirFor, storePayload } from "./payload-store.js";
import { diffPolicies, renderDiff, SPEC_NAMESPACES, type PolicyDiff } from "./policy-diff.js";
import { loadPolicyText, POLICY_FILENAMES, type PolicyLoadResult } from "./policy-load.js";
import { readVerifiedRecords } from "./state.js";
import type { GateRefusal, GateRefusalCode } from "./gate.js";

/** Actors permitted to propose: a person or an agent, never the runtime. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

/** Actors permitted to answer a proposal. Human-only, in code (SPEC.md §11). */
const HUMAN_ACTOR = /^human:.+/u;

/**
 * The event an agent appends to ask for an attestation.
 *
 * Named `proposed` rather than `requested` deliberately: `approval.requested`
 * is the approval lifecycle, with its own TTL, its own budgets and its own
 * grant. This is a different question with a different answer event, and giving
 * it the same word would invite a reader — or a projection — to treat a policy
 * attestation as an ordinary authorization.
 */
export const PROPOSAL_EVENT = "policy.proposed";

/** The event a decline appends. An attestation appends `policy.updated`. */
export const DECLINE_EVENT = "policy.declined";

/**
 * The idempotency key an attestation prompt is rendered under.
 *
 * `policy.attest:<sha256>` — derived from the proposed bytes and from nothing
 * else, so two proposals of the same policy text carry the same key and a tap
 * on either answers the same question. It is also what
 * `channels/contract.ts` routes on: a gesture whose key starts with this prefix
 * becomes an attestation, never a grant.
 */
export const ATTESTATION_KEY_PREFIX = "policy.attest:";

/** The action class an attestation prompt is resolved and rendered under. */
export const ATTESTATION_CLASS = "policy.edit";

/** `policy.attest:<sha256>` for the given policy bytes. */
export function attestationActionKey(sha256: string): string {
  return `${ATTESTATION_KEY_PREFIX}${sha256}`;
}

/** Is this an attestation prompt's key rather than an ordinary action's? */
export function isAttestationActionKey(actionKey: string): boolean {
  return actionKey.startsWith(ATTESTATION_KEY_PREFIX);
}

/** The proposed policy hash named by an attestation key, or `null`. */
export function attestationKeySha256(actionKey: string): string | null {
  if (!isAttestationActionKey(actionKey)) return null;
  const hash = actionKey.slice(ATTESTATION_KEY_PREFIX.length);
  return /^[a-f0-9]{64}$/u.test(hash) ? hash : null;
}

/**
 * The largest rendered diff a channel prompt may carry, in characters.
 *
 * Telegram's hard limit is 4096 characters for one message and the prompt
 * carries a dozen other lines besides the diff, so this is the budget the
 * *smallest* supported channel can show whole. It is a refusal threshold and
 * never a truncation point: see the module header.
 */
export const ATTESTATION_DIFF_MAX_CHARS = 2400;

/** The same bound, in lines: a diff nobody will scroll is a diff nobody reads. */
export const ATTESTATION_DIFF_MAX_LINES = 60;

/** The load advisory a channel renders beside the diff. */
export interface LoadAdvisory {
  ok: boolean;
  /** The load failure's machine-readable code, or `null` on a clean load. */
  code: string | null;
  message: string | null;
}

/** The semantic diff summary a channel renders, as the log records it. */
export interface DiffSummary {
  /** False in hash-only mode: no verifiable baseline, so no semantic diff. */
  available: boolean;
  /** Why the diff is unavailable; `null` when it is available. */
  reason: string | null;
  /** The rendered diff, line by line, exactly as a channel prints it. */
  lines: string[];
  /** The one-line headline (`3 class resolution(s), 1 default(s)`). */
  headline: string;
  /** The SHA-256 of the baseline the diff was taken against, when there was one. */
  baseline_sha256: string | null;
}

/** What {@link proposeAttestation} was asked to propose. */
export interface ProposeInput {
  /** The policy file whose bytes are being proposed. */
  policyPath: string;
  /**
   * The previously-attested policy TEXT, for the semantic diff.
   *
   * Checked, never trusted: bytes whose SHA-256 is not the latest attestation's
   * are refused as a baseline and the proposal falls to hash-only mode with the
   * reason recorded. Callers recover them from `HEAD:<path>` (`cli/amend.ts`);
   * a caller with nothing to offer passes nothing.
   */
  baseline?: Uint8Array | null;
  /**
   * The proposer's own words about the amendment. CLAIMED, and rendered as
   * such: it is the one field on the prompt the runtime does not stand behind.
   */
  note?: string;
  /**
   * When the proposing process stops waiting (RFC 3339). Display only, and it
   * can only raise urgency: see `ChannelRequest.waiting`.
   */
  waitUntil?: string;
}

/** Options for both verbs: the append's, plus the clock and the schema dir. */
export interface ProposalOptions extends ClockOptions {
  schemaDir?: string;
  append?: AppendOptions;
  /** Where the full policy text is stored for the channel to display. */
  payloadStoreDir?: string;
}

export type ProposeResult =
  | { ok: true; record: EventRecord; sha256: string; diff: DiffSummary; load: LoadAdvisory }
  | GateRefusal;

export type AttestationDecision = "attest" | "decline";

export type DecideAttestationResult =
  | { ok: true; decision: AttestationDecision; record: EventRecord; sha256: string }
  | GateRefusal;

function refuse(
  code: GateRefusalCode,
  message: string,
  extra: Omit<GateRefusal, "ok" | "code" | "message"> = {},
): GateRefusal {
  return { ok: false, code, message, ...extra };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function appendOptionsOf(options: ProposalOptions): AppendOptions {
  const append: AppendOptions = { ...options.append };
  if (options.schemaDir !== undefined) append.schemaDir = options.schemaDir;
  return append;
}

function append(
  logPath: string,
  input: EventInput,
  options: ProposalOptions,
  expectedHead: LogHead | null,
): { ok: true; record: EventRecord } | GateRefusal {
  const result = appendEvent(logPath, input, {
    ...appendOptionsOf(options),
    expectedHead,
  });
  if (result.ok) return { ok: true, record: result.record };
  return refuse("append-failed", `${input.event} could not be appended: ${result.error.message}`, {
    append: result.error,
  });
}

/**
 * The policy file a proposal concerns, discovered the way `loadPolicy` does so
 * the proposed file and the enforced file are never two different files.
 */
export function proposalPolicyPath(dir: string): string {
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return join(dir, POLICY_FILENAMES[0] ?? "APPROVAL.md");
}

/** The load advisory for policy text, as a channel renders it. */
export function adviseLoad(policyPath: string, text: string, schemaDir?: string): LoadAdvisory {
  const load: PolicyLoadResult = loadPolicyText(
    policyPath,
    text,
    schemaDir === undefined ? {} : { schemaDir },
  );
  return load.ok
    ? { ok: true, code: null, message: null }
    : { ok: false, code: load.code, message: load.message };
}

/** The one-line headline of a diff: what changed, counted by section. */
function headlineOf(diff: PolicyDiff): string {
  const parts: string[] = [];
  if (diff.classes.length > 0) parts.push(`${String(diff.classes.length)} class resolution(s)`);
  if (diff.approvers.length > 0) parts.push(`${String(diff.approvers.length)} approver change(s)`);
  if (diff.defaults.length > 0) parts.push(`${String(diff.defaults.length)} default(s)`);
  if (diff.budgets.length > 0) parts.push(`${String(diff.budgets.length)} limit(s)`);
  if (diff.vocabulary.length > 0) parts.push(`${String(diff.vocabulary.length)} policy key(s)`);
  return parts.length === 0 ? "no semantic change" : parts.join(", ");
}

/** The rendered size of a diff summary, as the channel budget counts it. */
export function diffSize(summary: DiffSummary): { chars: number; lines: number } {
  return {
    chars: summary.lines.reduce((total, line) => total + line.length + 1, 0),
    lines: summary.lines.length,
  };
}

/**
 * The semantic diff between the attested baseline and the proposed bytes.
 *
 * Hash-only mode (`available: false`) whenever the baseline cannot be *proved*
 * to be the attested text: no baseline was offered, none was ever attested, or
 * the offered bytes hash to something other than the attestation. The reason is
 * recorded so a channel can print it instead of a diff, which is the honest
 * rendering of "we cannot show you what this changes".
 */
export function summarizeDiff(
  policyPath: string,
  baseline: Uint8Array | null | undefined,
  live: Uint8Array,
  attestedSha256: string | null,
  schemaDir?: string,
): DiffSummary {
  const unavailable = (reason: string): DiffSummary => ({
    available: false,
    reason,
    lines: [],
    headline: "semantic diff unavailable",
    baseline_sha256: null,
  });

  if (attestedSha256 === null) {
    return unavailable(
      "the policy has never been attested, so there is no previous state to diff against",
    );
  }
  if (baseline === null || baseline === undefined) {
    return unavailable(
      "no baseline text was supplied, and the attested BYTES are not recoverable from the log (an attestation records only their SHA-256)",
    );
  }
  const baselineSha256 = policyBytesHash(baseline);
  if (baselineSha256 !== attestedSha256) {
    return unavailable(
      `the supplied baseline hashes ${baselineSha256}, which is not the attested ${attestedSha256}; a baseline nobody can verify is not a baseline`,
    );
  }

  const options = schemaDir === undefined ? {} : { schemaDir };
  const before = loadPolicyText(policyPath, Buffer.from(baseline).toString("utf8"), options);
  const after = loadPolicyText(policyPath, Buffer.from(live).toString("utf8"), options);
  const diff = diffPolicies(before, after, SPEC_NAMESPACES);
  return {
    available: true,
    reason: null,
    lines: renderDiff(diff),
    headline: headlineOf(diff),
    baseline_sha256: baselineSha256,
  };
}

/** The stored value a channel displays as the prompt's full payload. */
export function proposalPayloadValue(policyPath: string, text: string): Record<string, unknown> {
  return { policy_path: basename(policyPath), text };
}

/**
 * Append a `policy.proposed` asking a human to attest `policyPath`'s bytes.
 *
 * The record's payload is the prompt: `sha256`, `diff` and `load` are all
 * derived here, `note` and `wait_until` are the proposer's and are labelled
 * claimed by every channel. `payload_hash` binds the full policy text stored
 * beside the log, so the approver can read the whole file rather than only the
 * summary (SPEC.md §10.4).
 *
 * No attestation is required to append one. That is the point of the verb: the
 * live policy is mid-amendment and therefore unattested, which is exactly the
 * state in which every other gate operation refuses. This one asks a human to
 * end that state.
 */
export function proposeAttestation(
  logPath: string,
  input: ProposeInput,
  actor: string,
  options: ProposalOptions = {},
): ProposeResult {
  const ts = tick(options);
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `a policy proposal requires a human: or agent: actor, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(input.policyPath);
  } catch (cause) {
    return refuse(
      "policy-not-attested",
      `policy ${input.policyPath} could not be read: ${detail(cause)}; an unverifiable policy is treated as unattested and nothing was proposed`,
      { detail: "unreadable" },
    );
  }

  const status: AttestationStatus = checkAttestationOfBytes(read.records, bytes);
  if (status.status === "attested") {
    return refuse(
      "policy-already-attested",
      `${input.policyPath} already matches its attestation at seq ${String(status.seq)}; there is no amendment to sign, and a prompt for one would ask a human to re-attest bytes that are already in force`,
    );
  }
  const sha256 = policyBytesHash(bytes);
  const attestedSha256 = status.status === "hash-mismatch" ? status.attestedSha256 : null;

  const diff = summarizeDiff(
    input.policyPath,
    input.baseline,
    bytes,
    attestedSha256,
    options.schemaDir,
  );
  const size = diffSize(diff);
  if (size.chars > ATTESTATION_DIFF_MAX_CHARS || size.lines > ATTESTATION_DIFF_MAX_LINES) {
    return refuse(
      "diff-too-large",
      `the semantic diff of ${input.policyPath} renders as ${String(size.lines)} line(s) / ${String(size.chars)} characters, past the ${String(ATTESTATION_DIFF_MAX_LINES)}-line / ${String(ATTESTATION_DIFF_MAX_CHARS)}-character budget a channel prompt can show whole. It is refused rather than truncated: a prompt that shows two thirds of a policy change collects a signature for the third it did not show. Read the diff at a terminal and attest there — \`approval policy amend --as human:<id> --require-load --commit\` — or split the amendment into changes a phone can hold. Nothing was appended.`,
    );
  }

  const text = Buffer.from(bytes).toString("utf8");
  const advisory = adviseLoad(input.policyPath, text, options.schemaDir);
  const value = proposalPayloadValue(input.policyPath, text);

  let boundHash: string;
  try {
    boundHash = payloadHash(value);
  } catch (cause) {
    return refuse(
      "payload-store-failed",
      `the policy text of ${input.policyPath} could not be canonicalized for display: ${detail(cause)}. Nothing was appended: a prompt whose bytes no channel can display is a prompt no human can answer (SPEC.md §10.4).`,
    );
  }
  const stored = storePayload(options.payloadStoreDir ?? payloadStoreDirFor(logPath), value);
  if (!stored.ok) {
    return refuse(
      "payload-store-failed",
      `${stored.message} Nothing was appended: an attestation prompt whose policy text no channel can display is a prompt no human can answer (SPEC.md §10.4).`,
    );
  }

  const payload: Record<string, unknown> = {
    policy_path: basename(input.policyPath),
    // COMPUTED, every one of them. `ProposeInput` carries no field for any of
    // these, so an agent cannot name the hash it wants attested, describe a
    // change it is not making, or claim its policy loads.
    sha256,
    action_key: attestationActionKey(sha256),
    class: ATTESTATION_CLASS,
    payload_hash: boundHash,
    diff,
    load: advisory,
  };
  if (attestedSha256 !== null) payload[POLICY_HASH_FIELD] = attestedSha256;
  if (input.note !== undefined) payload["note"] = input.note;
  if (input.waitUntil !== undefined) payload["wait_until"] = input.waitUntil;

  const appended = append(
    logPath,
    {
      ts,
      event: PROPOSAL_EVENT,
      actor,
      action_key: attestationActionKey(sha256),
      payload,
    },
    options,
    read.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, record: appended.record, sha256, diff, load: advisory };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** What became of a proposal, derived from the log and from nothing else. */
export type ProposalState =
  /** Nobody has answered, nothing supersedes it, and its deadline has not passed. */
  | "open"
  /** A human attested these bytes: a `policy.updated` carries the same hash. */
  | "attested"
  /** A human declined: a `policy.declined` names this proposal. */
  | "declined"
  /** A newer proposal for the same policy path replaced it. */
  | "superseded"
  /** Its `wait_until` passed with no answer. Nothing was attested. */
  | "expired";

export interface ProposalDerivation {
  seq: number;
  actionKey: string;
  sha256: string;
  state: ProposalState;
  record: EventRecord;
}

function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

function stringField(record: EventRecord, name: string): string | null {
  const value = payloadOf(record)[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Every `policy.proposed` record in the log, in append order. */
export function proposalRecords(records: readonly EventRecord[]): EventRecord[] {
  return records.filter((record) => record.event === PROPOSAL_EVENT);
}

/**
 * Derive one proposal's state at `now`.
 *
 * Terminal states are read off the log; `expired` is arithmetic on the
 * proposer's own `wait_until` and materialises no event, because a lapsed
 * attestation prompt has nothing to record: nothing was attested, and the
 * proposal record already says everything a reader needs. That is the
 * fail-closed reading — a prompt nobody answered leaves the policy exactly as
 * unattested as it was.
 */
export function proposalState(
  records: readonly EventRecord[],
  seq: number,
  now: string,
): ProposalDerivation | null {
  const record = records.find((entry) => entry.seq === seq && entry.event === PROPOSAL_EVENT);
  if (record === undefined) return null;
  const sha256 = stringField(record, "sha256");
  if (sha256 === null) return null;
  const actionKey = record.action_key ?? attestationActionKey(sha256);
  const path = stringField(record, "policy_path");

  let state: ProposalState = "open";
  for (const entry of records) {
    if (entry.seq <= record.seq) continue;
    if (entry.event === "policy.updated" && stringField(entry, "sha256") === sha256) {
      state = "attested";
      break;
    }
    if (entry.event === DECLINE_EVENT && stringField(entry, "sha256") === sha256) {
      state = "declined";
      break;
    }
    if (
      entry.event === PROPOSAL_EVENT &&
      stringField(entry, "sha256") !== sha256 &&
      stringField(entry, "policy_path") === path
    ) {
      state = "superseded";
      break;
    }
  }

  if (state === "open") {
    const waitUntil = stringField(record, "wait_until");
    const deadline = waitUntil === null ? Number.NaN : Date.parse(waitUntil);
    const nowMs = Date.parse(now);
    if (!Number.isNaN(deadline) && !Number.isNaN(nowMs) && nowMs >= deadline) state = "expired";
  }

  return { seq: record.seq, actionKey, sha256, state, record };
}

/** Every proposal still awaiting a human answer at `now`, in log order. */
export function openProposals(
  records: readonly EventRecord[],
  now: string,
): ProposalDerivation[] {
  const open: ProposalDerivation[] = [];
  for (const record of proposalRecords(records)) {
    const derived = proposalState(records, record.seq, now);
    if (derived !== null && derived.state === "open") open.push(derived);
  }
  return open;
}

/** The open proposal whose bytes hash to `sha256`, or `null`. */
export function openProposalFor(
  records: readonly EventRecord[],
  sha256: string,
  now: string,
): ProposalDerivation | null {
  const matches = openProposals(records, now).filter((entry) => entry.sha256 === sha256);
  return matches[matches.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/** Options for {@link decideAttestation}. */
export interface DecideAttestationOptions extends ProposalOptions {
  /** The approver's free-text note, recorded on the answer. */
  note?: string;
  /** Where `APPROVAL.md` lives, when it is not the proposal's own directory. */
  policyPath?: string;
  /** The channel delivery id this gesture answered, for audit. */
  batchDeliveryId?: string;
}

/**
 * Answer a proposal: attest the bytes the prompt displayed, or decline them.
 *
 * Human-only, in code — the same rule `core/attest.ts` enforces, restated here
 * because this is a second door onto the same act and the rule must hold for
 * every caller and not only for the CLI's.
 *
 * **The attested hash is the hash the prompt displayed.** Before anything is
 * appended the live file is re-read and re-hashed, and any difference refuses
 * `proposal-stale`: the human signed for bytes they were shown, and bytes that
 * changed underneath the prompt are a different policy that has to be proposed
 * again. This is the one check that makes "the phone shows the diff and the
 * hash" mean anything.
 *
 * A decline appends `policy.declined` and attests nothing. So does a lapsed
 * deadline, by appending nothing at all.
 */
export function decideAttestation(
  logPath: string,
  seq: number,
  decision: AttestationDecision,
  actor: string,
  options: DecideAttestationOptions = {},
): DecideAttestationResult {
  const ts = tick(options);
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `${decision} is a human-only verb; attestation is the one act an agent must not perform, and the actor must match human:<id>, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  const derived = proposalState(read.records, seq, ts);
  if (derived === null) {
    return refuse(
      "proposal-not-found",
      `seq ${String(seq)} is not a ${PROPOSAL_EVENT} record carrying a policy hash; there is no attestation prompt to answer`,
    );
  }
  if (derived.state === "expired") {
    return refuse(
      "expired",
      `the attestation prompt at seq ${String(seq)} passed the deadline its proposer declared; nothing was attested. Propose the amendment again — a prompt nobody answered leaves the policy exactly as unattested as it was.`,
    );
  }
  if (derived.state !== "open") {
    return refuse(
      "already-decided",
      `the attestation prompt at seq ${String(seq)} is ${derived.state}; a second answer would rewrite a human's decision about which policy bytes are in force`,
    );
  }

  const policyPath =
    options.policyPath ?? stringField(derived.record, "policy_path") ?? "APPROVAL.md";

  if (decision === "attest") {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(policyPath);
    } catch (cause) {
      return refuse(
        "proposal-stale",
        `the policy file ${policyPath} could not be read to confirm the bytes this prompt displayed: ${detail(cause)}. Nothing was attested: an attestation names bytes, and bytes nobody can read are not the bytes anybody was shown.`,
      );
    }
    const live = policyBytesHash(bytes);
    if (live !== derived.sha256) {
      return refuse(
        "proposal-stale",
        `the attestation prompt at seq ${String(seq)} displayed ${derived.sha256} and ${policyPath} now hashes ${live}; the file changed after the question was asked, so a tap here would attest bytes the approver was never shown. Nothing was attested: propose the amendment again, which re-renders the diff and the advisory over the bytes actually on disk.`,
      );
    }
  }

  const payload: Record<string, unknown> = {
    policy_path: basename(policyPath),
    sha256: derived.sha256,
    proposed_seq: derived.seq,
  };
  if (options.note !== undefined) payload["note"] = options.note;
  if (options.batchDeliveryId !== undefined && options.batchDeliveryId.length > 0) {
    payload["batch_delivery_id"] = options.batchDeliveryId;
  }

  const appended = append(
    logPath,
    {
      ts,
      event: decision === "attest" ? "policy.updated" : DECLINE_EVENT,
      actor,
      action_key: derived.actionKey,
      payload,
    },
    options,
    read.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, decision, record: appended.record, sha256: derived.sha256 };
}
