/**
 * Dogfood tests (APRV-13): the repository's own `APPROVAL.md`, under CI lock.
 *
 * approval.md is built by agents that operate under approval.md, so the policy
 * at the repo root is not documentation — it is live configuration, and the
 * only thing standing between "the gate works" and "the gate silently stopped
 * reading its own rules" is a test that exercises the real file with the real
 * engine. This suite loads `APPROVAL.md` in place (never a copy, never a
 * fixture), asserts its parsed shape, and pins the autonomy and provenance the
 * matcher resolves for every class the policy declares plus the default and
 * irreversibility-floor paths. Any future edit to `APPROVAL.md` that breaks the
 * policy, and any engine regression that mis-reads it, therefore fails
 * `npm test` and CI rather than being discovered by an agent doing something it
 * should not have been allowed to do. `APPROVAL.md` is read-only to agents: the
 * before/after byte comparison below is the mechanical enforcement of that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { CLASSIFIER_CLASSES } from "../src/core/command-class.js";
import { loadPolicy, loadPolicyText, type PolicyLoadResult } from "../src/core/policy-load.js";
import { loadValuesText } from "../src/core/values.js";
import { resolve } from "../src/core/policy-match.js";
import {
  checkPolicyExpectations,
  describeFailure,
  expectationsFor,
  REPO_POLICY_EXPECTATIONS,
} from "../src/core/policy-expectations.js";

/**
 * Repo root. This file compiles to `dist/tests/dogfood.test.js`, so the root is
 * two levels up from the compiled module — the same relocation-safe
 * `import.meta.url` derivation `src/core/validate.ts` uses for `DEFAULT_SCHEMA_DIR`.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APPROVAL_MD = fileURLToPath(new URL("../../APPROVAL.md", import.meta.url));

const BROKEN_POLICY_MESSAGE =
  "the repository's own APPROVAL.md no longer parses as a valid policy — " +
  "if you edited APPROVAL.md, fix the policy; if you changed the engine, " +
  "you broke compatibility with the live policy";

/** Bytes of `APPROVAL.md` captured before any test runs; compared after. */
let bytesBefore: Buffer;

before(() => {
  bytesBefore = readFileSync(APPROVAL_MD);
});

after(() => {
  const bytesAfter = readFileSync(APPROVAL_MD);
  assert.ok(
    bytesBefore.equals(bytesAfter),
    "APPROVAL.md is read-only: this suite must never modify a byte of it",
  );
});

/** Load the live policy, failing loudly with the operator-facing message. */
function loadRepoPolicy(): Extract<PolicyLoadResult, { ok: true }> {
  const result = loadPolicy({ dir: REPO_ROOT });
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `${BROKEN_POLICY_MESSAGE} [${result.code}: ${result.message}]`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result;
}

// ---------------------------------------------------------------------------
// 1. The live policy parses
// ---------------------------------------------------------------------------

test("the repository's own APPROVAL.md parses as a valid policy", () => {
  const result = loadRepoPolicy();
  assert.equal(result.source.filename, "APPROVAL.md", BROKEN_POLICY_MESSAGE);
  assert.equal(result.durations.approvalTtlMs, 86_400_000, BROKEN_POLICY_MESSAGE);
});

// ---------------------------------------------------------------------------
// 2. Structure of the parsed policy
// ---------------------------------------------------------------------------

test("APPROVAL.md defaults are fail-closed: manual, expiry rejects", () => {
  const { policy } = loadRepoPolicy();
  assert.equal(policy.defaults?.autonomy, "manual");
  assert.equal(policy.defaults?.on_expiry, "reject");
});

test("APPROVAL.md declares the audit sample rate and global budget", () => {
  const { policy } = loadRepoPolicy();
  assert.equal(policy.audit?.supervised_sample_rate, 0.15);
  assert.equal(policy.budgets?.global?.daily_actions, 20000);
});

test("APPROVAL.md declares approver carter on the cli channel", () => {
  const { policy } = loadRepoPolicy();
  const carter = policy.approvers?.carter;
  assert.ok(carter !== undefined, "approver 'carter' is declared");
  assert.ok(carter.channels.includes("cli"), "carter is reachable on 'cli'");
});

// ---------------------------------------------------------------------------
// 3. Matching: every declared class, plus defaults and the floor
// ---------------------------------------------------------------------------

/**
 * The pins themselves live in `src/core/policy-expectations.ts` (APRV-203).
 *
 * They moved out of this file so that `approval policy amend` can read them: the
 * ceremony runs the same check against the AMENDED file before it pushes, which
 * is what turns "CI went red after the ceremony" into a refusal on the laptop.
 * This suite is still their other reader, and still the thing CI runs.
 */
for (const { actionClass, autonomy, provenance, note } of REPO_POLICY_EXPECTATIONS) {
  const label = note === undefined ? "" : ` (${note})`;
  test(`APPROVAL.md resolves ${actionClass} → ${autonomy}/${provenance}${label}`, () => {
    const load = loadRepoPolicy();
    const resolution = resolve(load, actionClass);
    assert.equal(resolution.autonomy, autonomy);
    assert.equal(resolution.provenance, provenance);
    assert.equal(resolution.floorApplied, false);
  });
}

test("the shared expectation check passes against the live policy (APRV-203)", () => {
  // The exact call `approval policy amend` makes before it pushes. When this
  // fails, the ceremony refuses on the laptop instead of on CI.
  const checked = checkPolicyExpectations(loadRepoPolicy(), REPO_POLICY_EXPECTATIONS);
  assert.deepEqual(
    checked.failures.map(describeFailure),
    [],
    "the live policy no longer matches its pins; update src/core/policy-expectations.ts in the same ceremony that changed the policy",
  );
  assert.equal(checked.ok, true);
});

test("this repository's own policy file resolves to this repository's pins", () => {
  assert.equal(expectationsFor(APPROVAL_MD), REPO_POLICY_EXPECTATIONS);
  // Somebody else's policy is not governed by them.
  assert.equal(expectationsFor("/APPROVAL.md"), null);
});

test("APPROVAL.md + irreversibility floor: vcs.push.main reversible:false → manual/floor", () => {
  // SPEC.md §7 (amended): an irreversible action MUST NOT run under
  // `autonomous` or `supervised`. The live policy grants `vcs.push.main`
  // `supervised`, so the floor — not the rule — decides the outcome.
  const load = loadRepoPolicy();
  const resolution = resolve(load, "vcs.push.main", { reversible: false });
  assert.equal(resolution.autonomy, "manual");
  assert.equal(resolution.provenance, "floor");
  assert.equal(resolution.floorApplied, true);
  assert.equal(resolution.matched?.pattern, "vcs.push.main");
});

// ---------------------------------------------------------------------------
// 4. The harness hook can reach every class this policy declares (APRV-82)
// ---------------------------------------------------------------------------

test("every literal class in APPROVAL.md is reachable from the command classifier", () => {
  const { policy } = loadRepoPolicy();
  const declared = Object.keys(policy.classes ?? {});
  assert.ok(declared.length > 0, BROKEN_POLICY_MESSAGE);

  // Wildcard patterns (`read.*`) name a namespace rather than a class; the
  // classifier emits members of it (`read.shell`, `read.vcs.remote`), and the
  // pattern itself is never an action class.
  const literal = declared.filter((pattern) => !pattern.includes("*"));
  const unreachable = literal.filter((cls) => !CLASSIFIER_CLASSES.includes(cls));
  assert.deepEqual(
    unreachable,
    [],
    `APPROVAL.md gates ${unreachable.join(", ")}, and no rule in the Claude Code hook's classifier ` +
      "can emit it: a command in that class would be classified as something else, or refused as " +
      "unclassified, and the policy line would never fire. Add a rule to src/core/command-class.ts " +
      "or remove the class from the policy.",
  );
});

test("the classifier's read.* classes are covered by the policy's read.* rule", () => {
  const load = loadRepoPolicy();
  for (const cls of CLASSIFIER_CLASSES.filter((candidate) => candidate.startsWith("read."))) {
    assert.equal(
      resolve(load, cls).autonomy,
      "autonomous",
      `${cls} is emitted by the classifier and must be covered by the policy's read.* rule`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Read-only proof (the `after` hook above is the enforcement)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The proposed values block (APRV-240)
// ---------------------------------------------------------------------------

/**
 * docs/proposals/repo-values-block.md carries the `yaml approval-values`
 * block Carter pastes into APPROVAL.md by hand (agents may not write that
 * file). Prove, against a scratch copy and never the real file, that the paste
 * changes nothing about the policy: the block loads as values, and the policy
 * parsed from the combined bytes is the policy parsed from the live bytes.
 */
test("the proposed values block leaves the live policy byte-for-byte the same (APRV-240)", () => {
  const proposal = readFileSync(join(REPO_ROOT, "docs", "proposals", "repo-values-block.md"), "utf8");
  const open = proposal.indexOf("```yaml approval-values");
  assert.ok(open >= 0, "the proposal names no approval-values fence");
  const close = proposal.indexOf("\n```\n", open);
  assert.ok(close > open, "the proposal's values fence is unterminated");
  const block = proposal.slice(open, close + 4);

  const live = readFileSync(APPROVAL_MD, "utf8");
  const pasted = `${live.trimEnd()}\n\n${block}\n`;
  const scratchPath = join(REPO_ROOT, "APPROVAL.md");

  const values = loadValuesText(scratchPath, pasted);
  assert.equal(values.ok, true, values.ok ? "" : `${values.code}: ${values.message}`);
  assert.equal(values.ok && values.present, true);

  const before = loadPolicyText(scratchPath, live);
  const afterPaste = loadPolicyText(scratchPath, pasted);
  assert.deepEqual(afterPaste, before);
});

test("APPROVAL.md is unchanged mid-suite", () => {
  assert.ok(
    bytesBefore.equals(readFileSync(APPROVAL_MD)),
    "APPROVAL.md must never be written by this suite",
  );
});
