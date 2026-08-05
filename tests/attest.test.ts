/**
 * Policy attestation core tests (APRV-15 Part A).
 *
 * Every log under test is built exclusively through the real append path
 * (`appendAttestation` → `appendEvent`); nothing here hand-writes a record
 * line, because a hand-written line is a fabricated log entry. Records are read
 * back by parsing the file the writer produced, which also keeps the tests
 * honest about the shape that actually lands on disk.
 *
 * The cases that matter most are the refusals: an agent actor, a policy edited
 * after attestation, a log with no attestation at all, and a policy file that
 * cannot be read. All four must resolve away from "attested".
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  ATTESTATION_REFUSAL,
  HUMAN_ACTOR_ENV,
  attestationRefusal,
  checkAttestation,
  policyFileHash,
  resolveHumanActor,
} from "../src/core/attest.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { appendAttestation } from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-attest-"));
const restoreOnExit: string[] = [];
let counter = 0;

after(() => {
  for (const path of restoreOnExit) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already gone or already readable; nothing to do.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

const POLICY_TEXT = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "```",
  "",
].join("\n");

interface Case {
  dir: string;
  policyPath: string;
  logPath: string;
}

function freshCase(policyText: string = POLICY_TEXT): Case {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText, "utf8");
  return { dir, policyPath, logPath: join(dir, ".approval", "log", "events.jsonl") };
}

/** Read back what the writer actually put on disk. */
function readRecords(logPath: string): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

const TS = "2026-08-06T10:00:00Z";

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// ---------------------------------------------------------------------------
// policyFileHash
// ---------------------------------------------------------------------------

test("policyFileHash digests the file's exact bytes", () => {
  const { policyPath } = freshCase();
  const expected = createHash("sha256").update(readFileSync(policyPath)).digest("hex");
  assert.match(policyFileHash(policyPath), /^[a-f0-9]{64}$/);
  assert.equal(policyFileHash(policyPath), expected);
});

test("a one-byte difference is a different policy file", () => {
  const a = freshCase();
  const b = freshCase(`${POLICY_TEXT} `);
  assert.notEqual(policyFileHash(a.policyPath), policyFileHash(b.policyPath));
});

// ---------------------------------------------------------------------------
// checkAttestation
// ---------------------------------------------------------------------------

test("a log with no attestation is not-attested, and the refusal says so", () => {
  const { policyPath, logPath } = freshCase();
  const status = checkAttestation(readRecords(logPath), policyPath);

  assert.deepEqual(status, { status: "not-attested" });

  const refusal = attestationRefusal(status);
  assert.equal(refusal?.code, ATTESTATION_REFUSAL);
  assert.equal(refusal?.code, "policy-not-attested");
  assert.equal(refusal?.detail, "not-attested");
  assert.match(refusal?.message ?? "", /never been attested/);
});

test("attesting makes the live file attested at the recorded seq and hash", () => {
  const { policyPath, logPath } = freshCase();
  const appended = appendAttestation(logPath, policyPath, "human:carter", TS);
  assert.equal(appended.ok, true);
  assert.equal(appended.ok && appended.record.event, "policy.updated");
  assert.equal(appended.ok && appended.record.actor, "human:carter");
  assert.deepEqual(appended.ok ? appended.record.payload : null, {
    policy_path: "APPROVAL.md",
    sha256: policyFileHash(policyPath),
  });

  const status = checkAttestation(readRecords(logPath), policyPath);
  assert.deepEqual(status, {
    status: "attested",
    seq: appended.ok ? appended.record.seq : -1,
    sha256: policyFileHash(policyPath),
  });
  assert.equal(attestationRefusal(status), null);
});

test("the payload records the basename, never the absolute path", () => {
  const { policyPath, logPath } = freshCase();
  appendAttestation(logPath, policyPath, "human:carter", TS);
  const line = readFileSync(logPath, "utf8");
  assert.match(line, /"policy_path":"APPROVAL\.md"/);
  assert.equal(line.includes(scratch), false);
});

test("editing the policy after attestation is a hash-mismatch carrying both hashes", () => {
  const { policyPath, logPath } = freshCase();
  const before = policyFileHash(policyPath);
  const appended = appendAttestation(logPath, policyPath, "human:carter", TS);
  assert.equal(appended.ok, true);

  writeFileSync(policyPath, `${POLICY_TEXT}\n<!-- an agent edited this -->\n`, "utf8");
  const after = policyFileHash(policyPath);

  const status = checkAttestation(readRecords(logPath), policyPath);
  assert.deepEqual(status, {
    status: "hash-mismatch",
    attestedSha256: before,
    liveSha256: after,
    seq: appended.ok ? appended.record.seq : -1,
  });

  const refusal = attestationRefusal(status);
  assert.equal(refusal?.code, ATTESTATION_REFUSAL);
  assert.equal(refusal?.detail, "hash-mismatch");
  assert.match(refusal?.message ?? "", /inoperative until a human re-attests/);
});

test("re-attesting the edited file makes it attested again, at the newer seq", () => {
  const { policyPath, logPath } = freshCase();
  appendAttestation(logPath, policyPath, "human:carter", TS);
  writeFileSync(policyPath, `${POLICY_TEXT}\n<!-- reviewed and kept -->\n`, "utf8");
  assert.equal(checkAttestation(readRecords(logPath), policyPath).status, "hash-mismatch");

  const second = appendAttestation(logPath, policyPath, "human:carter", "2026-08-06T11:00:00Z");
  assert.equal(second.ok, true);

  const status = checkAttestation(readRecords(logPath), policyPath);
  assert.deepEqual(status, {
    status: "attested",
    seq: second.ok ? second.record.seq : -1,
    sha256: policyFileHash(policyPath),
  });
  // The latest attestation wins: the stale one must not vouch for these bytes.
  assert.equal(second.ok && second.record.seq, 2);
});

test("a policy.updated with no sha256 payload is ignored — fail closed", () => {
  const { policyPath, logPath } = freshCase();
  // A pre-attestation-era event: the type existed before this verb did.
  const legacy = appendEvent(logPath, {
    ts: TS,
    event: "policy.updated",
    actor: "human:carter",
    payload: { path: "APPROVAL.md", note: "edited by hand" },
  });
  assert.equal(legacy.ok, true);

  assert.deepEqual(checkAttestation(readRecords(logPath), policyPath), { status: "not-attested" });
});

test("a policy.updated with no payload at all is ignored", () => {
  const { policyPath, logPath } = freshCase();
  const bare = appendEvent(logPath, { ts: TS, event: "policy.updated", actor: "human:carter" });
  assert.equal(bare.ok, true);
  assert.deepEqual(checkAttestation(readRecords(logPath), policyPath), { status: "not-attested" });
});

test("an unreadable policy file is unreadable, never attested", { skip: isRoot() }, () => {
  const { policyPath, logPath } = freshCase();
  const appended = appendAttestation(logPath, policyPath, "human:carter", TS);
  assert.equal(appended.ok, true);

  chmodSync(policyPath, 0o000);
  restoreOnExit.push(policyPath);

  const status = checkAttestation(readRecords(logPath), policyPath);
  assert.equal(status.status, "unreadable");
  assert.match(status.status === "unreadable" ? status.message : "", /could not be read/);

  const refusal = attestationRefusal(status);
  assert.equal(refusal?.code, ATTESTATION_REFUSAL);
  assert.equal(refusal?.detail, "unreadable");
  assert.match(refusal?.message ?? "", /unverifiable policy is treated as unattested/);
});

// ---------------------------------------------------------------------------
// appendAttestation: the human-only rule
// ---------------------------------------------------------------------------

test("an agent actor is refused and nothing is written", () => {
  const { policyPath, logPath } = freshCase();
  const result = appendAttestation(logPath, policyPath, "agent:planner", TS);

  assert.equal(result.ok, false);
  // APRV-20 pass two: its own code, not `validation`. "You are not allowed to
  // perform this verb" and "your record failed the event schema" are different
  // facts calling for different responses, and they used to share a name.
  assert.equal(result.ok === false && result.error.code, "actor-not-human");
  assert.match(result.ok === false ? result.error.message : "", /requires a human actor/);
  assert.deepEqual(readRecords(logPath), []);
});

test("a system actor is refused too", () => {
  const { policyPath, logPath } = freshCase();
  const result = appendAttestation(logPath, policyPath, "system:daemon", TS);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "actor-not-human");
  assert.deepEqual(readRecords(logPath), []);
});

test("an empty human id is refused", () => {
  const { policyPath, logPath } = freshCase();
  assert.equal(appendAttestation(logPath, policyPath, "human:", TS).ok, false);
  assert.deepEqual(readRecords(logPath), []);
});

test("an absent policy file is an io refusal, not an append", () => {
  const { dir, logPath } = freshCase();
  const result = appendAttestation(logPath, join(dir, "nope.md"), "human:carter", TS);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "io");
  assert.deepEqual(readRecords(logPath), []);
});

test("a schema-invalid policy file still attests: bytes, not parse", () => {
  const { policyPath, logPath } = freshCase("this is not a policy file at all\n");
  const result = appendAttestation(logPath, policyPath, "human:carter", TS);

  assert.equal(result.ok, true);
  assert.deepEqual(checkAttestation(readRecords(logPath), policyPath), {
    status: "attested",
    seq: 1,
    sha256: policyFileHash(policyPath),
  });
});

// ---------------------------------------------------------------------------
// resolveHumanActor
// ---------------------------------------------------------------------------

test("resolveHumanActor prefers the explicit option over the environment", () => {
  const previous = process.env[HUMAN_ACTOR_ENV];
  process.env[HUMAN_ACTOR_ENV] = "human:from-env";
  try {
    assert.equal(resolveHumanActor({ actor: "human:explicit" }), "human:explicit");
    assert.equal(resolveHumanActor(), "human:from-env");
    assert.equal(resolveHumanActor({}), "human:from-env");
    // An explicit non-human actor does NOT fall back to the environment.
    assert.equal(resolveHumanActor({ actor: "agent:planner" }), null);
  } finally {
    if (previous === undefined) delete process.env[HUMAN_ACTOR_ENV];
    else process.env[HUMAN_ACTOR_ENV] = previous;
  }
});

test("resolveHumanActor is null with no declared identity, and rejects a non-human env", () => {
  const previous = process.env[HUMAN_ACTOR_ENV];
  try {
    delete process.env[HUMAN_ACTOR_ENV];
    assert.equal(resolveHumanActor(), null);
    process.env[HUMAN_ACTOR_ENV] = "agent:planner";
    assert.equal(resolveHumanActor(), null);
    process.env[HUMAN_ACTOR_ENV] = "human:";
    assert.equal(resolveHumanActor(), null);
  } finally {
    if (previous === undefined) delete process.env[HUMAN_ACTOR_ENV];
    else process.env[HUMAN_ACTOR_ENV] = previous;
  }
});
