/**
 * The policy's tool-name mapping and unmapped-tool default, below the hook
 * (APRV-499): the glob, the first-match verdict, the load-time checks that
 * fail a policy closed, the schema, and the one class whose default
 * `defaults.unmapped_tool` supplies.
 *
 * Pure: every policy here is text handed to `loadPolicyText`, so nothing
 * touches a log. The hook's own half is `tests/cli-hook-tool-map.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { diffPolicies } from "../src/core/policy-diff.js";
import { explain } from "../src/core/policy-explain.js";
import { loadPolicyText, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import {
  UNMAPPED_TOOL_CLASS,
  classDeclared,
  matchesToolPattern,
  toolMapVerdict,
} from "../src/core/tool-map.js";
import { validate } from "../src/core/validate.js";

function policyText(yaml: string[]): string {
  return ["# Policy", "", "```yaml approval-policy", ...yaml, "```", ""].join("\n");
}

const BASE = [
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
];

const CLASSES = [
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  marketplace.*:",
  "    autonomy: manual",
  "  marketplace.app.read:",
  "    autonomy: autonomous",
  "  marketplace.contextsling.publish:",
  "    autonomy: human-only",
];

function load(yaml: string[]): PolicyLoadResult {
  return loadPolicyText("APPROVAL.md", policyText(yaml));
}

function loaded(yaml: string[]): Extract<PolicyLoadResult, { ok: true }> {
  const result = load(yaml);
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${JSON.stringify(result.errors)}`);
  return result as Extract<PolicyLoadResult, { ok: true }>;
}

function refused(yaml: string[]): Extract<PolicyLoadResult, { ok: false }> {
  const result = load(yaml);
  assert.equal(result.ok, false, "the policy loaded and should not have");
  return result as Extract<PolicyLoadResult, { ok: false }>;
}

// ---------------------------------------------------------------------------
// The glob
// ---------------------------------------------------------------------------

test("an exact pattern matches only the whole name, case-sensitively", () => {
  assert.equal(matchesToolPattern("mcp__zzz__post", "mcp__zzz__post"), true);
  assert.equal(matchesToolPattern("mcp__zzz__post", "mcp__zzz__posts"), false);
  assert.equal(matchesToolPattern("mcp__zzz__post", "xmcp__zzz__post"), false);
  assert.equal(matchesToolPattern("mcp__zzz__post", "MCP__zzz__post"), false);
});

test("* matches any run of characters, including none, anywhere in the pattern", () => {
  assert.equal(matchesToolPattern("mcp__contextsling__*", "mcp__contextsling__publish"), true);
  assert.equal(matchesToolPattern("mcp__contextsling__*", "mcp__contextsling__"), true);
  assert.equal(matchesToolPattern("mcp__contextsling__*", "mcp__contextslingx__publish"), false);
  assert.equal(matchesToolPattern("*__publish", "mcp__contextsling__publish"), true);
  assert.equal(matchesToolPattern("*__publish", "mcp__contextsling__publisher"), false);
  assert.equal(matchesToolPattern("mcp__*__publish", "mcp__a__b__publish"), true);
  assert.equal(matchesToolPattern("mcp__*__publish", "mcp____publish"), true);
  assert.equal(matchesToolPattern("a*b*c", "abc"), true);
  assert.equal(matchesToolPattern("a*b*c", "aXbYbZc"), true);
  assert.equal(matchesToolPattern("a*b*c", "acb"), false);
  // A literal run may not overlap the suffix it must leave room for.
  assert.equal(matchesToolPattern("ab*ba", "aba"), false);
  assert.equal(matchesToolPattern("*", "anything_at_all"), true);
  assert.equal(matchesToolPattern("*", ""), true);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("the first matching entry decides, and later entries are not read", () => {
  const policy = loaded([
    ...BASE,
    ...CLASSES,
    "tools:",
    "  - match: mcp__contextsling__publish",
    "    class: marketplace.contextsling.publish",
    '  - match: "mcp__contextsling__*"',
    "    class: marketplace.app.read",
  ]).policy;
  assert.deepEqual(toolMapVerdict(policy, "mcp__contextsling__publish"), {
    kind: "mapped",
    cls: "marketplace.contextsling.publish",
    match: "mcp__contextsling__publish",
    index: 0,
  });
  assert.deepEqual(toolMapVerdict(policy, "mcp__contextsling__list"), {
    kind: "mapped",
    cls: "marketplace.app.read",
    match: "mcp__contextsling__*",
    index: 1,
  });
  assert.deepEqual(toolMapVerdict(policy, "mcp__other__x"), { kind: "not-gated" });
});

test("a broad entry first shadows a narrow one after it: order is the author's to choose", () => {
  const policy = loaded([
    ...BASE,
    ...CLASSES,
    "tools:",
    '  - match: "mcp__contextsling__*"',
    "    class: marketplace.app.read",
    "  - match: mcp__contextsling__publish",
    "    class: marketplace.contextsling.publish",
  ]).policy;
  const verdict = toolMapVerdict(policy, "mcp__contextsling__publish");
  assert.equal(verdict.kind, "mapped");
  assert.equal(verdict.kind === "mapped" ? verdict.cls : null, "marketplace.app.read");
});

test("an unmatched tool takes defaults.unmapped_tool, and with no key is not gated", () => {
  const record = loaded([...BASE, "  unmapped_tool: record", ...CLASSES]).policy;
  assert.deepEqual(toolMapVerdict(record, "TodoWrite"), {
    kind: "unmapped",
    cls: UNMAPPED_TOOL_CLASS,
    mode: "record",
  });
  const ask = loaded([...BASE, "  unmapped_tool: ask", ...CLASSES]).policy;
  assert.deepEqual(toolMapVerdict(ask, "TodoWrite"), {
    kind: "unmapped",
    cls: UNMAPPED_TOOL_CLASS,
    mode: "ask",
  });
  const absent = loaded([...BASE, ...CLASSES]).policy;
  assert.deepEqual(toolMapVerdict(absent, "TodoWrite"), { kind: "not-gated" });
});

// ---------------------------------------------------------------------------
// Load-time checks: each fails the WHOLE policy closed
// ---------------------------------------------------------------------------

test("an entry naming a class classes does not declare fails the policy closed", () => {
  const result = refused([
    ...BASE,
    ...CLASSES,
    "tools:",
    "  - match: mcp__zzz__post",
    "    class: communicate.zzz.post",
  ]);
  assert.equal(result.code, "schema-invalid");
  assert.deepEqual(
    result.errors?.map((error) => [error.path, error.keyword]),
    [["/tools/0/class", "tool-class-undeclared"]],
  );
  // Fail closed means every class, unrelated ones included, is manual.
  assert.equal(resolve(result, "read.file").autonomy, "manual");
  assert.equal(resolve(result, "read.file").provenance, "fail-closed");
});

test("a class under a declared trailing family key is declared; an interior wildcard declares nothing", () => {
  assert.equal(classDeclared({ "marketplace.*": {} }, "marketplace.contextsling.publish"), true);
  assert.equal(classDeclared({ "marketplace.contextsling.*": {} }, "marketplace.contextsling.publish"), true);
  assert.equal(classDeclared({ "marketplace.contextsling.publish": {} }, "marketplace.contextsling.publish"), true);
  assert.equal(classDeclared({ "marketplace.*.publish": {} }, "marketplace.contextsling.publish"), false);
  assert.equal(classDeclared({ "*.*": {} }, "marketplace.contextsling.publish"), false);
  assert.equal(classDeclared({ "*": {} }, "marketplace"), false);
  // `marketplace.*` covers members, never the bare namespace (SPEC §5.2).
  assert.equal(classDeclared({ "marketplace.*": {} }, "marketplace"), false);
  loaded([
    ...BASE,
    "classes:",
    "  marketplace.*:",
    "    autonomy: manual",
    "tools:",
    "  - match: mcp__contextsling__publish",
    "    class: marketplace.contextsling.publish",
  ]);
});

test("an entry naming harness.tool.unmapped is refused: that class means no entry claimed the call", () => {
  const result = refused([
    ...BASE,
    "classes:",
    "  harness.tool.unmapped:",
    "    autonomy: autonomous",
    "tools:",
    "  - match: mcp__zzz__post",
    "    class: harness.tool.unmapped",
  ]);
  assert.deepEqual(
    result.errors?.map((error) => [error.path, error.keyword]),
    [["/tools/0/class", "tool-class-reserved"]],
  );
});

test("two entries sharing a match are refused: the second could never decide", () => {
  const result = refused([
    ...BASE,
    ...CLASSES,
    "tools:",
    "  - match: mcp__zzz__post",
    "    class: marketplace.app.read",
    "  - match: mcp__zzz__post",
    "    class: marketplace.contextsling.publish",
  ]);
  assert.deepEqual(
    result.errors?.map((error) => [error.path, error.keyword]),
    [["/tools/1/match", "tool-match-duplicate"]],
  );
});

test("a malformed match is a schema violation: **, a space, an empty string, a slash", () => {
  for (const match of ['"mcp__**"', '"mcp zzz"', '""', '"mcp/zzz"', '"mcp__zzz__?"']) {
    const result = refused([
      ...BASE,
      ...CLASSES,
      "tools:",
      `  - match: ${match}`,
      "    class: marketplace.app.read",
    ]);
    assert.equal(result.code, "schema-invalid", match);
    assert.ok(
      result.errors?.some((error) => error.path === "/tools/0/match"),
      `${match}: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("a malformed class is a schema violation: a wildcard, uppercase, a trailing dot", () => {
  for (const cls of ['"marketplace.*"', "Marketplace.app", '"marketplace."']) {
    const result = refused([
      ...BASE,
      ...CLASSES,
      "tools:",
      "  - match: mcp__zzz__post",
      `    class: ${cls}`,
    ]);
    assert.equal(result.code, "schema-invalid", cls);
    assert.ok(
      result.errors?.some((error) => error.path === "/tools/0/class"),
      `${cls}: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("an entry with an extra key, or missing one, is a schema violation", () => {
  const extra = refused([
    ...BASE,
    ...CLASSES,
    "tools:",
    "  - match: mcp__zzz__post",
    "    class: marketplace.app.read",
    "    autonomy: autonomous",
  ]);
  assert.equal(extra.code, "schema-invalid");
  const missing = refused([...BASE, ...CLASSES, "tools:", "  - match: mcp__zzz__post"]);
  assert.equal(missing.code, "schema-invalid");
});

test("defaults.unmapped_tool admits record and ask and nothing else", () => {
  for (const value of ["allow", "manual", "autonomous", "true"]) {
    const result = refused([...BASE, `  unmapped_tool: ${value}`, ...CLASSES]);
    assert.equal(result.code, "schema-invalid", value);
  }
});

test("the schema alone accepts a well-formed tools list and refuses a malformed one", () => {
  const ok = validate("policy", {
    version: "0.1",
    defaults: { autonomy: "manual", unmapped_tool: "record" },
    classes: { "marketplace.*": { autonomy: "manual" } },
    tools: [
      { match: "mcp__contextsling__*", class: "marketplace.contextsling.publish" },
      { match: "*", class: "marketplace.app.read" },
    ],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.ok ? null : ok.errors));
  const bad = validate("policy", { version: "0.1", tools: [{ match: "a**b", class: "x.y" }] });
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// Resolution of harness.tool.unmapped
// ---------------------------------------------------------------------------

test("record resolves harness.tool.unmapped autonomous and ask resolves it manual, over defaults.autonomy", () => {
  const record = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "  unmapped_tool: record",
  ]);
  const resolvedRecord = resolve(record, UNMAPPED_TOOL_CLASS);
  assert.equal(resolvedRecord.autonomy, "autonomous");
  assert.equal(resolvedRecord.provenance, "default");
  assert.equal(resolvedRecord.matched, null);

  const ask = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: autonomous",
    "  unmapped_tool: ask",
  ]);
  assert.equal(resolve(ask, UNMAPPED_TOOL_CLASS).autonomy, "manual");

  // Explicit beats default, human-only included: the key is the more specific
  // statement about this one class.
  const humanOnlyDefault = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: human-only",
    "  unmapped_tool: record",
  ]);
  assert.equal(resolve(humanOnlyDefault, UNMAPPED_TOOL_CLASS).autonomy, "autonomous");
});

test("the key is a default for one class: other classes keep defaults.autonomy", () => {
  const record = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "  unmapped_tool: record",
  ]);
  assert.equal(resolve(record, "harness.tool.other").autonomy, "manual");
  assert.equal(resolve(record, "harness.tool").autonomy, "manual");
});

test("a classes rule matching harness.tool.unmapped decides it, as a rule decides any class", () => {
  const sampled = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "  unmapped_tool: record",
    "classes:",
    "  harness.tool.unmapped:",
    "    autonomy: supervised-retro",
  ]);
  const resolution = resolve(sampled, UNMAPPED_TOOL_CLASS);
  assert.equal(resolution.autonomy, "supervised");
  assert.equal(resolution.supervision, "retro");
  assert.equal(resolution.provenance, "rule");

  const reserved = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "  unmapped_tool: record",
    "classes:",
    "  harness.*:",
    "    autonomy: human-only",
  ]);
  assert.equal(resolve(reserved, UNMAPPED_TOOL_CLASS).autonomy, "human-only");
});

test("an irreversible declaration still floors a recorded unmapped call to manual", () => {
  const record = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "  unmapped_tool: record",
  ]);
  assert.equal(resolve(record, UNMAPPED_TOOL_CLASS, { reversible: false }).autonomy, "manual");
});

test("explain names defaults.unmapped_tool as what decided", () => {
  const record = loaded([
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "  unmapped_tool: record",
  ]);
  const explained = explain(record, UNMAPPED_TOOL_CLASS);
  assert.ok(
    explained.decisionPath.some((line) => line.includes("defaults.unmapped_tool: record")),
    explained.decisionPath.join("\n"),
  );
});

test("the policy differ probes the classes the tool mapping reaches", () => {
  const before = loaded([...BASE, ...CLASSES]);
  const after = loaded([...BASE, "  unmapped_tool: record", ...CLASSES]);
  const diff = diffPolicies(before, after);
  assert.ok(diff.probes.includes(UNMAPPED_TOOL_CLASS), diff.probes.join(", "));
  const change = diff.classes.find((entry) => entry.class === UNMAPPED_TOOL_CLASS);
  assert.ok(change !== undefined, "the unmapped class's resolution change was not reported");
  assert.equal(change.before.autonomy, "manual");
  assert.equal(change.after.autonomy, "autonomous");
});
