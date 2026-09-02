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
 *
 * The write-back cases (APRV-62) assert on bytes and on mtimes rather than on
 * parsed frontmatter: the claim is that one value changed and nothing else did,
 * and a parse would hide exactly the whitespace, comment and line-ending damage
 * the round-trip writer exists to avoid. An unchanged mtime is how "the daemon
 * did not rewrite this file with identical content" is checked, which is the
 * property that keeps a watcher-triggered write from looping.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runPayloadHash } from "../src/core/payload.js";
import type { DaemonEvent } from "../src/daemon/daemon.js";

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

/**
 * A binding for a declaration nothing in this suite ever executes: the flow-style
 * envelope of the write-back-refusal case, which is registered and never run.
 * Every action that DOES execute binds to {@link CHILD} instead (APRV-140).
 */
const UNEXECUTED_BINDING = "3".repeat(64);

/**
 * The one command every `approval run` in this suite spawns. `run` recomputes
 * the binding from the argv and cwd it is about to spawn (APRV-140), so the exit
 * code travels in the ENVIRONMENT: one payload, one binding per case directory,
 * and the declarations can commit to it before anything runs.
 */
const CHILD = [process.execPath, "-e", "process.exit(Number(process.env.CHILD_EXIT ?? 0))"];

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

/**
 * The sampling secret, passed to each child through an explicitly named
 * TEST-SCOPED variable and never exported into this process, so no other suite
 * can be changed by it and no assertion here depends on a developer's shell.
 */
const SAMPLING_SECRET_ENV = "APPROVAL_TEST_DAEMON_SAMPLING_SECRET";
const SAMPLING_SECRET = "operator-held-secret-never-in-the-log";

/** Rate 1: every supervised execution is drawn, so the case tests the daemon's
 * reporting rather than which subjects a particular secret happens to pick. */
const POLICY_SAMPLING = POLICY.replace(
  "```\n",
  ["audit:", "  supervised_sample_rate: 1", `  sampling_secret_env: ${SAMPLING_SECRET_ENV}`, "```\n"].join(
    "\n",
  ),
);

/** Short enough to lapse inside a test, long enough not to race the setup. */
const POLICY_SHORT_TTL = policy("2s");

function taskFile(state: string, dir: string): string {
  const binding = runPayloadHash(CHILD, dir);
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
    '      est_cost_usd: "0.02"',
    '      idempotency_key: "task-042:chaser"',
    `      payload_hash: "${binding}"`,
    "    - class: communicate.email.external",
    '      summary: "Send the follow-up"',
    "      reversible: false",
    '      est_cost_usd: "0.02"',
    '      idempotency_key: "task-042:followup"',
    `      payload_hash: "${binding}"`,
    "    - class: files.write.local",
    '      summary: "Write the draft"',
    "      reversible: true",
    '      est_cost_usd: "0.01"',
    '      idempotency_key: "task-042:draft"',
    `      payload_hash: "${binding}"`,
    "    - class: files.write.local",
    '      summary: "Write the second draft"',
    "      reversible: true",
    '      est_cost_usd: "0.01"',
    '      idempotency_key: "task-042:draft2"',
    `      payload_hash: "${binding}"`,
    "    - class: files.write.local",
    '      summary: "Write the third draft"',
    "      reversible: true",
    '      est_cost_usd: "0.01"',
    '      idempotency_key: "task-042:draft3"',
    `      payload_hash: "${binding}"`,
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
  writeFileSync(join(dir, "backlog", "tasks", "task-042.md"), taskFile(state, dir), "utf8");
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
function daemonOnce(
  dir: string,
  extra: string[] = [],
  env: Record<string, string> = {},
): { run: Run; lines: Record<string, unknown>[] } {
  const run = runCli(["daemon", "run", "--once", "--json", ...extra], dir, env);
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

  // Drift, then repair (APRV-62): the disagreement reaches the log first and the
  // file is corrected second, in the same tick.
  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("awaiting", dir));
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

  // Two more passes over an unchanged world append nothing: the first pass
  // repaired the file, so there is no longer a contradiction to record.
  daemonOnce(dir);
  daemonOnce(dir);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);

  // A different wrong claim is a different fact and is recorded.
  writeFileSync(taskPath(dir), taskFile("executed", dir), "utf8");
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

/**
 * The same task file with pre-APRV-121 monetary fields: JSON numbers where the
 * write boundary now demands canonical decimal strings. Derived from
 * {@link taskFile} by unquoting only the amounts, so the repair-preservation
 * assertions can compare whole files byte for byte.
 */
function historicalTaskFile(state: string, dir: string): string {
  return taskFile(state, dir).replaceAll(/est_cost_usd: "([0-9.]+)"/gu, "est_cost_usd: $1");
}

test("drift: a pre-121 envelope is scanned at the read boundary, not refused (APRV-148)", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");

  // The log says `awaiting`. The file now carries the numeric monetary form a
  // pre-121 write boundary accepted, still claiming `proposed`: the daemon must
  // read the claim and record the contradiction, not warn and look away.
  writeFileSync(taskPath(dir), historicalTaskFile("proposed", dir), "utf8");

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /envelope-invalid/u);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);

  // Repair still lands (set-state preserves the fields it did not author, the
  // numeric amounts included), so the historical file is not stranded in drift.
  assert.equal(readFileSync(taskPath(dir), "utf8"), historicalTaskFile("awaiting", dir));
  assertClean(dir);
});

test("drift: a pre-121 envelope that agrees with the log appends nothing and warns nothing", () => {
  const dir = ready(POLICY, "proposed");
  writeFileSync(taskPath(dir), historicalTaskFile("proposed", dir), "utf8");
  const before = records(dir).length;

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /envelope-invalid/u);
  assert.equal(records(dir).length, before);
  assertClean(dir);
});

test("drift: the write boundary still refuses the numeric form the scan accepts (APRV-148)", () => {
  const dir = caseDir(POLICY, "proposed");
  writeFileSync(taskPath(dir), historicalTaskFile("proposed", dir), "utf8");
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);

  const register = runCli(
    ["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"],
    dir,
  );
  assert.notEqual(register.code, 0, "register accepted a numeric monetary field");
  assert.match(`${register.stdout}${register.stderr}`, /envelope-invalid|must be string/u);
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
  const plain = join(dir, "backlog", "tasks", "task-099.md");
  const text = ["---", "id: task-099", "title: No envelope", "---", "", "Body.", ""].join("\n");
  writeFileSync(plain, text, "utf8");
  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.equal(eventsOf(dir, "envelope.drift").length, 0);
  // Write-back is not this file's business either: no envelope is invented for
  // it, and no warning is spent on a task that is simply a plain task.
  assert.equal(readFileSync(plain, "utf8"), text);
  assertClean(dir);
});

// ===========================================================================
// Projection write-back (SPEC.md §6.3, §10.2, APRV-62)
// ===========================================================================

/** Indices of the lines on which two texts differ. Both must have the same count. */
function differingLines(before: string, after: string): number[] {
  const b = before.split("\n");
  const a = after.split("\n");
  assert.equal(a.length, b.length, "the rewrite changed the number of lines");
  const out: number[] = [];
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) out.push(index);
  return out;
}

test("write-back: the log's state is written into the file, one line and no other byte", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");
  const before = readFileSync(taskPath(dir), "utf8");

  const { run, lines } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);

  const back = lines.find((line) => line["event"] === "write_back");
  assert.ok(back !== undefined, `no write_back line: ${run.stdout}`);
  assert.equal(back["task"], "task-042");
  assert.equal(back["from"], "proposed");
  assert.equal(back["to"], "awaiting");
  assert.equal(typeof back["bytes"], "number");

  const after = readFileSync(taskPath(dir), "utf8");
  const changed = differingLines(before, after);
  assert.equal(changed.length, 1, `more than the state: line changed: ${JSON.stringify(changed)}`);
  assert.equal(after.split("\n")[changed[0] as number]?.trim(), "state: awaiting");
  assert.equal(after, taskFile("awaiting", dir), "the file is the original with one value replaced");
  assertClean(dir);
});

test("write-back: the repaired file is quiet on the next tick — no drift, no rewrite", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");
  daemonOnce(dir);

  const repaired = readFileSync(taskPath(dir), "utf8");
  const mtime = statSync(taskPath(dir)).mtimeMs;
  const drifts = eventsOf(dir, "envelope.drift").length;
  const total = records(dir).length;

  // Two further passes see a file that already agrees with the log. Nothing is
  // appended and nothing is written, so the watcher this write would have woken
  // never fires and the loop is not a loop.
  for (let pass = 0; pass < 2; pass += 1) {
    const { run, lines } = daemonOnce(dir);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(lines.some((line) => line["event"] === "write_back"), false, run.stdout);
    assert.equal(lines.some((line) => line["event"] === "drift"), false, run.stdout);
  }

  assert.equal(readFileSync(taskPath(dir), "utf8"), repaired);
  assert.equal(statSync(taskPath(dir)).mtimeMs, mtime, "the file was rewritten with the same bytes");
  assert.equal(eventsOf(dir, "envelope.drift").length, drifts);
  assert.equal(records(dir).length, total);
  assertClean(dir);
});

test("write-back: a live daemon repairs once and then leaves the file alone", async () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");

  const daemon = new LiveDaemon(dir, ["--interval", "100ms"]);
  await until(
    () => readFileSync(taskPath(dir), "utf8") === taskFile("awaiting", dir),
    "the daemon to repair the file",
  );
  const mtime = statSync(taskPath(dir)).mtimeMs;

  // A write wakes the watcher, which schedules a tick, which could write again.
  // Several intervals later the file must still carry the same bytes and the
  // same mtime, and the log must carry exactly one drift record.
  await until(
    () => daemon.lines().filter((line) => line["event"] === "tick").length >= 5,
    "five ticks",
  );
  const code = await daemon.stopWith("SIGINT");
  assert.equal(code, 0, `daemon exited ${code}: ${daemon.stderr}`);

  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("awaiting", dir));
  assert.equal(statSync(taskPath(dir)).mtimeMs, mtime, "the daemon rewrote the file repeatedly");
  assert.equal(daemon.lines().filter((line) => line["event"] === "write_back").length, 1);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);
  assertClean(dir);
});

test("write-back: a file the writer will not round-trip is warned about and left untouched", () => {
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");

  // A flow-style envelope: schema-valid, so the drift scan reads a claim out of
  // it, and unrewritable, because a state-only edit rewrites one line and a flow
  // mapping does not have one. Exactly the shape the writer refuses.
  const flow = [
    "---",
    "id: task-042",
    "title: Chase deposit refund",
    `approval: {origin: {app: example-capture, created_by: "human:carter"}, state: proposed, actions: [{class: communicate.email.external, summary: "Send deposit chaser", reversible: false, est_cost_usd: "0.02", idempotency_key: "task-042:chaser", payload_hash: "${UNEXECUTED_BINDING}"}]}`,
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
  writeFileSync(taskPath(dir), flow, "utf8");

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /write-back-refused/u);
  assert.match(run.stderr, /unsupported-shape/u);

  // The refusal is total: the file is exactly as it was, and the drift record
  // that preceded it still stands.
  assert.equal(readFileSync(taskPath(dir), "utf8"), flow);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);
  assert.deepEqual(
    readdirSync(join(dir, "backlog", "tasks")).filter((name) => name.includes(".tmp-")),
    [],
    "a temp task file survived a refused write-back",
  );
  assertClean(dir);
});

test("write-back: the file follows the log through registered, requested, granted, executed", () => {
  const dir = ready(POLICY, "proposed");

  // Registered, and the file already agrees: nothing to record and nothing to
  // write. This is the shape of the APRV-51 proof, which under the M5 deferral
  // left three drift records and a file that never moved.
  daemonOnce(dir);
  assert.equal(eventsOf(dir, "envelope.drift").length, 0);
  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("proposed", dir));

  request(dir, "task-042:chaser");
  daemonOnce(dir);
  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("awaiting", dir));

  const granted = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(granted.code, 0, granted.stderr);
  const token = String((JSON.parse(granted.stdout) as Record<string, unknown>)["token"]);
  daemonOnce(dir);
  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("approved", dir));

  const executed = runCli(
    ["run", "task-042:chaser", "--token", token, "--as", "agent:claude", "--", ...CHILD],
    dir,
  );
  assert.equal(executed.code, 0, executed.stderr);
  daemonOnce(dir);
  assert.equal(readFileSync(taskPath(dir), "utf8"), taskFile("executed", dir));

  // One drift record per transition the daemon observed: each marks a moment the
  // file was found behind the log and brought up to it, and none is a repeat.
  const drifts = eventsOf(dir, "envelope.drift");
  assert.equal(drifts.length, 3);
  assert.deepEqual(
    drifts.map((record) => {
      const payload = record["payload"] as Record<string, unknown>;
      return [payload["declared_state"], payload["derived_state"]];
    }),
    [
      ["proposed", "awaiting"],
      ["awaiting", "approved"],
      ["approved", "executed"],
    ],
  );
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
    const run = runCli(["run", key, "--as", "agent:claude", "--", ...CHILD], dir, {
      CHILD_EXIT: "1",
    });
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
    // APRV-145: `scope` is the additive field; `task` still carries the key.
    { task: "task-042", scope: "task", consecutive_failures: 3, escalated: true },
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

test("a tick publishes the verified-head snapshot, and a corrupt log publishes none", () => {
  // APRV-188. The daemon is the process that has already walked the chain, so
  // it is the one that publishes what it walked. Two properties matter here and
  // nothing else: the file lands at mode 0600 (the ownership argument in
  // `core/verified-snapshot.ts` rests on it), and it describes the log the tick
  // actually read. What a READER does with it is `tests/verified-snapshot.ts`.
  const dir = ready(POLICY, "proposed");
  request(dir, "task-042:chaser");
  const snapshotPath = join(dir, ".approval", "log", "verified-head.json");
  assert.ok(!existsSync(snapshotPath), "nothing publishes it before the daemon runs");

  const run = runCli(["daemon", "run", "--once", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(existsSync(snapshotPath), "one tick publishes it");
  assert.equal((statSync(snapshotPath).mode & 0o777).toString(8), "600");

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  const log = readFileSync(logPath(dir));
  assert.equal(snapshot["log"], realpathSync(logPath(dir)));
  assert.equal(snapshot["byte_length"], log.length, "it endorses the log as the tick left it");
  assert.equal(
    snapshot["lines"],
    readFileSync(logPath(dir), "utf8").split("\n").filter((line) => line).length,
  );
  assert.equal(
    snapshot["sha256"],
    createHash("sha256").update(log).digest("hex"),
    "the digest is of the bytes on disk",
  );

  // A log that stops verifying leaves the old snapshot alone rather than
  // endorsing anything: only a clean read publishes.
  const before = readFileSync(snapshotPath, "utf8");
  appendFileSync(logPath(dir), `${JSON.stringify({ seq: 99, hash: "0".repeat(64) })}\n`, "utf8");
  const broken = runCli(["daemon", "run", "--once", "--json"], dir);
  assert.equal(broken.code, 1);
  assert.equal(readFileSync(snapshotPath, "utf8"), before, "a corrupt read publishes nothing");
});

test("the daemon does not wake itself from its own writes", async () => {
  // APRV-211. Every clean read publishes a verified-head snapshot into the
  // directory the daemon watches, and every repaired task file lands in the
  // other one. Before the watcher learned to ignore its own hand, that made an
  // idle daemon tick forever: 18 ticks in 45 seconds against a ten-minute
  // interval, with nothing else writing anything.
  //
  // A long interval and a short debounce is what tells the two apart: the only
  // thing that can produce a second tick here is a watcher event, so a single
  // tick over a second and a half of idleness is the property, and the watcher
  // still being LIVE for a real change is the other half of it.
  const dir = ready(POLICY, "proposed");

  const daemon = new LiveDaemon(dir, ["--interval", "60s", "--debounce", "50ms"]);
  await until(() => daemon.lines().some((line) => line["event"] === "tick"), "the first tick");

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const idle = daemon.lines().filter((line) => line["event"] === "tick");
  assert.equal(
    idle.length,
    1,
    `an idle daemon ticked ${String(idle.length)} times in 1.5 s with a 60 s interval: it is waking itself`,
  );

  // The watcher is not deaf, only deaf to itself: a real append wakes it well
  // inside the interval.
  request(dir, "task-042:chaser");
  await until(
    () => daemon.lines().filter((line) => line["event"] === "tick").length >= 2,
    "a tick woken by an external append",
  );

  const code = await daemon.stopWith("SIGTERM");
  assert.equal(code, 0, `daemon exited ${code}: ${daemon.stderr}`);
  assertClean(dir);
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
    // APRV-91: the frozen table is printed by `approval --help` alone.
    assert.match(run.stdout, /exit codes: approval --help/u);
    assert.match(run.stdout, /Usage:/u);
    assert.match(run.stdout, /--json/u);
  }
  const help = runCli(["daemon", "run", "-h"], dir);
  assert.match(help.stdout, /FOREGROUND/u);
  assert.match(help.stdout, /backgrounding is the operator's/u);
  // APRV-91: the single-writer reasoning moved to
  // docs/cli-reference.md#daemon-run, which the help points at.
  assert.match(help.stdout, /docs\/cli-reference\.md#daemon-run/u);

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

// ===========================================================================
// The frozen output union (APRV-57)
// ===========================================================================

test("the DaemonEvent union is frozen public output: every variant, listed", () => {
  // The `Record` makes the compiler the first assertion: a variant added to the
  // union without a key here does not build, and a key here naming no variant
  // does not build either. The `deepEqual` is the second: growing the union is a
  // deliberate edit to this list, and repurposing an entry (the one thing a
  // frozen shape forbids) surfaces in the diff as a rename rather than as a
  // quietly different meaning behind an unchanged name.
  const variants: Record<DaemonEvent["event"], true> = {
    started: true,
    // APRV-204: the cadence advance's line. Appended to the union, so no
    // existing entry changed meaning.
    advance: true,
    // APRV-192: the dark-session sweep's line. Appended to the union, so no
    // existing entry changed meaning.
    dark_session: true,
    drift: true,
    write_back: true,
    expired: true,
    sampled: true,
    pruned: true,
    rendered: true,
    escalated: true,
    escalation_cleared: true,
    tick: true,
    warning: true,
    stopped: true,
  };

  assert.deepEqual(Object.keys(variants).sort(), [
    "advance",
    "dark_session",
    "drift",
    "escalated",
    "escalation_cleared",
    "expired",
    "pruned",
    "rendered",
    "sampled",
    "started",
    "stopped",
    "tick",
    "warning",
    "write_back",
  ]);
});

// ===========================================================================
// Audit sampling, end to end through --json (APRV-40 appends, APRV-57 reports)
// ===========================================================================

test("sampling: a supervised execution drawn by the daemon is one `sampled` JSON line", () => {
  const dir = caseDir(POLICY_SAMPLING, "proposed");
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(
    runCli(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir).code,
    0,
  );
  // Supervised: it runs without asking and is sampled afterwards, which is the
  // only kind of execution the sweep can draw.
  const ran = runCli(
    ["run", "task-042:draft", "--as", "agent:claude", "--", ...CHILD],
    dir,
    { [SAMPLING_SECRET_ENV]: SAMPLING_SECRET },
  );
  assert.equal(ran.code, 0, ran.stderr);
  const started = eventsOf(dir, "execution.started");
  assert.equal(started.length, 1, ran.stdout);

  const { run, lines } = daemonOnce(dir, [], { [SAMPLING_SECRET_ENV]: SAMPLING_SECRET });
  assert.equal(run.code, 0, run.stderr);

  const sampled = lines.filter((line) => line["event"] === "sampled");
  assert.equal(sampled.length, 1, `one line per appended sample: ${run.stdout}`);
  const line = sampled[0] as Record<string, unknown>;
  assert.equal(line["action_key"], "task-042:draft");
  assert.equal(line["task"], "task-042");
  assert.equal(line["subject_seq"], started[0]?.["seq"]);

  const appended = eventsOf(dir, "audit.sampled");
  assert.equal(appended.length, 1);
  assert.equal(line["seq"], appended[0]?.["seq"], "the line must name the record it reports");
  assert.equal(
    run.stdout.includes(SAMPLING_SECRET),
    false,
    "the sampling secret reached the output stream",
  );

  // Idempotence: the second tick samples nothing, so it says nothing. A success
  // line repeated every tick could not be told apart from a second sample.
  const again = daemonOnce(dir, [], { [SAMPLING_SECRET_ENV]: SAMPLING_SECRET });
  assert.equal(
    again.lines.filter((entry) => entry["event"] === "sampled").length,
    0,
    again.run.stdout,
  );
  assert.equal(eventsOf(dir, "audit.sampled").length, 1);
  assertClean(dir);
});
