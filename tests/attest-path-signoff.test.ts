/**
 * Protected-path sign-off core tests (APRV-338).
 *
 * The gap this covers: SPEC.md's amendment-provenance rule says text that
 * reached a protected file without a grant carries `(Amended APRV-n, pending
 * sign-off.)` and holds no more authority than a proposal until a human
 * ratifies it — and nothing recorded the ratification. There was no event, no
 * verb, and no way for CI or doctor to tell a ratified amendment from a pending
 * one. PR #393 is what that costs: two SPEC.md hunks the policy had let proceed
 * unsampled, blocked by the guard, with no route out but re-editing under a
 * grant or changing the guard.
 *
 * Three claims are asserted here and they are different sizes. The small one is
 * that the verb records what it says it records. The middle one is that it
 * refuses every path that is not a `policy.edit` surface, with a code per
 * repair. The large one is that the record is INVISIBLE to the gate and to the
 * organ reader: a sign-off must not make an unattested policy operative, must
 * not answer an organ's question, and must not be answered by one.
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
  PATH_SIGN_OFF_EVENT,
  appendOrganAttestation,
  appendPathSignOff,
  checkAttestation,
  findOrganAttestation,
  findPathSignOff,
  latestPathSignOff,
  organAttestationOf,
  pathSignOffOf,
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
const SPEC = "SPEC.md";
const SPEC_TEXT = "# Spec\n\nA sentence. (Amended APRV-338, pending sign-off.)\n";

const { root, cleanup } = scratchRoot("attest-path-signoff");
after(cleanup);

/** A scenario whose checkout carries one protected file, written to disk. */
function withFile(text: string = SPEC_TEXT, path: string = SPEC): Scenario {
  const unit = newScenario(root);
  writeProtected(unit, path, text);
  return unit;
}

function writeProtected(unit: Scenario, path: string, text: string): string {
  const onDisk = join(unit.dir, ...path.split("/"));
  mkdirSync(join(onDisk, ".."), { recursive: true });
  writeFileSync(onDisk, text, "utf8");
  return onDisk;
}

/** `SPEC.md` is not a BUILT-IN protected path: a policy has to widen to it. */
const PROTECTS_SPEC = [SPEC];

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

test("signing off a protected path records the path and the runtime's own digest", () => {
  const unit = withFile();
  const result = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
    { clock: fixedClock(at(1)) },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.record.event, PATH_SIGN_OFF_EVENT);
  assert.equal(result.record.event, "gate.path.signed_off");
  assert.equal(result.record.actor, HUMAN);
  assert.deepEqual(Object.keys(payloadOf(result.record)).sort(), ["path", "sha256"]);
  assert.equal(payloadOf(result.record)["path"], SPEC);
  // The digest is the file's bytes, and the caller passed no hash: there is no
  // parameter for one.
  assert.equal(
    payloadOf(result.record)["sha256"],
    policyBytesHash(readFileSync(join(unit.dir, SPEC))),
  );
});

test("a built-in policy.edit path needs no policy entry to be signable", () => {
  const unit = withFile("# Claude\n\npending sign-off\n", "CLAUDE.md");
  const result = appendPathSignOff(unit.logPath, { path: "CLAUDE.md", root: unit.dir }, HUMAN);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("a path routed to a policy.edit sub-class is signable", () => {
  const unit = withFile("# Decision\n", "design/quorum.md");
  const result = appendPathSignOff(
    unit.logPath,
    {
      path: "design/quorum.md",
      root: unit.dir,
      protectedPaths: [{ path: "design/", class: "policy.edit.design" }],
    },
    HUMAN,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(payloadOf(result.record)["path"], "design/quorum.md");
});

test("a spelling with ./ signs the same identity a plain path does", () => {
  const unit = withFile();
  const result = appendPathSignOff(
    unit.logPath,
    { path: `./${SPEC}`, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(payloadOf(result.record)["path"], SPEC);
});

test("the record carries no policy_path and is not a policy.updated", () => {
  const unit = withFile();
  const result = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(payloadOf(result.record)["policy_path"], undefined);
  assert.notEqual(result.record.event, "policy.updated");
  assert.notEqual(result.record.event, ORGAN_ATTESTATION_EVENT);
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test("an agent actor is refused and nothing is written", () => {
  const unit = withFile();
  const result = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    AGENT,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "actor-not-human");
  // The reason is the point: an agent that could write one could ratify its
  // own text.
  assert.match(result.error.message, /ratify its own text/u);
  assert.equal(records(unit).length, 0);
});

test("a system actor is refused too", () => {
  const unit = withFile();
  const result = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    "system:daemon",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "actor-not-human");
  assert.equal(records(unit).length, 0);
});

test("the policy file is refused with its own code, pointing at its own verb", () => {
  const unit = withFile();
  const result = appendPathSignOff(unit.logPath, { path: "APPROVAL.md", root: unit.dir }, HUMAN);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "path-is-policy");
  assert.match(result.error.message, /approval policy attest/u);
  assert.equal(records(unit).length, 0);
});

test("a gate organ is refused with path-is-core and pointed at --organ", () => {
  const unit = withFile('{"hooks":{}}\n', ".claude/settings.json");
  const result = appendPathSignOff(
    unit.logPath,
    { path: ".claude/settings.json", root: unit.dir },
    HUMAN,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  // Its own code, because the repair is a different verb writing a different
  // record — not "this file cannot be signed off at all".
  assert.equal(result.error.code, "path-is-core");
  assert.match(result.error.message, /--organ/u);
  assert.equal(records(unit).length, 0);
});

test("the approval home and the log directory are refused with path-is-core", () => {
  const unit = withFile();
  for (const path of [".approval/vault.enc", ".approval/log/events.jsonl"]) {
    const result = appendPathSignOff(unit.logPath, { path, root: unit.dir }, HUMAN);
    assert.equal(result.ok, false, path);
    if (result.ok) return;
    assert.equal(result.error.code, "path-is-core", path);
  }
  assert.equal(records(unit).length, 0);
});

test("an ordinary file is refused: there is nothing about it to ratify", () => {
  const unit = withFile("export const x = 1;\n", "src/core/gate.ts");
  const result = appendPathSignOff(
    unit.logPath,
    { path: "src/core/gate.ts", root: unit.dir },
    HUMAN,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "path-not-protected");
  assert.equal(records(unit).length, 0);
});

test("omitting the policy's protected_paths narrows rather than widens", () => {
  // The same call that passes with the policy's list refuses without it: the
  // built-in set alone is the strictly narrower answer, which is the
  // fail-closed direction for a verb whose list decides what may be signed.
  const unit = withFile();
  const without = appendPathSignOff(unit.logPath, { path: SPEC, root: unit.dir }, HUMAN);
  assert.equal(without.ok, false);
  if (without.ok) return;
  assert.equal(without.error.code, "path-not-protected");

  const with_ = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
  );
  assert.equal(with_.ok, true, JSON.stringify(with_));
});

test("an absolute path and a .. escape are refused before anything is read", () => {
  const unit = withFile();
  for (const path of [join(unit.dir, SPEC), `../${SPEC}`, ""]) {
    const result = appendPathSignOff(
      unit.logPath,
      { path, root: unit.dir, protectedPaths: PROTECTS_SPEC },
      HUMAN,
    );
    assert.equal(result.ok, false, JSON.stringify(path));
    if (result.ok) return;
    assert.equal(result.error.code, "path-not-protected", JSON.stringify(path));
  }
  assert.equal(records(unit).length, 0);
});

test("a path this verb would never sign is refused whether or not it exists", () => {
  // No file is written at all, and the answer is still the path rule rather
  // than an I/O error: the order is normative, because the caller's repair
  // depends on which fact they are told.
  const unit = newScenario(root);
  const result = appendPathSignOff(unit.logPath, { path: "APPROVAL.md", root: unit.dir }, HUMAN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "path-is-policy");
});

test("an eligible path that is absent is an io refusal naming path and root", () => {
  const unit = newScenario(root);
  const result = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "io");
  assert.match(result.error.message, /SPEC\.md/u);
  assert.equal(records(unit).length, 0);
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

test("a sign-off is found by path AND digest, and by neither alone", () => {
  const unit = withFile();
  const appended = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
  );
  assert.equal(appended.ok, true);
  if (!appended.ok) return;
  const digest = payloadOf(appended.record)["sha256"] as string;
  const all = records(unit);

  assert.notEqual(findPathSignOff(all, SPEC, digest), null);
  // Wrong path, right digest: a file that happens to hash alike is still
  // another file, and a human who read one said nothing about the other.
  assert.equal(findPathSignOff(all, "CLAUDE.md", digest), null);
  // Right path, wrong digest: bytes edited after a sign-off are bytes nobody
  // signed.
  assert.equal(findPathSignOff(all, SPEC, "a".repeat(64)), null);
});

test("latestPathSignOff tells never-signed from signed-and-edited-since", () => {
  const unit = withFile();
  assert.equal(latestPathSignOff(records(unit), SPEC), null);

  const first = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
    { clock: fixedClock(at(1)) },
  );
  assert.equal(first.ok, true);
  writeProtected(unit, SPEC, `${SPEC_TEXT}another sentence.\n`);

  const latest = latestPathSignOff(records(unit), SPEC);
  assert.notEqual(latest, null);
  assert.equal(
    latest?.sha256,
    first.ok ? (payloadOf(first.record)["sha256"] as string) : "",
  );
  // The live bytes are NOT what that record stands for, which is exactly the
  // difference a status surface has to be able to report.
  assert.equal(
    findPathSignOff(records(unit), SPEC, policyBytesHash(readFileSync(join(unit.dir, SPEC)))),
    null,
  );
});

test("a record asserting nothing about bytes cannot satisfy a check about bytes", () => {
  // `pathSignOffOf` is the fail-closed reader: a record of the right type with
  // a missing or non-string field is ignored rather than half-read.
  const shell = { event: PATH_SIGN_OFF_EVENT, actor: HUMAN } as unknown as EventRecord;
  assert.equal(pathSignOffOf(shell), null);
  assert.equal(
    pathSignOffOf({ ...shell, payload: { path: SPEC } } as EventRecord),
    null,
  );
  assert.equal(
    pathSignOffOf({ ...shell, payload: { sha256: "a".repeat(64) } } as EventRecord),
    null,
  );
  assert.equal(
    pathSignOffOf({ ...shell, payload: { path: "", sha256: "a".repeat(64) } } as EventRecord),
    null,
  );
});

// ---------------------------------------------------------------------------
// Invisible to the gate, and to the organ reader
// ---------------------------------------------------------------------------

test("a sign-off does not make an unattested policy operative", () => {
  const unit = withFile();
  // No `attest(unit)`: the policy has never been attested.
  const signed = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
    { clock: fixedClock(at(1)) },
  );
  assert.equal(signed.ok, true, JSON.stringify(signed));

  const status = checkAttestation(records(unit), unit.policyPath);
  assert.equal(status.status, "not-attested");

  // And the gate refuses at intake, through its own path, for the attestation
  // reason: the sign-off is a record about prose and answers nothing here.
  const registered = register(unit.logPath, registration(), AGENT, {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
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
    AGENT,
    { ...unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(requested.ok, false);
  if (requested.ok) return;
  assert.equal(requested.code, ATTESTATION_REFUSAL);
});

test("a sign-off does not change the policy hash a request and a grant are decided under", () => {
  const unit = withFile();
  attest(unit, at(0));
  const before = checkAttestation(records(unit), unit.policyPath);
  assert.equal(before.status, "attested");

  const signed = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
    { clock: fixedClock(at(1)) },
  );
  assert.equal(signed.ok, true, JSON.stringify(signed));

  const after = checkAttestation(records(unit), unit.policyPath);
  assert.deepEqual(after, before);

  const registered = register(unit.logPath, registration(), AGENT, {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
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
    AGENT,
    { ...unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const granted = decide(unit.logPath, ACTION_KEY, "grant", HUMAN, {
    ...unit.options,
    clock: fixedClock(at(4)),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));

  const all = records(unit);
  const grantRecord = all.find((entry) => entry.event === "approval.granted");
  assert.notEqual(grantRecord, undefined);
  assert.equal(
    payloadOf(grantRecord as EventRecord)["policy_sha256"],
    before.status === "attested" ? before.sha256 : "",
  );
});

test("a sign-off is not an organ attestation and an organ attestation is not a sign-off", () => {
  const unit = withFile();
  writeProtected(unit, ".claude/settings.json", '{"hooks":{}}\n');

  const signed = appendPathSignOff(
    unit.logPath,
    { path: SPEC, root: unit.dir, protectedPaths: PROTECTS_SPEC },
    HUMAN,
    { clock: fixedClock(at(1)) },
  );
  const organ = appendOrganAttestation(
    unit.logPath,
    { path: ".claude/settings.json", root: unit.dir },
    HUMAN,
    { clock: fixedClock(at(2)) },
  );
  assert.equal(signed.ok, true);
  assert.equal(organ.ok, true);
  if (!signed.ok || !organ.ok) return;
  const all = records(unit);

  // Each reader sees its own type and nothing else. Two indexes fed by two
  // event types is what makes that structural rather than a filter every
  // reader has to remember.
  assert.equal(organAttestationOf(signed.record), null);
  assert.equal(pathSignOffOf(organ.record), null);
  assert.equal(
    findOrganAttestation(all, SPEC, payloadOf(signed.record)["sha256"] as string),
    null,
  );
  assert.equal(
    findPathSignOff(
      all,
      ".claude/settings.json",
      payloadOf(organ.record)["sha256"] as string,
    ),
    null,
  );
});
