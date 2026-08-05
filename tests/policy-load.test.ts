/**
 * Policy loading tests (APRV-10).
 *
 * Markdown fixtures live in `schema/fixtures/policy-md/`, deliberately outside
 * the APRV-2 fixture auto-discovery: `tests/fixtures.test.ts` enumerates
 * `listSchemaNames()` (basenames of `schema/*.schema.json`) and reads only
 * `*.json`, so a `policy-md` directory of markdown is never picked up by it.
 *
 * Every failure assertion here is also a fail-closed assertion: a not-ok
 * result obligates the APRV-11 matcher to treat every class as `manual`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { readTaskFile } from "../src/core/frontmatter.js";
import {
  MAX_ALIAS_COUNT,
  POLICY_FILENAMES,
  loadPolicy,
  parseDuration,
  parseHardenedYaml,
  type PolicyLoadResult,
} from "../src/core/policy-load.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";

const REPO_ROOT = join(DEFAULT_SCHEMA_DIR, "..");
const FIXTURES = join(DEFAULT_SCHEMA_DIR, "fixtures", "policy-md");

const scratch = mkdtempSync(join(tmpdir(), "approval-md-policy-load-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function loadFixture(...segments: string[]): PolicyLoadResult {
  return loadPolicy({ file: join(FIXTURES, ...segments) });
}

function expectOk(result: PolicyLoadResult): Extract<PolicyLoadResult, { ok: true }> {
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `${result.code}: ${result.message}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectFail(
  result: PolicyLoadResult,
  code: string,
): Extract<PolicyLoadResult, { ok: false }> {
  assert.equal(result.ok, false, "expected a fail-closed result");
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, code, `message was: ${result.message}`);
  assert.ok(result.message.length > 0, "a fail-closed result must carry a reason");
  return result;
}

// ---------------------------------------------------------------------------
// Valid policy files
// ---------------------------------------------------------------------------

test("the SPEC §5.1 canonical policy loads from surrounding prose", () => {
  const result = expectOk(loadFixture("valid", "canonical.md"));
  assert.equal(result.policy.version, "0.1");
  assert.equal(result.policy.defaults?.autonomy, "manual");
  assert.equal(result.policy.defaults?.channel, "telegram");
  assert.equal(result.policy.defaults?.on_expiry, "reject");
  assert.deepEqual(result.policy.approvers?.["carter"], {
    channels: ["telegram", "cli"],
  });
  assert.deepEqual(result.policy.classes?.["read.*"], { autonomy: "autonomous" });
  assert.deepEqual(result.policy.classes?.["financial.spend"], {
    autonomy: "manual",
    approvers: ["carter"],
    limits: { per_action_usd: 25, daily_usd: 100 },
  });
  assert.deepEqual(result.policy.budgets?.["global"], {
    daily_usd: 100,
    daily_actions: 200,
  });
  assert.equal(result.policy.audit?.supervised_sample_rate, 0.1);
  assert.equal(result.policy.channels?.["web"]?.["port"], 4680);
  assert.equal(result.source.filename, "canonical.md");
  assert.equal(result.durations.approvalTtlMs, 24 * 3_600_000);
});

test("a minimal policy (version only) loads", () => {
  const result = expectOk(loadFixture("valid", "minimal.md"));
  assert.deepEqual(result.policy, { version: "0.1" });
  assert.equal(result.durations.approvalTtlMs, null, "absent ttl resolves to null");
});

test("yaml-lookalike prose, indented code, and other fences are all ignored", () => {
  const result = expectOk(loadFixture("valid", "prose-lookalikes.md"));
  assert.equal(result.policy.version, "0.1", "decoy version 9.9 must not win");
  assert.equal(result.policy.defaults?.autonomy, "manual");
  assert.equal(result.policy.defaults?.channel, "cli");
  assert.equal(result.durations.approvalTtlMs, 2 * 3_600_000);
});

test("the returned source names the file actually read", () => {
  const path = join(FIXTURES, "valid", "minimal.md");
  const result = expectOk(loadPolicy({ file: path }));
  assert.equal(result.source.path, path);
  assert.equal(result.source.filename, "minimal.md");
});

// ---------------------------------------------------------------------------
// Fail-closed paths
// ---------------------------------------------------------------------------

test("a missing file fails closed as file-missing", () => {
  expectFail(loadPolicy({ file: join(scratch, "nope", "APPROVAL.md") }), "file-missing");
});

test("a directory with no policy file fails closed as file-missing", () => {
  const dir = join(scratch, "empty-dir");
  writeFileSync(join(scratch, "stray.md"), "not a policy\n", "utf8");
  const result = expectFail(loadPolicy({ dir }), "file-missing");
  for (const filename of POLICY_FILENAMES) {
    assert.ok(result.message.includes(filename), `message should name ${filename}`);
  }
});

test("a policy file with no fenced block fails closed as no-block", () => {
  expectFail(loadFixture("invalid", "no-fence.md"), "no-block");
});

test("a bare ```yaml fence is not a policy block", () => {
  expectFail(loadFixture("invalid", "wrong-info-string.md"), "no-block");
});

test("an unterminated policy fence fails closed rather than closing at EOF", () => {
  const result = expectFail(loadFixture("invalid", "unclosed-fence.md"), "no-block");
  assert.match(result.message, /unterminated/);
});

test("two policy blocks fail closed as multiple-blocks", () => {
  const result = expectFail(loadFixture("invalid", "two-fences.md"), "multiple-blocks");
  assert.match(result.message, /exactly one/);
});

test("malformed YAML fails closed as yaml-error", () => {
  expectFail(loadFixture("invalid", "yaml-syntax-error.md"), "yaml-error");
});

test("an alias bomb fails closed as yaml-error, not as memory exhaustion", () => {
  const result = expectFail(loadFixture("invalid", "alias-bomb.md"), "yaml-error");
  assert.match(result.message, /alias/i);
  assert.ok(MAX_ALIAS_COUNT > 0 && MAX_ALIAS_COUNT <= 64, "alias bound stays small");
});

test("an unknown autonomy level fails closed as schema-invalid and carries errors", () => {
  const result = expectFail(
    loadFixture("invalid", "schema-invalid-autonomy.md"),
    "schema-invalid",
  );
  assert.ok((result.errors ?? []).length > 0, "schema failures carry validation errors");
  assert.ok(
    (result.errors ?? []).some((error) => error.path.includes("financial.spend")),
    `expected an error pointing at the bad rule, got ${JSON.stringify(result.errors)}`,
  );
});

test("duplicate mapping keys fail closed rather than last-one-wins", () => {
  const file = join(scratch, "duplicate-keys.md");
  writeFileSync(
    file,
    '```yaml approval-policy\nversion: "0.1"\ndefaults:\n  autonomy: manual\ndefaults:\n  autonomy: autonomous\n```\n',
    "utf8",
  );
  expectFail(loadPolicy({ file }), "yaml-error");
});

test("an explicitly tagged node fails closed as yaml-error", () => {
  const file = join(scratch, "tagged.md");
  writeFileSync(
    file,
    '```yaml approval-policy\nversion: !!str "0.1"\n```\n',
    "utf8",
  );
  const result = expectFail(loadPolicy({ file }), "yaml-error");
  assert.match(result.message, /tag/);
});

test("YAML 1.1 booleans are not honored: `autonomy: no` stays a string and is rejected", () => {
  const file = join(scratch, "yaml11-bool.md");
  writeFileSync(
    file,
    '```yaml approval-policy\nversion: "0.1"\ndefaults:\n  autonomy: no\n```\n',
    "utf8",
  );
  // Parses as the string "no", which is not in the closed autonomy enum.
  expectFail(loadPolicy({ file }), "schema-invalid");
});

test("a non-mapping policy block fails closed as schema-invalid", () => {
  const file = join(scratch, "sequence.md");
  writeFileSync(file, "```yaml approval-policy\n- version\n- \"0.1\"\n```\n", "utf8");
  expectFail(loadPolicy({ file }), "schema-invalid");
});

test("loadPolicy never throws for any fixture", () => {
  for (const name of [
    "no-fence.md",
    "wrong-info-string.md",
    "unclosed-fence.md",
    "two-fences.md",
    "yaml-syntax-error.md",
    "alias-bomb.md",
    "schema-invalid-autonomy.md",
  ]) {
    assert.doesNotThrow(() => loadFixture("invalid", name), `${name} threw`);
  }
});

// ---------------------------------------------------------------------------
// Filename precedence (SPEC.md §5)
// ---------------------------------------------------------------------------

test("APPROVALS.md is accepted as the fallback filename", () => {
  const result = expectOk(loadPolicy({ dir: join(FIXTURES, "precedence", "fallback-only") }));
  assert.equal(result.source.filename, "APPROVALS.md");
  assert.equal(result.policy.defaults?.channel, "from-approvals-md");
});

test("APPROVAL.md wins when both filenames exist", () => {
  const result = expectOk(loadPolicy({ dir: join(FIXTURES, "precedence", "both") }));
  assert.equal(result.source.filename, "APPROVAL.md");
  assert.equal(result.policy.defaults?.channel, "from-approval-md");
});

test("an explicit file overrides directory discovery", () => {
  const result = expectOk(
    loadPolicy({
      dir: join(FIXTURES, "precedence", "both"),
      file: join(FIXTURES, "precedence", "both", "APPROVALS.md"),
    }),
  );
  assert.equal(result.source.filename, "APPROVALS.md");
  assert.equal(result.policy.defaults?.channel, "from-approvals-md");
});

// ---------------------------------------------------------------------------
// Duration grammar (SPEC.md §5.2)
// ---------------------------------------------------------------------------

const DURATION_ACCEPTS: ReadonlyArray<readonly [string, number]> = [
  ["1ms", 1],
  ["250ms", 250],
  ["1s", 1_000],
  ["90s", 90_000],
  ["1m", 60_000],
  ["30m", 1_800_000],
  ["1h", 3_600_000],
  ["24h", 86_400_000],
  ["1d", 86_400_000],
  ["7d", 604_800_000],
  ["1w", 604_800_000],
  ["2w", 1_209_600_000],
];

for (const [text, expected] of DURATION_ACCEPTS) {
  test(`parseDuration("${text}") === ${expected}`, () => {
    assert.equal(parseDuration(text), expected);
  });
}

test("every duration unit is covered by the accept table", () => {
  const units = new Set(
    DURATION_ACCEPTS.map(([text]) => text.replace(/^[0-9]+/u, "")),
  );
  assert.deepEqual([...units].sort(), ["d", "h", "m", "ms", "s", "w"]);
});

test("a week is exactly seven days", () => {
  assert.equal(parseDuration("1w"), parseDuration("7d"));
});

const DURATION_REJECTS = [
  "",
  " ",
  "0s",
  "0",
  "0ms",
  "01h",
  "007d",
  "1.5h",
  ".5h",
  "1h30m",
  "1m30s",
  "-1h",
  "+1h",
  " 1h",
  "1h ",
  "1 h",
  "1H",
  "1MS",
  "24",
  "h",
  "ms",
  "1y",
  "1mo",
  "1hs",
  "1sm",
  "Infinity",
  "NaN",
  "1e3s",
  "1_000s",
  "24h\n",
  "\n24h",
];

for (const text of DURATION_REJECTS) {
  test(`parseDuration(${JSON.stringify(text)}) === null`, () => {
    assert.equal(parseDuration(text), null);
  });
}

// ---------------------------------------------------------------------------
// Real repository policy (smoke check; full dogfood suite is APRV-13)
// ---------------------------------------------------------------------------

test("the repository's own APPROVAL.md loads successfully", () => {
  const result = expectOk(loadPolicy({ dir: REPO_ROOT }));
  assert.equal(result.source.filename, "APPROVAL.md");
  assert.equal(result.policy.version, "0.1");
  assert.equal(result.policy.defaults?.autonomy, "manual");
  assert.equal(
    result.durations.approvalTtlMs,
    parseDuration(result.policy.defaults?.approval_ttl ?? ""),
    "resolved duration must match the policy's own string",
  );
  assert.ok(
    Object.keys(result.policy.classes ?? {}).length > 0,
    "the repo policy declares class rules",
  );
});

test("loading is deterministic: repeated loads of the same file are identical", () => {
  const first = loadPolicy({ dir: REPO_ROOT });
  const second = loadPolicy({ dir: REPO_ROOT });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// One hardened parser, two entry points (APRV-20 finding S5)
// ---------------------------------------------------------------------------

/**
 * The hardening cases, each written twice: once as a policy block read through
 * `loadPolicy`, once as task frontmatter read through `readTaskFile`.
 *
 * This is the honest proof that the two share one implementation. Before
 * APRV-20 `core/frontmatter.ts` carried its own copy of the parser settings, and
 * a fix to one was a fix to only one. Now both call `parseHardenedYaml`, and a
 * regression in either direction fails a pair of assertions here.
 */
const HARDENING_CASES: Array<[name: string, yaml: string, expected: RegExp]> = [
  [
    "an alias bomb",
    [
      'id: task-042',
      'a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]',
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]",
      "f: [*e, *e, *e, *e, *e, *e, *e, *e, *e]",
    ].join("\n"),
    /alias/iu,
  ],
  ["an explicit tag", 'id: !!str "task-042"', /tag/u],
  ["duplicate keys", "id: task-042\nid: task-043", /keys must be unique/iu],
];

for (const [name, yaml, expected] of HARDENING_CASES) {
  test(`${name} fails closed through loadPolicy AND through readTaskFile`, () => {
    const policyPath = join(scratch, `hardening-policy-${name.replace(/\s+/gu, "-")}.md`);
    writeFileSync(policyPath, ["```yaml approval-policy", yaml, "```", ""].join("\n"), "utf8");
    const policy = expectFail(loadPolicy({ file: policyPath }), "yaml-error");
    assert.match(policy.message, expected);
    assert.match(policy.message, /^policy YAML/u);

    const taskPath = join(scratch, `hardening-task-${name.replace(/\s+/gu, "-")}.md`);
    writeFileSync(taskPath, ["---", yaml, "---", "", "# Task", ""].join("\n"), "utf8");
    const task = readTaskFile(taskPath);
    assert.equal(task.ok, false, "the task file must fail closed too");
    if (task.ok) throw new Error("unreachable");
    assert.equal(task.code, "yaml-error");
    assert.match(task.message, expected);
    assert.match(task.message, /^frontmatter YAML/u);
  });
}

test("parseHardenedYaml is the shared implementation both paths call", () => {
  const ok = parseHardenedYaml("version: \"0.1\"", {
    subject: "policy YAML",
    tagContext: "a policy block",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value, { version: "0.1" });

  // YAML 1.2 core, so no 1.1-isms: `no` is the string, not `false`. The same
  // guarantee now holds for a task envelope, because it is the same call.
  const yaml11 = parseHardenedYaml("autonomy: no", {
    subject: "policy YAML",
    tagContext: "a policy block",
  });
  assert.equal(yaml11.ok, true);
  if (yaml11.ok) assert.deepEqual(yaml11.value, { autonomy: "no" });

  const tagged = parseHardenedYaml('version: !!str "0.1"', {
    subject: "frontmatter YAML",
    tagContext: "a task envelope",
  });
  assert.equal(tagged.ok, false);
  if (!tagged.ok) {
    assert.match(tagged.message, /^frontmatter YAML uses an explicit tag/u);
    assert.match(tagged.message, /a task envelope/u);
  }
});
