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
 * (`ast`), never by importing the plugin. A registration is any call of
 * `<x>.register_tool(...)`, of a bare `register_tool(...)`, or of a local name
 * bound from `getattr(<x>, "register_tool", ...)` (the overlay's house style,
 * B-167N review M1). Its name and schema are literals, module-level constants
 * (of the module or a sibling it imports from), or the rows of the literal list
 * a `for name, schema, ... in <list>` loop walks (av-events `_share_vote`).
 * A registration this cannot read is reported (`unread`), so the check fails
 * closed on it when a gated tool is involved, or when its name is unknown.
 *
 * The same pass reads, for the check:
 * - every `<x>.propose(<class>, ...)` daemon propose (review M3), with its file,
 *   line and class (a literal, a module constant, or the template a module
 *   function `return PREFIX + "." + param` makes), and the daemon answers the
 *   plugin goes on with after it (`accepts`, review S1: every
 *   `decision != "x"` / `decision not in (...)` on that answer in the same
 *   function);
 * - the village tool's READ_OPERATIONS, WRITE_OPERATIONS and
 *   APP_SCOPED_OPERATIONS (review M2), beside the module that registers it.
 */
const PLUGIN_TOOLS_PY = String.raw`
import ast, json, os, sys
root = sys.argv[1]
out, unread, proposes, village_ops = [], [], [], None

class Unresolved(Exception):
    pass

MODS = {}  # path -> module info

def load(path):
    if path in MODS:
        return MODS[path]
    tree = ast.parse(open(path, encoding="utf-8").read(), path)
    consts, funcs, imports = {}, {}, {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            consts[node.targets[0].id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            consts[node.target.id] = node.value
        elif isinstance(node, ast.FunctionDef):
            funcs[node.name] = node
        elif isinstance(node, ast.ImportFrom) and node.level == 1 and node.module:
            target = os.path.join(os.path.dirname(path), node.module.replace(".", os.sep) + ".py")
            for a in node.names:
                imports[a.asname or a.name] = (target, a.name)
    MODS[path] = m = {"path": path, "tree": tree, "consts": consts, "funcs": funcs, "imports": imports}
    return m

def lookup(m, name, depth):
    if name in m["consts"]:
        return m, m["consts"][name]
    if name in m["imports"]:
        target, orig = m["imports"][name]
        if depth < 8 and os.path.isfile(target):
            return lookup(load(target), orig, depth + 1)
    raise Unresolved(name)

def ev(m, node, depth=0, local=None):
    """A literal, with names resolved to module-level constants (this module or a sibling it imports)."""
    if depth > 40:
        raise Unresolved("too deep")
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if local is not None and node.id in local:
            return local[node.id]
        mm, value = lookup(m, node.id, 0)
        return ev(mm, value, depth + 1)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        items = []
        for e in node.elts:
            if isinstance(e, ast.Starred):
                items.extend(list(ev(m, e.value, depth + 1, local)))
            else:
                items.append(ev(m, e, depth + 1, local))
        return items
    if isinstance(node, ast.Dict):
        if any(k is None for k in node.keys):
            raise Unresolved("dict unpacking")
        return {ev(m, k, depth + 1, local): ev(m, v, depth + 1, local) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("frozenset", "set", "tuple", "list") and len(node.args) == 1 and not node.keywords:
        return list(ev(m, node.args[0], depth + 1, local))
    if isinstance(node, ast.Subscript):
        key = node.slice.value if isinstance(node.slice, ast.Constant) else None
        base = ev(m, node.value, depth + 1, local)
        if isinstance(base, dict) and key in base:
            return base[key]
        raise Unresolved("subscript")
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = ev(m, node.left, depth + 1, local), ev(m, node.right, depth + 1, local)
        if isinstance(a, str) and isinstance(b, str):
            return a + b
        raise Unresolved("add")
    raise Unresolved(type(node).__name__)

def parents_of(tree):
    par = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            par[child] = node
    return par

def enclosing(par, node, kinds):
    while node in par:
        node = par[node]
        if isinstance(node, kinds):
            return node
    return None

def loop_bindings(m, par, call):
    """M1: a registration inside 'for a, b, ... in <list>' (the list a literal or a name bound once in the
    function): one binding of the loop variables per element. None when the call is in no such loop."""
    loop = enclosing(par, call, (ast.For,))
    if loop is None:
        return None
    target = loop.target
    names = [t.id for t in target.elts] if isinstance(target, ast.Tuple) and all(isinstance(t, ast.Name) for t in target.elts) else ([target.id] if isinstance(target, ast.Name) else None)
    if names is None:
        raise Unresolved("loop target")
    it = loop.iter
    if isinstance(it, ast.Name):
        fn = enclosing(par, loop, (ast.FunctionDef, ast.AsyncFunctionDef))
        bound = [n.value for n in ast.walk(fn) if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and n.targets[0].id == it.id] if fn else []
        if len(bound) != 1:
            raise Unresolved("loop list")
        it = bound[0]
    if not isinstance(it, (ast.List, ast.Tuple)):
        raise Unresolved("loop list")
    rows = []
    for elt in it.elts:
        if len(names) == 1:
            rows.append({names[0]: elt})
        elif isinstance(elt, (ast.Tuple, ast.List)) and len(elt.elts) == len(names):
            rows.append(dict(zip(names, elt.elts)))
        else:
            raise Unresolved("loop row")
    return rows

def arg_of(call, kw, pos):
    for k in call.keywords:
        if k.arg == kw:
            return k.value
    return call.args[pos] if len(call.args) > pos else None

def accepted_answers(m, par, call):
    """S1: the daemon answers the plugin goes on with after this propose: every 'decision != "x"' or
    'decision not in (...)' in the enclosing function, where decision is the propose's answer's
    'doc.get("decision")' (direct, or a name bound from it). None when nothing narrows it."""
    fn = enclosing(par, call, (ast.FunctionDef, ast.AsyncFunctionDef))
    assign = par.get(call)
    if fn is None or not (isinstance(assign, ast.Assign) and len(assign.targets) == 1 and isinstance(assign.targets[0], ast.Name)):
        return None
    answer = assign.targets[0].id
    def is_decision(n):
        return (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and n.args
                and isinstance(n.args[0], ast.Constant) and n.args[0].value == "decision"
                and isinstance(n.func.value, ast.Attribute) and n.func.value.attr == "doc"
                and isinstance(n.func.value.value, ast.Name) and n.func.value.value.id == answer)
    names = {n.targets[0].id for n in ast.walk(fn) if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and is_decision(n.value)}
    allowed = None
    for n in ast.walk(fn):
        if not (isinstance(n, ast.Compare) and len(n.ops) == 1):
            continue
        left = n.left
        if not (is_decision(left) or (isinstance(left, ast.Name) and left.id in names)):
            continue
        try:
            right = ev(m, n.comparators[0])
        except Unresolved:
            continue
        if isinstance(n.ops[0], ast.NotEq) and isinstance(right, str):
            got = {right}
        elif isinstance(n.ops[0], ast.NotIn) and isinstance(right, list):
            got = set(right)
        else:
            continue
        allowed = got if allowed is None else allowed & got
    return sorted(allowed) if allowed is not None else None

def propose_class(m, node):
    """M3: the class a propose names: a literal or module constant, or a module function returning
    CONSTANT + "." + parameter called with a name (a class template, '<prefix>.{param}')."""
    try:
        v = ev(m, node)
        if isinstance(v, str):
            return {"class": v}
    except Unresolved:
        pass
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in m["funcs"] and len(node.args) == 1 and isinstance(node.args[0], ast.Name):
        fn = m["funcs"][node.func.id]
        params = [a.arg for a in fn.args.args]
        body = [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
        if len(params) == 1 and len(body) == 1 and isinstance(body[0], ast.Return) and isinstance(body[0].value, ast.BinOp):
            try:
                prefix = ev(m, body[0].value, local={params[0]: "\u0000"})
                if isinstance(prefix, str) and prefix.count("\u0000") == 1 and prefix.endswith("\u0000"):
                    return {"class": None, "template": prefix.replace("\u0000", "{" + node.args[0].id + "}")}
            except Unresolved:
                pass
    return {"class": None, "why": "the class is not a literal, a module constant or a class template"}

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
            m = load(path)
            tree = m["tree"]
            par = parents_of(tree)
            # M1: a local name bound from getattr(<x>, "register_tool"[, default]) registers too.
            aliases = {"register_tool"}
            for node in ast.walk(tree):
                if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                        and node.value.func.id == "getattr" and len(node.value.args) >= 2
                        and isinstance(node.value.args[1], ast.Constant) and node.value.args[1].value == "register_tool"):
                    aliases.update(t.id for t in node.targets if isinstance(t, ast.Name))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                if isinstance(fn, ast.Attribute) and fn.attr == "propose" and not (isinstance(fn.value, ast.Name) and fn.value.id == "self"):
                    cls_node = arg_of(node, "cls", 0)
                    site = {"plugin": plugin, "file": rel, "line": node.lineno, "accepts": accepted_answers(m, par, node)}
                    site.update(propose_class(m, cls_node) if cls_node is not None else {"class": None, "why": "no class argument"})
                    proposes.append(site)
                    continue
                if not ((isinstance(fn, ast.Attribute) and fn.attr == "register_tool") or (isinstance(fn, ast.Name) and fn.id in aliases)):
                    continue
                name_node, schema_node = arg_of(node, "name", 0), arg_of(node, "schema", 2)
                try:
                    rows = loop_bindings(m, par, node)
                except Unresolved as why:
                    unread.append({"plugin": plugin, "file": rel, "line": node.lineno, "why": "registered in a loop whose list cannot be read (%s)" % why})
                    continue
                for local_nodes in (rows if rows is not None else [None]):
                    local = None
                    if local_nodes is not None:
                        local = {}
                        for k, v in local_nodes.items():
                            try:
                                local[k] = ev(m, v)
                            except Unresolved:
                                pass  # a loop value only a name or schema would read (a handler, a flag)
                    try:
                        name = ev(m, name_node, local=local) if name_node is not None else None
                    except Unresolved:
                        name = None
                    if not isinstance(name, str):
                        unread.append({"plugin": plugin, "file": rel, "line": node.lineno, "why": "name is not a literal or module constant"})
                        continue
                    try:
                        value = ev(m, schema_node, local=local) if schema_node is not None else None
                    except Unresolved:
                        value = None
                    if not isinstance(value, dict):
                        unread.append({"plugin": plugin, "file": rel, "line": node.lineno, "name": name, "why": "schema is not a dict literal or module constant"})
                        value = None
                    entry = {"name": name, "plugin": plugin, "file": "%s:%d" % (rel, node.lineno), "schema": (value.get("parameters", value) if isinstance(value, dict) else None)}
                    if not any(o["name"] == name and o["file"].split(":")[0] == rel and o["schema"] == entry["schema"] for o in out):
                        out.append(entry)
                    # M2: the village tool's operation lists, beside the module that registers it.
                    if name == "village" and village_ops is None:
                        try:
                            village_ops = {k: sorted(set(ev(m, ast.Name(id=k)))) for k in ("READ_OPERATIONS", "WRITE_OPERATIONS", "APP_SCOPED_OPERATIONS")}
                        except Unresolved as why:
                            village_ops = {"error": "the village operation lists cannot be read (%s)" % why}
print(json.dumps({"tools": out, "unread": unread, "proposes": proposes, "village_ops": village_ops}, sort_keys=True))
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

/**
 * Review M2: one envelope per operation the village schema's `operation` enum
 * accepts that no manifest already reached (handle() serves any enum operation
 * in READ_OPERATIONS or WRITE_OPERATIONS, with or without a manifest). The
 * app-scoped operations take an app from the caller and come from the
 * manifests. An enum operation in neither list is `unmapped`: the check fails
 * closed on it when it is new.
 */
export function enumEnvelopes(village, ops, already) {
  const read = new Set(ops.READ_OPERATIONS);
  const write = new Set(ops.WRITE_OPERATIONS);
  const scoped = new Set(ops.APP_SCOPED_OPERATIONS);
  const reached = new Set(already.filter((e) => e.tool === "village").map((e) => e.input?.operation));
  const out = [];
  const where = `${String(village.file).replace(/:\d+$/u, "")}#operation`;
  for (const op of village.schema?.properties?.operation?.enum ?? []) {
    if (scoped.has(op) || reached.has(op)) continue;
    if (!read.has(op) && !write.has(op)) {
      out.push({ key: `unmapped#${JSON.stringify(["village", op])}`, tool: null, input: null, where: `${where}:${String(op)}`, operation: op, unmapped: "an operation the village schema accepts that is in neither READ_OPERATIONS nor WRITE_OPERATIONS" });
      continue;
    }
    const input = { operation: op };
    out.push({ key: envelopeKey("village", input), tool: "village", input, where: `${where}:${op}`, operation: op, rw: write.has(op) ? "write" : "read" });
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
  if (village !== undefined) {
    // Review M2: every operation the village schema accepts is a call, manifest or not.
    if (found.village_ops === null || "error" in found.village_ops) {
      process.stderr.write(`${found.village_ops?.error ?? "the village operation lists (READ_OPERATIONS, WRITE_OPERATIONS) were not found"}; fail closed\n`);
      process.exit(1);
    }
    envelopes.push(...enumEnvelopes(village, found.village_ops, envelopes));
  }
  // Review M3: the daemon proposes of every plugin that owns a gated tool; the
  // others are not behind a hooked call and are listed apart.
  const gatedPlugins = new Set(tools.map((t) => t.plugin));
  const proposes = found.proposes.filter((p) => gatedPlugins.has(p.plugin));
  const proposesUnhooked = found.proposes.filter((p) => !gatedPlugins.has(p.plugin));
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
  envelopeScope = { gated, tools, unread, envelopes, proposes, proposesUnhooked };
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
  corpus.proposes = envelopeScope.proposes;
  corpus.proposes_unhooked = envelopeScope.proposesUnhooked;
}

writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
process.stdout.write(
  `${recipes.length} recipes${envelopeScope === undefined ? "" : `, ${String(envelopeScope.envelopes.length)} envelopes, ${String(envelopeScope.tools.length)} gated plugin tools`} at ${sha} -> ${relative(REPO_ROOT, OUT)}\n`,
);
