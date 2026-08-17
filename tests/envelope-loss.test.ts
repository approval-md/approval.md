/**
 * Envelope loss: a task with log history whose file no longer has an envelope
 * (APRV-63) — the defense half of APRV-60.
 *
 * The reproduction is not invented here. `tests/fixtures/backlog/` holds the
 * same task file before and after the pinned Backlog.md CLI rewrote it
 * (APRV-65): the `after` bytes are what the tool actually produced, and what it
 * produced has no `approval:` key. Every case below registers the BEFORE bytes
 * through the real CLI and then swaps in the AFTER bytes, which is exactly the
 * sequence that happened to APRV-51 in the live repository — an ordinary board
 * edit, no corruption, no refusal, and an envelope simply gone.
 *
 * Three read points must notice, and they are asserted through the built CLI
 * rather than in process, because the claim is about what an operator sees:
 * `register` refuses with its own code, the daemon records `envelope.drift`
 * with `reason: "envelope-missing"` exactly once, and `doctor` lists the task.
 *
 * The fourth property is the one this task exists to protect: **nothing is
 * repaired**. The log holds every action the envelope declared, so a writer
 * could re-emit it; doing so would make a projection into a source. Every case
 * therefore asserts the task file is byte-identical afterwards, and that the
 * log still verifies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CORPUS = join(REPO_ROOT, "tests", "fixtures", "backlog");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-envelope-loss-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  delete env["APPROVAL_TG_TOKEN"];
  delete env["APPROVAL_TG_CHAT"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The single task file of one corpus scenario, as `[name, bytes]`. */
function fixture(scenario: string): { name: string; text: string } {
  const dir = join(CORPUS, scenario);
  const entries = readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort();
  const name = entries[0];
  assert.ok(name !== undefined, `no task file in the ${scenario} fixture`);
  return { name, text: readFileSync(join(dir, name), "utf8") };
}

const BEFORE = fixture("envelope-edit-before");
const AFTER = fixture("envelope-edit-after");

/** The board key the fixture declares — read from the fixture, never assumed. */
const TASK_ID = /^id:\s*(\S+)/mu.exec(BEFORE.text)?.[1] ?? "";

function taskPath(dir: string): string {
  return join(dir, "backlog", "tasks", BEFORE.name);
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

/** The `payload.reason` of the nth record in `list`, asserted to exist. */
function reasonOf(list: Record<string, unknown>[], index: number): unknown {
  const record = list[index];
  assert.ok(record !== undefined, `no record at index ${String(index)}`);
  return (record["payload"] as Record<string, unknown>)["reason"];
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

/** A working directory holding the BEFORE fixture, with the policy attested. */
function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  copyFileSync(join(CORPUS, "envelope-edit-before", BEFORE.name), taskPath(dir));
  const attested = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

/** Register the BEFORE file through the real gate. Returns the seq. */
function register(dir: string): number {
  const run = runCli(
    ["register", join("backlog", "tasks", BEFORE.name), "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  return (JSON.parse(run.stdout) as { seq: number }).seq;
}

/** What the pinned Backlog.md CLI did: rewrite the file without the envelope. */
function stripEnvelope(dir: string): void {
  writeFileSync(taskPath(dir), AFTER.text, "utf8");
}

/** One `--once` daemon pass, as JSON lines. */
function daemonOnce(dir: string): { run: Run; lines: Record<string, unknown>[] } {
  const run = runCli(["daemon", "run", "--once", "--json"], dir);
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { run, lines };
}

function refusalOf(run: Run): { code: string; message: string } {
  const parsed = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  return parsed.error;
}

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

test("the reproduction fixture is a real envelope loss", () => {
  assert.match(BEFORE.text, /^approval:/mu);
  assert.doesNotMatch(AFTER.text, /^approval:/mu);
  assert.match(AFTER.text, /^---$/mu);
  assert.notEqual(TASK_ID, "");
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

test("register: a stripped file whose task has log history is refused envelope-missing", () => {
  const dir = caseDir();
  const seq = register(dir);
  stripEnvelope(dir);
  const before = readFileSync(logPath(dir));

  const run = runCli(
    ["register", join("backlog", "tasks", BEFORE.name), "--as", "agent:claude", "--json"],
    dir,
  );

  // A gate refusal is exit 1: the command was well-formed and the answer is no.
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(run.stdout, "");
  const error = refusalOf(run);
  assert.equal(error.code, "envelope-missing");
  // The seq of the registration, so the human can go read what was declared.
  assert.match(error.message, new RegExp(`seq ${String(seq)}`, "u"));
  assert.match(error.message, /narrow the record/u);
  assert.match(error.message, /restore/iu);

  // Nothing appended, nothing rewritten.
  assert.deepEqual(readFileSync(logPath(dir)), before);
  assert.equal(readFileSync(taskPath(dir), "utf8"), AFTER.text);
  assertClean(dir);
});

test("register: the same refusal in human-readable form names the code", () => {
  const dir = caseDir();
  register(dir);
  stripEnvelope(dir);

  const run = runCli(["register", join("backlog", "tasks", BEFORE.name), "--as", "agent:claude"], dir);
  assert.equal(run.code, 1, run.stdout);
  assert.match(run.stderr, /^approval: envelope-missing: /u);
});

test("register: a file with no frontmatter at all is still recognised as a loss", () => {
  const dir = caseDir();
  const seq = register(dir);
  // Worse than the observed case: the whole frontmatter block is gone, so the
  // file leaves no id behind and only its Backlog.md name identifies it.
  writeFileSync(taskPath(dir), "## Description\n\nBody with no frontmatter.\n", "utf8");

  const run = runCli(
    ["register", join("backlog", "tasks", BEFORE.name), "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  const error = refusalOf(run);
  assert.equal(error.code, "envelope-missing");
  assert.match(error.message, /no frontmatter at all/u);
  assert.match(error.message, new RegExp(`seq ${String(seq)}`, "u"));
  assertClean(dir);
});

test("register: a file with no envelope and NO log history is unchanged behavior", () => {
  const dir = caseDir();
  // Never registered: SPEC.md §6 tolerates a task with no envelope, and this
  // task is one. The refusal is the one it has always been.
  stripEnvelope(dir);

  const run = runCli(
    ["register", join("backlog", "tasks", BEFORE.name), "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(refusalOf(run).code, "envelope-invalid");
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// the daemon
// ---------------------------------------------------------------------------

test("daemon: a stripped file appends envelope.drift with reason envelope-missing, once", () => {
  const dir = caseDir();
  const seq = register(dir);
  stripEnvelope(dir);

  const first = daemonOnce(dir);
  assert.equal(first.run.code, 0, first.run.stderr);
  const drift = first.lines.find((line) => line["event"] === "drift");
  assert.ok(drift !== undefined, `no drift line: ${first.run.stdout}`);
  assert.equal(drift["task"], TASK_ID);
  assert.equal(drift["declared_state"], null);
  assert.equal(drift["reason"], "envelope-missing");

  const appended = eventsOf(dir, "envelope.drift");
  assert.equal(appended.length, 1);
  const record = appended[0] as Record<string, unknown>;
  assert.equal(record["actor"], "system:daemon");
  assert.equal(record["task"], TASK_ID);
  const payload = record["payload"] as Record<string, unknown>;
  assert.equal(payload["reason"], "envelope-missing");
  assert.equal(payload["declared_state"], null);
  assert.equal(payload["derived_state"], "proposed");
  assert.equal(payload["registered"], true);
  assert.equal(payload["registered_seq"], seq);
  assert.equal(payload["missing"], "no-approval-key");
  // There is no envelope, so there is nothing to digest.
  assert.equal(payload["envelope_sha256"], undefined);

  // Re-derived every tick and appended once per episode: a second pass over an
  // unchanged file adds nothing.
  const second = daemonOnce(dir);
  assert.equal(second.run.code, 0, second.run.stderr);
  assert.equal(eventsOf(dir, "envelope.drift").length, 1);
  assert.equal(
    second.lines.find((line) => line["event"] === "drift"),
    undefined,
  );

  // The daemon never repairs the file.
  assert.equal(readFileSync(taskPath(dir), "utf8"), AFTER.text);
  assertClean(dir);
});

test("daemon: a state mismatch and an envelope loss are separate records", () => {
  const dir = caseDir();
  register(dir);

  // The BEFORE file claims `awaiting`; the log, with only a registration,
  // implies `proposed`. That is the original §6.3 drift.
  const mismatch = daemonOnce(dir);
  assert.equal(mismatch.run.code, 0, mismatch.run.stderr);
  const first = eventsOf(dir, "envelope.drift");
  assert.equal(first.length, 1);
  assert.equal(reasonOf(first, 0), "state-mismatch");

  // Now the envelope disappears. Same task, same derived state, different fact:
  // the dedupe key carries the reason, so the loss is not swallowed by the
  // mismatch already on record.
  stripEnvelope(dir);
  const loss = daemonOnce(dir);
  assert.equal(loss.run.code, 0, loss.run.stderr);
  const both = eventsOf(dir, "envelope.drift");
  assert.equal(both.length, 2);
  assert.equal(reasonOf(both, 1), "envelope-missing");

  assertClean(dir);
});

test("daemon: a file with no envelope and no log history is silent", () => {
  const dir = caseDir();
  stripEnvelope(dir);

  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(eventsOf(dir, "envelope.drift").length, 0);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function envelopeIntegrity(dir: string): {
  run: Run;
  check: { check: string; status: string; detail: string; fix?: string };
} {
  const run = runCli(["doctor", "--json"], dir);
  const parsed = JSON.parse(run.stdout) as {
    checks: Array<{ check: string; status: string; detail: string; fix?: string }>;
  };
  const check = parsed.checks.find((entry) => entry.check === "envelope-integrity");
  assert.ok(check !== undefined, `no envelope-integrity check: ${run.stdout}`);
  return { run, check };
}

test("doctor: envelope-integrity lists a task whose log history implies an envelope", () => {
  const dir = caseDir();
  const seq = register(dir);
  stripEnvelope(dir);
  const before = readFileSync(logPath(dir));

  const { run, check } = envelopeIntegrity(dir);
  assert.equal(check.status, "fail");
  assert.match(check.detail, new RegExp(TASK_ID, "u"));
  assert.match(check.detail, new RegExp(`seq ${String(seq)}`, "u"));
  assert.ok(check.fix !== undefined);
  assert.match(check.fix, /restore it from the log by hand/u);
  assert.match(check.fix, /docs\/dogfood-cutover\.md/u);
  assert.match(check.fix, /APRV-60/u);
  // A failing check means a failing run.
  assert.equal(run.code, 1, run.stdout);

  // doctor appends nothing, ever.
  assert.deepEqual(readFileSync(logPath(dir)), before);
  assertClean(dir);
});

test("doctor: envelope-integrity passes while the envelope is there", () => {
  const dir = caseDir();
  register(dir);

  const { check } = envelopeIntegrity(dir);
  assert.equal(check.status, "pass");
  assert.match(check.detail, /still carries its approval: envelope/u);
});

test("doctor: envelope-integrity skips when there is no task folder", () => {
  const dir = caseDir();
  rmSync(join(dir, "backlog"), { recursive: true, force: true });

  const { check } = envelopeIntegrity(dir);
  assert.equal(check.status, "skip");
  assert.match(check.detail, /no task folder/u);
});

test("doctor: an envelope-less task the log never registered is not a loss", () => {
  const dir = caseDir();
  stripEnvelope(dir);

  const { check } = envelopeIntegrity(dir);
  assert.equal(check.status, "pass");
});
