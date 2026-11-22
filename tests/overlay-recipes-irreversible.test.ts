/**
 * The NEW-CALLS check learns core's `approval propose --irreversible`
 * (APRV-537, the For Kicks card build; lead ruling "RULED build-4's For Kicks
 * page 9a55e501", point 3).
 *
 * With the flag, core resolves a propose's class with SPEC.md §7's floor, so
 * every cell but human-only answers `requested` and core's renderer draws the
 * minimal card (autonomy manual). The check must read it the same way, or it
 * calls the floored card "technical (anomaly)" and supervised-live "sampled".
 *
 * What is pinned:
 *   1. `validateExpected` takes `propose.irreversible` (true or false) and
 *      refuses anything else;
 *   2. `decideProposeCall`, under #679's own five cells of the village default
 *      template, reads the For Kicks propose answered `requested` as a card in
 *      the minimal style in every cell with the flag, and as today without it;
 *   3. `limitingReasons` names the floor for an irreversible propose of a class
 *      the template runs on its own, and is unchanged for the For Kicks entry;
 *   4. `judgeNewCalls` holds the entry's flag to the code's (the extractor's
 *      `irreversible` at the propose site), and fails closed on an unread one;
 *   5. the box passes `--irreversible` to `approval propose` exactly when the
 *      entry says so (argv read through a recording core), and a core that
 *      does not know the flag reads as a refused propose, never an error.
 *
 * The For Kicks entry of expected.json is read, never changed: it changes in
 * the overlay PR that lands the card.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadCore,
  loadCorpusPolicy,
  newCallJobs,
  policyTextOf,
  templateAutonomyOf,
  // @ts-expect-error no declaration file for the standalone check script
} from "../../scripts/overlay-recipes-check.mjs";
import {
  runBox,
  // @ts-expect-error no declaration file for the standalone box runner
} from "../../scripts/overlay-recipes-box.mjs";
import {
  CELLS,
  decideProposeCall,
  judgeNewCalls,
  limitingReasons,
  validateExpected,
  variantBlock,
  // @ts-expect-error no declaration file for the standalone new-calls module
} from "../../scripts/overlay-recipes-newcalls.mjs";

type Json = Record<string, unknown>;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "irreversible-check-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const pinned = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as Json & { policy: Json & { block: string } };
// The pinned template carries no say entry for marketplace.app.action; the overlay's does (APPROVAL-UX P0), and
// the For Kicks entry's payload keys are the overlay template's quote (App, the rest kept off the card).
const SAY = '        marketplace.app.action: { does: "do something in one of your mini-apps", quote: { appId: "App", operation: ~, preview: ~ } }\n';
const corpus = { ...pinned, policy: { ...pinned.policy, block: pinned.policy.block.replace(/^( {6}say:\n)/mu, `$1${SAY}`) } };
assert.notEqual(corpus.policy.block, pinned.policy.block, "the say line went in");
const expected = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "expected.json"), "utf8")) as { entries: Json[] };
const FK = expected.entries.find((e) => (e["input"] as Json | undefined)?.["operation"] === "forkicks.order.confirm") as Json & { propose: Json & { class: string; payload: Json; source: string; accepts: string[] } };
assert.ok(FK !== undefined, "#679's expected.json has the For Kicks entry");

const core = await loadCore(ROOT);

// ---------------------------------------------------------------------------
// 1. The field
// ---------------------------------------------------------------------------

test("validateExpected takes propose.irreversible true or false, and refuses anything else", () => {
  const errorsOf = (irreversible: unknown): string[] => {
    const entry = structuredClone(FK) as Json & { propose: Json };
    if (irreversible === undefined) delete entry.propose["irreversible"];
    else entry.propose["irreversible"] = irreversible;
    return (validateExpected({ entries: [entry] }).errors as { message: string }[]).map((e) => e.message);
  };
  assert.deepEqual(errorsOf(undefined), []);
  assert.deepEqual(errorsOf(true), []);
  assert.deepEqual(errorsOf(false), []);
  for (const bad of ["true", 1, null]) {
    assert.match(errorsOf(bad).join("\n"), /propose\.irreversible must be true or false/u, JSON.stringify(bad));
  }
  // The For Kicks entry is as #679 has it: no flag yet.
  assert.equal(Object.prototype.hasOwnProperty.call(FK.propose, "irreversible"), false);
});

// ---------------------------------------------------------------------------
// 2. The decision and the card style, per cell
// ---------------------------------------------------------------------------

function cellLoad(cell: string): unknown {
  const variant = variantBlock(corpus.policy.block, [FK["class"], FK.propose.class], cell) as { block?: string; error?: string };
  assert.equal(variant.error, undefined);
  const load = loadCorpusPolicy(core.loadPolicyText, { ...corpus, policy: { ...corpus.policy, block: variant.block } }) as { ok: boolean };
  assert.equal(load.ok, true);
  return load;
}

const decided = (cell: string, irreversible: boolean | undefined): string => {
  const d = decideProposeCall(core, cellLoad(cell), {
    key: "fk#propose",
    where: FK.propose.source,
    command: "fk#propose",
    cls: FK.propose.class,
    payload: FK.propose.payload,
    accepts: FK.propose.accepts,
    verdict: "answered",
    answer: "requested",
    ...(irreversible === undefined ? {} : { irreversible }),
  }) as { decision: string; drawn: string | null; style: string | null };
  return `${d.decision}${d.drawn ? `:${d.drawn}` : ""}${d.style ? `, ${d.style}` : ""}`;
};

test("with irreversible, the For Kicks propose answered requested is a minimal card in all five cells", () => {
  const out: Record<string, string> = {};
  for (const cell of CELLS as string[]) out[cell] = decided(cell, true);
  assert.deepEqual(out, {
    ask: "card, minimal",
    autonomous: "card, minimal",
    "supervised-retro": "card, minimal",
    "supervised-live": "card, minimal",
    manual: "card, minimal",
  });
});

test("without it, the same answer reads as it did before the floor (the page's decide679-floor-answers.json)", () => {
  const today: Record<string, string> = {};
  for (const cell of CELLS as string[]) today[cell] = decided(cell, undefined);
  const absent: Record<string, string> = { ...today };
  assert.deepEqual(today, {
    ask: "card, minimal",
    autonomous: "card, technical (anomaly: autonomy not manual)",
    "supervised-retro": "card, technical (anomaly: autonomy not manual)",
    "supervised-live": "sampled:card, technical (anomaly: autonomy not manual)",
    manual: "card, minimal",
  });
  // false is the same as absent.
  for (const cell of CELLS as string[]) assert.equal(decided(cell, false), absent[cell], cell);
});

test("the floor changes nothing for a refused or plugin-refused answer", () => {
  const load = cellLoad("autonomous");
  const base = { key: "k", where: "w", command: "k", cls: FK.propose.class, payload: FK.propose.payload, accepts: ["requested"], irreversible: true };
  assert.equal((decideProposeCall(core, load, { ...base, verdict: "refused", code: "usage" }) as { decision: string }).decision, "refused");
  const autonomous = decideProposeCall(core, load, { ...base, verdict: "answered", answer: "autonomous" }) as { decision: string; code: string };
  assert.deepEqual([autonomous.decision, autonomous.code], ["refused", "plugin-refuses:autonomous"]);
});

// ---------------------------------------------------------------------------
// 3. P1, limiting
// ---------------------------------------------------------------------------

test("limitingReasons names the floor for an irreversible propose of a class the template runs on its own", () => {
  // The village default itself, through the check's own autonomyOf.
  const autonomyOf = templateAutonomyOf(core, loadCorpusPolicy(core.loadPolicyText, corpus)) as (cls: string, options?: { reversible?: boolean }) => string;
  assert.equal(autonomyOf("marketplace.app.action.gold-stars.send"), "autonomous");
  assert.equal(autonomyOf("marketplace.app.action.gold-stars.send", { reversible: false }), "manual");
  // The For Kicks entry: unchanged by this build (the page's limiting-679.json).
  assert.deepEqual(limitingReasons(FK, autonomyOf), ["propose decision card", "propose class marketplace.app.action defaults to manual"]);
  const gold = { propose: { class: "marketplace.app.action.gold-stars.send", decision: "auto", source: "plugins/village-bridge/_gold.py:10" } };
  assert.deepEqual(limitingReasons(gold, autonomyOf), []);
  assert.deepEqual(limitingReasons({ propose: { ...gold.propose, irreversible: true } }, autonomyOf), [
    "propose class marketplace.app.action.gold-stars.send is floored to manual (irreversible, SPEC section 7)",
  ]);
});

test("the box jobs carry each entry's propose.irreversible, and only true reads as the flag", () => {
  // Three propose-only entries (one key each: the source line differs).
  const entries = [true, false, undefined].map((flag, i) => {
    const e = structuredClone(FK) as Json & { propose: Json };
    for (const k of ["tool", "input", "class", "decision", "card_style", "matrix"]) delete e[k];
    e.propose["source"] = `plugins/village-bridge/_forkicks.py:${String(400 + i)}`;
    if (flag === undefined) delete e.propose["irreversible"];
    else e.propose["irreversible"] = flag;
    return e;
  });
  const validated = validateExpected({ entries });
  assert.deepEqual(validated.errors, []);
  const jobs = newCallJobs({ envelopes: [] }, validated) as { proposals: { irreversible: boolean }[] };
  assert.deepEqual(jobs.proposals.map((p) => p.irreversible), [true, false, false]);
});

// ---------------------------------------------------------------------------
// 4. The entry's flag against the code's
// ---------------------------------------------------------------------------

const SOURCE = "plugins/village-bridge/_order.py:12";
const site = (irreversible: unknown): Json => ({
  plugin: "village-bridge",
  file: "plugins/village-bridge/_order.py",
  line: 12,
  class: "marketplace.app.action",
  accepts: ["requested"],
  gated_plugin: false,
  ...(irreversible === "absent" ? {} : { irreversible }),
  ...(irreversible === null ? { irreversible_why: "irreversible= is not a literal True or False or a module constant" } : {}),
});
const onlyEntry = (irreversible?: boolean): Json => ({
  propose: {
    class: "marketplace.app.action",
    key: "marketplace.app.action:order-1",
    summary: "An order",
    payload: { order: "1 x Cold brew" },
    source: SOURCE,
    accepts: ["requested"],
    decision: "card",
    card_style: "minimal",
    matrix: { ask: "card", autonomous: "card", "supervised-retro": "card", "supervised-live": "card", manual: "card" },
    ...(irreversible === undefined ? {} : { irreversible }),
  },
  template: "village default",
  reason: "a purchase always asks a person",
  owner: "the card build",
  accepted_by: "human:carter",
  accepted_at: "2026-11-22",
});

function irreversibleFindings(siteFlag: unknown, entryFlag?: boolean): string[] {
  const c = { recipes: [], envelopes: [], gated_tools: [], tools: [], proposes: [site(siteFlag)], class_writers: [] };
  const result = judgeNewCalls({
    corpus: c,
    tagCorpus: c,
    validated: validateExpected({ entries: [onlyEntry(entryFlag)] }),
    head: { calls: [], proposed: [] },
    cells: {},
    autonomyOf: () => "manual",
  }) as { findings: { message: string }[] };
  return result.findings.map((f) => f.message).filter((m) => /APRV-537/u.test(m));
}

test("the check holds propose.irreversible to the code, and fails closed on an unread flag", () => {
  assert.deepEqual(irreversibleFindings(true, true), []);
  assert.deepEqual(irreversibleFindings(false, undefined), []);
  assert.deepEqual(irreversibleFindings(false, false), []);
  // A corpus from an extractor before the field: no member reads as no flag.
  assert.deepEqual(irreversibleFindings("absent", undefined), []);
  assert.match(irreversibleFindings(false, true).join("\n"), /propose\.irreversible true, but the propose at plugins\/village-bridge\/_order\.py:12 does not pass irreversible=True/u);
  assert.match(irreversibleFindings(true, undefined).join("\n"), /propose\.irreversible false, but the propose at plugins\/village-bridge\/_order\.py:12 passes irreversible=True/u);
  assert.match(irreversibleFindings("absent", true).join("\n"), /does not pass irreversible=True/u);
  assert.match(irreversibleFindings(null, true).join("\n"), /passes irreversible in a form the extractor cannot read .*; fail closed/u);
  assert.match(irreversibleFindings(null, undefined).join("\n"), /fail closed/u);
});

// ---------------------------------------------------------------------------
// 5. The box passes the flag
// ---------------------------------------------------------------------------

/**
 * A core root whose CLI records each `propose` argv and then runs this
 * checkout's real CLI with the same arguments, so the answer is the real one.
 */
function recordingCore(): { root: string; log: string } {
  const root = join(scratch, `recording-${String(Math.random()).slice(2)}`);
  mkdirSync(join(root, "dist", "src", "cli"), { recursive: true });
  const log = join(root, "argv.jsonl");
  const real = join(ROOT, "dist", "src", "cli", "main.js");
  writeFileSync(
    join(root, "dist", "src", "cli", "main.js"),
    [
      "const { spawnSync } = require(\"node:child_process\");",
      "const { appendFileSync } = require(\"node:fs\");",
      "const args = process.argv.slice(2);",
      `if (args[0] === "propose") appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(real)}, ...args], { stdio: "inherit" });`,
      "process.exit(r.status === null ? 1 : r.status);",
      "",
    ].join("\n"),
  );
  return { root, log };
}

test("the box passes --irreversible exactly when the entry says so, and reads a core without it as a refusal", { timeout: 120_000 }, async () => {
  const { root, log } = recordingCore();
  const boxRoot = join(scratch, "boxes");
  mkdirSync(boxRoot, { recursive: true });
  const proposal = (name: string, irreversible: boolean): Json => ({
    key: `${name}#propose`,
    cls: FK.propose.class,
    actionKey: `${FK.propose.class}:${name}`,
    summary: "For Kicks order",
    payload: FK.propose.payload,
    where: FK.propose.source,
    accepts: FK.propose.accepts,
    irreversible,
  });
  const ran = (await runBox({
    coreRoot: root,
    corpus: { ...corpus, recipes: [] },
    policyText: policyTextOf(corpus),
    overlayTree: undefined,
    boxRoot,
    toolsLines: [],
    harnessOnly: [],
    proposals: [proposal("plain", false), proposal("floored", true)],
  })) as { proposed?: (Json & { irreversible: boolean; verdict: string; answer: string | null; code: string | null })[]; error?: string };
  assert.equal(ran.error, undefined, ran.error ?? "");
  const argv = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(argv.length, 2);
  assert.equal(argv[0]?.includes("--irreversible"), false);
  assert.equal(argv[1]?.includes("--irreversible"), true);
  const [plain, floored] = ran.proposed ?? [];
  assert.deepEqual([plain?.irreversible, floored?.irreversible], [false, true]);
  // The village default runs marketplace.app.action manual: the plain one is a card.
  assert.deepEqual([plain?.verdict, plain?.answer], ["answered", "requested"]);
  // A core with the flag answers requested; one without it refuses it as a usage error.
  // Either way the check reads an outcome, never an error.
  const known = floored?.verdict === "answered" ? floored.answer === "requested" : floored?.verdict === "refused" && floored.code === "usage";
  assert.equal(known, true, JSON.stringify(floored));
  const load = loadCorpusPolicy(core.loadPolicyText, corpus);
  const d = decideProposeCall(core, load, floored) as { decision: string; style: string | null };
  assert.ok(d.decision === "card" ? d.style === "minimal" : d.decision === "refused", JSON.stringify(d));
});
