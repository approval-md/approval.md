#!/usr/bin/env node
/**
 * `node hosted/tenant.mjs <tenant-dir>` — run one tenant's approval.md.
 *
 * A tenant is a directory: `APPROVAL.md` beside `.approval/`, whose log is an
 * ordinary file. This script starts the two processes that tenant needs (the
 * daemon and the Telegram listener), prefixes their output so one terminal can
 * hold both, and stops them together. It decides nothing, appends nothing, and
 * opens no port of its own.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = resolve(REPO, "cli.js");

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  process.stdout.write("usage: node hosted/tenant.mjs <tenant-dir>\n");
  process.exit(arg ? 0 : 2);
}

const dir = resolve(process.cwd(), arg);
const name = basename(dir);

if (!existsSync(resolve(dir, "APPROVAL.md"))) {
  process.stderr.write(
    `tenant: ${dir}/APPROVAL.md is missing.\n` +
      `  Open hosted/policy-builder/index.html, fill in the approver and the classes,\n` +
      `  then use its Download button and save APPROVAL.md into ${dir}.\n`,
  );
  process.exit(2);
}

if (!existsSync(resolve(dir, ".approval"))) {
  process.stdout.write(`[${name}] .approval/ missing, running approval init\n`);
  const init = spawnSync(process.execPath, [CLI, "init", "--dir", dir], {
    cwd: dir,
    stdio: "inherit",
  });
  if (init.status !== 0) process.exit(init.status ?? 1);
}

/** Prefix every line of a child's stream, holding partial lines until a newline. */
function pipe(stream, label, sink) {
  let tail = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const parts = (tail + chunk).split("\n");
    tail = parts.pop() ?? "";
    for (const line of parts) sink.write(`[${name}:${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (tail) sink.write(`[${name}:${label}] ${tail}\n`);
    tail = "";
  });
}

const children = new Map();
let stopping = false;

function start(label, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipe(child.stdout, label, process.stdout);
  pipe(child.stderr, label, process.stderr);
  children.set(label, child);
  child.on("exit", (code, signal) => {
    children.delete(label);
    if (stopping) return;
    process.stdout.write(`[${name}:${label}] exited (code ${code ?? signal})\n`);
    if (label === "telegram" && code !== 0) {
      // The listener reads the bot out of the environment by the NAMES the
      // policy gives; APPROVAL.md never carries the values (SPEC.md §5.1).
      process.stdout.write(
        `[${name}:telegram] no decisions can arrive until the bot is in this shell's environment:\n` +
          `[${name}:telegram]   export APPROVAL_TG_TOKEN=<bot token from @BotFather>\n` +
          `[${name}:telegram]   export APPROVAL_TG_CHAT=<numeric chat id>\n` +
          `[${name}:telegram] (or the names your policy's channels.telegram token_env / chat_id_env give).\n` +
          `[${name}:telegram] The daemon keeps running; restart this script once they are exported.\n`,
      );
    }
    if (children.size === 0) process.exit(code ?? 0);
  });
  return child;
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`[${name}] ${signal}, stopping\n`);
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(0);
  }, 3000).unref();
  const wait = setInterval(() => {
    if (children.size === 0) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 50);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

process.stdout.write(`[${name}] tenant ${dir}\n`);
// `--no-preflight` and `--no-build`: the preflight is for the daemon running in
// a git checkout of this repository, and a tenant directory is not one.
// `--no-draw` keeps this process off any port.
start("daemon", ["daemon", "run", "--dir", dir, "--no-preflight", "--no-build", "--no-draw"]);
start("telegram", ["channel", "telegram", "listen", "--dir", dir]);
