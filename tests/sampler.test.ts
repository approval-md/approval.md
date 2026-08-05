/**
 * The audit sampler (APRV-40): `core/sampler.ts`.
 *
 * Pure-function suite. Nothing here touches a log, because the sampler does not:
 * it maps (secret, record hash) to a verdict and knows nothing else. The
 * lifecycle that consumes it is `tests/audit.test.ts`.
 *
 * The properties under test are the ones SPEC.md §5.2 asks for by name —
 * reproducible for the operator, unpredictable to the agent — plus the two
 * boundary rates, the uniformity the rate depends on to mean anything, and the
 * one rule that has no second chance: the secret never appears in any output.
 *
 * Every secret here comes from a TEST-SCOPED environment variable name, never
 * from a name a real policy would use, so nothing in this suite can be
 * mistaken for (or accidentally read) an operator's configuration.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadPolicy } from "../src/core/policy-load.js";
import {
  isSampled,
  resolveSampler,
  SAMPLER_DISABLED_REASONS,
  selectionValue,
} from "../src/core/sampler.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-sampler-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A test-scoped variable name. Never a name an operator would pick. */
const TEST_SECRET_ENV = "APPROVAL_TEST_SAMPLING_SECRET";
const SECRET = "operator-held-secret-never-in-the-log";
const OTHER_SECRET = "a-different-operator-held-secret";

/** Deterministic stand-ins for record hashes: 64 lowercase hex, distinct. */
function hashes(count: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(createHash("sha256").update(`record-${String(index)}`, "utf8").digest("hex"));
  }
  return out;
}

function policyText(body: string[]): string {
  return ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', ...body, "```", ""].join(
    "\n",
  );
}

function policyAt(body: string[]): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "APPROVAL.md");
  writeFileSync(path, policyText(body), "utf8");
  return path;
}

const RATE_AND_SECRET = [
  "audit:",
  "  supervised_sample_rate: 0.1",
  `  sampling_secret_env: ${TEST_SECRET_ENV}`,
];

// ===========================================================================
// The mapping
// ===========================================================================

test("the selection value is reproducible given the secret", () => {
  for (const hash of hashes(50)) {
    const first = selectionValue(SECRET, hash);
    assert.equal(selectionValue(SECRET, hash), first);
    assert.equal(selectionValue(SECRET, hash), first, "and again: the mapping holds no state");
  }
});

test("every selection value lies in [0, 1)", () => {
  for (const hash of hashes(2_000)) {
    const value = selectionValue(SECRET, hash);
    assert.ok(value >= 0, `value ${String(value)} is below 0`);
    assert.ok(value < 1, `value ${String(value)} is not below 1`);
  }
});

test("a different secret produces a different sample", () => {
  const subjects = hashes(500);
  const mine = subjects.filter((hash) => isSampled(SECRET, hash, 0.5));
  const theirs = subjects.filter((hash) => isSampled(OTHER_SECRET, hash, 0.5));

  assert.notDeepEqual(
    mine,
    theirs,
    "two secrets selected identical sets; the secret would then not be what makes the sample unpredictable",
  );
  const overlap = mine.filter((hash) => theirs.includes(hash)).length;
  // Two independent 50% samples of 500 overlap on ~125. A wildly different
  // number would mean the secret barely enters the mapping.
  assert.ok(
    overlap > 60 && overlap < 200,
    `overlap ${String(overlap)} is not the ~125 two independent halves should share`,
  );
});

test("rate 0 selects nothing and rate 1 selects everything", () => {
  const subjects = hashes(1_000);
  assert.equal(
    subjects.filter((hash) => isSampled(SECRET, hash, 0)).length,
    0,
    "rate 0 selected something",
  );
  assert.equal(
    subjects.filter((hash) => isSampled(SECRET, hash, 1)).length,
    subjects.length,
    "rate 1 did not select everything",
  );
});

test("a negative or non-finite rate selects nothing rather than throwing", () => {
  for (const rate of [-0.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(isSampled(SECRET, hashes(1)[0] as string, rate), false);
  }
  // A rate above 1 reads as "everything", the stricter of the two readings.
  assert.equal(isSampled(SECRET, hashes(1)[0] as string, 1.5), true);
});

test("the mapping is unbiased across ten coarse buckets", () => {
  const buckets: number[] = Array.from({ length: 10 }, () => 0);
  const subjects = hashes(10_000);
  for (const hash of subjects) {
    const bucket = Math.floor(selectionValue(SECRET, hash) * 10);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  // Deterministic given the fixed secret and the fixed subject list, so this is
  // a pinned observation rather than a flaky statistical test. The band is ~5
  // standard deviations (sd = sqrt(10000 * 0.1 * 0.9) ≈ 30) around 1000: wide
  // enough that no honest PRF fails it, tight enough that a truncation bug or a
  // modulo bias does.
  for (const [index, count] of buckets.entries()) {
    assert.ok(
      count > 850 && count < 1_150,
      `bucket ${String(index)} holds ${String(count)} of 10000; the mapping is not uniform`,
    );
  }
});

test("the selected fraction tracks the configured rate", () => {
  const subjects = hashes(10_000);
  for (const rate of [0.05, 0.1, 0.25, 0.5]) {
    const selected = subjects.filter((hash) => isSampled(SECRET, hash, rate)).length;
    const expected = rate * subjects.length;
    assert.ok(
      Math.abs(selected - expected) < 5 * Math.sqrt(expected * (1 - rate)),
      `rate ${String(rate)} selected ${String(selected)} of 10000, expected about ${String(expected)}`,
    );
  }
});

test("a sample is monotone in the rate: raising it never unselects anything", () => {
  const subjects = hashes(500);
  const low = new Set(subjects.filter((hash) => isSampled(SECRET, hash, 0.2)));
  const high = subjects.filter((hash) => isSampled(SECRET, hash, 0.6));
  for (const hash of low) {
    assert.ok(
      high.includes(hash),
      "a record sampled at 0.2 fell out of the sample at 0.6; scrutiny must only ratchet up",
    );
  }
});

// ===========================================================================
// Resolution from policy and environment
// ===========================================================================

test("the disabled-reason union is frozen public API", () => {
  assert.deepEqual(
    [...SAMPLER_DISABLED_REASONS],
    [
      "policy-unreadable",
      "rate-absent",
      "rate-zero",
      "rate-invalid",
      "secret-env-unnamed",
      "secret-unset",
    ],
  );
});

test("a rate and a set secret produce an enabled sampler", () => {
  const load = loadPolicy({ file: policyAt(RATE_AND_SECRET) });
  const sampler = resolveSampler(load, { [TEST_SECRET_ENV]: SECRET });
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;
  assert.equal(sampler.rate, 0.1);
  assert.equal(sampler.secretEnv, TEST_SECRET_ENV);
  assert.equal(sampler.selects(hashes(1)[0] as string), isSampled(SECRET, hashes(1)[0] as string, 0.1));
});

test("an unset secret disables sampling with a distinct reason", () => {
  const load = loadPolicy({ file: policyAt(RATE_AND_SECRET) });
  const sampler = resolveSampler(load, {});
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "secret-unset");
  assert.equal(sampler.secretEnv, TEST_SECRET_ENV);
  assert.equal(sampler.rate, 0.1, "the rate is still reported: the operator configured it");
});

test("an empty secret is an unset secret", () => {
  const load = loadPolicy({ file: policyAt(RATE_AND_SECRET) });
  const sampler = resolveSampler(load, { [TEST_SECRET_ENV]: "" });
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "secret-unset");
});

test("a rate with no named secret variable disables sampling", () => {
  const load = loadPolicy({ file: policyAt(["audit:", "  supervised_sample_rate: 0.5"]) });
  const sampler = resolveSampler(load, { [TEST_SECRET_ENV]: SECRET });
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "secret-env-unnamed");
  assert.match(
    sampler.message,
    /forbidden/u,
    "the refusal should say why an event-content seed is not the fallback",
  );
});

test("rate 0 and an absent rate are distinct disabled reasons", () => {
  const zero = resolveSampler(
    loadPolicy({
      file: policyAt(["audit:", "  supervised_sample_rate: 0", `  sampling_secret_env: ${TEST_SECRET_ENV}`]),
    }),
    { [TEST_SECRET_ENV]: SECRET },
  );
  assert.equal(zero.enabled, false);
  if (!zero.enabled) assert.equal(zero.reason, "rate-zero");

  const absent = resolveSampler(
    loadPolicy({ file: policyAt([`audit:`, `  sampling_secret_env: ${TEST_SECRET_ENV}`]) }),
    { [TEST_SECRET_ENV]: SECRET },
  );
  assert.equal(absent.enabled, false);
  if (!absent.enabled) assert.equal(absent.reason, "rate-absent");
});

test("an unloadable policy disables sampling rather than inventing a rate", () => {
  const sampler = resolveSampler(loadPolicy({ file: join(scratch, "does-not-exist.md") }), {
    [TEST_SECRET_ENV]: SECRET,
  });
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "policy-unreadable");
  assert.equal(sampler.rate, null);
});

// ===========================================================================
// The secret never leaves
// ===========================================================================

test("the secret appears in no serialization, message, or enumerable property", () => {
  const load = loadPolicy({ file: policyAt(RATE_AND_SECRET) });
  const sampler = resolveSampler(load, { [TEST_SECRET_ENV]: SECRET });
  assert.equal(sampler.enabled, true);

  const serialized = JSON.stringify(sampler);
  assert.equal(
    serialized.includes(SECRET),
    false,
    `the sampler serialized to something containing the secret: ${serialized}`,
  );
  assert.match(serialized, /"secret_env":"APPROVAL_TEST_SAMPLING_SECRET"/u);

  for (const value of Object.values(sampler)) {
    assert.equal(
      typeof value === "string" && value.includes(SECRET),
      false,
      "an enumerable property of the sampler carries the secret",
    );
  }
});

test("no disabled message quotes the secret, even when the secret is set", () => {
  // Every disablement path, each with the secret present in the environment, so
  // a message that interpolated the value instead of the NAME would be caught.
  const cases = [
    policyAt(["audit:", "  supervised_sample_rate: 0"]),
    policyAt(["audit:", "  supervised_sample_rate: 0.5"]),
    policyAt([`audit:`, `  sampling_secret_env: ${TEST_SECRET_ENV}`]),
    join(scratch, "absent.md"),
  ];
  for (const file of cases) {
    const sampler = resolveSampler(loadPolicy({ file }), { [TEST_SECRET_ENV]: SECRET });
    assert.equal(sampler.enabled, false);
    if (sampler.enabled) continue;
    assert.equal(
      sampler.message.includes(SECRET),
      false,
      `a disabled message quoted the secret: ${sampler.message}`,
    );
  }
});

test("the selection value is not derivable from the record hash alone", () => {
  // The property SPEC.md §5.2 buys with the secret: an agent that knows the
  // record hash — which it authored, and which is public in the log — learns
  // nothing about the verdict without the key. Stated here as the observable
  // consequence: two keys disagree on a healthy fraction of the same subjects.
  const subjects = hashes(1_000);
  const disagreements = subjects.filter(
    (hash) => isSampled(SECRET, hash, 0.5) !== isSampled(OTHER_SECRET, hash, 0.5),
  ).length;
  assert.ok(
    disagreements > 400 && disagreements < 600,
    `two keys disagreed on ${String(disagreements)} of 1000 subjects at rate 0.5; the verdict is not keyed as it should be`,
  );
});
