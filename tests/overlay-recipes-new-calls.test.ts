/**
 * The NEW-CALLS check (B-167N; Carter L17349, L17375; spec approval L17350;
 * review-b's pre-refute folds P1-P7, L17356): scripts/overlay-recipes-newcalls.mjs
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
  acceptanceErrorsN,
  changeSet,
  judgeLayer,
  limitingReasons,
  recipeKey,
  schemaErrors,
  validateExpected,
  variantBlock,
  // @ts-expect-error no declaration file for the standalone new-calls module
} from "../../scripts/overlay-recipes-newcalls.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "overlay-recipes-check.mjs");

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
    decision: "card",
    card_style: "minimal",
    matrix: { ask: "card", autonomous: "auto", "supervised-retro": "auto", "supervised-live": "sampled", manual: "card" },
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

// --- extractor scope (3a, 3b): the envelopes come from the manifests and the plugins' own code ---------

const EXTRACT = join(ROOT, "scripts", "overlay-recipes-extract.mjs");
const PLUGIN_PY = [
  "SCHEMA = {",
  '    "name": "village",',
  '    "parameters": {"type": "object", "properties": {',
  '        "operation": {"type": "string", "enum": ["mini-app.read", "mini-app.context.read", "mini-app.context.write", "forkicks.menu", "forkicks.order.confirm"]},',
  '        "draftId": {"type": ["string", "null"]},',
  '    }, "required": ["operation"], "additionalProperties": False},',
  "}",
  "def register(ctx):",
  '    ctx.register_tool(name="village", toolset="village", schema=SCHEMA, handler=None)',
  "",
].join("\n");

function extractFixture(over: { gated?: string | null; plugin?: string } = {}): { status: number | null; corpus: Json; err: string } {
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

test("3a/3b (P5, P6): manifest operations become the exact village call, relay tools one each, and the gated tool keeps its registered schema", async () => {
  // @ts-expect-error no declaration file for the standalone box runner
  const { envelopeKey } = (await import("../../scripts/overlay-recipes-box.mjs")) as { envelopeKey: (t: string, i: unknown) => string };
  const run = extractFixture();
  assert.equal(run.status, 0, run.err);
  const envelopes = run.corpus["envelopes"] as { key: string; tool: string | null; input: Json | null; unmapped?: string }[];
  assert.deepEqual(
    envelopes.map((e) => e.key),
    [
      "village#mini-app.read:dizko.search_events",
      "unmapped#dizko.dizko.weird",
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
  assert.equal(tools[0]?.file, "plugins/village-bridge/__init__.py:9");
  const schema = tools[0]?.schema ?? {};
  assert.deepEqual((schema["properties"] as Json)["draftId"], { type: ["string", "null"] });
  assert.deepEqual(run.corpus["tools_unread"], []);
});

test("3b fails closed: no gated list exits 1; a gated registration whose schema is not a literal is reported unread", () => {
  assert.equal(extractFixture({ gated: null }).status, 1);
  const computed = extractFixture({ plugin: 'def register(ctx):\n    ctx.register_tool(name="village", schema=make_schema())\n' });
  assert.equal(computed.status, 0, computed.err);
  assert.match(JSON.stringify(computed.corpus["tools_unread"]), /schema is not a module-level dict literal/u);
});

test("without --with-envelopes the corpus carries no envelope keys (the pinned corpus keeps its bytes)", () => {
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
  for (const dir of [scratch, plantedRoot, boxes]) rmSync(dir, { recursive: true, force: true });
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

function corpusFile(recipes: unknown[], envelopes: unknown[], block = BLOCK): string {
  const path = join(scratch, `corpus-${String(Math.random()).slice(2)}.json`);
  const tools = [{ name: "village", plugin: "village-bridge", file: "plugins/village-bridge/__init__.py:1141", schema: VILLAGE_SCHEMA }];
  writeFileSync(path, JSON.stringify({ ...baseCorpus, policy: { ...baseCorpus.policy, block }, recipes, envelopes, tools, tools_unread: [], gated_tools: ["village"] }));
  return path;
}

function gate(
  entries: unknown[],
  opts: { corpus?: string; tag?: string; core?: string; diff?: boolean; env?: Record<string, string> } = {},
): { status: number | null; md: string; err: string } {
  const expected = join(scratch, `expected-${String(Math.random()).slice(2)}.json`);
  writeFileSync(expected, JSON.stringify({ entries }));
  const allowlist = join(scratch, "allowlist.json");
  writeFileSync(allowlist, JSON.stringify({ entries: [] }));
  const corpus = opts.corpus ?? corpusFile([STAY], [ENVELOPE]);
  const box = mkdtempSync(join(boxes, "box-"));
  const md = join(box, "report.md");
  const args = [
    SCRIPT,
    "--core", opts.core ?? ROOT,
    "--corpus", corpus,
    "--allowlist", allowlist,
    "--overlay-tree", overlay,
    "--box-root", box,
    "--md", md,
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
  return { status: run.status, md: report, err: run.stderr };
}

const BOX_TIMEOUT = { timeout: 600_000 };

test("control: a new recipe and the For Kicks order shape, both declared, Carter's acceptance on the limiting one: exit 0", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry()]);
  assert.equal(run.status, 0, `${run.err}\n${run.md.slice(0, 2000)}`);
  assert.match(run.md, /^NEW-CALLS PASS: .*2 new/mu);
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

test("hazard B: marketplace.app.action flipped to on-its-own makes the order's expected card run auto: exit 1", BOX_TIMEOUT, () => {
  const corpus = corpusFile([STAY], [ENVELOPE], HAZARD_B);
  const run = gate([recipeEntry(), envelopeEntry()], { corpus });
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /propose: an expected card runs auto \(hazard B/u);
});

test("P1: the limiting entry accepted by another human, or with the date left for Carter, exits 1", BOX_TIMEOUT, () => {
  const run = gate([recipeEntry(), envelopeEntry({ accepted_by: "human:test" })]);
  assert.equal(run.status, 1, run.err);
  assert.match(run.md, /LIMITING .*must be "human:carter"/u);
  const placeholder = gate([recipeEntry(), envelopeEntry({ accepted_at: "YYYY-MM-DD" })]);
  assert.equal(placeholder.status, 1, placeholder.err);
  assert.match(placeholder.md, /Carter fills it/u);
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
