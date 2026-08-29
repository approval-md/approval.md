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
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { CLASSIFIER_CLASSES } from "../src/core/command-class.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve, type Provenance } from "../src/core/policy-match.js";
import type { Autonomy } from "../src/core/policy-load.js";

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
  assert.equal(policy.budgets?.global?.daily_actions, 2000);
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

interface Expectation {
  actionClass: string;
  autonomy: Autonomy;
  provenance: Provenance;
  note?: string;
}

const EXPECTATIONS: readonly Expectation[] = [
  // manual — the side-effecting and self-modifying classes
  { actionClass: "deps.add", autonomy: "manual", provenance: "rule" },
  {
    actionClass: "network.call",
    autonomy: "manual",
    provenance: "rule",
    note: "re-tightened 2026-08-20 (attested seq 293) once APRV-114 taught the classifier that GET-shaped fetches are read.web; this class now covers only the mutating and ambiguous remainder",
  },
  { actionClass: "release.publish", autonomy: "manual", provenance: "rule" },
  { actionClass: "policy.edit", autonomy: "manual", provenance: "rule" },
  { actionClass: "vcs.history.rewrite", autonomy: "manual", provenance: "rule" },
  { actionClass: "files.delete.out_of_scope", autonomy: "manual", provenance: "rule" },
  {
    actionClass: "log.sync",
    autonomy: "manual",
    provenance: "rule",
    note: "declared 2026-08-26 (attested seq 513); the APRV-125 sign-off names sync=autonomous as the candidate end state once trust builds",
  },
  {
    actionClass: "log.advance",
    autonomy: "manual",
    provenance: "rule",
    note: "declared 2026-08-26 (attested seq 513); the APRV-125 sign-off names advance=supervised as the candidate end state once trust builds",
  },

  // autonomous — reads and in-workspace/branch-local writes
  {
    actionClass: "read.web",
    autonomy: "autonomous",
    provenance: "rule",
    note: "member of the read.* namespace",
  },
  {
    actionClass: "read.files.workspace",
    autonomy: "autonomous",
    provenance: "rule",
    note: "read.* trailing wildcard spans more than one segment",
  },
  { actionClass: "files.write.workspace", autonomy: "autonomous", provenance: "rule" },
  { actionClass: "vcs.commit.branch", autonomy: "autonomous", provenance: "rule" },
  { actionClass: "vcs.push.branch", autonomy: "autonomous", provenance: "rule" },

  // supervised — pushing to main is sampled, not free
  { actionClass: "vcs.push.main", autonomy: "supervised", provenance: "rule" },

  // defaults — undeclared classes fall to defaults.autonomy (manual)
  {
    actionClass: "communicate.email.external",
    autonomy: "manual",
    provenance: "default",
    note: "undeclared class: the absence of a grant is not a grant",
  },
  {
    actionClass: "read",
    autonomy: "manual",
    provenance: "default",
    // SPEC.md §5.2 (amended): a trailing `.*` matches ONE OR MORE segments, so
    // `read.*` is the namespace *under* `read` and does not cover the bare
    // class `read`. A policy wanting the bare class covered must list it as its
    // own rule; the repo policy does not, so `read` falls to the manual default.
    note: "bare namespace is NOT matched by read.* (SPEC.md §5.2)",
  },
];

for (const { actionClass, autonomy, provenance, note } of EXPECTATIONS) {
  const label = note === undefined ? "" : ` (${note})`;
  test(`APPROVAL.md resolves ${actionClass} → ${autonomy}/${provenance}${label}`, () => {
    const load = loadRepoPolicy();
    const resolution = resolve(load, actionClass);
    assert.equal(resolution.autonomy, autonomy);
    assert.equal(resolution.provenance, provenance);
    assert.equal(resolution.floorApplied, false);
  });
}

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

test("APPROVAL.md is unchanged mid-suite", () => {
  assert.ok(
    bytesBefore.equals(readFileSync(APPROVAL_MD)),
    "APPROVAL.md must never be written by this suite",
  );
});
