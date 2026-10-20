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
 * is a card (the hook opened a request and nobody tapped in 200 ms); its
 * classes come from that request, bound to the call by the key the deny names
 * (fold 3, S-5), and a card whose request cannot be bound is an error.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const logPath = (store) => join(store, ".approval", "log", "events.jsonl");

/**
 * Every request a store's log holds, one row per action: the byte offset of its
 * line, its event, task, action key, class and summary. `task.registered` rows
 * come from its actions (key = `idempotency_key`), `approval.requested` rows
 * from the event (key = `action_key`).
 */
export function readRequests(store) {
  const log = logPath(store);
  if (!existsSync(log)) return [];
  const buf = readFileSync(log);
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(at, end).toString("utf8");
    let event = null;
    try {
      event = line.trim() === "" ? null : JSON.parse(line);
    } catch {
      event = null;
    }
    if (event !== null && typeof event.task === "string") {
      if (event.event === "task.registered") {
        for (const a of event.payload?.actions ?? []) out.push({ at, event: event.event, task: event.task, key: a?.idempotency_key ?? null, cls: a?.class ?? null, summary: a?.summary ?? null });
      }
      if (event.event === "approval.requested") {
        out.push({ at, event: event.event, task: event.task, key: event.action_key ?? null, cls: event.payload?.class ?? null, summary: event.payload?.summary ?? null });
      }
    }
    at = end + 1;
  }
  return out;
}

/**
 * The request keys a `hook-timeout` deny names ("no decision on K1, K2 within
 * ..."), read from the deny sentence only: the hook never echoes the command
 * there, so a recipe cannot plant a key.
 */
export function timeoutKeys(text) {
  const m = text.match(/hook-timeout: (?:no decision on|the caller that asked went away before) ([^\s,"]+(?:, [^\s,"]+)*)/u);
  return m === null ? [] : m[1].split(", ");
}

/**
 * Whether a request's summary is this call's: a terminal call's summary is its
 * command with whitespace runs collapsed and trimmed (core's `truncate`), cut
 * with "…" when long; any other tool's starts with the tool name.
 */
export function summaryFits(summary, tool, input) {
  if (typeof summary !== "string") return false;
  if (tool === "terminal") {
    if (typeof input?.command !== "string") return false;
    const command = input.command.replace(/\s+/gu, " ").trim();
    return summary === command || (summary.endsWith("…") && summary.length > 1 && command.startsWith(summary.slice(0, -1)));
  }
  return summary === tool || summary.startsWith(`${tool} `);
}

/**
 * Bind one call to the request it opened (fold 3, review-b S-5), never by a
 * task id this runner guesses:
 * - a `hook-timeout` deny names its request keys; each must be in the call's own
 *   store (a retry of the same bytes adopts an earlier request, and the deny
 *   names that one);
 * - a deny that names none: the requests appended to the call's store while the
 *   call ran (each worker runs its calls one at a time in its own store) whose
 *   summary is this call's tool and command;
 * then exactly one task, and every action of it this call's. Anything else is
 * `{ error }`. Returns `{ task, classes }`.
 */
export function bindRequest({ text, tool, input, span }, requests) {
  const keys = timeoutKeys(text);
  let mine;
  if (keys.length > 0) {
    mine = requests.filter((r) => r.key !== null && keys.includes(r.key));
    const missing = keys.filter((k) => !mine.some((r) => r.key === k));
    if (missing.length > 0) return { error: `the hook names request ${missing.join(", ")}, which this call's store does not hold` };
  } else {
    mine = requests.filter((r) => r.at >= span[0] && r.at < span[1] && summaryFits(r.summary, tool, input));
  }
  const tasks = [...new Set(mine.map((r) => r.task))];
  if (tasks.length === 0) return { error: `no request in this call's store matches ${tool} and its command (the deny names no request key)` };
  if (tasks.length > 1) return { error: `${String(tasks.length)} requests (${tasks.join(", ")}) match this one call` };
  const all = requests.filter((r) => r.task === tasks[0]);
  const foreign = all.find((r) => !summaryFits(r.summary, tool, input));
  if (foreign !== undefined) return { error: `request ${tasks[0]} carries an action of another call (${String(foreign.summary).slice(0, 80)})` };
  const classes = [...new Set(all.map((r) => r.cls).filter((c) => typeof c === "string"))].sort();
  if (classes.length === 0) return { error: `request ${tasks[0]} names no class` };
  return { task: tasks[0], classes };
}

/**
 * Environment names the sampling secret may never take (fold 3, review-b N-7):
 * the box layout (HOME, HERMES_HOME, APPROVAL_*), what finds and runs node
 * (PATH, NODE_*), and anything not a plain variable name.
 */
export function reservedEnvName(name) {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || ["HOME", "HERMES_HOME", "PATH"].includes(name) || /^(APPROVAL|NODE)_/u.test(name);
}

export function boxEnv(home, hh, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("APPROVAL_") && k !== "HERMES_HOME") env[k] = v;
  // The extra (the fixed sampling value) beats the runner's own value of that
  // name, so a real secret is never read; the layout keys come last and win.
  return { ...env, ...extra, HOME: home, HERMES_HOME: hh, APPROVAL_HERMES_HOME: hh };
}

/**
 * Run a corpus and its harness calls through one core's real hook in a fresh
 * box. Returns `{ calls }` (one per call per column) or `{ error }`.
 */
export async function runBox({ coreRoot, corpus, policyText, overlayTree, boxRoot, toolsLines, extraEnv = {}, concurrency = 1, harnessOnly = null }) {
  const cliPath = join(coreRoot, "dist", "src", "cli", "main.js");
  if (!existsSync(cliPath)) return { error: `no hook CLI at ${cliPath}` };
  const reserved = Object.keys(extraEnv).filter(reservedEnvName);
  if (reserved.length > 0) return { error: `the template names audit.sampling_secret_env ${reserved.map((n) => JSON.stringify(n)).join(", ")}, a box layout or runtime variable; the class-diff refuses it (N-7)` };
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
    const env = boxEnv(home, hh, extraEnv);
    // One store per worker (fold 2, N-6): concurrent hooks appending to one log
    // could lose a race (`hook-gate-refused:append-failed`), which read as a
    // refusal. A box's hooks share one log; ours never race on it.
    const workers = Math.max(1, concurrency);
    const stores = [];
    for (let w = 0; w < workers; w += 1) {
      const store = join(box, `store-${String(w)}`);
      mkdirSync(store);
      const cliSync = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: store, env, encoding: "utf8" });
      let r = cliSync(["init", "--json"]);
      if (r.status !== 0) return { error: `approval init failed at ${coreRoot}: ${r.stderr}` };
      writeFileSync(join(store, "APPROVAL.md"), `# Policy\n\n\`\`\`yaml approval-policy\n${policyText}\n\`\`\`\n`);
      r = cliSync(["policy", "attest", "--bootstrap", "--as", "human:operator"]);
      if (r.status !== 0) return { error: `approval policy attest failed at ${coreRoot}: ${r.stderr}` };
      stores.push(store);
    }

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
    const one = (job, store) =>
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
          resolveJob({ result: { key: job.key, column: job.column, kind: job.kind, where: job.where, command: job.command, ...v, reason: scrub(v.reason), detail: scrub(se.trim().slice(0, 240)) }, text: `${so}\n${se}` });
        });
        p.stdin.end(JSON.stringify(envelope));
      });
    const calls = Array.from({ length: jobs.length });
    const runs = Array.from({ length: jobs.length });
    const size = (store) => {
      try {
        return statSync(logPath(store)).size;
      } catch {
        return 0;
      }
    };
    let next = 0;
    const worker = async (w) => {
      while (next < jobs.length) {
        const i = next++;
        // The bytes this call appended to its worker's store: this worker runs
        // nothing else there while the call runs.
        const start = size(stores[w]);
        const { result, text } = await one(jobs[i], stores[w]);
        calls[i] = result;
        runs[i] = { store: w, text, span: [start, size(stores[w])] };
      }
    };
    await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
    // A card's classes (fold 2, S-4; bound to the call in fold 3, S-5): the
    // hook's timeout line names no class, so they come from the request the hook
    // opened, in the store's own log, found by bindRequest. A card whose request
    // is not found, or not this call's, is an error (the gate exits 2): read as
    // a card of no class it would hide a real move.
    const requests = stores.map((s) => readRequests(s));
    calls.forEach((call, i) => {
      const run = runs[i];
      const job = jobs[i];
      if (call.verdict !== "deny" && call.verdict !== "allow") return;
      const card = call.verdict === "deny" && call.code === "hook-timeout";
      // An allow or another deny names no request key; only what it appended counts.
      const bound = bindRequest({ text: card ? run.text : "", tool: job.tool, input: job.input, span: run.span }, requests[run.store]);
      if ("error" in bound) {
        if (card) Object.assign(call, { verdict: "error", code: "card-request-unbound", detail: scrub(`${bound.error}; ${call.detail}`.slice(0, 400)) });
        return;
      }
      call.task = bound.task;
      call.requested = bound.classes;
      call.classes = card ? [...new Set([...call.classes, ...bound.classes])].sort() : call.classes.length === 0 ? bound.classes : call.classes;
    });
    return { calls };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}
