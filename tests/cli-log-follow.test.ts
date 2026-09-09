/** End-to-end JSON-lines contract for `approval log follow` (APRV-322). */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appendEvent, type EventInput, type EventRecord } from "../src/core/log.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "approval-cli-log-follow-"));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function fresh(): { cwd: string; logPath: string } {
  counter += 1;
  const cwd = join(scratch, `case-${String(counter)}`);
  return { cwd, logPath: join(cwd, ".approval", "log", "events.jsonl") };
}

function append(logPath: string, id: number): EventRecord {
  const input: EventInput = {
    ts: `2026-09-08T21:00:${String(id).padStart(2, "0")}Z`,
    event: "task.registered",
    actor: "agent:cli-listener-test",
    task: `task-${String(id)}`,
    channel: "cli",
    payload: { title: `Task ${String(id)}` },
  };
  const result = appendEvent(logPath, input);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("unreachable");
  return result.record;
}

function start(args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function startWithWriteStats(
  args: string[],
  cwd: string,
  statsPath: string,
): ChildProcessWithoutNullStreams {
  const shimPath = join(scratch, `stdout-stats-${String(counter)}.mjs`);
  writeFileSync(
    shimPath,
    `import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(pathToFileURL(CLI_ENTRY).href)};
const stdout = process.stdout;
const originalWrite = stdout.write.bind(stdout);
let peak = 0;
let writes = 0;
stdout.write = (...args) => {
  const accepted = originalWrite(...args);
  writes += 1;
  peak = Math.max(peak, stdout.writableLength);
  return accepted;
};
process.on("exit", () => {
  writeFileSync(${JSON.stringify(statsPath)}, JSON.stringify({
    peak,
    writes,
    highWaterMark: stdout.writableHighWaterMark,
  }));
});
process.exitCode = await main(process.argv.slice(2));
`,
    "utf8",
  );
  return spawn(process.execPath, [shimPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function nextLine(child: ChildProcessWithoutNullStreams, timeoutMs = 4_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for a JSON line"));
    }, timeoutMs);
    const data = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      const line = buffered.slice(0, newline);
      cleanup();
      resolve(line);
    };
    const exited = (code: number | null): void => {
      cleanup();
      reject(new Error(`listener exited ${String(code)} before writing a line`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", data);
      child.off("exit", exited);
    };
    child.stdout.on("data", data);
    child.once("exit", exited);
  });
}

function exitOf(child: ChildProcessWithoutNullStreams, timeoutMs = 4_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for listener exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal === null ? -1 : 128));
    });
  });
}

async function waitUntilReadable(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.stdout.readableLength > 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child.stdout, "readable"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("listener stdout never became readable")), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("CLI replays exclusively, follows a real append, and SIGTERM exits zero", async () => {
  const world = fresh();
  const first = append(world.logPath, 1);
  append(world.logPath, 2);
  const child = start(
    ["log", "follow", "--from", "1", "--cursor-hash", first.hash, "--json"],
    world.cwd,
  );
  assert.equal((JSON.parse(await nextLine(child)) as EventRecord).seq, 2);
  const waiting = nextLine(child);
  append(world.logPath, 3);
  assert.equal((JSON.parse(await waiting) as EventRecord).seq, 3);
  child.kill("SIGTERM");
  assert.equal(await exitOf(child), 0);
});

test("CLI preserves usage, cursor-integrity, and torn-tail exit classes", () => {
  const world = fresh();
  const first = append(world.logPath, 1);
  const noJson = spawnSync(process.execPath, [CLI_ENTRY, "log", "follow"], {
    cwd: world.cwd,
    encoding: "utf8",
    timeout: 4_000,
  });
  assert.equal(noJson.status, 2);

  const wrongCursor = spawnSync(
    process.execPath,
    [CLI_ENTRY, "log", "follow", "--from", "1", "--cursor-hash", "0".repeat(64), "--json"],
    { cwd: world.cwd, encoding: "utf8", timeout: 4_000 },
  );
  assert.equal(wrongCursor.status, 1);
  assert.equal((JSON.parse(wrongCursor.stderr) as { error: { code: string } }).error.code, "integrity");

  const tornPath = `${world.logPath}.torn`;
  copyFileSync(world.logPath, tornPath);
  writeFileSync(tornPath, `${readFileSync(tornPath, "utf8")}{"seq":2`, "utf8");
  const torn = spawnSync(
    process.execPath,
    [
      CLI_ENTRY,
      "log",
      "follow",
      "--log",
      tornPath,
      "--from",
      "1",
      "--cursor-hash",
      first.hash,
      "--json",
    ],
    { cwd: world.cwd, encoding: "utf8", timeout: 4_000 },
  );
  assert.equal(torn.status, 3);
  assert.equal((JSON.parse(torn.stderr) as { error: { code: string } }).error.code, "torn-tail");
});

test("a closed downstream pipe cancels the foreground listener cleanly", async () => {
  const world = fresh();
  append(world.logPath, 1);
  append(world.logPath, 2);
  const child = start(["log", "follow", "--json"], world.cwd);
  await nextLine(child);
  child.stdout.destroy();
  // The second replay line, or this append if both replay writes fit before the
  // close, exercises the actual process stdout EPIPE listener.
  append(world.logPath, 3);
  assert.equal(await exitOf(child), 0);
});

test("a slow native pipe bounds producer output and resumes after an incomplete final fragment", async () => {
  const world = fresh();
  const total = 8;
  let largestLineBytes = 0;
  for (let id = 1; id <= total; id += 1) {
    const result = appendEvent(world.logPath, {
      ts: "2026-09-08T21:30:00Z",
      event: "task.registered",
      actor: "agent:slow-pipe-test",
      task: `large-${String(id)}`,
      channel: "cli",
      payload: { title: `${String(id)}:${"x".repeat(524_288)}` },
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) throw new Error("unreachable");
    largestLineBytes = Math.max(
      largestLineBytes,
      Buffer.byteLength(`${JSON.stringify(result.record)}\n`, "utf8"),
    );
  }

  const statsPath = join(scratch, `stdout-stats-${String(counter)}.json`);
  const child = startWithWriteStats(["log", "follow", "--json"], world.cwd, statsPath);
  child.stdout.pause();
  await waitUntilReadable(child);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  const outputEnded = new Promise<void>((resolve) => child.stdout.once("end", resolve));
  const exited = exitOf(child, 5_000);
  child.kill("SIGTERM");
  assert.equal(await exited, 0);

  const stats = JSON.parse(readFileSync(statsPath, "utf8")) as {
    peak: number;
    writes: number;
    highWaterMark: number;
  };
  assert.equal(stats.writes, 1, "the iterator advanced while the first record was backpressured");
  assert.ok(
    stats.peak <= largestLineBytes + stats.highWaterMark,
    `producer queued ${String(stats.peak)} bytes, beyond one record plus native buffering`,
  );

  child.stdout.resume();
  await outputEnded;

  const fragments = Buffer.concat(output).toString("utf8").split("\n");
  const incomplete = fragments.pop() ?? "";
  assert.ok(incomplete.length > 0, "signal cancellation did not exercise a partial final record");
  assert.throws(() => JSON.parse(incomplete), SyntaxError);
  const complete = fragments
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
  const cursor = complete.at(-1);

  // A consumer discards the unterminated fragment and reconnects from the last
  // complete record it processed (or zero when cancellation split record one).
  const resumeArgs =
    cursor === undefined
      ? ["log", "follow", "--from", "0", "--json"]
      : [
          "log",
          "follow",
          "--from",
          String(cursor.seq),
          "--cursor-hash",
          cursor.hash,
          "--json",
        ];
  const resumed = start(resumeArgs, world.cwd);
  const replayed = JSON.parse(await nextLine(resumed)) as EventRecord;
  assert.equal(replayed.seq, (cursor?.seq ?? 0) + 1);
  resumed.kill("SIGTERM");
  assert.equal(await exitOf(resumed), 0);
});
