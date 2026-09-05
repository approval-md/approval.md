/**
 * `approval up` — the ambient runtime, driven as a real process (APRV-110).
 *
 * This suite is deliberately a COMPOSITION and not a third description of
 * behaviour already described twice. The daemon suite says what the loop does,
 * the telegram suite says what the listener does, and the question here is only
 * whether the two behave identically when one process runs both. So the fixtures
 * are the daemon suite's shape (a real case directory, a real task file, a
 * policy attested and a request made through the CLI's own verbs) and the far
 * end is the telegram suite's mock Bot API. Nothing new is asserted about a
 * prompt's wording, a token's format, or a tick's contents: those are asserted
 * where they belong, and repeating them here would only produce a second place
 * to update when they change.
 *
 * What IS asserted here, and nowhere else:
 *
 * - the two parts run in ONE process and both leave their marks (a decision
 *   recorded through the channel, a queue projection written by the daemon);
 * - the decision object and the token panel are the same as the separate
 *   listener's, compared field by field against a run of that very verb;
 * - a channel that cannot start does not stop the daemon, and says why in
 *   `approval doctor`'s vocabulary;
 * - a channel that falls over is restarted with backoff while the daemon keeps
 *   ticking, and the restart RE-SENDS what is still pending;
 * - SIGINT and SIGTERM stop every part and leave the log verifiable.
 *
 * Every log here is built through the real append path. No line is written by
 * hand, and `approval log verify` runs at the end of every scenario that
 * appended anything.
 *
 * Timing: nothing sleeps a fixed amount and hopes. Every wait is a poll on the
 * condition itself with a generous ceiling, because a suite that spawns real
 * processes and long-polls a real socket has no business asserting on latency.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { payloadHash } from "../src/core/payload.js";
import { callbackUpdate, startMockBotApi, assertLocal, type MockBotApi } from "./telegram-mock.js";
import { fakeClaudeEnv } from "./fake-claude.js";

/** dist/tests/up.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-up-")));
let counter = 0;

/** The fake bot token and chat, in the telegram suite's own shape. */
const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";
const CHAT = "9911";
const HUMAN = "human:carter";
const ACTOR = "agent:claude";
const TASK = "task-042";

/**
 * Every live process this file starts, so a failed assertion cannot leave one
 * running. An orphan keeps the test runner alive, and a suite that hangs reports
 * nothing at all rather than reporting the failure it found.
 */
const live = new Set<LiveUp>();

let mock: MockBotApi;

before(async () => {
  mock = await startMockBotApi(TOKEN);
});

after(async () => {
  for (const process_ of live) process_.child.kill("SIGKILL");
  live.clear();
  await mock.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The material the one action is bound to.
 *
 * Nothing here executes, so the binding exists for the reason SPEC.md §6.2 makes
 * it mandatory for a manual action: a human is asked to approve BYTES, and a
 * request whose bytes nobody holds is `payload-unavailable` and never presented.
 * The same document is written to a `--payloads` file, which is how the telegram
 * suite feeds its own listener, so both verbs in the byte-compatibility case see
 * one payload through one path.
 */
const PAYLOAD: Record<string, unknown> = {
  from: "ap@approval.example",
  to: ["ap@vendor.example"],
  subject: "Invoice 41 chaser <urgent> & overdue",
  body: "Following up on invoice 41. The balance is £1,200 <b>including</b> VAT.",
};

function policy(ttl: string, extra: string[] = []): string {
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
    "  communicate.email.external:",
    "    autonomy: manual",
    "budgets:",
    "  global:",
    "    daily_usd: 10",
    "    daily_actions: 50",
    ...extra,
    "```",
    "",
  ].join("\n");
}

const POLICY = policy("1h");

/**
 * The TTL a lapse is caused with, rather than waited for (APRV-248).
 *
 * The expiry case used to run under a 2s TTL, which had to outlast the whole
 * launch of `approval up` — the spawn, the first verified read, the channel
 * coming up and the prompt reaching the mock. On a busy machine it did not: the
 * request lapsed before it was ever delivered, nothing arrived to annotate, and
 * the case sat in its 20s ceiling and then failed for the machine. The daemon
 * re-reads `defaults.approval_ttl` on every pass by design, so the case now runs
 * under the ordinary 1h TTL and calls {@link lapse} once it has watched the
 * prompt arrive.
 */
const POLICY_LAPSED_TTL = policy("1ms");

function taskFile(key: string): string {
  const binding = payloadHash(PAYLOAD);
  return [
    "---",
    `id: ${TASK}`,
    "title: Chase deposit refund",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: example-capture",
    `    created_by: "${HUMAN}"`,
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser"',
    "      reversible: false",
    '      est_cost_usd: "0.02"',
    `      idempotency_key: "${key}"`,
    `      payload_hash: "${binding}"`,
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The launch environment, and only it.
 *
 * SPEC.md §11.1 invariant 7 is the point of the scrub: nothing loads
 * `.approval/env` implicitly, so a developer whose own shell exports a token
 * must not be able to make an "unconfigured" case pass. What a child sees is
 * exactly what a case hands it.
 */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // APRV-197. `up` starts the Telegram listener, and that listener asks a model
  // for a one-sentence gloss unless told not to. Every spawn in this file gets
  // a fake `claude` first on PATH, so the suite answers itself instantly rather
  // than spending ~13s per request on a real model — and never depends on
  // whether the machine running the tests has the CLI installed at all.
  const env = { ...process.env, ...fakeClaudeEnv(scratch), ...extra };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_TG_TOKEN", "APPROVAL_TG_CHAT"]) {
    if (extra[name] === undefined) delete env[name];
  }
  return env;
}

/**
 * NO RUN IN THIS FILE MAY REACH THE REAL BOT API, and this is where that is
 * enforced rather than remembered.
 *
 * A run that hands the process a bot token without also pointing it at the local
 * mock would have the listener long-poll `api.telegram.org`, which in a
 * `spawnSync` is a test suite that hangs rather than one that fails. The
 * telegram suite makes the same promise with `assertLocal` on every channel it
 * constructs; a subprocess has no channel to inspect, so the argv is checked
 * instead.
 */
function assertOffline(args: readonly string[], env: Record<string, string>): void {
  // No credential, or the channel explicitly left out: nothing will be built, so
  // there is nothing that could dial out.
  if (env["APPROVAL_TG_TOKEN"] === undefined) return;
  if (args.includes("--no-telegram")) return;
  const base = args.indexOf("--api-base");
  assert.notEqual(
    base,
    -1,
    `a configured telegram run must pass --api-base at the mock: ${args.join(" ")}`,
  );
  assertLocal(args[base + 1] ?? "");
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  assertOffline(args, env);
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: cliEnv(env),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
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

/** One case: its own directory, and its own action key. */
interface Case {
  dir: string;
  key: string;
}

/**
 * A case directory with the policy attested, the task registered and one manual
 * request awaiting a human. Built entirely through the CLI's own verbs.
 *
 * THE ACTION KEY IS UNIQUE PER CASE, and that is load-bearing rather than tidy.
 * One mock Bot API serves the whole file, exactly as it serves the telegram
 * suite, so a constant key would let one case's delivered prompt satisfy the
 * next case's "has it been delivered yet?" and hand it a callback nonce minted
 * by a process that has already exited.
 */
function ready(policyText: string = POLICY): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  const key = `${TASK}:chaser-${String(counter)}`;
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "backlog", "tasks", `${TASK}.md`), taskFile(key), "utf8");
  writeFileSync(join(dir, "payloads.json"), JSON.stringify({ [key]: PAYLOAD }), "utf8");

  assert.equal(runCli(["policy", "attest", "--as", HUMAN], dir).code, 0);
  assert.equal(
    runCli(["register", join("backlog", "tasks", `${TASK}.md`), "--as", ACTOR], dir).code,
    0,
  );
  const requested = runCli(["request", TASK, "--action", key, "--as", ACTOR], dir);
  assert.equal(requested.code, 0, requested.stderr);
  return { dir, key };
}

/**
 * Make every still-live request in `dir` lapse, now (APRV-248).
 *
 * The human's own ceremony, used as the test's clock: the policy file is
 * rewritten with a 1ms `defaults.approval_ttl` and re-attested through the real
 * CLI verb, exactly as an operator shortening a deadline would do it. The
 * request was made before the runtime even started, so from the daemon's next
 * pass onwards it is lapsed by the policy in force. Only the TTL differs from
 * the policy the case started under.
 */
function lapse(dir: string): void {
  writeFileSync(join(dir, "APPROVAL.md"), POLICY_LAPSED_TTL, "utf8");
  const attested = runCli(["policy", "attest", "--as", HUMAN], dir);
  assert.equal(attested.code, 0, attested.stderr);
}

/** The channel environment a configured case is launched with. */
function configured(): Record<string, string> {
  return { APPROVAL_TG_TOKEN: TOKEN, APPROVAL_TG_CHAT: CHAT, APPROVAL_HUMAN: HUMAN };
}

/**
 * The flags every configured case passes: the local mock, the payload the
 * request is bound to, and a long poll with room in it.
 *
 * Five seconds rather than one because of `--once`, which is a single poll: a
 * test queues its callback the moment it sees the prompt, and a one-second poll
 * can have opened and closed empty in the gap. The wait is not a sleep — the
 * poll returns as soon as the update lands — so the ceiling costs nothing except
 * on the paths that are deliberately waiting for nothing to happen.
 */
function channelArgs(): string[] {
  return [...apiBase(), "--poll-timeout", "5", "--payloads", "payloads.json"];
}

/** The mock alone, for the cases that also want to spell a poll timeout wrong. */
function apiBase(): string[] {
  return ["--api-base", assertLocal(mock.url)];
}

async function until(predicate: () => boolean, label: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Wait until the mock has offered an Approve button for `key`. */
async function untilDelivered(key: string, label: string): Promise<void> {
  await until(
    () => {
      try {
        mock.callbackDataFor(key, "grant");
        return true;
      } catch {
        return false;
      }
    },
    label,
  );
}

/** A live `approval up`, with its output collected as it arrives. */
class LiveUp {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  private readonly exited: Promise<number>;

  constructor(dir: string, args: string[], env: Record<string, string>) {
    assertOffline(args, env);
    this.child = spawn(process.execPath, [CLI_ENTRY, "up", "--json", ...args], {
      cwd: dir,
      env: cliEnv(env),
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

  /** Every JSON line on stdout so far. */
  lines(): Record<string, unknown>[] {
    return jsonLines(this.stdout);
  }

  /** Every JSON line on stderr so far: warnings, refusals and part failures. */
  errLines(): Record<string, unknown>[] {
    return jsonLines(this.stderr);
  }

  countOf(event: string): number {
    return [...this.lines(), ...this.errLines()].filter((line) => line["event"] === event).length;
  }

  async stopWith(signal: NodeJS.Signals): Promise<number> {
    this.child.kill(signal);
    return this.exited;
  }

  /**
   * The exit code, whenever it arrives — including if it already has.
   *
   * Attaching a fresh `on("exit")` at the point a case wants to wait is a bug
   * that only shows up under load: `--once` can be finished before the case gets
   * there, and a listener attached after the event never fires at all. The
   * promise is made once, in the constructor, for exactly that reason.
   */
  async wait(): Promise<number> {
    return this.exited;
  }
}

/**
 * Parse the JSON lines out of a stream, ignoring anything that is not one.
 *
 * A `--json` run should emit nothing else, and the cases that care assert that
 * separately. Being lenient here keeps an unrelated stray line from turning
 * every assertion in the suite into a parse error.
 */
function jsonLines(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      found.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return found;
}

// ===========================================================================
// 1. One process, both parts (AC 1)
// ===========================================================================

test("up --once: one process delivers the prompt, records the decision and writes the queue", async () => {
  const { dir, key } = ready();
  const process_ = new LiveUp(dir, ["--once", ...channelArgs()], configured());

  await untilDelivered(key, "the ambient runtime to deliver the pending request");
  mock.queueUpdate(callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }));

  // `--once` ends on its own: one daemon tick and one poll cycle, with the fast
  // part waiting for the slow one. No signal is sent here on purpose.
  const code = await process_.wait();
  assert.equal(code, 0, `up exited ${String(code)}: ${process_.stderr}`);

  // The CHANNEL's half: a decision recorded against the launch identity.
  const granted = eventsOf(dir, "approval.granted");
  assert.equal(granted.length, 1, "the channel recorded no decision");
  assert.equal((granted[0] as Record<string, unknown>)["actor"], HUMAN);

  // The DAEMON's half, in the same process: the queue projection exists, and it
  // is the daemon and nothing else that writes it.
  assert.ok(existsSync(join(dir, ".approval", "QUEUE.md")), "the daemon wrote no queue");

  // And the two halves shared one stream.
  const events = new Set(process_.lines().map((line) => line["event"]));
  assert.ok(events.has("up_started"), `no up_started line: ${process_.stdout}`);
  assert.ok(events.has("started"), "the daemon's own started line is missing from the stream");
  assert.ok(events.has("notified"), "the listener's own notified line is missing from the stream");
  assert.ok(events.has("decision"), "the listener's own decision line is missing from the stream");

  assertClean(dir);
});

test("up --no-telegram --no-web is the daemon alone, and says which parts it started", () => {
  const { dir } = ready();
  const run = runCli(["up", "--once", "--json", "--no-telegram", "--no-web"], dir, configured());
  assert.equal(run.code, 0, run.stderr);

  const started = jsonLines(run.stdout).find((line) => line["event"] === "up_started");
  assert.ok(started !== undefined, `no up_started line: ${run.stdout}`);
  assert.deepEqual(started["parts"], ["daemon"]);
  assert.equal(jsonLines(run.stdout).some((line) => line["event"] === "tick"), true);
  assertClean(dir);
});

// ===========================================================================
// 2. Byte-compatibility with the separate processes (AC 2)
// ===========================================================================

/**
 * The fields of a decision line that mean the same thing in any run.
 *
 * The comparison below is in two halves on purpose. The KEY SET is compared
 * whole, because a field added on one path and not the other is the regression
 * this case exists to catch and no list of interesting fields would notice it.
 * The VALUES are compared over these names only, because everything else on the
 * line is legitimately per-run: a token, a nonce, a message id, a sequence
 * number and a timestamp differ between two runs of the SAME verb, and asserting
 * they do not would be asserting something false.
 */
const SEMANTIC = ["event", "outcome", "actor", "channel", "class", "task"] as const;

function semantics(line: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const name of SEMANTIC) {
    if (name in line) copy[name] = line[name];
  }
  return copy;
}

test("the decision line and the token panel are the separate listener's, field for field", async () => {
  // Two identical fixtures, one decided by `channel telegram listen --once` and
  // one by `up --once`. The comparison is against the verb this one replaces,
  // rather than against a literal pinned in this file: a shape that changed in
  // both would be a deliberate change to the channel, and a shape that changed
  // in one is exactly the regression this case exists to catch.
  const listenCase = ready();
  const listenDir = listenCase.dir;
  const listener = spawn(
    process.execPath,
    [CLI_ENTRY, "channel", "telegram", "listen", "--once", "--json", ...channelArgs()],
    { cwd: listenDir, env: cliEnv(configured()) },
  );
  let listenOut = "";
  listener.stdout.setEncoding("utf8");
  listener.stdout.on("data", (chunk: string) => {
    listenOut += chunk;
  });
  await untilDelivered(listenCase.key, "the separate listener to deliver");
  mock.queueUpdate(
    callbackUpdate({ data: mock.callbackDataFor(listenCase.key, "grant"), chatId: CHAT }),
  );
  const listenCode = await new Promise<number>((resolve) => {
    listener.on("exit", (code) => resolve(code ?? -1));
  });
  assert.equal(listenCode, 0, `the separate listener exited ${String(listenCode)}`);
  assert.equal(
    eventsOf(listenDir, "approval.granted").length,
    1,
    "the separate listener recorded no decision, so there is nothing to compare against",
  );

  const upCase = ready();
  const upDir = upCase.dir;
  const process_ = new LiveUp(upDir, ["--once", ...channelArgs()], configured());
  await untilDelivered(upCase.key, "the ambient runtime to deliver");
  mock.queueUpdate(
    callbackUpdate({ data: mock.callbackDataFor(upCase.key, "grant"), chatId: CHAT }),
  );
  const upCode = await process_.wait();
  assert.equal(upCode, 0, process_.stderr);

  const listenDecision = jsonLines(listenOut).find((line) => line["event"] === "decision");
  const upDecision = process_.lines().find((line) => line["event"] === "decision");
  assert.ok(listenDecision !== undefined, `the listener printed no decision: ${listenOut}`);
  assert.ok(upDecision !== undefined, `up printed no decision: ${process_.stdout}`);

  // Identical KEYS, first: a field added on one path and not the other is the
  // failure mode a value-by-value comparison would miss entirely.
  assert.deepEqual(
    Object.keys(upDecision).sort(),
    Object.keys(listenDecision).sort(),
    "the decision object grew or lost a field inside the ambient runtime",
  );
  assert.deepEqual(semantics(upDecision), semantics(listenDecision));

  // The notified line, same treatment.
  const listenNotified = jsonLines(listenOut).find((line) => line["event"] === "notified");
  const upNotified = process_.lines().find((line) => line["event"] === "notified");
  assert.ok(listenNotified !== undefined && upNotified !== undefined);
  assert.deepEqual(Object.keys(upNotified).sort(), Object.keys(listenNotified).sort());

  // The token panel: printed by both, and the same shape in both. Its lines are
  // compared with the two tokens themselves blanked, because a single-use token
  // that repeated across two runs would be a far worse bug than a layout drift.
  const panelOf = (text: string): string[] => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.includes("execution token"));
    assert.notEqual(start, -1, `no execution token panel: ${text}`);
    return lines
      .slice(start, start + 3)
      .map((line) => line.replace(/[0-9a-f]{64}/u, "<token>").replace(/chaser-\d+/u, "<key>"));
  };
  assert.deepEqual(panelOf(process_.stdout), panelOf(listenOut));

  // Both recorded the same thing in their own logs, through the same path.
  for (const dir of [listenDir, upDir]) {
    const granted = eventsOf(dir, "approval.granted");
    assert.equal(granted.length, 1);
    assert.equal((granted[0] as Record<string, unknown>)["actor"], HUMAN);
    assertClean(dir);
  }
});

test("the execution token reaches stdout and never the chat", async () => {
  const { dir, key } = ready();
  const process_ = new LiveUp(dir, ["--once", ...channelArgs()], configured());
  await untilDelivered(key, "the prompt");
  mock.queueUpdate(callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }));
  assert.equal(await process_.wait(), 0, process_.stderr);

  const decision = process_.lines().find((line) => line["event"] === "decision");
  assert.ok(decision !== undefined, process_.stdout);
  assert.equal(decision["token_issued"], true);

  // The token is PRINTED, in the panel, and is not a field on the decision
  // object: that is the separate listener's shape and the ambient runtime prints
  // it with the same function. The panel is what the operator copies from.
  const panel = /execution token +\S+\n {2}(\S+)/u.exec(process_.stdout);
  assert.ok(panel !== null, `no execution token panel: ${process_.stdout}`);
  const token = panel[1] as string;
  assert.match(token, /^[0-9a-f]{64}$/u);

  // The whole point of printing it on the operator's terminal rather than in the
  // prompt. The same assertion the telegram suite makes of the separate verb.
  for (const text of [...mock.sentTexts(), ...mock.answerTexts()]) {
    assert.equal(
      text.includes(token),
      false,
      `the execution token was sent to the chat: ${text}`,
    );
  }
  assertClean(dir);
});

// ===========================================================================
// 3. Fail closed, and carry on (AC 1, AC 3's vocabulary)
// ===========================================================================

test("a channel whose credential is unset is skipped in doctor's words; the daemon runs", () => {
  const { dir } = ready();
  // No APPROVAL_TG_TOKEN, no APPROVAL_TG_CHAT: the machine is unconfigured for
  // telegram, which is a legitimate deployment and not an operator error.
  const run = runCli(["up", "--once", "--json"], dir, { APPROVAL_HUMAN: HUMAN });
  assert.equal(run.code, 0, `an unconfigured channel must not fail the runtime: ${run.stderr}`);

  const skip = jsonLines(run.stderr).find(
    (line) => line["event"] === "part_unavailable" && line["part"] === "telegram",
  );
  assert.ok(skip !== undefined, `no part_unavailable line: ${run.stderr}`);
  // Doctor's four fields, and not a second vocabulary for the same fact.
  assert.equal(skip["status"], "skip");
  assert.equal(typeof skip["check"], "string");
  assert.match(String(skip["detail"]), /APPROVAL_TG_TOKEN/u);
  assert.match(String(skip["fix"]), /approval setup channel telegram/u);

  // The daemon ran anyway, and the runtime said so before it did.
  const started = jsonLines(run.stdout).find((line) => line["event"] === "up_started");
  assert.deepEqual(started?.["parts"], ["daemon"]);
  assert.ok(existsSync(join(dir, ".approval", "QUEUE.md")), "the daemon was withheld");
  assertClean(dir);
});

test("no human identity skips the channel rather than recording against nobody", () => {
  const { dir } = ready();
  const run = runCli(["up", "--once", "--json", ...apiBase()], dir, {
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
  });
  assert.equal(run.code, 0, run.stderr);

  const skip = jsonLines(run.stderr).find(
    (line) => line["event"] === "part_unavailable" && line["part"] === "telegram",
  );
  assert.ok(skip !== undefined, run.stderr);
  assert.match(String(skip["detail"]), /no human identity/u);
  assert.equal(run.stderr.includes(TOKEN), false, "the token must never be echoed back");
  assertClean(dir);
});

test("a mistyped flag is refused outright rather than degraded into a missing channel", () => {
  const { dir } = ready();
  const run = runCli(
    ["up", "--once", "--json", ...apiBase(), "--poll-timeout", "soon"],
    dir,
    configured(),
  );
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /poll-timeout/u);

  const backoff = runCli(
    ["up", "--once", "--json", ...channelArgs(), "--restart-backoff", "1h30m"],
    dir,
    configured(),
  );
  assert.equal(backoff.code, 2, backoff.stderr);
});

test("the queue page is skipped when the policy declares no port, and says it is not a fault", () => {
  const { dir } = ready();
  const run = runCli(["up", "--once", "--json", ...channelArgs()], dir, configured());
  const skip = jsonLines(run.stderr).find(
    (line) => line["event"] === "part_unavailable" && line["part"] === "web",
  );
  assert.ok(skip !== undefined, `no web skip line: ${run.stderr}`);
  assert.equal(skip["status"], "skip");
  assert.equal(skip["check"], "web-port");
  assertClean(dir);
});

// ===========================================================================
// 4. Crash isolation and the re-send (AC 1, AC 2)
// ===========================================================================

test("a channel that falls over is restarted with backoff, re-sends, and the daemon ticks through it", async () => {
  const { dir, key } = ready();
  // The far end is refusing before the runtime starts, so the listener's own
  // startup cycle fails: a part that fell over, not a poll error the channel
  // absorbs on its own.
  mock.fail("500");

  const process_ = new LiveUp(
    dir,
    ["--interval", "200ms", "--restart-backoff", "200ms", ...channelArgs()],
    configured(),
  );

  await until(() => process_.countOf("part_failed") >= 1, "the telegram part to fall over");
  const failed = process_
    .errLines()
    .find((line) => line["event"] === "part_failed" && line["part"] === "telegram");
  assert.ok(failed !== undefined, process_.stderr);
  assert.equal(failed["attempt"], 1);
  assert.equal(typeof failed["restart_in_ms"], "number");

  await until(() => process_.countOf("part_restarted") >= 1, "the telegram part to restart");

  // The claim the split into two processes used to buy, bought back: the daemon
  // loop is unaffected by a channel that cannot reach its far end.
  const ticksAtFailure = process_.countOf("tick");
  await until(
    () => process_.countOf("tick") > ticksAtFailure + 1,
    "the daemon to keep ticking while the channel is down",
  );

  // Recovery: a restart re-derives the pending queue from the verified log and
  // sends what is still pending. A duplicate on the phone, never a silence.
  mock.fail(null);
  await untilDelivered(key, "the restarted listener to re-send the still-pending request");

  const code = await process_.stopWith("SIGTERM");
  assert.equal(code, 0, `up exited ${String(code)}: ${process_.stderr}`);
  assertClean(dir);
});

// ===========================================================================
// 5. The daemon and the channel cooperating (AC 2's annotate flow)
// ===========================================================================

test("the daemon expires a lapsed request and the channel annotates it, in one process", async () => {
  const { dir, key } = ready();
  const process_ = new LiveUp(
    dir,
    ["--interval", "300ms", ...channelArgs()],
    configured(),
  );

  // The prompt reaches the phone first: that is the ordering the case needs, and
  // it is now a fact rather than a race, because nothing can lapse until the
  // next line makes it lapse.
  await untilDelivered(key, "the prompt to be delivered");
  lapse(dir);

  // Nobody taps. The DAEMON's sweep is what ends this request, and the CHANNEL
  // in the same process is what tells the human it ended.
  await until(() => eventsOf(dir, "approval.expired").length === 1, "the daemon's TTL sweep");
  await until(() => mock.edits().length >= 1, "the channel to annotate the expired prompt");

  const edit = mock.edits().at(-1);
  assert.ok(edit !== undefined);
  assert.equal(
    edit.replyMarkup,
    undefined,
    "an annotated prompt must no longer offer a decision to tap",
  );

  const code = await process_.stopWith("SIGTERM");
  assert.equal(code, 0, `up exited ${String(code)}: ${process_.stderr}`);
  assertClean(dir);
});

// ===========================================================================
// 6. Signals stop every part (AC 1)
// ===========================================================================

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} stops every part cleanly and leaves the log verifiable`, async () => {
    const { dir, key } = ready();
    const process_ = new LiveUp(dir, ["--interval", "300ms", ...channelArgs()], configured());

    await untilDelivered(key, "the runtime to be fully up before it is signalled");
    await until(() => process_.countOf("tick") >= 1, "the daemon's first tick");

    const code = await process_.stopWith(signal);
    assert.equal(code, 0, `up exited ${String(code)} on ${signal}: ${process_.stderr}`);

    const lines = process_.lines();
    const stopped = lines.find((line) => line["event"] === "up_stopped");
    assert.ok(stopped !== undefined, `no up_stopped line: ${process_.stdout}`);
    assert.equal(stopped["reason"], signal);

    // Every part that started said it stopped: a supervisor that returned while
    // a part was still running is the thing this assertion rules out.
    const stoppedParts = new Set(
      lines
        .filter((line) => line["event"] === "part_stopped")
        .map((line) => String(line["part"])),
    );
    assert.ok(stoppedParts.has("telegram"), `the telegram part never stopped: ${process_.stdout}`);

    assertClean(dir);
  });
}

// ===========================================================================
// 7. Two spellings, one verb
// ===========================================================================

test("daemon run --with-channels is the ambient runtime, flags and all", () => {
  const { dir } = ready();

  // The tell: `--as` is an `approval up` flag and `daemon run` has no such
  // table, so a run that accepts it reached the other function.
  const help = runCli(["daemon", "run", "--with-channels", "--help"], dir);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /approval up —/u);

  const run = runCli(
    [
      "daemon",
      "run",
      "--with-channels",
      "--once",
      "--json",
      ...apiBase(),
      "--no-telegram",
      "--no-web",
      "--as",
      HUMAN,
    ],
    dir,
    configured(),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.ok(jsonLines(run.stdout).some((line) => line["event"] === "up_started"));
  assertClean(dir);
});

test("up --help and an unexpected argument", () => {
  const { dir } = ready();
  const help = runCli(["up", "--help"], dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /approval up —/u);

  const extra = runCli(["up", "frobnicate", "--json"], dir);
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /unexpected argument/u);
});
