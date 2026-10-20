// Planted core moves for the CLASS-DIFF tests (B-167 fold 1). Vendored from
// claude-review-b's refute tool (lanes-review-b/B167-tools/plant.mjs), unchanged
// but for this header: it patches a scratch COPY of a build with env-switched
// one-condition moves in resolve, classifyForHook and the Hermes tool table, so
// a test can prove each one fails the gate. Never run against a real build.
// Adds env-switched planted moves to a COPY of an approval.md build (fake data, scratch only).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, P] = process.argv.slice(2);
const edit = (file, from, to) => {
  const p = join(root, file); const t = readFileSync(p, "utf8");
  if (!t.includes(from)) throw new Error(`anchor missing in ${file}: ${from}`);
  writeFileSync(p, t.replace(from, to));
};
edit("dist/src/core/policy-match.js", "export function resolve(load, actionClass, options = {}) {",
`// PLANTED (refuter scratch): env ${P}RESOLVE="class=autonomy[:supervision],..."
export function resolve(load, actionClass, options = {}) {
  const r = resolve__orig(load, actionClass, options);
  const spec = process.env["${P}RESOLVE"];
  if (spec) for (const one of spec.split(",")) {
    const [cls, aut] = one.split("=");
    if (cls === actionClass) { const [a, s] = aut.split(":"); return { ...r, autonomy: a, supervision: s ?? null, liveRate: s === "live" ? 0.5 : null }; }
  }
  return r;
}
function resolve__orig(load, actionClass, options = {}) {`);
edit("dist/src/cli/hook.js", "export function classifyForHook(command, protectedPaths, cwd, readRoots = [], ",
`// PLANTED (refuter scratch): env ${P}CLASSIFY="plant,plant"
import { basename as __pb, dirname as __pd } from "node:path";
import { existsSync as __pe, realpathSync as __pr } from "node:fs";
const __canon = (p) => { try { return __pr(p); } catch { return p; } };
export function classifyForHook(command, protectedPaths, cwd, readRoots = [], execCode = false, credentialCwds = []) {
  const plants = (process.env["${P}CLASSIFY"] ?? "").split(",").filter(Boolean);
  const refuse = { result: { ok: false, code: "unparseable", detail: "planted refusal", segment: command }, notes: [] };
  const isCurl = /^\\s*curl\\b/u.test(command);
  if (plants.includes("refuse-curl") && isCurl) return refuse;
  if (plants.includes("refuse-curl-home") && isCurl && __pb(cwd) === ".hermes") return refuse;
  if (plants.includes("refuse-plaza") && command.includes("agent_plaza_selfie")) return refuse;
  const out = classifyForHook__orig(command, protectedPaths, cwd, readRoots, execCode, credentialCwds);
  if (!out.result.ok) return out;
  let segs = out.result.segments;
  const add = (cls) => { segs = [...segs, { ...segs[0], class: cls, rule: "planted" }]; };
  if (plants.includes("loosen-home")) segs = segs.filter((s) => s.class !== "account.credential");
  if (plants.includes("readweb-curl")) segs = segs.map((s) => (s.class === "network.call" ? { ...s, class: "read.web" } : s));
  const hh = process.env.APPROVAL_HERMES_HOME ?? process.env.HERMES_HOME;
  if (plants.includes("home-parent") && hh && __canon(__pd(hh)) === __canon(cwd) && command.includes("$EDGEOS_API_KEY")) add("account.credential");
  if (plants.includes("hosted") && process.env.APPROVAL_HERMES_HOME && command.includes("$EDGEOS_API_KEY")) add("account.credential");
  if (plants.includes("skills-present") && /^\\s*bun skills\\//u.test(command) && __pe(__canon(cwd) + "/skills/edgeos/scripts")) add("policy.core");
  if (plants.includes("readroots") && readRoots.length > 0 && isCurl) add("account.credential");
  if (plants.includes("execcode") && execCode && isCurl) add("account.credential");
  if (segs === out.result.segments) return out;
  const classes = [...new Set(segs.map((s) => s.class))];
  return { ...out, result: { ...out.result, segments: segs, classes } };
}
function classifyForHook__orig(command, protectedPaths, cwd, readRoots = [], `);
edit("dist/src/cli/hook.js", "function hermesToolRule(toolName, toolInput) {",
`// PLANTED (refuter scratch): env ${P}TOOL="tool=class,..."
function hermesToolRule(toolName, toolInput) {
  const spec = process.env["${P}TOOL"];
  if (spec) for (const one of spec.split(",")) { const [t, c] = one.split("="); if (t === toolName) return { kind: "gated", cls: c, headline: toolName + " (" + c + ")" }; }
  return hermesToolRule__orig(toolName, toolInput);
}
function hermesToolRule__orig(toolName, toolInput) {`);
// Fold 3 (S-5), after review-b's recheck tool plant-task.mjs: env ${P}TASK changes
// the task id the Hermes hook mints ("suffix:<s>" renames every task; "swap"
// trades cd-N with cd-(N+-4) in blocks of 8; "const:<id>" puts every call under
// one task), so the request lands where a runner guessing the id would miss it.
edit("dist/src/cli/hook.js", "`hook:${input.sessionId}:${input.toolUseId ?? randomBytes(8).toString(\"hex\")}`;",
`((__id) => { /* PLANTED (refuter scratch): env ${P}TASK */
          const spec = process.env["${P}TASK"] ?? "";
          if (spec.startsWith("suffix:")) return __id + spec.slice(7);
          if (spec === "swap") { const m = /^(hook:[^:]*:cd-)(\\d+)$/u.exec(__id); if (m) { const n = Number(m[2]); return m[1] + String((n - 1) % 8 < 4 ? n + 4 : n - 4); } }
          if (spec.startsWith("const:")) return "hook:" + input.sessionId + ":" + spec.slice(6);
          return __id; })(\`hook:\${input.sessionId}:\${input.toolUseId ?? randomBytes(8).toString("hex")}\`);`);
// env ${P}DENYKEY changes the request keys a hook-timeout deny names, not the
// log: "suffix:<s>" names keys the store does not hold, "none" names no key.
// Fold 5 (review-b N-9, after its plant-f3.mjs "xsame"): "xsame" names the
// latest earlier request in the store whose summary equals this call's own
// (the same command at another workdir), so the deny points at another call.
{
  const p = join(root, "dist/src/cli/hook.js");
  const from = "${waitKeys.join(\", \")}";
  const t = readFileSync(p, "utf8");
  if (t.split(from).length < 3) throw new Error("anchor missing in dist/src/cli/hook.js: waitKeys");
  writeFileSync(p, t.replaceAll(from, "${__plantDenyKeys(waitKeys).join(\", \")}") +
`
// PLANTED (refuter scratch): env ${P}DENYKEY
import { readFileSync as __plantRead } from "node:fs";
function __plantDenyKeys(keys) {
  const spec = process.env["${P}DENYKEY"] ?? "";
  if (spec.startsWith("suffix:")) return keys.map((k) => k + spec.slice(7));
  if (spec === "none") return [];
  if (spec === "xsame") {
    let rows = [];
    try {
      for (const line of __plantRead(".approval/log/events.jsonl", "utf8").split("\\n")) {
        if (line.trim() === "") continue;
        const e = JSON.parse(line);
        if (e.event === "approval.requested") rows.push({ key: e.action_key, summary: e.payload?.summary });
      }
    } catch { rows = []; }
    const own = rows.find((r) => keys.includes(r.key));
    const others = rows.filter((r) => own !== undefined && !keys.includes(r.key) && r.summary === own.summary);
    return others.length > 0 ? [others[others.length - 1].key] : keys;
  }
  return keys;
}
`);
}
// Fold 5 (review-b N-10, after its plant-f3.mjs "CLS"): env ${P}CLS="other:<cls>"
// rewrites every class field of task.registered and approval.requested to
// <cls> as the core appends them, so the log names a class other than the one
// the hook carded on.
edit("dist/src/core/log.js", "export function appendEvent(logPath, input, options = {}) {\n",
`export function appendEvent(logPath, input, options = {}) {
    input = __plantCls(input); /* PLANTED (refuter scratch): env ${P}CLS */
`);
{
  const p = join(root, "dist/src/core/log.js");
  writeFileSync(p, readFileSync(p, "utf8") + `
// PLANTED (refuter scratch): env ${P}CLS
function __plantCls(input) {
  const spec = process.env["${P}CLS"] ?? "";
  if (!spec.startsWith("other:") || input === null || typeof input !== "object") return input;
  if (input.event !== "task.registered" && input.event !== "approval.requested") return input;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = k === "class" && typeof x === "string" ? spec.slice(6) : walk(x);
    return o;
  };
  return { ...input, payload: walk(input.payload) };
}
`);
}
console.log("planted", root, P);
