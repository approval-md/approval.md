/** APRV-317: explicit operator permission for truthful irreversible actions. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { appendAttestation, checkAttestation } from "../src/core/attest.js";
import { diffPolicies, renderDiff } from "../src/core/policy-diff.js";
import { explain } from "../src/core/policy-explain.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { readVerifiedRecords } from "../src/core/state.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-irreversible-policy-"));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function text(classes: string, defaults = "  autonomy: manual"): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    defaults,
    "classes:",
    classes,
    "```",
    "",
  ].join("\n");
}

function load(classes: string, defaults?: string): PolicyLoadResult {
  counter += 1;
  const path = join(scratch, `policy-${String(counter)}.md`);
  writeFileSync(path, text(classes, defaults), "utf8");
  return loadPolicy({ file: path });
}

function ok(result: PolicyLoadResult): Extract<PolicyLoadResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error("policy did not load");
  return result;
}

test("absent and false preserve the floor, while each nonmanual mode may opt in", () => {
  for (const [autonomy, extra, expected, supervision] of [
    ["autonomous", "", "autonomous", null],
    ["supervised", "", "supervised", "retro"],
    ["supervised-retro", "", "supervised", "retro"],
    ["supervised-live", "\n    live_rate: 0.25", "supervised", "live"],
  ] as const) {
    const without = ok(load(`  work.${autonomy}:\n    autonomy: ${autonomy}${extra}`));
    assert.equal(resolve(without, `work.${autonomy}`, { reversible: false }).autonomy, "manual");

    const explicitFalse = ok(
      load(
        `  work.${autonomy}:\n    autonomy: ${autonomy}${extra}\n    allow_irreversible: false`,
      ),
    );
    assert.equal(
      resolve(explicitFalse, `work.${autonomy}`, { reversible: false }).autonomy,
      "manual",
    );

    const allowed = ok(
      load(`  work.${autonomy}:\n    autonomy: ${autonomy}${extra}\n    allow_irreversible: true`),
    );
    const result = resolve(allowed, `work.${autonomy}`, { reversible: false });
    assert.equal(result.autonomy, expected);
    assert.equal(result.supervision, supervision);
    assert.equal(result.allowIrreversible, true);
    assert.equal(result.floorApplied, false);
  }
});

test("invalid placement and malformed values fail the entire policy closed", () => {
  for (const [label, classes, defaults] of [
    ["manual true", "  work.run: { autonomy: manual, allow_irreversible: true }", undefined],
    ["human-only true", "  work.run: { autonomy: human-only, allow_irreversible: true }", undefined],
    ["nonboolean", "  work.run: { autonomy: autonomous, allow_irreversible: yes }", undefined],
    [
      "defaults",
      "  work.run: { autonomy: autonomous }",
      "  autonomy: autonomous\n  allow_irreversible: true",
    ],
  ] as const) {
    const result = load(classes, defaults);
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.code, "schema-invalid", label);
    assert.equal(resolve(result, "work.run", { reversible: false }).autonomy, "manual", label);
  }
});

test("every equally most-specific match must opt in; lower-specificity refusals do not govern", () => {
  const tied = ok(
    load(
      [
        "  work.*: { autonomy: autonomous, allow_irreversible: true }",
        "  '*.run': { autonomy: supervised-retro }",
      ].join("\n"),
    ),
  );
  const denied = resolve(tied, "work.run", { reversible: false });
  assert.equal(denied.autonomy, "manual");
  assert.deepEqual(denied.irreversiblePatterns, ["*.run", "work.*"]);

  const unanimous = ok(
    load(
      [
        "  work.*: { autonomy: autonomous, allow_irreversible: true }",
        "  '*.run': { autonomy: supervised-retro, allow_irreversible: true }",
      ].join("\n"),
    ),
  );
  assert.equal(resolve(unanimous, "work.run", { reversible: false }).autonomy, "supervised");

  const lower = ok(
    load(
      [
        "  work.*: { autonomy: autonomous }",
        "  work.special.run: { autonomy: autonomous, allow_irreversible: true }",
      ].join("\n"),
    ),
  );
  assert.equal(resolve(lower, "work.special.run", { reversible: false }).autonomy, "autonomous");
});

test("policy.edit children inherit the parent's irreversible capability", () => {
  const inherited = ok(
    load("  policy.edit: { autonomy: supervised-retro, allow_irreversible: true }"),
  );
  const result = resolve(inherited, "policy.edit.docs", { reversible: false });
  assert.equal(result.provenance, "inherited");
  assert.equal(result.autonomy, "supervised");
  assert.equal(result.allowIrreversible, true);
  assert.deepEqual(result.irreversiblePatterns, ["policy.edit"]);
});

test("protected built-in routes compare the effective irreversible outcome", () => {
  const result = load(
    [
      "  policy.edit: { autonomy: supervised-retro }",
      "  policy.edit.ci: { autonomy: supervised-retro, allow_irreversible: true }",
    ].join("\n"),
  );
  // Rebuild with the route because the helper intentionally only varies classes.
  counter += 1;
  const path = join(scratch, `policy-${String(counter)}.md`);
  writeFileSync(
    path,
    text(
      [
        "  policy.edit: { autonomy: supervised-retro }",
        "  policy.edit.ci: { autonomy: supervised-retro, allow_irreversible: true }",
      ].join("\n"),
    ).replace("classes:\n", "protected_paths:\n  - { path: .github/workflows/, class: policy.edit.ci }\nclasses:\n"),
    "utf8",
  );
  void result;
  const routed = loadPolicy({ file: path });
  assert.equal(routed.ok, false);
  if (!routed.ok) {
    assert.equal(routed.code, "protected-route-floor");
    assert.match(routed.message, /reversible: false/u);
    assert.match(routed.message, /supervised.*weaker than.*manual/u);
  }
});

test("explain names explicit permission and the governing tie group", () => {
  const policy = ok(
    load(
      [
        "  work.*: { autonomy: autonomous, allow_irreversible: true }",
        "  '*.run': { autonomy: supervised-retro, allow_irreversible: true }",
      ].join("\n"),
    ),
  );
  const explanation = explain(policy, "work.run", { reversible: false });
  assert.equal(explanation.outcome.autonomy, "supervised");
  assert.equal(explanation.manualBecause, null);
  assert.equal(explanation.overridden, null);
  assert.ok(explanation.decisionPath.some((line) => /every equally most-specific/u.test(line)));
  assert.ok(explanation.decisionPath.some((line) => line.includes("*.run, work.*")));
});

test("amendment diff exposes allow-only and mixed ordinary/irreversible changes", () => {
  const before = ok(load("  work.run: { autonomy: autonomous }"));
  const allowOnly = ok(
    load("  work.run: { autonomy: autonomous, allow_irreversible: true }"),
  );
  const only = diffPolicies(before, allowOnly, ["work.run"]);
  assert.equal(only.classes.length, 1);
  assert.deepEqual(only.classes[0]?.before, only.classes[0]?.after);
  assert.equal(only.classes[0]?.irreversible?.before.autonomy, "manual");
  assert.equal(only.classes[0]?.irreversible?.after.autonomy, "autonomous");
  assert.match(renderDiff(only).join("\n"), /work\.run \(reversible: false\): manual.*autonomous/u);

  const mixed = ok(
    load("  work.run: { autonomy: supervised-retro, allow_irreversible: true }"),
  );
  const both = diffPolicies(before, mixed, ["work.run"]);
  assert.equal(both.classes[0]?.before.autonomy, "autonomous");
  assert.equal(both.classes[0]?.after.autonomy, "supervised");
  assert.equal(both.classes[0]?.irreversible?.before.autonomy, "manual");
  assert.equal(both.classes[0]?.irreversible?.after.autonomy, "supervised");
  const rendered = renderDiff(both).join("\n");
  assert.match(rendered, /work\.run: autonomous.*supervised/u);
  assert.match(rendered, /work\.run \(reversible: false\): manual.*supervised/u);
});

test("action options cannot forge policy permission, and an edit invalidates attestation", () => {
  const dir = join(scratch, `attestation-${String(++counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  writeFileSync(policyPath, text("  work.run: { autonomy: autonomous }"), "utf8");
  const initial = ok(loadPolicy({ file: policyPath }));
  const forged = resolve(initial, "work.run", {
    reversible: false,
    allow_irreversible: true,
  } as { reversible: false; allow_irreversible: true });
  assert.equal(forged.autonomy, "manual");

  const attested = appendAttestation(logPath, policyPath, "human:carter", {
    clock: () => "2026-09-08T00:00:00Z",
  });
  assert.equal(attested.ok, true, attested.ok ? "" : attested.error.message);
  const records = readVerifiedRecords(logPath);
  assert.equal(records.ok, true, records.ok ? "" : records.message);
  if (!records.ok) return;
  assert.equal(checkAttestation(records.records, policyPath).status, "attested");

  writeFileSync(
    policyPath,
    text("  work.run: { autonomy: autonomous, allow_irreversible: true }"),
    "utf8",
  );
  assert.equal(checkAttestation(records.records, policyPath).status, "hash-mismatch");
});
