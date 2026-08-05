/**
 * Policy explanation tests (APRV-12).
 *
 * Two properties carry most of the weight here. First, the trace must agree
 * with the decision: `explain()` delegates to `resolve()`, so every candidate,
 * winner and floor claim is asserted against `resolve()`'s own output rather
 * than against a hand-written expectation that could drift from the matcher.
 * Second, `manualBecause` must distinguish the three ways an answer becomes
 * `manual` — a rule said so, the §7 floor overrode a grant, or the policy never
 * loaded — because collapsing them hides a broken policy behind an answer that
 * looks deliberate.
 *
 * Policies are written to temp files and read through the real `loadPolicy`;
 * no `PolicyLoadResult` is hand-built, so the fail-closed cases are the ones
 * the loader actually produces.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { explain, isActionClass } from "../src/core/policy-explain.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-policy-explain-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a policy file whose `classes:` block is `body`, and load it. */
function policyWith(body: string, defaults = "  autonomy: manual\n"): PolicyLoadResult {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "APPROVAL.md");
  writeFileSync(
    path,
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      defaults.trimEnd(),
      "classes:",
      body.trimEnd(),
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  return loadPolicy({ file: path });
}

const MANUAL_RULE = "  deps.add: { autonomy: manual }\n";
const AUTONOMOUS_RULE = "  read.*: { autonomy: autonomous }\n";

// ---------------------------------------------------------------------------
// The three reasons an answer is manual
// ---------------------------------------------------------------------------

test("manualBecause is matched-rule when a rule says manual", () => {
  const explanation = explain(policyWith(MANUAL_RULE), "deps.add");

  assert.equal(explanation.outcome.autonomy, "manual");
  assert.equal(explanation.provenance, "rule");
  assert.equal(explanation.manualBecause, "matched-rule");
  assert.equal(explanation.loadFailure, null);
  assert.equal(explanation.overridden, null);
  assert.deepEqual(explanation.matched, {
    pattern: "deps.add",
    rule: { autonomy: "manual" },
  });
});

test("manualBecause is matched-rule when defaults.autonomy supplies the manual", () => {
  const explanation = explain(policyWith(AUTONOMOUS_RULE), "financial.spend");

  assert.equal(explanation.outcome.autonomy, "manual");
  assert.equal(explanation.provenance, "default");
  assert.equal(explanation.manualBecause, "matched-rule");
  assert.equal(explanation.matched, null);
  assert.deepEqual(explanation.candidates, []);
});

test("manualBecause is irreversibility-floor, and overridden records the grant", () => {
  const load = policyWith(AUTONOMOUS_RULE);
  const explanation = explain(load, "read.web", { reversible: false });

  assert.equal(explanation.outcome.autonomy, "manual");
  assert.equal(explanation.provenance, "floor");
  assert.equal(explanation.manualBecause, "irreversibility-floor");
  assert.deepEqual(explanation.overridden, { pattern: "read.*", autonomy: "autonomous" });
  assert.equal(explanation.reversible, false);
  assert.equal(explanation.loadFailure, null);
  assert.ok(
    explanation.decisionPath.some((line) => line.includes("irreversibility floor")),
    "the floor must appear in the trace",
  );
});

test("the floor over defaults.autonomy reports a null overridden pattern", () => {
  const load = policyWith(MANUAL_RULE, "  autonomy: autonomous\n");
  const explanation = explain(load, "unmatched.class", { reversible: false });

  assert.equal(explanation.manualBecause, "irreversibility-floor");
  assert.deepEqual(explanation.overridden, { pattern: null, autonomy: "autonomous" });
  assert.ok(
    explanation.decisionPath.some((line) => line.includes("defaults.autonomy")),
    "the trace must name defaults.autonomy as the overridden grant",
  );
});

test("an already-manual outcome is not attributed to the floor", () => {
  const explanation = explain(policyWith(MANUAL_RULE), "deps.add", { reversible: false });

  assert.equal(explanation.manualBecause, "matched-rule");
  assert.equal(explanation.overridden, null);
  assert.ok(
    explanation.decisionPath.some((line) => line.includes("the floor changed nothing")),
    "the trace must say the floor was inert",
  );
});

test("manualBecause is load-failure when the policy file is missing", () => {
  const explanation = explain(
    loadPolicy({ dir: join(scratch, "nowhere") }),
    "read.web",
  );

  assert.equal(explanation.outcome.autonomy, "manual");
  assert.equal(explanation.provenance, "fail-closed");
  assert.equal(explanation.manualBecause, "load-failure");
  assert.equal(explanation.loadFailure?.code, "file-missing");
  assert.ok((explanation.loadFailure?.message.length ?? 0) > 0);
  assert.equal(explanation.matched, null);
  assert.deepEqual(explanation.candidates, []);
  assert.deepEqual(explanation.outcome, { autonomy: "manual", approvers: null, limits: null });
});

test("manualBecause is load-failure for a schema-invalid policy too", () => {
  const explanation = explain(policyWith("  read.web: { autonomy: sometimes }\n"), "read.web");

  assert.equal(explanation.manualBecause, "load-failure");
  assert.equal(explanation.loadFailure?.code, "schema-invalid");
});

test("manualBecause is null when the outcome is not manual", () => {
  const explanation = explain(policyWith(AUTONOMOUS_RULE), "read.web");

  assert.equal(explanation.outcome.autonomy, "autonomous");
  assert.equal(explanation.manualBecause, null);
  assert.equal(explanation.loadFailure, null);
  assert.equal(explanation.overridden, null);
  assert.equal(explanation.reversible, null);
});

// ---------------------------------------------------------------------------
// Candidates mirror the matcher
// ---------------------------------------------------------------------------

test("candidates mirror resolve() in order, pattern and autonomy", () => {
  const load = policyWith(
    [
      "  read.*: { autonomy: autonomous }",
      "  read.web: { autonomy: supervised }",
      "  '*.web': { autonomy: manual }",
    ].join("\n"),
  );
  const resolution = resolve(load, "read.web");
  const explanation = explain(load, "read.web");

  assert.deepEqual(
    explanation.candidates.map((candidate) => candidate.pattern),
    resolution.candidates.map((candidate) => candidate.pattern),
  );
  assert.deepEqual(
    explanation.candidates.map((candidate) => candidate.specificity),
    resolution.candidates.map((candidate) => candidate.specificity),
  );
  assert.deepEqual(
    explanation.candidates.map((candidate) => candidate.autonomy),
    resolution.candidates.map((candidate) => candidate.rule.autonomy),
  );
  assert.deepEqual(explanation.matched, resolution.matched);
  assert.equal(explanation.outcome.autonomy, resolution.autonomy);

  const winners = explanation.candidates.filter((candidate) => candidate.winner);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.pattern, resolution.matched?.pattern);
  // read.web has two literals, so it wins outright — no tie to break.
  assert.equal(winners[0]?.tieBreak, "specificity");
});

test("an equal-specificity tie is annotated as strictest-autonomy", () => {
  const load = policyWith(
    ["  read.*: { autonomy: autonomous }", "  '*.web': { autonomy: supervised }"].join("\n"),
  );
  const explanation = explain(load, "read.web");
  const resolution = resolve(load, "read.web");

  assert.equal(explanation.outcome.autonomy, "supervised");
  assert.equal(resolution.matched?.pattern, "*.web");
  const winner = explanation.candidates.find((candidate) => candidate.winner);
  assert.equal(winner?.pattern, "*.web");
  assert.equal(winner?.tieBreak, "strictest-autonomy");
  const loser = explanation.candidates.find((candidate) => !candidate.winner);
  assert.equal(loser?.pattern, "read.*");
  assert.equal(loser?.tieBreak, "tied-specificity");
  assert.ok(
    explanation.decisionPath.some((line) => line.includes("deny beats allow")),
    "the trace must explain the strictness tie-break",
  );
});

test("a tie on specificity and strictness is annotated as lexicographic", () => {
  const load = policyWith(
    ["  read.*: { autonomy: supervised }", "  '*.web': { autonomy: supervised }"].join("\n"),
  );
  const explanation = explain(load, "read.web");

  const winner = explanation.candidates.find((candidate) => candidate.winner);
  assert.equal(winner?.pattern, "*.web", "lexicographically smallest pattern wins");
  assert.equal(winner?.tieBreak, "lexicographic");
  assert.equal(
    explanation.candidates.find((candidate) => !candidate.winner)?.tieBreak,
    "tied-specificity",
  );
});

test("a candidate outside the head's tie group carries no tieBreak", () => {
  const load = policyWith(
    ["  read.*: { autonomy: autonomous }", "  read.web: { autonomy: supervised }"].join("\n"),
  );
  const explanation = explain(load, "read.web");

  const outer = explanation.candidates.find((candidate) => candidate.pattern === "read.*");
  assert.equal(outer?.winner, false);
  assert.equal(outer?.tieBreak, undefined);
});

// ---------------------------------------------------------------------------
// Trace, approvers/limits, determinism
// ---------------------------------------------------------------------------

test("decisionPath is non-empty and names the winning pattern", () => {
  const load = policyWith("  vcs.push.main: { autonomy: supervised }\n");
  const explanation = explain(load, "vcs.push.main");

  assert.ok(explanation.decisionPath.length >= 4);
  assert.ok(
    explanation.decisionPath.some((line) => line.includes("vcs.push.main")),
    "the winning pattern must appear in the trace",
  );
  assert.ok(
    explanation.decisionPath.some((line) => line.startsWith("winner: vcs.push.main")),
    "the winner line must be present",
  );
  assert.equal(explanation.decisionPath.at(-1), "final: supervised");
});

test("approvers and limits ride along from the matched rule", () => {
  const load = policyWith(
    "  financial.spend: { autonomy: manual, approvers: [carter], limits: { daily_usd: 100 } }\n",
  );
  const explanation = explain(load, "financial.spend");

  assert.deepEqual(explanation.outcome, {
    autonomy: "manual",
    approvers: ["carter"],
    limits: { daily_usd: 100 },
  });
});

test("explain is deterministic across calls", () => {
  const load = policyWith(
    [
      "  read.*: { autonomy: autonomous }",
      "  '*.web': { autonomy: supervised }",
      "  read.web.page: { autonomy: manual }",
    ].join("\n"),
  );

  for (const options of [{}, { reversible: true }, { reversible: false }]) {
    assert.deepEqual(explain(load, "read.web", options), explain(load, "read.web", options));
  }
  const missing = loadPolicy({ dir: join(scratch, "nowhere") });
  assert.deepEqual(explain(missing, "read.web"), explain(missing, "read.web"));
});

// ---------------------------------------------------------------------------
// Action-class grammar
// ---------------------------------------------------------------------------

test("isActionClass accepts concrete classes and rejects patterns and junk", () => {
  for (const value of ["read", "read.web", "vcs.push.main", "a1.b_2.c-3"]) {
    assert.equal(isActionClass(value), true, value);
  }
  for (const value of ["", "*", "read.*", "Read.WEB", "read..web", ".read", "read.", "read web"]) {
    assert.equal(isActionClass(value), false, JSON.stringify(value));
  }
});
