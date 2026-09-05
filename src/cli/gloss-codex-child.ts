/**
 * Process-group supervisor for the synchronous Codex gloss runner (APRV-254).
 *
 * The public runner waits synchronously because GlossRunner is synchronous.
 * This small child can still supervise Codex asynchronously, which lets it
 * terminate the complete detached process group when the CLI times out or
 * exceeds its output allowance. It never prints stderr or process errors.
 */

import { spawn, type ChildProcess } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const EXIT_TIMEOUT = 124;
const EXIT_OUTPUT_LIMIT = 125;
const EXIT_SPAWN = 126;

function positiveInteger(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const executable = process.argv[2];
const timeoutMs = positiveInteger(process.argv[3]);
const cwd = process.argv[4];
const instruction = process.argv[5];
const argsJson = process.argv[6];

if (
  executable === undefined ||
  timeoutMs === null ||
  cwd === undefined ||
  instruction === undefined ||
  argsJson === undefined
) {
  process.exit(EXIT_SPAWN);
}

let prefixArgs: string[];
try {
  const parsed: unknown = JSON.parse(argsJson);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    process.exit(EXIT_SPAWN);
  }
  prefixArgs = parsed as string[];
} catch {
  process.exit(EXIT_SPAWN);
}

let child: ChildProcess | null = null;
let terminal = false;

function killTree(): void {
  const pid = child?.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      child?.kill("SIGKILL");
    } catch {
      // The process has already exited.
    }
  }
}

function finish(code: number): void {
  if (terminal) return;
  terminal = true;
  clearTimeout(timer);
  if (code !== 0) killTree();
  process.exitCode = code;
}

process.on("SIGTERM", () => {
  killTree();
  process.exit(EXIT_TIMEOUT);
});
process.on("SIGINT", () => {
  killTree();
  process.exit(EXIT_TIMEOUT);
});

const chunks: Buffer[] = [];
let outputBytes = 0;
let overflow = false;

try {
  child = spawn(executable, [...prefixArgs, instruction], {
    cwd,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
} catch {
  process.exit(EXIT_SPAWN);
}

const timer = setTimeout(() => {
  killTree();
  finish(EXIT_TIMEOUT);
}, timeoutMs);
timer.unref();

child.on("error", () => finish(EXIT_SPAWN));
child.stdin?.on("error", () => finish(EXIT_SPAWN));
child.stdout?.on("data", (chunk: Buffer | string) => {
  if (overflow) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  outputBytes += bytes.byteLength;
  if (outputBytes > OUTPUT_LIMIT_BYTES) {
    overflow = true;
    killTree();
    return;
  }
  chunks.push(bytes);
});
child.on("close", (code, signal) => {
  if (terminal) return;
  if (overflow) {
    finish(EXIT_OUTPUT_LIMIT);
    return;
  }
  if (signal !== null || code === null) {
    finish(EXIT_SPAWN);
    return;
  }
  if (code !== 0) {
    finish(code > 0 && code < 124 ? code : 123);
    return;
  }
  // A launcher may exit successfully while leaving native descendants alive.
  // The detached group belongs solely to this one-shot invocation.
  killTree();
  const output = Buffer.concat(chunks);
  process.stdout.write(output, (error) => finish(error == null ? 0 : EXIT_SPAWN));
});

let input = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer | string) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  input = Buffer.concat([input, bytes]);
});
process.stdin.on("end", () => child?.stdin?.end(input));
process.stdin.resume();
