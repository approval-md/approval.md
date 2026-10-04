/**
 * The `edgeos` sender channel (APRV-455, part 1).
 *
 * `approvers.<id>.senders` admitted one channel, `telegram`, because its
 * transport attributes a gesture to an account id the sender cannot choose.
 * This suite pins the second: the EdgeOS `/humans/me` id an operator's control
 * plane attributes a gesture to when it carries it over `approval channel
 * relay` (part 2 of the task, `tests/channel-relay.test.ts`). What is pinned
 * here is the half that is a POLICY fact: the schema admits the key in both
 * forms and refuses anything outside the grammar, a policy mapping it loads and
 * attests through the real append path, the resolver treats it exactly as it
 * treats `telegram`, and an observed id that wears the keyed prefix can never
 * match a keyed entry by string equality.
 *
 * No log line is written by hand: attestation goes through `core/attest.ts`,
 * requests through `core/gate.ts`, decisions through `recordChannelDecision`.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { appendAttestation, checkAttestation } from "../src/core/attest.js";
import { recordChannelDecision } from "../src/channels/contract.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import {
  EDGEOS_SENDER_ID_PATTERN,
  SENDER_CHANNELS,
  actorForSender,
  hashedSenderId,
  isEdgeosSenderId,
  isSenderChannel,
  resolveSender,
} from "../src/core/sender-identity.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { register, request } from "./clock-adapters.js";
import {
  assertClean,
  at,
  fixedClock,
  newScenario,
  payloadOf,
  records,
  scratchRoot,
} from "./scenario.js";

const scratch = scratchRoot("sender-edgeos");
after(() => scratch.cleanup());

const RESIDENT_EDGEOS = "4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c";
const OTHER_EDGEOS = "8d2b7c11-0e4f-4a3b-b6c5-1f2e3d4c5b6a";
const SENDER_KEY = "edgeos-test-sender-key-0123456789abcdef";
const AGENT = "agent:hermes";
const TASK = "task-455";

/** A two-approver policy; `edgeos` values are written verbatim when given. */
function policyText(options: { edgeos?: Record<string, string>; telegram?: Record<string, string> } = {}): string {
  const lines = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "24h"',
    "  on_expiry: reject",
    "approvers:",
  ];
  for (const id of ["resident", "operator"]) {
    lines.push(`  ${id}:`, "    channels: [telegram, edgeos, cli]");
    const edgeos = options.edgeos?.[id];
    const telegram = options.telegram?.[id];
    if (edgeos !== undefined || telegram !== undefined) lines.push("    senders:");
    if (telegram !== undefined) lines.push(`      telegram: "${telegram}"`);
    if (edgeos !== undefined) lines.push(`      edgeos: "${edgeos}"`);
  }
  lines.push(
    "classes:",
    "  communicate.email.external:",
    "    autonomy: manual",
    "```",
    "",
  );
  return lines.join("\n");
}

test("edgeos is a sender channel, and the closed set is exactly telegram and edgeos", () => {
  assert.deepEqual([...SENDER_CHANNELS], ["telegram", "edgeos"]);
  assert.equal(isSenderChannel("edgeos"), true);
  assert.equal(isSenderChannel("web"), false);
  assert.equal(isSenderChannel("cli"), false);
  assert.equal(isSenderChannel("relay"), false);
});

test("the raw EdgeOS id grammar admits UUIDs and decimal ids and nothing that could pass for a digest", () => {
  for (const ok of [RESIDENT_EDGEOS, "12345", "a", "A1._-z", "x".repeat(128)]) {
    assert.equal(isEdgeosSenderId(ok), true, ok);
  }
  for (const bad of [
    "",
    " 12345",
    "12345 ",
    "-leading-dash",
    ".leading-dot",
    "has space",
    "has:colon",
    `hmac-sha256:${"a".repeat(64)}`,
    "x".repeat(129),
    "émoji",
    "tab\there",
  ]) {
    assert.equal(isEdgeosSenderId(bad), false, JSON.stringify(bad));
  }
  // The schema pins the same grammar on the policy key, so the two can be read
  // against each other.
  assert.equal(EDGEOS_SENDER_ID_PATTERN.source, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
});

test("a policy mapping edgeos loads in the raw form, the keyed form, and beside telegram", () => {
  const raw = loadPolicyText("APPROVAL.md", policyText({ edgeos: { resident: RESIDENT_EDGEOS } }));
  assert.equal(raw.ok, true, JSON.stringify(raw));
  assert.equal(raw.ok ? raw.policy.approvers?.["resident"]?.senders?.["edgeos"] : null, RESIDENT_EDGEOS);

  const keyed = loadPolicyText(
    "APPROVAL.md",
    policyText({ edgeos: { resident: hashedSenderId(SENDER_KEY, RESIDENT_EDGEOS) } }),
  );
  assert.equal(keyed.ok, true, JSON.stringify(keyed));

  const both = loadPolicyText(
    "APPROVAL.md",
    policyText({ edgeos: { resident: RESIDENT_EDGEOS }, telegram: { resident: "42" } }),
  );
  assert.equal(both.ok, true, JSON.stringify(both));
});

test("an edgeos value outside the grammar is a schema failure, so the policy fails closed", () => {
  for (const bad of ["has space", "has:colon", "-dash", "x".repeat(129), "hmac-sha256:nothex"]) {
    const load = loadPolicyText("APPROVAL.md", policyText({ edgeos: { resident: bad } }));
    assert.equal(load.ok, false, `${JSON.stringify(bad)} loaded`);
    assert.equal(load.ok === false ? load.code : "", "schema-invalid");
  }
});

test("one EdgeOS id claimed by two approvers refuses the policy at load", () => {
  const load = loadPolicyText(
    "APPROVAL.md",
    policyText({ edgeos: { resident: RESIDENT_EDGEOS, operator: RESIDENT_EDGEOS } }),
  );
  assert.equal(load.ok, false);
  assert.equal(load.ok === false ? load.code : "", "sender-ambiguous");
});

test("a policy mapping edgeos attests through the real append path and is in force", () => {
  const unit = newScenario(scratch.root, policyText({ edgeos: { resident: RESIDENT_EDGEOS } }));
  const attested = appendAttestation(unit.logPath, unit.policyPath, "human:operator", {
    clock: fixedClock(at(0)),
  });
  assert.equal(attested.ok, true, JSON.stringify(attested));
  const read = readVerifiedRecords(unit.logPath);
  assert.equal(read.ok, true);
  const status = checkAttestation(read.ok ? read.records : [], unit.policyPath);
  assert.equal(status.status, "attested", JSON.stringify(status));
  assertClean(unit);
});

test("the resolver treats edgeos as it treats telegram: mapped, unmapped, and its own namespace", () => {
  const load = loadPolicyText(
    "APPROVAL.md",
    policyText({ edgeos: { resident: RESIDENT_EDGEOS }, telegram: { operator: "42" } }),
  );
  const mapped = resolveSender(load, { channel: "edgeos", id: RESIDENT_EDGEOS });
  assert.equal(mapped.kind, "mapped");
  if (mapped.kind === "mapped") {
    assert.equal(mapped.actor, "human:resident");
    assert.deepEqual(mapped.recorded, { channel: "edgeos", id: RESIDENT_EDGEOS });
  }
  assert.equal(resolveSender(load, { channel: "edgeos", id: OTHER_EDGEOS }).kind, "unmapped");
  // A Telegram account id reported on the EdgeOS channel is a different
  // namespace and names nobody there, even though the policy maps "42".
  assert.equal(resolveSender(load, { channel: "edgeos", id: "42" }).kind, "unmapped");
  // And the mapping for one channel does not switch enforcement on for another
  // channel nobody maps: a policy mapping only edgeos leaves telegram in mode 1.
  const edgeosOnly = loadPolicyText("APPROVAL.md", policyText({ edgeos: { resident: RESIDENT_EDGEOS } }));
  assert.deepEqual(resolveSender(edgeosOnly, { channel: "telegram", id: "42" }), {
    kind: "configured",
    reason: "channel-unmapped",
  });
});

test("keyed edgeos resolves with the key, refuses without it, and records the digest", () => {
  const digest = hashedSenderId(SENDER_KEY, RESIDENT_EDGEOS);
  const load = loadPolicyText("APPROVAL.md", policyText({ edgeos: { resident: digest } }));
  const withKey = resolveSender(load, { channel: "edgeos", id: RESIDENT_EDGEOS }, SENDER_KEY);
  assert.equal(withKey.kind, "mapped");
  if (withKey.kind === "mapped") {
    assert.deepEqual(withKey.recorded, { channel: "edgeos", id: digest, hashed: true });
  }
  assert.equal(
    resolveSender(load, { channel: "edgeos", id: RESIDENT_EDGEOS }, null).kind,
    "key-unavailable",
  );
});

test("an observed id that IS the published digest never matches the keyed entry by string equality", () => {
  // The digest is public (it is in the published policy). A caller that
  // reported it as the account id would, without this guard, match the keyed
  // entry through the raw comparison: no key needed and not the account.
  const digest = hashedSenderId(SENDER_KEY, RESIDENT_EDGEOS);
  const load = loadPolicyText("APPROVAL.md", policyText({ edgeos: { resident: digest } }));
  const spoof = { channel: "edgeos", id: digest };
  const resolution = resolveSender(load, spoof, SENDER_KEY);
  assert.equal(resolution.kind, "unmapped", JSON.stringify(resolution));
  const actor = actorForSender(load, "human:operator", spoof, SENDER_KEY);
  assert.equal(actor.ok, false);
  assert.equal(actor.ok === false ? actor.code : "", "sender-unmapped");

  // The same guard on telegram, where it changes nothing a real transport can
  // produce: a Telegram id is digits and never wears the prefix.
  const tg = loadPolicyText(
    "APPROVAL.md",
    policyText({ telegram: { resident: hashedSenderId(SENDER_KEY, "42") } }),
  );
  assert.equal(
    resolveSender(tg, { channel: "telegram", id: hashedSenderId(SENDER_KEY, "42") }, SENDER_KEY).kind,
    "unmapped",
  );
  assert.equal(resolveSender(tg, { channel: "telegram", id: "42" }, SENDER_KEY).kind, "mapped");
});

test("a decision carrying an edgeos sender lands under the mapped human and records the sender", () => {
  const unit = newScenario(scratch.root, policyText({ edgeos: { resident: RESIDENT_EDGEOS } }));
  const attested = appendAttestation(unit.logPath, unit.policyPath, "human:operator", {
    clock: fixedClock(at(0)),
  });
  assert.equal(attested.ok, true);
  const key = `${TASK}:send-1`;
  const payload = { to: ["a@example.org"], subject: "hello" };
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          {
            class: "communicate.email.external",
            idempotency_key: key,
            summary: "send hello",
            est_cost_usd: "0",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    at(0),
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const requested = request(
    unit.logPath,
    { task: TASK, actionKey: key, cls: "communicate.email.external", est_cost_usd: "0", summary: "send hello" },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const result = recordChannelDecision(
    unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "edgeos-1", sender: { channel: "edgeos", id: RESIDENT_EDGEOS } },
    { actor: "human:operator", channel: "edgeos" },
    { ...unit.options, clock: fixedClock(at(2)) },
  );
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.actor, "human:resident");
  assert.equal(result.outcome.record.channel, "edgeos");
  assert.deepEqual(payloadOf(result.outcome.record)["sender"], {
    channel: "edgeos",
    id: RESIDENT_EDGEOS,
  });
  assert.equal(records(unit).filter((r) => r.event === "audit.decision_refused").length, 0);
  assertClean(unit);
});
