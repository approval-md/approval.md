/**
 * The amend diff's key vocabulary, read from the policy schema (APRV-296).
 *
 * `core/policy-diff.ts` names every top-level key a policy document carries and
 * marks the ones the schema does not know, because an unrecognised key is why a
 * policy fails closed to all-`manual`. Which keys those are used to be a
 * hand-written list beside the schema, and the 2026-09-07 ceremony is what the
 * copy cost: three `daemon.*` keys, admitted by the schema since APRV-217,
 * unchanged by that amendment, and each printed as
 * `(UNKNOWN KEY: … the policy FAILS CLOSED to all-manual until it is removed)`
 * over a policy the same run then loaded cleanly.
 *
 * Two properties, and the second is why the first is not enough on its own: the
 * vocabulary is the schema's own top-level `properties`, and a key the schema
 * really does not declare is still called out. A derivation that answered
 * "known" to everything would fix the false alarm by deleting the warning.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  diffPolicies,
  policyTopLevelKeys,
  POLICY_SCHEMA_PATH,
  renderDiff,
} from "../src/core/policy-diff.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRATCH_POLICY_PATH = join(REPO_ROOT, "scratch-APPROVAL.md");

/** A minimal policy document, as the markdown the loader reads. */
function policyDoc(...extra: string[]): string {
  return [
    "# Scratch policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    ...extra,
    "```",
    "",
  ].join("\n");
}

const BASE = policyDoc();

/** The three keys the ceremony warned about, exactly as the live policy has them. */
const WITH_DAEMON = policyDoc(
  "daemon:",
  "  read_proof: incremental",
  "  full_reproof_every: 50",
  "  full_reproof_after: 60s",
);

/** One character off, and therefore a key that really does fail the policy closed. */
const WITH_TYPO = policyDoc("daemonn:", "  read_proof: incremental");

test("the vocabulary is the policy schema's own top-level keys", () => {
  // The schema this reads is the schema `core/validate.ts` validates against:
  // one file, found by two derivations, so a schema directory that moves fails
  // here rather than leaving the renderer reading a path that no longer exists
  // and silently falling back to the stale list.
  assert.equal(POLICY_SCHEMA_PATH, join(DEFAULT_SCHEMA_DIR, "policy.schema.json"));
  const keys = policyTopLevelKeys();
  for (const key of ["version", "defaults", "classes", "approvers", "audit", "daemon", "channels"]) {
    assert.ok(keys.includes(key), `${key} is a schema key the diff would call unknown`);
  }
});

test("the daemon block renders as known keys, unchanged or not", () => {
  const added = renderDiff(
    diffPolicies(
      loadPolicyText(SCRATCH_POLICY_PATH, BASE),
      loadPolicyText(SCRATCH_POLICY_PATH, WITH_DAEMON),
    ),
  ).join("\n");
  assert.match(added, /daemon\.read_proof: \(absent\) -> incremental/u);
  assert.match(added, /daemon\.full_reproof_after: \(absent\) -> 60s/u);
  assert.equal(/UNKNOWN KEY/u.test(added), false, added);

  // And the ceremony's own case: the keys sit in both versions and moved not at
  // all, which is when a stale vocabulary printed its warning three times.
  const unmoved = renderDiff(
    diffPolicies(
      loadPolicyText(SCRATCH_POLICY_PATH, WITH_DAEMON),
      loadPolicyText(SCRATCH_POLICY_PATH, WITH_DAEMON),
    ),
  ).join("\n");
  assert.equal(/UNKNOWN KEY/u.test(unmoved), false, unmoved);
  assert.match(unmoved, /no semantic change/u);
});

test("a key the schema does not declare is still named as unknown", () => {
  const rendered = renderDiff(
    diffPolicies(
      loadPolicyText(SCRATCH_POLICY_PATH, BASE),
      loadPolicyText(SCRATCH_POLICY_PATH, WITH_TYPO),
    ),
  ).join("\n");
  assert.match(rendered, /daemonn\.read_proof: .*\(UNKNOWN KEY/u);
  assert.match(rendered, /FAILS CLOSED to all-manual/u);
});
