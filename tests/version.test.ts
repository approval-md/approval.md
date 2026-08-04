import assert from "node:assert/strict";
import { test } from "node:test";

import { POLICY_VERSION, SPEC_VERSION } from "../src/core/version.js";

test("SPEC_VERSION matches the version declared in SPEC.md", () => {
  assert.equal(SPEC_VERSION, "0.1.0-draft");
});

test("POLICY_VERSION matches the policy frontmatter version in SPEC.md", () => {
  assert.equal(POLICY_VERSION, "0.1");
});
