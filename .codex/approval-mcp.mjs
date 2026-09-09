#!/usr/bin/env node

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

function refusal(message) {
  return new Error(`approval Codex MCP launcher: ${message}`);
}

function realDirectory(path, label) {
  let real;
  try {
    real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw refusal(`${label} is not a directory: ${real}`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("approval Codex MCP launcher:")) {
      throw cause;
    }
    throw refusal(`${label} is unavailable: ${path}`);
  }
  return real;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw refusal(`git ${args.join(" ")} failed in ${cwd}`);
  }
  const output = result.stdout.trim();
  if (output.length === 0 || output.includes("\n") || output.includes("\0")) {
    throw refusal(`git ${args.join(" ")} returned an unusable path`);
  }
  return output;
}

export function resolveCodexMcpPaths(invocationCwd = process.cwd()) {
  const invocation = realDirectory(invocationCwd, "invocation directory");
  const worktreeRoot = realDirectory(git(invocation, ["rev-parse", "--show-toplevel"]), "worktree root");

  // A relative --git-common-dir is relative to the invocation directory, not
  // necessarily to the worktree root. Resolve it before deriving the primary.
  const commonRaw = git(invocation, ["rev-parse", "--git-common-dir"]);
  const commonGitDir = realDirectory(resolve(invocation, commonRaw), "common Git directory");
  if (basename(commonGitDir) !== ".git") {
    throw refusal(`cannot prove a primary checkout from common Git directory ${commonGitDir}`);
  }

  const primaryRoot = realDirectory(dirname(commonGitDir), "primary checkout");
  const primaryTop = realDirectory(
    git(primaryRoot, ["rev-parse", "--show-toplevel"]),
    "primary checkout root",
  );
  const primaryCommonRaw = git(primaryRoot, ["rev-parse", "--git-common-dir"]);
  const primaryCommon = realDirectory(
    resolve(primaryRoot, primaryCommonRaw),
    "primary common Git directory",
  );
  if (primaryTop !== primaryRoot || primaryCommon !== commonGitDir) {
    throw refusal("the derived primary checkout does not own this worktree's common Git directory");
  }

  const cli = join(worktreeRoot, "cli.js");
  const policy = join(primaryRoot, "APPROVAL.md");
  const log = join(primaryRoot, ".approval", "log", "events.jsonl");
  for (const [label, path] of [["CLI", cli], ["policy", policy], ["event log", log]]) {
    try {
      if (!statSync(path).isFile()) throw refusal(`${label} is not a file: ${path}`);
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("approval Codex MCP launcher:")) {
        throw cause;
      }
      throw refusal(`${label} is unavailable: ${path}`);
    }
  }

  return { worktreeRoot, commonGitDir, primaryRoot, cli, policy, log };
}

export function approvalMcpArgv(paths) {
  return [
    paths.cli,
    "mcp",
    "serve",
    "--as",
    "agent:codex-mcp",
    "--dir",
    paths.primaryRoot,
    "--log",
    paths.log,
    "--policy",
    paths.policy,
  ];
}

export function superviseChild(child, host = process) {
  let settled = false;
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTerminate = () => child.kill("SIGTERM");
  const cleanup = () => {
    host.off("SIGINT", forwardInterrupt);
    host.off("SIGTERM", forwardTerminate);
  };

  host.on("SIGINT", forwardInterrupt);
  host.on("SIGTERM", forwardTerminate);
  child.once("error", (cause) => {
    if (settled) return;
    settled = true;
    cleanup();
    host.stderr.write(`approval Codex MCP launcher: could not start approval: ${cause.message}\n`);
    host.exitCode = 2;
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (signal !== null) {
      // The forwarding handlers are gone before re-raising the child's signal,
      // so this cannot loop back into child.kill().
      host.kill(host.pid, signal);
    } else {
      host.exitCode = code ?? 2;
    }
  });
}

export function launchApprovalMcp(paths, spawnProcess = spawn, host = process) {
  const child = spawnProcess(process.execPath, approvalMcpArgv(paths), {
    cwd: paths.primaryRoot,
    stdio: "inherit",
  });
  superviseChild(child, host);
  return 0;
}

export function main() {
  let paths;
  try {
    paths = resolveCodexMcpPaths();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }

  return launchApprovalMcp(paths);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
