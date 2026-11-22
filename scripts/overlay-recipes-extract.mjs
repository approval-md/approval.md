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
 * - every daemon propose (review M3), in every plugin (review S1: one whose
 *   plugin owns no gated tool is judged all the same), spelled
 *   `<x>.propose(<class>, ...)` (`self` included), a bare `propose(...)`, a
 *   name imported as `propose` or bound from `getattr(<x>, "propose")` (review
 *   N1), or `getattr(<x>, "propose")(...)` called on the spot (review N3),
 *   with its file, line and class (a literal, a module constant, the
 *   template a module function `return PREFIX + "." + param` makes, or the
 *   class field of a held entry read as the classes the module's guards
 *   compare it with), and the daemon answers the plugin goes on with after it
 *   (`accepts`, review S1: `decision != "x"` / `decision not in (...)` on that
 *   answer in the same function, and an `if`/`elif` chain on it whose `else`
 *   ends the flow); a class or answers it cannot read are reported unread;
 *   and whether it passes `irreversible=True` (APRV-537, `approval propose
 *   --irreversible`): only a literal True or False at the call is read, no keyword is false,
 *   any other spelling is reported unread (`irreversible: null`);
 * - in every plugin with a propose of a held entry's class (review S1b), the
 *   class writers (`class_writers`): each line that gives a held entry its
 *   class, with its file, enclosing function, line and the class it files, a
 *   call into the function that stores the class followed across the plugin's
 *   modules (see the S1b block in the Python below); a writer it cannot read
 *   is listed with no class and a reason;
 * - the village tool's READ_OPERATIONS, WRITE_OPERATIONS and
 *   APP_SCOPED_OPERATIONS (review M2), beside the module that registers it.
 */
const PLUGIN_TOOLS_PY = String.raw`
import ast, json, os, sys
root = sys.argv[1]
out, unread, proposes, village_ops = [], [], [], None
PLUGIN_FILES = {}  # plugin -> its module paths, walk order (S1b: a class writer's calls are followed across them)

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

ANSWERS = {"autonomous", "requested", "supervised"}

def bound_pairs(fn):
    """(name, value) for every 'name = value' in the function, and pairwise for 'a, b = x, y'."""
    for n in ast.walk(fn):
        if not (isinstance(n, ast.Assign) and len(n.targets) == 1):
            continue
        t = n.targets[0]
        if isinstance(t, ast.Name):
            yield t.id, n.value
        elif isinstance(t, ast.Tuple) and isinstance(n.value, ast.Tuple) and len(t.elts) == len(n.value.elts):
            for a, b in zip(t.elts, n.value.elts):
                if isinstance(a, ast.Name):
                    yield a.id, b

def block_of(par, stmt):
    """The statement list that holds a statement, or None."""
    owner = par.get(stmt)
    for field in ("body", "orelse", "finalbody", "handlers"):
        block = getattr(owner, field, None)
        if isinstance(block, list) and any(x is stmt for x in block):
            return block
    return None

def spine(par, fn, call):
    """S1 position rule: [(block, index)] for the statement holding the propose and each statement
    around it up to the function's own body, climbing only out of an if or else branch, a try body
    or a with body. None when the propose sits in a loop, an except or finally block, or a nested
    def, class or lambda: no statement after it is then on every path from it."""
    node = call
    while not isinstance(node, ast.stmt):
        node = par.get(node)
        if node is None or isinstance(node, ast.Lambda):
            return None
    out = []
    while True:
        owner = par.get(node)
        block = block_of(par, node)
        if block is None:
            return None
        out.append((block, next(i for i, x in enumerate(block) if x is node)))
        if owner is fn:
            return out if block is fn.body else None
        if isinstance(owner, ast.If) or (isinstance(owner, (ast.With, ast.AsyncWith)) and block is owner.body) or (isinstance(owner, ast.Try) and block is owner.body):
            node = owner
            continue
        return None

def ends_flow(body):
    return bool(body) and isinstance(body[-1], (ast.Return, ast.Raise))

def accepted_answers(m, par, call):
    """S1: the daemon answers the plugin goes on with after this propose, read in the enclosing
    function, where decision is the propose's answer's 'doc.get("decision")' (on 'answer.doc', or on
    a name bound from it; direct, or a name bound from it, also as one member of 'a, b = x, y').
    Only an 'if' that every path from the propose passes through counts: a statement after the
    propose in the block that holds it, or in a block around it the propose leaves only by an if
    or else branch, a try body or a with body, in the same function (never a nested def, class or
    lambda); see 'spine'. There:
    - an 'if' whose body returns or raises, tested by 'decision != "x"' or 'decision not in (...)'
      (alone, or as one operand of an 'or'), narrows it to those answers;
    - an if/elif chain that tests the decision and ends in an 'else' that returns or raises narrows
      it to the answers of the branches the code goes on from ('== "x"' or 'in (...)', alone or
      under 'and'; a test that names no decision admits every answer; a branch that returns or
      raises admits none).
    None (unread, the check fails closed) when nothing narrows it, or a narrowing comparison or a
    chain that tests the decision sits anywhere else or in a form not read."""
    fn = enclosing(par, call, (ast.FunctionDef, ast.AsyncFunctionDef))
    assign = par.get(call)
    if fn is None or not (isinstance(assign, ast.Assign) and len(assign.targets) == 1 and isinstance(assign.targets[0], ast.Name)):
        return None
    answer = assign.targets[0].id
    pairs = list(bound_pairs(fn))
    def is_answer_doc(n):
        return isinstance(n, ast.Attribute) and n.attr == "doc" and isinstance(n.value, ast.Name) and n.value.id == answer
    docs = {name for name, value in pairs if is_answer_doc(value)}
    def is_decision(n):
        return (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and n.args
                and isinstance(n.args[0], ast.Constant) and n.args[0].value == "decision"
                and (is_answer_doc(n.func.value) or (isinstance(n.func.value, ast.Name) and n.func.value.id in docs)))
    names = {name for name, value in pairs if is_decision(value)}
    def names_decision(n):
        return is_decision(n) or (isinstance(n, ast.Name) and n.id in names)
    def mentions(n):
        return any(names_decision(x) for x in ast.walk(n))
    where = spine(par, fn, call)
    def after_propose(stmt):
        block = block_of(par, stmt)
        return where is not None and block is not None and any(b is block and next(j for j, x in enumerate(block) if x is stmt) > i for b, i in where)
    allowed = None
    for n in ast.walk(fn):
        if not (isinstance(n, ast.Compare) and len(n.ops) == 1 and names_decision(n.left) and isinstance(n.ops[0], (ast.NotEq, ast.NotIn))):
            continue
        guard = par.get(n)
        if isinstance(guard, ast.BoolOp) and isinstance(guard.op, ast.Or):
            guard = par.get(guard)
        if not (isinstance(guard, ast.If) and (guard.test is n or (isinstance(guard.test, ast.BoolOp) and isinstance(guard.test.op, ast.Or) and any(v is n for v in guard.test.values)))
                and ends_flow(guard.body) and after_propose(guard)):
            return None  # a narrowing that does not guard every path from the propose: unread
        try:
            right = ev(m, n.comparators[0])
        except Unresolved:
            return None
        if isinstance(n.ops[0], ast.NotEq) and isinstance(right, str):
            got = {right}
        elif isinstance(n.ops[0], ast.NotIn) and isinstance(right, list):
            got = set(right)
        else:
            return None
        allowed = got if allowed is None else allowed & got
    def admits(test):
        """The answers one branch test admits; Unresolved when it tests the decision another way."""
        if not mentions(test):
            return set(ANSWERS)
        parts = test.values if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And) else [test]
        got = set(ANSWERS)
        for p in parts:
            if not mentions(p):
                continue
            if not (isinstance(p, ast.Compare) and len(p.ops) == 1 and names_decision(p.left) and isinstance(p.ops[0], (ast.Eq, ast.In))):
                raise Unresolved("a branch tests the decision in a form not read")
            right = ev(m, p.comparators[0])
            got &= {right} if isinstance(p.ops[0], ast.Eq) and isinstance(right, str) else (set(right) if isinstance(right, list) else set())
        return got
    for n in ast.walk(fn):
        head = par.get(n)
        if not isinstance(n, ast.If) or (isinstance(head, ast.If) and head.orelse == [n]):
            continue  # not an if, or an elif inside a chain read from its head
        branches, node = [], n
        while True:
            branches.append(node)
            if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
                node = node.orelse[0]
                continue
            break
        if not any(mentions(b.test) for b in branches) or not ends_flow(node.orelse):
            continue  # a chain that never tests the decision, or no else that ends the flow
        if not after_propose(n):
            return None  # before the propose, nested, or under a branch, loop, try or with that can be skipped
        try:
            got = set().union(*(set() if ends_flow(b.body) else admits(b.test) for b in branches))
        except Unresolved:
            return None
        allowed = got if allowed is None else allowed & got
    return sorted(allowed) if allowed is not None else None

def is_class_field(n):
    """'<x>["class"]' or '<x>.get("class")': the class field of an entry the plugin holds."""
    if isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant) and n.slice.value == "class":
        return isinstance(n.value, ast.Name)
    return (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and isinstance(n.func.value, ast.Name)
            and len(n.args) == 1 and isinstance(n.args[0], ast.Constant) and n.args[0].value == "class")

def held_classes(m):
    """S1 (unhooked proposes): the classes a module's held entries may carry, read from the module's
    own guards: every '<class field> == / != / in / not in <a module constant or literal>', where the
    class field is '<x>["class"]', '<x>.get("class")' or a name bound from one in the same function.
    A comparison with a value it cannot read (a parameter, another entry's field) adds nothing."""
    out = set()
    for fn in [m["tree"]] + [n for n in ast.walk(m["tree"]) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        names = set() if fn is m["tree"] else {name for name, value in bound_pairs(fn) if is_class_field(value)}
        for n in ast.walk(fn):
            if not (isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.ops[0], (ast.Eq, ast.NotEq, ast.In, ast.NotIn))):
                continue
            if not (is_class_field(n.left) or (isinstance(n.left, ast.Name) and n.left.id in names)):
                continue
            try:
                right = ev(m, n.comparators[0])
            except Unresolved:
                continue
            for v in ([right] if isinstance(right, str) else right if isinstance(right, list) else []):
                if isinstance(v, str):
                    out.add(v)
    return sorted(out)

def propose_class(m, node):
    """M3: the class a propose names: a literal or module constant, or a module function returning
    CONSTANT + "." + parameter called with a name (a class template, '<prefix>.{param}'), or the
    class field of an entry the plugin holds, read as the set of classes the module's own guards
    compare that field with (S1, the av-events approval maps). Anything else is unread."""
    try:
        v = ev(m, node)
        if isinstance(v, str):
            return {"class": v}
    except Unresolved:
        pass
    if is_class_field(node):
        classes = held_classes(m)
        if classes:
            return {"class": None, "classes": classes, "held": True}
        return {"class": None, "held": True, "why": "the class is a held entry's field, and the module compares that field with no class it can read"}
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

def propose_irreversible(m, node):
    """APRV-537: whether a propose asks core for the SPEC section 7 floor ('approval propose
    --irreversible'), read ONLY as the keyword 'irreversible=' with a literal True or a literal False
    written at the call. No such keyword is False.

    Anything else is unread, which the check fails closed on: ANY name (a module constant included), an
    expression, a fifth positional, '*args' or '**kwargs'. A name is never followed (review, folds 2
    to 4): what a name holds at the call is decided at run time, and no reading of the source sees every
    way it can be rebound (a function's own binding, a module-level 'if', a class body, a comprehension
    or match capture, a star import, a walrus in a default, decorator or base, globals()). A call that
    means the floor says so in place: irreversible=True."""
    if any(k.arg is None for k in node.keywords) or any(isinstance(a, ast.Starred) for a in node.args):
        return {"irreversible": None, "irreversible_why": "the arguments are spread (*args or **kwargs)"}
    if len(node.args) > 4:
        return {"irreversible": None, "irreversible_why": "a fifth positional argument; pass irreversible by keyword"}
    kws = [k for k in node.keywords if k.arg == "irreversible"]
    if not kws:
        return {"irreversible": False}
    value = kws[0].value
    if len(kws) == 1 and isinstance(value, ast.Constant) and (value.value is True or value.value is False):
        return {"irreversible": value.value}
    return {"irreversible": None, "irreversible_why": "irreversible= is not the literal True or False written at the call (a name is never followed)"}

# ---- Review S1b: the class writers -------------------------------------------------------------
# A held-class propose (above) proposes whatever class its held entry carries, so the lines that give a
# held entry its class decide which class is proposed. In a plugin with such a propose, every place a
# "class" field gets its value is a writer, read to the class it files, with the file and the enclosing
# function (its identity in expected.json) and the line (reported only):
# - a dict literal with a "class" key ({"class": SHARE_CLASS, ...});
# - an assignment to x["class"] (also one member of 'x["class"], y = a, b');
# - x.setdefault("class", v) and x.__setitem__("class", v);
# a key read as "class" when it is that literal or a module constant equal to it. The class value is a
# literal, a module constant (of the module, a sibling it imports from, or a plugin module reached through
# an alias: 'ia = _ia()', 'from . import x as y', 'import x'), a local name bound once in the function to
# one of those, or a PARAMETER of the enclosing function, followed to every call of that function in the
# plugin (by name, or through a module alias, a 'from .m import f' name, keyword or position, or its
# default), where each call is then the writer (open_entry(..., cls=ia.INFERRED_CLASS) in another module).
# Anything else is an UNREAD writer, which the check fails closed on: a value it cannot read, a parameter
# with no call found, one passed through *args or **kwargs or rebound in the function, a writer function
# referenced but not called on the spot (passed, stored, getattr), an augmented assignment, an unpaired
# unpacking. Reads ('entry.get("class")', 'ap["class"]', the map loaded back from disk) are not writers:
# a writer whose value is such a read is unread, never skipped.

def qualnames(tree):
    """Each def's dotted name: its classes and outer defs, then its own name."""
    out = {}
    def visit(node, prefix):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if not isinstance(child, ast.ClassDef):
                    out[child] = prefix + child.name
                visit(child, prefix + child.name + ".")
            else:
                visit(child, prefix)
    visit(tree, "")
    return out

SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)

def info(m):
    if "par" not in m:
        m["par"] = parents_of(m["tree"])
        m["qual"] = qualnames(m["tree"])
        m["rel"] = os.path.relpath(m["path"], os.path.dirname(root))
    return m

def scope_of(m, node):
    return enclosing(m["par"], node, SCOPES)

def module_path(m, dotted):
    """A module beside m (relative import), or None."""
    base = os.path.join(os.path.dirname(m["path"]), *dotted.split("."))
    for p in (base + ".py", os.path.join(base, "__init__.py")):
        if os.path.isfile(p):
            return os.path.abspath(p)
    return None

def plain_import_path(m, dotted):
    """'import a.b.x': the plugin module x names (any tail of the dotted name under the plugin's directory), or None."""
    parts = dotted.split(".")
    pdir = m.get("plugin_dir")
    if pdir is None:
        return None
    for i in range(len(parts)):
        base = os.path.join(pdir, *parts[i:])
        for p in (base + ".py", os.path.join(base, "__init__.py")):
            if os.path.isfile(p):
                return os.path.abspath(p)
    return None

def module_aliases(m):
    """(scope, name) -> the plugin module that name names in that scope, when EVERY binding of the name in the
    scope names that one module: 'from . import x [as y]', 'from .pkg import x' (x a module), 'import a.x as y',
    'y = <an alias>', 'y = f()' for a module function f whose every return is an alias. A name also bound any
    other way in the scope (a parameter, a loop or with target, another value) is no alias there."""
    if "aliases" in m:
        return m["aliases"]
    info(m)
    fixed, assigns = {}, []
    def add(scope, name, value):
        fixed.setdefault((scope, name), set()).add(value)
    for n in ast.walk(m["tree"]):
        if isinstance(n, ast.ImportFrom):
            for a in n.names:
                target = module_path(m, a.name if not n.module else n.module + "." + a.name) if n.level == 1 else None
                add(scope_of(m, n), a.asname or a.name, target)
        elif isinstance(n, ast.Import):
            for a in n.names:
                add(scope_of(m, n), a.asname or a.name.split(".")[0], plain_import_path(m, a.name) if (a.asname or "." not in a.name) else None)
        elif isinstance(n, SCOPES):
            args = n.args
            for a in args.posonlyargs + args.args + args.kwonlyargs + [x for x in (args.vararg, args.kwarg) if x is not None]:
                add(n, a.arg, None)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            owner = m["par"].get(n)
            if isinstance(owner, ast.Assign) and len(owner.targets) == 1 and owner.targets[0] is n:
                assigns.append((scope_of(m, n), n.id, owner.value))
            else:
                add(scope_of(m, n), n.id, None)
    bound = set(fixed) | {(s, n) for s, n, _ in assigns}
    resolved, rets = {}, {}
    def resolve_in(scope, name):
        """The module a name names where it is read: its innermost scope that binds it, as Python looks it up."""
        while (scope, name) not in bound:
            if scope is None:
                return None
            scope = scope_of(m, scope)
        return resolved.get((scope, name))
    for _ in range(4):
        rets = {}
        for fname, f in m["funcs"].items():
            vals = [r.value for r in ast.walk(f) if isinstance(r, ast.Return)]
            paths = {resolve_in(scope_of(m, v), v.id) if isinstance(v, ast.Name) else None for v in vals}
            if vals and len(paths) == 1 and None not in paths:
                rets[fname] = next(iter(paths))
        cur = {k: set(v) for k, v in fixed.items()}
        for scope, name, value in assigns:
            p = None
            if isinstance(value, ast.Name):
                p = resolve_in(scope, value.id)
            elif isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and not value.args and not value.keywords:
                p = rets.get(value.func.id)
            cur.setdefault((scope, name), set()).add(p)
        resolved = {k: next(iter(v)) for k, v in cur.items() if len(v) == 1 and None not in v}
    m["aliases"], m["module_funcs"], m["bound"] = resolved, rets, bound
    return resolved

def module_of_expr(m, expr):
    """The plugin module an expression names: an alias name (looked up from its scope outwards, as Python
    does), or a call of a module function that returns one ('_ia()'). None otherwise."""
    aliases = module_aliases(m)
    if isinstance(expr, ast.Name):
        scope = scope_of(m, expr)
        while True:
            if (scope, expr.id) in m["bound"]:
                return aliases.get((scope, expr.id))
            if scope is None:
                return None
            scope = scope_of(m, scope)
    if isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name) and not expr.args and not expr.keywords:
        scope = scope_of(m, expr)
        while scope is not None:
            if (scope, expr.func.id) in m["bound"]:
                return None
            scope = scope_of(m, scope)
        return m["module_funcs"].get(expr.func.id)
    return None

def cev(m, node):
    """ev, and '<module alias>.NAME' read as that plugin module's constant ('ia.INFERRED_CLASS')."""
    if isinstance(node, ast.Attribute):
        target = module_of_expr(m, node.value)
        if target is None:
            raise Unresolved("attribute")
        mm, value = lookup(load(target), node.attr, 0)
        return ev(mm, value)
    return ev(m, node)

def is_class_key(m, k):
    if isinstance(k, ast.Constant):
        return k.value == "class"
    if not isinstance(k, (ast.Name, ast.Attribute)):
        return False
    try:
        return cev(m, k) == "class"
    except Exception:  # noqa: BLE001 - a key it cannot read is not taken for "class" (computed keys are not read)
        return False

def class_subscript(m, t):
    return isinstance(t, ast.Subscript) and isinstance(t.ctx, ast.Store) and is_class_key(m, t.slice)

def fn_label(m, fn):
    return "<module>" if fn is None else m["qual"].get(fn, getattr(fn, "name", "<lambda>"))

def same_path(a, b):
    return a is not None and b is not None and os.path.abspath(a) == os.path.abspath(b)

def calls_of(M, fn, plugin):
    """Every call in the plugin that may call fn (by its name, a 'from .m import fn [as g]' name, or
    '<x>.fn(...)' whose x is no OTHER plugin module), and every reference to it not called on the spot."""
    fname = fn.name
    calls, refs = [], []
    for path in PLUGIN_FILES.get(plugin, []):
        m = info(load(path))
        module_aliases(m)
        imported = {a.asname or a.name for n in ast.walk(m["tree"]) if isinstance(n, ast.ImportFrom) and n.level == 1 and n.module
                    for a in n.names if a.name == fname and same_path(module_path(m, n.module), M["path"])}
        own = m is M or same_path(m["path"], M["path"])
        def names_fn(x):
            if isinstance(x, ast.Name):
                return x.id in imported or (x.id == fname and (own or x.id not in m["funcs"]))
            if isinstance(x, ast.Attribute) and x.attr == fname:
                target = module_of_expr(m, x.value)
                return target is None or same_path(target, M["path"])
            return False
        for n in ast.walk(m["tree"]):
            parent = m["par"].get(n)
            called = isinstance(parent, ast.Call) and parent.func is n
            if isinstance(n, (ast.Name, ast.Attribute)) and isinstance(n.ctx, ast.Load) and names_fn(n):
                (calls if called else refs).append((m, parent if called else n))
            elif (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "getattr" and len(n.args) >= 2
                  and isinstance(n.args[1], ast.Constant) and n.args[1].value == fname):
                refs.append((m, n))
    return calls, refs

def arg_value(fn, call, pname, method_call):
    """(the node a call passes for parameter pname, None) or (a default node, "default") or (None, why)."""
    a = fn.args
    positional = [x.arg for x in a.posonlyargs + a.args]
    defaults = dict(zip(positional[len(positional) - len(a.defaults):], a.defaults))
    defaults.update({x.arg: d for x, d in zip(a.kwonlyargs, a.kw_defaults) if d is not None})
    if method_call and positional:
        positional = positional[1:]
    for k in call.keywords:
        if k.arg == pname:
            return k.value, None
    if pname in positional:
        i = positional.index(pname)
        for j, x in enumerate(call.args):
            if isinstance(x, ast.Starred) and j <= i:
                return None, "the class is passed through *args"
        if i < len(call.args):
            return call.args[i], None
    if any(k.arg is None for k in call.keywords) or any(isinstance(x, ast.Starred) for x in call.args):
        return None, "the class may be passed through **kwargs or *args"
    if pname in defaults:
        return defaults[pname], "default"
    return None, "the call passes no class"

def writer_records(m_eval, node, m_site, at, depth, via, plugin, following=()):
    """The writer(s) a class value decides: [{file, function, line, class[, via]}], a class None with a why when unread."""
    fn = enclosing(m_site["par"], at, (ast.FunctionDef, ast.AsyncFunctionDef))
    rec = {"plugin": plugin, "file": m_site["rel"], "function": fn_label(m_site, fn), "line": at.lineno}
    if via:
        rec["via"] = list(via)
    def unread(why):
        return [dict(rec, **{"class": None, "why": why})]
    params = [x.arg for x in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs] if fn is not None else []
    local = [v for name, v in bound_pairs(fn) if name == node.id] if fn is not None and isinstance(node, ast.Name) else []
    if not (isinstance(node, ast.Name) and (node.id in params or local)):
        try:
            v = cev(m_eval, node)
            return [dict(rec, **{"class": v})] if isinstance(v, str) else unread("the class is not a string")
        except Unresolved:
            return unread("the class is not a literal, a module constant or a parameter followed to its calls (a computed value, or a read of another entry)")
    if m_eval is not m_site:
        return unread("the class is a name the extractor cannot read")
    if node.id not in params:
        if len(local) == 1:
            return writer_records(m_eval, local[0], m_site, at, depth + 1, via, plugin, following)
        return unread("the class is a name the extractor cannot read (bound %d times in %s)" % (len(local), fn_label(m_site, fn)))
    if local:
        return unread("the class is parameter %s, which %s rebinds" % (node.id, fn_label(m_site, fn)))
    if depth >= 6 or fn in following:
        return unread("the class is parameter %s, followed too deep or in a cycle" % node.id)
    hop = "%s:%d %s(%s)" % (m_site["rel"], at.lineno, fn_label(m_site, fn), node.id)
    method = isinstance(m_site["par"].get(fn), ast.ClassDef) and not any(isinstance(d, ast.Name) and d.id == "staticmethod" for d in fn.decorator_list)
    calls, refs = calls_of(m_site, fn, plugin)
    out = []
    def at_call(mc, node_at, **fields):
        site = enclosing(mc["par"], node_at, (ast.FunctionDef, ast.AsyncFunctionDef))
        return dict({"plugin": plugin, "file": mc["rel"], "function": fn_label(mc, site), "line": node_at.lineno, "via": via + [hop]}, **fields)
    for mc, call in calls:
        val, how = arg_value(fn, call, node.id, method and isinstance(call.func, ast.Attribute))
        if val is None:
            out.append(at_call(mc, call, **{"class": None, "why": how}))
        elif how == "default":
            # The default is read where the function is defined; the writer is the call that leaves it.
            try:
                v = cev(m_site, val)
            except Unresolved:
                v = None
            out.append(at_call(mc, call, **({"class": v} if isinstance(v, str) else {"class": None, "why": "the call leaves the class to a default the extractor cannot read"})))
        else:
            out += writer_records(mc, val, mc, call, depth + 1, via + [hop], plugin, following + (fn,))
    for mr, ref in refs:
        out.append(at_call(mr, ref, **{"class": None, "why": "%s, which stores the class, is referenced but not called on the spot (passed, stored or through getattr), so the class it is given cannot be followed" % fn.name}))
    return out or unread("the class is parameter %s of %s, and the plugin has no call of it" % (node.id, fn_label(m_site, fn)))

def class_writers_in(m, plugin):
    info(m)
    out = []
    def recs(value, at):
        return writer_records(m, value, m, at, 0, [], plugin)
    def unread(at, why):
        fn = enclosing(m["par"], at, (ast.FunctionDef, ast.AsyncFunctionDef))
        return [{"plugin": plugin, "file": m["rel"], "function": fn_label(m, fn), "line": at.lineno, "class": None, "why": why}]
    for n in ast.walk(m["tree"]):
        if isinstance(n, ast.Dict):
            for k, v in zip(n.keys, n.values):
                if k is not None and is_class_key(m, k):
                    out += recs(v, k)
        elif isinstance(n, (ast.Assign, ast.AnnAssign)):
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                if class_subscript(m, t):
                    out += recs(n.value, t) if n.value is not None else []
                elif isinstance(t, (ast.Tuple, ast.List)):
                    for i, e in enumerate(t.elts):
                        if class_subscript(m, e):
                            pairs = isinstance(n.value, (ast.Tuple, ast.List)) and len(n.value.elts) == len(t.elts) and not any(isinstance(x, ast.Starred) for x in n.value.elts + t.elts)
                            out += recs(n.value.elts[i], e) if pairs else unread(e, "the class is unpacked from a value the extractor cannot pair")
        elif isinstance(n, ast.AugAssign) and class_subscript(m, n.target):
            out += unread(n.target, "an augmented assignment to the class")
        elif (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("setdefault", "__setitem__")
              and n.args and is_class_key(m, n.args[0])):
            out += recs(n.args[1], n) if len(n.args) >= 2 else unread(n, "setdefault of the class with no value")
    return out

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
            m["plugin_dir"] = pdir
            PLUGIN_FILES.setdefault(plugin, []).append(path)
            tree = m["tree"]
            par = parents_of(tree)
            # M1: a local name bound from getattr(<x>, "register_tool"[, default]) registers too.
            aliases = {"register_tool"}
            # Review N1: every spelling of a daemon propose is read: '<x>.propose(...)' on any object
            # ('self' included), a bare 'propose(...)', a name imported as propose, or a local name bound
            # from getattr(<x>, "propose"[, default]), from '<x>.propose' or from another such name. Its
            # class is then read or the site is unread. Any other reference to a propose that is not called
            # on the spot (passed, stored, wrapped in a partial) is an unread site: the check fails closed.
            proposers = {"propose"}
            bound = set()  # the '<x>.propose', proposer names and getattr(<x>, "propose") an alias assignment reads
            def getattr_propose(n):
                """Review N3: getattr(<x>, "propose"[, default])."""
                return (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "getattr" and len(n.args) >= 2
                        and isinstance(n.args[1], ast.Constant) and n.args[1].value == "propose")
            for _ in range(2):  # an alias of an alias
                for node in ast.walk(tree):
                    if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                            and node.value.func.id == "getattr" and len(node.value.args) >= 2
                            and isinstance(node.value.args[1], ast.Constant) and node.value.args[1].value in ("register_tool", "propose")):
                        (aliases if node.value.args[1].value == "register_tool" else proposers).update(t.id for t in node.targets if isinstance(t, ast.Name))
                        if node.value.args[1].value == "propose" and all(isinstance(t, ast.Name) for t in node.targets):
                            bound.add(node.value)
                    elif (isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets)
                            and ((isinstance(node.value, ast.Attribute) and node.value.attr == "propose") or (isinstance(node.value, ast.Name) and node.value.id in proposers))):
                        proposers.update(t.id for t in node.targets)
                        bound.add(node.value)
                    elif isinstance(node, ast.ImportFrom):
                        proposers.update(a.asname for a in node.names if a.name == "propose" and a.asname)
            for node in ast.walk(tree):
                ref = ((isinstance(node, ast.Attribute) and node.attr == "propose") or (isinstance(node, ast.Name) and node.id in proposers)) and isinstance(node.ctx, ast.Load)
                # Review N3: getattr(<x>, "propose") is a reference too: called on the spot it is read as a
                # propose below; bound to a name it is an alias; anything else (passed, stored) is unread.
                if (ref or getattr_propose(node)) and node not in bound and not (isinstance(par.get(node), ast.Call) and par[node].func is node):
                    proposes.append({"plugin": plugin, "file": rel, "line": node.lineno, "accepts": None, "class": None,
                                     "why": "a propose referenced but not called on the spot (passed, stored or wrapped), so its class cannot be read"})
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                if (isinstance(fn, ast.Attribute) and fn.attr == "propose") or (isinstance(fn, ast.Name) and fn.id in proposers) or getattr_propose(fn):
                    cls_node = arg_of(node, "cls", 0)
                    site = {"plugin": plugin, "file": rel, "line": node.lineno, "accepts": accepted_answers(m, par, node)}
                    site.update(propose_class(m, cls_node) if cls_node is not None else {"class": None, "why": "no class argument"})
                    site.update(propose_irreversible(m, node))
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
# S1b: in every plugin with a propose of a held entry's class, every class writer (a plugin with such a
# propose and no writer at all is the check's finding).
class_writers = []
for plugin in sorted({p["plugin"] for p in proposes if p.get("held")}):
    for path in PLUGIN_FILES.get(plugin, []):
        class_writers.extend(class_writers_in(load(path), plugin))
class_writers.sort(key=lambda w: (w["file"], w["line"], w["function"], str(w.get("class"))))
print(json.dumps({"tools": out, "unread": unread, "proposes": proposes, "village_ops": village_ops, "class_writers": class_writers}, sort_keys=True))
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
  // Review M3, S1: every daemon propose in every plugin, each judged by the
  // check. `gated_plugin` says only whether its plugin owns a gated tool (the
  // report shows it); a propose outside the hook is judged all the same, so
  // there is no separate list a reader could take for "not judged".
  const gatedPlugins = new Set(tools.map((t) => t.plugin));
  const proposes = found.proposes.map((p) => ({ ...p, gated_plugin: gatedPlugins.has(p.plugin) }));
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
  envelopeScope = { gated, tools, unread, envelopes, proposes, classWriters: found.class_writers };
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
  // Review S1b: every line that gives a held entry its class, in a plugin whose propose carries one.
  corpus.class_writers = envelopeScope.classWriters;
}

writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
process.stdout.write(
  `${recipes.length} recipes${envelopeScope === undefined ? "" : `, ${String(envelopeScope.envelopes.length)} envelopes, ${String(envelopeScope.tools.length)} gated plugin tools`} at ${sha} -> ${relative(REPO_ROOT, OUT)}\n`,
);
