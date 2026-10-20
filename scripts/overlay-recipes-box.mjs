/**
 * The box half of the CLASS-DIFF (B-167 fold 1, review-b M-1 and M-2): every
 * shipped call goes through a core's REAL `approval hook hermes`, as a Hermes
 * pre_tool_call envelope, in a box-shaped layout, instead of through
 * `classifyForHook` with the inputs a box never has.
 *
 * The layout, per core (fake data only, nothing secret):
 * - HOME = <box>/home/hermes, HERMES_HOME = APPROVAL_HERMES_HOME =
 *   $HOME/.hermes (the control plane exports APPROVAL_HERMES_HOME on every
 *   box), holding a `.env` with one dummy key name, a `config.yaml`, and the
 *   overlay's `skills/` and `workspace/` copied from the overlay tree;
 * - a store with the corpus's template policy, attested by bootstrap, window
 *   closed; the hook computes its own readRoots, credential cwds and exec gate
 *   from that store, as on a box;
 * - every recipe as a `terminal` call at four workdirs: $HERMES_HOME, $HOME,
 *   $HERMES_HOME/workspace, and unset;
 * - the harness calls: core's own Hermes tools (terminal, read_file,
 *   write_file, patch, search_files, execute_code, send_message, cronjob,
 *   process, skill_manage, delegate_task, browser_*) and one envelope per
 *   `tools:` line of either template, so a template line that shadows an
 *   existing tool moves that tool's own row.
 *
 * Each call's verdict is read off the hook: exit 0 is an allow (its stderr
 * names the classes), exit 2 a deny with its code. A deny with `hook-timeout`
 * is a card (the hook opened a request and nobody tapped in 200 ms).
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Envelopes for core's own Hermes tools, with inputs a box sees. `$HH` and `$WS` are filled per box. */
export const CORE_TOOL_CALLS = [
  ["terminal", { command: "ls", workdir: "$WS" }],
  ["read_file", { path: "$HH/skills/edgeos/SKILL.md" }],
  ["read_file", { path: "$WS/notes.md" }],
  ["write_file", { path: "$WS/notes.md", content: "fake" }],
  ["patch", { path: "$WS/notes.md", old_string: "a", new_string: "b" }],
  ["search_files", { pattern: "fake", path: "$WS" }],
  ["execute_code", { code: "print(1)" }],
  ["send_message", { target: "telegram", message: "hello from a fake test" }],
  ["cronjob", { action: "create", schedule: "0 9 * * *", prompt: "fake" }],
  ["cronjob", { action: "list" }],
  ["process", { action: "list" }],
  ["skill_manage", { action: "create", name: "fake-skill", content: "fake" }],
  ["delegate_task", { goal: "fake" }],
  ["browser_navigate", { url: "https://example.com/" }],
];

/** A tool name a `tools:` match line names: the literal, or its glob with `*` filled. */
export function probeName(match) {
  return String(match).replaceAll("*", "probe");
}

/** Every harness envelope for a box: core's own tools plus one per tools line of the given templates. */
export function harnessCalls(toolsLines) {
  const out = [];
  const seen = new Set();
  const push = (tool, input) => {
    const key = `${tool}\u0000${JSON.stringify(input)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tool, input });
  };
  for (const [tool, input] of CORE_TOOL_CALLS) push(tool, input);
  for (const line of toolsLines) push(probeName(line.match), {});
  return out;
}

const fillPaths = (value, hh, ws) =>
  JSON.parse(JSON.stringify(value).replaceAll("$WS", ws).replaceAll("$HH", hh));

/** The verdict of one hook run, read off its exit code and stderr. */
export function readVerdict(status, stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  if (status === 0) {
    const line = stderr.match(/approval hook hermes: allow — ([^\n]*)/u);
    // An exit 0 with no allow line is not an allow: the CLI did not run the hook
    // at all (seen when its path reached node through a symlinked tmpdir and the
    // entry-point check did not fire). Fail closed, as an error.
    if (line === null) return { verdict: "error", code: "no-allow-line", classes: [], reason: "" };
    const reason = line[1];
    // The hook's allow lines: "autonomous: a, b (note)", "granted: a, b needs no
    // approval under this policy" (supervised), "granted: <task> (a, b)" (a spent grant).
    const named =
      reason.match(/^autonomous: ([^(]*?)(?: \(|$)/u) ??
      reason.match(/^granted: (.*?) needs no approval/u) ??
      reason.match(/^granted: \S+ \(([^)]*)\)/u) ??
      reason.match(/^granted: ([^(]*?)(?: \(|$)/u);
    const classes = named === null ? [] : named[1].split(",").map((c) => c.trim()).filter((c) => /^[a-z0-9._*-]+$/u.test(c));
    return { verdict: "allow", code: null, classes, reason };
  }
  const code = (text.match(/hook-[a-z0-9-]+(?::[a-z0-9-]+)?/u) ?? [])[0] ?? `exit-${String(status)}`;
  const cls = (text.match(/class ([a-z0-9._*-]+)/u) ?? [])[1];
  return { verdict: status === 2 ? "deny" : "error", code, classes: cls === undefined ? [] : [cls], reason: "" };
}

function boxEnv(home, hh, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("APPROVAL_") && k !== "HERMES_HOME") env[k] = v;
  return { ...env, HOME: home, HERMES_HOME: hh, APPROVAL_HERMES_HOME: hh, ...extra };
}

/**
 * Run a corpus and its harness calls through one core's real hook in a fresh
 * box. Returns `{ calls }` (one per call per column) or `{ error }`.
 */
export async function runBox({ coreRoot, corpus, policyText, overlayTree, boxRoot, toolsLines, extraEnv = {}, concurrency = 1, harnessOnly = null }) {
  const cliPath = join(coreRoot, "dist", "src", "cli", "main.js");
  if (!existsSync(cliPath)) return { error: `no hook CLI at ${cliPath}` };
  // The real path: the CLI runs its main only when argv[1] is its own module
  // path, and a symlinked tmpdir (macOS /var -> /private/var) breaks that.
  const cli = realpathSync(cliPath);
  const box = realpathSync(mkdtempSync(join(boxRoot, "class-diff-box-")));
  try {
    const home = join(box, "home", "hermes");
    const hh = join(home, ".hermes");
    const ws = join(hh, "workspace");
    mkdirSync(join(hh, "skills"), { recursive: true });
    if (overlayTree !== undefined) {
      for (const dir of ["skills", "workspace"]) {
        if (existsSync(join(overlayTree, dir))) cpSync(join(overlayTree, dir), join(hh, dir), { recursive: true });
      }
    }
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(hh, ".env"), "EDGEOS_API_KEY=dummy-not-a-secret\n");
    writeFileSync(join(hh, "config.yaml"), "model: fake-model\n");
    writeFileSync(join(ws, "notes.md"), "a\n");
    const store = join(box, "store");
    mkdirSync(store);
    const env = boxEnv(home, hh, extraEnv);
    const cliSync = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: store, env, encoding: "utf8" });
    let r = cliSync(["init", "--json"]);
    if (r.status !== 0) return { error: `approval init failed at ${coreRoot}: ${r.stderr}` };
    writeFileSync(join(store, "APPROVAL.md"), `# Policy\n\n\`\`\`yaml approval-policy\n${policyText}\n\`\`\`\n`);
    r = cliSync(["policy", "attest", "--bootstrap", "--as", "human:operator"]);
    if (r.status !== 0) return { error: `approval policy attest failed at ${coreRoot}: ${r.stderr}` };

    const fill = (c) => {
      let o = c;
      for (const { pattern, value } of corpus.fill ?? []) o = o.replace(new RegExp(pattern, "gu"), value);
      return o;
    };
    const workdirs = [
      ["hermes-home", hh],
      ["home", home],
      ["workspace", ws],
      ["unset", null],
    ];
    const jobs = [];
    const seen = new Map();
    const keyed = (column, kind, file, command) => {
      const base = `${column}\u0000${kind}\u0000${file}\u0000${command}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return `${base}\u0000${n}`;
    };
    for (const recipe of corpus.recipes) {
      const file = recipe.where.replace(/:\d+$/u, "");
      for (const [column, wd] of workdirs) {
        const input = { command: fill(recipe.command) };
        if (wd !== null) input.workdir = wd;
        jobs.push({ key: keyed(column, "recipe", file, recipe.command), column, kind: "recipe", where: recipe.where, command: recipe.command, tool: "terminal", input });
      }
    }
    for (const call of harnessCalls(toolsLines).filter((c) => harnessOnly === null || harnessOnly.includes(c.tool))) {
      const label = `${call.tool} ${JSON.stringify(call.input)}`;
      jobs.push({ key: keyed("harness", "harness", "tools", label), column: "harness", kind: "harness", where: "harness", command: label, tool: call.tool, input: fillPaths(call.input, hh, ws) });
    }
    const scrub = (s) => s.replaceAll(ws, "$WS").replaceAll(hh, "$HH").replaceAll(home, "$HOME").replaceAll(box, "$BOX");
    let n = 0;
    const one = (job) =>
      new Promise((resolveJob) => {
        n += 1;
        const id = `cd-${String(n)}`;
        const envelope = {
          hook_event_name: "pre_tool_call",
          session_id: "class-diff",
          tool_use_id: id,
          cwd: hh,
          profile: "default",
          tool_name: job.tool,
          tool_input: job.input,
          extra: { turn_id: "turn-1", tool_call_id: id },
        };
        const p = spawn(
          process.execPath,
          [cli, "hook", "hermes", "--as", "agent:hermes", "--harness-cap", "300s", "--timeout", "200ms", "--interval", "50ms"],
          { cwd: store, env },
        );
        let so = "";
        let se = "";
        p.stdout.on("data", (d) => (so += d));
        p.stderr.on("data", (d) => (se += d));
        p.on("close", (status) => {
          const v = readVerdict(status, so, se);
          resolveJob({ key: job.key, column: job.column, kind: job.kind, where: job.where, command: job.command, ...v, reason: scrub(v.reason), detail: scrub(se.trim().slice(0, 240)) });
        });
        p.stdin.end(JSON.stringify(envelope));
      });
    const calls = Array.from({ length: jobs.length });
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const i = next++;
        calls[i] = await one(jobs[i]);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { calls };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}
