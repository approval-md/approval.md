/**
 * Organ attestation core tests (APRV-272).
 *
 * The defect this covers, verified on PR #300: a human hand-committed the
 * harness settings file and the protected-path guard failed the change. It
 * could not have passed. The file is `policy.core`, `policy.core` is human-only,
 * and the gate refuses to mint any record at all for a human-only class — so the
 * guard's `granted-file` and `granted-command` verdicts cannot exist for it, and
 * its `attested` verdict was wired to the policy file alone.
 *
 * So there are two claims here and they are different sizes. The small one is
 * that the new verb records what it says it records. The large one is that the
 * new record is INVISIBLE to the gate: an organ attestation must not make an
 * unattested policy operative, and must not change the `policy_sha256` a request
 * or a grant is decided under. That half is driven through the real gate on a
 * real log rather than asserted about the reader in isolation, because the thing
 * that would break is the gate.
 *
 * Every log here is built through the real append path (`core/attest.ts` →
 * `core/log.ts`) and read back by parsing the file the writer produced. Nothing
 * hand-writes a record line.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  ATTESTATION_REFUSAL,
  ORGAN_ATTESTATION_EVENT,
  appendOrganAttestation,
  checkAttestation,
  findOrganAttestation,
  latestOrganAttestation,
  organAttestationOf,
  policyBytesHash,
} from "../src/core/attest.js";
import { decide, register, request } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import {
  at,
  attest,
  fixedClock,
  newScenario,
  payloadOf,
  records,
  scratchRoot,
  type Scenario,
} from "./scenario.js";

const HUMAN = "human:carter";
const AGENT = "agent:claude-code";
const ORGAN = ".claude/settings.json";

const { root, cleanup } = scratchRoot("attest-organ");
after(cleanup);

const SETTINGS = JSON.stringify(
  { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "approval hook claude-code" }] }] } },
  null,
  2,
);

/** A scenario whose checkout carries one organ file, written to disk. */
function withOrgan(text: string = SETTINGS, path: string = ORGAN): Scenario {
  const unit = newScenario(root);
  writeOrgan(unit, path, text);
  return unit;
}

function writeOrgan(unit: Scenario, path: string, text: string): string {
  const onDisk = join(unit.dir, ...path.split("/"));
  mkdirSync(join(onDisk, ".."), { recursive: true });
  writeFileSync(onDisk, text, "utf8");
  return onDisk;
}

function organRecords(unit: Scenario): EventRecord[] {
  return records(unit);
}

const TASK = "task-1";
const ACTION_KEY = "task-1:chaser";
const MATERIAL = { to: "ops@example.com", body: "chasing the invoice" };

/** One registration, in the envelope shape `core/gate.ts` actually takes. */
function registration(): Parameters<typeof register>[1] {
  return {
    task: TASK,
    envelope: {
      origin: { app: "claude-code", created_by: "agent:claude-code" },
      state: "proposed",
      actions: [
        {
          class: "communicate.email.external",
          summary: "send the chaser",
          reversible: false,
          est_cost_usd: "0",
          idempotency_key: ACTION_KEY,
          payload_hash: payloadHash(MATERIAL),
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test("attesting an organ records the path and the runtime's own digest", () => {
  const unit = withOrgan();
  const result = appendOrganAttestation(
    unit.logPath,
    { path: ORGAN, root: unit.dir },
    HUMAN,
    { clock: fixedClock(at(1)) },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.event, ORGAN_ATTESTATION_EVENT);
  assert.equal(result.record.event, "gate.organ.attested");
  assert.equal(result.record.actor, HUMAN);
  assert.deepEqual(Object.keys(payloadOf(result.record)).sort(), ["organ_path", "sha256"]);
  assert.equal(payloadOf(result.record)["organ_path"], ORGAN);
  // The digest is the file's bytes, and the caller passed no hash: there is no
  // parameter for one.
  assert.equal(
    payloadOf(result.record)["sha256"],
    policyBytesHash(readFileSync(join(unit.dir, ".claude", "settings.json"))),
  );
});

test("the record carries no policy_path, so no policy reader can mistake it", () => {
  const unit = withOrgan();
  const result = appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, HUMAN);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(payloadOf(result.record)["policy_path"], undefined);
  assert.notEqual(result.record.event, "policy.updated");
});

test("a spelling with ./ attests the same identity a plain path does", () => {
  const unit = withOrgan();
  const result = appendOrganAttestation(
    unit.logPath,
    { path: "./.claude/settings.json", root: unit.dir },
    HUMAN,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(payloadOf(result.record)["organ_path"], ORGAN);
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test("an agent actor is refused and nothing is written", () => {
  const unit = withOrgan();
  const result = appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, AGENT);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "actor-not-human");
  assert.equal(organRecords(unit).length, 0);
});

test("a system actor is refused too", () => {
  const unit = withOrgan();
  const result = appendOrganAttestation(
    unit.logPath,
    { path: ORGAN, root: unit.dir },
    "system:daemon",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "actor-not-human");
});

test("the policy file is refused with its own code, not the generic one", () => {
  const unit = withOrgan();
  const result = appendOrganAttestation(
    unit.logPath,
    { path: "APPROVAL.md", root: unit.dir },
    HUMAN,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  // Distinct from `path-not-organ` because the repair is distinct: the policy
  // file has its own verb, and the gate reads its attestation on every
  // operation.
  assert.equal(result.error.code, "path-is-policy");
  assert.match(result.error.message, /approval policy attest/u);
  assert.equal(organRecords(unit).length, 0);
});

test("the approval home is refused: it is the human's own ceremony surface", () => {
  const unit = withOrgan();
  for (const path of [".approval/env", ".approval/log/events.jsonl", ".approval/QUEUE.md"]) {
    const result = appendOrganAttestation(unit.logPath, { path, root: unit.dir }, HUMAN);
    assert.equal(result.ok, false, path);
    if (result.ok) continue;
    assert.equal(result.error.code, "path-not-organ", path);
  }
  assert.equal(organRecords(unit).length, 0);
});

test("an ordinary file is refused: this verb is not a general blessing", () => {
  const unit = withOrgan();
  for (const path of ["src/core/gate.ts", "SPEC.md", "CLAUDE.md", ".github/workflows/ci.yml"]) {
    const result = appendOrganAttestation(unit.logPath, { path, root: unit.dir }, HUMAN);
    assert.equal(result.ok, false, path);
    if (result.ok) continue;
    assert.equal(result.error.code, "path-not-organ", path);
  }
});

test("an absolute path and a .. path are refused before anything is read", () => {
  const unit = withOrgan();
  for (const path of [join(unit.dir, ".claude", "settings.json"), "../other/.claude/settings.json"]) {
    const result = appendOrganAttestation(unit.logPath, { path, root: unit.dir }, HUMAN);
    assert.equal(result.ok, false, path);
    if (result.ok) continue;
    assert.equal(result.error.code, "path-not-organ", path);
  }
});

test("an organ that is not on disk is an io refusal, not an append", () => {
  const unit = newScenario(root);
  const result = appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, HUMAN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "io");
  assert.equal(organRecords(unit).length, 0);
});

// ---------------------------------------------------------------------------
// Reading the records back
// ---------------------------------------------------------------------------

test("a digest attested for one path is not evidence for another", () => {
  const unit = withOrgan();
  const cursor = ".cursor/hooks.json";
  writeOrgan(unit, cursor, SETTINGS);

  assert.equal(
    appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, HUMAN).ok,
    true,
  );
  const all = organRecords(unit);
  const sha = policyBytesHash(readFileSync(join(unit.dir, ".claude", "settings.json")));

  assert.notEqual(findOrganAttestation(all, ORGAN, sha), null);
  // Byte-identical bytes at a path nobody attested. The digest matches and the
  // path does not, and both halves are required.
  assert.equal(
    policyBytesHash(readFileSync(join(unit.dir, ".cursor", "hooks.json"))),
    sha,
    "the two organ files should be byte-identical for this case to mean anything",
  );
  assert.equal(findOrganAttestation(all, cursor, sha), null);
});

test("editing the organ after attestation leaves the new bytes unattested", () => {
  const unit = withOrgan();
  assert.equal(
    appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, HUMAN).ok,
    true,
  );
  const before = policyBytesHash(readFileSync(join(unit.dir, ".claude", "settings.json")));

  writeOrgan(unit, ORGAN, `${SETTINGS}\n`);
  const after = policyBytesHash(readFileSync(join(unit.dir, ".claude", "settings.json")));
  const all = organRecords(unit);

  assert.notEqual(before, after);
  assert.equal(findOrganAttestation(all, ORGAN, after), null);
  // The older bytes stay attested: an organ record is evidence about a change,
  // not a statement about which bytes are operative now.
  assert.notEqual(findOrganAttestation(all, ORGAN, before), null);
  assert.equal(latestOrganAttestation(all, ORGAN)?.sha256, before);
});

test("a record with no organ_path or no sha256 is not an attestation", () => {
  const unit = withOrgan();
  attest(unit);
  const record = records(unit)[0] as EventRecord;
  assert.equal(organAttestationOf(record), null, "a policy.updated is not an organ attestation");
  assert.equal(
    organAttestationOf({ ...record, event: ORGAN_ATTESTATION_EVENT, payload: {} }),
    null,
  );
  assert.equal(
    organAttestationOf({
      ...record,
      event: ORGAN_ATTESTATION_EVENT,
      payload: { organ_path: ORGAN },
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// The gate cannot see it (AC #2)
// ---------------------------------------------------------------------------

test("an organ attestation does NOT make an unattested policy operative", () => {
  const unit = withOrgan();
  // The policy is never attested. The only attestation in this log is an organ.
  assert.equal(
    appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, HUMAN, {
      clock: fixedClock(at(1)),
    }).ok,
    true,
  );

  assert.equal(checkAttestation(records(unit), unit.policyPath).status, "not-attested");

  register(unit.logPath, registration(), "agent:claude-code", {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: ACTION_KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0",
      summary: "send the chaser",
      payload_hash: payloadHash(MATERIAL),
      payload: { value: MATERIAL },
    },
    "agent:claude-code",
    { ...unit.options, clock: fixedClock(at(3)) },
  );

  assert.equal(requested.ok, false, "the gate must refuse under an unattested policy");
  if (requested.ok) return;
  assert.equal(requested.code, ATTESTATION_REFUSAL);
  assert.equal(requested.detail, "not-attested");
});

test("an organ attestation does not change policy_sha256 on a request or a grant", () => {
  const unit = withOrgan();
  attest(unit, at(0));
  const policySha = policyBytesHash(readFileSync(unit.policyPath));

  const registered = register(unit.logPath, registration(), "agent:claude-code", {
    ...unit.options,
    clock: fixedClock(at(1)),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));

  // The organ attestation lands BETWEEN the policy attestation and the gate
  // operations: the position that would break a reader scanning backwards for
  // the newest record carrying a `sha256`.
  assert.equal(
    appendOrganAttestation(unit.logPath, { path: ORGAN, root: unit.dir }, HUMAN, {
      clock: fixedClock(at(2)),
    }).ok,
    true,
  );

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: ACTION_KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0",
      summary: "send the chaser",
      payload_hash: payloadHash(MATERIAL),
      payload: { value: MATERIAL },
    },
    "agent:claude-code",
    { ...unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const granted = decide(unit.logPath, ACTION_KEY, "grant", HUMAN, {
    ...unit.options,
    clock: fixedClock(at(4)),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));

  const all = records(unit);
  const requestRecord = all.find((entry) => entry.event === "approval.requested");
  const grantRecord = all.find((entry) => entry.event === "approval.granted");
  assert.notEqual(requestRecord, undefined);
  assert.notEqual(grantRecord, undefined);
  assert.equal(payloadOf(requestRecord as EventRecord)["policy_sha256"], policySha);
  assert.equal(payloadOf(grantRecord as EventRecord)["policy_sha256"], policySha);

  // And the policy still reads as attested at ITS record, not at the organ's.
  const status = checkAttestation(all, unit.policyPath);
  assert.equal(status.status, "attested");
  if (status.status !== "attested") return;
  assert.equal(status.sha256, policySha);
  const organSeq = all.find((entry) => entry.event === ORGAN_ATTESTATION_EVENT)?.seq;
  assert.notEqual(organSeq, undefined);
  assert.notEqual(status.seq, organSeq);
});
