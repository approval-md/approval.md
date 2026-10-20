/**
 * The CLASS-DIFF release gate (B-167, lead ruling CLAIMS L15681 (1)).
 *
 * `scripts/overlay-recipes-check.mjs --diff <baseline core>` classifies the
 * overlay's shipped calls at a baseline core and at this one, and fails when
 * an existing call moves from running (auto, sampled, card) to a deny
 * (human-only, refused). Three fixtures, as the ruling asks:
 *
 * - a recipe that FLIPS (auto -> human-only) must fail;
 * - a recipe that STAYS must pass, with "class-diff: none";
 * - a NEW recipe is reported as new and does not fail.
 *
 * The pure half runs `decideCorpus` and `diffCalls` with a stand-in baseline
 * core that answers as 0.4.5 did for the pre-#427 EdgeOS shape (network.call),
 * against this checkout's real core (policy.core by fetch-output-unknown): the
 * EDGEOS-BLOCK move itself. The CLI half spawns the script with fixture
 * corpora and reads its exit code alone; there the flip comes from the
 * template side (a corpus whose policy reserves network.call), since CI has
 * one built core.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook } from "../src/cli/hook.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { harnessLaunchNeedsRule, resolve } from "../src/core/policy-match.js";
import { promptSayFor, promptStyleFor } from "../src/core/prompt-layout.js";
// @ts-expect-error no declaration file for the standalone check script
import { decideCorpus, diffCalls, gateLine } from "../../scripts/overlay-recipes-check.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "overlay-recipes-check.mjs");

interface Recipe {
  where: string;
  command: string;
}
interface Corpus {
  overlay: { repo: string; sha: string; extracted_at: string; method: string };
  policy: { source: string; substitute: Record<string, string>; block: string };
  fill: { pattern: string; value: string }[];
  cwd: string;
  recipes: Recipe[];
}
interface Side {
  classes: string[];
  decision: string;
  code: string | null;
  style: string | null;
}
interface Row {
  status: string;
  kind: string;
  where: string;
  command: string;
  old: Side | null;
  new: Side | null;
}
interface Diff {
  rows: Row[];
  summary: { calls: number; harness: number; blocking: number; unchanged: number; new: number };
}

const corpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as Corpus;

const FIXED_URL = 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"';
const PRE_FIX_URL = 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"';
const NEW_RECIPE = "bun skills/edgeos/scripts/events.ts --when tomorrow";

const STAYS: Recipe = { where: "skills/edgeos/SKILL.md:10", command: FIXED_URL };
const FLIPS: Recipe = { where: "skills/edgeos/SKILL.md:20", command: PRE_FIX_URL };
const NEW: Recipe = { where: "skills/edgeos/SKILL.md:30", command: NEW_RECIPE };

function fixture(recipes: Recipe[], block = corpus.policy.block, sha = "a".repeat(40)): Corpus {
  return { ...corpus, overlay: { ...corpus.overlay, sha }, policy: { ...corpus.policy, block }, recipes };
}

const thisCore = {
  version: "this",
  classifyForHook,
  loadPolicyText,
  resolve,
  harnessLaunchNeedsRule,
  promptStyleFor,
  promptSayFor,
};

/** 0.4.5's answer for the pre-#427 shape: no fetch-output-unknown rule, so the curl is network.call. */
const baselineCore = {
  ...thisCore,
  version: "0.4.5-standin",
  classifyForHook: (command: string, ...rest: unknown[]) => {
    const real = (classifyForHook as (...a: unknown[]) => { result: Record<string, unknown> })(command, ...rest);
    if (command.startsWith("curl ") && !command.includes("--url")) {
      return { ...real, result: { ok: true, classes: ["network.call"], segments: [{ class: "network.call", rule: "fetch" }] } };
    }
    return real;
  },
};

function diff(before: Corpus, now: Corpus, allowlist = { entries: [] as unknown[] }): Diff {
  const a = decideCorpus(baselineCore, before) as { calls: unknown[] } | { error: string };
  const b = decideCorpus(thisCore, now) as { calls: unknown[] } | { error: string };
  assert.ok(!("error" in a), JSON.stringify(a));
  assert.ok(!("error" in b), JSON.stringify(b));
  return diffCalls(a.calls, b.calls, allowlist) as Diff;
}

const recipeRow = (d: Diff, command: string): Row | undefined => d.rows.find((r) => r.kind === "recipe" && r.command === command);

test("FLIP: the pre-#427 EdgeOS recipe moves network.call auto -> policy.core human-only and is BLOCKING", () => {
  const d = diff(fixture([STAYS, FLIPS]), fixture([STAYS, FLIPS]));
  const row = recipeRow(d, PRE_FIX_URL);
  assert.equal(row?.status, "blocking");
  assert.deepEqual(row?.old?.classes, ["network.call"]);
  assert.equal(row?.old?.decision, "auto");
  assert.deepEqual(row?.new?.classes, ["policy.core"]);
  assert.equal(row?.new?.decision, "human-only");
  assert.equal(d.summary.blocking, 1);
});

test("STAYS: the --url recipe classes network.call auto at both cores and is unchanged", () => {
  const d = diff(fixture([STAYS]), fixture([STAYS]));
  const row = recipeRow(d, FIXED_URL);
  assert.equal(row?.status, "unchanged");
  assert.equal(row?.new?.decision, "auto");
  assert.equal(d.summary.blocking, 0);
  // The harness tools lines are part of every diff, and none moves here.
  assert.ok(d.summary.harness > 0);
  assert.equal(d.summary.unchanged, d.summary.calls);
});

test("NEW: a recipe only in the candidate corpus is reported new and never blocks", () => {
  const d = diff(fixture([STAYS]), fixture([STAYS, NEW]));
  const row = recipeRow(d, NEW_RECIPE);
  assert.equal(row?.status, "new");
  assert.equal(row?.old, null);
  assert.equal(d.summary.new, 1);
  assert.equal(d.summary.blocking, 0);
});

test("REMOVED, moved lines, and an allowlisted flip", () => {
  const moved = { ...STAYS, where: "skills/edgeos/SKILL.md:99" };
  const d = diff(fixture([STAYS, FLIPS]), fixture([moved, FLIPS]), {
    entries: [{ file: "skills/edgeos/SKILL.md", command: PRE_FIX_URL, flip: { from: "auto", to: "human-only" }, reason: "accepted by Carter (test)" }],
  });
  assert.equal(recipeRow(d, FIXED_URL)?.status, "unchanged", "a line move is not a change");
  assert.equal(recipeRow(d, PRE_FIX_URL)?.status, "allowlisted");
  assert.equal(d.summary.blocking, 0);
  // An entry whose flip names another move does not cover this one.
  const wrong = diff(fixture([FLIPS]), fixture([FLIPS]), {
    entries: [{ file: "skills/edgeos/SKILL.md", command: PRE_FIX_URL, flip: { from: "card", to: "refused" }, reason: "x" }],
  });
  assert.equal(recipeRow(wrong, PRE_FIX_URL)?.status, "blocking");
  const gone = diff(fixture([STAYS, NEW]), fixture([STAYS]));
  assert.equal(recipeRow(gone, NEW_RECIPE)?.status, "removed");
});

test("the GATE line states class-diff: none when nothing moved, and FAIL with the count when something did", () => {
  const meta = { core: "b", baselineCore: "a", overlay: "f".repeat(40), baselineOverlay: "f".repeat(40) };
  const none = diff(fixture([STAYS]), fixture([STAYS]));
  assert.match(gateLine(meta, none.summary), /^CLASS-DIFF PASS: .*class-diff: none/u);
  const flip = diff(fixture([FLIPS]), fixture([FLIPS]));
  assert.match(gateLine(meta, flip.summary), /^CLASS-DIFF FAIL 1 BLOCKING: /u);
});

// --- the CLI, exit codes read alone -------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "class-diff-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

const EMPTY_ALLOWLIST = write("allowlist.json", { entries: [] });
const RESERVED_BLOCK = corpus.policy.block.replace(
  /^(\s*)network\.call:(\s*)\{ autonomy: autonomous \}/mu,
  "$1network.call:$2{ autonomy: human-only }",
);

function cli(baseline: Corpus, candidate: Corpus): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(
    process.execPath,
    [SCRIPT, "--core", ROOT, "--diff", ROOT, "--allowlist", EMPTY_ALLOWLIST, "--baseline-corpus", write("base.json", baseline), "--corpus", write("cand.json", candidate)],
    { encoding: "utf8" },
  );
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test("CLI: the template fixture really reserves network.call", () => {
  assert.notEqual(RESERVED_BLOCK, corpus.policy.block);
});

test("CLI FLIP: a recipe moving auto -> human-only exits 1 with the BLOCKING row", () => {
  const run = cli(fixture([STAYS]), fixture([STAYS], RESERVED_BLOCK));
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /CLASS-DIFF FAIL \d+ BLOCKING/u);
  assert.match(run.stdout, /network\.call: auto \| network\.call: human-only/u);
  assert.match(run.stderr, /move from running to a deny/u);
});

test("CLI STAYS: the same corpus at the same core exits 0 and says class-diff: none", () => {
  const run = cli(fixture([STAYS]), fixture([STAYS]));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /CLASS-DIFF PASS: .*class-diff: none/u);
});

test("CLI NEW: a new recipe exits 0 and is listed under New calls", () => {
  const run = cli(fixture([STAYS]), fixture([STAYS, NEW]));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /; 1 new, 0 removed/u);
  assert.match(run.stdout, /### New calls \(reported, not gated\): 1/u);
});
