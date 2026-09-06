/**
 * The pins module's two new readers (APRV-274).
 *
 * `approval policy amend --commit` has to do two things with the pins that the
 * pin CHECK never had to do: print the line an unpinned class needs, and say
 * how the pins file moved between the commit an amendment is built on and the
 * working tree. The first is a resolution turned into source text; the second
 * is a diff of two blobs of TypeScript, because the committed side of that
 * comparison is a git object with no build output to import.
 *
 * Both are DISPLAY, and this file pins that boundary as much as it pins the
 * behaviour: nothing here decides whether an amendment may proceed. The check
 * that can refuse a ceremony resolves the compiled `REPO_POLICY_EXPECTATIONS`
 * against a loaded policy and is exercised by `tests/dogfood.test.ts`, so a
 * pins TEXT this reader misreads costs a report line rather than a verdict.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadPolicy } from "../src/core/policy-load.js";
import {
  checkPolicyExpectations,
  describePinChange,
  diffPinSources,
  pinLine,
  readPinSource,
  REPO_POLICY_EXPECTATIONS,
} from "../src/core/policy-expectations.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------------------
// 1. The line an unpinned class needs
// ---------------------------------------------------------------------------

test("a pin line is the source line the pins list already uses", () => {
  assert.equal(
    pinLine("deps.remove", "manual", "rule"),
    '  { actionClass: "deps.remove", autonomy: "manual", provenance: "rule" },',
  );
});

test("a pin line survives the round trip back through the reader", () => {
  const source = ["export const REPO_POLICY_EXPECTATIONS = [", pinLine("gate.self", "human-only", "rule"), "];"].join("\n");
  assert.deepEqual(readPinSource(source), [
    { actionClass: "gate.self", resolution: "human-only/rule" },
  ]);
});

test("an unpinned class carries the line that pins the resolution it actually has", () => {
  // The live policy plus one class nothing pins. The line the check prints has
  // to state the resolution the AMENDED policy produces, or an operator who
  // pastes it swaps one failure for another.
  const load = loadPolicy({ dir: REPO_ROOT });
  assert.equal(load.ok, true, load.ok ? "" : `${load.code}: ${load.message}`);
  if (!load.ok) return;

  const withoutOne = REPO_POLICY_EXPECTATIONS.filter(
    (expectation) => expectation.actionClass !== "deps.add",
  );
  const checked = checkPolicyExpectations(load, withoutOne);
  const unpinned = checked.failures.filter((failure) => failure.kind === "unpinned");
  assert.deepEqual(
    unpinned.map((failure) => failure.actionClass),
    ["deps.add"],
  );
  assert.equal(
    unpinned[0]?.pinLine,
    '  { actionClass: "deps.add", autonomy: "manual", provenance: "rule" },',
  );
});

test("a failure that is not `unpinned` carries no pin line", () => {
  const load = loadPolicy({ dir: REPO_ROOT });
  assert.equal(load.ok, true, load.ok ? "" : `${load.code}: ${load.message}`);
  if (!load.ok) return;

  const moved = REPO_POLICY_EXPECTATIONS.map((expectation) =>
    expectation.actionClass === "deps.add" ? { ...expectation, autonomy: "autonomous" as const } : expectation,
  );
  const checked = checkPolicyExpectations(load, moved);
  const resolution = checked.failures.filter((failure) => failure.kind === "resolution");
  assert.equal(resolution.length > 0, true, "the moved pin produced no resolution failure");
  for (const failure of resolution) assert.equal(failure.pinLine, undefined);
});

// ---------------------------------------------------------------------------
// 2. Reading a pins module as text
// ---------------------------------------------------------------------------

test("the reader finds every entry in the real pins module", () => {
  // The compiled list is the authority; the reader is asserted against it, so a
  // pins file written in a shape this reader cannot follow fails here rather
  // than quietly reporting a smaller diff at a ceremony.
  const source = readFileSync(join(REPO_ROOT, "src", "core", "policy-expectations.ts"), "utf8");
  const read = readPinSource(source);
  assert.deepEqual(
    read.map((entry) => entry.actionClass),
    REPO_POLICY_EXPECTATIONS.map((expectation) => expectation.actionClass),
  );
  assert.deepEqual(
    read.map((entry) => entry.resolution),
    REPO_POLICY_EXPECTATIONS.map(
      (expectation) => `${expectation.autonomy}/${expectation.provenance}`,
    ),
  );
});

test("an entry the reader cannot make out is reported, never dropped", () => {
  const source = [
    "export const REPO_POLICY_EXPECTATIONS = [",
    '  { actionClass: "deps.add", autonomy: "manual", provenance: "rule" },',
    '  { actionClass: "log.sync" },',
    "];",
  ].join("\n");
  assert.deepEqual(readPinSource(source), [
    { actionClass: "deps.add", resolution: "manual/rule" },
    { actionClass: "log.sync", resolution: null },
  ]);
});

// ---------------------------------------------------------------------------
// 3. How the pins moved
// ---------------------------------------------------------------------------

const BEFORE = [
  "export const REPO_POLICY_EXPECTATIONS = [",
  '  { actionClass: "deps.add", autonomy: "manual", provenance: "rule" },',
  '  { actionClass: "log.sync", autonomy: "autonomous", provenance: "rule" },',
  '  { actionClass: "read", autonomy: "manual", provenance: "default" },',
  "];",
].join("\n");

test("a moved, an added and a removed pin each read as one change", () => {
  const after = [
    "export const REPO_POLICY_EXPECTATIONS = [",
    '  { actionClass: "deps.add", autonomy: "manual", provenance: "rule" },',
    '  { actionClass: "log.sync", autonomy: "manual", provenance: "rule" },',
    '  { actionClass: "files.delete.scratch", autonomy: "autonomous", provenance: "rule" },',
    "];",
  ].join("\n");
  assert.deepEqual(diffPinSources(BEFORE, after), [
    { actionClass: "files.delete.scratch", before: null, after: "autonomous/rule" },
    { actionClass: "log.sync", before: "autonomous/rule", after: "manual/rule" },
    { actionClass: "read", before: "manual/default", after: null },
  ]);
});

test("a comment, a note or a reflow moves no pin", () => {
  const reflowed = BEFORE.replace(
    '  { actionClass: "log.sync", autonomy: "autonomous", provenance: "rule" },',
    [
      "  {",
      '    actionClass: "log.sync",',
      '    autonomy: "autonomous",',
      '    provenance: "rule",',
      '    note: "an ff-pull with chain reconcile decides nothing",',
      "  },",
    ].join("\n"),
  );
  assert.notEqual(reflowed, BEFORE, "the fixture did not change at all");
  assert.deepEqual(diffPinSources(BEFORE, reflowed), []);
});

test("a pins file the base does not carry reads as every pin added", () => {
  assert.deepEqual(
    diffPinSources("", BEFORE).map(describePinChange),
    [
      "deps.add: not pinned -> manual/rule",
      "log.sync: not pinned -> autonomous/rule",
      "read: not pinned -> manual/default",
    ],
  );
});

test("an unreadable pin and an absent pin are different facts", () => {
  const unreadable = ["export const REPO_POLICY_EXPECTATIONS = [", '  { actionClass: "deps.add" },', "];"].join("\n");
  assert.deepEqual(diffPinSources(BEFORE, unreadable).map(describePinChange), [
    "deps.add: manual/rule -> unreadable",
    "log.sync: autonomous/rule -> not pinned",
    "read: manual/default -> not pinned",
  ]);
});
