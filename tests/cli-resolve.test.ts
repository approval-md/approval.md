/**
 * `approval execution resolve`, and `approval run`'s computed content binding.
 *
 * Both are CLI contracts, so every case spawns the real compiled CLI: what is
 * under test is what a human or an agent observes — the exit code, the bytes on
 * each stream, and the lines that end up in the log. No log line is written by
 * hand, and `approval log verify` runs after each flow.
 *
 * The recovery verb exists because a crash between `execution.started` and its
 * outcome leaves a dangling execution that nothing repairs automatically. What
 * this suite pins is that the verb refuses to make that write casual: the note
 * is mandatory, the actor is human, and the recorded `exit_code` is `null`
 * rather than an invented number.
 *
 * The `run` cases pin the other half of A1: run computes
 * `runPayloadHash(argv, cwd)` itself, so a token minted for one command cannot
 * spend another.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runPayloadHash } from "../src/core/payload.js";

/** dist/tests/cli-resolve.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-resolve-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

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

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "classes:",
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/** The child `approval run` will spawn in the manual cases. */
function childArgv(): string[] {
  return [process.execPath, "-e", "process.exit(0)"];
}

/** The task file, whose manual action binds to whatever `run` will hash. */
function taskFile(binding: string): string {
  return [
    "---",
    "id: task-042",
    "title: Chase deposit",
    "approval:",
    "  origin:",
    "    app: cartsos",
    '    created_by: "human:carter"',
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser"',
    "      reversible: false",
    "      est_cost_usd: 0.02",
    '      idempotency_key: "task-042:chaser"',
    `      payload_hash: "${binding}"`,
    "    - class: files.write.local",
    '      summary: "Write the draft"',
    "      reversible: true",
    "      est_cost_usd: 0.01",
    '      idempotency_key: "task-042:draft"',
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
}

interface Case {
  dir: string;
  /** The binding the manual action declares — what `run` will compute. */
  binding: string;
}

/** A scratch repo: policy attested, task registered, ready to request. */
function ready(): Case {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  // The binding is what `approval run` will compute for the command below,
  // in this directory — the real derivation, not a stand-in.
  const binding = runPayloadHash(childArgv(), dir);
  writeFileSync(join(dir, "task-042.md"), taskFile(binding), "utf8");

  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  return { dir, binding };
}

function logRecords(dir: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(dir: string): string[] {
  return logRecords(dir).map((record) => record["event"] as string);
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

/** Grant the manual action and return the raw token. */
function grantChaser(dir: string): string {
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir).code,
    0,
  );
  const granted = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(granted.code, 0, granted.stderr);
  return (JSON.parse(granted.stdout) as Record<string, unknown>)["token"] as string;
}

/** A supervised execution that starts and is never closed. */
function dangling(dir: string): void {
  // `consume`-free path: a supervised action needs no token, and killing the
  // child is not needed — a command that cannot be spawned still closes the
  // execution, so the dangle is produced with the internal seam instead.
  const started = runCli(
    ["run", "task-042:draft", "--as", "agent:claude", "--", process.execPath, "-e", "process.exit(0)"],
    dir,
  );
  assert.equal(started.code, 0, started.stderr);
}

// ---------------------------------------------------------------------------
// run: the computed content binding
// ---------------------------------------------------------------------------

test("run computes the binding from argv and cwd, and the spend succeeds", () => {
  const unit = ready();
  const token = grantChaser(unit.dir);

  // No --payload-hash: run hashes the command it is about to spawn.
  const run = runCli(
    ["run", "task-042:chaser", "--token", token, "--as", "agent:claude", "--json", "--", ...childArgv()],
    unit.dir,
  );
  assert.equal(run.code, 0, run.stderr);
  const summary = JSON.parse(run.stderr.trim()) as Record<string, unknown>;
  assert.equal(summary["payload_hash"], unit.binding);

  const started = logRecords(unit.dir).find((record) => record["event"] === "execution.started");
  assert.notEqual(started, undefined, "run appended no execution.started");
  const startedPayload = (started ?? {})["payload"] as Record<string, unknown>;
  assert.equal(startedPayload["payload_hash"], unit.binding);
  assertClean(unit.dir);
});

test("a token minted for one command cannot run another: payload-mismatch, exit 1", () => {
  const unit = ready();
  const token = grantChaser(unit.dir);
  const before = events(unit.dir);

  // Same action key, same token, DIFFERENT bytes. The human approved one
  // command; this is another.
  const run = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--as",
      "agent:claude",
      "--json",
      "--",
      process.execPath,
      "-e",
      "process.exit(1)",
    ],
    unit.dir,
  );
  assert.equal(run.code, 1, run.stderr);
  const error = (JSON.parse(run.stderr.trim()) as Record<string, unknown>)["error"] as Record<
    string,
    unknown
  >;
  assert.equal(error["code"], "payload-mismatch");
  assert.deepEqual(events(unit.dir), before, "a mismatched run appended something");
  assertClean(unit.dir);
});

test("the same command run from a different cwd is different bytes", () => {
  const unit = ready();
  const token = grantChaser(unit.dir);
  const elsewhere = join(unit.dir, "sub");
  mkdirSync(elsewhere, { recursive: true });

  // Identical argv; the cwd is inside the hash, so the binding differs.
  const run = runCli(
    [
      "run",
      "task-042:chaser",
      "--log",
      join(unit.dir, ".approval", "log", "events.jsonl"),
      "--dir",
      unit.dir,
      "--token",
      token,
      "--as",
      "agent:claude",
      "--json",
      "--",
      ...childArgv(),
    ],
    elsewhere,
  );
  assert.equal(run.code, 1, run.stderr);
  const error = (JSON.parse(run.stderr.trim()) as Record<string, unknown>)["error"] as Record<
    string,
    unknown
  >;
  assert.equal(error["code"], "payload-mismatch");
  assertClean(unit.dir);
});

test("--payload-hash overrides the computation, and a malformed one is exit 2", () => {
  const unit = ready();
  const token = grantChaser(unit.dir);

  const bad = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--payload-hash",
      "NOTAHASH",
      "--as",
      "agent:claude",
      "--json",
      "--",
      ...childArgv(),
    ],
    unit.dir,
  );
  assert.equal(bad.code, 2, bad.stderr);
  assert.equal(
    ((JSON.parse(bad.stderr.trim()) as Record<string, unknown>)["error"] as Record<string, unknown>)[
      "code"
    ],
    "usage",
  );
  assert.equal(events(unit.dir).includes("execution.started"), false);

  // The override with the right value works: this is the adapter's door.
  const good = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--payload-hash",
      unit.binding,
      "--as",
      "agent:claude",
      "--",
      ...childArgv(),
    ],
    unit.dir,
  );
  assert.equal(good.code, 0, good.stderr);
  assertClean(unit.dir);
});

// ---------------------------------------------------------------------------
// execution resolve
// ---------------------------------------------------------------------------

/** A dangling execution: started, never closed, because the runtime "died". */
function danglingCase(): Case {
  const unit = ready();
  // `approval consume` starts a manual execution and returns; nothing closes
  // it, which is exactly the state a crash after execution.started leaves.
  const token = grantChaser(unit.dir);
  const consumed = runCli(
    [
      "consume",
      "task-042:chaser",
      "--token",
      token,
      "--payload-hash",
      unit.binding,
      "--as",
      "agent:claude",
    ],
    unit.dir,
  );
  assert.equal(consumed.code, 0, consumed.stderr);
  const status = runCli(["status", "--json"], unit.dir);
  const dangling = (JSON.parse(status.stdout) as Record<string, unknown>)["dangling"] as unknown[];
  assert.equal(dangling.length, 1, "the fixture did not produce a dangling execution");
  return unit;
}

test("resolve records a human observation: exit_code null, attested_by_human true", () => {
  const unit = danglingCase();
  const run = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "checked the mail server logs: the message went out at 09:14",
      "--as",
      "human:carter",
      "--json",
    ],
    unit.dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    action_key: "task-042:chaser",
    task: "task-042",
    event: "execution.completed",
    outcome: "completed",
    seq: 6,
    attested_by_human: true,
    actor: "human:carter",
  });

  const closed = logRecords(unit.dir)[5] as Record<string, unknown>;
  assert.equal(closed["event"], "execution.completed");
  assert.equal(closed["actor"], "human:carter");
  assert.deepEqual(closed["payload"], {
    note: "checked the mail server logs: the message went out at 09:14",
    attested_by_human: true,
    // NOT 0, and not 127: nobody ran anything, so there is no code to report.
    exit_code: null,
  });

  // The dangling execution is gone from status.
  const status = runCli(["status", "--json"], unit.dir);
  assert.deepEqual((JSON.parse(status.stdout) as Record<string, unknown>)["dangling"], []);
  assertClean(unit.dir);
});

test("resolve --outcome failed records execution.failed the same way", () => {
  const unit = danglingCase();
  const run = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "failed",
      "--note",
      "no message in the outbox; the process died before the send",
      "--as",
      "human:carter",
    ],
    unit.dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /resolved task-042:chaser as failed/u);
  assert.equal(events(unit.dir).at(-1), "execution.failed");
  assertClean(unit.dir);
});

test("the note is MANDATORY and non-empty — both are exit 2, log untouched", () => {
  const unit = danglingCase();
  const before = events(unit.dir);

  for (const args of [
    ["execution", "resolve", "task-042:chaser", "--outcome", "completed", "--as", "human:carter"],
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "   ",
      "--as",
      "human:carter",
    ],
  ]) {
    const run = runCli([...args, "--json"], unit.dir);
    assert.equal(run.code, 2, `expected a usage error for ${JSON.stringify(args)}`);
    assert.equal(
      ((JSON.parse(run.stderr.trim()) as Record<string, unknown>)["error"] as Record<
        string,
        unknown
      >)["code"],
      "usage",
    );
    assert.match(run.stderr, /observation/u);
  }
  assert.deepEqual(events(unit.dir), before);
});

test("resolve is human-only: an agent actor is exit 2 and nothing is appended", () => {
  const unit = danglingCase();
  const before = events(unit.dir);

  const agent = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "trust me",
      "--as",
      "agent:claude",
      "--json",
    ],
    unit.dir,
  );
  assert.equal(agent.code, 2, agent.stderr);
  assert.match(agent.stderr, /human/u);

  // …and with no identity at all.
  const anonymous = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "I saw it",
      "--json",
    ],
    unit.dir,
  );
  assert.equal(anonymous.code, 2, anonymous.stderr);
  assert.match(anonymous.stderr, /APPROVAL_HUMAN/u);
  assert.deepEqual(events(unit.dir), before);
});

test("APPROVAL_HUMAN supplies the observing human when --as is absent", () => {
  const unit = danglingCase();
  const run = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "saw it in the sent folder",
      "--json",
    ],
    unit.dir,
    { APPROVAL_HUMAN: "human:carter" },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["actor"], "human:carter");
  assertClean(unit.dir);
});

test("--outcome is required and closed: anything else is exit 2", () => {
  const unit = danglingCase();
  const before = events(unit.dir);

  for (const args of [
    ["execution", "resolve", "task-042:chaser", "--note", "x", "--as", "human:carter"],
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "probably-fine",
      "--note",
      "x",
      "--as",
      "human:carter",
    ],
  ]) {
    assert.equal(runCli(args, unit.dir).code, 2, JSON.stringify(args));
  }
  assert.deepEqual(events(unit.dir), before);
});

test("resolve refuses at exit 1 when there is no dangling execution to close", () => {
  const unit = ready();
  const notStarted = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "nothing happened",
      "--as",
      "human:carter",
      "--json",
    ],
    unit.dir,
  );
  assert.equal(notStarted.code, 1, notStarted.stderr);
  assert.equal(
    ((JSON.parse(notStarted.stderr.trim()) as Record<string, unknown>)["error"] as Record<
      string,
      unknown
    >)["code"],
    "not-started",
  );

  // An execution that already has an outcome is `already-finished`.
  dangling(unit.dir);
  const twice = runCli(
    [
      "execution",
      "resolve",
      "task-042:draft",
      "--outcome",
      "completed",
      "--note",
      "already closed by run",
      "--as",
      "human:carter",
      "--json",
    ],
    unit.dir,
  );
  assert.equal(twice.code, 1, twice.stderr);
  assert.equal(
    ((JSON.parse(twice.stderr.trim()) as Record<string, unknown>)["error"] as Record<
      string,
      unknown
    >)["code"],
    "already-finished",
  );
  assertClean(unit.dir);
});

test("resolve needs NO attested policy: it exercises no policy authority", () => {
  const unit = danglingCase();
  // Edit the policy after the fact: every gated verb now refuses.
  writeFileSync(join(unit.dir, "APPROVAL.md"), `${POLICY}\n<!-- edited -->\n`, "utf8");
  const gated = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    unit.dir,
  );
  assert.equal(gated.code, 1);
  assert.match(gated.stderr, /policy-not-attested/u);

  // Recovery is not gated on it: a dangling execution left unclosable because a
  // file changed afterwards would be a repair blocked by an unrelated fact.
  const resolved = runCli(
    [
      "execution",
      "resolve",
      "task-042:chaser",
      "--outcome",
      "completed",
      "--note",
      "the send completed before the crash",
      "--as",
      "human:carter",
    ],
    unit.dir,
  );
  assert.equal(resolved.code, 0, resolved.stderr);
  assertClean(unit.dir);
});

test("`approval execution` alone, and an unknown subcommand, are usage errors", () => {
  const unit = ready();
  assert.equal(runCli(["execution"], unit.dir).code, 2);
  assert.equal(runCli(["execution", "reconcile"], unit.dir).code, 2);
  assert.equal(runCli(["execution", "--help"], unit.dir).code, 0);
  const help = runCli(["execution", "resolve", "--help"], unit.dir);
  assert.equal(help.code, 0);
  // The reason no attestation is required is in the help, not only in the code.
  assert.match(help.stdout, /NO ATTESTATION IS REQUIRED/u);
  assert.match(help.stdout, /exercises no policy authority/u);
});
