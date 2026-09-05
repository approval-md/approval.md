/**
 * AGENTS.md import, core (APRV-64) — the parser, the class heuristic, and the
 * bytes of the draft it renders.
 *
 * Three properties are worth stating, because they are what the tests are
 * actually for:
 *
 * 1. **The output is pinned byte-for-byte.** The heuristic is a keyword table,
 *    and a keyword added for one file silently changes what every other file
 *    imports to. Pinned expected output turns that into a visible diff: a
 *    reviewer sees the class a bullet moved to, not just that a table grew.
 * 2. **The draft is a real policy.** Every draft is fed back through
 *    `loadPolicy` — the same loader `APPROVAL.md` goes through, schema and all.
 *    A generator that emits something the runtime would fail closed on would be
 *    worse than no generator, because the human confirming it would discover
 *    that only after pasting it in.
 * 3. **The CLAUDE.md fixture is a copy, not a reference.** `tests/fixtures/`
 *    holds the bytes of that section as of 2026-08-17. Reading CLAUDE.md live
 *    would mean a convention edit quietly re-pointed the pinned expectation.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLASS_TABLE,
  classifyBullet,
  importAgentsMd,
  parseAgentsMd,
  parseValuesHeadings,
  renderDraftPolicy,
  renderFencedDraft,
  renderFencedValuesDraft,
  valuesDraftOf,
} from "../src/core/agents-md.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { VALUES_INFO_STRING, loadValuesText } from "../src/core/values.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "agents-md");
const SCHEMA_DIR = join(REPO_ROOT, "schema");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-agents-md-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * Load a rendered draft the way a human would use it: wrapped in the fence that
 * makes it the machine-readable block of an APPROVAL.md.
 */
function loadDraft(yaml: string): ReturnType<typeof loadPolicy> {
  counter += 1;
  const path = join(scratch, `draft-${counter}.md`);
  writeFileSync(path, `# Draft\n\n\`\`\`yaml approval-policy\n${yaml}\`\`\`\n`, "utf8");
  return loadPolicy({ file: path, schemaDir: SCHEMA_DIR });
}

// ---------------------------------------------------------------------------
// The grammar

test("parses the three canonical sections of the CLAUDE.md fixture", () => {
  const parse = parseAgentsMd(fixture("claude-md-permissions.md"));
  assert.equal(parse.sections.allowed.length, 4);
  assert.equal(parse.sections.approvalFirst.length, 6);
  assert.equal(parse.sections.never.length, 3);
  assert.deepEqual(parse.ignored, []);
  assert.deepEqual(parse.warnings, []);
});

test("joins a wrapped bullet's continuation line into one bullet", () => {
  const parse = parseAgentsMd(fixture("claude-md-permissions.md"));
  const last = parse.sections.never.at(-1);
  assert.ok(last !== undefined);
  assert.equal(
    last.text,
    "Mutate `events.jsonl` or fabricate log entries — including in tests; test logs are built through the real append path",
  );
});

test("accepts the tolerant heading variants and reports the heading it skipped", () => {
  const parse = parseAgentsMd(fixture("tolerant-variants.md"));
  assert.deepEqual(
    parse.sections.allowed.map((bullet) => bullet.text),
    ["Read the docs directory and search the codebase", "Delete scratch files under /tmp"],
  );
  assert.deepEqual(
    parse.sections.approvalFirst.map((bullet) => bullet.text),
    ["Deleting anything under data/", "Any outbound webhook"],
  );
  assert.deepEqual(
    parse.sections.never.map((bullet) => bullet.text),
    ["Touch the deployment vault", "Feed the plants on the third floor"],
  );
  assert.deepEqual(parse.ignored, ["House style"]);
});

test("ignores bullets outside the permissions region and inside fenced blocks", () => {
  const parse = parseAgentsMd(fixture("tolerant-variants.md"));
  const all = [...parse.sections.allowed, ...parse.sections.approvalFirst, ...parse.sections.never];
  for (const bullet of all) {
    assert.ok(!bullet.text.includes("must not reach the draft"), bullet.text);
    assert.ok(!bullet.text.includes("not a permission"), bullet.text);
    assert.ok(!bullet.text.includes("Prefer commas"), bullet.text);
    assert.ok(!bullet.text.includes("also not read"), bullet.text);
  }
});

test("the bare three-heading layout needs no parent Permissions heading", () => {
  const parse = parseAgentsMd(
    ["# Agent", "", "## Allowed without prompting", "- Read files", ""].join("\n"),
  );
  assert.deepEqual(
    parse.sections.allowed.map((bullet) => bullet.text),
    ["Read files"],
  );
  assert.deepEqual(parse.warnings, []);
});

test("a file with no permissions section warns and declares nothing", () => {
  const parse = parseAgentsMd(fixture("no-permissions.md"));
  assert.deepEqual(parse.sections, { allowed: [], approvalFirst: [], never: [] });
  assert.equal(parse.warnings.length, 1);
  assert.match(parse.warnings[0] ?? "", /no permissions section found/u);
});

// ---------------------------------------------------------------------------
// The heuristic

test("the class table is ordered, first match wins", () => {
  // "any network call beyond package installs" contains "install"; network.call
  // must precede deps.add or the bullet lands on the wrong class.
  const order = CLASS_TABLE.map((entry) => entry.cls);
  assert.ok(order.indexOf("network.call") < order.indexOf("deps.add"));
  assert.ok(order.indexOf("vcs.push") < order.indexOf("vcs.push.main"));
  assert.ok(order.indexOf("policy.edit") < order.indexOf("release.publish"));
  assert.equal(order.at(-1), "read.*");
});

test("classifies the bullets a permissions section actually contains", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["Read files, list directories, search the repo", "read.*"],
    ["Edit source, tests, fixtures, and Backlog.md task files", "files.write.workspace"],
    ["Run tests, lint, typecheck, build; `node`/`tsx` scripts inside the repo", "exec.local"],
    ["Local git: status, diff, add, commit on feature branches", "vcs.commit.branch"],
    ["`git push`, merges to `main`, tag creation", "vcs.push"],
    ["merges to main", "vcs.push.main"],
    ["`npm publish`, `npm version`, any registry interaction", "release.publish"],
    ["Adding or upgrading dependencies", "deps.add"],
    ["Deleting files outside the current task's stated scope", "data.delete"],
    ["Any network call beyond package installs (API calls, webhooks, sends)", "network.call"],
    ["Edits to `APPROVAL.md`, `.approval/`, `CLAUDE.md`, or CI/release config", "policy.edit"],
    ["Touch credentials, tokens, or the vault", "account.credential"],
    ["Rewrite git history on shared branches", "vcs.history.rewrite"],
    ["Feed the plants on the third floor", null],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyBullet(text), expected, text);
  }
});

test("an unplaceable bullet is preserved, never guessed at", () => {
  const result = importAgentsMd(fixture("claude-md-permissions.md"));
  assert.deepEqual(result.unmapped, [
    {
      text: "Mutate `events.jsonl` or fabricate log entries — including in tests; test logs are built through the real append path",
      section: "never",
    },
  ]);
  const yaml = renderDraftPolicy(result, "fixture");
  assert.ok(yaml.includes("# UNMAPPED"));
  assert.ok(yaml.includes("#   (never) Mutate `events.jsonl` or fabricate log entries"));
});

test("a class claimed by two sections resolves to the stricter autonomy", () => {
  const result = importAgentsMd(fixture("tolerant-variants.md"));
  const conflicted = result.classes.find((entry) => entry.cls === "data.delete");
  assert.ok(conflicted !== undefined);
  assert.equal(conflicted.autonomy, "manual");
  assert.equal(conflicted.bullets.length, 2);
  const warning = result.warnings.find((text) => text.startsWith("class data.delete"));
  assert.ok(warning !== undefined);
  // Both bullets are named: the human resolves a contradiction in the SOURCE.
  assert.ok(warning.includes("Delete scratch files under /tmp"));
  assert.ok(warning.includes("Deleting anything under data/"));
});

test("never bullets become manual and say so, since v0.1 has no forbid level", () => {
  const result = importAgentsMd(fixture("claude-md-permissions.md"));
  const credential = result.classes.find((entry) => entry.cls === "account.credential");
  assert.ok(credential !== undefined);
  assert.equal(credential.autonomy, "manual");
  const yaml = renderDraftPolicy(result, "fixture");
  assert.ok(yaml.includes("# never: Touch credentials, tokens, or the vault"));
  assert.ok(yaml.includes("NO forbid level"));
});

test("no approvers and no channels are invented", () => {
  const yaml = renderDraftPolicy(importAgentsMd(fixture("claude-md-permissions.md")), "fixture");
  assert.ok(!/^approvers:/mu.test(yaml));
  assert.ok(!/^channels:/mu.test(yaml));
});

// ---------------------------------------------------------------------------
// Pinned bytes, and validity as a policy

for (const name of ["claude-md-permissions", "tolerant-variants", "no-permissions"] as const) {
  test(`draft for ${name} matches its pinned bytes`, () => {
    const source = `tests/fixtures/agents-md/${name}.md`;
    const rendered = renderDraftPolicy(importAgentsMd(fixture(`${name}.md`)), source);
    assert.equal(rendered, fixture(`${name}.expected.yaml`));
  });

  test(`draft for ${name} loads cleanly through loadPolicy`, () => {
    const source = `tests/fixtures/agents-md/${name}.md`;
    const result = loadDraft(renderDraftPolicy(importAgentsMd(fixture(`${name}.md`)), source));
    assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.message}`);
    assert.equal(result.policy.version, "0.1");
    assert.equal(result.policy.defaults?.autonomy, "manual");
    assert.equal(result.policy.defaults?.on_expiry, "reject");
    assert.equal(result.durations.approvalTtlMs, 24 * 60 * 60 * 1000);
    assert.equal(result.policy.approvers, undefined);
    assert.equal(result.policy.channels, undefined);
  });
}

test("the fenced form is the pinned YAML inside a policy fence", () => {
  const source = "tests/fixtures/agents-md/claude-md-permissions.md";
  const result = importAgentsMd(fixture("claude-md-permissions.md"));
  assert.equal(
    renderFencedDraft(result, source),
    `\`\`\`yaml approval-policy\n${fixture("claude-md-permissions.expected.yaml")}\`\`\`\n`,
  );
});

test("rendering is deterministic: no clock, no environment, same bytes twice", () => {
  const markdown = fixture("claude-md-permissions.md");
  const first = renderDraftPolicy(importAgentsMd(markdown), "x.md");
  const second = renderDraftPolicy(importAgentsMd(markdown), "x.md");
  assert.equal(first, second);
  // And nothing that looks like today's date leaked into the provenance line.
  assert.ok(!/\d{4}-\d{2}-\d{2}/u.test(first));
});

test("the CLAUDE.md fixture keeps its provenance note", () => {
  const text = fixture("claude-md-permissions.md");
  assert.ok(text.includes("FIXTURE PROVENANCE"));
  assert.ok(text.includes("copied verbatim on 2026-08-17"));
});

// ---------------------------------------------------------------------------
// The values draft (APRV-240)
//
// The property under test in almost every case below is a NEGATIVE one: the
// importer fills `wants` and never grades. A generator that put a bullet in
// `love:` would be writing an opinion into the one block of APPROVAL.md that
// exists to carry the human's own, and the human would find out by reading
// their own file back and seeing a feeling they never expressed.

/** Load an emitted values fence the way `APPROVAL.md` would carry it. */
function loadValuesDraft(fenced: string): ReturnType<typeof loadValuesText> {
  counter += 1;
  return loadValuesText(join(scratch, `values-${counter}.md`), `# Draft\n\n${fenced}`, {
    schemaDir: SCHEMA_DIR,
  });
}

/** Write a two-block draft to disk and read it back through `loadPolicy`. */
function loadTwoBlockDraft(markdown: string): ReturnType<typeof loadPolicy> {
  counter += 1;
  const path = join(scratch, `two-block-${counter}.md`);
  writeFileSync(path, markdown, "utf8");
  return loadPolicy({ file: path, schemaDir: SCHEMA_DIR });
}

test("the restated schema caps still match values.schema.json", () => {
  // `core/agents-md.ts` restates maxItems/maxLength rather than importing a
  // validator. This is the test that keeps the copy honest.
  const schema = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "values.schema.json"), "utf8"),
  ) as { $defs: { valueList: { maxItems: number; items: { maxLength: number } } } };
  assert.equal(schema.$defs.valueList.maxItems, 20);
  assert.equal(schema.$defs.valueList.items.maxLength, 200);
});

test("the rendered fence carries the values reader's own info string", () => {
  // `core/agents-md.ts` spells the label rather than importing it, because
  // `tests/values-inert.test.ts` lets no `src/core/` module import the values
  // reader (SPEC.md §11.1 invariant 10). This is the drift guard that pays for
  // that copy: the renderer's fence and the reader's constant, side by side.
  const fenced = renderFencedValuesDraft(parseValuesHeadings("## What I value\n\n- A\n"), "x.md");
  assert.ok(fenced.startsWith(`\`\`\`${VALUES_INFO_STRING}\n`), fenced.slice(0, 40));
});

test("recognises the four values headings at any level and normalises them", () => {
  const draft = parseValuesHeadings(fixture("values-headings.md"));
  assert.deepEqual(draft.headings, [
    "what i value",
    "what good looks like",
    "how i like to work",
    "what i want from you",
  ]);
});

test("every values bullet goes to wants, and nothing is graded", () => {
  const draft = parseValuesHeadings(fixture("values-headings.md"));
  // The parse result has one destination for bullets, by construction.
  assert.deepEqual(Object.keys(draft).sort(), ["headings", "overflow", "wants", "warnings"]);

  const fenced = renderFencedValuesDraft(draft, "fixture");
  // No emitted KEY is love/like/dislike. Comment lines start with `#`, so the
  // header's mention of them cannot satisfy this.
  assert.ok(!/^\s*(love|like|dislike):/mu.test(fenced), fenced);

  const loaded = loadValuesDraft(fenced);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  assert.ok(loaded.present);
  assert.equal(loaded.values.love, undefined);
  assert.equal(loaded.values.like, undefined);
  assert.equal(loaded.values.dislike, undefined);
  assert.deepEqual(loaded.values.wants, draft.wants);
});

test("values bullets inside a fenced block, and under other headings, are ignored", () => {
  const draft = parseValuesHeadings(fixture("values-headings.md"));
  for (const want of draft.wants) {
    assert.ok(!want.includes("inside a fenced block"), want);
    assert.ok(!want.includes("does not recognise"), want);
  }
  // And the permissions bullets of the same file did not leak in either.
  assert.ok(!draft.wants.some((want) => want.includes("Adding or upgrading dependencies")));
});

test("a wrapped values bullet is joined, and a repeat is collapsed with a note", () => {
  const draft = parseValuesHeadings(fixture("values-headings.md"));
  assert.ok(draft.wants.includes("A diff that says what it changed and why it changed it"));
  assert.equal(
    draft.wants.filter((want) => want === "Work I can check without rerunning it myself").length,
    1,
  );
  const note = draft.warnings.find((text) => text.includes("repeated values"));
  assert.ok(note !== undefined, draft.warnings.join(" | "));
});

test("a bullet over 200 characters is truncated and reported, never dropped", () => {
  const draft = parseValuesHeadings(fixture("values-headings.md"));
  const long = draft.wants.find((want) => want.startsWith("Tell me the exit code"));
  assert.ok(long !== undefined);
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith("…"));
  const note = draft.warnings.find((text) => text.includes("215 characters"));
  assert.ok(note !== undefined, draft.warnings.join(" | "));
  // Truncated, and still a valid entry: the human edits it in place.
  const loaded = loadValuesDraft(renderFencedValuesDraft(draft, "fixture"));
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
});

test("bullets past the cap of 20 are preserved as comments, not in wants", () => {
  const markdown = [
    "## What I want from you",
    "",
    ...Array.from({ length: 25 }, (_, index) => `- Want number ${String(index + 1)}`),
    "",
  ].join("\n");
  const draft = parseValuesHeadings(markdown);
  assert.equal(draft.wants.length, 20);
  assert.deepEqual(draft.overflow, [
    "Want number 21",
    "Want number 22",
    "Want number 23",
    "Want number 24",
    "Want number 25",
  ]);
  const note = draft.warnings.find((text) => text.includes("past the cap of 20"));
  assert.ok(note !== undefined, draft.warnings.join(" | "));

  const fenced = renderFencedValuesDraft(draft, "inline");
  assert.ok(fenced.includes("# OVER THE CAP:"));
  assert.ok(fenced.includes("#   Want number 25"));
  const loaded = loadValuesDraft(fenced);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  assert.ok(loaded.present);
  assert.equal(loaded.values.wants?.length, 20);
});

test("a heading with no bullets still declares itself, with an empty list", () => {
  const draft = parseValuesHeadings("## How I like to work\n\nNothing yet.\n");
  assert.deepEqual(draft.headings, ["how i like to work"]);
  assert.deepEqual(draft.wants, []);
  const fenced = renderFencedValuesDraft(draft, "inline");
  assert.ok(fenced.includes("wants: []"));
  const loaded = loadValuesDraft(fenced);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  assert.ok(loaded.present);
});

test("a source with no values heading drafts nothing at all", () => {
  for (const name of ["claude-md-permissions", "tolerant-variants", "no-permissions"] as const) {
    const result = importAgentsMd(fixture(`${name}.md`));
    assert.deepEqual(result.values.headings, [], name);
    assert.deepEqual(result.values.wants, [], name);
    assert.equal(valuesDraftOf(result, name), null, name);
    // And the policy draft is byte-identical to the one-block form: passing a
    // values draft that is not there changes nothing.
    assert.equal(
      renderDraftPolicy(result, name, result.values),
      renderDraftPolicy(result, name),
      name,
    );
    assert.equal(
      renderFencedDraft(result, name, result.values),
      renderFencedDraft(result, name),
      name,
    );
  }
});

test("the two-block draft matches its pinned bytes on both surfaces", () => {
  const source = "tests/fixtures/agents-md/values-headings.md";
  const result = importAgentsMd(fixture("values-headings.md"));
  const expected = fixture("values-headings.expected.md");
  assert.equal(renderDraftPolicy(result, source, result.values), expected);
  // `--out` and stdout agree: one draft, one set of bytes, two ways to get it.
  assert.equal(renderFencedDraft(result, source, result.values), expected);
  // And `--json`'s `values_draft` is exactly the tail of it: the same fence,
  // reachable without parsing the two-block form back apart.
  const valuesFence = valuesDraftOf(result, source);
  assert.ok(valuesFence !== null);
  assert.ok(valuesFence.startsWith("```yaml approval-values\n"));
  assert.ok(expected.endsWith(valuesFence), valuesFence);
});

test("the two-block draft loads as a policy AND as a values block", () => {
  const source = "tests/fixtures/agents-md/values-headings.md";
  const result = importAgentsMd(fixture("values-headings.md"));
  const markdown = renderDraftPolicy(result, source, result.values);

  const policy = loadTwoBlockDraft(markdown);
  assert.ok(policy.ok, policy.ok ? "" : `${policy.code}: ${policy.message}`);
  assert.equal(policy.policy.version, "0.1");
  assert.equal(policy.policy.defaults?.autonomy, "manual");

  const values = loadValuesText(join(scratch, "two-block.md"), markdown, {
    schemaDir: SCHEMA_DIR,
  });
  assert.ok(values.ok, values.ok ? "" : values.message);
  assert.ok(values.present);
  assert.equal(values.values.version, 1);
  assert.deepEqual(values.values.wants, result.values.wants);
});

test("the values warnings reach the import result, and never the classes", () => {
  const result = importAgentsMd(fixture("values-headings.md"));
  assert.ok(result.warnings.some((text) => text.includes("repeated values")));
  assert.deepEqual(
    result.classes.map((entry) => entry.cls),
    ["read.*", "deps.add"],
  );
  assert.deepEqual(result.unmapped, []);
});

test("the values draft is deterministic: same bytes twice", () => {
  const markdown = fixture("values-headings.md");
  const first = renderFencedValuesDraft(parseValuesHeadings(markdown), "x.md");
  const second = renderFencedValuesDraft(parseValuesHeadings(markdown), "x.md");
  assert.equal(first, second);
  assert.ok(!/\d{4}-\d{2}-\d{2}/u.test(first));
});
