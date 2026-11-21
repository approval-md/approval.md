/**
 * The NEW-CALLS check (B-167N, Carter's ruling CLAIMS L17349 and L17375; spec
 * approval L17350; review-b's pre-refute folds P1-P7, L17356).
 *
 * approval.md must never limit existing functionality OR a new capability.
 * B-167's CLASS-DIFF covers the calls the boxes already run. This covers the
 * new ones: every call that is NEW or CHANGED at the candidate against the
 * previous release (P3), whether a shell recipe or a harness-tool envelope
 * (SPEC 1; the extractor's 3a/3b scope), needs a declared outcome in the
 * author's repo (the overlay's scripts/approval-class-diff/expected.json, keyed
 * by the B-167 key: file + normalised command, or the envelope key), and the
 * real hook of the pinned core, in the box layout, under the village default
 * template, must give exactly that outcome.
 *
 * An entry declares (SPEC 2, P2):
 * - `file` + `command` (a recipe) or `tool` + `input` (an envelope, the
 *   realistic input the box sends; P6: it must validate against the plugin's
 *   registered schema and carry the manifest-derived call, P5);
 * - `class`, `decision` (auto | sampled | card | deny | human-only | refused),
 *   `card_style: minimal` whenever decision is card or sampled, and
 *   `template: "village default"`;
 * - `matrix`: the decision under each resident setting for its class(es), the
 *   cells `ask`, `autonomous`, `supervised-retro`, `supervised-live` and
 *   `manual` (P2). supervised-live is drawn with a fixed sampling secret, so a
 *   cell never flaps (the drawn side is reported as sampled:card or
 *   sampled:skip);
 * - optionally `propose`: the plugin's own daemon propose behind the call (a For
 *   Kicks order proposes marketplace.app.action from _forkicks.py), with its own
 *   class, action key, payload, decision, card_style and matrix;
 * - `reason`, `owner`; and, when the entry is LIMITING (P1: any layer's decision
 *   stricter than auto under the village default, or any layer's class whose
 *   template default autonomy is manual), `accepted_by: "human:carter"` exactly
 *   and an `accepted_at` date. A limiting entry without them fails.
 *
 * It BLOCKS (SPEC 3) when: a NEW or CHANGED call has no entry (never "info");
 * the actual class differs; the actual decision differs (an expected card that
 * runs auto is hazard B, a capability loss); the call is denied, refused,
 * unclassified or opaque and was not declared with Carter's acceptance; a card
 * is technical (an undeclared say entry, or for a propose an unlisted payload
 * key); a matrix cell's decision differs; an entry is stale or duplicated (P4);
 * an envelope input fails its tool's schema (P6).
 *
 * Pure but for the core functions it is handed.
 */

import { envelopeKey, envelopeKeyErrors } from "./overlay-recipes-box.mjs";

export const VILLAGE_DEFAULT = "village default";
export const CELLS = ["ask", "autonomous", "supervised-retro", "supervised-live", "manual"];
/** The columns a recipe is judged at: a real workdir (the box check's columns; `unset` is reported only). */
export const REAL_COLUMNS = ["hermes-home", "home", "workspace"];
export const DECLARABLE = ["auto", "sampled", "card", "deny", "human-only", "refused"];
const CELL_DECISIONS = ["auto", "sampled", "card", "human-only", "refused"];
const DENY = new Set(["human-only", "refused"]);
/** P1: Carter's ruling, his name. Not any human:<id>. */
export const CARTER = "human:carter";
/** The fixed sampling secret's variable for the supervised-live cell (P2). Never a real secret. */
export const SAMPLING_SECRET_ENV = "CLASS_DIFF_SAMPLING_SECRET";
export const LIVE_RATE = 0.5;
const TRIVIAL_REASON = /^(ok|okay|fine|yes|n\/?a|todo|tbd|accepted|allow(ed)?|-+|\.+)$/iu;

export const normCommand = (command) => String(command).replace(/\s+/gu, " ").trim();
/** The B-167 key of a recipe: its file and its normalised command. */
export const recipeKey = (file, command) => `${file}\u0000${normCommand(command)}`;
export const keyLabel = (key) => String(key).replace("\u0000", ": ");
const fileOf = (where) => String(where).replace(/:\d+$/u, "");

export function entryKind(entry) {
  if (typeof entry?.file === "string" && typeof entry?.command === "string" && entry.tool === undefined) return "recipe";
  if (typeof entry?.tool === "string" && entry?.input !== null && typeof entry?.input === "object" && !Array.isArray(entry.input) && entry.file === undefined) return "envelope";
  return null;
}

export function entryKey(entry) {
  const kind = entryKind(entry);
  if (kind === "recipe") return recipeKey(entry.file, entry.command);
  if (kind === "envelope") return envelopeKey(entry.tool, entry.input);
  return null;
}

const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const reasonOk = (r) => typeof r === "string" && r.trim().length >= 12 && !TRIVIAL_REASON.test(r.trim());

function layerErrors(layer, at) {
  const errors = [];
  if (typeof layer.class !== "string" || !/^[a-z0-9][a-z0-9._-]*$/u.test(layer.class)) errors.push(`${at}class is not a class name`);
  if (!DECLARABLE.includes(layer.decision)) errors.push(`${at}decision "${String(layer.decision)}" is not one of ${DECLARABLE.join(", ")}`);
  if ((layer.decision === "card" || layer.decision === "sampled") && layer.card_style !== "minimal") {
    errors.push(`${at}card_style must be "minimal" when decision is ${String(layer.decision)} (APPROVAL-UX P0)`);
  }
  if (layer.card_style !== undefined && layer.card_style !== null && layer.card_style !== "minimal") errors.push(`${at}card_style "${String(layer.card_style)}" is not minimal`);
  const m = layer.matrix;
  if (m === null || typeof m !== "object" || Array.isArray(m)) errors.push(`${at}matrix is missing (P2: ${CELLS.join(", ")})`);
  else {
    const keys = Object.keys(m).sort();
    if (keys.join(",") !== [...CELLS].sort().join(",")) errors.push(`${at}matrix must name exactly ${CELLS.join(", ")}`);
    for (const cell of CELLS) if (m[cell] !== undefined && !CELL_DECISIONS.includes(m[cell])) errors.push(`${at}matrix.${cell} "${String(m[cell])}" is not one of ${CELL_DECISIONS.join(", ")}`);
  }
  return errors;
}

/**
 * Validate expected.json: the shape of every entry, and no two entries for one
 * key (P4). Returns `{ entries: [{ entry, kind, key }], errors: [{ key, message }] }`.
 */
export function validateExpected(doc) {
  const errors = [];
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.entries)) return { entries: [], errors: [{ key: "(file)", message: "expected.json has no entries array" }] };
  const entries = [];
  const seen = new Map();
  doc.entries.forEach((entry, i) => {
    const kind = entryKind(entry);
    const key = entryKey(entry);
    const label = key === null ? `entries[${String(i)}]` : keyLabel(key);
    const err = (message) => errors.push({ key: label, message });
    if (kind === null) {
      err("an entry names either file + command (a recipe) or tool + input (an envelope)");
      return;
    }
    if (kind === "envelope" && key === null) {
      err(`no unambiguous envelope key: ${envelopeKeyErrors(entry.tool, entry.input).join("; ")}`);
      return;
    }
    if (seen.has(key)) err(`a second entry for this key (entries[${String(seen.get(key))}] and entries[${String(i)}]); one key, one declared outcome (P4)`);
    else seen.set(key, i);
    for (const e of layerErrors(entry, "")) err(e);
    if (entry.template !== VILLAGE_DEFAULT) err(`template must be "${VILLAGE_DEFAULT}"`);
    if (!reasonOk(entry.reason)) err(`its reason says nothing ("${String(entry.reason ?? "")}")`);
    if (typeof entry.owner !== "string" || entry.owner.trim() === "") err("owner (the PR that adds the call) is empty");
    if (entry.propose !== undefined) {
      const p = entry.propose;
      if (p === null || typeof p !== "object") err("propose is not an object");
      else {
        for (const e of layerErrors(p, "propose.")) err(e);
        if (typeof p.key !== "string" || typeof p.class !== "string" || !p.key.startsWith(`${p.class}:`)) err("propose.key must start with propose.class and a colon (the daemon's rule)");
        if (typeof p.summary !== "string" || p.summary.trim() === "") err("propose.summary is empty");
        if (p.payload === null || typeof p.payload !== "object" || Array.isArray(p.payload)) err("propose.payload is not an object");
        if (typeof p.source !== "string" || !/:\d+/u.test(p.source)) err("propose.source must cite the code that proposes (file:line)");
      }
    }
    entries.push({ entry, kind, key });
  });
  return { entries, errors };
}

/** The layers of an entry: the call the hook sees, then the plugin's own propose. */
export const layersOf = (entry) => [{ name: "hook", layer: entry }, ...(entry.propose !== undefined ? [{ name: "propose", layer: entry.propose }] : [])];

/**
 * P1: why an entry is LIMITING, from nothing the author declares but its
 * decision and class: a decision stricter than auto under the village default,
 * or a class whose template default autonomy is manual. Empty = not limiting.
 */
export function limitingReasons(entry, autonomyOf) {
  const out = [];
  for (const { name, layer } of layersOf(entry)) {
    if (layer.decision !== "auto") out.push(`${name} decision ${String(layer.decision)}`);
    if (typeof layer.class === "string" && autonomyOf(layer.class) === "manual") out.push(`${name} class ${layer.class} defaults to manual`);
  }
  return out;
}

/** P1: a limiting entry's acceptance, by Carter's name exactly. Empty = accepted. */
export function acceptanceErrorsN(entry) {
  const errors = [];
  if (entry.accepted_by !== CARTER) errors.push(`awaiting acceptance: accepted_by must be "${CARTER}" (it is ${JSON.stringify(entry.accepted_by ?? null)})`);
  if (!isDate(entry.accepted_at)) errors.push(`awaiting acceptance: accepted_at ${JSON.stringify(entry.accepted_at ?? null)} is not a YYYY-MM-DD date (Carter fills it)`);
  if (!reasonOk(entry.reason)) errors.push("a limiting entry needs a reason that says why");
  return errors;
}

// ---------------------------------------------------------------------------
// P6: a JSON Schema subset, enough for a plugin's registered input schema.
// Fails closed: a keyword it does not know is an error, never a pass.
// ---------------------------------------------------------------------------

const KNOWN = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "anyOf", "pattern", "description", "title", "$schema", "default"]);
const typeOk = (t, v) =>
  t === "null" ? v === null
  : t === "array" ? Array.isArray(v)
  : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v)
  : t === "integer" ? Number.isInteger(v)
  : t === "number" ? typeof v === "number" && Number.isFinite(v)
  : typeof v === t;

export function schemaErrors(schema, value, at = "input") {
  if (schema === null || typeof schema !== "object") return [`${at}: no schema`];
  const errors = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) errors.push(`${at}: schema keyword ${k} is not supported here (fail closed)`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) return [...errors, `${at}: ${JSON.stringify(value)} is not ${types.join(" | ")}`];
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} is not in its enum`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: not the const`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) errors.push(`${at}: shorter than ${String(schema.minLength)}`);
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) errors.push(`${at}: longer than ${String(schema.maxLength)}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below ${String(schema.minimum)}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above ${String(schema.maximum)}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: fewer than ${String(schema.minItems)} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${at}: more than ${String(schema.maxItems)} items`);
    if (schema.items !== undefined) value.forEach((v, i) => errors.push(...schemaErrors(schema.items, v, `${at}[${String(i)}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(value, r)) errors.push(`${at}: required ${r} is missing`);
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) errors.push(...schemaErrors(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: ${k} is not a property of the schema`);
      else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") errors.push(...schemaErrors(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => schemaErrors(s, value, at).length === 0)) errors.push(`${at}: matches none of its anyOf`);
  return errors;
}

/** Every derived (manifest) input key is in the entry's input with the same value (P5). */
export function carriesDerived(derived, input) {
  return Object.entries(derived ?? {}).filter(([k, v]) => JSON.stringify(input?.[k]) !== JSON.stringify(v)).map(([k]) => k);
}

// ---------------------------------------------------------------------------
// The matrix (P2): the template with an entry's classes set to one cell.
// ---------------------------------------------------------------------------

const ROW = {
  ask: "autonomy: manual",
  autonomous: "autonomy: autonomous",
  "supervised-retro": "autonomy: supervised-retro",
  "supervised-live": `autonomy: supervised-live, live_rate: ${String(LIVE_RATE)}`,
  manual: "autonomy: manual",
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The village default template with each of `classes` set to `cell`, other
 * flags on the row (agent_may_request) kept. `ask` is the resident's ask for
 * the class (its row manual); `manual` is the whole policy manual (defaults and
 * the row); `supervised-live` also names the fixed sampling secret so the draw
 * is deterministic. Returns `{ block }` or `{ error }` (fail closed).
 */
export function variantBlock(block, classes, cell) {
  if (!Object.prototype.hasOwnProperty.call(ROW, cell)) return { error: `no cell ${cell}` };
  // Only the top-level classes: block is rewritten (a say entry of the same
  // class name under channels: must never be touched).
  const head = block.match(/^classes:[ \t]*\n/mu);
  if (head === null || head.index === undefined) return { error: "the template has no classes: block" };
  const start = head.index + head[0].length;
  const rest = block.slice(start);
  const next = rest.search(/^\S/mu);
  let rows = next === -1 ? rest : rest.slice(0, next);
  const tail = next === -1 ? "" : rest.slice(next);
  for (const cls of [...new Set(classes)].sort()) {
    const re = new RegExp(`^([ \\t]+)${escapeRe(cls)}:([ \\t]*)\\{([^}\\n]*)\\}`, "mu");
    const m = rows.match(re);
    if (m !== null) {
      const kept = m[3].split(",").map((s) => s.trim()).filter((s) => s !== "" && !/^(autonomy|live_rate|supervision)\s*:/u.test(s));
      rows = rows.replace(re, `$1${cls}:$2{ ${[ROW[cell], ...kept].join(", ")} }`);
    } else {
      rows = `  ${cls}: { ${ROW[cell]} }\n${rows}`;
    }
  }
  let out = block.slice(0, start) + rows + tail;
  if (cell === "manual") {
    if (!/^ {2}autonomy:\s*\S+/mu.test(out)) return { error: "the template has no defaults.autonomy line" };
    out = out.replace(/^( {2}autonomy:)\s*\S+/mu, "$1 manual");
  }
  if (cell === "supervised-live" && !/^\s+sampling_secret_env:/mu.test(out)) {
    out = /^audit:\s*$/mu.test(out) ? out.replace(/^audit:\s*$/mu, `audit:\n  sampling_secret_env: ${SAMPLING_SECRET_ENV}`) : `${out}\naudit:\n  sampling_secret_env: ${SAMPLING_SECRET_ENV}`;
  }
  return { block: out };
}

// ---------------------------------------------------------------------------
// Deciding a propose, and judging a layer against its declaration.
// ---------------------------------------------------------------------------

const isLive = (core, load, cls) => {
  const r = core.resolve(load, cls);
  return r.autonomy === "supervised" && r.supervision === "live";
};

/**
 * The card a propose opens, as core 0.4.7's Telegram minimal card decides it
 * (src/channels/telegram-minimal.ts renderTelegramMinimal: the policy, anomaly,
 * undeclared, unlisted-key and nothing-quoted fallbacks), from the policy and
 * the payload alone. The too-long and truncated fallbacks need the rendering and
 * are not modelled.
 */
export function proposeCardStyle(core, load, cls, payload) {
  const style = typeof core.promptStyleFor === "function" ? core.promptStyleFor(load, "telegram") : "technical";
  if (style !== "minimal") return style;
  if (cls === "policy" || /^(policy|log)\./u.test(cls)) return "technical (policy)";
  const say = typeof core.promptSayFor === "function" ? core.promptSayFor(load, "telegram") : {};
  const entry = Object.prototype.hasOwnProperty.call(say, cls) ? say[cls] : undefined;
  if (entry === undefined || typeof entry?.does !== "string") return "technical (undeclared)";
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "technical (not an object)";
  const quote = entry.quote ?? {};
  const unlisted = Object.keys(payload).filter((k) => !Object.prototype.hasOwnProperty.call(quote, k));
  if (unlisted.length > 0) return `technical (unlisted-key: ${unlisted.sort().join(", ")})`;
  if (!Object.values(quote).some((v) => typeof v === "string")) return "technical (nothing-quoted)";
  if (core.resolve(load, cls).autonomy !== "manual") return "technical (anomaly: autonomy not manual)";
  return "minimal";
}

/** One propose answer, decided: decision, class, drawn side, card style. */
export function decideProposeCall(core, load, p) {
  const base = { key: p.key, kind: "propose", where: p.where, command: p.command, classes: [p.cls], code: p.code ?? null, answer: p.answer ?? null, style: null, drawn: null };
  if (p.verdict === "refused") return { ...base, decision: /human-only/u.test(String(p.code)) ? "human-only" : "refused" };
  if (p.verdict !== "answered") return { ...base, decision: "error" };
  const live = isLive(core, load, p.cls);
  let decision;
  let drawn = null;
  if (p.answer === "requested") {
    decision = live ? "sampled" : "card";
    drawn = live ? "card" : null;
  } else if (p.answer === "autonomous") decision = "auto";
  else if (p.answer === "supervised") {
    decision = live ? "sampled" : "auto";
    drawn = live ? "skip" : null;
  } else return { ...base, decision: "refused", code: `answer:${String(p.answer)}` };
  // A card is drawn only on a card, or a supervised-live draw that fell on the card side.
  const style = decision === "card" || drawn === "card" ? proposeCardStyle(core, load, p.cls, p.payload) : null;
  return { ...base, decision, drawn, style };
}

/** Does an actual decision meet a declared one ("deny" stands for human-only or refused). */
const decisionMeets = (declared, actual) => declared === actual || (declared === "deny" && DENY.has(actual));

/**
 * Judge one decided call against one layer's declaration, under the village
 * default (SPEC 3). Returns the reasons it blocks; empty = it matches.
 */
export function judgeLayer(layer, actual) {
  const out = [];
  if (actual === undefined) return ["the box ran no such call"];
  if (DENY.has(actual.decision) && !decisionMeets(layer.decision, actual.decision)) out.push(`denied (${String(actual.decision)}, ${String(actual.code)}) and not declared so with Carter's acceptance`);
  if (!DENY.has(actual.decision) && (actual.classes ?? []).length === 0) out.push("unclassified: the hook named no class");
  const cls = (actual.classes ?? []).join("+");
  if (!DENY.has(actual.decision) && cls !== "" && cls !== layer.class) out.push(`class ${cls}, declared ${String(layer.class)}`);
  if (!decisionMeets(layer.decision, actual.decision) && !(DENY.has(actual.decision) && out.length > 0)) {
    out.push(
      layer.decision === "card" && actual.decision === "auto"
        ? "an expected card runs auto (hazard B: a call whose code needs the card loses its capability)"
        : `decision ${String(actual.decision)}, declared ${String(layer.decision)}`,
    );
  }
  // A supervised-live draw on the skip side shows no card, so its style is moot.
  if ((actual.decision === "card" || (actual.decision === "sampled" && actual.drawn !== "skip")) && actual.style !== "minimal") out.push(`the card is ${String(actual.style)}, not minimal`);
  return out;
}

const outcomeText = (a) =>
  a === undefined ? "-" : `${(a.classes ?? []).join("+") || "(no class)"}: ${String(a.decision)}${a.drawn ? `:${a.drawn}` : ""}${a.style ? `, ${a.style} card` : ""}${a.code && DENY.has(a.decision) ? ` (${a.code})` : ""}`;

/**
 * The NEW / CHANGED set against the previous release's corpus (P3): NEW is a key
 * absent there; CHANGED is the same key with other command bytes (or another
 * derived envelope input), or a call B-167's diff moved between the base core
 * and this one (`movedKeys`, read from that diff, never re-derived).
 */
export function changeSet({ corpus, tagCorpus, movedKeys = new Set() }) {
  const tagRecipes = new Map();
  for (const r of tagCorpus.recipes ?? []) {
    const k = recipeKey(fileOf(r.where), r.command);
    if (!tagRecipes.has(k)) tagRecipes.set(k, new Set());
    tagRecipes.get(k).add(r.command);
  }
  const tagEnvelopes = new Map((tagCorpus.envelopes ?? []).map((e) => [e.key, e]));
  const status = new Map();
  const duplicates = [];
  for (const side of [corpus, tagCorpus]) {
    const seen = new Set();
    for (const e of side.envelopes ?? []) {
      if (typeof e.key !== "string" || e.key === "") duplicates.push({ key: String(e.key), where: e.where, why: "an envelope with no key" });
      else if (seen.has(e.key)) duplicates.push({ key: e.key, where: e.where, why: `a second envelope with this key in the ${side === corpus ? "head" : "previous release's"} corpus` });
      else seen.add(e.key);
    }
  }
  for (const r of corpus.recipes ?? []) {
    const k = recipeKey(fileOf(r.where), r.command);
    if (status.has(k)) continue;
    const at = tagRecipes.get(k);
    if (at === undefined) status.set(k, { kind: "recipe", status: "new", where: r.where, command: r.command });
    else if (!at.has(r.command)) status.set(k, { kind: "recipe", status: "changed (bytes)", where: r.where, command: r.command });
    else if (movedKeys.has(k)) status.set(k, { kind: "recipe", status: "changed (core move)", where: r.where, command: r.command });
    else status.set(k, { kind: "recipe", status: "unchanged", where: r.where, command: r.command });
  }
  for (const e of corpus.envelopes ?? []) {
    if (status.has(e.key)) continue; // a duplicate: reported in `duplicates`, which fails the run
    const at = tagEnvelopes.get(e.key);
    const st =
      at === undefined ? "new"
      : JSON.stringify(at.input) !== JSON.stringify(e.input) || (at.tool ?? null) !== (e.tool ?? null) ? "changed (bytes)"
      : movedKeys.has(e.key) ? "changed (core move)"
      : "unchanged";
    status.set(e.key, { kind: "envelope", status: st, where: e.where, command: e.key, envelope: e });
  }
  status.duplicates = duplicates;
  return status;
}

/**
 * The whole check over decided box results. `head` is `{ calls, proposed }` at
 * the head core under the village default; `cells` maps each matrix cell to the
 * same over the entries' calls; `autonomyOf(cls)` is the template default's
 * resolved autonomy. Returns `{ rows, findings, summary }`; any finding is rc 1.
 */
export function judgeNewCalls({ corpus, tagCorpus, validated, head, cells = {}, movedKeys = new Set(), autonomyOf }) {
  const findings = [];
  const find = (key, message) => findings.push({ key: keyLabel(key), message });
  for (const e of validated.errors) findings.push({ key: e.key, message: e.message });
  const status = changeSet({ corpus, tagCorpus, movedKeys });
  // Security fold: two envelopes sharing a key would let one call stand for another; fail, never skip.
  for (const d of status.duplicates ?? []) findings.push({ key: d.key, message: `${d.why} (${String(d.where)}); one key, one call` });
  const byKey = new Map(validated.entries.map((v) => [v.key, v]));
  const tools = new Map((corpus.tools ?? []).map((t) => [t.name, t]));
  for (const u of corpus.tools_unread ?? []) findings.push({ key: `${u.plugin}:${u.file}:${String(u.line)}`, message: `a gated plugin tool registration the extractor cannot read (${u.why}); fail closed` });

  const recipeCalls = (key, calls) => calls.filter((c) => c.kind === "recipe" && recipeKey(fileOf(c.where), c.command) === key);
  const envelopeCall = (key, calls) => calls.find((c) => c.kind === "envelope" && c.command === key);
  const proposeOf = (key, proposed) => proposed.find((p) => p.key === `${key}#propose`);

  const rows = [];
  for (const [key, st] of status) {
    const v = byKey.get(key);
    if (v === undefined) {
      if (st.status !== "unchanged") {
        const what = st.envelope?.unmapped ? `opaque: ${st.envelope.unmapped}` : "no declared outcome in expected.json";
        find(key, `${st.status} call with ${what} (undeclared = block)`);
        rows.push({ key, kind: st.kind, status: st.status, where: st.where, entry: false, outcome: st.kind === "recipe" ? outcomeText(recipeCalls(key, head.calls).find((c) => c.column === "hermes-home")) : outcomeText(envelopeCall(key, head.calls)), blocks: [what] });
      }
      continue;
    }
    const { entry } = v;
    const blocks = [];
    // Default cell, every layer.
    const hookActual = v.kind === "recipe" ? recipeCalls(key, head.calls).filter((c) => REAL_COLUMNS.includes(c.column)) : [envelopeCall(key, head.calls)];
    for (const a of hookActual) for (const b of judgeLayer(entry, a)) blocks.push(`${a?.column ?? "envelope"}: ${b}`);
    if (v.kind === "recipe" && hookActual.length === 0) blocks.push("the box ran no such recipe");
    if (entry.propose !== undefined) for (const b of judgeLayer(entry.propose, proposeOf(key, head.proposed))) blocks.push(`propose: ${b}`);
    // P6 / P5: an envelope's input against the tool's registered schema and the manifest's call.
    if (v.kind === "envelope") {
      const t = tools.get(entry.tool);
      if (t === undefined) blocks.push(`${entry.tool} is no gated plugin tool the extractor found`);
      else if (t.schema === null) blocks.push(`${entry.tool}'s registered schema could not be read (fail closed)`);
      else blocks.push(...schemaErrors(t.schema, entry.input).map((e) => `schema (P6): ${e}`));
      const missing = carriesDerived(st.envelope?.input, entry.input);
      if (missing.length > 0) blocks.push(`input does not carry the manifest's call (${missing.join(", ")}) (P5)`);
    }
    // P1.
    const limiting = limitingReasons(entry, autonomyOf);
    if (limiting.length > 0) for (const e of acceptanceErrorsN(entry)) blocks.push(`LIMITING (${limiting.join("; ")}): ${e}`);
    // P2: the matrix, decision per cell.
    const matrix = {};
    for (const cell of CELLS) {
      const run = cells[cell];
      if (run === undefined) continue;
      const cellCalls = v.kind === "recipe" ? recipeCalls(key, run.calls).filter((c) => REAL_COLUMNS.includes(c.column)) : [envelopeCall(key, run.calls)];
      matrix[cell] = { hook: cellCalls.map(outcomeText).filter((x, i, a) => a.indexOf(x) === i).join(" / ") };
      for (const a of cellCalls) if (a === undefined || !decisionMeets(entry.matrix?.[cell], a.decision)) blocks.push(`matrix ${cell}: ${a?.column ?? "envelope"} ${a === undefined ? "not run" : String(a.decision)}, declared ${String(entry.matrix?.[cell])}`);
      if (entry.propose !== undefined) {
        const p = proposeOf(key, run.proposed);
        matrix[cell].propose = outcomeText(p);
        if (p === undefined || !decisionMeets(entry.propose.matrix?.[cell], p.decision)) blocks.push(`matrix ${cell}: propose ${p === undefined ? "not run" : String(p.decision)}, declared ${String(entry.propose.matrix?.[cell])}`);
      }
    }
    for (const b of blocks) find(key, b);
    rows.push({
      key,
      kind: v.kind,
      status: st.status,
      where: st.where,
      entry: true,
      limiting,
      outcome: v.kind === "recipe" ? hookActual.map(outcomeText).filter((x, i, a) => a.indexOf(x) === i).join(" / ") : outcomeText(hookActual[0]),
      propose: entry.propose !== undefined ? outcomeText(proposeOf(key, head.proposed)) : null,
      declared: `${entry.class}: ${entry.decision}${entry.card_style ? `, ${entry.card_style} card` : ""}`,
      declaredPropose: entry.propose !== undefined ? `${entry.propose.class}: ${entry.propose.decision}${entry.propose.card_style ? `, ${entry.propose.card_style} card` : ""}` : null,
      matrix,
      blocks,
    });
  }
  // P4: an entry whose call no longer exists.
  for (const v of validated.entries) {
    if (!status.has(v.key)) find(v.key, "stale: no recipe or envelope with this key in the corpus any more; delete the entry (P4: a re-added call never inherits an old acceptance)");
  }
  const count = (s) => [...status.values()].filter((x) => x.status === s).length;
  const summary = {
    new: count("new"),
    changedBytes: count("changed (bytes)"),
    changedCore: count("changed (core move)"),
    entries: validated.entries.length,
    undeclared: rows.filter((r) => !r.entry).length,
    blocking: findings.length,
  };
  return { rows, findings, summary };
}

export function newCallsLine(meta, summary) {
  const verdict = summary.blocking > 0 ? `FAIL ${String(summary.blocking)} BLOCKING` : "PASS";
  return (
    `NEW-CALLS ${verdict}: core ${meta.core}, village default template, base ${meta.tagLabel}; ` +
    `${String(summary.new)} new, ${String(summary.changedBytes + summary.changedCore)} changed (${String(summary.changedBytes)} bytes, ${String(summary.changedCore)} core move); ` +
    `${String(summary.entries)} declared, ${String(summary.undeclared)} undeclared`
  );
}

/** P7: the pinned live decision line, `class | decision | card_style | core version | tool/command key`. */
export function decisionLine(cls, decision, style, core, key) {
  return `${cls} | ${decision} | ${style ?? "none"} | ${core} | ${key}`;
}

const cellText = (t) => String(t).replace(/\|/gu, "\\|").replace(/`/gu, "'").replace(/\n/gu, " ");

export function renderNewCalls(meta, result, validated) {
  const out = [newCallsLine(meta, result.summary), "", `## New calls: core ${meta.core} vs ${meta.tagLabel}`, ""];
  out.push(
    "- NEW = a key absent at the previous release; CHANGED = other command bytes, or a call B-167's diff moved between the cores (P3)",
    "- every NEW or CHANGED call needs a declared outcome in expected.json; each declared call must get exactly it under the village default and in every matrix cell (P2)",
    "",
  );
  if (result.findings.length > 0) {
    out.push(`### BLOCKING: ${String(result.findings.length)}`, "");
    for (const f of result.findings) out.push(`- \`${cellText(f.key)}\`: ${cellText(f.message)}`);
    out.push("");
  }
  out.push("### Calls", "", "| call | status | declared | at this core | propose declared | propose at this core |", "|---|---|---|---|---|---|");
  for (const r of result.rows) {
    out.push(`| \`${cellText(keyLabel(r.key))}\` | ${r.status}${r.limiting?.length ? " (LIMITING)" : ""} | ${cellText(r.declared ?? "(none)")} | ${cellText(r.outcome)} | ${cellText(r.declaredPropose ?? "-")} | ${cellText(r.propose ?? "-")} |`);
  }
  out.push("");
  const withMatrix = result.rows.filter((r) => r.entry && Object.keys(r.matrix ?? {}).length > 0);
  if (withMatrix.length > 0) {
    out.push("### Settings matrix (P2; supervised-live drawn with a fixed secret)", "", `| call | ${CELLS.join(" | ")} |`, `|---|${CELLS.map(() => "---").join("|")}|`);
    for (const r of withMatrix) {
      out.push(`| \`${cellText(keyLabel(r.key))}\` | ${CELLS.map((c) => cellText([r.matrix[c]?.hook, r.matrix[c]?.propose ? `propose ${r.matrix[c].propose}` : null].filter(Boolean).join("; ") || "-")).join(" | ")} |`);
    }
    out.push("");
  }
  out.push("### Expected live decision lines (P7: `class | decision | card_style | core version | tool/command key`)", "", "```");
  for (const { entry, key } of validated.entries) {
    out.push(decisionLine(entry.class, entry.decision, entry.card_style ?? null, meta.core, entry.command ?? key));
    if (entry.propose !== undefined) out.push(decisionLine(entry.propose.class, entry.propose.decision, entry.propose.card_style ?? null, meta.core, entry.propose.key));
  }
  out.push("```", "");
  return out.join("\n");
}
