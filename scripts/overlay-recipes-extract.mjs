#!/usr/bin/env bun
/**
 * Refresh the pinned overlay recipe corpus (0.4.7, EDGEOS-BLOCK, brief item D).
 *
 * The corpus is what `scripts/overlay-recipes-check.mjs` runs through
 * `classifyForHook` before a release: every shell recipe the overlay
 * (Edge-City/agentvillage) ships to its agents, extracted the way the overlay's
 * own EDGEOS-BLOCK test extracts them (`scripts/tests/fetch-url-shape.test.ts`,
 * `agentFacingRecipes` and `recipesIn`, added by agentvillage #427):
 *
 * - every `.md` and `.txt` file under `skills/` and `workspace/`, skipping
 *   `node_modules` and dot entries;
 * - in each, every command in a fenced block whose language is empty, `sh`,
 *   `bash`, `shell`, `zsh` or `console` (continuation lines joined, a leading
 *   `$ ` prompt dropped, `#` comment lines skipped), and every inline
 *   backticked span that starts with `curl ` or `wget ` outside a fence;
 * - the inline cron prompts, `DIGEST_CRON_SPECS[].promptBody` from
 *   `install/install_index.ts`, read as plain text (inline spans only).
 *
 * `recipesIn` below is the overlay's function, copied verbatim but for types,
 * so a refresh extracts exactly what the overlay's test reads. Files are walked
 * in sorted order so a refresh at the same sha writes the same bytes.
 *
 * It also vendors the overlay's template policy block
 * (`skills/approval/templates/APPROVAL.md`, the ```yaml approval-policy fence),
 * so the check resolves classes with this repository's own resolver against the
 * policy the boxes render, at the same sha.
 *
 * Run with bun (the cron specs are TypeScript with extensionless imports), on a
 * read-only export of the overlay at the sha being pinned; it never touches the
 * overlay's own checkout:
 *
 *   git -C <agentvillage> archive <sha> skills workspace install | tar -x -C <dir>
 *   bun scripts/overlay-recipes-extract.mjs --overlay <dir> --sha <sha>
 *
 * It writes `scripts/overlay-recipes/corpus.json` (or `--out`). Commit it with the sha it
 * names; the check never fetches anything.
 *
 * B-167N (`--with-envelopes`, the overlay's class-diff passes it; the export must
 * then also hold `mini-apps` and `plugins`): the corpus also carries the calls
 * that are not shell, each as the exact Hermes tool envelope the hook sees:
 * every mini-app manifest operation (3a, `manifestEnvelopes`) and every plugin
 * tool in APPROVAL_GATED_TOOLS with its registered input schema (3b,
 * `pluginTools`). Without the flag the output is byte for byte as before.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";


const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const overlay = arg("--overlay");
const sha = arg("--sha");
const OUT = arg("--out") ?? join(REPO_ROOT, "scripts", "overlay-recipes", "corpus.json");
const extractedAt = arg("--extracted-at") ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
if (overlay === undefined || sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
  process.stderr.write("usage: bun scripts/overlay-recipes-extract.mjs --overlay <export dir> --sha <40-hex overlay sha> [--extracted-at <iso>] [--out <path>]\n");
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(md|txt)$/.test(entry)) out.push(path);
  }
  return out;
}

const SHELL_FENCE = new Set(["", "sh", "bash", "shell", "zsh", "console"]);

/** The overlay's `recipesIn`, verbatim but for types (fetch-url-shape.test.ts). */
function recipesIn(name, text, plain = false) {
  const out = [];
  const lines = text.split("\n");
  let fence = null;
  let lang = "";
  let pending = "";
  let start = 0;
  lines.forEach((line, i) => {
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/);
    if (!plain && fence === null && open) {
      fence = open[1];
      lang = open[2].toLowerCase();
      pending = "";
      return;
    }
    if (!plain && fence !== null && line.trim().startsWith(fence)) {
      fence = null;
      return;
    }
    if (!plain && fence !== null) {
      if (!SHELL_FENCE.has(lang)) return;
      if (pending === "") start = i + 1;
      pending += (pending ? " " : "") + line.replace(/\\\s*$/, "");
      if (/\\\s*$/.test(line)) return;
      const command = pending.replace(/^\s*\$\s+/, "").trim();
      pending = "";
      if (command && !command.startsWith("#")) out.push({ where: `${name}:${start}`, command });
      return;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      if (/^\s*(curl|wget)\s/.test(m[1])) out.push({ where: `${name}:${i + 1}`, command: m[1] });
    }
  });
  return out;
}

const recipes = [];
for (const dir of ["skills", "workspace"]) {
  for (const path of walk(join(overlay, dir))) {
    recipes.push(...recipesIn(relative(overlay, path), readFileSync(path, "utf8")));
  }
}
const { DIGEST_CRON_SPECS } = await import(join(overlay, "install", "install_index.ts"));
for (const spec of DIGEST_CRON_SPECS) {
  if (spec.promptBody !== undefined) recipes.push(...recipesIn(`install/install_index.ts#${spec.name}`, spec.promptBody, true));
}

const TEMPLATE = "skills/approval/templates/APPROVAL.md";
const templateText = readFileSync(join(overlay, TEMPLATE), "utf8");
const block = templateText.match(/^```yaml approval-policy\n([\s\S]*?)\n```$/mu);
if (block === null) {
  process.stderr.write(`no approval-policy fence in ${TEMPLATE}\n`);
  process.exit(1);
}

/**
 * The envelope key, the same rule as scripts/overlay-recipes-box.mjs
 * `envelopeKey` (tests/overlay-recipes-new-calls.test.ts holds the two equal):
 * closed character sets that exclude the separators, so no two calls share a
 * key; a part outside its set is no key (null). Copied, not imported: ci.yml
 * runs the BASE branch's extractor as a lone file.
 */
function envelopeKey(tool, input) {
  const i = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  const parts = [[tool, /^[A-Za-z0-9_-]{1,128}$/u, false], [i.operation, /^[A-Za-z0-9_.-]{1,128}$/u, true], [i.appId, /^[A-Za-z0-9_-]{1,128}$/u, true], [i.tool, /^[A-Za-z0-9_-]{1,128}$/u, true]];
  if (parts.some(([v, re, optional]) => !(optional && v === undefined) && (typeof v !== "string" || !re.test(v)))) return null;
  let key = String(tool);
  if (i.operation !== undefined) key += `#${i.operation}`;
  if (i.appId !== undefined) key += `:${i.appId}`;
  if (i.tool !== undefined) key += `.${i.tool}`;
  return key;
}

// ---------------------------------------------------------------------------
// B-167N extractor scope (3a, 3b): with --with-envelopes only, so the pinned
// corpus.json (recipes only) and approval.md's re-extraction check keep their
// bytes. The overlay's class-diff passes the flag for its head and base runs.
// ---------------------------------------------------------------------------

/**
 * 3b: the plugin tools Hermes routes to the hook. APPROVAL_GATED_TOOLS is read
 * as text from install/install_approval.ts (a list of string literals, full-match
 * regexes in Hermes); importing that module would run the installer's imports.
 */
export function gatedPatterns(text) {
  const m = text.match(/export const APPROVAL_GATED_TOOLS = \[([\s\S]*?)\] as const;/u);
  if (m === null) return null;
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((x) => JSON.parse(`"${x[1]}"`));
}

/**
 * 3b: every tool a plugin registers, with the input schema it registers it with
 * (P6: the real schema, never a hand-written one). Read by python3's own parser
 * (`ast`), never by importing the plugin: a `register_tool(name=..., schema=X)`
 * call whose name is a string literal and whose schema is a module-level dict
 * literal (village-bridge/__init__.py `SCHEMA`, literal-evaluated as R-DEON's
 * proof already does). A registration this cannot read is reported, so the
 * check fails closed on it when a gated tool is involved.
 */
const PLUGIN_TOOLS_PY = String.raw`
import ast, json, os, sys
root = sys.argv[1]
out, unread = [], []
for plugin in (sorted(os.listdir(root)) if os.path.isdir(root) else []):
    pdir = os.path.join(root, plugin)
    if not os.path.isdir(pdir) or plugin.startswith("."):
        continue
    for dirpath, dirnames, filenames in os.walk(pdir):
        dirnames[:] = sorted(d for d in dirnames if d not in ("tests", "node_modules", "__pycache__") and not d.startswith("."))
        for f in sorted(filenames):
            if not f.endswith(".py"):
                continue
            path = os.path.join(dirpath, f)
            rel = os.path.relpath(path, os.path.dirname(root))
            tree = ast.parse(open(path, encoding="utf-8").read(), path)
            consts = {}
            for node in tree.body:
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    consts[node.targets[0].id] = node.value
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "register_tool"):
                    continue
                kw = {k.arg: k.value for k in node.keywords if k.arg}
                name = kw.get("name")
                if isinstance(name, ast.Name) and name.id in consts:
                    name = consts[name.id]
                schema = kw.get("schema")
                if isinstance(schema, ast.Name) and schema.id in consts:
                    schema = consts[schema.id]
                if not (isinstance(name, ast.Constant) and isinstance(name.value, str)):
                    unread.append({"plugin": plugin, "file": rel, "line": node.lineno, "why": "name is not a literal"})
                    continue
                try:
                    value = ast.literal_eval(schema) if schema is not None else None
                except Exception:
                    value = None
                if not isinstance(value, dict):
                    unread.append({"plugin": plugin, "file": rel, "line": node.lineno, "name": name.value, "why": "schema is not a module-level dict literal"})
                    value = None
                out.append({"name": name.value, "plugin": plugin, "file": "%s:%d" % (rel, node.lineno), "schema": (value.get("parameters", value) if isinstance(value, dict) else None)})
print(json.dumps({"tools": out, "unread": unread}, sort_keys=True))
`;

export function pluginTools(overlayDir) {
  const r = spawnSync("python3", ["-I", "-c", PLUGIN_TOOLS_PY, join(overlayDir, "plugins")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(`python3 could not read the plugins' tool registrations: ${r.stderr ?? r.error}\n`);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

/**
 * 3a (P5): each mini-app manifest operation as the exact call the hook sees,
 * derived from the village-bridge code path, never written by hand:
 * - the `village` tool's handler accepts an operation only when it is in its
 *   schema's `operation` enum (village-bridge/__init__.py: SCHEMA, and the
 *   READ_OPERATIONS/WRITE_OPERATIONS gate in handle()), so a manifest operation
 *   named in that enum is `village {operation: <name>}`;
 * - a relay app's operation (`target.tool`, an MCP tool) reaches its app only
 *   through the generic read, `village {operation: "mini-app.read", appId,
 *   tool, arguments}` (handle(): `mini-app.read` takes exactly those keys; the
 *   envelope key and the derived input carry the selecting ones), so
 *   EVERY MCP tool of a relay app is its own envelope;
 * - an app whose manifest declares `data.context` also has the context read and
 *   write (`mini-app.context.read` / `.write`, appId from the caller);
 * - anything else is `unmapped`: the check fails closed on it when it is new.
 */
const APP_SCOPED = new Set(["mini-app.read", "mini-app.context.read", "mini-app.context.write"]);

export function manifestEnvelopes(overlayDir, villageSchema) {
  const ops = new Set(villageSchema?.properties?.operation?.enum ?? []);
  const dir = join(overlayDir, "mini-apps");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir).sort()) {
    const path = join(dir, id, "manifest.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const where = `mini-apps/${id}/manifest.json`;
    const push = (op, input) => out.push({ key: envelopeKey("village", input), tool: "village", input, where: `${where}#${op}`, app: id, operation: op });
    // Manifest v2 operations are objects ({name, target?}); a v1 manifest lists names.
    for (const op of Array.isArray(manifest.operations) ? manifest.operations : []) {
      const name = typeof op === "string" ? op : String(op?.name);
      // The app-scoped operations take the app from the caller (handle(): APP_SCOPED_OPERATIONS).
      if (ops.has(name)) push(name, APP_SCOPED.has(name) ? { operation: name, appId: id } : { operation: name });
      else if (typeof op?.target?.tool === "string" && ops.has("mini-app.read")) push(name, { operation: "mini-app.read", appId: id, tool: op.target.tool });
      else out.push({ key: `unmapped#${JSON.stringify([id, name])}`, tool: null, input: null, where: `${where}#${name}`, app: id, operation: name, unmapped: "no village operation reaches this manifest operation" });
    }
    if (manifest?.data?.context !== undefined) {
      for (const op of ["mini-app.context.read", "mini-app.context.write"]) {
        if (ops.has(op)) push(op, { operation: op, appId: id });
      }
    }
  }
  return out;
}

let envelopeScope;
if (process.argv.includes("--with-envelopes")) {
  // Fail closed: an overlay without the gated list cannot say which plugin tools reach the hook.
  const gatedPath = join(overlay, "install", "install_approval.ts");
  const gated = existsSync(gatedPath) ? gatedPatterns(readFileSync(gatedPath, "utf8")) : null;
  if (gated === null) {
    process.stderr.write("no APPROVAL_GATED_TOOLS list in install/install_approval.ts\n");
    process.exit(1);
  }
  const isGated = (name) => gated.some((p) => new RegExp(`^(?:${p})$`, "u").test(name));
  const found = pluginTools(overlay);
  const tools = found.tools.filter((t) => isGated(t.name));
  const unread = found.unread.filter((u) => u.name === undefined || isGated(u.name));
  const village = tools.find((t) => t.name === "village");
  const envelopes = manifestEnvelopes(overlay, village?.schema);
  // A gated plugin tool no manifest reaches gets one bare envelope of its own.
  for (const t of tools) {
    if (!envelopes.some((e) => e.tool === t.name)) envelopes.push({ key: envelopeKey(t.name, {}), tool: t.name, input: {}, where: t.file });
  }
  // Security fold: an envelope with no unambiguous key, or two envelopes with one
  // key, would let one call stand for another; never skipped, exit 1.
  const bad = envelopes.filter((e) => e.key === null);
  const seenKeys = new Map();
  const dups = [];
  for (const e of envelopes) {
    if (e.key === null) continue;
    if (seenKeys.has(e.key)) dups.push(`${e.key} (${seenKeys.get(e.key)} and ${e.where})`);
    else seenKeys.set(e.key, e.where);
  }
  if (bad.length > 0 || dups.length > 0) {
    for (const e of bad) process.stderr.write(`no unambiguous envelope key for ${e.where} (an id or tool name outside [A-Za-z0-9_-], or an operation outside [A-Za-z0-9_.-])\n`);
    for (const d of dups) process.stderr.write(`duplicate envelope key ${d}\n`);
    process.exit(1);
  }
  envelopeScope = { gated, tools, unread, envelopes };
}

const corpus = {
  about:
    "Pinned overlay recipe corpus for the release check (approval.md 0.4.7, EDGEOS-BLOCK). Written by scripts/overlay-recipes-extract.mjs; read by scripts/overlay-recipes-check.mjs. Do not hand-edit: refresh at a new overlay sha instead.",
  overlay: {
    repo: "Edge-City/agentvillage",
    sha,
    extracted_at: extractedAt,
    method:
      "agentFacingRecipes() of scripts/tests/fetch-url-shape.test.ts (agentvillage #427): skills/** and workspace/** .md/.txt, shell fences (lang '', sh, bash, shell, zsh, console) plus inline `curl`/`wget` spans, and DIGEST_CRON_SPECS[].promptBody as plain text",
  },
  policy: {
    source: TEMPLATE,
    // The template carries a provisioning placeholder the schema rejects; the
    // check substitutes a syntactically valid id. No class row depends on it.
    substitute: { "<telegram_user_id>": "1" },
    block: block[1],
  },
  // The overlay test fills these placeholders before classifying (its FILL); the
  // check applies the same, and leaves every other placeholder as written.
  fill: [
    { pattern: "\\{(current_iso_timestamp|start_iso|end_iso|occurrence_iso)\\}", value: "2026-10-21T10:00:00Z" },
    { pattern: "\\{(event_id|popup_id)\\}", value: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
  ],
  // The overlay test classifies from /tmp with no protected-path entries beyond
  // the policy's own; the check does the same.
  cwd: "/tmp",
  recipes,
};
if (envelopeScope !== undefined) {
  corpus.gated_tools = envelopeScope.gated;
  corpus.tools = envelopeScope.tools;
  corpus.tools_unread = envelopeScope.unread;
  corpus.envelopes = envelopeScope.envelopes;
}

writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
process.stdout.write(
  `${recipes.length} recipes${envelopeScope === undefined ? "" : `, ${String(envelopeScope.envelopes.length)} envelopes, ${String(envelopeScope.tools.length)} gated plugin tools`} at ${sha} -> ${relative(REPO_ROOT, OUT)}\n`,
);
