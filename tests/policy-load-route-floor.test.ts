/**
 * The `protected_paths` routing floor (APRV-266).
 *
 * `protected_paths` has been additive-only since APRV-107, for a reason routing
 * does not repeal: a policy that can shrink its own protected surface is a
 * policy an agent can edit its way out of. Routing is a new way to try, and it
 * leaves every list looking wider than before while the autonomy underneath
 * gets looser. So the loader resolves each route against the `policy.edit` line
 * and refuses the file when a BUILT-IN protected path would come out weaker.
 *
 * Refusal is at LOAD, not at classification, and the consequence is the whole
 * design: a policy that does not load resolves every class to `manual`. An
 * author who wrote a weakening they did not intend gets everything gated plus a
 * message naming the entry, which is the strictest available answer and the one
 * this loader has always given.
 *
 * The floor is general rather than a list of paths: it asks
 * `builtinProtectedPathClass` whether the runtime protects the path on its own,
 * so a built-in surface added later is floored the day it is added and nothing
 * here has to be revisited.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";

const FIXTURES = join(DEFAULT_SCHEMA_DIR, "fixtures", "policy-md");
const scratch = mkdtempSync(join(tmpdir(), "approval-md-route-floor-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a policy file whose block is `yaml`, and load it. */
let counter = 0;
function loadYaml(yaml: string): PolicyLoadResult {
  counter += 1;
  const file = join(scratch, `policy-${String(counter)}.md`);
  writeFileSync(file, ["```yaml approval-policy", yaml, "```", ""].join("\n"), "utf8");
  return loadPolicy({ file });
}

/** A policy whose `policy.edit` line is supervised-live at 0.1. */
function withRoutes(routes: string, classes = ""): string {
  return [
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "protected_paths:",
    routes,
    "classes:",
    "  policy.edit:",
    "    autonomy: supervised-live",
    "    live_rate: 0.1",
    classes,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// The shipped fixtures
// ---------------------------------------------------------------------------

test("the routed fixture loads and carries both entry shapes", () => {
  const result = loadPolicy({ file: join(FIXTURES, "valid", "routed-protected-paths.md") });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;
  assert.deepEqual(result.policy.protected_paths, [
    "SPEC.md",
    { path: "design/", class: "policy.edit.design" },
    { path: ".github/workflows/", class: "policy.edit.ci" },
    { path: "docs/constitution.md", class: "policy.edit.spec" },
  ]);
});

test("a route outside the policy.edit namespace is refused by the schema", () => {
  const result = loadPolicy({
    file: join(FIXTURES, "invalid", "protected-route-not-a-subclass.md"),
  });
  assert.equal(result.ok, false, "a route to another taxonomy branch must not load");
  if (result.ok) return;
  assert.equal(result.code, "schema-invalid");
});

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

test("a built-in policy.edit path routed to a STRICTER sub-class passes", () => {
  const result = loadYaml(
    withRoutes(
      "  - { path: .github/workflows/, class: policy.edit.ci }",
      "  policy.edit.ci: { autonomy: manual }",
    ),
  );
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;
  assert.equal(resolve(result, "policy.edit.ci").autonomy, "manual");
});

test("a path the runtime does not protect on its own is unfloored", () => {
  // `design/` is protected only BECAUSE this policy lists it, so there is
  // nothing for the floor to protect: the author is choosing the autonomy of a
  // surface they invented, and choosing a loose one narrows nothing.
  const result = loadYaml(
    withRoutes(
      "  - { path: design/, class: policy.edit.design }",
      "  policy.edit.design: { autonomy: supervised }",
    ),
  );
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;
  assert.equal(resolve(result, "policy.edit.design").autonomy, "supervised");
});

test("a built-in policy.edit path routed to a LOOSER level is refused", () => {
  const result = loadYaml(
    withRoutes(
      "  - { path: .github/workflows/, class: policy.edit.ci }",
      "  policy.edit.ci: { autonomy: autonomous }",
    ),
  );
  assert.equal(result.ok, false, "a weakening route must make the policy inoperative");
  if (result.ok) return;
  assert.equal(result.code, "protected-route-floor");
  assert.match(result.message, /\.github\/workflows\//u);
  assert.match(result.message, /policy\.edit\.ci/u);
  assert.match(result.message, /additive/u);
});

test("plain supervised under a supervised-live line is a weakening, caught by the LEVEL", () => {
  // The realistic mistake, and the one that shows the rate tie-break is not
  // load-bearing for it: `supervised` (retrospective) and `supervised-live` are
  // different levels in `policy-match`'s own table, 3 and 2, so the comparison
  // that catches this is the first one and no rate is consulted. The tie-break
  // below therefore only ever runs between two `supervised-live` rules, where
  // both rates exist — which is why its null guards are defensiveness rather
  // than a branch some policy reaches.
  const result = loadYaml(
    withRoutes(
      "  - { path: .github/workflows/, class: policy.edit.ci }",
      "  policy.edit.ci: { autonomy: supervised }",
    ),
  );
  assert.equal(result.ok, false, "retrospective sampling is looser than live gating");
  if (result.ok) return;
  assert.equal(result.code, "protected-route-floor");
  assert.match(result.message, /supervised — weaker/u);
});

test("a tie on the level compares the live rate", () => {
  // `supervised-live 0.01` under a `policy.edit` of `supervised-live 0.1` gates
  // one tenth as often as the line it replaces. The level says they are equal
  // and they are not, so the rate decides.
  const weaker = loadYaml(
    withRoutes(
      "  - { path: .github/workflows/, class: policy.edit.ci }",
      "  policy.edit.ci: { autonomy: supervised-live, live_rate: 0.01 }",
    ),
  );
  assert.equal(weaker.ok, false, "a lower live rate on a built-in path is a weakening");
  if (weaker.ok) return;
  assert.equal(weaker.code, "protected-route-floor");

  const stricter = loadYaml(
    withRoutes(
      "  - { path: .github/workflows/, class: policy.edit.ci }",
      "  policy.edit.ci: { autonomy: supervised-live, live_rate: 0.5 }",
    ),
  );
  assert.equal(stricter.ok, true, stricter.ok ? "" : stricter.message);
});

test("a route at the gate's own organs or at the log is refused outright", () => {
  // It could never fire — `protectedPathClass` answers `policy.core` and
  // `log.mutate` before any policy entry is read — but a policy whose author
  // believes a rule is in force that the runtime will never consult is exactly
  // the misreading this project exists to prevent.
  for (const path of ["APPROVAL.md", ".approval/", ".approval/log/"]) {
    const result = loadYaml(
      withRoutes(
        `  - { path: ${path}, class: policy.edit.home }`,
        "  policy.edit.home: { autonomy: manual }",
      ),
    );
    assert.equal(result.ok, false, `${path} must not be routable`);
    if (result.ok) continue;
    assert.equal(result.code, "protected-route-floor", path);
    assert.match(result.message, /can never fire/u);
  }
});

test("a bare-string policy is not put through the floor at all", () => {
  // The floor's first act is to look for an object entry and return when there
  // is none, so an APRV-107 policy is byte-identical in behaviour AND in cost.
  const result = loadYaml(
    withRoutes("  - SPEC.md\n  - design/\n  - .github/workflows/"),
  );
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
});

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

test("a routed class with no line of its own inherits the policy.edit line", () => {
  const result = loadYaml(withRoutes("  - { path: SPEC.md, class: policy.edit.spec }"));
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;
  const resolution = resolve(result, "policy.edit.spec");
  assert.equal(resolution.provenance, "inherited");
  assert.equal(resolution.declaredAutonomy, "supervised-live");
  assert.equal(resolution.liveRate, 0.1);
  // Adopting a routing must be a no-op until the author says otherwise: the
  // parent's own resolution is what the sub-class gets.
  assert.equal(resolution.autonomy, resolve(result, "policy.edit").autonomy);
});

test("inheritance is why an unlined route passes the floor", () => {
  // A route with no line resolves AT the line, which is never weaker than it.
  const result = loadYaml(withRoutes("  - { path: .github/workflows/, class: policy.edit.ci }"));
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
});

test("with no policy.edit rule at all a sub-class falls to defaults", () => {
  // `"inherited"` means "a `policy.edit` RULE decided this". With no such rule
  // there is nothing to inherit, and `defaults.autonomy` is the same answer by
  // a shorter road.
  const result = loadYaml(
    [
      'version: "0.1"',
      "defaults:",
      "  autonomy: manual",
      "protected_paths:",
      "  - { path: design/, class: policy.edit.design }",
    ].join("\n"),
  );
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;
  const resolution = resolve(result, "policy.edit.design");
  assert.equal(resolution.provenance, "default");
  assert.equal(resolution.autonomy, "manual");
});

test("a wildcard rule matching the sub-class beats inheritance", () => {
  // Inheritance is the NO-RULE-MATCHED path. `policy.edit.*` is a rule and it
  // matches, so it decides and provenance stays `"rule"`.
  const result = loadYaml(
    withRoutes(
      "  - { path: design/, class: policy.edit.design }",
      "  policy.edit.*: { autonomy: supervised }",
    ),
  );
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;
  const resolution = resolve(result, "policy.edit.design");
  assert.equal(resolution.provenance, "rule");
  assert.equal(resolution.autonomy, "supervised");
});
