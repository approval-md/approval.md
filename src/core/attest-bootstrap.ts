/**
 * The operator's bootstrap attestation (APRV-449): `approval policy attest
 * --bootstrap`, the first attestation of a store that has never had one, and
 * nothing else.
 *
 * ## Why the plain verb is not enough for provisioning
 *
 * `appendAttestation` is an unconditional assertion about a file's bytes: it
 * reads no log and appends whatever the caller hands it, which is right for a
 * human at a terminal and wrong for a provisioning step that runs again on every
 * update and recreate of a sandbox. Two things go wrong with a re-run of the
 * plain verb:
 *
 * 1. It is not idempotent. A second run over the same bytes appends a second
 *    `policy.updated`, so the log grows an attestation per redeploy and the seq
 *    of the policy in force moves although nothing changed.
 * 2. It can overwrite a human's act. Once the resident has attested or amended
 *    their own policy, a re-run of the operator's step attests the bytes on disk
 *    as the operator, and the attester of record silently becomes the operator
 *    again. If the step re-rendered the policy first, the operator has just
 *    amended a resident's policy without the resident's tap.
 *
 * The bootstrap closes both by reading the verified log first:
 *
 * - no attestation in the log: attest, as the plain verb would;
 * - the live bytes already match the latest attestation: refuse
 *   `policy-already-attested`, append nothing (the expected answer on a re-run);
 * - the log carries an attestation of OTHER bytes: refuse
 *   `policy-amendment-required`, append nothing. A change to a policy that has
 *   been attested is an amendment, and an amendment is the approver's act
 *   through a channel (SPEC.md §10.3, APRV-109). The operator sets the starting
 *   policy only.
 *
 * ## Compare-and-append
 *
 * This is a check-then-append, so it passes the head it read as `expectedHead`
 * (SPEC.md §11.1): an attestation that lands between the read and the append
 * makes this one fail `head-moved` rather than stack an operator attestation on
 * top of it. The bytes are bound the same way: the digest the decision was made
 * on is passed as `expectedSha256`, so a file rewritten between the check and the
 * append is refused rather than attested.
 *
 * ## What it does not change
 *
 * The actor rule (human only), bytes-not-parse, config-declared identity and the
 * payload-store binding of APRV-356 are `appendAttestation`'s, untouched, because
 * the append IS `appendAttestation`. No timestamp is accepted: `policy.updated`
 * is gate-typed and core stamps it.
 */

import { readFileSync } from "node:fs";

import {
  appendAttestation,
  attesterAt,
  checkAttestationOfBytes,
  policyBytesHash,
  type AttestErrorCode,
  type AttestOptions,
} from "./attest.js";
import type { EventRecord } from "./log.js";
import { readVerifiedRecords, type LogReadRefusalCode } from "./state.js";

/** The two refusals only the bootstrap can give, beside the read and append codes. */
export const BOOTSTRAP_REFUSAL_CODES = [
  "policy-already-attested",
  "policy-amendment-required",
] as const;

export type BootstrapRefusalCode = (typeof BOOTSTRAP_REFUSAL_CODES)[number];

export type BootstrapErrorCode = BootstrapRefusalCode | LogReadRefusalCode | AttestErrorCode;

export interface BootstrapError {
  code: BootstrapErrorCode;
  message: string;
  /** The seq of the attestation in force, on the two bootstrap refusals. */
  seq?: number;
  /** Who made that attestation, as the verified record names them. */
  attested_by?: string | null;
}

export type BootstrapResult =
  | { ok: true; record: EventRecord; line: string }
  | { ok: false; error: BootstrapError };

/** `appendAttestation`'s options, less the digest binding this module supplies itself. */
export type BootstrapOptions = Omit<AttestOptions, "expectedSha256" | "expectedHead">;

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Attest `policyPath` as the store's FIRST policy, or refuse.
 *
 * `actor` must be `human:<id>`; the rule is `appendAttestation`'s and is not
 * re-stated here, so an `agent:` actor is refused `actor-not-human` before
 * anything is read.
 */
export function appendBootstrapAttestation(
  logPath: string,
  policyPath: string,
  actor: string,
  options: BootstrapOptions = {},
): BootstrapResult {
  if (!/^human:.+/u.test(actor)) {
    // Decided before the log is read, so the refusal is the same whatever state
    // the store is in. `appendAttestation` would refuse it too; answering here
    // keeps an agent actor from learning anything about the log first.
    return appendAttestation(logPath, policyPath, actor, options);
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return { ok: false, error: { code: read.code, message: read.message } };

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(policyPath);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "io",
        message: `policy ${policyPath} could not be read for attestation: ${detail(cause)}`,
      },
    };
  }

  const status = checkAttestationOfBytes(read.records, bytes);
  if (status.status === "attested") {
    const by = attesterAt(read.records, status.seq);
    return {
      ok: false,
      error: {
        code: "policy-already-attested",
        message: `${policyPath} already matches its attestation at seq ${String(status.seq)}${by === null ? "" : ` by ${by}`}; the bootstrap attests a store's first policy only, and nothing was appended`,
        seq: status.seq,
        attested_by: by,
      },
    };
  }
  if (status.status === "hash-mismatch") {
    const by = attesterAt(read.records, status.seq);
    return {
      ok: false,
      error: {
        code: "policy-amendment-required",
        message: `${policyPath} differs from the policy attested at seq ${String(status.seq)}${by === null ? "" : ` by ${by}`} (attested ${status.attestedSha256}, live ${status.liveSha256}); a change to an attested policy is an amendment, and an amendment is the approver's act through a channel (\`approval policy amend\` or a proposal they tap), never a re-run of the bootstrap. Nothing was appended`,
        seq: status.seq,
        attested_by: by,
      },
    };
  }

  return appendAttestation(logPath, policyPath, actor, {
    ...options,
    expectedSha256: policyBytesHash(bytes),
    expectedHead: read.head,
  });
}
