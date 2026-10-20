#!/usr/bin/env node
/**
 * Release check: the overlay's shipped recipes against this core
 * (0.4.7, EDGEOS-BLOCK, brief item D), and the CLASS-DIFF of those calls
 * against a baseline core (B-167, lead ruling CLAIMS L15681 (1)).
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
 * `--diff <baseline core>` (B-167) adds the release question the incident
 * turned on: which shipped calls CHANGE how they are decided between the core
 * the boxes run today and this one. 0.4.6 passed every test of its own; what
 * nobody produced was the list of fleet calls whose answer moved. The same
 * corpus is classified at both cores; the calls are every recipe plus the box
 * harness calls, read from the template's `tools:` lines (each Hermes or MCP
 * tool the policy names, at the class its line gives: core's own Hermes tool
 * table, `describeToolCall` in src/cli/hook.ts, is not exported, and the
 * template states the two agree). Each call reduces to one decision, the
 * strictest over its classes: auto (autonomous, supervised-retro), sampled
 * (supervised-live), card (manual), human-only, refused (the classifier
 * refuses it, or an unruled harness.launch.*). A card also carries its style
 * (the template's `style`, and `technical (undeclared)` for a class with no
 * `say` entry under minimal). Calls match by file + exact command text +
 * occurrence, so a moved line is not a change.
 *
 * - BLOCKING: an existing call moving from auto, sampled or card to human-only
 *   or refused (auto -> human-only, card -> deny). Fails, unless the allowlist
 *   names that call with a reason (and, when the entry has `flip`, that exact
 *   from -> to); it is then reported as allowlisted.
 * - TIGHTER: a stricter decision that still runs (auto -> card). Reported.
 * - CHANGED: the class set, refusal code or card style moves and the decision
 *   gets no stricter. Reported.
 * - NEW / REMOVED (with `--baseline-corpus`): calls only in this / the
 *   baseline corpus. Reported, not gated: a new recipe that is human-only is
 *   the check's own finding above.
 *
 * Usage:
 *   node scripts/overlay-recipes-check.mjs            the check (exit 1 on a hit)
 *   node scripts/overlay-recipes-check.mjs --json     the per-recipe table as JSON
 *   ... --corpus <path>                              another snapshot (a candidate refresh)
 *   ... --core <dir>                                 judge another build than this checkout's
 *                                                    (a package root holding dist/src, e.g.
 *                                                    node_modules/approval-md of an npm install)
 *   ... --allowlist <path>                           another allowlist (the overlay keeps its own)
 *   ... --diff <dir>                                 the CLASS-DIFF against the baseline core at <dir>
 *       [--baseline-corpus <path>] [--md <out.md>] [--diff-json <out.json>]
 *       [--core-label <text>] [--baseline-label <text>]
 *
 * In --diff mode the markdown report goes to stdout (and --md) after the check;
 * its first line is the GATE line.
 *
 * Exit codes: 0 clean, 1 an unlisted human-only recipe, a stale allowlist
 * entry or a blocking flip, 2 the corpus, the allowlist, the policy or a build
 * could not be read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const CORPUS = arg("--corpus") ?? join(REPO_ROOT, "scripts", "overlay-recipes", "corpus.json");
const ALLOWLIST = arg("--allowlist") ?? join(REPO_ROOT, "scripts", "overlay-recipes", "allowlist.json");

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

/** Load a corpus's vendored template policy with a core's own loader. */
export function loadCorpusPolicy(loadPolicyText, corpus) {
  let text = corpus.policy.block;
  for (const [from, to] of Object.entries(corpus.policy.substitute ?? {})) text = text.split(from).join(to);
  return loadPolicyText(corpus.policy.source, `\`\`\`yaml approval-policy\n${text}\n\`\`\`\n`);
}

/**
 * Classify every recipe and judge it. Pure over its inputs, so a test can run
 * it against a doctored corpus without spawning anything.
 */
export function judge({ corpus, allowlist, classifyForHook, loadPolicyText, resolve }) {
  const load = loadCorpusPolicy(loadPolicyText, corpus);
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

// ---------------------------------------------------------------------------
// CLASS-DIFF (B-167)
// ---------------------------------------------------------------------------

/** Strictest first: a lower index is stricter. */
export const DECISIONS = ["refused", "human-only", "card", "sampled", "auto"];
const DENIES = new Set(["refused", "human-only"]);
const RUNS = new Set(["card", "sampled", "auto"]);
const strictness = (decision) => DECISIONS.indexOf(decision);

/** The card style a carded class gets on the resident's Telegram (template `style` + `say` coverage). */
function cardStyle(core, load, cls) {
  const style = typeof core.promptStyleFor === "function" ? core.promptStyleFor(load, "telegram") : "technical";
  if (style !== "minimal") return style;
  const say = typeof core.promptSayFor === "function" ? core.promptSayFor(load, "telegram") : {};
  return Object.prototype.hasOwnProperty.call(say, cls) ? "minimal" : "technical (undeclared)";
}

/** One class's decision under a loaded policy, through the core's own resolver. */
function classDecision(core, load, cls) {
  const res = core.resolve(load, cls);
  if (typeof core.harnessLaunchNeedsRule === "function" && core.harnessLaunchNeedsRule(cls, res)) {
    return { decision: "refused", code: "hook-harness-launch-unruled" };
  }
  if (res.autonomy === "human-only") return { decision: "human-only", code: "hook-class-human-only" };
  if (res.autonomy === "manual") return { decision: "card", style: cardStyle(core, load, cls) };
  if (res.autonomy === "supervised" && res.supervision === "live") {
    return { decision: "sampled", style: cardStyle(core, load, cls) };
  }
  return { decision: "auto" };
}

/**
 * Every call of a corpus (recipes + the template's tools lines), classified and
 * decided at one core. Pure over its inputs: `core` is the core's functions
 * (classifyForHook, loadPolicyText, resolve, and optionally
 * harnessLaunchNeedsRule, promptStyleFor, promptSayFor), so a test can hand it
 * stand-ins.
 */
export function decideCorpus(core, corpus) {
  const load = loadCorpusPolicy(core.loadPolicyText, corpus);
  if (!load.ok) return { error: `the template policy did not load at core ${core.version}: ${load.code}: ${load.message}` };
  const protectedPaths = load.policy.protected_paths ?? [];
  const calls = [];
  const seen = new Map();
  const keyed = (kind, file, command) => {
    const base = `${kind}\u0000${file}\u0000${command}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}\u0000${n}`;
  };
  const verdictOf = (classes) => {
    let worst = { decision: "auto" };
    const styles = new Set();
    for (const cls of classes) {
      const d = classDecision(core, load, cls);
      if (d.style !== undefined) styles.add(d.style);
      if (strictness(d.decision) < strictness(worst.decision)) worst = d;
    }
    const style = worst.decision === "card" || worst.decision === "sampled" ? [...styles].sort().join("+") : null;
    return { decision: worst.decision, code: worst.code ?? null, style };
  };
  for (const recipe of corpus.recipes) {
    const command = filled(recipe.command, corpus.fill ?? []);
    const result = core.classifyForHook(command, protectedPaths, corpus.cwd ?? "/tmp", []).result;
    const key = keyed("recipe", fileOf(recipe.where), recipe.command);
    if (!result.ok) {
      calls.push({ key, kind: "recipe", where: recipe.where, command: recipe.command, classes: [], rules: [], decision: "refused", code: result.code, style: null });
      continue;
    }
    const classes = [...new Set(result.classes)].sort();
    const rules = [...new Set(result.segments.map((s) => s.rule).filter((r) => typeof r === "string"))].sort();
    calls.push({ key, kind: "recipe", where: recipe.where, command: recipe.command, classes, rules, ...verdictOf(classes) });
  }
  for (const line of load.policy.tools ?? []) {
    const match = String(line.match);
    const key = keyed("harness", "tools:", match);
    const classes = typeof line.class === "string" ? [line.class] : [];
    const verdict = classes.length === 0 ? { decision: "refused", code: "tools-line-without-class", style: null } : verdictOf(classes);
    calls.push({ key, kind: "harness", where: "tools:", command: match, classes, rules: ["tools-line"], ...verdict });
  }
  return { calls };
}

function allowlisted(allowlist, row) {
  return (allowlist?.entries ?? []).find(
    (e) =>
      e.file === fileOf(row.where) &&
      e.command === row.command &&
      typeof e.reason === "string" &&
      e.reason.trim() !== "" &&
      (e.flip === undefined || (e.flip?.from === row.old.decision && e.flip?.to === row.new.decision)),
  );
}

const pick = (c) => ({ classes: c.classes, rules: c.rules, decision: c.decision, code: c.code ?? null, style: c.style ?? null, where: c.where });

/**
 * Join the baseline side and this side into the diff. Pure. `baselineCalls`
 * and `calls` come from {@link decideCorpus}.
 */
export function diffCalls(baselineCalls, calls, allowlist = { entries: [] }) {
  const before = new Map(baselineCalls.map((c) => [c.key, c]));
  const keys = new Set(calls.map((c) => c.key));
  const rows = [];
  for (const now of calls) {
    const was = before.get(now.key);
    if (was === undefined) {
      rows.push({ status: "new", kind: now.kind, where: now.where, command: now.command, old: null, new: pick(now) });
      continue;
    }
    const moved =
      was.classes.join("+") !== now.classes.join("+") ||
      was.decision !== now.decision ||
      (was.code ?? null) !== (now.code ?? null) ||
      (was.style ?? null) !== (now.style ?? null);
    let status = "unchanged";
    if (RUNS.has(was.decision) && DENIES.has(now.decision)) status = "blocking";
    else if (strictness(now.decision) < strictness(was.decision) && RUNS.has(now.decision)) status = "tighter";
    else if (moved) status = "changed";
    const row = { status, kind: now.kind, where: now.where, command: now.command, old: pick(was), new: pick(now) };
    if (status === "blocking") {
      const entry = allowlisted(allowlist, row);
      if (entry !== undefined) {
        row.status = "allowlisted";
        row.reason = entry.reason;
      }
    }
    rows.push(row);
  }
  for (const was of baselineCalls) {
    if (!keys.has(was.key)) rows.push({ status: "removed", kind: was.kind, where: was.where, command: was.command, old: pick(was), new: null });
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  const summary = {
    calls: calls.length,
    recipes: calls.filter((c) => c.kind === "recipe").length,
    harness: calls.filter((c) => c.kind === "harness").length,
    blocking: count("blocking"),
    allowlisted: count("allowlisted"),
    tighter: count("tighter"),
    changed: count("changed"),
    new: count("new"),
    removed: count("removed"),
    unchanged: count("unchanged"),
  };
  return { rows, summary };
}

/** The GATE line: the one line the release GATE carries verbatim. */
export function gateLine(meta, summary) {
  const verdict = summary.blocking > 0 ? `FAIL ${summary.blocking} BLOCKING` : "PASS";
  const moved = summary.blocking + summary.allowlisted + summary.tighter + summary.changed;
  const overlay =
    meta.baselineOverlay === meta.overlay
      ? `overlay ${meta.overlay.slice(0, 12)}`
      : `overlay ${meta.baselineOverlay.slice(0, 12)} -> ${meta.overlay.slice(0, 12)}`;
  return (
    `CLASS-DIFF ${verdict}: core ${meta.baselineCore} -> ${meta.core}, ${overlay}; ` +
    `${summary.calls} calls (${summary.recipes} recipes + ${summary.harness} harness tools); ` +
    (moved === 0
      ? "class-diff: none"
      : `${moved} moved (${summary.blocking} blocking, ${summary.allowlisted} allowlisted, ${summary.tighter} tighter, ${summary.changed} changed)`) +
    `; ${summary.new} new, ${summary.removed} removed`
  );
}

function sideText(s) {
  if (s === null) return "-";
  const classes = s.classes.length > 0 ? s.classes.join("+") : `refused:${s.code}`;
  const style = s.style ? `, ${s.style} card` : "";
  const code = s.classes.length > 0 && s.code ? ` (${s.code}${s.rules.length > 0 ? `; ${s.rules.join(",")}` : ""})` : "";
  return `${classes}: ${s.decision}${style}${code}`;
}

function cell(text) {
  const t = String(text).replace(/\|/gu, "\\|").replace(/`/gu, "'").replace(/\n/gu, " ");
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

export function renderDiff(meta, diff) {
  const out = [gateLine(meta, diff.summary), ""];
  out.push(`## Class-diff: approval.md core ${meta.baselineCore} -> ${meta.core}`, "");
  out.push(`- baseline: core ${meta.baselineCore} (${meta.baselineLabel}), overlay ${meta.overlayRepo}@${meta.baselineOverlay}`);
  out.push(`- candidate: core ${meta.core} (${meta.coreLabel}), overlay ${meta.overlayRepo}@${meta.overlay}`);
  out.push("- BLOCKING (CLAIMS L15681 (1)): an existing call moving from auto, sampled or card to human-only or refused", "");
  const moved = diff.rows.filter((r) => ["blocking", "allowlisted", "tighter", "changed"].includes(r.status));
  if (moved.length === 0) out.push("class-diff: none (no existing call changes class, code, decision or card style)", "");
  const sections = [
    ["blocking", "BLOCKING (fails the job)"],
    ["allowlisted", "Would block, allowlisted with a reason"],
    ["tighter", "Tighter, still runs (reported)"],
    ["changed", "Class, code or card style changed, not stricter (reported)"],
  ];
  for (const [status, title] of sections) {
    const rows = diff.rows.filter((r) => r.status === status);
    if (rows.length === 0) continue;
    out.push(`### ${title}: ${rows.length}`, "", "| call | where | old | new |", "|---|---|---|---|");
    for (const r of rows) out.push(`| \`${cell(r.command)}\` | ${cell(r.new.where)} | ${cell(sideText(r.old))} | ${cell(sideText(r.new))} |`);
    out.push("");
  }
  for (const [status, title, side] of [["new", "New calls (reported, not gated)", "new"], ["removed", "Removed calls", "old"]]) {
    const rows = diff.rows.filter((r) => r.status === status);
    if (rows.length === 0) continue;
    out.push(`### ${title}: ${rows.length}`, "", "| call | where | at this side's core |", "|---|---|---|");
    for (const r of rows) out.push(`| \`${cell(r.command)}\` | ${cell(r[side].where)} | ${cell(sideText(r[side]))} |`);
    out.push("");
  }
  out.push(`Unchanged: ${diff.summary.unchanged} of ${diff.summary.calls} calls.`, "");
  return out.join("\n");
}

/** A core's functions from a package root that holds `dist/src`. */
export async function loadCore(root) {
  const dist = join(root, "dist", "src");
  for (const f of ["cli/hook.js", "core/policy-load.js", "core/policy-match.js"]) {
    if (!existsSync(join(dist, f))) throw new Error(`no build at ${join(dist, f)}; run \`npm run build\` there first`);
  }
  const hook = await import(pathToFileURL(join(dist, "cli", "hook.js")).href);
  const load = await import(pathToFileURL(join(dist, "core", "policy-load.js")).href);
  const match = await import(pathToFileURL(join(dist, "core", "policy-match.js")).href);
  const layoutPath = join(dist, "core", "prompt-layout.js");
  const layout = existsSync(layoutPath) ? await import(pathToFileURL(layoutPath).href) : {};
  return {
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    classifyForHook: hook.classifyForHook,
    loadPolicyText: load.loadPolicyText,
    resolve: match.resolve,
    harnessLaunchNeedsRule: match.harnessLaunchNeedsRule,
    promptStyleFor: layout.promptStyleFor,
    promptSayFor: layout.promptSayFor,
  };
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${what} at ${path}: ${String(error)}`);
  }
}

function checkCorpusShape(corpus, path) {
  if (!Array.isArray(corpus.recipes) || corpus.recipes.length === 0) fail(`the corpus at ${path} has no recipes`);
  if (!/^[0-9a-f]{40}$/u.test(corpus.overlay?.sha ?? "")) fail(`the corpus at ${path} records no overlay sha`);
}

async function main() {
  const json = process.argv.includes("--json");
  if (!existsSync(CORPUS)) fail(`no corpus at ${CORPUS}`);
  const corpus = readJson(CORPUS, "the corpus");
  const allowlist = existsSync(ALLOWLIST) ? readJson(ALLOWLIST, "the allowlist") : { entries: [] };
  checkCorpusShape(corpus, CORPUS);
  const coreDir = resolvePath(arg("--core") ?? REPO_ROOT);
  let core;
  try {
    core = await loadCore(coreDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const verdict = judge({ corpus, allowlist, classifyForHook: core.classifyForHook, loadPolicyText: core.loadPolicyText, resolve: core.resolve });
  if ("error" in verdict) fail(verdict.error);
  const version = core.version;

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

  const baselineDir = arg("--diff");
  if (baselineDir !== undefined) {
    const baselinePath = arg("--baseline-corpus") ?? CORPUS;
    if (!existsSync(baselinePath)) fail(`no baseline corpus at ${baselinePath}`);
    const baselineCorpus = readJson(baselinePath, "the baseline corpus");
    checkCorpusShape(baselineCorpus, baselinePath);
    let baselineCore;
    try {
      baselineCore = await loadCore(resolvePath(baselineDir));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const before = decideCorpus(baselineCore, baselineCorpus);
    if ("error" in before) fail(before.error);
    const after = decideCorpus(core, corpus);
    if ("error" in after) fail(after.error);
    const diff = diffCalls(before.calls, after.calls, allowlist);
    const meta = {
      core: core.version,
      baselineCore: baselineCore.version,
      coreLabel: arg("--core-label") ?? coreDir,
      baselineLabel: arg("--baseline-label") ?? resolvePath(baselineDir),
      overlay: corpus.overlay.sha,
      baselineOverlay: baselineCorpus.overlay.sha,
      overlayRepo: corpus.overlay.repo,
    };
    const md = renderDiff(meta, diff);
    if (!json) process.stdout.write(`\n${md}`);
    const mdOut = arg("--md");
    if (mdOut !== undefined) writeFileSync(mdOut, md, "utf8");
    const jsonOut = arg("--diff-json");
    if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify({ gate: gateLine(meta, diff.summary), meta, ...diff }, null, 2)}\n`, "utf8");
    if (diff.summary.blocking > 0) {
      bad = true;
      process.stderr.write(
        `${diff.summary.blocking} shipped call(s) move from running to a deny between core ${meta.baselineCore} and ${meta.core} (EDGEOS-BLOCK). ` +
          "Fix the classifier, change the overlay recipe first, or have Carter accept the move by name: an allowlist entry for the call with its reason (and `flip`).\n",
      );
    }
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] !== undefined && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url) await main();
