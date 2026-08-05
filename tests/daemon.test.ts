/**
 * `approval daemon run` — the daemon loop, driven as a real process (APRV-39).
 *
 * Every case here spawns the built CLI in a temp directory and asserts against
 * the files it left behind. Nothing calls `Daemon` in process, deliberately: the
 * thing under test is a long-lived process with watchers, timers, and signal
 * handlers, and an in-process harness would prove that a class works while
 * leaving open the two questions an operator actually has — does it stop when I
 * press Ctrl-C, and does it leave my log clean.
 *
 * Every log is built through the real append path (the CLI's own verbs and the
 * daemon's own appends); the one exception is the tamper case, where a junk line
 * is appended on purpose to prove the daemon refuses to keep running on a chain
 * that does not verify. `approval log verify` runs at the end of every scenario.
 *
 * Timing: the TTL cases use a short but real TTL and poll until the condition
 * holds, with a generous ceiling. No test sleeps a fixed amount and hopes.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-daemon-")));
let counter = 0;

/**
 * Every live daemon this file starts, so a failed assertion cannot leave one
 * running: an orphaned child keeps the test process alive, and a suite that
 * hangs reports nothing at all rather than reporting the failure.
 */
const live = new Set<LiveDaemon>();

after(() => {
  for (const daemon of live) daemon.child.kill("SIGKILL");
  live.clear();
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYLOAD_HASH = "3".repeat(64);

function policy(ttl: string): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    `  approval_ttl: "${ttl}"`,
    "  on_expiry: reject",
    "classes:",
    "  files.write.*:",
    "    autonomy: supervised",
    "  communicate.email.external:",
    "    autonomy: manual",
    "budgets:",
    "  global:",
    "    daily_usd: 10",
    "    daily_actions: 50",
    "```",
    "",
  ].join("\n");
}

const POLICY = policy("1h");

/** Short enough to lapse inside a test, long enough not to race the setup. */
const POLICY_SHORT_TTL = policy("2s");

function taskFile(state: string): string {
  return [
    "---",
    "id: task-042",
    "title: Chase deposit refund",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: example-capture",
    '    created_by: "human:carter"',
    `  state: ${state}`,
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser"',
    "      reversible: false",
    "      est_cost_usd: 0.02",
    '      idempotency_key: "task-042:chaser"',
    `      payload_hash: "${PAYLOAD_HASH}"`,
    "    - class: communicate.email.external",
    '      summary: "Send the follow-up"',
    "      reversible: false",
    "      est_cost_usd: 0.02",
    '      idempotency_key: "task-042:followup"',
    `      payload_hash: "${PAYLOAD_HASH}"`,
    "    - class: files.write.local",
    '      summary: "Write the draft"',
    "      reversible: true",
    "      est_cost_usd: 0.01",
    '      idempotency_key: "task-042:draft"',
    "    - class: files.write.local",
    '      summary: "Write the second draft"',
    "      reversible: true",
    "      est_cost_usd: 0.01",
    '      idempotency_key: "task-042:draft2"',
    "    - class: files.write.local",
    '      summary: "Write the third draft"',
    "      reversible: true",
    "      est_cost_usd: 0.01",
    '      idempotency_key: "task-042:draft3"',
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(policyText: string = POLICY, state = "proposed"): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "backlog", "tasks", "task-042.md"), taskFile(state), "utf8");
  return dir;
}

function taskPath(dir: string): string {
  return join(dir, "backlog", "tasks", "task-042.md");
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function queuePath(dir: string): string {
  return join(dir, ".approval", "QUEUE.md");
}

function records(dir: string): Record<string, unknown>[] {
  if (!existsSync(logPath(dir))) return [];
  return readFileSync(logPath(dir), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOf(dir: string, event: string): Record<string, unknown>[] {
  return records(dir).filter((record) => record["event"] === event);
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

/** Attest the policy and register the task: the state every case starts from. */
function ready(policyText: string = POLICY, state = "proposed"): string {
  const dir = caseDir(policyText, state);
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(
    runCli(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir).code,
    0,
  );
  return dir;
}

function request(dir: string, actionKey: string): void {
  const run = runCli(["request", "task-042", "--action", actionKey, "--as", "agent:claude"], dir);
  assert.equal(run.code, 0, run.stderr);
}

/** One `--once` daemon pass, as JSON lines. */
function daemonOnce(dir: string, extra: string[] = []): { run: Run; lines: Record<string, unknown>[] } {
  const run = runCli(["daemon", "run", "--once", "--json", ...extra], dir);
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { run, lines };
}

async function until(predicate: () => boolean, label: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A live daemon process, with its output collected as it arrives. */
class LiveDaemon {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  private readonly exited: Promise<number>;

  constructor(dir: string, args: string[]) {
    this.child = spawn(process.execPath, [CLI_ENTRY, "daemon", "run", "--json", ...args], {
      cwd: dir,
      env: { ...process.env },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout += chunk;
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise<number>((resolve) => {
      this.child.on("exit", (code) => {
        live.delete(this);
        resolve(code ?? -1);
      });
    });
    live.add(this);
  }

  lines(): Record<string, unknown>[] {
    return this.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async stopWith(signal: NodeJS.Signals): Promise<number> {
    this.child.kill(signal);
    return this.exited;
  }

  async wait(): Promise<number> {
    return this.exited;
  }
}

// ===========================================================================
// Envelope drift (SPEC.md §6.3)
// ===========================================================================

test("drift: a file whose state contradicts the log appends envelope.drift", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");

  // The log now says `awaiting`. The file still claims `proposed`, and an
  // ordinary editor save is what the daemon is watching for.
  const { run, lines } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);

  const drift = lines.find((line) => line["event"] === "drift");
  assert.ok(drift !== undefined, `no drift line: ${run.stdout}`);
  assert.equal(drift["task"], "task-042");
  assert.equal(drift["declared_state"], "proposed");
  assert.equal(drift["derived_state"], "awaiting");

  const appended = eventsOf(dir, "envelope.drift");
  assert.equal(appended.length, 1);
  const record = appended[0] as Record<string, unknown>;
  assert.equal(record["actor"], "system:daemon");
  assert.equal(record["task"], "task-042");
  const payload = record["payload"] as Record<string, unknown>;
  assert.equal(payload["declared_state"], "proposed");
  assert.equal(payload["derived_state"], "awaiting");
  assert.equal(payload["reason"], "state-mismatch");
  assert.equal(typeof payload["envelope_sha256"], "string");

  // The file is never rewritten: the log is the truth and the daemon records
  // the disagreement rather than resolving it.
  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("proposed"));
  assertClean(dir);
});

test("drift: an unregistered task claiming `approved` contradicts the log", () => {
  const dir = caseDir(POLICY, "approved");
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  const appended = eventsOf(dir, "envelope.drift");
  assert.equal(appended.length, 1);
  const payload = (appended[0] as Record<string, unknown>)["payload"] as Record<string, unknown>;
  assert.equal(payload["declared_state"], "approved");
  assert.equal(payload["derived_state"], "proposed");
  assert.equal(payload["registered"], false);
  assertClean(dir);
});

test("drift: the same claim against the same log is recorded once, a new claim again", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");

  daemonOnce(dir);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);

  // Two more passes over an unchanged world append nothing.
  daemonOnce(dir);
  daemonOnce(dir);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);

  // A different wrong claim is a different fact and is recorded.
  writeFileSync(taskPath(dir), taskFile("executed"), "utf8");
  daemonOnce(dir);
  const drifts = eventsOf(dir, "envelope.drift");
  assert.equal(drifts.length, 2);
  const payload = (drifts[1] as Record<string, unknown>)["payload"] as Record<string, unknown>;
  assert.equal(payload["declared_state"], "executed");
  assert.equal(payload["derived_state"], "awaiting");
  assertClean(dir);
});

test("drift: a file that agrees with the log appends nothing", () => {
  const dir = ready(POLICY, "proposed");
  const before = records(dir).length;
  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(eventsOf(dir, "envelope.drift").length, 0);
  assert.equal(records(dir).length, before);
  assertClean(dir);
});

test("drift: a schema-invalid envelope warns and appends nothing", () => {
  const dir = ready(POLICY, "proposed");
  writeFileSync(
    taskPath(dir),
    ["---", "id: task-042", "approval:", "  state: nonsense", "---", "", "Body.", ""].join("\n"),
    "utf8",
  );
  const before = records(dir).length;

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0);
  assert.match(run.stderr, /envelope-invalid/u);
  assert.equal(records(dir).length, before, "a malformed file made the daemon append something");
  assertClean(dir);
});

test("drift: a task file with no envelope is silently tolerated (SPEC.md §6)", () => {
  const dir = ready(POLICY, "proposed");
  writeFileSync(
    join(dir, "backlog", "tasks", "task-099.md"),
    ["---", "id: task-099", "title: No envelope", "---", "", "Body.", ""].join("\n"),
    "utf8",
  );
  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.equal(eventsOf(dir, "envelope.drift").length, 0);
  assertClean(dir);
});

// ===========================================================================
// The TTL sweep (SPEC.md §6.3, §10.2)
// ===========================================================================

test("sweep: a live daemon expires a lapsed request exactly once and leaves a decided one alone", async () => {
  const dir = ready(POLICY_SHORT_TTL, "proposed");
  request(dir, "task-042:chaser");
  request(dir, "task-042:followup");

  // The follow-up is decided before it can lapse; the chaser is left to lapse.
  const granted = runCli(
    ["grant", "task-042:followup", "--as", "human:carter", "--json"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);

  const daemon = new LiveDaemon(dir, ["--interval", "200ms"]);
  await until(
    () => eventsOf(dir, "approval.expired").length === 1,
    "the sweep to expire the lapsed request",
  );
  // Several more ticks pass; the sweep must not expire it again.
  await until(
    () => daemon.lines().filter((line) => line["event"] === "tick").length >= 4,
    "four ticks",
  );
  const code = await daemon.stopWith("SIGINT");
  assert.equal(code, 0, `daemon exited ${code}: ${daemon.stderr}`);

  const expired = eventsOf(dir, "approval.expired");
  assert.equal(expired.length, 1, "the sweep is not idempotent with itself");
  const record = expired[0] as Record<string, unknown>;
  assert.equal(record["action_key"], "task-042:chaser");
  assert.equal(record["actor"], "system:gate");
  assert.equal(record["task"], "task-042");

  const emitted = daemon.lines().filter((line) => line["event"] === "expired");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.["action_key"], "task-042:chaser");

  assertClean(dir);
});

test("sweep: a request the gate already expired lazily is not expired a second time", async () => {
  const dir = ready(POLICY_SHORT_TTL, "proposed");
  request(dir, "task-042:chaser");

  // Wait out the 2s TTL — polled, never a fixed sleep — and only then attempt
  // the grant, so the refusal under test is the lapse and not a race with it.
  const requestedAt = Date.now();
  await until(() => Date.now() - requestedAt > 3_000, "the 2s TTL to lapse");

  const late = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(late.code, 1, `a late grant was accepted: ${late.stdout}`);
  assert.match(late.stdout + late.stderr, /expired/u);
  assert.equal(eventsOf(dir, "approval.expired").length, 1, "the gate recorded no lazy expiry");

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(eventsOf(dir, "approval.expired").length, 1);
  assertClean(dir);
});

test("sweep: nothing expires when the policy declares no TTL", () => {
  const noTtl = POLICY.split("\n")
    .filter((line) => !line.includes("approval_ttl"))
    .join("\n");
  const dir = ready(noTtl, "proposed");
  request(dir, "task-042:chaser");
  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(eventsOf(dir, "approval.expired").length, 0);
  assertClean(dir);
});

// ===========================================================================
// The queue projection (SPEC.md §9.1)
// ===========================================================================

test("queue: QUEUE.md is regenerated, whole, and leaves no temp file behind", async () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");

  const daemon = new LiveDaemon(dir, ["--interval", "60ms"]);
  await until(() => existsSync(queuePath(dir)), "QUEUE.md to appear");

  // Read the file repeatedly while the daemon rewrites it: temp-then-rename
  // means a reader sees a complete document every time, never a partial one.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = readFileSync(queuePath(dir), "utf8");
    assert.ok(text.startsWith("<!--"), "QUEUE.md did not start with its generated-file banner");
    assert.ok(text.endsWith("\n"), "QUEUE.md was read mid-write");
    assert.match(text, /never the truth/u);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const code = await daemon.stopWith("SIGTERM");
  assert.equal(code, 0, daemon.stderr);

  const leftovers = readdirSync(join(dir, ".approval")).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "a temp queue file survived");
  assertClean(dir);
});

test("queue: the daemon regenerates the queue after an append it did not make", async () => {
  const dir = ready(POLICY, "proposed");
  const daemon = new LiveDaemon(dir, ["--interval", "100ms"]);
  await until(() => existsSync(queuePath(dir)), "the first render");

  // An external CLI append — exactly the case the single-writer stance tolerates.
  request(dir, "task-042:chaser");
  await until(
    () => readFileSync(queuePath(dir), "utf8").includes("task-042:chaser"),
    "the queue to pick up an external append",
  );

  const code = await daemon.stopWith("SIGINT");
  assert.equal(code, 0, daemon.stderr);
  assertClean(dir);
});

// ===========================================================================
// Loop escalation (SPEC.md §10.2)
// ===========================================================================

test("escalation: three consecutive failures are surfaced by the daemon and by status", () => {
  const dir = ready(POLICY, "proposed");
  for (const key of ["task-042:draft", "task-042:draft2", "task-042:draft3"]) {
    const run = runCli(
      ["run", key, "--as", "agent:claude", "--", process.execPath, "-e", "process.exit(1)"],
      dir,
    );
    assert.equal(run.code, 1, run.stderr);
  }

  const { run, lines } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  const escalated = lines.find((line) => line["event"] === "escalated");
  assert.ok(escalated !== undefined, `no escalation line: ${run.stdout}`);
  assert.equal(escalated["task"], "task-042");
  assert.equal(escalated["consecutive_failures"], 3);

  // The daemon surfaces the projection; it does not own it. `status` agrees.
  const status = runCli(["status", "--json"], dir);
  assert.equal(status.code, 1);
  assert.deepEqual((JSON.parse(status.stdout) as Record<string, unknown>)["loop_escalations"], [
    { task: "task-042", consecutive_failures: 3, escalated: true },
  ]);
  assertClean(dir);
});

// ===========================================================================
// Shutdown
// ===========================================================================

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`shutdown: ${signal} exits 0 and leaves no lockfile and no torn queue`, async () => {
    const dir = ready(POLICY, "proposed");
    request(dir, "task-042:chaser");

    const daemon = new LiveDaemon(dir, ["--interval", "100ms"]);
    await until(
      () => daemon.lines().some((line) => line["event"] === "tick"),
      "the first tick",
    );

    const code = await daemon.stopWith(signal);
    assert.equal(code, 0, `daemon exited ${code}: ${daemon.stderr}`);

    const stopped = daemon.lines().find((line) => line["event"] === "stopped");
    assert.ok(stopped !== undefined, `no stopped line: ${daemon.stdout}`);
    assert.equal(stopped["reason"], signal);
    assert.equal(typeof stopped["ticks"], "number");

    assert.equal(existsSync(`${logPath(dir)}.lock`), false, "a lockfile survived the shutdown");
    const queue = readFileSync(queuePath(dir), "utf8");
    assert.ok(queue.endsWith("\n"), "the queue was left torn");
    assertClean(dir);
  });
}

// ===========================================================================
// Fail closed
// ===========================================================================

test("a log that does not verify stops the daemon at exit 1 and it appends nothing", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");
  // Tampering on purpose: the point of the case is that the daemon refuses to
  // build anything on a chain that does not verify.
  appendFileSync(logPath(dir), `${JSON.stringify({ seq: 99, hash: "0".repeat(64) })}\n`, "utf8");
  const before = readFileSync(logPath(dir), "utf8");

  const run = runCli(["daemon", "run", "--once", "--json"], dir);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /log-corrupt/u);
  assert.equal(readFileSync(logPath(dir), "utf8"), before, "the daemon wrote to a corrupt log");
});

test("a torn tail stops the daemon at exit 3", () => {
  const dir = ready(POLICY, "proposed");
  appendFileSync(logPath(dir), "{\"seq\":99", "utf8");
  const run = runCli(["daemon", "run", "--once", "--json"], dir);
  assert.equal(run.code, 3);
  assert.match(run.stderr, /log-torn-tail/u);
});

// ===========================================================================
// Usage
// ===========================================================================

test("usage: daemon --help documents the exit codes, the JSON shape and the foreground stance", () => {
  const dir = caseDir();
  for (const args of [["daemon", "--help"], ["daemon", "run", "--help"]]) {
    const run = runCli(args, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Exit codes \(frozen public API\)/u);
    assert.match(run.stdout, /Usage:/u);
    assert.match(run.stdout, /--json/u);
  }
  const help = runCli(["daemon", "run", "-h"], dir);
  assert.match(help.stdout, /FOREGROUND/u);
  assert.match(help.stdout, /backgrounding is the operator's/u);
  assert.match(help.stdout, /SINGLE WRITER, IN INTENT ONLY/u);

  const root = runCli(["--help"], dir);
  assert.match(root.stdout, /approval daemon run/u);
});

test("usage: a bad duration, an unknown subcommand and a missing --tasks folder", () => {
  const dir = ready();
  const bad = runCli(["daemon", "run", "--interval", "1h30m", "--once"], dir);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--interval expects a duration/u);

  const unknown = runCli(["daemon", "sniff"], dir);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown subcommand/u);

  const missing = runCli(["daemon", "run", "--once", "--tasks", "nowhere", "--json"], dir);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /is not a directory/u);
});

test("usage: an absent DEFAULT task folder warns and the daemon still sweeps and renders", () => {
  const dir = ready();
  rmSync(join(dir, "backlog"), { recursive: true, force: true });
  const run = runCli(["daemon", "run", "--once", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /does not exist/u);
  assert.ok(existsSync(queuePath(dir)), "the queue was not rendered");
  assertClean(dir);
});
