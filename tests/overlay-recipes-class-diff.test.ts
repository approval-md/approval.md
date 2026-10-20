/**
 * The CLASS-DIFF release gate (B-167, lead ruling CLAIMS L15681 (1)), after
 * fold 1 of review-b's refute.
 *
 * Pure half: the allowlist's acceptance rule (M-3 (b): `reason: "ok"` and an
 * entry nobody accepted by name both fail), the diff's autonomy ranking (S-4:
 * autonomous -> supervised-retro, a higher live rate and auto -> card block),
 * column-scoped entries, the shadowed-tools reader (M-2 (c)), the hook verdict
 * reader, and the corpus and gate-file pins in ci.yml (M-3 (c): a pruned
 * corpus fails).
 *
 * Box half: the real `approval hook hermes` of this build against a planted
 * copy of it (tests/fixtures/class-diff/plant.mjs, review-b's one-condition
 * plants), in the box layout, through the script's CLI with exit codes read
 * alone. Each plant must FAIL the gate: P20 (core's Hermes table sends
 * send_message to policy.core), P22 (the credential pass fires from $HOME),
 * P23 (a rule keyed on APPROVAL_HERMES_HOME), P24 (a rule keyed on skills on
 * disk), P25 (a rule keyed on non-empty readRoots), P27 (read_file's class
 * goes human-only), P17 (network.call autonomous -> supervised-retro), T5 (a
 * template tools line that shadows an existing tool), and S-1 (a shipped
 * recipe the hook denies in the box, with no diff move).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync as copyTree, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  acceptanceErrors,
  diffCalls,
  entryMatches,
  gateLine,
  shadowedTools,
  // @ts-expect-error no declaration file for the standalone check script
} from "../../scripts/overlay-recipes-check.mjs";
// @ts-expect-error no declaration file for the standalone box runner
import { readVerdict } from "../../scripts/overlay-recipes-box.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "overlay-recipes-check.mjs");

interface Side {
  decision: string;
  classes?: string[];
  level?: string | null;
  rank?: number;
  code?: string | null;
}
interface Row {
  status: string;
  column: string;
  command: string;
}
interface Diff {
  rows: Row[];
  summary: { blocking: number; allowlisted: number; changed: number; new: number; removed: number; columns: Record<string, number> };
}

const ACCEPTED = { accepted_by: "human:test", accepted_at: "2026-10-20" };

// --- pure half -------------------------------------------------------------------

test("M-3 (b): a reason that says nothing, or no acceptance by name, keeps an entry from counting", () => {
  assert.deepEqual(acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough", ...ACCEPTED }), []);
  assert.match(acceptanceErrors({ file: "f", command: "c", reason: "ok", ...ACCEPTED }).join(";"), /says nothing/u);
  assert.match(acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough" }).join(";"), /awaiting acceptance/u);
  assert.match(
    acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough", accepted_by: "carter", accepted_at: "2026-10-20" }).join(";"),
    /not a human:<id>/u,
  );
  assert.match(
    acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough", ...ACCEPTED, columns: ["nowhere"] }).join(";"),
    /columns/u,
  );
});

test("entries scoped to columns match only there; '*' matches a whole file", () => {
  const e = { file: "a.md", command: "x", columns: ["hermes-home"] };
  assert.equal(entryMatches(e, "a.md", "x", "hermes-home"), true);
  assert.equal(entryMatches(e, "a.md", "x", "home"), false);
  assert.equal(entryMatches({ file: "a.md", command: "*" }, "a.md", "anything", "home"), true);
});

const call = (key: string, side: Side, column = "hermes-home") => ({
  key,
  column,
  kind: "recipe",
  where: "skills/x/SKILL.md:1",
  command: key,
  classes: side.classes ?? ["network.call"],
  ...side,
});

test("S-4: less autonomy on an existing call blocks; more autonomy is reported", () => {
  const cases: [string, Side, Side, string][] = [
    ["retro", { decision: "auto", level: "autonomous", rank: 4 }, { decision: "auto", level: "supervised-retro", rank: 3 }, "blocking"],
    ["live-up", { decision: "sampled", level: "supervised-live:0.1", rank: 1.9 }, { decision: "sampled", level: "supervised-live:1", rank: 1 }, "blocking"],
    ["card", { decision: "auto", level: "autonomous", rank: 4 }, { decision: "card", level: "manual", rank: 1 }, "blocking"],
    ["deny", { decision: "card", level: "manual", rank: 1 }, { decision: "refused", rank: -1, code: "hook-unparseable" }, "blocking"],
    ["looser", { decision: "card", level: "manual", rank: 1 }, { decision: "auto", level: "autonomous", rank: 4 }, "changed"],
    ["deny-to-deny", { decision: "human-only", rank: -1, code: "hook-class-human-only" }, { decision: "refused", rank: -1, code: "hook-unparseable" }, "changed"],
    ["same", { decision: "auto", level: "autonomous", rank: 4 }, { decision: "auto", level: "autonomous", rank: 4 }, "unchanged"],
  ];
  for (const [key, was, now, want] of cases) {
    const d = diffCalls([call(key, was)], [call(key, now)]) as Diff;
    assert.equal(d.rows[0]?.status, want, key);
  }
});

test("a blocking move is allowlisted only by an accepted entry for that call, column and (if given) flip; never by '*'", () => {
  const was = call("c", { decision: "auto", level: "autonomous", rank: 4 });
  const now = call("c", { decision: "human-only", rank: -1, code: "hook-class-human-only" });
  const entry = { file: "skills/x/SKILL.md", command: "c", reason: "accepted for a stated reason", scope: "box", ...ACCEPTED };
  const status = (entries: unknown[]) => (diffCalls([was], [now], { entries }) as Diff).rows[0]?.status;
  assert.equal(status([entry]), "allowlisted");
  assert.equal(status([{ ...entry, accepted_by: "" }]), "blocking", "unaccepted");
  assert.equal(status([{ ...entry, reason: "ok" }]), "blocking", "B1: reason ok");
  assert.equal(status([{ ...entry, columns: ["home"] }]), "blocking", "another column");
  assert.equal(status([{ ...entry, flip: { from: "card", to: "refused" } }]), "blocking", "another flip");
  assert.equal(status([{ ...entry, command: "*" }]), "blocking", "a whole-file entry never covers a move");
});

test("new and removed calls are reported, never blocking", () => {
  const a = call("a", { decision: "auto", rank: 4 });
  const b = call("b", { decision: "human-only", rank: -1 });
  const d = diffCalls([a], [b]) as Diff;
  assert.deepEqual(d.rows.map((r) => r.status).sort(), ["new", "removed"]);
  assert.equal(d.summary.blocking, 0);
});

test("M-2 (c): a tools line shadowed by an earlier one is found (first match wins)", () => {
  const lines = [
    { match: "mcp__*", class: "account.credential" },
    { match: "mcp__index__list_intents", class: "read.web" },
    { match: "web_search", class: "read.web" },
  ];
  assert.deepEqual(
    shadowedTools(lines).map((s: { match: string; by: string }) => `${s.match}<${s.by}`),
    ["mcp__index__list_intents<mcp__*"],
  );
  assert.deepEqual(shadowedTools(lines.slice(1)), []);
});

test("the hook verdict reader names the classes of every allow line the hook writes", () => {
  assert.deepEqual(readVerdict(0, "{}", "approval hook hermes: allow — autonomous: read.web (tools entry 8)\n").classes, ["read.web"]);
  assert.deepEqual(
    readVerdict(0, "{}", "approval hook hermes: allow — granted: network.call, exec.local needs no approval under this policy\n").classes,
    ["network.call", "exec.local"],
  );
  const deny = readVerdict(2, "", "hook-class-human-only: class policy.core resolves to human-only");
  assert.equal(deny.code, "hook-class-human-only");
  assert.equal(deny.verdict, "deny");
  // An exit 0 with no allow line is the CLI not running the hook at all: an error, never an allow.
  assert.equal(readVerdict(0, "", "").verdict, "error");
});

test("the GATE line names both cores by label, and FAIL with the count", () => {
  const meta = { core: "0.4.6", baselineCore: "0.4.6", coreLabel: "this build abc", baselineLabel: "npm 0.4.6", overlay: "f".repeat(40), baselineOverlay: "f".repeat(40) };
  const summary = { calls: 2, recipes: 1, harness: 1, blocking: 1, allowlisted: 0, changed: 0, new: 0, removed: 0, unchanged: 1, columns: { home: 1 } };
  assert.match(gateLine(meta, summary), /^CLASS-DIFF FAIL 1 BLOCKING: core 0\.4\.6 \(npm 0\.4\.6\) -> 0\.4\.6 \(this build abc\).*blocking by column: home 1$/u);
});

test("M-3 (c): ci.yml pins the gate's own files by sha256 and the corpus by its count, so a pruned corpus fails", () => {
  const wf = parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  const env = wf.jobs["overlay-recipes"]?.env ?? {};
  const sha = (p: string) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
  const pins: [string, string][] = [
    ["PIN_CORPUS", "scripts/overlay-recipes/corpus.json"],
    ["PIN_ALLOWLIST", "scripts/overlay-recipes/allowlist.json"],
    ["PIN_CHECK", "scripts/overlay-recipes-check.mjs"],
    ["PIN_BOX", "scripts/overlay-recipes-box.mjs"],
    ["PIN_EXTRACT", "scripts/overlay-recipes-extract.mjs"],
  ];
  for (const [name, path] of pins) assert.equal(env[name], sha(path), `${name} pins ${path}`);
  const corpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as { recipes: unknown[] };
  assert.equal(env["CORPUS_RECIPES"], String(corpus.recipes.length));
  // B2: review-b's pruned corpus (63 -> 37) matches neither pin.
  const pruned = JSON.stringify({ ...corpus, recipes: corpus.recipes.slice(0, 37) }, null, 2) + "\n";
  assert.notEqual(createHash("sha256").update(pruned).digest("hex"), env["PIN_CORPUS"]);
  assert.notEqual(String(37), env["CORPUS_RECIPES"]);
});

// --- box half: the real hook, a planted copy of this build --------------------------

const scratch = mkdtempSync(join(tmpdir(), "class-diff-test-"));
// The planted core and the boxes each get a directory of their own.
const plantedRoot = mkdtempSync(join(tmpdir(), "class-diff-core-"));
const planted = join(plantedRoot, "planted");
const boxes = mkdtempSync(join(tmpdir(), "class-diff-boxes-"));
const overlay = join(scratch, "overlay");
after(() => {
  for (const dir of [scratch, plantedRoot, boxes]) rmSync(dir, { recursive: true, force: true });
});

const baseCorpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as {
  overlay: Record<string, string>;
  policy: { source: string; block: string; substitute: Record<string, string> };
  recipes: { where: string; command: string }[];
};
const STAY = { where: "skills/edgeos/SKILL.md:65", command: "bun skills/edgeos/scripts/events.ts --when today" };
const CURL = baseCorpus.recipes.find((r) => r.where.startsWith("skills/edgeos/SKILL.md") && r.command.startsWith("curl "))!;
const PRE_FIX = { where: "skills/edgeos/SKILL.md:300", command: CURL.command.replace('--url "${EDGEOS_API_BASE', '"${EDGEOS_API_BASE') };

before(() => {
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
  writeFileSync(join(overlay, "workspace", "README.md"), "# workspace\n");
});

function corpusWith(recipes: { where: string; command: string }[], block = baseCorpus.policy.block): string {
  const path = join(scratch, `corpus-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ ...baseCorpus, policy: { ...baseCorpus.policy, block }, recipes }));
  return path;
}

/** The --url curl is denied from the Hermes home at 0.4.6 (B-162): listed there only, accepted. */
const allowlist = join(scratch, "allowlist.json");
function writeAllowlist(): void {
  writeFileSync(
    allowlist,
    JSON.stringify({
      entries: [
        { file: "skills/edgeos/SKILL.md", command: CURL.command, scope: "box", columns: ["hermes-home"], reason: "B-162 test entry: denied from the Hermes home", ...ACCEPTED },
      ],
    }),
  );
}

function gate(
  env: Record<string, string>,
  opts: { corpus?: string; baselineCorpus?: string; core?: string; concurrency?: number } = {},
): { status: number | null; out: string; err: string } {
  writeAllowlist();
  const corpus = opts.corpus ?? corpusWith([STAY, CURL]);
  const box = mkdtempSync(join(boxes, "box-"));
  const md = join(box, "report.md");
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--core", opts.core ?? planted,
      "--diff", ROOT,
      "--corpus", corpus,
      "--baseline-corpus", opts.baselineCorpus ?? corpus,
      "--allowlist", allowlist,
      "--overlay-tree", overlay,
      "--box-root", box,
      "--md", md,
      "--box-concurrency", String(opts.concurrency ?? 1),
      // Sequential hook runs (the lead's load rule) over the harness tools the plants touch.
      "--harness-only", "terminal,read_file,search_files,send_message,web_search,mcp__index__list_intents",
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  let report = "";
  try {
    report = readFileSync(md, "utf8");
  } catch {
    report = "(no report)";
  }
  return { status: run.status, out: report, err: run.stderr };
}

const BOX_TIMEOUT = { timeout: 600_000 };

test("box control: the planted copy with every plant off passes, class-diff: none", BOX_TIMEOUT, () => {
  const run = gate({});
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^CLASS-DIFF PASS: .*class-diff: none/u);
});

const plants: [string, Record<string, string>, RegExp][] = [
  ["P20 core's Hermes table: send_message -> policy.core", { PLANT_TOOL: "send_message=policy.core" }, /blocking by column: harness \d/u],
  ["P22 the credential pass also fires from $HOME", { PLANT_CLASSIFY: "home-parent" }, /blocking by column: .*home \d/u],
  ["P23 a rule keyed on APPROVAL_HERMES_HOME", { PLANT_CLASSIFY: "hosted" }, /blocking by column: .*home \d/u],
  ["P24 a rule keyed on skills present on disk", { PLANT_CLASSIFY: "skills-present" }, /blocking by column: hermes-home \d/u],
  ["P25 a rule keyed on non-empty readRoots", { PLANT_CLASSIFY: "readroots" }, /blocking by column: .*home \d/u],
  ["P27 read_file's class goes human-only", { PLANT_RESOLVE: "read.file.out_of_scope=human-only" }, /blocking by column: harness \d/u],
  ["P17 (S-4) network.call autonomous -> supervised-retro", { PLANT_RESOLVE: "network.call=supervised:retro" }, /CLASS-DIFF FAIL \d+ BLOCKING/u],
];
for (const [name, env, shape] of plants) {
  test(`plant ${name}: the gate fails (exit 1)`, BOX_TIMEOUT, () => {
    const run = gate(env);
    assert.equal(run.status, 1, `${run.err}\n${run.out.slice(0, 400)}`);
    assert.match(run.out, /^CLASS-DIFF FAIL \d+ BLOCKING/u);
    assert.match(run.out.split("\n")[0] ?? "", shape);
  });
}

test("T5 (M-2): a template line inserted first that shadows existing tools fails the gate", BOX_TIMEOUT, () => {
  const shadowing = baseCorpus.policy.block.replace(/^tools:\n/mu, 'tools:\n  - { match: "mcp__*", class: account.credential }\n');
  assert.notEqual(shadowing, baseCorpus.policy.block);
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], shadowing), baselineCorpus: corpusWith([STAY, CURL]) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /newly shadowed tools line/u);
  assert.match(run.out, /mcp__index__list_intents/u);
});

test("S-1: a shipped recipe the hook denies in the box fails with no diff move, unless listed", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, PRE_FIX]) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /class-diff: none/u);
  assert.match(run.err, /denied by the real hook in the box layout/u);
});

// --- fold 2: carded calls keep their class, autonomy and style (S-4) -----------------------

const NETWORK_ROW = /^(\s*)network\.call:(\s*)\{ autonomy: autonomous \}/mu;
const withNetwork = (row: string): string => {
  const block = baseCorpus.policy.block.replace(NETWORK_ROW, `$1network.call:$2${row}`);
  assert.notEqual(block, baseCorpus.policy.block);
  return block;
};
const LIVE_01 = withNetwork("{ autonomy: supervised-live, live_rate: 0.1 }");
const LIVE_10 = withNetwork("{ autonomy: supervised-live, live_rate: 1.0 }");
const MANUAL = withNetwork("{ autonomy: manual }");
const SAY_LINE = /^\s*network\.call:\s*\{ quote: .*$\n/mu;
const MANUAL_NO_SAY = MANUAL.replace(SAY_LINE, "");

test("S-4 control: a template whose network.call cards on both sides passes, class-diff: none", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^CLASS-DIFF PASS: .*class-diff: none/u);
});

test("S-4 plant: live_rate 0.1 -> 1.0 on network.call fails (more of its calls card)", BOX_TIMEOUT, () => {
  assert.equal(MANUAL_NO_SAY === MANUAL, false, "the say line was removed");
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], LIVE_10), baselineCorpus: corpusWith([STAY, CURL], LIVE_01) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /^CLASS-DIFF FAIL \d+ BLOCKING/u);
  assert.match(run.out, /supervised-live:0\.1.*supervised-live:1/u);
});

test("S-4 plant: supervised-live -> manual on network.call (sampled -> card) fails", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], LIVE_01) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /^CLASS-DIFF FAIL \d+ BLOCKING/u);
});

test("S-4 plant: network.call's card falls from minimal to technical (its say entry removed) fails", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /minimal card .*technical \(undeclared\) card/u);
});

test("N-6: carded calls at box concurrency 4 read no false refusal (one store per worker)", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL), concurrency: 4 });
  assert.equal(run.status, 0, run.err);
  assert.doesNotMatch(`${run.out}${run.err}`, /append-failed/u);
});
