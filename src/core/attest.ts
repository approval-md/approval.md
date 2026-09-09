/**
 * Policy attestation (SPEC.md §5.2, §11) — the mechanical form of "agents MUST
 * NOT be able to modify `APPROVAL.md`".
 *
 * The problem this solves is not that an agent *can* edit the policy file — on
 * a single machine nothing stops it — but that an edited policy would otherwise
 * take effect silently. Attestation closes that: a human runs
 * `approval policy attest`, which appends a `policy.updated` event carrying the
 * SHA-256 of the policy file's exact bytes. From then on the live file either
 * hashes to the latest attestation or it does not, and {@link checkAttestation}
 * says which. Gate operations (request intake, grant recording, token minting —
 * APRV-16) refuse on anything but a match. An edited policy is inoperative
 * until a human re-attests it.
 *
 * ## What this proves, and what it does not
 *
 * Human identity at v0.1 is **config-declared**: `--as human:<id>` or the
 * `APPROVAL_HUMAN` environment variable (see {@link resolveHumanActor}). The
 * trust boundary is the local machine. Anyone who can set that environment
 * variable and write to the log is inside the boundary, so an attestation
 * proves that *someone with local control* signed off — not *who*. There is no
 * cryptographic identity here and this module claims none; that is future work,
 * stated plainly rather than dressed up. What attestation buys, even so, is
 * real: a policy edit made by an agent mid-run cannot become operative without
 * a separate, deliberate, logged human act.
 *
 * ## Fail closed, in this order
 *
 * A policy file that cannot be read is `unreadable`, never `attested`. No
 * attestation at all is `not-attested`. Bytes that do not match the latest
 * attestation are `hash-mismatch`. Only an exact match is `attested`.
 *
 * Everything here is read-only except {@link appendAttestation}, which writes
 * through `core/log.ts`'s `appendEvent` — the one sanctioned append path — and
 * therefore inherits its locking, chain stamping, and write-boundary schema
 * validation. Nothing in this file opens the log itself.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { tick, type ClockOptions } from "./clock.js";
import {
  builtinProtectedPathClass,
  isGateOrganPath,
  normalizePathSpelling,
} from "./command-class.js";
import {
  APPEND_ERROR_CODES,
  appendEvent,
  type AppendOptions,
  type EventRecord,
} from "./log.js";
import type { ValidationError } from "./validate.js";

/**
 * Actors permitted to attest. Deliberately narrower than the event schema's
 * `^(human|agent|system):.+`: attestation is the one verb an agent must not be
 * able to perform, so `agent:` and `system:` are refused here — in code, not
 * only in prose.
 */
const HUMAN_ACTOR = /^human:.+/;

/** Environment variable naming the human on whose behalf the CLI attests. */
export const HUMAN_ACTOR_ENV = "APPROVAL_HUMAN";

/**
 * The machine-readable refusal code emitted when policy is not attested.
 *
 * Deliberately distinct from any generic policy-load failure. A caller must be
 * able to tell "the policy says manual" from "the policy is unverified", because
 * the repairs are different: the first is answered by asking a human to approve
 * an action, the second by asking a human to attest a file.
 */
export const ATTESTATION_REFUSAL = "policy-not-attested";

/**
 * The payload field carrying the attested policy hash a gate event was decided
 * under (APRV-118, amended SPEC.md §5.2).
 *
 * Written on `approval.requested` and `approval.granted`, and named here rather
 * than in `core/gate.ts` because the value is this module's: it is the SHA-256
 * the live policy file matched when {@link checkAttestation} said `attested`.
 * Pinning it lets a reader of the log answer a question attestation alone cannot
 * — whether the approver decided under the rules the requester was routed by.
 */
export const POLICY_HASH_FIELD = "policy_sha256";

/** Is `value` a lowercase-hex SHA-256, the shape {@link POLICY_HASH_FIELD} takes? */
export function isPolicySha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** Why an attestation check refused. Mirrors the non-`attested` statuses. */
export type AttestationRefusalDetail = "not-attested" | "hash-mismatch" | "unreadable";

/** The refusal a gate operation surfaces to its caller (APRV-16 consumes it). */
export interface AttestationRefusal {
  code: typeof ATTESTATION_REFUSAL;
  detail: AttestationRefusalDetail;
  message: string;
}

/**
 * Why an attestation append failed: every reason `appendEvent` can give, plus
 * the one rule this module enforces on its own.
 *
 * ### Why `actor-not-human` lives here and not in `core/log.ts`
 *
 * Until APRV-20 pass two the non-human-actor refusal reused `validation`, which
 * conflated two different facts: "the record failed `event.schema.json` at the
 * write boundary" and "the caller is not allowed to perform this verb". A
 * caller branching on `validation` could not tell a malformed event from a
 * forbidden one, and the two call for opposite responses (fix the record;
 * fetch a human).
 *
 * The fix does **not** add the code to `APPEND_ERROR_CODES`. That union is the
 * log writer's vocabulary — the ways a byte can fail to reach the file — and
 * "only humans may attest" is a fact about attestation, not about writing.
 * Widening the writer's union to carry a caller's policy rule would oblige every
 * future append site to consider a code that can only ever come from this one,
 * and would make `core/log.ts` the place people look for permission rules.
 * Instead this module widens the union *for itself*: `AppendResult` remains
 * assignable to {@link AttestationAppendResult}, so nothing downstream is
 * forced to change, and the CLI adds one case.
 */
export const ATTEST_ERROR_CODES = [...APPEND_ERROR_CODES, "actor-not-human"] as const;

export type AttestErrorCode = (typeof ATTEST_ERROR_CODES)[number];

export interface AttestError {
  code: AttestErrorCode;
  message: string;
  /** Schema errors, present when `code` is "validation". */
  errors?: ValidationError[];
}

/** {@link appendAttestation}'s result: `AppendResult` widened by one code. */
export type AttestationAppendResult =
  | { ok: true; record: EventRecord; line: string }
  | { ok: false; error: AttestError };

/** Options for {@link appendAttestation}: the append's, plus the clock. */
export interface AttestOptions extends AppendOptions, ClockOptions {}

/** The result of comparing the live policy file against the log. */
export type AttestationStatus =
  | { status: "attested"; seq: number; sha256: string }
  | { status: "not-attested" }
  | { status: "hash-mismatch"; attestedSha256: string; liveSha256: string; seq: number }
  | { status: "unreadable"; message: string };

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * SHA-256 (lowercase hex) of a file's **exact bytes**.
 *
 * Bytes, not text: no encoding round-trip, no newline normalization, no parse.
 * A policy file that differs only in trailing whitespace is a different policy
 * file as far as attestation is concerned, which is the conservative reading
 * and the only one that survives an adversary who knows what gets normalized.
 *
 * Throws if the file cannot be read; callers that need a status rather than an
 * exception use {@link checkAttestation}, which converts that into
 * `unreadable`.
 */
export function policyFileHash(path: string): string {
  return policyBytesHash(readFileSync(path));
}

/**
 * SHA-256 (lowercase hex) of policy bytes a caller has already read.
 *
 * The same digest {@link policyFileHash} computes, over bytes rather than a
 * path. It exists so a gate operation can read `APPROVAL.md` once and hash the
 * exact buffer it is also about to parse (APRV-142): hashing by path a second
 * time would reopen the window where the attestation check and the parse can
 * see different bytes.
 */
export function policyBytesHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Append a `policy.updated` attestation for `policyPath` to `logPath`.
 *
 * `actor` MUST match `^human:.+`. An `agent:` or `system:` actor is refused
 * before anything is read or written — the refusal is a structured result,
 * never a throw, consistent with the rest of the write path. Its code is
 * `actor-not-human`, this module's own (see {@link ATTEST_ERROR_CODES}): the
 * actor failed the rule *this verb* enforces, which is a different fact from a
 * record failing the event schema, and the two used to share `validation`.
 *
 * The event is deliberately minimal:
 *
 * ```json
 * { "event": "policy.updated", "actor": "human:alice",
 *   "payload": { "policy_path": "APPROVAL.md", "sha256": "<64 hex>" } }
 * ```
 *
 * `policy_path` is the **basename**, not the absolute path: the log is meant to
 * be copied, exported, and read on other machines, and an absolute path would
 * leak the writer's home directory into a permanent record while saying nothing
 * a reader can use. `sha256` is the file's byte digest — the field
 * {@link checkAttestation} compares against.
 *
 * `ts` is **not** a parameter. `policy.updated` is one of the gate-typed events
 * of amended SPEC.md §8 (A2), so its timestamp is assigned by the runtime at the
 * write boundary — read once from {@link AttestOptions.clock}, which defaults to
 * the real clock and which tests inject. Attestation is the verb that decides
 * which policy bytes are operative from a moment onward; a caller that could
 * choose that moment could backdate the answer.
 *
 * ## Why this append carries no `expectedHead` (APRV-20 finding B1)
 *
 * Every *other* append site in the codebase reads the log, decides something
 * from what it read, and must therefore prove the log has not moved before it
 * writes. This one does not read the log at all. Its only precondition is the
 * actor check and the policy file's bytes — neither of which the log can
 * invalidate — so there is no check-then-act window to close. A concurrent
 * appender simply means this attestation lands after that record, which is
 * correct: attestation is an unconditional assertion about a file's bytes at a
 * moment, and the *latest* attestation is the one `checkAttestation` honors.
 * Passing a precondition here would only manufacture spurious failures.
 */
export function appendAttestation(
  logPath: string,
  policyPath: string,
  actor: string,
  options: AttestOptions = {},
): AttestationAppendResult {
  if (!HUMAN_ACTOR.test(actor)) {
    return {
      ok: false,
      error: {
        code: "actor-not-human",
        message: `attestation requires a human actor matching ^human:.+, got ${JSON.stringify(actor)}; attestation is the one verb an agent must not perform, and the log was left unchanged`,
      },
    };
  }

  let sha256: string;
  try {
    sha256 = policyFileHash(policyPath);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "io",
        message: `policy ${policyPath} could not be read for attestation: ${detail(cause)}`,
      },
    };
  }

  return appendEvent(
    logPath,
    {
      ts: tick(options),
      event: "policy.updated",
      actor,
      payload: { policy_path: basename(policyPath), sha256 },
    },
    options,
  );
}

/**
 * Is this record an attestation — a `policy.updated` carrying a `sha256`?
 *
 * `policy.updated` records **without** a `payload.sha256` are ignored for
 * attestation purposes. Two reasons, one forward and one backward: the event
 * type predates this verb (SPEC.md §8 has always had it, and the schema keeps
 * it base-only with no required payload fields), so pre-attestation logs and
 * hand-rolled tooling may carry `policy.updated` events that assert nothing
 * about bytes; and treating such a record as an attestation would mean a
 * payload-less event could *satisfy* the guard, which is exactly backwards.
 * Ignoring them means an old log reads as `not-attested` — fail closed.
 */
function attestationSha256(record: EventRecord): string | null {
  if (record.event !== "policy.updated") return null;
  const payload = record.payload;
  if (payload === undefined) return null;
  const value = payload["sha256"];
  return typeof value === "string" ? value : null;
}

/**
 * Compare the live policy file against the latest attestation in `records`.
 *
 * `records` is the log in append order, as a caller has already read and
 * verified it; this function does no I/O on the log and never writes. The
 * **latest** attestation wins — re-attesting after an edit is the supported
 * repair, and an older attestation must not be able to vouch for bytes that a
 * newer one already disagreed with.
 *
 * `payload.policy_path` is recorded but deliberately **not** matched against
 * `policyPath`: v0.1 has exactly one policy file per approval home (SPEC.md
 * §5), and a filename filter would let an attestation of `APPROVALS.md` and a
 * live `APPROVAL.md` drift apart silently. Comparing only bytes means the
 * mismatch surfaces as a mismatch.
 */
export function checkAttestation(
  records: EventRecord[],
  policyPath: string,
): AttestationStatus {
  // Read the live file first: unreadable is its own status, and it outranks
  // "never attested" because it is the fact we are most sure of.
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(policyPath);
  } catch (cause) {
    return unreadablePolicyStatus(policyPath, detail(cause));
  }
  return checkAttestationOfBytes(records, bytes);
}

/** The `unreadable` status for a policy read the caller performed itself. */
export function unreadablePolicyStatus(policyPath: string, cause: string): AttestationStatus {
  return {
    status: "unreadable",
    message: `policy ${policyPath} could not be read: ${cause}`,
  };
}

/**
 * {@link checkAttestation} against bytes the caller already holds.
 *
 * Same comparison, no read. A gate operation reads the policy file once and
 * passes that one buffer here and to the parser (APRV-142), which is what makes
 * "attested one policy, enforced another" structurally impossible rather than
 * merely unlikely.
 *
 * The `unreadable` status has no counterpart here: bytes that exist were read.
 * A caller whose read failed calls {@link unreadablePolicyStatus} instead, so
 * the fail-closed ordering of {@link checkAttestation} survives the split.
 */
export function checkAttestationOfBytes(
  records: EventRecord[],
  bytes: Uint8Array,
): AttestationStatus {
  const liveSha256 = policyBytesHash(bytes);

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as EventRecord;
    const attested = attestationSha256(record);
    if (attested === null) continue;
    if (attested === liveSha256) {
      return { status: "attested", seq: record.seq, sha256: liveSha256 };
    }
    return {
      status: "hash-mismatch",
      attestedSha256: attested,
      liveSha256,
      seq: record.seq,
    };
  }

  return { status: "not-attested" };
}

/**
 * The refusal for a non-`attested` status, or `null` when policy is attested.
 *
 * One code (`policy-not-attested`) with a `detail` discriminator, rather than
 * three codes: a caller that wants to refuse needs to branch on one value, and
 * a caller that wants to explain has `detail` and `message`.
 */
export function attestationRefusal(status: AttestationStatus): AttestationRefusal | null {
  switch (status.status) {
    case "attested":
      return null;
    case "not-attested":
      return {
        code: ATTESTATION_REFUSAL,
        detail: "not-attested",
        message:
          "the policy file has never been attested; a human must run `approval policy attest` before gated operations can proceed",
      };
    case "hash-mismatch":
      return {
        code: ATTESTATION_REFUSAL,
        detail: "hash-mismatch",
        message: `the policy file has changed since it was attested at seq ${status.seq} (attested ${status.attestedSha256}, live ${status.liveSha256}); an edited policy is inoperative until a human re-attests it`,
      };
    case "unreadable":
      return {
        code: ATTESTATION_REFUSAL,
        detail: "unreadable",
        message: `${status.message}; an unverifiable policy is treated as unattested`,
      };
  }
}

/**
 * The human identity to record as `actor`, or `null` when none is declared.
 *
 * Precedence: `options.actor` (the CLI's `--as`) first, then the
 * `APPROVAL_HUMAN` environment variable. An explicit `--as` that does not match
 * `^human:.+` yields `null` rather than falling back to the environment —
 * silently substituting a different identity for the one the caller typed would
 * be worse than refusing.
 *
 * This is **config-declared identity**. The trust boundary is the local
 * machine: whoever can set `APPROVAL_HUMAN` and write to the log is inside it.
 * v0.1 makes no cryptographic claim about who attested, only that a locally
 * privileged act occurred and was recorded.
 */
export function resolveHumanActor(options: { actor?: string } = {}): string | null {
  const explicit = options.actor;
  if (explicit !== undefined) {
    return HUMAN_ACTOR.test(explicit) ? explicit : null;
  }
  const fromEnv = process.env[HUMAN_ACTOR_ENV];
  if (fromEnv !== undefined && HUMAN_ACTOR.test(fromEnv)) return fromEnv;
  return null;
}

// ===========================================================================
// Organ attestation (APRV-272, amended SPEC.md §5.2 and §8)
// ===========================================================================

/**
 * The event an ORGAN attestation is: a human's sign-off on the exact bytes of
 * one of the gate's own organ files.
 *
 * ## Why the organs need this at all
 *
 * `.claude/settings.json` and Cursor's hook files classify `policy.core`, and
 * `policy.core` is human-only in this repository's policy and inert to agents
 * by §11.1 invariant 9. So the gate mints NOTHING for them: `core/gate.ts`
 * refuses a human-only class before any record is appended, which means the
 * protected-path guard's `granted-file` and `granted-command` verdicts cannot
 * exist for an organ, however correctly a human edited it. PR #300 is that hole,
 * exactly: a human hand-committed hook entries and CI failed the change because
 * the only evidence the guard could accept was evidence the gate is designed
 * never to produce.
 *
 * Attestation is the primitive that already fits. It records "a human saw these
 * exact bytes", it needs no grant, and it matches CONTENT rather than a path, so
 * the guard can hash the blob at head and ask the log about it.
 *
 * ## Why a separate event type
 *
 * `core/log.ts`'s `EventType` note carries the argument in full. In one line:
 * every reader of the POLICY attestation selects on `event === "policy.updated"`,
 * so a distinct type is invisible to all of them by construction, and
 * {@link checkAttestationOfBytes} returns at the first `sha256`-bearing record
 * it meets scanning backwards — an organ record wearing `policy.updated` would
 * have made a correctly attested policy read as `hash-mismatch`.
 */
export const ORGAN_ATTESTATION_EVENT = "gate.organ.attested" as const;

/**
 * The payload field naming which organ was attested.
 *
 * Repository-relative and `/`-separated, never absolute: the log is meant to be
 * copied and read on other machines, and an absolute path would leak the
 * writer's home directory into a permanent record. Unlike the policy
 * attestation, which records a BASENAME because v0.1 has exactly one policy file
 * per approval home, an organ record has to carry the whole relative path —
 * there are several organs, they live in different directories, and the guard's
 * rule is that a digest attested for one path is not evidence for another.
 */
export const ORGAN_PATH_FIELD = "organ_path";

/**
 * Why an organ attestation was refused: the policy attestation's codes, plus
 * the two rules this verb has of its own.
 *
 * Two codes and not one, because the repairs are different and a caller must be
 * able to tell them apart. `path-is-policy` means the caller aimed the organ
 * verb at the policy file, whose attestation is `approval policy attest` with no
 * `--organ` and which the gate reads on every operation. `path-not-organ` covers
 * everything else the runtime will not attest this way: the approval home, whose
 * contents are the human's own ceremony surface, and any ordinary file, which is
 * not part of the gate and needs no attestation to be edited.
 */
export const ORGAN_ATTEST_ERROR_CODES = [
  ...ATTEST_ERROR_CODES,
  "path-not-organ",
  "path-is-policy",
] as const;

export type OrganAttestErrorCode = (typeof ORGAN_ATTEST_ERROR_CODES)[number];

export interface OrganAttestError {
  code: OrganAttestErrorCode;
  message: string;
  /** Schema errors, present when `code` is "validation". */
  errors?: ValidationError[];
}

/** {@link appendOrganAttestation}'s result: the append's, widened by two codes. */
export type OrganAttestationAppendResult =
  | { ok: true; record: EventRecord; line: string }
  | { ok: false; error: OrganAttestError };

/**
 * Which file to attest, in the two spellings that are not the same fact.
 *
 * `path` is the identity the record carries and the guard matches on, so it is
 * repository-relative. `root` is where that path is rooted on THIS machine, and
 * it never reaches the log. Splitting them is what keeps an absolute path out
 * of a permanent record without making the record ambiguous about which of
 * several organs it names.
 */
export interface OrganTarget {
  /** Repository-relative, e.g. `.claude/settings.json`. */
  path: string;
  /** The checkout `path` is relative to; `join(root, path)` is hashed. */
  root: string;
}

/** The identity and digest an organ attestation carries, or `null`. */
export interface OrganAttestationFields {
  organPath: string;
  sha256: string;
}

/** An organ attestation found in the log, with the record it came from. */
export interface OrganAttestation extends OrganAttestationFields {
  record: EventRecord;
}

/**
 * Append a `gate.organ.attested` record for `target` to `logPath`.
 *
 * The rules, all of them refused as structured results and never as throws, in
 * the order they are checked:
 *
 * 1. `actor` MUST match `^human:.+`. Attestation is the verb an agent must not
 *    perform, and it is refused here in code and again at the CLI, exactly as
 *    {@link appendAttestation} is.
 * 2. The path must be repository-relative: absolute paths and `..` are refused,
 *    because the recorded identity has to mean the same file on the machine
 *    that later reads the log.
 * 3. The policy file is refused with its own code. It has its own attestation
 *    and the gate reads it on every operation; letting the organ verb write a
 *    record about it would create a second thing that looks like a policy
 *    attestation and is not one.
 * 4. The path must be a gate organ ({@link isGateOrganPath}). Nothing else is
 *    attestable this way, so the verb cannot be turned into a general
 *    "bless these bytes" primitive for any file at all.
 *
 * The digest is computed by the runtime from the file's exact bytes. There is
 * no parameter for it, which is the same reason there is no `ts` parameter: a
 * caller who could supply the hash could attest bytes nobody read, and a caller
 * who could supply the moment could backdate what was operative when.
 *
 * Like {@link appendAttestation} this append carries no `expectedHead`. It reads
 * nothing from the log, so it has no check-then-act window to close; a
 * concurrent appender only means this record lands after theirs.
 */
export function appendOrganAttestation(
  logPath: string,
  target: OrganTarget,
  actor: string,
  options: AttestOptions = {},
): OrganAttestationAppendResult {
  if (!HUMAN_ACTOR.test(actor)) {
    return {
      ok: false,
      error: {
        code: "actor-not-human",
        message: `attesting a gate organ requires a human actor matching ^human:.+, got ${JSON.stringify(actor)}; the organs are the files that install the hook, so an agent that could attest one could vouch for its own way out of the gate, and the log was left unchanged`,
      },
    };
  }

  const refusal = organPathRefusal(target.path);
  if (refusal !== null) return { ok: false, error: refusal };
  const organPath = normalizePathSpelling(target.path);

  let sha256: string;
  try {
    sha256 = policyFileHash(join(target.root, organPath));
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "io",
        message: `gate organ ${organPath} could not be read under ${target.root} for attestation: ${detail(cause)}`,
      },
    };
  }

  return appendEvent(
    logPath,
    {
      ts: tick(options),
      event: ORGAN_ATTESTATION_EVENT,
      actor,
      payload: { [ORGAN_PATH_FIELD]: organPath, sha256 },
    },
    options,
  );
}

/** Rules 2 to 4 of {@link appendOrganAttestation}, or `null` when the path passes. */
function organPathRefusal(candidate: string): OrganAttestError | null {
  const normalized = normalizePathSpelling(candidate);
  if (normalized.length === 0 || isAbsolute(candidate) || normalized.split("/").includes("..")) {
    return {
      code: "path-not-organ",
      message: `${JSON.stringify(candidate)} is not a repository-relative path; an organ attestation records the path itself, so it must name the same file on every machine that later reads the log`,
    };
  }
  if (isGateOrganPath(normalized)) return null;
  if (builtinProtectedPathClass(normalized) === "policy.core") {
    const last = normalized.split("/").pop() ?? normalized;
    if (POLICY_FILE_NAMES.includes(last)) {
      return {
        code: "path-is-policy",
        message: `${normalized} is the policy file, not a gate organ; its attestation is \`approval policy attest\` with no --organ, and the gate reads that one on every operation`,
      };
    }
    return {
      code: "path-not-organ",
      message: `${normalized} is inside the approval home, which is the human's own ceremony surface and is not attested this way; the gate organs are the harness files that install the hook`,
    };
  }
  return {
    code: "path-not-organ",
    message: `${normalized} does not classify policy.core, so it is not one of the gate's organs; only the harness files that install the hook are attested by content, and an ordinary protected path is edited through the gate and evidenced by the grant`,
  };
}

/**
 * The policy filenames, for the one refusal that has to name them.
 *
 * Spelled here rather than imported from `core/policy-load.ts`: this module is
 * below the policy loader and stays there, and the two candidate names are a
 * SPEC.md §5 constant rather than a loader detail.
 */
const POLICY_FILE_NAMES: readonly string[] = ["APPROVAL.md", "APPROVALS.md"];

/**
 * Is this record an organ attestation, and which bytes of which file does it
 * vouch for?
 *
 * A record missing either field is ignored, for the reason a `policy.updated`
 * with no `sha256` is ignored: a record that asserts nothing about bytes must
 * never be able to SATISFY a check about bytes. Fail closed.
 */
export function organAttestationOf(record: EventRecord): OrganAttestationFields | null {
  if (record.event !== ORGAN_ATTESTATION_EVENT) return null;
  const payload = record.payload;
  if (payload === undefined) return null;
  const organPath = payload[ORGAN_PATH_FIELD];
  const sha256 = payload["sha256"];
  if (typeof organPath !== "string" || typeof sha256 !== "string") return null;
  const normalized = normalizePathSpelling(organPath);
  if (normalized.length === 0) return null;
  return { organPath: normalized, sha256 };
}

/**
 * The record in which a human attested THIS digest FOR THIS path, latest first,
 * or `null`.
 *
 * Both halves are required and that is the whole rule: a digest attested for
 * some other organ is not evidence for this one. Two organ files with identical
 * bytes (two checkouts of the same hook entry, say) are still two files, and a
 * human who signed one has said nothing about the other.
 *
 * Unlike the policy attestation there is no "latest wins" supersession here.
 * Every organ attestation stands for the bytes it names: the guard asks about a
 * blob at a commit that may be months old, and the newest attestation of a file
 * says nothing about whether an older set of bytes was once signed off. The
 * gate reads none of these records, so a stale one authorizes nothing on its
 * own — it is evidence about a change, and evidence does not expire the way an
 * operative policy does.
 */
export function findOrganAttestation(
  records: readonly EventRecord[],
  organPath: string,
  sha256: string,
): EventRecord | null {
  const want = normalizePathSpelling(organPath);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as EventRecord;
    const fields = organAttestationOf(record);
    if (fields === null) continue;
    if (fields.organPath === want && fields.sha256 === sha256) return record;
  }
  return null;
}

/**
 * The most recent attestation of `organPath` at ANY digest, or `null`.
 *
 * What a status surface needs to tell "this file has never been attested" from
 * "this file was attested and has been edited since". Nothing enforcing reads
 * it: {@link findOrganAttestation} is the question the guard asks.
 */
export function latestOrganAttestation(
  records: readonly EventRecord[],
  organPath: string,
): OrganAttestation | null {
  const want = normalizePathSpelling(organPath);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as EventRecord;
    const fields = organAttestationOf(record);
    if (fields === null) continue;
    if (fields.organPath === want) return { ...fields, record };
  }
  return null;
}
