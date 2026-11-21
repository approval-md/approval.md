/**
 * The NEW-CALLS check (B-167N; Carter's ruling; the approval spec;
 * review-b's pre-refute folds P1-P7): scripts/overlay-recipes-newcalls.mjs
 * and its `--expected` / `--tag-corpus` run in scripts/overlay-recipes-check.mjs.
 *
 * Pure half: the expectations vocabulary (P2 matrix, card_style), one entry per
 * key (P4), the limiting rule and Carter's acceptance by name (P1), the layer
 * judge (class, decision, deny, technical card, hazard B), NEW / CHANGED (P3),
 * the schema check (P6) and the settings-cell template rewrite.
 *
 * Box half: the real `approval hook hermes` (and `approval propose`) of this
 * build, in the box layout, through the script's CLI, exit codes read alone:
 * an undeclared new call, a class mismatch, an expected card turning auto
 * (hazard B, the For Kicks order shape), a limiting entry without human:carter,
 * a stale or duplicate entry and a schema-invalid input each exit 1; a declared
 * control exits 0; a core move on an unchanged recipe is reported as
 * "changed (core move)"; a supervised-live draw is deterministic both ways.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync as copyTree, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decideInBox,
  loadCore,
  // @ts-expect-error no declaration file for the standalone check script
} from "../../scripts/overlay-recipes-check.mjs";
import {
  envelopeKey,
  envelopeKeyErrors,
  // @ts-expect-error no declaration file for the standalone box runner
} from "../../scripts/overlay-recipes-box.mjs";
import {
  acceptanceErrorsN,
  changeSet,
  decideProposeCall,
  duplicateMembers,
  judgeNewCalls,
  judgeLayer,
  limitingReasons,
  recipeKey,
  schemaErrors,
  validateExpected,
  variantBlock,
  // @ts-expect-error no declaration file for the standalone new-calls module
} from "../../scripts/overlay-recipes-newcalls.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// The box tests run a scratch copy of scripts/ (TOOL), so each can write the
// pinned expected.json copy the check compares with (security fold, P1).
const TOOL = mkdtempSync(join(tmpdir(), "new-calls-tool-"));
copyTree(join(ROOT, "scripts"), join(TOOL, "scripts"), { recursive: true });
const SCRIPT = join(TOOL, "scripts", "overlay-recipes-check.mjs");
const PINNED = join(TOOL, "scripts", "overlay-recipes", "expected.json");

type Json = Record<string, unknown>;
const READ_MATRIX = { ask: "card", autonomous: "auto", "supervised-retro": "auto", "supervised-live": "sampled", manual: "card" };
const STAY = { where: "skills/edgeos/SKILL.md:65", command: "bun skills/edgeos/scripts/events.ts --when today" };
/** A recipe only the previous release shipped: the tag corpus is never empty. */
const OTHER = { where: "skills/edgeos/SKILL.md:99", command: "bun skills/edgeos/scripts/events.ts --when 2026-10-01" };
const recipeEntry = (over: Json = {}): Json => ({
  file: "skills/edgeos/SKILL.md",
  command: STAY.command,
  class: "exec.local",
  decision: "auto",
  template: "village default",
  matrix: READ_MATRIX,
  reason: "a fixture recipe that runs on its own",
  owner: "fixture",
  ...over,
});
/** The For Kicks propose the fixture corpora carry (review M3): its file, line, class and accepted answers. */
const FK_PROPOSE = { plugin: "village-bridge", file: "plugins/village-bridge/_forkicks.py", line: 130, class: "marketplace.app.action", accepts: ["requested"] };
// supervised-live draws this key on the skip side: the daemon answers "supervised", which For Kicks refuses.
const PROPOSE_MATRIX = { ask: "card", autonomous: "refused", "supervised-retro": "refused", "supervised-live": "refused", manual: "card" };
const PAYLOAD = { appId: "forkicks", operation: "forkicks.order.confirm", preview: { appId: "forkicks", draftId: "fk-draft-0001" } };
const envelopeEntry = (over: Json = {}): Json => ({
  tool: "village",
  input: { operation: "forkicks.order.confirm", draftId: "fk-draft-0001" },
  class: "marketplace.app.read",
  decision: "auto",
  card_style: "minimal",
  template: "village default",
  matrix: READ_MATRIX,
  reason: "a purchase always asks",
  owner: "fixture",
  propose: {
    class: "marketplace.app.action",
    key: "marketplace.app.action:forkicks.order.confirm:fk-draft-0001",
    summary: "For Kicks order",
    payload: PAYLOAD,
    source: "plugins/village-bridge/_forkicks.py:127-140",
    accepts: ["requested"],
    decision: "card",
    card_style: "minimal",
    // Review S1: For Kicks goes on only with "requested"; an "autonomous" or "supervised" answer is a refused order.
    matrix: PROPOSE_MATRIX,
  },
  accepted_by: "human:carter",
  accepted_at: "2026-10-21",
  ...over,
});

// --- pure half -------------------------------------------------------------------

test("P2/P4: the vocabulary is checked, and two entries for one key fail", () => {
  assert.deepEqual(validateExpected({ entries: [recipeEntry()] }).errors, []);
  const dup = validateExpected({ entries: [recipeEntry(), recipeEntry({ command: `  ${STAY.command}  ` })] });
  assert.match(dup.errors.map((e: { message: string }) => e.message).join(";"), /a second entry for this key/u);
  assert.match(validateExpected({ entries: [recipeEntry({ matrix: undefined })] }).errors[0].message, /matrix is missing/u);
  assert.match(validateExpected({ entries: [recipeEntry({ decision: "card" })] }).errors[0].message, /card_style must be "minimal"/u);
  assert.match(validateExpected({ entries: [recipeEntry({ template: "custom" })] }).errors[0].message, /template must be "village default"/u);
  assert.match(validateExpected({ entries: [envelopeEntry({ propose: { ...(envelopeEntry().propose as Json), key: "other:x" } })] }).errors[0].message, /propose\.key must start/u);
});

test("P1: a limiting entry needs human:carter exactly and a date; an auto entry in an autonomous class needs nothing", () => {
  const manual = (cls: string) => (cls === "marketplace.app.action" ? "manual" : "autonomous");
  assert.deepEqual(limitingReasons(recipeEntry(), manual), []);
  const reasons = limitingReasons(envelopeEntry(), manual);
  assert.deepEqual(reasons, ["propose decision card", "propose class marketplace.app.action defaults to manual"]);
  assert.deepEqual(acceptanceErrorsN(envelopeEntry()), []);
  assert.match(acceptanceErrorsN(envelopeEntry({ accepted_by: "human:test" })).join(";"), /must be "human:carter"/u);
  assert.match(acceptanceErrorsN(envelopeEntry({ accepted_at: "YYYY-MM-DD" })).join(";"), /Carter fills it/u);
  assert.match(acceptanceErrorsN(envelopeEntry({ accepted_at: "2026-02-31" })).join(";"), /not a YYYY-MM-DD date/u);
  // A class whose default is manual is limiting even when the author declares auto.
  assert.deepEqual(limitingReasons(recipeEntry({ class: "marketplace.app.action" }), manual), ["hook class marketplace.app.action defaults to manual"]);
});

test("the layer judge: class, decision, hazard B, an undeclared deny, unclassified and a technical card all block", () => {
  const actual = (over: Json) => ({ classes: ["network.call"], decision: "auto", style: null, code: null, ...over });
  assert.deepEqual(judgeLayer({ class: "network.call", decision: "auto" }, actual({})), []);
  assert.match(judgeLayer({ class: "exec.local", decision: "auto" }, actual({})).join(";"), /class network\.call, declared exec\.local/u);
  assert.match(judgeLayer({ class: "network.call", decision: "card", card_style: "minimal" }, actual({})).join(";"), /hazard B/u);
  assert.match(judgeLayer({ class: "network.call", decision: "auto" }, actual({ decision: "refused", classes: [], code: "hook-unparseable" })).join(";"), /denied .* not declared/u);
  assert.deepEqual(judgeLayer({ class: "network.call", decision: "deny" }, actual({ decision: "refused", classes: [], code: "hook-unparseable" })), []);
  assert.match(judgeLayer({ class: "network.call", decision: "auto" }, actual({ classes: [] })).join(";"), /unclassified/u);
  assert.match(judgeLayer({ class: "network.call", decision: "card", card_style: "minimal" }, actual({ decision: "card", style: "technical (undeclared)" })).join(";"), /not minimal/u);
  assert.deepEqual(judgeLayer({ class: "network.call", decision: "sampled", card_style: "minimal" }, actual({ decision: "sampled", drawn: "skip", style: "technical (undeclared)" })), []);
});

test("security fold: envelope keys are unambiguous; a part carrying a separator, or not a string, has no key", () => {
  assert.equal(envelopeKey("village", { operation: "mini-app.read", appId: "dizko", tool: "search_events" }), "village#mini-app.read:dizko.search_events");
  // The old concatenation made these two one key ("village#a:b.c"); now neither the id nor the operation may carry a separator.
  assert.equal(envelopeKey("village", { operation: "a:b", tool: "c" }), null);
  assert.equal(envelopeKey("village", { operation: "a", appId: "b.c" }), null);
  assert.notEqual(envelopeKey("village", { operation: "a", appId: "b", tool: "c" }), envelopeKey("village", { operation: "a.b", tool: "c" }));
  assert.equal(envelopeKey("vil#lage", {}), null);
  assert.equal(envelopeKey("village", { operation: 1 }), null);
  assert.match(envelopeKeyErrors("village", { appId: "x:y" }).join(";"), /appId "x:y" is not a key part/u);
  assert.match(validateExpected({ entries: [envelopeEntry({ input: { operation: "forkicks.order.confirm", appId: "a.b" } })] }).errors[0].message, /no unambiguous envelope key/u);
});

test("security fold: two envelopes with one key in a corpus are a finding, never skipped", () => {
  const st = changeSet({ corpus: { recipes: [], envelopes: [{ key: "t#a", tool: "t", input: { operation: "a" }, where: "m1" }, { key: "t#a", tool: "t", input: { operation: "a" }, where: "m2" }] }, tagCorpus: { recipes: [], envelopes: [] } });
  assert.equal(st.duplicates.length, 1);
  assert.match(st.duplicates[0].why, /a second envelope with this key/u);
});

test("P3: NEW is a key absent at the previous release; CHANGED is other bytes or a core move; the rest is unchanged", () => {
  const tag = { recipes: [{ where: "a.md:1", command: "x  y" }, { where: "a.md:2", command: "z" }, { where: "a.md:3", command: "w" }], envelopes: [{ key: "t#a", tool: "t", input: { operation: "a" } }] };
  const head = {
    recipes: [{ where: "a.md:1", command: "x y" }, { where: "a.md:2", command: "z" }, { where: "a.md:9", command: "w" }, { where: "a.md:4", command: "new" }],
    envelopes: [{ key: "t#a", tool: "t", input: { operation: "a" } }, { key: "t#b", tool: "t", input: { operation: "b" } }],
  };
  const st = changeSet({ corpus: head, tagCorpus: tag, movedKeys: new Set([recipeKey("a.md", "z")]) });
  assert.equal(st.get(recipeKey("a.md", "x y")).status, "changed (bytes)");
  assert.equal(st.get(recipeKey("a.md", "z")).status, "changed (core move)");
  assert.equal(st.get(recipeKey("a.md", "w")).status, "unchanged");
  assert.equal(st.get(recipeKey("a.md", "new")).status, "new");
  assert.equal(st.get("t#a").status, "unchanged");
  assert.equal(st.get("t#b").status, "new");
});

test("P6: an input is checked against the registered schema, and an unknown keyword fails closed", () => {
  const schema = { type: "object", properties: { operation: { type: "string", enum: ["a"] }, draftId: { type: ["string", "null"] } }, required: ["operation"], additionalProperties: false };
  assert.deepEqual(schemaErrors(schema, { operation: "a", draftId: "x" }), []);
  assert.match(schemaErrors(schema, { operation: "a", url: "https://example.com/" }).join(";"), /url is not a property/u);
  assert.match(schemaErrors(schema, { operation: "b" }).join(";"), /not in its enum/u);
  assert.match(schemaErrors({ type: "object", patternProperties: {} }, {}).join(";"), /not supported here/u);
});

test("P2: a settings cell rewrites the class row (other flags kept), names the fixed secret for supervised-live, and sets the defaults for manual", () => {
  const block =
    "defaults:\n  autonomy: autonomous   # x\nchannels:\n  telegram:\n    say:\n      a.b: { quote: { x: \"X\" } }\nclasses:\n  a.b:    { autonomy: manual, agent_may_request: true }   # c\n  a.b.c: { autonomy: autonomous }\ntools:\n  - { match: t, class: a.b }\n";
  const live = variantBlock(block, ["a.b", "z.z"], "supervised-live").block;
  assert.match(live, /^ {2}a\.b: {4}\{ autonomy: supervised-live, live_rate: 0\.5, agent_may_request: true \}/mu);
  assert.match(live, /^ {2}a\.b\.c: \{ autonomy: autonomous \}/mu);
  assert.match(live, /^ {2}z\.z: \{ autonomy: supervised-live, live_rate: 0\.5 \}/mu);
  assert.match(live, /^audit:\n {2}sampling_secret_env: CLASS_DIFF_SAMPLING_SECRET$/mu);
  // The say entry of the same class under channels: is never rewritten.
  assert.match(live, /^ {6}a\.b: \{ quote: \{ x: "X" \} \}$/mu);
  assert.match(live, /^tools:\n {2}- \{ match: t, class: a\.b \}$/mu);
  assert.match(variantBlock(block, ["a.b"], "manual").block, /^ {2}autonomy: manual/mu);
  assert.match(variantBlock(block, ["a.b"], "ask").block, /^ {2}autonomy: autonomous/mu);
  assert.ok("error" in variantBlock("classes:\n", ["a"], "manual"));
});

// --- review folds: M1 (gated patterns), M3 (proposes), S1 (accepted answers), N1, N2, N3 ---------------

/** A pure judge run over a corpus with no box calls: the findings the corpus and expected.json alone decide. */
function pureFindings(corpus: Json, tag: Json, entries: unknown[], harness: { names: string[]; matches: string[] } | null = null): string[] {
  const validated = validateExpected({ entries });
  const r = judgeNewCalls({ corpus, tagCorpus: tag, validated, head: { calls: [], proposed: [] }, autonomyOf: () => "autonomous", harness }) as { findings: { key: string; message: string }[] };
  // No box ran: the per-call layer findings are the box tests' business.
  return r.findings.map((f) => `${f.key}: ${f.message}`).filter((f) => !/the box ran no such call/u.test(f));
}
const GATED_ENTRY = (over: Json = {}): Json => ({ gated: "pray", change: "added", reason: "the pray tool now reaches the hook", owner: "fixture", ...over });

test("M1: a pattern added to or removed from APPROVAL_GATED_TOOLS needs a declared entry; a declared one passes", () => {
  const tag = { recipes: [], envelopes: [], gated_tools: ["village", "old_tool"] };
  const head = { recipes: [], envelopes: [], gated_tools: ["village", "pray"] };
  const undeclared = pureFindings(head, tag, []).join("\n");
  assert.match(undeclared, /gated#pray: a gated pattern added to APPROVAL_GATED_TOOLS with no declared entry/u);
  assert.match(undeclared, /gated#old_tool: a gated pattern removed from APPROVAL_GATED_TOOLS with no declared entry/u);
  const declared = pureFindings(head, tag, [GATED_ENTRY(), GATED_ENTRY({ gated: "old_tool", change: "removed", reason: "old_tool is gone from the plugins" })]);
  assert.deepEqual(declared, []);
  assert.match(pureFindings(head, tag, [GATED_ENTRY({ change: "removed" })]).join("\n"), /declared as removed, but the pattern was added/u);
  // An entry for a pattern that did not move is stale.
  assert.match(pureFindings(tag, tag, [GATED_ENTRY()]).join("\n"), /gated#pray: stale/u);
  assert.match(validateExpected({ entries: [GATED_ENTRY({ change: "moved" })] }).errors[0].message, /change must be "added" or "removed"/u);
});

test("M1: every gated pattern reaches an envelope, a core Hermes tool or a tools line, or fails closed", () => {
  const corpus = { recipes: [], envelopes: [{ key: "village#a", tool: "village", input: { operation: "a" } }], gated_tools: ["village", "terminal", "browser_.*", "mcp__index__archive_intent", "pray"] };
  const harness = { names: ["terminal", "browser_probe"], matches: ["mcp__index__*", "browser_*"] };
  const found = pureFindings(corpus, corpus, [], harness);
  assert.deepEqual(found, ["gated#pray: a gated pattern that reaches no envelope, core Hermes tool or tools line the box runs; fail closed (review M1)"]);
});

const SITE = { plugin: "village-bridge", file: "plugins/village-bridge/_forkicks.py", line: 130, class: "marketplace.app.action", accepts: ["requested"] };
const ORDER = { key: "village#forkicks.order.confirm", tool: "village", input: { operation: "forkicks.order.confirm" } };
const propCorpus = (proposes: unknown[]): Json => ({ recipes: [], envelopes: [ORDER], gated_tools: [], tools: [{ name: "village", schema: { type: "object" } }], proposes });

test("M3: a daemon propose no entry declares fails, and so does an entry whose propose names another class or no propose", () => {
  // Review failure 2: the order entry without its propose.
  const noPropose = pureFindings(propCorpus([SITE]), propCorpus([SITE]), [envelopeEntry({ propose: undefined })]);
  assert.match(noPropose.join("\n"), /propose#plugins\/village-bridge\/_forkicks\.py:130: a daemon propose \(class marketplace\.app\.action\) that no expected\.json entry declares/u);
  assert.deepEqual(pureFindings(propCorpus([SITE]), propCorpus([SITE]), [envelopeEntry()]).filter((f) => !/LIMITING/u.test(f)), []);
  // Review failure 1: the code now proposes a read class.
  const reclassed = { ...SITE, class: "marketplace.app.read" };
  assert.match(pureFindings(propCorpus([reclassed]), propCorpus([SITE]), [envelopeEntry()]).join("\n"), /propose\.class marketplace\.app\.action, but plugins\/village-bridge\/_forkicks\.py:130 proposes marketplace\.app\.read/u);
  // The source names a line with no propose.
  assert.match(pureFindings(propCorpus([{ ...SITE, line: 300 }]), propCorpus([SITE]), [envelopeEntry()]).join("\n"), /names no daemon propose the extractor found/u);
  // A class the extractor cannot read fails closed.
  assert.match(pureFindings(propCorpus([{ ...SITE, class: null, why: "x" }]), propCorpus([]), []).join("\n"), /whose class cannot be read/u);
  // A new class template no entry declares fails; an old one is the control plane catalog's.
  const tmpl = { ...SITE, file: "plugins/village-bridge/_mini_app_card.py", line: 424, class: null, template: "marketplace.app.action.{operation}" };
  assert.match(pureFindings(propCorpus([tmpl]), propCorpus([]), []).join("\n"), /a new daemon propose class template/u);
  assert.deepEqual(pureFindings(propCorpus([tmpl]), propCorpus([tmpl]), []), []);
  assert.match(validateExpected({ entries: [envelopeEntry({ propose: { ...(envelopeEntry().propose as Json), accepts: ["requested", "maybe"] } })] }).errors[0].message, /propose\.accepts must list/u);
});

test("S1: the answers a plugin goes on with are the code's; an answer outside them is a refused call", () => {
  assert.match(pureFindings(propCorpus([{ ...SITE, accepts: ["autonomous", "requested"] }]), propCorpus([SITE]), [envelopeEntry()]).join("\n"), /propose\.accepts \["requested"\], but the code after .* goes on with \["autonomous","requested"\]/u);
  assert.match(pureFindings(propCorpus([{ ...SITE, accepts: null }]), propCorpus([SITE]), [envelopeEntry()]).join("\n"), /accepted answers cannot be read/u);
  const core = { resolve: () => ({ autonomy: "autonomous", supervision: null }), promptStyleFor: () => "minimal", promptSayFor: () => ({}) };
  const p = { key: "k", cls: "marketplace.app.action", verdict: "answered", payload: {} };
  // For Kicks: "autonomous" is refused (the order never runs without a card).
  assert.equal(decideProposeCall(core, {}, { ...p, answer: "autonomous", accepts: ["requested"] }).decision, "refused");
  assert.equal(decideProposeCall(core, {}, { ...p, answer: "autonomous", accepts: ["requested"] }).code, "plugin-refuses:autonomous");
  // Gold Stars, the inverse: "autonomous" runs, "supervised" is refused.
  assert.equal(decideProposeCall(core, {}, { ...p, answer: "autonomous", accepts: ["autonomous", "requested"] }).decision, "auto");
  assert.equal(decideProposeCall(core, {}, { ...p, answer: "supervised", accepts: ["autonomous", "requested"] }).decision, "refused");
  // No accepts (an entry from before the fold): the daemon's answer, as before.
  assert.equal(decideProposeCall(core, {}, { ...p, answer: "autonomous" }).decision, "auto");
});

test("N1, N2, N3: a future acceptance date, a member named twice, two recipes with one key and other bytes", () => {
  assert.match(acceptanceErrorsN(envelopeEntry({ accepted_at: "2999-12-31" })).join(";"), /is after today/u);
  assert.deepEqual(duplicateMembers('{"entries":[{"accepted_at":"2026-10-21","accepted_at":"YYYY-MM-DD"}]}').map((d: { name: string }) => d.name), ["accepted_at"]);
  assert.deepEqual(duplicateMembers('{"a":{"a":1},"b":[{"a":1},{"a":2}]}'), []);
  const st = changeSet({ corpus: { recipes: [{ where: "a.md:1", command: "x  y" }, { where: "a.md:2", command: "x y" }], envelopes: [] }, tagCorpus: { recipes: [], envelopes: [] } });
  assert.match(st.duplicates[0].why, /a second recipe with this normalised key and other bytes/u);
});

// --- extractor scope (3a, 3b): the envelopes come from the manifests and the plugins' own code ---------

const EXTRACT = join(ROOT, "scripts", "overlay-recipes-extract.mjs");
// The extractor runs under bun (the overlay's cron specs are TypeScript); the
// full-gate shards carry no bun, so these tests skip there, by name. The
// overlay's class-diff job runs this extractor on every overlay PR.
const NO_BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0 ? false : "bun is not on this runner (the overlay's class-diff job runs the extractor)";
const PLUGIN_PY = [
  "SCHEMA = {",
  '    "name": "village",',
  '    "parameters": {"type": "object", "properties": {',
  '        "operation": {"type": "string", "enum": ["mini-app.read", "mini-app.context.read", "mini-app.context.write", "forkicks.menu", "forkicks.order.confirm"]},',
  '        "draftId": {"type": ["string", "null"]},',
  '    }, "required": ["operation"], "additionalProperties": False},',
  "}",
  'READ_OPERATIONS = frozenset({"mini-app.read", "mini-app.context.read", "forkicks.menu"})',
  'WRITE_OPERATIONS = frozenset({"mini-app.context.write", "forkicks.order.confirm"})',
  'APP_SCOPED_OPERATIONS = frozenset({"mini-app.read", "mini-app.context.read", "mini-app.context.write"})',
  "def register(ctx):",
  '    ctx.register_tool(name="village", toolset="village", schema=SCHEMA, handler=None)',
  "",
].join("\n");

function extractFixture(over: { gated?: string | null; plugin?: string; extra?: Record<string, string> } = {}): { status: number | null; corpus: Json; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "new-calls-extract-"));
  const put = (path: string, text: string): void => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("skills/edgeos/SKILL.md", "# EdgeOS\n\n```sh\nbun skills/edgeos/scripts/events.ts --when today\n```\n");
  put("workspace/README.md", "# workspace\n");
  put("install/install_index.ts", "export const DIGEST_CRON_SPECS: { name: string; promptBody?: string }[] = [];\n");
  put("skills/approval/templates/APPROVAL.md", `# t\n\n\`\`\`yaml approval-policy\n${BLOCK}\n\`\`\`\n`);
  if (over.gated !== null) put("install/install_approval.ts", over.gated ?? 'export const APPROVAL_GATED_TOOLS = [\n  "terminal",\n  "village",\n] as const;\n');
  put("plugins/village-bridge/__init__.py", over.plugin ?? PLUGIN_PY);
  put("plugins/village-bridge/tests/test_x.py", 'ctx.register_tool(name="not-read", schema=None)\n');
  put("plugins/other/__init__.py", 'def register(ctx):\n    ctx.register_tool(name="ungated_tool", schema={"type": "object"})\n');
  put("mini-apps/forkicks/manifest.json", JSON.stringify({ manifest: 2, id: "forkicks", operations: [{ name: "forkicks.menu" }, { name: "forkicks.order.confirm" }] }));
  put("mini-apps/dizko/manifest.json", JSON.stringify({ manifest: 2, id: "dizko", operations: [{ name: "dizko.search_events", target: { tool: "search_events" } }, { name: "dizko.weird" }], data: { context: {} } }));
  put("mini-apps/legacy/manifest.json", JSON.stringify({ id: "legacy", operations: ["mini-app.read"] }));
  for (const [path, text] of Object.entries(over.extra ?? {})) put(path, text);
  const out = join(dir, "corpus.json");
  const run = spawnSync("bun", [EXTRACT, "--overlay", dir, "--sha", "a".repeat(40), "--extracted-at", "2026-10-21T00:00:00Z", "--out", out, "--with-envelopes"], { encoding: "utf8" });
  let corpus: Json = {};
  try {
    corpus = JSON.parse(readFileSync(out, "utf8")) as Json;
  } catch {
    corpus = {};
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: run.status, corpus, err: run.stderr };
}

test("3a/3b (P5, P6): manifest operations become the exact village call, relay tools one each, and the gated tool keeps its registered schema", { skip: NO_BUN }, async () => {
  // @ts-expect-error no declaration file for the standalone box runner
  const { envelopeKey } = (await import("../../scripts/overlay-recipes-box.mjs")) as { envelopeKey: (t: string, i: unknown) => string };
  const run = extractFixture();
  assert.equal(run.status, 0, run.err);
  const envelopes = run.corpus["envelopes"] as { key: string; tool: string | null; input: Json | null; unmapped?: string }[];
  assert.deepEqual(
    envelopes.map((e) => e.key),
    [
      "village#mini-app.read:dizko.search_events",
      'unmapped#["dizko","dizko.weird"]',
      "village#mini-app.context.read:dizko",
      "village#mini-app.context.write:dizko",
      "village#forkicks.menu",
      "village#forkicks.order.confirm",
      "village#mini-app.read:legacy",
    ],
  );
  // The extractor's copy of the key rule and the box runner's are the same rule.
  for (const e of envelopes.filter((x) => x.tool !== null)) assert.equal(e.key, envelopeKey(String(e.tool), e.input));
  assert.deepEqual(envelopes[0]?.input, { operation: "mini-app.read", appId: "dizko", tool: "search_events" });
  assert.match(String(envelopes[1]?.unmapped), /no village operation/u);
  const tools = run.corpus["tools"] as { name: string; file: string; schema: Json }[];
  assert.deepEqual(tools.map((t) => t.name), ["village"], "only the gated tool; tests/ never read");
  assert.equal(tools[0]?.file, "plugins/village-bridge/__init__.py:12");
  const schema = tools[0]?.schema ?? {};
  assert.deepEqual((schema["properties"] as Json)["draftId"], { type: ["string", "null"] });
  assert.deepEqual(run.corpus["tools_unread"], []);
});

test("security fold: the extractor exits 1 on a duplicate envelope key or a manifest id with no unambiguous key", { skip: NO_BUN }, () => {
  const dup = extractFixture({ extra: { "mini-apps/forkicks2/manifest.json": JSON.stringify({ manifest: 2, id: "forkicks2", operations: [{ name: "forkicks.menu" }] }) } });
  assert.equal(dup.status, 1);
  assert.match(dup.err, /duplicate envelope key village#forkicks\.menu/u);
  const dotted = extractFixture({ extra: { "mini-apps/a.b/manifest.json": JSON.stringify({ id: "a.b", operations: ["mini-app.read"] }) } });
  assert.equal(dotted.status, 1);
  assert.match(dotted.err, /no unambiguous envelope key/u);
});

test("3b fails closed: no gated list exits 1; a gated registration whose schema is not a literal is reported unread", { skip: NO_BUN }, () => {
  assert.equal(extractFixture({ gated: null }).status, 1);
  const lists = PLUGIN_PY.split("\n").filter((l) => /_OPERATIONS = /u.test(l)).join("\n");
  const computed = extractFixture({ plugin: `${lists}\ndef register(ctx):\n    ctx.register_tool(name="village", schema=make_schema())\n` });
  assert.equal(computed.status, 0, computed.err);
  assert.match(JSON.stringify(computed.corpus["tools_unread"]), /schema is not a dict literal or module constant/u);
});

test("M1: a tool registered through a local name bound from getattr(ctx, \"register_tool\"), or in a loop over a literal list, is read; an unknown name is unread", { skip: NO_BUN }, () => {
  const house = [
    'TOOL_NAME = "pray"',
    'TOOL_SCHEMA = {"name": "pray", "parameters": {"type": "object", "properties": {"text": {"type": "string"}}}}',
    'A_SCHEMA = {"type": "object"}',
    "def register(ctx):",
    '    register_tool = getattr(ctx, "register_tool", None)',
    "    try:",
    "        register_tool(name=TOOL_NAME, toolset=\"t\", schema=TOOL_SCHEMA, handler=None, description=\"d\")",
    "    except TypeError:",
    "        register_tool(name=TOOL_NAME, toolset=\"t\", schema=TOOL_SCHEMA, handler=None)",
    "    wanted = [(\"share_a\", A_SCHEMA, None), (\"share_b\", A_SCHEMA, None)]",
    "    for name, schema, handler in wanted:",
    "        register_tool(name=name, schema=schema, handler=handler)",
    "",
  ].join("\n");
  const gated = 'export const APPROVAL_GATED_TOOLS = [\n  "terminal",\n  "village",\n  "pray",\n  "share_.*",\n] as const;\n';
  const run = extractFixture({ gated, extra: { "plugins/av-events/_pray.py": house } });
  assert.equal(run.status, 0, run.err);
  const tools = run.corpus["tools"] as { name: string; file: string; schema: Json | null }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), ["pray", "share_a", "share_b", "village"]);
  assert.deepEqual(tools.find((t) => t.name === "pray")?.schema, { type: "object", properties: { text: { type: "string" } } });
  const envelopes = run.corpus["envelopes"] as { key: string }[];
  for (const k of ["pray", "share_a", "share_b"]) assert.ok(envelopes.some((e) => e.key === k), `${k} has its bare envelope`);
  assert.deepEqual(run.corpus["gated_tools"], ["terminal", "village", "pray", "share_.*"]);
  // A name read from nowhere is unread with no name, which the check fails closed on.
  const unknown = extractFixture({ gated, extra: { "plugins/av-events/_x.py": 'def register(ctx):\n    r = getattr(ctx, "register_tool")\n    r(name=compute(), schema={})\n' } });
  assert.equal(unknown.status, 0, unknown.err);
  assert.match(JSON.stringify(unknown.corpus["tools_unread"]), /name is not a literal or module constant/u);
});

test("M2: every village schema operation is a call, manifest or not; one in neither operation list is unmapped; the lists are required", { skip: NO_BUN }, () => {
  const plugin = PLUGIN_PY.replace('"forkicks.order.confirm"]}', '"forkicks.order.confirm", "wallet.transfer", "ghost.op"]}').replace('WRITE_OPERATIONS = frozenset({"mini-app.context.write", "forkicks.order.confirm"})', 'WRITE_OPERATIONS = frozenset({"mini-app.context.write", "forkicks.order.confirm", "wallet.transfer"})');
  assert.notEqual(plugin, PLUGIN_PY);
  const run = extractFixture({ plugin });
  assert.equal(run.status, 0, run.err);
  const envelopes = run.corpus["envelopes"] as { key: string; input: Json | null; rw?: string; unmapped?: string }[];
  const wallet = envelopes.find((e) => e.key === "village#wallet.transfer");
  assert.deepEqual(wallet?.input, { operation: "wallet.transfer" });
  assert.equal(wallet?.rw, "write");
  assert.match(String(envelopes.find((e) => e.key === 'unmapped#["village","ghost.op"]')?.unmapped), /neither READ_OPERATIONS nor WRITE_OPERATIONS/u);
  // A manifest operation is not repeated from the enum.
  assert.equal(envelopes.filter((e) => e.key === "village#forkicks.menu").length, 1);
  const noLists = extractFixture({ plugin: PLUGIN_PY.split("\n").filter((l) => !/_OPERATIONS = /u.test(l)).join("\n") });
  assert.equal(noLists.status, 1);
  assert.match(noLists.err, /village operation lists cannot be read/u);
});

test("M3 + S1: daemon proposes are extracted with their class (literal, constant or template) and the answers the code goes on with", { skip: NO_BUN }, () => {
  const bridge = [
    'APPROVAL_CLASS = "marketplace.app.action"',
    'PARENT = "marketplace.app.action"',
    "def member_class(operation):",
    '    return PARENT + "." + operation',
    "def order(ap, key, held):",
    '    answer = ap.propose(APPROVAL_CLASS, key, "s", held)',
    '    if not answer.ok or answer.doc.get("decision") != "requested":',
    "        return None",
    "def send(ap, key, held):",
    '    answer = ap.propose("marketplace.app.action.gold-stars.send", key, "s", held)',
    '    decision = answer.doc.get("decision")',
    '    if decision not in ("requested", "autonomous"):',
    "        return None",
    "def card(ap, operation, key, held):",
    "    answer = ap.propose(member_class(operation), key, \"s\", held)",
    '    decision = answer.doc.get("decision")',
    '    if decision == "autonomous":',
    "        return None",
    '    if decision != "requested":',
    "        return None",
    "def dyn(ap, entry):",
    '    answer = ap.propose(entry["class"], "k", "s", "{}")',
    "",
  ].join("\n");
  const run = extractFixture({ extra: { "plugins/village-bridge/_flows.py": bridge, "plugins/other/_p.py": 'def f(ap):\n    ap.propose("digest.share", "k", "s", "{}")\n' } });
  assert.equal(run.status, 0, run.err);
  const proposes = run.corpus["proposes"] as Json[];
  assert.deepEqual(
    proposes.map((p) => [p["line"], p["class"], p["template"] ?? null, p["accepts"]]),
    [
      [6, "marketplace.app.action", null, ["requested"]],
      [10, "marketplace.app.action.gold-stars.send", null, ["autonomous", "requested"]],
      [15, null, "marketplace.app.action.{operation}", ["requested"]],
      [22, null, null, null],
    ],
  );
  // A plugin with no gated tool proposes outside the hook: listed apart, never judged.
  assert.deepEqual((run.corpus["proposes_unhooked"] as Json[]).map((p) => p["class"]), ["digest.share"]);
});

test("without --with-envelopes the corpus carries no envelope keys (the pinned corpus keeps its bytes)", { skip: NO_BUN }, () => {
  const dir = mkdtempSync(join(tmpdir(), "new-calls-extract-"));
  mkdirSync(join(dir, "skills", "approval", "templates"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "install"), { recursive: true });
  writeFileSync(join(dir, "skills", "approval", "templates", "APPROVAL.md"), `\`\`\`yaml approval-policy\n${BLOCK}\n\`\`\`\n`);
  writeFileSync(join(dir, "install", "install_index.ts"), "export const DIGEST_CRON_SPECS: { name: string }[] = [];\n");
  const out = join(dir, "c.json");
  const run = spawnSync("bun", [EXTRACT, "--overlay", dir, "--sha", "a".repeat(40), "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const c = JSON.parse(readFileSync(out, "utf8")) as Json;
  assert.deepEqual(Object.keys(c), ["about", "overlay", "policy", "fill", "cwd", "recipes"]);
  rmSync(dir, { recursive: true, force: true });
});

// --- box half: the real hook of this build ------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "new-calls-test-"));
const plantedRoot = mkdtempSync(join(tmpdir(), "new-calls-core-"));
const planted = join(plantedRoot, "planted");
const boxes = mkdtempSync(join(tmpdir(), "new-calls-boxes-"));
const overlay = join(scratch, "overlay");
after(() => {
  for (const dir of [scratch, plantedRoot, boxes, TOOL]) rmSync(dir, { recursive: true, force: true });
});

const baseCorpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as Json & { policy: { block: string } };
// The pinned template carries no say entry for marketplace.app.action; the overlay's does (APPROVAL-UX P0).
const SAY = '        marketplace.app.action: { does: "do something in one of your mini-apps", quote: { appId: "App", operation: ~, preview: ~ } }\n';
const BLOCK = baseCorpus.policy.block.replace(/^( {6}say:\n)/mu, `$1${SAY}`);
const ACTION_ROW = /^(\s*)marketplace\.app\.action:(\s*)\{ autonomy: manual, agent_may_request: true \}/mu;
const HAZARD_B = BLOCK.replace(ACTION_ROW, "$1marketplace.app.action:$2{ autonomy: autonomous, agent_may_request: true }");
const VILLAGE_SCHEMA = {
  type: "object",
  properties: { operation: { type: "string", enum: ["forkicks.schedule", "forkicks.order.confirm"] }, draftId: { type: ["string", "null"] }, days: { type: "integer", minimum: 1, maximum: 31 } },
  required: ["operation"],
  additionalProperties: false,
};
const ENVELOPE = { key: "village#forkicks.order.confirm", tool: "village", input: { operation: "forkicks.order.confirm" }, where: "mini-apps/forkicks/manifest.json#forkicks.order.confirm" };

before(() => {
  assert.notEqual(BLOCK, baseCorpus.policy.block, "the say line went in");
  assert.notEqual(HAZARD_B, BLOCK, "the action row was found");
  mkdirSync(planted);
  copyTree(join(ROOT, "dist"), join(planted, "dist"), { recursive: true });
  copyTree(join(ROOT, "schema"), join(planted, "schema"), { recursive: true });
  copyTree(join(ROOT, "package.json"), join(planted, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(planted, "node_modules"));
  const plant = spawnSync(process.execPath, [join(ROOT, "tests", "fixtures", "class-diff", "plant.mjs"), planted, "PLANT_"], { encoding: "utf8" });
  assert.equal(plant.status, 0, plant.stderr);
  mkdirSync(join(overlay, "skills", "edgeos", "scripts"), { recursive: true });
  mkdirSync(join(overlay, "workspace"), { recursive: true });
  writeFileSync(join(overlay, "skills", "edgeos", "SKILL.md"), "# EdgeOS\n");
  writeFileSync(join(overlay, "skills", "edgeos", "scripts", "events.ts"), "console.log(1);\n");
});

function corpusFile(recipes: unknown[], envelopes: unknown[], block = BLOCK, extra: Json = {}): string {
  const path = join(scratch, `corpus-${String(Math.random()).slice(2)}.json`);
  const tools = [{ name: "village", plugin: "village-bridge", file: "plugins/village-bridge/__init__.py:1141", schema: VILLAGE_SCHEMA }];
  writeFileSync(path, JSON.stringify({ ...baseCorpus, policy: { ...baseCorpus.policy, block }, recipes, envelopes, tools, tools_unread: [], gated_tools: ["village"], proposes: [FK_PROPOSE], proposes_unhooked: [], ...extra }));
  return path;
}

function gate(
  entries: unknown[],
  opts: { corpus?: string; tag?: string; core?: string; diff?: boolean; env?: Record<string, string>; pinned?: string | null } = {},
): { status: number | null; md: string; err: string; json: Json } {
  const expected = join(scratch, `expected-${String(Math.random()).slice(2)}.json`);
  writeFileSync(expected, JSON.stringify({ entries }));
  if (opts.pinned === null) rmSync(PINNED, { force: true });
  else writeFileSync(PINNED, opts.pinned ?? JSON.stringify({ entries }));
  const allowlist = join(scratch, "allowlist.json");
  writeFileSync(allowlist, JSON.stringify({ entries: [] }));
  const corpus = opts.corpus ?? corpusFile([STAY], [ENVELOPE]);
  const box = mkdtempSync(join(boxes, "box-"));
  const md = join(box, "report.md");
  const jsonOut = join(box, "report.json");
  const args = [
    SCRIPT,
    "--core", opts.core ?? ROOT,
    "--corpus", corpus,
    "--allowlist", allowlist,
    "--overlay-tree", overlay,
    "--box-root", box,
    "--md", md,
    "--diff-json", jsonOut,
    "--harness-only", "terminal",
    "--expected", expected,
    "--tag-corpus", opts.tag ?? corpusFile([OTHER], []),
  ];
  if (opts.diff === true) args.push("--diff", ROOT, "--baseline-corpus", corpus);
  const run = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...opts.env } });
  let report = "";
  try {
    report = readFileSync(md, "utf8");
  } catch {
    report = "(no report)";
  }
  let json: Json = {};
  try {
    json = JSON.parse(readFileSync(jsonOut, "utf8")) as Json;
  } catch {
    json = {};
  }
  return { status: run.status, md: report, err: run.stderr, json };
}

const BOX_TIMEOUT = { timeout: 600_000 };
const PIN_REASON = /^expected\.json at .* is not the copy this approval\.md checkout pins/u;

test("control: a new recipe and the For Kicks order shape, both declared, Carter's acceptance on the limiting one: exit 0", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry()]);
  assert.equal(run.status, 0, `${run.err}\n${run.md.slice(0, 2000)}`);
  assert.match(run.md, /^NEW-CALLS PASS: .*2 new/u);
  // A clean run lists no other finding.
  assert.doesNotMatch(run.md, /## Other findings/u);
  assert.equal(run.json["failed"], false);
  assert.deepEqual(run.json["reasons"], []);
  assert.equal((run.json["newCalls"] as Json)["line"], run.md.split("\n")[0]);
  assert.match(run.md, /marketplace\.app\.action \| card \| minimal \| [0-9.]+ \| marketplace\.app\.action:forkicks\.order\.confirm:fk-draft-0001/u);
});

test("an undeclared new call (recipe or envelope) exits 1, never 'info'", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry()]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /village#forkicks\.order\.confirm`: new call with no declared outcome/u);
});

test("a class other than declared exits 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry({ class: "network.call" }), envelopeEntry()]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /class exec\.local, declared network\.call/u);
});

test("hazard B: marketplace.app.action flipped to on-its-own: the daemon answers autonomous, which For Kicks refuses (S1): exit 1", BOX_TIMEOUT, () => {
  const corpus = corpusFile([STAY], [ENVELOPE], HAZARD_B);
  const run = gate([recipeEntry(), envelopeEntry()], { corpus });
  assert.equal(run.status, 1, run.err);
  // Before the S1 fold this read "an expected card runs auto"; the order that never runs is the capability loss.
  assert.match(run.md, /propose: denied \(refused, plugin-refuses:autonomous\) and not declared so/u);
});

test("P1: the limiting entry accepted by another human, or with the date left for Carter, exits 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry({ accepted_by: "human:test" })]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /LIMITING .*must be "human:carter"/u);
  const placeholder = gate([recipeEntry(), envelopeEntry({ accepted_at: "YYYY-MM-DD" })]);
  assert.equal(placeholder.status, 1, placeholder.err);
  assert.match(placeholder.md, /Carter fills it/u);
});

test("P1 security fold: an overlay expected.json that is not approval.md's pinned copy exits 1, even with human:carter on every entry", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry()], { pinned: JSON.stringify({ entries: [recipeEntry()] }) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.err, /is not the copy this approval\.md checkout pins/u);
  // No class-diff here: the NEW-CALLS line heads the report, and it says FAIL and why (never PASS on a red run).
  const lines = run.md.split("\n");
  assert.match(lines[0] ?? "", /^NEW-CALLS FAIL 1 OTHER: /u);
  assert.equal(lines[2], "## Other findings (each fails the run): 1");
  const reasons = run.json["reasons"] as string[];
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", PIN_REASON);
  assert.equal(lines[5], reasons[0]);
  assert.ok(run.err.split("\n").includes(reasons[0] ?? ""));
  assert.equal(run.json["failed"], true);
  assert.equal((run.json["newCalls"] as Json)["line"], lines[0]);
});

test("NEW-CALLS findings and an other finding together: the heading NEW-CALLS line says FAIL n BLOCKING, 1 OTHER", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry()], { pinned: JSON.stringify({ entries: [recipeEntry(), envelopeEntry()] }) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md.split("\n")[0] ?? "", /^NEW-CALLS FAIL [1-9]\d* BLOCKING, 1 OTHER: /u);
  assert.match((run.json["reasons"] as string[])[0] ?? "", PIN_REASON);
  assert.match(run.md, /village#forkicks\.order\.confirm`: new call with no declared outcome/u);
});

test("with the class-diff, NEW-CALLS findings stay on their own line: CLASS-DIFF PASS, NEW-CALLS FAIL n BLOCKING, failed true", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry()], { diff: true });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md.split("\n")[0] ?? "", /^CLASS-DIFF PASS: /u);
  assert.match(run.md, /^NEW-CALLS FAIL [1-9]\d* BLOCKING: /mu);
  assert.doesNotMatch(run.md, /## Other findings/u);
  assert.equal(run.json["failed"], true);
  assert.deepEqual(run.json["reasons"], []);
  assert.equal(run.json["gate"], run.md.split("\n")[0]);
});

test("security fold: two corpus envelopes with one key exit 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry()], { corpus: corpusFile([STAY], [ENVELOPE, { ...ENVELOPE, where: "mini-apps/other/manifest.json#forkicks.order.confirm" }]) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /a second envelope with this key in the head corpus/u);
});

test("P4: a stale entry, or two entries for one key, exits 1", BOX_TIMEOUT, () => {
  const stale = gate([recipeEntry(), envelopeEntry(), recipeEntry({ command: "bun skills/edgeos/scripts/events.ts --when never" })]);
  assert.equal(stale.status, 1, stale.err);
  assert.match(stale.md, /stale: no recipe or envelope/u);
  const dup = gate([recipeEntry(), recipeEntry(), envelopeEntry()]);
  assert.equal(dup.status, 1, dup.err);
  assert.match(dup.md, /a second entry for this key/u);
});

test("P6: an envelope input the tool's registered schema refuses exits 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry({ input: { operation: "forkicks.order.confirm", draftId: "fk-draft-0001", url: "https://example.com/" } })]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /schema \(P6\): input: url is not a property/u);
});

test("P2: a settings matrix cell other than declared exits 1 (the recipe under ask cards; declared auto)", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry({ matrix: { ...READ_MATRIX, ask: "auto" } }), envelopeEntry()]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /matrix ask: hermes-home card, declared auto/u);
});

test("a technical card on the propose (an unlisted payload key) exits 1", BOX_TIMEOUT, () => {
  const propose = { ...(envelopeEntry().propose as Json), payload: { ...PAYLOAD, extra: "x" } };
  const run = gate([recipeEntry(), envelopeEntry({ propose })]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /technical \(unlisted-key: extra\)/u);
});

test("P3: a core move on an UNCHANGED recipe is reported as 'changed (core move)' and needs an entry", BOX_TIMEOUT, () => {
  const corpus = corpusFile([STAY], [ENVELOPE]);
  // The tag holds the same recipe bytes; only the core moves (exec.local autonomous -> supervised-retro).
  const run = gate([envelopeEntry()], { corpus, tag: corpus, core: planted, diff: true, env: { PLANT_RESOLVE: "exec.local=supervised:retro" } });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /skills\/edgeos\/SKILL\.md: bun skills\/edgeos\/scripts\/events\.ts --when today`: changed \(core move\) call with no declared outcome/u);
  // Control: the same core with no move reports it unchanged and passes.
  const still = gate([envelopeEntry()], { corpus, tag: corpus, core: planted, diff: true });
  assert.equal(still.status, 0, `${still.err}\n${still.md.slice(0, 1500)}`);
});

test("P2: a supervised-live draw is deterministic both ways (known-sample and known-skip inputs, two runs)", BOX_TIMEOUT, async () => {
  const core = await loadCore(ROOT);
  const variant = variantBlock(BLOCK, ["marketplace.app.read"], "supervised-live");
  assert.ok(!("error" in variant));
  const corpus = { ...baseCorpus, policy: { ...baseCorpus.policy, block: variant.block }, recipes: [] };
  const envelopes = [
    { key: "village#forkicks.schedule.sample", tool: "village", input: { operation: "forkicks.schedule", days: 1 } },
    { key: "village#forkicks.schedule.skip", tool: "village", input: { operation: "forkicks.schedule", days: 2 } },
  ];
  for (let i = 0; i < 2; i += 1) {
    const box = mkdtempSync(join(boxes, "live-"));
    const r = (await decideInBox({ core, corpus, overlayTree: overlay, boxRoot: box, toolsLines: [], harnessOnly: [], envelopes })) as { calls: { command: string; decision: string; drawn: string }[] };
    const by = Object.fromEntries(r.calls.map((c) => [c.command, `${c.decision}:${c.drawn}`]));
    assert.equal(by["village#forkicks.schedule.sample"], "sampled:card", `run ${String(i)}`);
    assert.equal(by["village#forkicks.schedule.skip"], "sampled:skip", `run ${String(i)}`);
  }
});

// --- review S4: four fail-closed paths, one box test each -----------------------------------------

test("S4 (M3): no pinned expected.json in the approval.md checkout exits 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry()], { pinned: null });
  assert.equal(run.status, 1, run.err);
  assert.match(run.err, /is not the copy this approval\.md checkout pins/u);
});

test("S4 (M7): a limiting entry with accepted_at \"\" exits 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry({ accepted_at: "" })]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /awaiting acceptance: accepted_at "" is not a YYYY-MM-DD date/u);
});

test("S4 (M11): a gated plugin tool registration the extractor could not read exits 1", BOX_TIMEOUT, () => {
  const corpus = corpusFile([STAY], [ENVELOPE], BLOCK, { tools_unread: [{ plugin: "av-events", file: "plugins/av-events/_x.py", line: 9, why: "name is not a literal or module constant" }] });
  const run = gate([recipeEntry(), envelopeEntry()], { corpus });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /a gated plugin tool registration the extractor cannot read/u);
});

test("S4 (M13): an entry input that drops a key of the manifest's derived call exits 1 (P5)", BOX_TIMEOUT, () => {
  // The corpus call carries a derived key beyond the envelope key's parts; the entry leaves it out.
  const derived = { ...ENVELOPE, input: { operation: "forkicks.order.confirm", draftId: "fk-draft-0001" } };
  const corpus = corpusFile([STAY], [derived]);
  const run = gate([recipeEntry(), envelopeEntry({ input: { operation: "forkicks.order.confirm" } })], { corpus });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /input does not carry the manifest's call \(draftId\) \(P5\)/u);
});
