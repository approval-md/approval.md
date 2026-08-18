/**
 * Class matching and autonomy resolution tests (APRV-11).
 *
 * Every policy here is built through the real `loadPolicy` path — either the
 * SPEC §5.1 canonical fixture or a temporary `APPROVAL.md` written to a scratch
 * dir — so the matcher is always exercised against a schema-validated policy
 * rather than a hand-assembled object literal that the schema might reject.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import {
  matchesPattern,
  resolve,
  specificityOf,
  type Resolution,
} from "../src/core/policy-match.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";

const FIXTURES = join(DEFAULT_SCHEMA_DIR, "fixtures", "policy-md");

const scratch = mkdtempSync(join(tmpdir(), "approval-md-policy-match-"));
let scratchCounter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const CANONICAL = loadPolicy({ file: join(FIXTURES, "valid", "canonical.md") });

/** Write a policy block to a scratch file and load it through `loadPolicy`. */
function policy(block: string): PolicyLoadResult {
  scratchCounter += 1;
  const path = join(scratch, `policy-${String(scratchCounter)}.md`);
  writeFileSync(path, `# Policy\n\nprose\n\n\`\`\`yaml approval-policy\n${block}\n\`\`\`\n`);
  const loaded = loadPolicy({ file: path });
  assert.equal(loaded.ok, true, loaded.ok ? "" : `${loaded.code}: ${loaded.message}`);
  return loaded;
}

/** A policy whose `classes` map is exactly the given pattern -> autonomy pairs. */
function classesPolicy(
  rules: Array<[pattern: string, autonomy: string]>,
  defaults = 'defaults:\n  autonomy: manual\n',
): PolicyLoadResult {
  const body = rules
    .map(([pattern, autonomy]) => `  "${pattern}": { autonomy: ${autonomy} }`)
    .join("\n");
  return policy(`version: "0.1"\n${defaults}classes:\n${body}`);
}

// ---------------------------------------------------------------------------
// SPEC §5.1 canonical policy
// ---------------------------------------------------------------------------

test("every class in the canonical policy resolves to its expected rule", () => {
  const cases: Array<[actionClass: string, pattern: string | null, autonomy: string]> = [
    ["read.web", "read.*", "autonomous"],
    ["read.web.page", "read.*", "autonomous"],
    ["read.file", "read.*", "autonomous"],
    ["files.write.workspace", "files.write.workspace", "autonomous"],
    ["calendar.write.own", "calendar.write.own", "supervised"],
    ["communicate.email.draft", "communicate.email.draft", "autonomous"],
    ["communicate.email.external", "communicate.email.external", "manual"],
    ["financial.spend", "financial.spend", "manual"],
    ["public.post", "public.post", "manual"],
    ["data.delete", "data.delete", "manual"],
    ["account.auth", "account.auth", "manual"],
    // Unmatched by any canonical rule -> defaults.autonomy (manual).
    ["physical.order", null, "manual"],
    ["files.write.repo", null, "manual"],
    ["calendar.write.shared", null, "manual"],
    ["read", null, "manual"],
  ];

  for (const [actionClass, pattern, autonomy] of cases) {
    const result = resolve(CANONICAL, actionClass);
    assert.equal(result.autonomy, autonomy, `autonomy for ${actionClass}`);
    assert.equal(result.matched?.pattern ?? null, pattern, `matched rule for ${actionClass}`);
    assert.equal(
      result.provenance,
      pattern === null ? "default" : "rule",
      `provenance for ${actionClass}`,
    );
  }
});

test("canonical approvers and limits come from the matched rule only", () => {
  const spend = resolve(CANONICAL, "financial.spend");
  assert.deepEqual(spend.approvers, ["alice"]);
  assert.deepEqual(spend.limits, { per_action_usd: 25, daily_usd: 100 });

  const external = resolve(CANONICAL, "communicate.email.external");
  assert.deepEqual(external.approvers, ["alice"]);
  assert.equal(external.limits, null, "rule without limits carries null");

  const read = resolve(CANONICAL, "read.web");
  assert.equal(read.approvers, null);
  assert.equal(read.limits, null);

  const defaulted = resolve(CANONICAL, "physical.order");
  assert.equal(defaulted.approvers, null, "defaulted resolutions carry no approvers");
  assert.equal(defaulted.limits, null, "defaulted resolutions carry no limits");
  assert.deepEqual(defaulted.candidates, []);
});

// ---------------------------------------------------------------------------
// Pattern grammar
// ---------------------------------------------------------------------------

test("bare `*` matches single-segment classes only", () => {
  assert.equal(matchesPattern("*", "read"), true);
  assert.equal(matchesPattern("*", "financial"), true);
  assert.equal(matchesPattern("*", "read.web"), false);
  assert.equal(matchesPattern("*", "a.b.c"), false);

  const loaded = classesPolicy([["*", "supervised"]]);
  assert.equal(resolve(loaded, "read").autonomy, "supervised");
  assert.equal(resolve(loaded, "read.web").autonomy, "manual");
  assert.equal(resolve(loaded, "read.web").provenance, "default");
});

test("an interior `*` matches exactly one segment", () => {
  assert.equal(matchesPattern("calendar.*.own", "calendar.write.own"), true);
  assert.equal(matchesPattern("calendar.*.own", "calendar.read.own"), true);
  assert.equal(matchesPattern("calendar.*.own", "calendar.write.shared"), false);
  assert.equal(matchesPattern("calendar.*.own", "calendar.own"), false);
  assert.equal(matchesPattern("calendar.*.own", "calendar.write.deep.own"), false);

  const loaded = classesPolicy([
    ["calendar.*.own", "supervised"],
    ["calendar.write.own", "autonomous"],
  ]);
  // calendar.write.own has 3 literals, beats calendar.*.own's 2.
  const specific = resolve(loaded, "calendar.write.own");
  assert.equal(specific.matched?.pattern, "calendar.write.own");
  assert.equal(specific.autonomy, "autonomous");
  assert.equal(specific.candidates.length, 2, "both rules are recorded as candidates");
  assert.deepEqual(
    specific.candidates.map((candidate) => candidate.pattern),
    ["calendar.write.own", "calendar.*.own"],
    "candidates are listed most specific first",
  );

  const wildcarded = resolve(loaded, "calendar.read.own");
  assert.equal(wildcarded.matched?.pattern, "calendar.*.own");
  assert.equal(wildcarded.autonomy, "supervised");
});

test("a trailing `.*` matches one or more segments at any depth", () => {
  assert.equal(matchesPattern("a.*", "a.b"), true);
  assert.equal(matchesPattern("a.*", "a.b.c"), true);
  assert.equal(matchesPattern("a.*", "a.b.c.d"), true);
  assert.equal(matchesPattern("a.b.*", "a.b.c.d.e"), true);
  assert.equal(matchesPattern("a.b.*", "a.b"), false, "trailing .* needs a further segment");
  assert.equal(matchesPattern("a.*", "b.c"), false);
});

test("`read.*` does not match the bare class `read`", () => {
  assert.equal(matchesPattern("read.*", "read"), false);
  assert.equal(matchesPattern("read.*", "read.web"), true);

  // The schema admits `read` and `read.*` as distinct keys, so a policy may
  // give them different autonomy; they are not aliases.
  const loaded = classesPolicy([
    ["read", "manual"],
    ["read.*", "autonomous"],
  ]);
  assert.equal(resolve(loaded, "read").matched?.pattern, "read");
  assert.equal(resolve(loaded, "read").autonomy, "manual");
  assert.equal(resolve(loaded, "read.web").matched?.pattern, "read.*");
  assert.equal(resolve(loaded, "read.web").autonomy, "autonomous");

  // Without a bare `read` rule the class falls through to the default.
  const namespaceOnly = classesPolicy([["read.*", "autonomous"]]);
  const bare = resolve(namespaceOnly, "read");
  assert.equal(bare.provenance, "default");
  assert.deepEqual(bare.candidates, []);
});

test("multi-wildcard patterns match by arity", () => {
  assert.equal(matchesPattern("*.*", "a.b"), true);
  assert.equal(matchesPattern("*.*", "a.b.c"), true, "trailing wildcard spans the tail");
  assert.equal(matchesPattern("*.*", "a"), false);
  assert.equal(matchesPattern("a.*.c", "a.b.c"), true);
  assert.equal(matchesPattern("a.*.c", "a.b.d"), false);
  assert.equal(matchesPattern("a.*.c", "a.b.x.c"), false);
  assert.equal(matchesPattern("*.b.*", "a.b.c"), true);
  assert.equal(matchesPattern("*.b.*", "a.b.c.d"), true);
  assert.equal(matchesPattern("*.b.*", "a.b"), false);
});

// ---------------------------------------------------------------------------
// Specificity
// ---------------------------------------------------------------------------

test("specificity keys count literals, wildcards and total segments", () => {
  assert.deepEqual(specificityOf("a.b.c"), [3, 0, 3]);
  assert.deepEqual(specificityOf("a.b.*"), [2, 1, 3]);
  assert.deepEqual(specificityOf("a.*.*"), [1, 2, 3]);
  assert.deepEqual(specificityOf("*"), [0, 1, 1]);
  assert.deepEqual(specificityOf("read.*"), [1, 1, 2], "trailing .* is one wildcard segment");
});

test("specificity level (a): more literal segments wins", () => {
  const loaded = classesPolicy([
    ["a.b.*", "autonomous"], // [2, 1, 3]
    ["a.*.*", "manual"], //     [1, 2, 3]
  ]);
  const result = resolve(loaded, "a.b.c");
  assert.equal(result.matched?.pattern, "a.b.*");
  assert.equal(result.autonomy, "autonomous", "the more specific rule wins over the stricter one");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.specificity),
    [
      [2, 1, 3],
      [1, 2, 3],
    ],
  );
});

test("specificity level (b): equal literals, fewer wildcards wins", () => {
  const loaded = classesPolicy([
    ["a.*.*", "manual"], // [1, 2, 3]
    ["a.*", "autonomous"], // [1, 1, 2]
  ]);
  const result = resolve(loaded, "a.b.c");
  assert.equal(result.matched?.pattern, "a.*");
  assert.equal(result.autonomy, "autonomous");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.pattern),
    ["a.*", "a.*.*"],
  );
});

test("specificity level (c): total segments is a defensive tie-break", () => {
  // For any pattern, totalSegments === literalSegments + wildcardSegments, so
  // clause (3) of the SPEC §5.2 specificity rule can never actually decide a
  // comparison that clauses (1) and (2) left tied. It is implemented for
  // conformance with the written rule; this test pins the invariant that makes
  // it unreachable, so a future grammar change (e.g. a `**` segment counted
  // differently) breaks here loudly rather than silently altering precedence.
  const patterns = [
    "a",
    "*",
    "a.b",
    "a.*",
    "*.b",
    "*.*",
    "a.b.c",
    "a.b.*",
    "a.*.c",
    "*.b.c",
    "a.*.*",
    "*.*.*",
    "read.*",
    "calendar.*.own",
  ];
  for (const pattern of patterns) {
    const [literals, wildcards, total] = specificityOf(pattern);
    assert.equal(literals + wildcards, total, `${pattern}: literals + wildcards === total`);
  }
});

test("specificity level (d): a full tie is broken by the strictest autonomy", () => {
  const loaded = classesPolicy([
    ["a.b.*", "autonomous"], // [2, 1, 3]
    ["*.b.c", "manual"], //     [2, 1, 3]
  ]);
  const result = resolve(loaded, "a.b.c");
  assert.deepEqual(result.candidates.map((candidate) => candidate.specificity), [
    [2, 1, 3],
    [2, 1, 3],
  ]);
  assert.equal(result.matched?.pattern, "*.b.c");
  assert.equal(result.autonomy, "manual");
  assert.equal(result.provenance, "rule");
});

test("equally strict full ties resolve to the lexicographically smallest pattern", () => {
  const forward = classesPolicy([
    ["a.b.*", "manual"],
    ["*.b.c", "manual"],
  ]);
  const reversed = classesPolicy([
    ["*.b.c", "manual"],
    ["a.b.*", "manual"],
  ]);
  for (const loaded of [forward, reversed]) {
    const result = resolve(loaded, "a.b.c");
    assert.equal(result.matched?.pattern, "*.b.c", "`*` sorts before `a`");
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.pattern),
      ["*.b.c", "a.b.*"],
      "candidate order is independent of policy key order",
    );
  }
});

// ---------------------------------------------------------------------------
// Strictest-wins, every pair
// ---------------------------------------------------------------------------

test("strictest autonomy wins for every pair at equal specificity", () => {
  const pairs: Array<[a: string, b: string, winner: string]> = [
    ["manual", "supervised", "manual"],
    ["supervised", "autonomous", "supervised"],
    ["manual", "autonomous", "manual"],
  ];
  for (const [a, b, winner] of pairs) {
    // Both orderings of the two equally specific patterns, both orderings of
    // the autonomy assignment: four checks per pair.
    for (const [first, second] of [
      [a, b],
      [b, a],
    ] as Array<[string, string]>) {
      const loaded = classesPolicy([
        ["a.b.*", first],
        ["*.b.c", second],
      ]);
      const result = resolve(loaded, "a.b.c");
      assert.equal(result.autonomy, winner, `${first} vs ${second}`);
      assert.equal(result.provenance, "rule");
      assert.equal(result.matched?.rule.autonomy, winner, "matched rule is the strict one");
    }
  }
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("an unmatched class takes defaults.autonomy", () => {
  for (const autonomy of ["manual", "supervised", "autonomous"]) {
    const loaded = classesPolicy(
      [["read.*", "autonomous"]],
      `defaults:\n  autonomy: ${autonomy}\n`,
    );
    const result = resolve(loaded, "financial.spend");
    assert.equal(result.autonomy, autonomy);
    assert.equal(result.provenance, "default");
    assert.equal(result.matched, null);
    assert.equal(result.floorApplied, false);
  }
});

test("a policy with no defaults resolves unmatched classes to manual", () => {
  const noDefaults = classesPolicy([["read.*", "autonomous"]], "");
  const result = resolve(noDefaults, "financial.spend");
  assert.equal(result.autonomy, "manual");
  assert.equal(result.provenance, "default");

  const emptyDefaults = classesPolicy([["read.*", "autonomous"]], "defaults:\n  channel: cli\n");
  const partial = resolve(emptyDefaults, "financial.spend");
  assert.equal(partial.autonomy, "manual");
  assert.equal(partial.provenance, "default");

  const noClasses = policy('version: "0.1"');
  const bare = resolve(noClasses, "read.web");
  assert.equal(bare.autonomy, "manual");
  assert.equal(bare.provenance, "default");
  assert.deepEqual(bare.candidates, []);
});

// ---------------------------------------------------------------------------
// Fail-closed propagation
// ---------------------------------------------------------------------------

test("a failed load makes every class manual with provenance fail-closed", () => {
  const failed = loadPolicy({ file: join(scratch, "does-not-exist.md") });
  assert.equal(failed.ok, false);

  for (const actionClass of ["read.web", "read", "financial.spend", "*", "anything.at.all"]) {
    const result = resolve(failed, actionClass);
    assert.deepEqual(result, {
      autonomy: "manual",
      provenance: "fail-closed",
      matched: null,
      approvers: null,
      limits: null,
      floorApplied: false,
      candidates: [],
    } satisfies Resolution);
  }

  // Even an irreversible action on a failed load stays a plain fail-closed
  // manual: the floor did not decide it, the missing policy did.
  const irreversible = resolve(failed, "financial.spend", { reversible: false });
  assert.equal(irreversible.provenance, "fail-closed");
  assert.equal(irreversible.floorApplied, false);
});

// ---------------------------------------------------------------------------
// Irreversibility floor (SPEC §7)
// ---------------------------------------------------------------------------

test("the floor lowers autonomous and supervised to manual", () => {
  for (const autonomy of ["autonomous", "supervised"]) {
    const loaded = classesPolicy([["a.b.c", autonomy]]);
    const result = resolve(loaded, "a.b.c", { reversible: false });
    assert.equal(result.autonomy, "manual");
    assert.equal(result.provenance, "floor");
    assert.equal(result.floorApplied, true);
    assert.equal(result.matched?.pattern, "a.b.c", "the matched rule is still reported");
    assert.equal(result.matched?.rule.autonomy, autonomy, "the rule itself is unchanged");
  }
});

test("the floor also applies over a defaulted autonomy", () => {
  const loaded = classesPolicy([["read.*", "manual"]], "defaults:\n  autonomy: autonomous\n");
  const result = resolve(loaded, "financial.spend", { reversible: false });
  assert.equal(result.autonomy, "manual");
  assert.equal(result.provenance, "floor");
  assert.equal(result.floorApplied, true);
});

test("an already-manual outcome keeps its provenance and floorApplied false", () => {
  const loaded = classesPolicy([["a.b.c", "manual"]]);
  const ruled = resolve(loaded, "a.b.c", { reversible: false });
  assert.equal(ruled.autonomy, "manual");
  assert.equal(ruled.provenance, "rule");
  assert.equal(ruled.floorApplied, false);

  const defaulted = resolve(loaded, "x.y.z", { reversible: false });
  assert.equal(defaulted.autonomy, "manual");
  assert.equal(defaulted.provenance, "default");
  assert.equal(defaulted.floorApplied, false);
});

test("reversible true or undefined leaves the resolution untouched", () => {
  const loaded = classesPolicy([["a.b.c", "autonomous"]]);
  const base = resolve(loaded, "a.b.c");
  assert.deepEqual(resolve(loaded, "a.b.c", {}), base);
  assert.deepEqual(resolve(loaded, "a.b.c", { reversible: true }), base);
  assert.equal(base.autonomy, "autonomous");
  assert.equal(base.provenance, "rule");
  assert.equal(base.floorApplied, false);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("resolve is deterministic across repeated calls", () => {
  const loaded = classesPolicy([
    ["*", "manual"],
    ["a.b.*", "autonomous"],
    ["*.b.c", "supervised"],
    ["a.*.*", "manual"],
    ["a.b.c", "supervised"],
  ]);
  for (const actionClass of ["a.b.c", "a.b.c.d", "a.x.y", "q", "financial.spend"]) {
    for (const options of [{}, { reversible: false }, { reversible: true }]) {
      const first = resolve(loaded, actionClass, options);
      const second = resolve(loaded, actionClass, options);
      assert.deepEqual(second, first, `${actionClass} ${JSON.stringify(options)}`);
    }
  }

  const canonicalFirst = resolve(CANONICAL, "read.web.page");
  const canonicalSecond = resolve(CANONICAL, "read.web.page");
  assert.deepEqual(canonicalSecond, canonicalFirst);
  assert.notEqual(canonicalSecond, canonicalFirst, "each call returns a fresh object");
});
