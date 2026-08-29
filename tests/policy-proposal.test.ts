/**
 * The attestation ceremony collected through a channel (APRV-109).
 *
 * `core/policy-proposal.ts` is the half of the ceremony that does not attest:
 * it asks. These tests pin the two properties the design rests on and the six
 * ways it refuses.
 *
 * **What is computed.** The hash, the semantic diff and the load advisory on a
 * proposal are derived from the policy bytes here, never accepted from the
 * proposer. `ProposeInput` carries no field for any of the three, so the
 * strongest statement a test can make is the one made below: the recorded
 * values equal what the bytes produce, and the one piece of material a caller
 * DOES supply — the diff baseline — is re-hashed and thrown away when it is not
 * the attested text.
 *
 * **What the tap attests.** The hash the prompt displayed, or nothing. A file
 * that moved under an open prompt refuses `proposal-stale` and appends nothing,
 * which is the check that makes "the phone showed the diff and the hash" mean
 * something.
 *
 * Every log here is built through the real append path (`proposeAttestation` /
 * `decideAttestation` → `appendEvent`). Nothing hand-writes a record line, and
 * the cases that must write nothing are asserted by comparing the log bytes
 * before and after.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { checkAttestation, policyFileHash } from "../src/core/attest.js";
import type { EventRecord } from "../src/core/log.js";
import {
  ATTESTATION_DIFF_MAX_LINES,
  attestationActionKey,
  attestationKeySha256,
  decideAttestation,
  isAttestationActionKey,
  openProposals,
  proposalState,
  proposeAttestation,
} from "../src/core/policy-proposal.js";
import { appendAttestation } from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-proposal-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const TS = "2026-08-29T10:00:00Z";
const LATER = "2026-08-29T10:05:00Z";

function policyText(body: string[]): string {
  return ["# Policy", "", "```yaml approval-policy", ...body, "```", ""].join("\n");
}

const BEFORE = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "approvers:",
  "  carter:",
  "    channels: [telegram]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
]);

/** BEFORE with one class resolution tightened: a diff a phone can hold. */
const AFTER = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "approvers:",
  "  carter:",
  "    channels: [telegram]",
  "classes:",
  "  read.*:",
  "    autonomy: manual",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
]);

/** A policy that does not load: the load advisory has something to say. */
const BROKEN = policyText(['version: "0.1"', "defaults:", "  autonomy: whenever"]);

/** BEFORE plus `count` classes, so the rendered diff blows the channel budget. */
function wide(count: number): string {
  const classes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    classes.push(`  widget${String(index)}.write:`, "    autonomy: manual");
  }
  return policyText([
    'version: "0.1"',
    "defaults:",
    "  autonomy: supervised",
    "approvers:",
    "  carter:",
    "    channels: [telegram]",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    ...classes,
  ]);
}

interface Case {
  dir: string;
  policyPath: string;
  logPath: string;
}

function freshCase(text: string = BEFORE): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, text, "utf8");
  return { dir, policyPath, logPath: join(dir, ".approval", "log", "events.jsonl") };
}

function records(logPath: string): EventRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function logBytes(logPath: string): string {
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

function payloadOf(record: EventRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

/** Attest BEFORE, then write `next`: the state every amendment starts from. */
function amended(next: string, text: string = BEFORE): Case & { baseline: Uint8Array } {
  const unit = freshCase(text);
  const baseline = readFileSync(unit.policyPath);
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter", TS).ok, true);
  writeFileSync(unit.policyPath, next, "utf8");
  return { ...unit, baseline };
}

// ---------------------------------------------------------------------------
// The action key
// ---------------------------------------------------------------------------

test("an attestation key names the proposed bytes and nothing else", () => {
  const sha256 = "a".repeat(64);
  assert.equal(attestationActionKey(sha256), `policy.attest:${sha256}`);
  assert.equal(isAttestationActionKey(attestationActionKey(sha256)), true);
  assert.equal(attestationKeySha256(attestationActionKey(sha256)), sha256);

  // Anything that is not a well-formed key resolves to no hash at all, so a
  // gesture carrying one can never be steered onto the attestation verb.
  assert.equal(isAttestationActionKey("communicate.send"), false);
  assert.equal(attestationKeySha256("communicate.send"), null);
  assert.equal(attestationKeySha256("policy.attest:not-a-hash"), null);
  assert.equal(attestationKeySha256(`policy.attest:${"A".repeat(64)}`), null);
});

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

test("a proposal computes the hash, the diff and the advisory from the bytes", () => {
  const unit = amended(AFTER);
  const proposed = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, baseline: unit.baseline, note: "tightening read.*" },
    "agent:planner",
    { clock: () => LATER },
  );
  assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.message);
  if (!proposed.ok) return;

  // The hash is the file's, and the record's `ts` is the injected clock's: a
  // gate-typed event never takes a caller's timestamp (SPEC.md §11.1(2)).
  assert.equal(proposed.sha256, policyFileHash(unit.policyPath));
  assert.equal(proposed.record.event, "policy.proposed");
  assert.equal(proposed.record.actor, "agent:planner");
  assert.equal(proposed.record.ts, LATER);
  assert.equal(proposed.record.action_key, attestationActionKey(proposed.sha256));

  const payload = payloadOf(proposed.record);
  assert.equal(payload["sha256"], proposed.sha256);
  assert.equal(payload["policy_path"], "APPROVAL.md");
  assert.equal(payload["class"], "policy.edit");
  assert.match(String(payload["payload_hash"]), /^[a-f0-9]{64}$/u);
  // The proposer's own words ride as `note` and are rendered claimed; they are
  // the one field on the prompt the runtime does not stand behind.
  assert.equal(payload["note"], "tightening read.*");

  // The semantic diff is available, names what moved, and is the baseline's.
  assert.equal(proposed.diff.available, true);
  assert.equal(proposed.diff.baseline_sha256, checkAttestedHash(unit.logPath));
  assert.match(proposed.diff.headline, /class resolution/u);
  assert.equal(
    proposed.diff.lines.some((line) => line.includes("read.")),
    true,
    `expected the read.* move in ${JSON.stringify(proposed.diff.lines)}`,
  );
  assert.equal(proposed.load.ok, true);
});

/** The hash of the latest attestation in the log. */
function checkAttestedHash(logPath: string): string | null {
  const attestations = records(logPath).filter((record) => record.event === "policy.updated");
  const last = attestations[attestations.length - 1];
  return last === undefined ? null : (payloadOf(last)["sha256"] as string);
}

test("a baseline that is not the attested text falls to hash-only mode", () => {
  const unit = amended(AFTER);
  const proposed = proposeAttestation(
    unit.logPath,
    // Bytes nobody attested. They are re-hashed here and refused as a baseline.
    { policyPath: unit.policyPath, baseline: Buffer.from(BROKEN, "utf8") },
    "agent:planner",
    { clock: () => LATER },
  );
  assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.message);
  if (!proposed.ok) return;

  assert.equal(proposed.diff.available, false);
  assert.equal(proposed.diff.lines.length, 0);
  assert.equal(proposed.diff.baseline_sha256, null);
  assert.match(String(proposed.diff.reason), /not the attested|nobody can verify/u);
});

test("the load advisory says a proposed policy does not load", () => {
  const unit = amended(BROKEN);
  const proposed = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, baseline: unit.baseline },
    "agent:planner",
    { clock: () => LATER },
  );
  assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.message);
  if (!proposed.ok) return;

  assert.equal(proposed.load.ok, false);
  assert.equal(typeof proposed.load.code, "string");
  // And it is on the RECORD, so the channel renders the advisory the prompt was
  // built from rather than one it recomputed for itself.
  assert.equal((payloadOf(proposed.record)["load"] as { ok: boolean }).ok, false);
});

test("a diff too large for a channel is REFUSED, never truncated", () => {
  const unit = amended(wide(ATTESTATION_DIFF_MAX_LINES + 20));
  const before = logBytes(unit.logPath);
  const proposed = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, baseline: unit.baseline },
    "agent:planner",
    { clock: () => LATER },
  );

  assert.equal(proposed.ok, false);
  if (proposed.ok) return;
  assert.equal(proposed.code, "diff-too-large");
  // The repair the message names is the terminal path, not a smaller prompt.
  assert.match(proposed.message, /at a terminal/u);
  assert.match(proposed.message, /Nothing was appended/u);
  assert.equal(logBytes(unit.logPath), before, "a refused proposal wrote to the log");
});

test("a policy that already matches its attestation has nothing to propose", () => {
  const unit = freshCase();
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter", TS).ok, true);
  const before = logBytes(unit.logPath);

  const proposed = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath },
    "agent:planner",
    { clock: () => LATER },
  );
  assert.equal(proposed.ok, false);
  if (proposed.ok) return;
  assert.equal(proposed.code, "policy-already-attested");
  assert.equal(logBytes(unit.logPath), before);
});

test("the runtime may not propose a policy of its own", () => {
  const unit = amended(AFTER);
  const before = logBytes(unit.logPath);
  for (const actor of ["system:daemon", "carter", ""]) {
    const proposed = proposeAttestation(
      unit.logPath,
      { policyPath: unit.policyPath, baseline: unit.baseline },
      actor,
      { clock: () => LATER },
    );
    assert.equal(proposed.ok, false, `${actor} was allowed to propose`);
    if (proposed.ok) return;
    assert.equal(proposed.code, "actor-invalid");
  }
  assert.equal(logBytes(unit.logPath), before);
});

test("a human may propose too: the ask is not agent-only", () => {
  const unit = amended(AFTER);
  const proposed = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, baseline: unit.baseline },
    "human:carter",
    { clock: () => LATER },
  );
  assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.message);
});

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/** Propose AFTER over an attested BEFORE, and return the proposal's seq. */
function proposed(unit: Case & { baseline: Uint8Array }, waitUntil?: string): number {
  const result = proposeAttestation(
    unit.logPath,
    {
      policyPath: unit.policyPath,
      baseline: unit.baseline,
      ...(waitUntil === undefined ? {} : { waitUntil }),
    },
    "agent:planner",
    { clock: () => LATER },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.ok ? result.record.seq : -1;
}

test("a tap attests the bytes the prompt displayed, under the approver's identity", () => {
  const unit = amended(AFTER);
  const seq = proposed(unit);

  const decided = decideAttestation(unit.logPath, seq, "attest", "human:carter", {
    clock: () => LATER,
    policyPath: unit.policyPath,
    batchDeliveryId: "telegram-42",
  });
  assert.equal(decided.ok, true, decided.ok ? "" : decided.message);
  if (!decided.ok) return;

  assert.equal(decided.record.event, "policy.updated");
  assert.equal(decided.record.actor, "human:carter");
  assert.equal(decided.record.ts, LATER);
  const payload = payloadOf(decided.record);
  assert.equal(payload["sha256"], policyFileHash(unit.policyPath));
  assert.equal(payload["proposed_seq"], seq);
  assert.equal(payload["batch_delivery_id"], "telegram-42");

  // The policy is now attested, by exactly the record the tap appended.
  const status = checkAttestation(records(unit.logPath), unit.policyPath);
  assert.equal(status.status, "attested");
  assert.equal(proposalState(records(unit.logPath), seq, LATER)?.state, "attested");
});

test("an agent may not answer its own attestation prompt", () => {
  const unit = amended(AFTER);
  const seq = proposed(unit);
  const before = logBytes(unit.logPath);

  for (const actor of ["agent:planner", "system:daemon"]) {
    const decided = decideAttestation(unit.logPath, seq, "attest", actor, {
      clock: () => LATER,
      policyPath: unit.policyPath,
    });
    assert.equal(decided.ok, false, `${actor} attested`);
    if (decided.ok) return;
    assert.equal(decided.code, "actor-not-human");
  }
  assert.equal(logBytes(unit.logPath), before);
});

test("bytes that moved under an open prompt refuse proposal-stale and attest nothing", () => {
  const unit = amended(AFTER);
  const seq = proposed(unit);
  // The file changes after the question was asked. Whatever the approver is
  // looking at, it is not this.
  writeFileSync(unit.policyPath, `${AFTER}\n# a later edit\n`, "utf8");
  const before = logBytes(unit.logPath);

  const decided = decideAttestation(unit.logPath, seq, "attest", "human:carter", {
    clock: () => LATER,
    policyPath: unit.policyPath,
  });
  assert.equal(decided.ok, false);
  if (decided.ok) return;
  assert.equal(decided.code, "proposal-stale");
  assert.match(decided.message, /never shown|Nothing was attested/u);
  assert.equal(logBytes(unit.logPath), before);
  assert.equal(checkAttestation(records(unit.logPath), unit.policyPath).status, "hash-mismatch");
});

test("a decline records the refusal and attests nothing", () => {
  const unit = amended(AFTER);
  const seq = proposed(unit);

  const decided = decideAttestation(unit.logPath, seq, "decline", "human:carter", {
    clock: () => LATER,
    policyPath: unit.policyPath,
    note: "not this week",
  });
  assert.equal(decided.ok, true, decided.ok ? "" : decided.message);
  if (!decided.ok) return;

  assert.equal(decided.record.event, "policy.declined");
  assert.equal(decided.record.actor, "human:carter");
  assert.equal(payloadOf(decided.record)["proposed_seq"], seq);
  assert.equal(payloadOf(decided.record)["note"], "not this week");

  // The policy is exactly as unattested as it was before the prompt.
  assert.equal(checkAttestation(records(unit.logPath), unit.policyPath).status, "hash-mismatch");
  assert.equal(proposalState(records(unit.logPath), seq, LATER)?.state, "declined");
});

test("a second answer is refused: the first human answer stands", () => {
  const unit = amended(AFTER);
  const seq = proposed(unit);
  assert.equal(
    decideAttestation(unit.logPath, seq, "decline", "human:carter", {
      clock: () => LATER,
      policyPath: unit.policyPath,
    }).ok,
    true,
  );
  const before = logBytes(unit.logPath);

  const again = decideAttestation(unit.logPath, seq, "attest", "human:carter", {
    clock: () => LATER,
    policyPath: unit.policyPath,
  });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.code, "already-decided");
  assert.equal(logBytes(unit.logPath), before);
});

test("a lapsed prompt attests nothing and appends nothing", () => {
  const unit = amended(AFTER);
  const seq = proposed(unit, LATER);
  const before = logBytes(unit.logPath);

  // `now` is the deadline, so the prompt has lapsed. A lapse materialises no
  // event: the proposal record already says everything a reader needs.
  const decided = decideAttestation(unit.logPath, seq, "attest", "human:carter", {
    clock: () => LATER,
    policyPath: unit.policyPath,
  });
  assert.equal(decided.ok, false);
  if (decided.ok) return;
  assert.equal(decided.code, "expired");
  assert.equal(logBytes(unit.logPath), before);
  assert.equal(proposalState(records(unit.logPath), seq, LATER)?.state, "expired");
  // And it leaves every queue by derivation, which is what retires the prompt.
  assert.deepEqual(openProposals(records(unit.logPath), LATER), []);
});

test("a newer proposal for the same policy supersedes the older one", () => {
  const unit = amended(AFTER);
  const first = proposed(unit);
  writeFileSync(unit.policyPath, `${AFTER}\n# a second amendment\n`, "utf8");
  const second = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, baseline: unit.baseline },
    "agent:planner",
    { clock: () => LATER },
  );
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (!second.ok) return;

  const all = records(unit.logPath);
  assert.equal(proposalState(all, first, LATER)?.state, "superseded");
  assert.equal(proposalState(all, second.record.seq, LATER)?.state, "open");
  assert.deepEqual(
    openProposals(all, LATER).map((entry) => entry.seq),
    [second.record.seq],
  );
});

test("answering a seq that is not a proposal is proposal-not-found", () => {
  const unit = amended(AFTER);
  const before = logBytes(unit.logPath);
  const decided = decideAttestation(unit.logPath, 1, "attest", "human:carter", {
    clock: () => LATER,
    policyPath: unit.policyPath,
  });
  assert.equal(decided.ok, false);
  if (decided.ok) return;
  assert.equal(decided.code, "proposal-not-found");
  assert.equal(logBytes(unit.logPath), before);
});
