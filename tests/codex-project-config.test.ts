import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
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

/** dist/tests/codex-project-config.test.js -> repository root. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LAUNCHER_PATH = join(REPO_ROOT, ".codex", "approval-mcp.mjs");

interface ResolvedPaths {
  worktreeRoot: string;
  commonGitDir: string;
  primaryRoot: string;
  cli: string;
  policy: string;
  log: string;
}

interface LauncherModule {
  resolveCodexMcpPaths(cwd: string): ResolvedPaths;
  approvalMcpArgv(paths: ResolvedPaths): string[];
  superviseChild(child: EventEmitter & { kill(signal: NodeJS.Signals): void }, host: FakeHost): void;
}

class FakeHost extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | undefined;
  readonly stderrText: string[] = [];
  readonly kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  readonly stderr = {
    write: (text: string) => {
      this.stderrText.push(text);
      return true;
    },
  };

  kill(pid: number, signal: NodeJS.Signals): true {
    this.kills.push({ pid, signal });
    return true;
  }
}

class FakeChild extends EventEmitter {
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): true {
    this.kills.push(signal);
    return true;
  }
}

const launcher = (await import(pathToFileURL(LAUNCHER_PATH).href)) as LauncherModule;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-codex-config-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `git spawn failed: ${String(result.error)}`);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("project config exposes only an optional MCP server", () => {
  const config = readFileSync(join(REPO_ROOT, ".codex", "config.toml"), "utf8");
  assert.match(config, /\[mcp_servers\.approval\]/u);
  assert.match(config, /^command = "npm"$/mu);
  assert.match(config, /^args = \["run", "--silent", "codex:mcp"\]$/mu);
  assert.match(config, /^required = false$/mu);
  const activeConfig = config
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    activeConfig,
    /hooks|approval_policy|sandbox_mode|writable_roots|network_access|trust_level|default_tools_approval_mode|allow_remote_control|features\.(?:apps|plugins)/iu,
  );
});

test("package script reaches the checked-in launcher", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.["codex:mcp"], "node .codex/approval-mcp.mjs");
});

test("launcher refuses a non-repository cwd with process exit 2", () => {
  const outside = realpathSync(mkdtempSync(join(scratch, "outside-")));
  const result = spawnSync(process.execPath, [LAUNCHER_PATH], { cwd: outside, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /approval Codex MCP launcher:/u);
});

test("launcher resolves nested primary and linked worktree paths while pinning gate state", () => {
  const primary = join(scratch, "primary");
  const linked = join(scratch, "linked");
  mkdirSync(join(primary, ".approval", "log"), { recursive: true });
  writeFileSync(join(primary, "cli.js"), "// fixture\n", "utf8");
  writeFileSync(join(primary, "APPROVAL.md"), "# fixture\n", "utf8");
  writeFileSync(join(primary, ".approval", "log", "events.jsonl"), "", "utf8");
  git(primary, ["init"]);
  git(primary, ["config", "user.name", "Codex test"]);
  git(primary, ["config", "user.email", "codex-test@example.invalid"]);
  git(primary, ["add", "cli.js", "APPROVAL.md"]);
  git(primary, ["commit", "-m", "fixture"]);
  git(primary, ["worktree", "add", "-b", "linked", linked]);
  mkdirSync(join(primary, "nested", "deeper"), { recursive: true });
  mkdirSync(join(linked, "nested", "deeper"), { recursive: true });

  const primaryPaths = launcher.resolveCodexMcpPaths(join(primary, "nested", "deeper"));
  assert.equal(primaryPaths.worktreeRoot, realpathSync(primary));
  assert.equal(primaryPaths.primaryRoot, realpathSync(primary));

  const linkedPaths = launcher.resolveCodexMcpPaths(join(linked, "nested", "deeper"));
  assert.equal(linkedPaths.worktreeRoot, realpathSync(linked));
  assert.equal(linkedPaths.cli, join(realpathSync(linked), "cli.js"));
  assert.equal(linkedPaths.primaryRoot, realpathSync(primary));
  assert.equal(linkedPaths.policy, join(realpathSync(primary), "APPROVAL.md"));
  assert.equal(linkedPaths.log, join(realpathSync(primary), ".approval", "log", "events.jsonl"));
  assert.deepEqual(launcher.approvalMcpArgv(linkedPaths), [
    join(realpathSync(linked), "cli.js"),
    "mcp",
    "serve",
    "--as",
    "agent:codex-mcp",
    "--dir",
    realpathSync(primary),
    "--log",
    join(realpathSync(primary), ".approval", "log", "events.jsonl"),
    "--policy",
    join(realpathSync(primary), "APPROVAL.md"),
  ]);
});

test("spawn errors fail closed and remove host signal handlers", () => {
  const host = new FakeHost();
  const child = new FakeChild();
  launcher.superviseChild(child, host);
  child.emit("error", new Error("ENOENT"));
  assert.equal(host.exitCode, 2);
  assert.match(host.stderrText.join(""), /could not start approval: ENOENT/u);
  assert.equal(host.listenerCount("SIGINT"), 0);
  assert.equal(host.listenerCount("SIGTERM"), 0);
});

test("parent termination is forwarded and a child signal is re-raised after cleanup", () => {
  const host = new FakeHost();
  const child = new FakeChild();
  launcher.superviseChild(child, host);
  host.emit("SIGTERM");
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("exit", null, "SIGTERM");
  assert.deepEqual(host.kills, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(host.listenerCount("SIGINT"), 0);
  assert.equal(host.listenerCount("SIGTERM"), 0);
});

test("normal child exit is preserved and signal handlers are removed", () => {
  const host = new FakeHost();
  const child = new FakeChild();
  launcher.superviseChild(child, host);
  child.emit("exit", 7, null);
  assert.equal(host.exitCode, 7);
  assert.equal(host.listenerCount("SIGINT"), 0);
  assert.equal(host.listenerCount("SIGTERM"), 0);
});
