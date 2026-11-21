/**
 * The overlay recipe corpus release check (0.4.7, EDGEOS-BLOCK, brief item D).
 *
 * `scripts/overlay-recipes-check.mjs` runs the pinned snapshot of the overlay's
 * shipped recipes through `classifyForHook` and fails on any recipe that
 * resolves to a human-only class under the overlay's template policy, unless
 * the allowlist names it with a reason. The CI job `overlay-recipes` runs the
 * script; this file runs its `judge` over the same snapshot inside the suite,
 * and proves on a mutant of the snapshot that the check would have caught
 * EDGEOS-BLOCK: the 0.4.6 recipes, before the overlay's `--url` fix
 * (agentvillage #427), land in `policy.core` by `fetch-output-unknown`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook } from "../src/cli/hook.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
// The script is plain Node ESM so CI runs it straight after a build; its
// exports are exercised here without a .d.ts, as agent-hours.test.ts does.
// @ts-expect-error no declaration file for the standalone check script
import { judge, fileOf, filled } from "../../scripts/overlay-recipes-check.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
interface Entry {
  file: string;
  command: string;
  reason?: string;
  scope?: string;
}
interface Row {
  where: string;
  command: string;
  ok: boolean;
  classes: string[];
  humanOnly: string[];
  rules?: string[];
}
interface Verdict {
  rows: Row[];
  held: Row[];
  refused: Row[];
  unlisted: Row[];
  stale: Entry[];
  unreasoned: Entry[];
}

const corpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as Corpus;
const allowlist = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "allowlist.json"), "utf8")) as {
  entries: Entry[];
};

function run(c: Corpus, a: { entries: Entry[] }): Verdict {
  const verdict = judge({ corpus: c, allowlist: a, classifyForHook, loadPolicyText, resolve }) as Verdict | { error: string };
  assert.ok(!("error" in verdict), JSON.stringify(verdict));
  return verdict as Verdict;
}

const EDGEOS = (recipe: Recipe): boolean => fileOf(recipe.where) === "skills/edgeos/SKILL.md" && /^curl\s/u.test(recipe.command);

test("the snapshot names its overlay sha, and carries the eleven EdgeOS recipes in their --url form", () => {
  assert.equal(corpus.overlay.repo, "Edge-City/agentvillage");
  assert.match(corpus.overlay.sha, /^[0-9a-f]{40}$/u);
  assert.ok(corpus.recipes.length > 0);
  const edgeos = corpus.recipes.filter(EDGEOS);
  assert.equal(edgeos.length, 11);
  for (const recipe of edgeos) {
    assert.ok(recipe.command.includes('--url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/'), recipe.command);
  }
});

test("the vendored template policy loads, and reserves exactly the classes the overlay names human-only", () => {
  const verdict = run(corpus, allowlist);
  assert.ok(verdict.rows.length === corpus.recipes.length);
  let text = corpus.policy.block;
  for (const [from, to] of Object.entries(corpus.policy.substitute)) text = text.split(from).join(to);
  const load = loadPolicyText("template", `\`\`\`yaml approval-policy\n${text}\n\`\`\`\n`);
  assert.ok(load.ok, JSON.stringify(load));
  for (const cls of ["policy.core", "log.mutate", "account.credential"]) {
    assert.equal(resolve(load, cls).autonomy, "human-only", cls);
  }
  for (const cls of ["network.call", "read.web", "exec.local"]) {
    assert.notEqual(resolve(load, cls).autonomy, "human-only", cls);
  }
});

test("this core: no overlay recipe resolves human-only unless the allowlist names it with a reason", () => {
  const verdict = run(corpus, allowlist);
  assert.deepEqual(verdict.unlisted.map((row) => `${row.where} ${row.humanOnly.join(",")}`), []);
  assert.deepEqual(verdict.stale, [], "an allowlist entry no held recipe matches");
  assert.deepEqual(verdict.unreasoned, []);
  // Every EdgeOS recipe classes network.call, autonomous under the template.
  for (const row of verdict.rows.filter(EDGEOS)) {
    assert.ok(row.ok, row.where);
    assert.deepEqual([...new Set(row.classes)], ["network.call"], `${row.where}: ${row.command}`);
  }
});

test("mutant: the EdgeOS recipes before the overlay's --url fix fail the check (EDGEOS-BLOCK)", () => {
  const before: Corpus = {
    ...corpus,
    recipes: corpus.recipes.map((recipe) =>
      EDGEOS(recipe) ? { ...recipe, command: recipe.command.replace('--url "${EDGEOS_API_BASE', '"${EDGEOS_API_BASE') } : recipe,
    ),
  };
  const verdict = run(before, allowlist);
  const edgeos = verdict.unlisted.filter((row) => fileOf(row.where) === "skills/edgeos/SKILL.md");
  assert.equal(edgeos.length, 11, JSON.stringify(verdict.unlisted.map((row) => row.where)));
  for (const row of edgeos) {
    assert.deepEqual(row.humanOnly, ["policy.core"], row.where);
    assert.deepEqual(row.rules, ["fetch-output-unknown"], row.where);
  }
});

test("mutant: a stale allowlist entry and one with no reason both fail", () => {
  const verdict = run(corpus, {
    entries: [
      ...allowlist.entries,
      { file: "skills/edgeos/SKILL.md", command: "curl -s https://h/never", reason: "gone", scope: "neutral" },
      { file: "skills/x/SKILL.md", command: "true", reason: " ", scope: "neutral" },
    ],
  });
  assert.deepEqual(
    verdict.stale.map((entry) => entry.command),
    ["curl -s https://h/never", "true"],
  );
  assert.deepEqual(
    verdict.unreasoned.map((entry) => entry.command),
    ["true"],
  );
});

test("mutant: with the allowlist emptied, its listed recipes are unlisted held recipes again", () => {
  const verdict = run(corpus, { entries: [] });
  // Entries scoped "box" are the real-hook box check's (B-167 fold 1), not this one's.
  const neutral = allowlist.entries.filter((entry) => entry.scope !== "box");
  assert.equal(verdict.unlisted.length, neutral.length);
  for (const entry of neutral) {
    assert.ok(verdict.unlisted.some((row) => fileOf(row.where) === entry.file && row.command === entry.command), entry.command);
  }
});

test("placeholder fills apply in order, as the overlay test's FILL does", () => {
  assert.equal(
    filled("x {event_id} {start_iso} {other}", corpus.fill),
    "x 3fa85f64-5717-4562-b3fc-2c963f66afa6 2026-10-21T10:00:00Z {other}",
  );
});
