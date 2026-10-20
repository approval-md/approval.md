#!/usr/bin/env node
/**
 * Release check: the overlay's shipped recipes against this core
 * (0.4.7, EDGEOS-BLOCK, brief item D).
 *
 * The lesson of EDGEOS-BLOCK: 0.4.6's `fetch-output-unknown` rule was right,
 * and every `skills/edgeos/SKILL.md` curl recipe the fleet shipped landed in
 * `policy.core`, which the overlay's template policy reserves to humans, so
 * every EdgeOS call was denied outright from the morning the boxes took 0.4.6.
 * Nobody had run the fleet's own recipes through the new classifier.
 *
 * This runs the pinned corpus (`scripts/overlay-recipes/corpus.json`, written
 * by `overlay-recipes-extract.mjs` at a recorded overlay sha) through
 * `classifyForHook` as BUILT here (`dist/`, so `npm run build` first), resolves
 * each class against the overlay's template policy with this repository's own
 * resolver, and fails when any recipe resolves to a `human-only` class unless
 * `scripts/overlay-recipes/allowlist.json` lists it with a reason. A recipe the
 * classifier refuses outright (`ok: false`, `hook-unclassified` and kin) is
 * reported and does not fail the check: the corpus extraction is the overlay's
 * own, and it reads operator READMEs, placeholder lines and sample output that
 * no core has ever classified, so a refusal is the long-standing answer for
 * them rather than a move. Whether refusals should gate too is the owner's call.
 *
 * An allowlist entry that no longer matches a held recipe also fails, so the
 * list cannot quietly outlive the reason it was written for and then cover a
 * new regression of the same recipe.
 *
 * Usage:
 *   node scripts/overlay-recipes-check.mjs            the check (exit 1 on a hit)
 *   node scripts/overlay-recipes-check.mjs --json     the per-recipe table as JSON
 *   ... --corpus <path>                              another snapshot (a candidate refresh)
 *
 * Exit codes: 0 clean, 1 an unlisted human-only recipe or a stale
 * allowlist entry, 2 the corpus, the allowlist, the policy or the build could
 * not be read.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const corpusAt = process.argv.indexOf("--corpus");
const CORPUS = corpusAt === -1 ? join(REPO_ROOT, "scripts", "overlay-recipes", "corpus.json") : process.argv[corpusAt + 1];
const ALLOWLIST = join(REPO_ROOT, "scripts", "overlay-recipes", "allowlist.json");

function fail(message) {
  process.stderr.write(`overlay-recipes-check: ${message}\n`);
  process.exit(2);
}

/** The file part of a corpus `where` (`skills/x/SKILL.md:12` -> `skills/x/SKILL.md`). */
export function fileOf(where) {
  return where.replace(/:\d+$/u, "");
}

/** Apply the corpus's placeholder fills, in order, as the overlay's test does. */
export function filled(command, fill) {
  let out = command;
  for (const { pattern, value } of fill) out = out.replace(new RegExp(pattern, "gu"), value);
  return out;
}

/**
 * Classify every recipe and judge it. Pure over its inputs, so a test can run
 * it against a doctored corpus without spawning anything.
 */
export function judge({ corpus, allowlist, classifyForHook, loadPolicyText, resolve }) {
  let text = corpus.policy.block;
  for (const [from, to] of Object.entries(corpus.policy.substitute ?? {})) text = text.split(from).join(to);
  const load = loadPolicyText(corpus.policy.source, `\`\`\`yaml approval-policy\n${text}\n\`\`\`\n`);
  if (!load.ok) return { error: `the vendored template policy did not load: ${load.code}: ${load.message}` };
  const protectedPaths = load.policy.protected_paths ?? [];
  const rows = [];
  for (const recipe of corpus.recipes) {
    const command = filled(recipe.command, corpus.fill ?? []);
    const result = classifyForHook(command, protectedPaths, corpus.cwd ?? "/tmp", []).result;
    if (!result.ok) {
      rows.push({ where: recipe.where, command: recipe.command, ok: false, code: result.code, classes: [], humanOnly: [] });
      continue;
    }
    const humanOnly = result.classes.filter((cls) => resolve(load, cls).autonomy === "human-only");
    const rules = [...new Set(result.segments.filter((s) => humanOnly.includes(s.class)).map((s) => s.rule))];
    rows.push({ where: recipe.where, command: recipe.command, ok: true, classes: result.classes, humanOnly, rules });
  }
  const held = rows.filter((row) => row.ok && row.humanOnly.length > 0);
  const refused = rows.filter((row) => !row.ok);
  const listed = (row) =>
    allowlist.entries.find((entry) => entry.file === fileOf(row.where) && entry.command === row.command);
  const unlisted = held.filter((row) => listed(row) === undefined);
  const stale = allowlist.entries.filter(
    (entry) => !held.some((row) => entry.file === fileOf(row.where) && entry.command === row.command),
  );
  const unreasoned = allowlist.entries.filter((entry) => typeof entry.reason !== "string" || entry.reason.trim() === "");
  return { rows, held, refused, unlisted, stale, unreasoned };
}

async function main() {
  const json = process.argv.includes("--json");
  if (!existsSync(CORPUS)) fail(`no corpus at ${CORPUS}`);
  let corpus;
  let allowlist;
  try {
    corpus = JSON.parse(readFileSync(CORPUS, "utf8"));
    allowlist = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : { entries: [] };
  } catch (error) {
    fail(`could not read the corpus or the allowlist: ${String(error)}`);
  }
  if (!Array.isArray(corpus.recipes) || corpus.recipes.length === 0) fail("the corpus has no recipes");
  if (!/^[0-9a-f]{40}$/u.test(corpus.overlay?.sha ?? "")) fail("the corpus records no overlay sha");
  const dist = join(REPO_ROOT, "dist", "src");
  if (!existsSync(join(dist, "cli", "hook.js"))) fail("no build at dist/; run `npm run build` first");
  const { classifyForHook } = await import(pathToFileURL(join(dist, "cli", "hook.js")).href);
  const { loadPolicyText } = await import(pathToFileURL(join(dist, "core", "policy-load.js")).href);
  const { resolve } = await import(pathToFileURL(join(dist, "core", "policy-match.js")).href);
  const verdict = judge({ corpus, allowlist, classifyForHook, loadPolicyText, resolve });
  if ("error" in verdict) fail(verdict.error);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

  if (json) {
    process.stdout.write(`${JSON.stringify({ core: version, overlay: corpus.overlay.sha, ...verdict }, null, 2)}\n`);
  } else {
    const counts = new Map();
    for (const row of verdict.rows) {
      const key = row.ok ? [...new Set(row.classes)].sort().join("+") || "(no class)" : `refused:${row.code}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    process.stdout.write(
      `core ${version} vs overlay ${corpus.overlay.repo}@${corpus.overlay.sha.slice(0, 12)}: ${verdict.rows.length} recipes, ${verdict.held.length} human-only (${verdict.held.length - verdict.unlisted.length} allowlisted), ${verdict.refused.length} refused (reported, not gated)\n`,
    );
    for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      process.stdout.write(`  ${String(n).padStart(4)}  ${key}\n`);
    }
    for (const row of verdict.held) {
      const entry = allowlist.entries.find((e) => e.file === fileOf(row.where) && e.command === row.command);
      const why = `${row.humanOnly.join(",")} (${row.rules.join(",")})`;
      process.stdout.write(`${entry === undefined ? "HELD" : "listed"}  ${row.where}  ${why}\n        ${row.command}\n`);
      if (entry !== undefined) process.stdout.write(`        reason: ${entry.reason}\n`);
    }
    for (const row of verdict.refused) process.stdout.write(`refused (info)  ${row.where}  ${row.code}\n`);
  }
  let bad = false;
  for (const entry of verdict.stale) {
    bad = true;
    process.stderr.write(`stale allowlist entry (no held recipe matches it any more; delete it): ${entry.file}: ${entry.command}\n`);
  }
  for (const entry of verdict.unreasoned) {
    bad = true;
    process.stderr.write(`allowlist entry without a reason: ${entry.file}: ${entry.command}\n`);
  }
  if (verdict.unlisted.length > 0) {
    bad = true;
    process.stderr.write(
      `${verdict.unlisted.length} overlay recipe(s) resolve to a human-only class under this core and are not allowlisted. ` +
        "An agent following them would be denied outright (EDGEOS-BLOCK). Fix the classifier, get the overlay recipe changed, " +
        "or list the recipe in scripts/overlay-recipes/allowlist.json with the reason it is right.\n",
    );
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
