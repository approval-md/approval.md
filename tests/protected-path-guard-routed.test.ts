/**
 * The protected-path guard under a routed policy (APRV-266).
 *
 * Once `protected_paths` can route a path family to a `policy.edit` sub-class,
 * the grants in the log stop all carrying one class name. The guard's evidence
 * test has two halves — the class opens the door, the naming and coverage test
 * decides — and only the first half changes: `isGrantingClass` accepts a routed
 * sub-class, and keeps accepting `policy.edit` itself.
 *
 * Both directions are asserted here because both are real:
 *
 * - A grant of the ROUTED class is the ordinary case once a policy adopts
 *   routing. The hook asked about `policy.edit.spec`, the human decided
 *   `policy.edit.spec`, so that is the class the record carries.
 * - A grant of `policy.edit` for a path today's policy routes is accepted too.
 *   A routing is itself a policy edit, and the two are never synchronized: a
 *   grant taken last week under a string-only policy is correct evidence for
 *   the edit it authorized, and adopting a routing must not retroactively
 *   invalidate it.
 *
 * And the guard must not have GAINED a pass: a grant of a routed class that
 * names some other file is still not evidence, because there is no class-level
 * pass in this module and routing does not add one.
 *
 * Every log here is built through the real append path, as the sibling suite's
 * note explains at length.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { decide, register, request } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import {
  evaluateProtectedPaths,
  isGrantingClass,
  isGuardedPath,
  type GuardInput,
  type LogWindow,
} from "../src/core/protected-path-guard.js";
import type { ProtectedPathEntry } from "../src/core/command-class.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { at, fixedClock, newScenario, scratchRoot, type Scenario } from "./scenario.js";

const HUMAN = "human:carter";
const AGENT = "agent:claude-code";

/** A policy routing `SPEC.md` to `policy.edit.spec`, as APRV-266 allows. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "protected_paths:",
  "  - { path: SPEC.md, class: policy.edit.spec }",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  policy.edit:",
  "    autonomy: manual",
  "  policy.edit.spec:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/** What the guard is handed, matching the policy above. */
const ROUTED: readonly ProtectedPathEntry[] = [{ path: "SPEC.md", class: "policy.edit.spec" }];

const WINDOW: LogWindow = {
  firstSeq: 1,
  lastSeq: 9,
  firstTs: at(0),
  lastTs: at(9),
  base: "aaaaaaaaaaaa",
  head: "bbbbbbbbbbbb",
};

function fileMaterial(file: string, before = "old", after = "new"): Record<string, unknown> {
  return { tool: "Edit", rule: "protected path", file, before, after };
}

interface World {
  unit: Scenario;
  store: Map<string, unknown>;
}

function world(root: string): World {
  const unit = newScenario(root, POLICY);
  const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
    clock: fixedClock(at(0)),
  });
  assert.equal(attested.ok, true, "attestation append failed");
  return { unit, store: new Map() };
}

/** One granted edit, of whatever class the caller names. */
function grantOfClass(
  world: World,
  key: string,
  cls: string,
  material: unknown,
  minute: number,
): EventRecord {
  const hash = payloadHash(material);
  const task = `hook:${key}`;
  const actionKey = `${task}:${cls}`;

  const registered = register(
    world.unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "claude-code", created_by: AGENT },
        state: "proposed",
        actions: [
          {
            class: cls,
            summary: `Edit ${key}`,
            reversible: true,
            est_cost_usd: "0",
            idempotency_key: actionKey,
            payload_hash: hash,
          },
        ],
      },
    },
    AGENT,
    { ...world.unit.options, clock: fixedClock(at(minute)) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const requested = request(
    world.unit.logPath,
    {
      task,
      actionKey,
      cls,
      est_cost_usd: "0",
      summary: `Edit ${key}`,
      payload_hash: hash,
      payload: { value: material },
      execution: "harness",
    },
    AGENT,
    { ...world.unit.options, clock: fixedClock(at(minute)) },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const granted = decide(world.unit.logPath, actionKey, "grant", HUMAN, {
    ...world.unit.options,
    clock: fixedClock(at(minute + 1)),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  if (!granted.ok) throw new Error("unreachable");

  world.store.set(hash, material);
  return granted.record;
}

function verified(unit: Scenario): EventRecord[] {
  const outcome = verifyWithRecords(unit.logPath);
  assert.equal(outcome.result.status, "clean", JSON.stringify(outcome.result));
  return outcome.records;
}

function inputFor(
  world: World,
  changedPaths: readonly string[],
  overrides: Partial<GuardInput> = {},
): GuardInput {
  return {
    changedPaths,
    records: verified(world.unit),
    logStatus: "ok",
    policyProtectedPaths: ROUTED,
    policySha256AtHead: null,
    policyPath: "APPROVAL.md",
    payloadFor: (hash) => world.store.get(hash) ?? null,
    blobsFor: () => ({ base: "old\n", head: "new\n" }),
    changeTsFor: () => at(3),
    window: WINDOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the predicate
// ---------------------------------------------------------------------------

test("isGrantingClass accepts policy.edit, policy.core and any routed sub-class", () => {
  for (const cls of [
    "policy.edit",
    "policy.core",
    "policy.edit.spec",
    "policy.edit.ci",
    "policy.edit.design",
    "policy.edit.house-rules",
  ]) {
    assert.equal(isGrantingClass(cls), true, cls);
  }
  // A sub-class name is not authority: the namespace is closed to
  // `policy.edit.*`, so nothing outside it can be manufactured by naming one.
  for (const cls of [
    "log.mutate",
    "files.write.workspace",
    "read.shell",
    "policy.core.custom",
    "policy.edit.",
    "",
  ]) {
    assert.equal(isGrantingClass(cls), false, cls);
  }
});

test("a routed path is guarded exactly as a bare-string one is", () => {
  assert.equal(isGuardedPath("SPEC.md", ROUTED), true);
  assert.equal(isGuardedPath("README.md", ROUTED), false);
  // Routing narrows nothing: the built-ins stay guarded whatever the routing.
  assert.equal(isGuardedPath("CLAUDE.md", ROUTED), true);
  assert.equal(isGuardedPath(".approval/log/events.jsonl", ROUTED), false);
});

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

test("a grant of the ROUTED sub-class is evidence for that path", () => {
  const { root, cleanup } = scratchRoot("guard-routed-subclass");
  try {
    const unit = world(root);
    const grant = grantOfClass(unit, "one", "policy.edit.spec", fileMaterial("/repo/SPEC.md"), 1);

    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings.length, 1);
    const finding = report.findings[0];
    assert.equal(finding?.path, "SPEC.md");
    assert.equal(finding?.ok, true);
    assert.equal(finding?.evidence, "granted-file");
    assert.equal(finding?.seq, grant.seq);
  } finally {
    cleanup();
  }
});

test("a grant of policy.edit ITSELF is still evidence for a now-routed path", () => {
  // The compatibility half. A grant taken under yesterday's string-only policy
  // named `policy.edit`; adopting a routing must not invalidate it.
  const { root, cleanup } = scratchRoot("guard-routed-parent");
  try {
    const unit = world(root);
    const grant = grantOfClass(unit, "one", "policy.edit", fileMaterial("/repo/SPEC.md"), 1);

    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.evidence, "granted-file");
    assert.equal(report.findings[0]?.seq, grant.seq);
  } finally {
    cleanup();
  }
});

test("a routed grant naming some OTHER file is not evidence", () => {
  // There is no class-level pass in this module and routing does not add one:
  // accepting a `policy.edit.spec` grant that names a different file would let
  // one approved edit launder every other edit in the window.
  const { root, cleanup } = scratchRoot("guard-routed-elsewhere");
  try {
    const unit = world(root);
    grantOfClass(unit, "one", "policy.edit.spec", fileMaterial("/repo/CHANGELOG.md"), 1);

    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
    assert.equal(report.ok, false, "a grant naming another file must not pass this path");
    assert.equal(report.findings[0]?.code, "no-evidence");
  } finally {
    cleanup();
  }
});

test("a routed grant does not cover a hunk it did not bind", () => {
  // The second half of the evidence test is untouched by routing: the class
  // opened the door, and the bytes still decide (APRV-202).
  const { root, cleanup } = scratchRoot("guard-routed-hunk");
  try {
    const unit = world(root);
    grantOfClass(unit, "one", "policy.edit.spec", fileMaterial("/repo/SPEC.md"), 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({ base: "old\n", head: "new\nsomething nobody approved\n" }),
      }),
    );
    assert.equal(report.ok, false, "an uncovered line must still fail");
    assert.equal(report.findings[0]?.code, "uncovered-hunk");
  } finally {
    cleanup();
  }
});
