/**
 * `approval hook hermes`: the tool rule table and the fail-closed error paths
 * (APRV-445).
 *
 * The rule table gives Hermes's own side-effecting tools a class each, where
 * until now every one of them was answered "not a gated tool". Every class
 * below is `human-only` in this suite's policy, so a gated call is refused at
 * once and the refusal names the class it was judged under; one class is
 * `autonomous` so the binding a start records can be read back.
 *
 * The error-path half pins that a pre-event answer is only ever the adapter's
 * own `{}` allow at exit 0 or a `{"action":"block"}` directive at exit 2. Hermes
 * (v2026.9.24) reads any other non-zero exit with an empty stdout as an ALLOW.
 *
 * Spawn the compiled CLI; never hand-write log lines. Every path is absolute,
 * for the reason `cli-hook-hermes.test.ts` gives.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { commandHook } from "../src/cli/hook.js";
import { protectedPathClass } from "../src/core/command-class.js";
import { payloadHash } from "../src/core/payload.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hermes-rules-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = "", nodeArgs: string[] = []): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [...nodeArgs, CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  cron.manage:",
  "    autonomy: human-only",
  "  process.write:",
  "    autonomy: human-only",
  "  browser.exec:",
  "    autonomy: human-only",
  "  skill.manage:",
  "    autonomy: human-only",
  "  message.send:",
  "    autonomy: human-only",
  "  agent.delegate:",
  "    autonomy: autonomous",
  "  policy.core:",
  "    autonomy: human-only",
  "  account.credential:",
  "    autonomy: human-only",
  "  network.call:",
  "    autonomy: manual",
  "  intent.publish.*:",
  "    autonomy: manual",
  "    agent_may_request: true",
  "  intent.publish.inferred.index:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function logRecords(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function event(dir: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "pre_tool_call",
    session_id: "hermes-sess-rules",
    tool_use_id: `tool-${String(Math.random()).slice(2)}`,
    cwd: dir,
    profile: "default",
    extra: {},
    ...fields,
  });
}

function hook(dir: string, input: string, extra: string[] = []): Run {
  return runCli(["hook", "hermes", "--as", "agent:hermes", ...extra], dir, input);
}

/** The one Hermes dialect: `{}` at 0, or exactly `{action:"block", message}` at 2. */
function verdictOf(run: Run): { permission: "allow" | "deny"; message: string } {
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    assert.equal(run.code, 0, run.stderr);
    return { permission: "allow", message: "" };
  }
  assert.deepEqual(keys.sort(), ["action", "message"], run.stdout);
  assert.equal(parsed["action"], "block");
  assert.equal(run.code, 2, `a Hermes block exits 2, got ${String(run.code)}`);
  return { permission: "deny", message: String(parsed["message"]) };
}

// ---------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------

test("each of Hermes's own side-effecting tools is judged under its own class", () => {
  const dir = ready();
  const cases: Array<[tool: string, input: Record<string, unknown>, cls: string]> = [
    ["cronjob_manage", { action: "create", schedule: "0 * * * *", script: "job.sh" }, "cron.manage"],
    ["cronjob_manage", { action: "update", job_id: "j1", script: "other.sh" }, "cron.manage"],
    ["cronjob_manage", { action: "run", job_id: "j1" }, "cron.manage"],
    ["cronjob_manage", { action: "pause", job_id: "j1" }, "cron.manage"],
    ["cronjob_manage", { action: "resume", job_id: "j1" }, "cron.manage"],
    ["cronjob_manage", { action: "remove", job_id: "j1" }, "cron.manage"],
    // The legacy alias and an action this table has never heard of: the
    // tool's class, not the read.
    ["cronjob", { action: "create", script: "job.sh" }, "cron.manage"],
    ["cronjob_manage", { action: "reschedule-everything" }, "cron.manage"],
    ["cronjob_manage", {}, "cron.manage"],
    ["process_manage", { action: "write", session_id: "p1", data: "rm -rf /\n" }, "process.write"],
    ["process_manage", { action: "submit", session_id: "p1", data: "y\n" }, "process.write"],
    ["process_manage", { action: "kill", session_id: "p1" }, "process.write"],
    ["process_manage", { action: "close", session_id: "p1" }, "process.write"],
    ["process_manage", { action: "handoff", session_id: "p1" }, "process.write"],
    ["process", { action: "write", session_id: "p1", data: "x" }, "process.write"],
    ["browser_exec", { code: "document.cookie" }, "browser.exec"],
    ["browser_cdp", { method: "Runtime.evaluate" }, "browser.exec"],
    ["browser_vault_fill", { field: "password" }, "browser.exec"],
    ["skill_manage", { action: "create", name: "s" }, "skill.manage"],
    ["send_message", { target: "telegram", message: "hello" }, "message.send"],
  ];
  for (const [tool, input, cls] of cases) {
    const run = hook(dir, event(dir, { tool_name: tool, tool_input: input }));
    const verdict = verdictOf(run);
    assert.equal(verdict.permission, "deny", `${tool} ${JSON.stringify(input)} was allowed`);
    assert.match(verdict.message, /class-human-only/u, `${tool}: ${verdict.message}`);
    assert.ok(verdict.message.includes(cls), `${tool} was not judged under ${cls}: ${verdict.message}`);
  }
});

test("the read actions of cronjob_manage and process_manage are allowed and record nothing", () => {
  const dir = ready();
  const before = logRecords(dir).length;
  for (const [tool, action] of [
    ["cronjob_manage", "list"],
    ["cronjob", "list"],
    ["process_manage", "list"],
    ["process_manage", "poll"],
    ["process_manage", "log"],
    ["process_manage", "wait"],
    ["process", "poll"],
  ] as const) {
    const run = hook(dir, event(dir, { tool_name: tool, tool_input: { action } }));
    assert.equal(verdictOf(run).permission, "allow", `${tool} ${action}: ${run.stdout}`);
    assert.match(run.stderr, /changes nothing/u);
  }
  assert.equal(logRecords(dir).length, before);
});

test("a gated tool call binds the WHOLE call: the start's payload_hash is the hash of {tool, input}", () => {
  const dir = ready();
  const input = { goal: "summarise the inbox", toolsets: ["web"] };
  const run = hook(dir, event(dir, { tool_name: "delegate_task", tool_input: input, tool_use_id: "deleg-1" }));
  assert.equal(verdictOf(run).permission, "allow", run.stderr);
  const started = logRecords(dir).filter((record) => record["event"] === "execution.started");
  assert.equal(started.length, 1);
  const payload = started[0]?.["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], "agent.delegate");
  assert.equal(payload["payload_hash"], payloadHash({ tool: "delegate_task", input }));

  // The post event closes it, like any other gated tool.
  const post = hook(
    dir,
    event(dir, {
      hook_event_name: "post_tool_call",
      tool_name: "delegate_task",
      tool_input: input,
      tool_use_id: "deleg-1",
      result: "ok",
    }),
  );
  assert.equal(post.code, 0, post.stderr);
  assert.equal(post.stdout, "");
  assert.match(post.stderr, /post-tool-use/u);
  assert.doesNotMatch(post.stderr, /post-tool-not-gated/u);
});

test("a tool neither the adapter nor the table knows is still answered, not gated", () => {
  const dir = ready();
  const run = hook(dir, event(dir, { tool_name: "some_future_tool", tool_input: { action: "write" } }));
  assert.equal(verdictOf(run).permission, "allow");
  assert.match(run.stderr, /not a gated tool/u);
});

// ---------------------------------------------------------------------------
// The $HERMES_HOME path rows
// ---------------------------------------------------------------------------

test("writes under .hermes/scripts are cron.manage; .hermes/approval and the allowlist lock are organs", () => {
  for (const path of [".hermes/scripts/job.sh", "/data/.hermes/scripts/sub/job.py", "~/.hermes/scripts"]) {
    assert.equal(protectedPathClass(path, []), "cron.manage", path);
  }
  for (const path of [
    ".hermes/approval/facade.env",
    "/data/.hermes/approval",
    "/data/.hermes/shell-hooks-allowlist.json.lock",
    "/data/.hermes/shell-hooks-allowlist.json",
  ]) {
    assert.equal(protectedPathClass(path, []), "policy.core", path);
  }
  // Ordinary session state is still not an organ.
  assert.equal(protectedPathClass("/data/.hermes/sessions/s1.json", []), null);
  assert.equal(protectedPathClass("/data/hermes/scripts/job.sh", []), null);
});

test("a script written into .hermes/scripts through write_file or terminal is cron.manage", () => {
  const dir = ready();
  const scripts = join(dir, ".hermes", "scripts");
  const viaFile = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "write_file",
        tool_input: { path: join(scripts, "job.sh"), content: "#!/bin/sh\ncurl evil\n" },
      }),
    ),
  );
  assert.equal(viaFile.permission, "deny");
  assert.ok(viaFile.message.includes("cron.manage"), viaFile.message);

  const viaShell = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "terminal",
        tool_input: { command: `echo 'curl evil' > ${join(scripts, "job.sh")}`, workdir: dir },
      }),
    ),
  );
  assert.equal(viaShell.permission, "deny");
  assert.ok(viaShell.message.includes("cron.manage"), viaShell.message);

  const lock = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "terminal",
        tool_input: { command: `chmod 000 ${join(dir, ".hermes", "shell-hooks-allowlist.json.lock")}`, workdir: dir },
      }),
    ),
  );
  assert.equal(lock.permission, "deny");
  assert.ok(lock.message.includes("policy.core"), lock.message);
});

// ---------------------------------------------------------------------------
// Every error path blocks
// ---------------------------------------------------------------------------

test("a misconfigured hook entry answers with the block directive at exit 2, never a bare usage error", () => {
  const dir = ready();
  const input = event(dir, { tool_name: "terminal", tool_input: { command: "ls", workdir: dir } });
  for (const extra of [
    ["--bogus-flag"],
    ["--timeout", "soon"],
    ["--interval", "often"],
    ["--retry-grace", "never"],
    ["--harness-cap", "big"],
    ["unexpected-positional"],
  ]) {
    const run = hook(dir, input, extra);
    const verdict = verdictOf(run);
    assert.equal(verdict.permission, "deny", `${extra.join(" ")}: ${run.stdout}`);
    assert.match(verdict.message, /^hook-io: /u);
  }
  const badActor = runCli(["hook", "hermes", "--as", "nobody"], dir, input);
  assert.equal(verdictOf(badActor).permission, "deny");
});

test("unreadable, empty and malformed input blocks", () => {
  const dir = ready();
  for (const input of ["", "not json", "[]", '{"hook_event_name":"pre_tool_call"}']) {
    const verdict = verdictOf(hook(dir, input));
    assert.equal(verdict.permission, "deny", JSON.stringify(input));
  }
});

test("a throw inside the hook becomes the block directive at exit 2", () => {
  const dir = ready();
  let out = "";
  let err = "";
  const code = commandHook(
    ["hermes", "--as", "agent:hermes"],
    { out: (text) => (out += text), err: (text) => (err += text) },
    dir,
    () => {
      throw new Error("stdin went away");
    },
  );
  assert.equal(code, 2, err);
  assert.deepEqual(JSON.parse(out), {
    action: "block",
    message: "hook-io: the hook failed: stdin went away",
  });
});

test("a post event still never blocks, whatever happens in it", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "hermes", "--as", "agent:hermes", "--timeout", "soon"],
    dir,
    event(dir, { hook_event_name: "post_tool_call", tool_name: "terminal", tool_input: { command: "ls", workdir: dir } }),
  );
  // A misconfigured entry is a configuration error on either event; on the post
  // event it must not be answered with a verdict about a call that already ran
  // in a form Hermes would act on as a later block. The pre path is what
  // carries the directive; this pins that the post path is untouched by the
  // wrapper (exit 0 or the directive, never a bare non-zero with no stdout).
  assert.ok(run.code === 0 || (run.code === 2 && run.stdout.includes('"action":"block"')), `${String(run.code)} ${run.stdout}`);
});

/**
 * SIGTERM mid-wait. The wait is a synchronous poll (`Atomics.wait`), so a JS
 * signal handler cannot run until it ends: the hook keeps waiting and answers
 * when the wait runs out. Observed while writing this test, and the property
 * that matters for Hermes holds either way: the answer is the block directive
 * at exit 2, never an empty stdout. The handler's own directive
 * (`hook-interrupted`) covers a signal that lands while the event loop runs.
 */
test("SIGTERM mid-wait still ends in the block directive at exit 2", async () => {
  const dir = ready();
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "hook", "hermes", "--as", "agent:hermes", "--harness-cap", "300s", "--timeout", "3s", "--interval", "50ms"],
    { cwd: dir, env: { ...process.env, APPROVAL_HUMAN: "" } },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.stdin.end(
    event(dir, {
      tool_name: "terminal",
      tool_input: { command: "npm install left-pad", workdir: dir },
    }),
  );
  // Wait for the request to land, which is when the hook is sitting in its wait.
  const deadline = Date.now() + 30_000;
  while (!logRecords(dir).some((record) => record["event"] === "approval.requested")) {
    assert.ok(Date.now() < deadline, `the hook never requested: ${stderr}`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
  const exited = new Promise<number | null>((settle) => child.on("exit", (code) => settle(code)));
  child.kill("SIGTERM");
  const code = await exited;
  assert.equal(code, 2, stderr);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "message"]);
  assert.equal(parsed["action"], "block");
  assert.match(String(parsed["message"]), /^hook-(interrupted|timeout): /u);
});

test("a hook module that fails to load still blocks, from main itself", () => {
  const dir = ready();
  // A resolve hook that refuses `./hook.js`, standing in for a broken install.
  const hooks = join(scratch, "break-hook-hooks.mjs");
  writeFileSync(
    hooks,
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier === "./hook.js") throw new Error("simulated: hook.js failed to load");',
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const register = join(scratch, "break-hook-register.mjs");
  writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
    "utf8",
  );
  const run = runCli(
    ["hook", "hermes", "--as", "agent:hermes"],
    dir,
    event(dir, { tool_name: "terminal", tool_input: { command: "ls", workdir: dir } }),
    ["--import", pathToFileURL(register).href],
  );
  assert.equal(run.code, 2, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["action"], "block");
  assert.match(String(parsed["message"]), /hook-io: the hook could not run: .*simulated/u);

  // The same failure on another harness keeps its old shape: a thrown error,
  // which only Hermes reads as an allow.
  const other = runCli(
    ["hook", "claude-code"],
    dir,
    "{}",
    ["--import", pathToFileURL(register).href],
  );
  assert.notEqual(other.code, 0);
  assert.equal(other.stdout, "");
});

// ---------------------------------------------------------------------------
// A proposal is not the hook's to sweep or carry (APRV-445)
// ---------------------------------------------------------------------------

test("the hook's abandoned-question sweep takes back its own stale question and never a proposal", async () => {
  const dir = ready();
  // Under `approval serve` the hook and `propose` are ONE actor.
  const key = "intent.publish.inferred.index:sweep";
  const proposed = runCli(
    ["propose", "--class", "intent.publish.inferred.index", "--key", key, "--summary", "s",
      "--payload-json", '{"text":"hello"}', "--as", "agent:hermes", "--json"],
    dir,
  );
  assert.equal(proposed.code, 0, proposed.stderr);

  // A hook question that nobody answers, abandoned almost at once.
  const flags = ["--harness-cap", "300s", "--timeout", "1ms", "--retry-grace", "1ms"];
  const stale = hook(
    dir,
    event(dir, { tool_name: "terminal", tool_input: { command: "npm install left-pad", workdir: dir } }),
    flags,
  );
  assert.equal(verdictOf(stale).permission, "deny");
  await new Promise((settle) => setTimeout(settle, 20));

  // The next gated call sweeps.
  const next = hook(dir, event(dir, { tool_name: "delegate_task", tool_input: { goal: "g" } }), flags);
  assert.equal(verdictOf(next).permission, "allow", next.stderr);

  const withdrawn = logRecords(dir)
    .filter((record) => record["event"] === "approval.withdrawn")
    .map((record) => String(record["action_key"]));
  assert.equal(withdrawn.length, 1, `expected exactly the hook's own question withdrawn: ${withdrawn.join(", ")}`);
  assert.ok(withdrawn[0]?.startsWith("hook:") === true, withdrawn[0] ?? "");
  assert.equal(withdrawn.includes(key), false, "the sweep withdrew a proposal");
});

// ---------------------------------------------------------------------------
// B2 (APRV-445 refutation): writes to the Hermes home's secrets are organs
// ---------------------------------------------------------------------------

test("every write shape onto .hermes/.env, auth.json or config.yaml is policy.core; reads stay account.credential", () => {
  const dir = ready();
  const home = join(dir, ".hermes");
  mkdirSync(home, { recursive: true });
  const env = join(home, ".env");
  const writes: Array<[string, Record<string, unknown>]> = [
    ["write_file", { path: env, content: "HERMES_ACCEPT_HOOKS=0" }],
    ["patch", { path: env, old_string: "1", new_string: "0" }],
    ["write_file", { path: join(home, ".env.local"), content: "X=1" }],
    ["write_file", { path: join(home, "auth.json"), content: "{}" }],
    ["write_file", { path: join(home, "config.yaml"), content: "hooks: {}" }],
    ["terminal", { command: `echo X=1 > ${env}`, workdir: dir }],
    ["terminal", { command: `echo X=1 >> ${env}`, workdir: dir }],
    ["terminal", { command: `sed -i s/1/0/ ${env}`, workdir: dir }],
    ["terminal", { command: `echo X | tee -a ${env}`, workdir: dir }],
    // L10: relative writes from a `.hermes` workdir.
    ["terminal", { command: "echo X=1 >> .env", workdir: home }],
    ["terminal", { command: "sed -i s/a/b/ config.yaml", workdir: home }],
    ["terminal", { command: "cp /tmp/x .env", workdir: home }],
    ["terminal", { command: "echo {} > auth.json", workdir: home }],
  ];
  for (const [tool, input] of writes) {
    const verdict = verdictOf(hook(dir, event(dir, { tool_name: tool, tool_input: input })));
    assert.equal(verdict.permission, "deny", `${tool} ${JSON.stringify(input)}`);
    assert.ok(verdict.message.includes("policy.core"), `${tool} ${JSON.stringify(input)}: ${verdict.message}`);
  }
  // `cp` is direction-blind to the classifier (APRV-198): a copy naming the
  // credential file may be a copy OUT of it, so it takes the credential class,
  // which is human-only exactly as policy.core is. Either way it is refused.
  const copy = verdictOf(
    hook(dir, event(dir, { tool_name: "terminal", tool_input: { command: `cp /tmp/x ${env}`, workdir: dir } })),
  );
  assert.equal(copy.permission, "deny");
  assert.match(copy.message, /policy\.core|account\.credential/u);
  // L10, the scheduler's directory, relative.
  const cron = verdictOf(
    hook(dir, event(dir, { tool_name: "terminal", tool_input: { command: "echo x > scripts/job.sh", workdir: home } })),
  );
  assert.ok(cron.message.includes("cron.manage"), cron.message);

  const reads: Array<[string, Record<string, unknown>]> = [
    ["terminal", { command: `cat ${env}`, workdir: dir }],
    ["terminal", { command: "cat .env", workdir: home }],
    ["read_file", { path: env }],
    ["read_file", { path: join(home, "auth.json") }],
  ];
  for (const [tool, input] of reads) {
    const verdict = verdictOf(hook(dir, event(dir, { tool_name: tool, tool_input: input })));
    assert.equal(verdict.permission, "deny", `${tool} ${JSON.stringify(input)}`);
    assert.ok(verdict.message.includes("account.credential"), `${tool}: ${verdict.message}`);
    assert.equal(verdict.message.includes("policy.core"), false, `${tool}: a read is not an organ write`);
  }

  // Ordinary work in the home is still ordinary.
  const notes = verdictOf(
    hook(dir, event(dir, { tool_name: "terminal", tool_input: { command: "touch notes.txt", workdir: home } })),
  );
  assert.equal(notes.permission, "allow");
  assert.equal(protectedPathClass("/data/.hermes/.env", []), "policy.core");
  assert.equal(protectedPathClass("/data/.hermes/auth.json", []), "policy.core");
});
