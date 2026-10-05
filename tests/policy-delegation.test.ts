/**
 * The policy `delegation` block and the `model:` identity, RESERVED (APRV-500).
 *
 * What this suite pins, in the order the reservation needs it:
 *
 * 1. The grammar: the schema admits the off form, an empty mapping, and the
 *    design's fully enabled form; the load-time relationship rules (exact class
 *    keys, no human-only or autonomous class, the max_autonomy pin, the
 *    escalation floors, reviewer identities, no power without a model) refuse
 *    as `schema-invalid` with their own keywords.
 * 2. The reservation: every value other than off fails the load with
 *    `delegation-not-supported`, and the policy then resolves every class
 *    `manual`.
 * 3. Inertness: an off block changes no resolution of any policy this repo
 *    ships or tests, and the display surfaces (policy check, policy diff) show
 *    it.
 * 4. The identity: `model:` parses for the reviewer role only, and every
 *    human-only verb refuses a `model:` actor; `verdict_source: model` is
 *    registered as reserved and refused at the event write boundary.
 *
 * Logs are built through the real append path only.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { stringify } from "yaml";

import { recordChannelDecision } from "../src/channels/contract.js";
import { CANONICAL_POLICY } from "../src/cli/scaffold.js";
import { QUICKSTART_CLASSES, renderSoloPolicy } from "../src/cli/quickstart.js";
import { RESERVED_VERDICT_SOURCES, reviewSample, VERDICT_SOURCES } from "../src/core/audit.js";
import {
  DELEGATION_KEYS,
  DELEGATION_OFF,
  delegationEngaged,
} from "../src/core/delegation.js";
import { MODEL_IDENTITY_PATTERN, parseIdentity, type IdentityRole } from "../src/core/identity.js";
import { diffPolicies } from "../src/core/policy-diff.js";
import { explain } from "../src/core/policy-explain.js";
import {
  loadPolicy,
  loadPolicyText,
  POLICY_FILENAMES,
  type PolicyLoadResult,
} from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { DEFAULT_SCHEMA_DIR, validate } from "../src/core/validate.js";
import { appendAttestation, decide, register, request } from "./clock-adapters.js";
import { at, attest, fixedClock, newScenario, scratchRoot } from "./scenario.js";

const { root: scratch, cleanup } = scratchRoot("policy-delegation");
after(cleanup);

const REPO_ROOT = join(DEFAULT_SCHEMA_DIR, "..");
const JUDGE = "model:judge@0.3.0";

/** A policy file text with `delegation` lines appended to a fixed body. */
function policyText(delegation: readonly string[], extraClasses: readonly string[] = []): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "approvers:",
    "  alice:",
    "    channels: [cli]",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  digest.*:",
    "    autonomy: manual",
    "  digest.share:",
    "    autonomy: manual",
    "  intent.publish:",
    "    autonomy: supervised-live",
    "    live_rate: 0.5",
    "  calendar.write.own:",
    "    autonomy: supervised-retro",
    "  calendar.write.legacy:",
    "    autonomy: supervised",
    "  vote.cast:",
    "    autonomy: human-only",
    ...extraClasses,
    ...delegation,
    "```",
    "",
  ].join("\n");
}

function load(text: string): PolicyLoadResult {
  return loadPolicyText("APPROVAL.md", text);
}

function expectOk(result: PolicyLoadResult): Extract<PolicyLoadResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectFail(result: PolicyLoadResult, code: string): Extract<PolicyLoadResult, { ok: false }> {
  assert.equal(result.ok, false, "expected the policy to fail closed");
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, code, `message was: ${result.message}`);
  return result;
}

function keywords(result: Extract<PolicyLoadResult, { ok: false }>): string[] {
  return (result.errors ?? []).map((error) => error.keyword);
}

const OFF_LINES = [
  "delegation:",
  "  model: null",
  "  classes: []",
  "  max_autonomy: manual",
  "  daily_cap: 0",
  "  escalate_on: []",
  "  advice: false",
  "  reviewers: []",
];

// ---------------------------------------------------------------------------
// 1. Grammar
// ---------------------------------------------------------------------------

test("the schema admits the off form, an empty mapping and the design's enabled form", () => {
  for (const name of ["delegation-off.json", "delegation-empty.json", "delegation-grammar-full.json"]) {
    const document = JSON.parse(
      readFileSync(join(DEFAULT_SCHEMA_DIR, "fixtures", "policy", "valid", name), "utf8"),
    ) as unknown;
    const result = validate("policy", document);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test("the judge identity pattern is the schema's own", () => {
  const schema = JSON.parse(readFileSync(join(DEFAULT_SCHEMA_DIR, "policy.schema.json"), "utf8")) as {
    $defs: Record<string, { pattern: string }>;
  };
  assert.equal(schema.$defs["modelIdentity"]?.pattern, MODEL_IDENTITY_PATTERN.source);
  const reviewer = schema.$defs["delegationReviewer"]?.pattern ?? "";
  assert.ok(
    reviewer.includes(MODEL_IDENTITY_PATTERN.source.slice(1, -1)),
    "the reviewer pattern's model half drifted from the identity parser",
  );
});

test("an off block, an empty block and no block all load", () => {
  expectOk(load(policyText(OFF_LINES)));
  expectOk(load(policyText(["delegation: {}"])));
  expectOk(load(policyText([])));
  // Each key absent is its off value.
  expectOk(load(policyText(["delegation:", "  model: null"])));
  expectOk(load(policyText(["delegation:", "  max_autonomy: manual", "  daily_cap: 0"])));
});

test("schema-level grammar faults fail closed as schema-invalid", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["null block", ["delegation:"]],
    ["unknown key", ["delegation:", "  judge: on"]],
    ["provider/name model", ["delegation:", "  model: anthropic/claude-judge@1.0.0"]],
    ["model without version", ["delegation:", "  model: model:judge"]],
    ["wildcard class", ["delegation:", "  classes: [digest.*]"]],
    ["max_autonomy autonomous", ["delegation:", "  max_autonomy: autonomous"]],
    ["max_autonomy alias", ["delegation:", "  max_autonomy: supervised"]],
    ["negative cap", ["delegation:", "  daily_cap: -1"]],
    ["fractional cap", ["delegation:", "  daily_cap: 1.5"]],
    ["string cap", ["delegation:", '  daily_cap: "0"']],
    ["cap over 1000", ["delegation:", "  daily_cap: 1001"]],
    ["unknown escalation", ["delegation:", "  escalate_on: [always]"]],
    ["duplicate escalation", ["delegation:", "  escalate_on: [deny, deny]"]],
    ["advice as a word", ["delegation:", "  advice: no"]],
    ["bare reviewer id", ["delegation:", "  reviewers: [alice]"]],
    ["agent reviewer", ["delegation:", "  reviewers: [\"agent:claude\"]"]],
    ["system reviewer", ["delegation:", "  reviewers: [\"system:audit\"]"]],
  ];
  for (const [label, lines] of cases) {
    const result = load(policyText(lines));
    assert.equal(result.ok, false, `${label}: loaded`);
    if (!result.ok) assert.equal(result.code, "schema-invalid", `${label}: ${result.code} ${result.message}`);
  }
});

test("a delegated class must be an exact key of classes", () => {
  // `digest.daily` is reached only through the `digest.*` family.
  const result = expectFail(
    load(policyText(["delegation:", "  classes: [digest.daily]"])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(result), ["delegation-class-undeclared"]);
  const nowhere = expectFail(load(policyText(["delegation:", "  classes: [treasury.send]"])), "schema-invalid");
  assert.deepEqual(keywords(nowhere), ["delegation-class-undeclared"]);
});

test("a human-only or autonomous class cannot be delegated", () => {
  const human = expectFail(load(policyText(["delegation:", "  classes: [vote.cast]"])), "schema-invalid");
  assert.deepEqual(keywords(human), ["delegation-class-level"]);
  const autonomous = expectFail(
    load(policyText(["delegation:", "  classes: [read.feed]"], ["  read.feed:", "    autonomy: autonomous"])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(autonomous), ["delegation-class-level"]);
});

test("the max_autonomy pin: a delegated row looser than max_autonomy fails the load", () => {
  // Default manual: a supervised-retro row is looser.
  const retro = expectFail(
    load(policyText(["delegation:", "  classes: [calendar.write.own]"])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(retro), ["delegation-max-autonomy-pin"]);
  // The deprecated `supervised` reads as supervised-retro, looser than live.
  const alias = expectFail(
    load(policyText(["delegation:", "  classes: [calendar.write.legacy]", "  max_autonomy: supervised-live"])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(alias), ["delegation-max-autonomy-pin"]);
  // supervised-live under a supervised-retro pin is stricter: the pin passes,
  // and the reservation is what refuses the block.
  expectFail(
    load(policyText(["delegation:", "  classes: [intent.publish]", "  max_autonomy: supervised-retro"])),
    "delegation-not-supported",
  );
  // A manual row passes under every max_autonomy.
  for (const ceiling of ["manual", "supervised-live", "supervised-retro"]) {
    expectFail(
      load(policyText(["delegation:", "  classes: [digest.share]", `  max_autonomy: ${ceiling}`])),
      "delegation-not-supported",
    );
  }
});

test("the escalation floors bind whenever daily_cap is above zero", () => {
  const result = expectFail(
    load(policyText(["delegation:", `  model: "${JUDGE}"`, "  daily_cap: 5", "  escalate_on: [deny]"])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(result), ["delegation-escalation-floor", "delegation-escalation-floor"]);
  expectFail(
    load(
      policyText([
        "delegation:",
        `  model: "${JUDGE}"`,
        "  daily_cap: 5",
        "  escalate_on: [irreversible, unknown_class]",
      ]),
    ),
    "delegation-not-supported",
  );
});

test("reviewer identities: a model reviewer equals model, a human reviewer names an approver", () => {
  const mismatch = expectFail(
    load(policyText(["delegation:", `  model: "${JUDGE}"`, '  reviewers: ["model:judge@0.4.0"]'])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(mismatch), ["delegation-reviewer-model"]);
  const stranger = expectFail(
    load(policyText(["delegation:", '  reviewers: ["human:mallory"]'])),
    "schema-invalid",
  );
  assert.deepEqual(keywords(stranger), ["delegation-reviewer-unknown"]);
  expectFail(load(policyText(["delegation:", '  reviewers: ["human:alice"]'])), "delegation-not-supported");
  expectFail(
    load(policyText(["delegation:", `  model: "${JUDGE}"`, `  reviewers: ["${JUDGE}"]`])),
    "delegation-not-supported",
  );
});

test("a power written with no model named is refused rather than ignored", () => {
  const cases: Array<readonly string[]> = [
    ["delegation:", "  advice: true"],
    ["delegation:", "  daily_cap: 3", "  escalate_on: [irreversible, unknown_class]"],
    ["delegation:", `  reviewers: ["${JUDGE}"]`],
  ];
  for (const lines of cases) {
    const result = expectFail(load(policyText(lines)), "schema-invalid");
    assert.deepEqual(keywords(result), ["delegation-model-required"], lines.join(" "));
  }
});

// ---------------------------------------------------------------------------
// 2. The reservation: any non-off value is delegation-not-supported
// ---------------------------------------------------------------------------

test("each non-off value refuses the load with delegation-not-supported, naming the key", () => {
  const cases: Array<[readonly string[], readonly string[]]> = [
    [[`  model: "${JUDGE}"`], ["model"]],
    [["  classes: [digest.share]"], ["classes"]],
    [["  max_autonomy: supervised-live"], ["max_autonomy"]],
    [["  max_autonomy: supervised-retro"], ["max_autonomy"]],
    [
      [`  model: "${JUDGE}"`, "  daily_cap: 1", "  escalate_on: [irreversible, unknown_class]"],
      ["model", "daily_cap", "escalate_on"],
    ],
    [["  escalate_on: [deny]"], ["escalate_on"]],
    [[`  model: "${JUDGE}"`, "  advice: true"], ["model", "advice"]],
    [['  reviewers: ["human:alice"]'], ["reviewers"]],
  ];
  for (const [lines, keys] of cases) {
    const result = expectFail(load(policyText(["delegation:", ...lines])), "delegation-not-supported");
    assert.deepEqual(
      (result.errors ?? []).map((error) => error.path),
      keys.map((key) => `/delegation/${key}`),
      lines.join(" "),
    );
    for (const key of keys) assert.match(result.message, new RegExp(`delegation\\.${key}`));
    assert.notEqual(result.raw, undefined, "the rejected document rides along for display");
  }
});

test("the design's fully enabled form is refused with every engaged key named", () => {
  const result = expectFail(
    load(
      policyText([
        "delegation:",
        `  model: "${JUDGE}"`,
        "  classes: [digest.share]",
        "  max_autonomy: manual",
        "  daily_cap: 10",
        "  escalate_on: [deny, low_confidence, irreversible, unknown_class]",
        "  advice: true",
        `  reviewers: ["${JUDGE}", "human:alice"]`,
      ]),
    ),
    "delegation-not-supported",
  );
  assert.deepEqual(
    (result.errors ?? []).map((error) => error.path),
    ["model", "classes", "daily_cap", "escalate_on", "advice", "reviewers"].map((key) => `/delegation/${key}`),
  );
});

test("a refused block resolves every class manual, the autonomous ones included", () => {
  const refused = load(policyText(["delegation:", "  advice: false", "  escalate_on: [deny]"]));
  expectFail(refused, "delegation-not-supported");
  for (const cls of ["read.file", "digest.share", "calendar.write.own", "anything.else"]) {
    const resolution = resolve(refused, cls);
    assert.equal(resolution.autonomy, "manual", cls);
    assert.equal(resolution.provenance, "fail-closed", cls);
  }
});

test("delegationEngaged lists exactly the keys away from their off value", () => {
  assert.deepEqual(delegationEngaged(undefined), []);
  assert.deepEqual(delegationEngaged({}), []);
  assert.deepEqual(delegationEngaged({ ...DELEGATION_OFF, classes: [], escalate_on: [], reviewers: [] }), []);
  assert.deepEqual(delegationEngaged({ daily_cap: 0, advice: false, model: null }), []);
  assert.deepEqual(delegationEngaged({ daily_cap: 1 }), ["daily_cap"]);
  assert.deepEqual(DELEGATION_KEYS, ["model", "classes", "max_autonomy", "daily_cap", "escalate_on", "advice", "reviewers"]);
});

// ---------------------------------------------------------------------------
// 3. Inertness and display
// ---------------------------------------------------------------------------

/** Every policy this repo ships or tests as valid, by name. */
function shippedPolicies(): Array<[string, string]> {
  const sources: Array<[string, string]> = [];
  const fixtures = join(DEFAULT_SCHEMA_DIR, "fixtures", "policy-md", "valid");
  for (const name of readdirSync(fixtures).filter((entry) => entry.endsWith(".md")).sort()) {
    sources.push([`policy-md/valid/${name}`, readFileSync(join(fixtures, name), "utf8")]);
  }
  sources.push(["scaffold CANONICAL_POLICY", CANONICAL_POLICY]);
  sources.push([
    "quickstart solo policy",
    renderSoloPolicy("carter", "telegram", QUICKSTART_CLASSES.map((entry) => entry.pattern)),
  ]);
  sources.push([
    "examples/agent-village/approval-policy.md",
    // The template's sender placeholder, rendered as tests/agent-village-policy.test.ts renders it.
    readFileSync(join(REPO_ROOT, "examples", "agent-village", "approval-policy.md"), "utf8").replace(
      '"<telegram_user_id>"',
      '"12345678"',
    ),
  ]);
  const own = POLICY_FILENAMES[0];
  sources.push([`repository ${own}`, readFileSync(join(REPO_ROOT, own), "utf8")]);
  return sources;
}

/** The policy re-serialised as a single fenced block, with or without a block. */
function reserialised(policy: object, withOff: boolean): string {
  const document = withOff ? { ...policy, delegation: { ...DELEGATION_OFF } } : policy;
  return `\`\`\`yaml approval-policy\n${stringify(document)}\`\`\`\n`;
}

test("every shipped and fixture policy still loads, and an off block changes none of its answers", () => {
  const sources = shippedPolicies();
  assert.ok(sources.length >= 10, "the policy census found too few sources to mean anything");
  for (const [label, text] of sources) {
    const original = expectOk(loadPolicyText(label, text));
    assert.equal(original.policy.delegation, undefined, `${label} already declares delegation`);

    const without = expectOk(loadPolicyText(label, reserialised(original.policy, false)));
    const withOff = expectOk(loadPolicyText(label, reserialised(original.policy, true)));
    assert.notEqual(withOff.policy.delegation, undefined);

    const probes = new Set<string>([
      ...Object.keys(original.policy.classes ?? {}).map((key) => key.replace(/\*/gu, "x")),
      "read.file",
      "communicate.email.external",
      "financial.spend",
      "policy.edit",
      "harness.tool.unmapped",
      "digest.share",
      "unknown.class",
    ]);
    for (const probe of probes) {
      for (const options of [{}, { reversible: false }]) {
        const a = resolve(original, probe, options);
        const b = resolve(without, probe, options);
        const c = resolve(withOff, probe, options);
        for (const [name, other] of [["re-serialised", b], ["with off block", c]] as const) {
          assert.equal(other.autonomy, a.autonomy, `${label} ${probe} ${name}`);
          assert.equal(other.declaredAutonomy, a.declaredAutonomy, `${label} ${probe} ${name}`);
          assert.equal(other.provenance, a.provenance, `${label} ${probe} ${name}`);
          assert.equal(other.matched?.pattern ?? null, a.matched?.pattern ?? null, `${label} ${probe} ${name}`);
        }
      }
    }
    const diff = diffPolicies(without, withOff, [...probes]);
    assert.deepEqual(diff.classes, [], `${label}: an off block moved a resolution`);
  }
});

test("policy check names a declared off block, and says nothing when there is none", () => {
  const declared = explain(load(policyText(OFF_LINES)), "digest.share");
  assert.equal(declared.outcome.autonomy, "manual");
  assert.ok(
    declared.decisionPath.some((line) => line.startsWith("delegation (APRV-500): declared and off")),
    declared.decisionPath.join("\n"),
  );
  const absent = explain(load(policyText([])), "digest.share");
  assert.equal(absent.decisionPath.some((line) => line.includes("delegation")), false);

  const refused = explain(load(policyText(["delegation:", "  advice: false", '  reviewers: ["human:alice"]'])), "read.file");
  assert.equal(refused.provenance, "fail-closed");
  assert.equal(refused.outcome.autonomy, "manual");
  assert.equal(refused.loadFailure?.code, "delegation-not-supported");
});

test("policy diff reports the block's paths and the reservation's refusal", () => {
  const none = load(policyText([]));
  const off = load(policyText(OFF_LINES));
  const added = diffPolicies(none, off);
  assert.deepEqual(added.classes, []);
  const paths = added.vocabulary.map((change) => change.key).sort();
  assert.deepEqual(
    paths,
    DELEGATION_KEYS.map((key) => `delegation.${key}`).sort(),
    JSON.stringify(added.vocabulary),
  );
  assert.ok(added.vocabulary.every((change) => change.recognised));

  const engaged = load(policyText(["delegation:", `  model: "${JUDGE}"`]));
  const moved = diffPolicies(off, engaged);
  assert.equal(moved.afterFailure?.code, "delegation-not-supported");
  assert.ok(moved.vocabulary.some((change) => change.key === "delegation.model" && change.after === JUDGE));
});

// ---------------------------------------------------------------------------
// 4. The model: identity and verdict_source
// ---------------------------------------------------------------------------

test("model: parses for the reviewer role only; human: for every role", () => {
  const roles: IdentityRole[] = ["reviewer", "decider", "attester", "sender"];
  for (const role of roles) {
    assert.deepEqual(parseIdentity("human:alice", role), { kind: "human", id: "alice" }, role);
    const model = parseIdentity(JUDGE, role);
    if (role === "reviewer") {
      assert.deepEqual(model, { kind: "model", name: "judge", version: "0.3.0" });
    } else {
      assert.equal(model, null, `${role} admitted a model identity`);
    }
    for (const other of ["agent:claude", "system:audit", "alice", "human:", "model:Judge@1.0.0", "model:judge@1.0", "model:judge@1.0.0-rc1", "model:-judge@1.0.0", `model:${"j".repeat(65)}@1.0.0`]) {
      assert.equal(parseIdentity(other, role), null, `${role} ${other}`);
    }
  }
  assert.ok(parseIdentity(`model:${"j".repeat(64)}@1.0.0`, "reviewer"));
});

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: true,
      est_cost_usd: "0.02",
      idempotency_key: "task-042:chaser",
      payload_hash: "1".repeat(64),
    },
  ],
};

test("every human-only verb refuses a model: actor (actor-not-human), and nothing is written", () => {
  const unit = newScenario(scratch);
  attest(unit);
  const registered = register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, at(1), "agent:claude");
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  const asked = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      payload_hash: "1".repeat(64),
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: true,
      summary: "Send deposit chaser",
    },
    at(2),
    "agent:claude",
    unit.options,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);
  const before = readFileSync(unit.logPath, "utf8");

  for (const decision of ["grant", "reject", "revoke"] as const) {
    const refused = decide(unit.logPath, "task-042:chaser", decision, JUDGE, at(3), unit.options);
    assert.equal(refused.ok, false, decision);
    if (!refused.ok) assert.equal(refused.code, "actor-not-human", decision);
  }

  const channel = recordChannelDecision(
    unit.logPath,
    { action_key: "task-042:chaser", decision: "grant", deliveryId: "mock-1" },
    { actor: JUDGE, channel: "mock" },
    { ...unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(channel.outcome.ok, false);
  if (!channel.outcome.ok) assert.equal(channel.outcome.code, "actor-not-human");
  assert.equal(channel.token, undefined);

  const attested = appendAttestation(unit.logPath, unit.policyPath, JUDGE, at(4));
  assert.equal(attested.ok, false);
  if (!attested.ok) assert.equal(attested.error.code, "actor-not-human");

  const reviewed = reviewSample(unit.logPath, { kind: "seq", seq: 1 }, JUDGE, null, {
    ...unit.options,
    verdict: "ok",
  });
  assert.equal(reviewed.ok, false);
  if (!reviewed.ok) assert.equal(reviewed.code, "actor-not-human");

  assert.equal(readFileSync(unit.logPath, "utf8"), before, "a refused model: actor wrote to the log");
});

test("verdict_source model is reserved: registered, never written, refused at the write boundary", () => {
  assert.deepEqual([...VERDICT_SOURCES], ["explicit"]);
  assert.deepEqual([...RESERVED_VERDICT_SOURCES], ["model"]);
  const fixtures = join(DEFAULT_SCHEMA_DIR, "fixtures", "event", "invalid");
  for (const name of ["audit-reviewed-verdict-source-model.json", "audit-reviewed-model-actor.json"]) {
    const document = JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
    assert.equal(validate("event", document).ok, false, `${name} validated`);
    assert.equal(validate("event", document, { mode: "historical" }).ok, false, `${name} validated historically`);
  }
});

test("a policy file on disk with a refused block is all-manual through loadPolicy too", () => {
  const path = join(scratch, "delegation-on-disk.md");
  writeFileSync(path, policyText(["delegation:", `  model: "${JUDGE}"`]), "utf8");
  const result = loadPolicy({ file: path });
  expectFail(result, "delegation-not-supported");
  assert.equal(resolve(result, "read.file").autonomy, "manual");
});
