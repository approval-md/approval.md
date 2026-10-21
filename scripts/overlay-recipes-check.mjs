#!/usr/bin/env node
/**
 * Release check: the overlay's shipped recipes against this core
 * (0.4.7, EDGEOS-BLOCK, brief item D), and the CLASS-DIFF of the overlay's
 * shipped calls against a baseline core (B-167, lead ruling CLAIMS L15681 (1);
 * fold 1 after review-b's refute).
 *
 * The lesson of EDGEOS-BLOCK: 0.4.6's `fetch-output-unknown` rule was right,
 * and every `skills/edgeos/SKILL.md` curl recipe the fleet shipped landed in
 * `policy.core`, which the overlay's template policy reserves to humans, so
 * every EdgeOS call was denied outright from the morning the boxes took 0.4.6.
 * Nobody had run the fleet's own recipes through the new classifier.
 *
 * Three checks, one script:
 *
 * 1. The corpus check (#663, neutral cwd, in process): the pinned corpus
 *    (`scripts/overlay-recipes/corpus.json`) through `classifyForHook` as BUILT
 *    here, each class resolved against the overlay's template policy; any
 *    recipe resolving to `human-only` fails unless the allowlist lists it.
 *    Refusals are reported and not gated here.
 *
 * 2. The box check (`--overlay-tree`, fold 1 S-1): the same corpus through the
 *    REAL `approval hook hermes` of the core under test, in a box layout
 *    (scripts/overlay-recipes-box.mjs: HOME/.hermes with `.env`, `config.yaml`,
 *    the overlay's skills and workspace, APPROVAL_HERMES_HOME set as the
 *    control plane sets it, an attested store), as a Hermes `terminal` call at
 *    $HERMES_HOME, $HOME and $HERMES_HOME/workspace. Any recipe the hook
 *    denies there (human-only OR refused) fails unless the allowlist lists it.
 *
 * 3. The CLASS-DIFF (`--diff <baseline core>`, with `--overlay-tree`): every
 *    shipped call, recipes at the three workdirs and unset plus the harness
 *    calls (core's own Hermes tools and one envelope per `tools:` line of
 *    either template), through each core's real hook in its own box. Each call
 *    is reduced to a decision (auto, sampled, card, human-only, refused) and an
 *    autonomy level (the strictest `resolve` over the classes the hook named:
 *    autonomous, supervised-retro, supervised-live:<rate>, manual,
 *    human-only). BLOCKING: an existing call that ran (auto, sampled, card)
 *    and now runs with less autonomy or not at all (fold 1 S-4: autonomous ->
 *    supervised-retro, a higher live rate, auto -> card, and every move into
 *    a deny), or whose card falls from the minimal to the technical card. A
 *    card's classes are read from the request the hook opened in the box's
 *    store (its timeout line names none). Other moves are reported. New and removed calls are reported; a
 *    new recipe that the hook denies is the box check's finding. A tools line
 *    shadowed by an earlier line (first match wins in core) that was not
 *    shadowed in the baseline template is also BLOCKING.
 *
 * The allowlist (fold 1 M-3): every entry names `file`, `command` (or "*" for
 * a whole operator README), a `reason` that says something, `scope`
 * ("neutral", "box" or "any", default "any"), and Carter's acceptance by name:
 * `accepted_by` ("human:<id>") and `accepted_at` (YYYY-MM-DD). An entry
 * without them fails the run ("awaiting acceptance"), so a PR cannot quiet the
 * gate with `reason: "ok"`. An entry nothing matches fails as stale. Entries
 * may carry `columns` (box columns it covers; default all) and
 * `flip: {from, to}` (only that decision move in the diff). A whole-file entry
 * ("*") covers the box check only and never a call that moves in the diff.
 *
 * Usage:
 *   node scripts/overlay-recipes-check.mjs [--json] [--corpus <path>] [--core <dir>] [--allowlist <path>]
 *        [--overlay-tree <dir>] [--box-root <dir>] [--box-concurrency <n>, default 1] [--harness-only <tool,...> (tests)]
 *        [--diff <baseline core dir> [--baseline-corpus <path>] [--baseline-overlay-tree <dir>]
 *         [--md <out.md>] [--diff-json <out.json>] [--core-label <t>] [--baseline-label <t>]]
 *        [--expected <expected.json> --tag-corpus <corpus at the previous release> [--tag-label <t>]]
 *
 * 4. The NEW-CALLS check (`--expected`, B-167N; scripts/overlay-recipes-newcalls.mjs):
 *    every call NEW or CHANGED against `--tag-corpus` (both corpora extracted
 *    with `--with-envelopes`) needs its declared outcome, and the hook in the
 *    box (and a plugin's daemon propose) must give exactly it under the
 *    village default template and in each settings cell. Findings exit 1.
 *
 * A core dir is a package root holding `dist/src` (a build, or
 * node_modules/approval-md of an npm install). `--diff` requires
 * `--overlay-tree`. Exit codes: 0 clean, 1 a finding (unlisted human-only, an
 * unlisted box deny, a blocking move, a new shadowed tools line, a stale or
 * unaccepted allowlist entry), 2 an input could not be read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { probeName, runBox } from "./overlay-recipes-box.mjs";
import { CELLS, decideProposeCall, judgeNewCalls, recipeKey, renderNewCalls, newCallsLine, validateExpected, variantBlock } from "./overlay-recipes-newcalls.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function arg(name) {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}

const CORPUS = () => arg("--corpus") ?? join(REPO_ROOT, "scripts", "overlay-recipes", "corpus.json");
const ALLOWLIST = () => arg("--allowlist") ?? join(REPO_ROOT, "scripts", "overlay-recipes", "allowlist.json");

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

/** The corpus's template policy block with its provisioning substitutions applied. */
export function policyTextOf(corpus) {
  let text = corpus.policy.block;
  for (const [from, to] of Object.entries(corpus.policy.substitute ?? {})) text = text.split(from).join(to);
  return text;
}

/** Load a corpus's vendored template policy with a core's own loader. */
export function loadCorpusPolicy(loadPolicyText, corpus) {
  return loadPolicyText(corpus.policy.source, `\`\`\`yaml approval-policy\n${policyTextOf(corpus)}\n\`\`\`\n`);
}

const scopeOf = (entry) => entry.scope ?? "any";
/**
 * Does an allowlist entry name this call: its file, its command (or "*"), and,
 * when the entry lists `columns`, the box column the call ran in?
 */
export function entryMatches(entry, file, command, column) {
  if (entry.file !== file || (entry.command !== command && entry.command !== "*")) return false;
  if (column !== undefined && Array.isArray(entry.columns) && !entry.columns.includes(column)) return false;
  return true;
}

/**
 * Classify every recipe and judge it (#663, neutral cwd). Pure over its
 * inputs. Entries scoped "box" are the box check's and are not read here.
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
  const entries = allowlist.entries.filter((entry) => scopeOf(entry) !== "box");
  const held = rows.filter((row) => row.ok && row.humanOnly.length > 0);
  const refused = rows.filter((row) => !row.ok);
  const listed = (row) => entries.find((entry) => entryMatches(entry, fileOf(row.where), row.command));
  const unlisted = held.filter((row) => listed(row) === undefined);
  // Only a neutral-scoped entry can go stale here; "any" entries are judged
  // against every check at the end of the run.
  const stale = entries.filter(
    (entry) => scopeOf(entry) === "neutral" && !held.some((row) => entryMatches(entry, fileOf(row.where), row.command)),
  );
  const unreasoned = allowlist.entries.filter((entry) => typeof entry.reason !== "string" || entry.reason.trim() === "");
  return { rows, held, refused, unlisted, stale, unreasoned };
}

const TRIVIAL_REASON = /^(ok|okay|fine|yes|n\/?a|todo|tbd|accepted|allow(ed)?|-+|\.+)$/iu;
/**
 * What keeps an allowlist entry from counting (fold 1 M-3 (b)): a reason that
 * says nothing, or no acceptance by name. An empty list is an accepted entry.
 */
export function acceptanceErrors(entry) {
  const errors = [];
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  if (reason.length < 12 || TRIVIAL_REASON.test(reason)) errors.push(`its reason says nothing ("${reason}")`);
  if (typeof entry.accepted_by !== "string" || entry.accepted_by.trim() === "") {
    errors.push("awaiting acceptance: accepted_by is empty (Carter accepts by name)");
  } else if (!/^human:[a-z][a-z0-9._-]*$/u.test(entry.accepted_by)) {
    errors.push(`accepted_by "${entry.accepted_by}" is not a human:<id>`);
  }
  if (typeof entry.accepted_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.accepted_at)) {
    errors.push("accepted_at is not a YYYY-MM-DD date");
  }
  if (!["neutral", "box", "any"].includes(scopeOf(entry))) errors.push(`scope "${entry.scope}" is not neutral, box or any`);
  if (entry.columns !== undefined && (!Array.isArray(entry.columns) || entry.columns.some((c) => !["hermes-home", "home", "workspace", "harness"].includes(c)))) {
    errors.push("columns names a column other than hermes-home, home, workspace or harness");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Decisions and autonomy
// ---------------------------------------------------------------------------

export const DECISIONS = ["refused", "human-only", "card", "sampled", "auto"];
const DENIES = new Set(["refused", "human-only"]);

/** The card style a carded class gets on the resident's Telegram (template `style` + `say` coverage). */
function cardStyle(core, load, cls) {
  const style = typeof core.promptStyleFor === "function" ? core.promptStyleFor(load, "telegram") : "technical";
  if (style !== "minimal") return style;
  const say = typeof core.promptSayFor === "function" ? core.promptSayFor(load, "telegram") : {};
  return Object.prototype.hasOwnProperty.call(say, cls) ? "minimal" : "technical (undeclared)";
}

/** A class's autonomy level under a loaded policy, as `resolve` gives it, and its rank (lower is less autonomy). */
export function levelOf(core, load, cls) {
  const res = core.resolve(load, cls);
  const declared = res.declaredAutonomy ?? res.autonomy;
  if (res.autonomy === "human-only") return { level: "human-only", rank: 0 };
  if (res.autonomy === "manual") return { level: "manual", rank: 1 };
  if (res.autonomy === "supervised" && res.supervision === "live") {
    const rate = typeof res.liveRate === "number" ? res.liveRate : 1;
    return { level: `supervised-live:${String(rate)}`, rank: 2 - rate };
  }
  if (res.autonomy === "supervised") return { level: "supervised-retro", rank: 3 };
  return { level: declared === "autonomous" ? "autonomous" : String(declared), rank: 4 };
}

/** A side's rank: a deny is 0, a running call its autonomy rank (a card without a known class, 1). */
export function rankOf(side) {
  if (DENIES.has(side.decision)) return -1;
  if (typeof side.rank === "number") return side.rank;
  return { card: 1, sampled: 1.5, auto: 4 }[side.decision] ?? 4;
}

/**
 * Fold 5 (review-b N-10): a `hook-timeout` card whose bound request names no
 * class that needs a human (every one autonomous or supervised-retro, rank 3 or
 * more) contradicts the hook that carded it: the core logged a class other
 * than the one it carded on. Read as is, the card would rank at the logged
 * class and hide a real move, so decideInBox makes it a verdict error and the
 * gate exits 2. A card that bound to no class at all is an error too.
 */
export function cardWithoutHumanClass(core, load, call) {
  if (call.verdict !== "deny" || call.code !== "hook-timeout") return false;
  const bound = Array.isArray(call.requested) ? call.requested : [];
  return !bound.some((cls) => levelOf(core, load, cls).rank < 3);
}

/**
 * Fold 6 (review-b N-15): the rows of a `hook-timeout` card's bound request
 * whose key is not `<task>:<class>` of the row itself (bindRequest's
 * `mislabeled`). The key carries the class the hook carded on; a row logging
 * another class, even one that needs a human, would let the card rank at the
 * logged class and hide a real move, so decideInBox makes it a verdict error
 * and the gate exits 2.
 */
export function cardKeyClassMismatch(call) {
  if (call.verdict !== "deny" || call.code !== "hook-timeout") return [];
  return Array.isArray(call.mislabeled) ? call.mislabeled : [];
}

/**
 * Turn one hook verdict from the box into a decided call: decision, autonomy
 * level (strictest over the classes the hook named), card style.
 */
export function decideBoxCall(core, load, call) {
  const levels = call.classes.map((cls) => ({ cls, ...levelOf(core, load, cls) }));
  const strictest = levels.reduce((a, b) => (b.rank < a.rank ? b : a), { cls: null, level: "autonomous", rank: 4 });
  let decision;
  if (call.verdict === "allow") decision = strictest.level.startsWith("supervised-live") ? "sampled" : "auto";
  else if (call.code === "hook-class-human-only") decision = "human-only";
  else if (call.code === "hook-timeout") decision = strictest.level.startsWith("supervised-live") ? "sampled" : "card";
  else decision = "refused";
  // Each carded class's style (fold 3, N-8: the minimal rule compares per class),
  // and the card's joined style for the report.
  const styles =
    decision === "card" || decision === "sampled"
      ? Object.fromEntries(levels.filter((l) => l.rank < 3).map((l) => [l.cls, cardStyle(core, load, l.cls)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : {};
  const style = [...new Set(Object.values(styles))].sort().join("+") || null;
  return {
    key: call.key,
    column: call.column,
    kind: call.kind,
    where: call.where,
    command: call.command,
    classes: [...new Set(call.classes)].sort(),
    rules: [],
    decision,
    code: DENIES.has(decision) || decision === "card" ? call.code : null,
    level: DENIES.has(decision) ? null : strictest.level,
    rank: DENIES.has(decision) ? -1 : decision === "card" && call.classes.length === 0 ? 1 : strictest.rank,
    style,
    styles,
    // B-167N (P2): which side of a supervised-live draw the call fell on.
    drawn: decision === "sampled" ? (call.verdict === "allow" ? "skip" : "card") : null,
    detail: call.detail,
  };
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

function allowlistedFlip(allowlist, row) {
  return (allowlist?.entries ?? []).find(
    (e) =>
      scopeOf(e) !== "neutral" &&
      // A whole-file entry ("*") covers the absolute box check only: it never
      // silences a call that moves, so a README line that ran and now denies blocks.
      e.command !== "*" &&
      entryMatches(e, fileOf(row.where), row.command, row.column) &&
      acceptanceErrors(e).length === 0 &&
      (e.flip === undefined || (e.flip?.from === row.old.decision && e.flip?.to === row.new.decision)),
  );
}

const pick = (c) => ({
  classes: c.classes,
  rules: c.rules ?? [],
  decision: c.decision,
  code: c.code ?? null,
  level: c.level ?? null,
  rank: c.rank,
  style: c.style ?? null,
  styles: c.styles ?? {},
  where: c.where,
});

/** Classes whose card was minimal and now carries another style (both sides carded). */
export function leftMinimal(was = {}, now = {}) {
  return Object.keys(was ?? {}).filter((cls) => was[cls] === "minimal" && typeof now?.[cls] === "string" && now[cls] !== "minimal");
}

/**
 * Fold 5 (owner N1, review-b N-11): when every class the old card carried was
 * minimal, the classes on the new card with another style. Each class is its own
 * card in core, so a class newly carded at technical on a call that read in plain
 * words is one more technical card. leftMinimal only sees classes on both sides.
 */
export function newlyNotMinimal(was = {}, now = {}) {
  const old = Object.values(was ?? {});
  if (old.length === 0 || old.some((s) => s !== "minimal")) return [];
  return Object.keys(now ?? {}).filter((cls) => typeof now[cls] === "string" && now[cls] !== "minimal");
}

/**
 * Join the baseline side and this side into the diff. Pure. Each call carries
 * `key` (column + kind + file + command + occurrence), `decision`, and
 * optionally `classes`, `code`, `level`, `rank`, `style`, `column`.
 */
export function diffCalls(baselineCalls, calls, allowlist = { entries: [] }) {
  const before = new Map(baselineCalls.map((c) => [c.key, c]));
  const keys = new Set(calls.map((c) => c.key));
  const rows = [];
  for (const now of calls) {
    const was = before.get(now.key);
    const column = now.column ?? "neutral";
    if (was === undefined) {
      rows.push({ status: "new", column, kind: now.kind, where: now.where, command: now.command, old: null, new: pick(now) });
      continue;
    }
    const moved =
      (was.classes ?? []).join("+") !== (now.classes ?? []).join("+") ||
      was.decision !== now.decision ||
      (was.code ?? null) !== (now.code ?? null) ||
      (was.level ?? null) !== (now.level ?? null) ||
      (was.style ?? null) !== (now.style ?? null) ||
      JSON.stringify(was.styles ?? {}) !== JSON.stringify(now.styles ?? {});
    let status = "unchanged";
    if (!DENIES.has(was.decision) && rankOf(now) < rankOf(was)) status = "blocking";
    // Fold 2 (S-4): a card the resident read in plain words that now arrives as
    // the technical card is a resident-visible regression too (the APPROVAL-UX
    // undeclared-class fallback): blocking, unless accepted.
    else if (!DENIES.has(now.decision) && /minimal/u.test(was.style ?? "") && !/minimal/u.test(now.style ?? "") && now.style !== null) status = "blocking";
    // Fold 3 (N-8): per class, so a two-class card whose second class leaves
    // minimal ("minimal" -> "minimal+technical (undeclared)") blocks too.
    else if (!DENIES.has(now.decision) && leftMinimal(was.styles, now.styles).length > 0) status = "blocking";
    // Fold 5 (N-11): a class new to an all-minimal card, at another style.
    else if (!DENIES.has(now.decision) && newlyNotMinimal(was.styles, now.styles).length > 0) status = "blocking";
    else if (moved) status = "changed";
    const row = { status, column, kind: now.kind, where: now.where, command: now.command, old: pick(was), new: pick(now) };
    if (status === "blocking") {
      const entry = allowlistedFlip(allowlist, row);
      if (entry !== undefined) {
        row.status = "allowlisted";
        row.reason = entry.reason;
        row.accepted_by = entry.accepted_by;
      }
    }
    rows.push(row);
  }
  for (const was of baselineCalls) {
    if (!keys.has(was.key)) {
      rows.push({ status: "removed", column: was.column ?? "neutral", kind: was.kind, where: was.where, command: was.command, old: pick(was), new: null });
    }
  }
  return { rows, summary: summarize(rows, calls) };
}

function summarize(rows, calls) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const columns = {};
  for (const r of rows) if (r.status === "blocking") columns[r.column] = (columns[r.column] ?? 0) + 1;
  return {
    calls: calls.length,
    recipes: calls.filter((c) => c.kind === "recipe").length,
    harness: calls.filter((c) => c.kind === "harness").length,
    blocking: count("blocking"),
    allowlisted: count("allowlisted"),
    changed: count("changed"),
    new: count("new"),
    removed: count("removed"),
    unchanged: count("unchanged"),
    columns,
  };
}

/** A glob match as core's tools list reads it: `*` is any run of characters. */
export function globMatches(pattern, name) {
  const re = new RegExp(`^${String(pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
  return re.test(name);
}

/** Tools lines that an earlier line shadows (first match wins in core), by index and match. */
export function shadowedTools(toolsLines) {
  const out = [];
  toolsLines.forEach((line, i) => {
    const name = probeName(line.match);
    const by = toolsLines.slice(0, i).findIndex((earlier) => globMatches(earlier.match, name));
    if (by !== -1 && String(toolsLines[by].class) !== String(line.class)) {
      out.push({ index: i, match: String(line.match), class: String(line.class), by: String(toolsLines[by].match), byClass: String(toolsLines[by].class) });
    }
  });
  return out;
}

/** The GATE line: the one line the release GATE carries verbatim. */
export function gateLine(meta, summary, extra = {}) {
  const findings = summary.blocking + (extra.shadowed ?? 0);
  const verdict = findings > 0 ? `FAIL ${String(findings)} BLOCKING` : "PASS";
  const moved = summary.blocking + summary.allowlisted + summary.changed;
  const overlay =
    meta.baselineOverlay === meta.overlay
      ? `overlay ${meta.overlay.slice(0, 12)}`
      : `overlay ${meta.baselineOverlay.slice(0, 12)} -> ${meta.overlay.slice(0, 12)}`;
  const byColumn = Object.entries(summary.columns ?? {})
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(", ");
  return (
    `CLASS-DIFF ${verdict}: core ${meta.baselineCore} (${meta.baselineLabel}) -> ${meta.core} (${meta.coreLabel}), ${overlay}; ` +
    `${String(summary.calls)} calls (${String(summary.recipes)} recipe runs + ${String(summary.harness)} harness calls); ` +
    (moved === 0
      ? "class-diff: none"
      : `${String(moved)} moved (${String(summary.blocking)} blocking, ${String(summary.allowlisted)} allowlisted, ${String(summary.changed)} changed)`) +
    `; ${String(summary.new)} new, ${String(summary.removed)} removed` +
    (byColumn === "" ? "" : `; blocking by column: ${byColumn}`) +
    ((extra.shadowed ?? 0) > 0 ? `; ${String(extra.shadowed)} newly shadowed tools line(s)` : "")
  );
}

function sideText(s) {
  if (s === null) return "-";
  const classes = s.classes.length > 0 ? s.classes.join("+") : s.code ?? "(no class)";
  const level = s.level && s.level !== "autonomous" ? ` [${s.level}]` : "";
  const style = s.style ? `, ${s.style} card` : "";
  const code = s.classes.length > 0 && s.code ? ` (${s.code})` : "";
  return `${classes}: ${s.decision}${level}${style}${code}`;
}

function cell(text) {
  const t = String(text).replace(/\|/gu, "\\|").replace(/`/gu, "'").replace(/\n/gu, " ");
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

export function renderDiff(meta, diff, extra = {}) {
  const out = [gateLine(meta, diff.summary, { shadowed: (extra.shadowed ?? []).length }), ""];
  out.push(`## Class-diff: approval.md core ${meta.baselineCore} -> ${meta.core}`, "");
  out.push(`- baseline: core ${meta.baselineCore} (${meta.baselineLabel}), overlay ${meta.overlayRepo}@${meta.baselineOverlay}`);
  out.push(`- candidate: core ${meta.core} (${meta.coreLabel}), overlay ${meta.overlayRepo}@${meta.overlay}`);
  out.push(
    "- every call through each core's real `approval hook hermes` in a box layout; recipes as terminal calls at $HERMES_HOME, $HOME, $HERMES_HOME/workspace and unset; harness calls as Hermes tool envelopes",
    "- BLOCKING: an existing call that ran and now runs with less autonomy or not at all, or whose card falls from minimal to technical (CLAIMS L15681 (1); S-4)",
    "",
  );
  for (const s of extra.shadowed ?? []) {
    out.push(`- BLOCKING: tools line ${String(s.index + 1)} (\`${s.match}\` -> ${s.class}) is shadowed by \`${s.by}\` -> ${s.byClass} (first match wins), newly in this template`);
  }
  if ((extra.shadowed ?? []).length > 0) out.push("");
  const moved = diff.rows.filter((r) => ["blocking", "allowlisted", "changed"].includes(r.status));
  if (moved.length === 0) out.push("class-diff: none (no existing call changes class, code, decision, autonomy or card style)", "");
  const columns = [...new Set(diff.rows.map((r) => r.column))];
  for (const column of columns) {
    const mine = diff.rows.filter((r) => r.column === column);
    const sections = [
      ["blocking", "BLOCKING (fails the job)"],
      ["allowlisted", "Would block, allowlisted with Carter's acceptance"],
      ["changed", "Changed, not less autonomy (reported)"],
    ];
    const shown = mine.filter((r) => r.status !== "unchanged");
    if (shown.length === 0) continue;
    out.push(`## Column: ${column}`, "");
    for (const [status, title] of sections) {
      const rows = mine.filter((r) => r.status === status);
      if (rows.length === 0) continue;
      out.push(`### ${title}: ${String(rows.length)}`, "", "| call | where | old | new |", "|---|---|---|---|");
      for (const r of rows) out.push(`| \`${cell(r.command)}\` | ${cell(r.new.where)} | ${cell(sideText(r.old))} | ${cell(sideText(r.new))} |`);
      out.push("");
    }
    for (const [status, title, side] of [["new", "New calls (reported; a denied new recipe is the box check's)", "new"], ["removed", "Removed calls", "old"]]) {
      const rows = mine.filter((r) => r.status === status);
      if (rows.length === 0) continue;
      out.push(`### ${title}: ${String(rows.length)}`, "", "| call | where | at this side's core |", "|---|---|---|");
      for (const r of rows) out.push(`| \`${cell(r.command)}\` | ${cell(r[side].where)} | ${cell(sideText(r[side]))} |`);
      out.push("");
    }
  }
  out.push(`Unchanged: ${String(diff.summary.unchanged)} of ${String(diff.summary.calls)} calls.`, "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Loading and running
// ---------------------------------------------------------------------------

/** A core's functions from a package root that holds `dist/src`. */
export async function loadCore(root) {
  const dist = join(root, "dist", "src");
  for (const f of ["cli/hook.js", "cli/main.js", "core/policy-load.js", "core/policy-match.js"]) {
    if (!existsSync(join(dist, f))) throw new Error(`no build at ${join(dist, f)}; run \`npm run build\` there first`);
  }
  const hook = await import(pathToFileURL(join(dist, "cli", "hook.js")).href);
  const load = await import(pathToFileURL(join(dist, "core", "policy-load.js")).href);
  const match = await import(pathToFileURL(join(dist, "core", "policy-match.js")).href);
  const layoutPath = join(dist, "core", "prompt-layout.js");
  const layout = existsSync(layoutPath) ? await import(pathToFileURL(layoutPath).href) : {};
  return {
    root,
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    classifyForHook: hook.classifyForHook,
    loadPolicyText: load.loadPolicyText,
    resolve: match.resolve,
    harnessLaunchNeedsRule: match.harnessLaunchNeedsRule,
    promptStyleFor: layout.promptStyleFor,
    promptSayFor: layout.promptSayFor,
  };
}

/** Every call of a corpus through one core's real hook in a box, decided. */
export async function decideInBox({ core, corpus, overlayTree, boxRoot, toolsLines, concurrency = 1, harnessOnly = null, envelopes = [], proposals = [] }) {
  const load = loadCorpusPolicy(core.loadPolicyText, corpus);
  if (!load.ok) return { error: `the template policy did not load at core ${core.version}: ${load.code}: ${load.message}` };
  // A fixed sampling secret (fold 2): when the template names
  // `audit.sampling_secret_env`, the box exports it with a fixed dummy value, so
  // a supervised-live class is drawn (sampled vs card) as on a box that holds a
  // secret. When it names none (the overlay template today), live selection
  // fails closed and every live call cards, exactly as on a real box.
  const secretEnv = load.policy.audit?.sampling_secret_env;
  // A name that would replace the box layout or the runtime is refused by
  // runBox (fold 3, N-7), and the gate exits 2.
  const extraEnv = typeof secretEnv === "string" && secretEnv.length > 0 ? { [secretEnv]: "class-diff-fixed-sampling-value-not-a-secret" } : {};
  const ran = await runBox({ coreRoot: core.root, corpus, policyText: policyTextOf(corpus), overlayTree, boxRoot, toolsLines, concurrency, harnessOnly, extraEnv, envelopes, proposals });
  if ("error" in ran) return ran;
  for (const c of ran.calls) {
    if (cardWithoutHumanClass(core, load, c)) {
      const named = (c.requested ?? []).join(", ") || "no class";
      Object.assign(c, {
        verdict: "error",
        code: "card-request-no-human-class",
        detail: `the hook carded this call, but the request it bound to names ${named}, none of which needs a human at core ${core.version}; ${c.detail ?? ""}`.slice(0, 400),
      });
      continue;
    }
    const wrong = cardKeyClassMismatch(c);
    if (wrong.length === 0) continue;
    const rows = wrong.map((w) => `${String(w.key)} as ${String(w.cls ?? "no class")}`).join(", ");
    Object.assign(c, {
      verdict: "error",
      code: "card-request-class-mismatch",
      detail: `the hook carded this call, but request ${String(c.task)} logs ${rows}: a key names another class than its row, so the core logged a class other than the one it carded on (core ${core.version}); ${c.detail ?? ""}`.slice(0, 400),
    });
  }
  const bad = ran.calls.filter((c) => c.verdict === "error");
  if (bad.length > 0) return { error: `${String(bad.length)} hook run(s) ended in neither allow nor deny at core ${core.version}, e.g. ${bad[0].code}: ${bad[0].detail}` };
  // B-167N: a propose that neither answered nor refused is an error, as a hook run is.
  const proposed = (ran.proposed ?? []).map((p) => decideProposeCall(core, load, p));
  const badPropose = proposed.find((p) => p.decision === "error");
  if (badPropose !== undefined) return { error: `a daemon propose ended in neither an answer nor a refusal at core ${core.version} (${String(badPropose.key)}: ${String(badPropose.code)})` };
  return { calls: ran.calls.map((c) => decideBoxCall(core, load, c)), proposed, load };
}

/** The box check (S-1): recipes the hook denies at a real workdir, against the allowlist. */
export function boxHeld(calls, allowlist) {
  const entries = allowlist.entries.filter((e) => scopeOf(e) !== "neutral");
  const held = calls.filter((c) => c.kind === "recipe" && c.column !== "unset" && DENIES.has(c.decision));
  const listed = (c) => entries.find((e) => entryMatches(e, fileOf(c.where), c.command, c.column));
  return { held, unlisted: held.filter((c) => listed(c) === undefined), listedBy: listed };
}

/**
 * B-167N: the envelopes and proposes a box runs for the new-calls check: every
 * corpus envelope (with its declared input when an entry names it), and every
 * entry's propose. `onlyDeclared` keeps just the declared ones (the matrix).
 */
export function newCallJobs(c, validated, onlyDeclared = false) {
  const byKey = new Map(validated.entries.map((v) => [v.key, v]));
  const seen = new Set();
  const envelopes = [];
  for (const e of c.envelopes ?? []) {
    if (e.tool === null || seen.has(e.key)) continue;
    const v = byKey.get(e.key);
    if (onlyDeclared && v === undefined) continue;
    seen.add(e.key);
    envelopes.push({ key: e.key, tool: e.tool, input: v?.entry.input ?? e.input, where: e.where });
  }
  const proposals = validated.entries
    .filter((v) => v.entry.propose !== undefined && v.entry.propose !== null && typeof v.entry.propose === "object")
    .map((v) => ({ key: `${v.key}#propose`, cls: v.entry.propose.class, actionKey: v.entry.propose.key, summary: v.entry.propose.summary, payload: v.entry.propose.payload, where: v.entry.propose.source }));
  return { envelopes, proposals };
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
  const corpusPath = CORPUS();
  const allowlistPath = ALLOWLIST();
  if (!existsSync(corpusPath)) fail(`no corpus at ${corpusPath}`);
  const corpus = readJson(corpusPath, "the corpus");
  const allowlist = existsSync(allowlistPath) ? readJson(allowlistPath, "the allowlist") : { entries: [] };
  checkCorpusShape(corpus, corpusPath);
  const coreDir = resolvePath(arg("--core") ?? REPO_ROOT);
  const overlayTree = arg("--overlay-tree");
  const baselineDir = arg("--diff");
  const boxRoot = resolvePath(arg("--box-root") ?? tmpdir());
  // Hook runs at once per box; 1 (sequential) unless asked, so a loaded machine is not swamped.
  const concurrency = Number.parseInt(arg("--box-concurrency") ?? "1", 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail("--box-concurrency must be 1-16");
  // Tests only: limit the harness envelopes to these tool names (CI never passes it;
  // ci.yml pins this script and its own invocation).
  const harnessOnlyArg = arg("--harness-only");
  const harnessOnly = harnessOnlyArg === undefined ? null : harnessOnlyArg.split(",").filter(Boolean);
  if (baselineDir !== undefined && overlayTree === undefined) fail("--diff needs --overlay-tree: the diff runs in a box layout");
  let core;
  try {
    core = await loadCore(coreDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // 1. The corpus check (#663).
  const verdict = judge({ corpus, allowlist, classifyForHook: core.classifyForHook, loadPolicyText: core.loadPolicyText, resolve: core.resolve });
  if ("error" in verdict) fail(verdict.error);
  if (json) {
    process.stdout.write(`${JSON.stringify({ core: core.version, overlay: corpus.overlay.sha, ...verdict }, null, 2)}\n`);
  } else {
    const counts = new Map();
    for (const row of verdict.rows) {
      const key = row.ok ? [...new Set(row.classes)].sort().join("+") || "(no class)" : `refused:${row.code}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    process.stdout.write(
      `core ${core.version} vs overlay ${corpus.overlay.repo}@${corpus.overlay.sha.slice(0, 12)}: ${String(verdict.rows.length)} recipes, ${String(verdict.held.length)} human-only (${String(verdict.held.length - verdict.unlisted.length)} allowlisted), ${String(verdict.refused.length)} refused (reported, not gated)\n`,
    );
    for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      process.stdout.write(`  ${String(n).padStart(4)}  ${key}\n`);
    }
    for (const row of verdict.held) {
      const listedIn = verdict.unlisted.includes(row) ? "HELD" : "listed";
      process.stdout.write(`${listedIn}  ${row.where}  ${row.humanOnly.join(",")} (${row.rules.join(",")})\n        ${row.command}\n`);
    }
    for (const row of verdict.refused) process.stdout.write(`refused (info)  ${row.where}  ${row.code}\n`);
  }
  let bad = false;
  const complain = (message) => {
    bad = true;
    process.stderr.write(`${message}\n`);
  };
  for (const entry of verdict.stale) complain(`stale allowlist entry (no held recipe matches it any more; delete it): ${entry.file}: ${entry.command}`);
  for (const entry of allowlist.entries) {
    for (const e of acceptanceErrors(entry)) complain(`allowlist entry ${entry.file}: ${entry.command}: ${e}`);
  }
  if (verdict.unlisted.length > 0) {
    complain(
      `${String(verdict.unlisted.length)} overlay recipe(s) resolve to a human-only class under this core and are not allowlisted. ` +
        "An agent following them would be denied outright (EDGEOS-BLOCK). Fix the classifier, get the overlay recipe changed, " +
        "or list the recipe in the allowlist with its reason and Carter's acceptance.",
    );
  }
  const used = new Set();
  for (const row of verdict.held) {
    const entry = allowlist.entries.find((e) => scopeOf(e) !== "box" && entryMatches(e, fileOf(row.where), row.command));
    if (entry !== undefined) used.add(entry);
  }

  // 4. B-167N: the new-calls check's inputs, read before any box runs.
  const expectedPath = arg("--expected");
  let validated;
  let tagCorpus;
  if (expectedPath !== undefined) {
    if (overlayTree === undefined) fail("--expected needs --overlay-tree: the new-calls check runs in a box layout");
    const tagPath = arg("--tag-corpus");
    if (tagPath === undefined) fail("--expected needs --tag-corpus, the corpus at the previous release (P3)");
    if (!existsSync(tagPath)) fail(`no tag corpus at ${tagPath}`);
    tagCorpus = readJson(tagPath, "the tag corpus");
    checkCorpusShape(tagCorpus, tagPath);
    if (!Array.isArray(corpus.envelopes) || !Array.isArray(tagCorpus.envelopes)) fail("--expected needs corpora extracted with --with-envelopes (3a/3b)");
    if (!existsSync(expectedPath)) fail(`no expected.json at ${expectedPath}`);
    validated = validateExpected(readJson(expectedPath, "expected.json"));
  }
  const jobsFor = (c, onlyDeclared = false) => (validated === undefined ? { envelopes: [], proposals: [] } : newCallJobs(c, validated, onlyDeclared));

  // 2. The box check, and 3. the diff.
  if (overlayTree !== undefined) {
    const toolsBaseline = [];
    let baselineCore;
    let baselineCorpus;
    if (baselineDir !== undefined) {
      const baselinePath = arg("--baseline-corpus") ?? corpusPath;
      if (!existsSync(baselinePath)) fail(`no baseline corpus at ${baselinePath}`);
      baselineCorpus = readJson(baselinePath, "the baseline corpus");
      checkCorpusShape(baselineCorpus, baselinePath);
      try {
        baselineCore = await loadCore(resolvePath(baselineDir));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      const bl = loadCorpusPolicy(baselineCore.loadPolicyText, baselineCorpus);
      if (!bl.ok) fail(`the baseline template policy did not load: ${bl.code}: ${bl.message}`);
      toolsBaseline.push(...(bl.policy.tools ?? []));
    }
    const cl = loadCorpusPolicy(core.loadPolicyText, corpus);
    if (!cl.ok) fail(`the template policy did not load: ${cl.code}: ${cl.message}`);
    const toolsCandidate = cl.policy.tools ?? [];
    const toolsLines = [...toolsCandidate, ...toolsBaseline];
    const after = await decideInBox({ core, corpus, overlayTree: resolvePath(overlayTree), boxRoot, toolsLines, concurrency, harnessOnly, ...jobsFor(corpus) });
    if ("error" in after) fail(after.error);

    const box = boxHeld(after.calls, allowlist);
    for (const c of box.held) {
      const entry = box.listedBy(c);
      if (entry !== undefined) used.add(entry);
    }
    if (!json) {
      process.stdout.write(
        `box check (real hook, box layout) at core ${core.version}: ${String(box.held.length)} recipe run(s) denied at $HERMES_HOME, $HOME or workspace, ${String(box.unlisted.length)} not allowlisted\n`,
      );
      for (const c of box.unlisted) process.stdout.write(`BOX-HELD  ${c.column}  ${c.where}  ${c.decision} (${c.code})\n        ${c.command}\n`);
    }
    if (box.unlisted.length > 0) {
      complain(
        `${String(box.unlisted.length)} shipped recipe run(s) are denied by the real hook in the box layout (human-only or refused) and are not allowlisted (B-167 S-1). ` +
          "Fix the classifier or the recipe, or list it with its reason and Carter's acceptance.",
      );
    }

    const movedKeys = new Set();
    let md = null;
    let diffDoc = null;
    if (baselineDir !== undefined) {
      const baselineTree = resolvePath(arg("--baseline-overlay-tree") ?? overlayTree);
      const before = await decideInBox({ core: baselineCore, corpus: baselineCorpus, overlayTree: baselineTree, boxRoot, toolsLines, concurrency, harnessOnly, ...jobsFor(baselineCorpus) });
      if ("error" in before) fail(before.error);
      const diff = diffCalls(before.calls, after.calls, allowlist);
      // B-167N (P3): CHANGED includes every call this diff moved; the new-calls
      // check reads it from here and never re-derives it.
      for (const row of diff.rows) {
        if (!["blocking", "allowlisted", "changed"].includes(row.status)) continue;
        if (row.kind === "recipe") movedKeys.add(recipeKey(fileOf(row.where), row.command));
        if (row.kind === "envelope") movedKeys.add(row.command);
      }
      for (const p of after.proposed ?? []) {
        const was = (before.proposed ?? []).find((b) => b.key === p.key);
        if (was !== undefined && (was.decision !== p.decision || (was.style ?? null) !== (p.style ?? null))) movedKeys.add(p.key.replace(/#propose$/u, ""));
      }
      for (const row of diff.rows) {
        if (row.status !== "allowlisted") continue;
        const entry = allowlistedFlip(allowlist, row);
        if (entry !== undefined) used.add(entry);
      }
      const shadowedBefore = new Set(shadowedTools(toolsBaseline).map((s) => `${s.match}\u0000${s.class}`));
      const shadowed = shadowedTools(toolsCandidate).filter((s) => !shadowedBefore.has(`${s.match}\u0000${s.class}`));
      const meta = {
        core: core.version,
        baselineCore: baselineCore.version,
        coreLabel: arg("--core-label") ?? coreDir,
        baselineLabel: arg("--baseline-label") ?? resolvePath(baselineDir),
        overlay: corpus.overlay.sha,
        baselineOverlay: baselineCorpus.overlay.sha,
        overlayRepo: corpus.overlay.repo,
      };
      md = renderDiff(meta, diff, { shadowed });
      if (!json) process.stdout.write(`\n${md}`);
      diffDoc = { gate: gateLine(meta, diff.summary, { shadowed: shadowed.length }), meta, shadowed, boxHeld: box.held, ...diff };
      if (diff.summary.blocking > 0) {
        complain(
          `${String(diff.summary.blocking)} shipped call run(s) lose autonomy or stop running between core ${meta.baselineCore} and ${meta.core} (EDGEOS-BLOCK, S-4). ` +
            "Fix the classifier, change the overlay first, or have Carter accept the move by name in the allowlist.",
        );
      }
      if (shadowed.length > 0) complain(`${String(shadowed.length)} tools line(s) are newly shadowed by an earlier line (first match wins): the later line never decides anything`);
    }
    // 4. B-167N: the new-calls check, at this core, under the village default
    // and in every matrix cell (P2).
    if (validated !== undefined) {
      const declared = new Set(validated.entries.map((v) => v.key));
      const declaredRecipes = corpus.recipes.filter((r) => declared.has(recipeKey(fileOf(r.where), r.command)));
      const classes = validated.entries.flatMap((v) => [v.entry.class, v.entry.propose?.class]).filter((c) => typeof c === "string");
      const only = jobsFor(corpus, true);
      const cells = {};
      if (declaredRecipes.length + only.envelopes.length + only.proposals.length > 0) {
        for (const cell of CELLS) {
          const variant = variantBlock(corpus.policy.block, classes, cell);
          if ("error" in variant) fail(`matrix ${cell}: ${variant.error}`);
          const vc = { ...corpus, policy: { ...corpus.policy, block: variant.block }, recipes: declaredRecipes };
          const run = await decideInBox({ core, corpus: vc, overlayTree: resolvePath(overlayTree), boxRoot, toolsLines: [], concurrency, harnessOnly: [], ...only });
          if ("error" in run) fail(`matrix ${cell}: ${run.error}`);
          cells[cell] = run;
        }
      }
      const result = judgeNewCalls({ corpus, tagCorpus, validated, head: after, cells, movedKeys, autonomyOf: (cls) => core.resolve(after.load, cls).autonomy });
      const meta = { core: core.version, tagLabel: arg("--tag-label") ?? `overlay ${tagCorpus.overlay.sha.slice(0, 12)}` };
      const nmd = renderNewCalls(meta, result, validated);
      if (!json) process.stdout.write(`\n${nmd}`);
      md = md === null ? nmd : `${md}\n${nmd}`;
      diffDoc = { ...diffDoc, newCalls: { line: newCallsLine(meta, result.summary), ...result } };
      if (result.findings.length > 0) {
        complain(
          `${String(result.findings.length)} new-calls finding(s) (B-167N): a new or changed call with no declared outcome, an outcome other than declared, ` +
            "a limiting entry without Carter's acceptance, or a stale entry. Declare the call in expected.json, fix the call, or have Carter accept it by name.",
        );
      }
    }
    const mdOut = arg("--md");
    if (mdOut !== undefined && md !== null) writeFileSync(mdOut, md, "utf8");
    const jsonOut = arg("--diff-json");
    if (jsonOut !== undefined && diffDoc !== null) writeFileSync(jsonOut, `${JSON.stringify(diffDoc, null, 2)}\n`, "utf8");
    // An entry nothing used is stale (box and any scopes; neutral ones above).
    for (const entry of allowlist.entries) {
      if (scopeOf(entry) === "neutral" || used.has(entry)) continue;
      complain(`stale allowlist entry (nothing held or blocked matches it; delete it): ${entry.file}: ${entry.command}`);
    }
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] !== undefined && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url) await main();
