/**
 * `approval policy amend` end-to-end tests (APRV-30).
 *
 * Every case spawns the real compiled CLI as a child process, and the cases that
 * need a baseline build a real temporary git repository and drive it with real
 * `git` — the baseline-recovery design turns on what `git show HEAD:<path>`
 * actually returns, and a fake would test the fake.
 *
 * Two of these tests are the incidents the verb was written for:
 * "the seq-2 shape" (an edit that does not load: the advisory says so, a plain
 * amend still attests, and --require-load refuses without touching the log) and
 * "the interregnum" (--commit lands the policy edit and its attestation as one
 * commit carrying exactly two files).
 *
 * Nothing here writes a log line by hand; every record is produced by the CLI,
 * and log bytes are compared before/after for the cases that must write nothing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/cli-amend.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-amend-")));
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

function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `git failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function policyText(body: string[]): string {
  return ["# Policy", "", "```yaml approval-policy", ...body, "```", ""].join("\n");
}

const BEFORE = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "approvers:",
  "  carter:",
  "    channels: [cli]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
]);

/** The same policy with three edits: class autonomy, approver channels, TTL. */
const AFTER = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 1h",
  "approvers:",
  "  carter:",
  "    channels: [cli, telegram]",
  "classes:",
  "  read.*:",
  "    autonomy: manual",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
]);

/** The seq-2 shape: an edit whose YAML is fine and whose schema is not. */
const BROKEN = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: whenever",
]);

function caseDir(text: string = BEFORE): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  return dir;
}

/** A git repository with the policy committed, so HEAD carries a baseline. */
function repoDir(text: string = BEFORE): string {
  const dir = caseDir(text);
  git(["init", "-q", "."], dir);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "policy"], dir);
  return dir;
}

function logPathIn(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function rawLog(dir: string): string {
  const path = logPathIn(dir);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function logRecords(dir: string): Record<string, unknown>[] {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The payload of the Nth logged record, as an object. */
function payloadAt(dir: string, index: number): Record<string, unknown> {
  const record = logRecords(dir)[index];
  assert.notEqual(record, undefined, `expected a record at index ${index}`);
  return (record as Record<string, unknown>)["payload"] as Record<string, unknown>;
}

function writePolicy(dir: string, text: string): void {
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
}

/** Attest the policy as it stands, so an amendment has a baseline to move from. */
function attest(dir: string): void {
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
}

function report(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function errorOf(run: Run): { code: string; message: string } {
  return (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error;
}

// ---------------------------------------------------------------------------
// (a) The no-op ceremony
// ---------------------------------------------------------------------------

test("an already-attested policy is nothing to amend, and that is a success", () => {
  const dir = caseDir();
  attest(dir);
  const before = rawLog(dir);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /nothing to amend/u);
  assert.match(run.stdout, /already matches its attestation at seq 1/u);
  assert.equal(rawLog(dir), before, "the no-op ceremony wrote to the log");
});

test("the no-op --json report carries every frozen key", () => {
  const dir = caseDir();
  attest(dir);
  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);

  assert.equal(run.code, 0);
  const parsed = report(run);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "aborted",
    "attestation",
    "attested",
    "baseline",
    "diff",
    "dryRun",
    "git",
    "liveSha256",
    "load",
    "noop",
    "ok",
    "policy",
  ]);
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["noop"], true);
  assert.equal(parsed["diff"], null);
  assert.equal(parsed["attestation"], null);
  assert.deepEqual(parsed["attested"], {
    sha256: payloadAt(dir, 0)["sha256"],
    seq: 1,
  });
});

// ---------------------------------------------------------------------------
// (b) Baseline recovery, and its stated limits
// ---------------------------------------------------------------------------

test("outside a git repository the diff is unavailable and the notice says why", () => {
  const dir = caseDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /HASH-ONLY MODE: no semantic diff/u);
  assert.match(run.stdout, /not inside a git repository/u);
  assert.match(run.stdout, /not recoverable from the log/u);
  // Hash-only mode still attests: the ceremony degrades, it does not stop.
  assert.equal(logRecords(dir).length, 2);
});

test("a never-attested policy has no baseline and says so", () => {
  const dir = repoDir();
  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);

  assert.equal(run.code, 0);
  const parsed = report(run);
  assert.deepEqual(parsed["baseline"], {
    mode: "unavailable",
    reason: "the policy has never been attested, so there is no previous state to diff against",
  });
  assert.equal(parsed["diff"], null);
  assert.equal(parsed["attested"], null);
});

test("a HEAD blob that is not the attested bytes is refused as a baseline", () => {
  const dir = repoDir();
  // Attest a working-tree edit that was never committed: HEAD no longer carries
  // the attested bytes, so it cannot be used to prove what was signed for.
  writePolicy(dir, AFTER);
  attest(dir);
  writePolicy(dir, BEFORE);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);

  assert.equal(run.code, 0);
  const baseline = report(run)["baseline"] as { mode: string; reason: string };
  assert.equal(baseline.mode, "unavailable");
  assert.match(baseline.reason, /which is not the attested/u);
  assert.equal(report(run)["diff"], null);
});

// ---------------------------------------------------------------------------
// (c) The semantic diff
// ---------------------------------------------------------------------------

test("in a git repo the diff names the class, approver and TTL changes", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = report(run);
  assert.deepEqual(parsed["baseline"], { mode: "git-head", reason: null });

  const diff = parsed["diff"] as Record<string, unknown>;
  assert.equal(diff["structuralComparable"], true);
  assert.equal(diff["unchanged"], false);
  assert.deepEqual(diff["classes"], [
    {
      class: "read.*",
      before: { autonomy: "autonomous", provenance: "rule", pattern: "read.*" },
      after: { autonomy: "manual", provenance: "rule", pattern: "read.*" },
    },
  ]);
  assert.deepEqual(diff["approvers"], [
    {
      approver: "carter",
      change: "channels-changed",
      beforeChannels: ["cli"],
      afterChannels: ["cli", "telegram"],
      danglingRules: [],
    },
  ]);
  assert.deepEqual(diff["defaults"], [
    { field: "approval_ttl", before: "24h", after: "1h" },
  ]);
  assert.deepEqual(diff["budgets"], []);
  // The probe set is stated, and it carries SPEC §7's namespaces.
  assert.equal((diff["probes"] as string[]).includes("financial.*"), true);
  assert.equal((diff["probes"] as string[]).includes("read.*"), true);
});

test("the human diff renders each section, and a budget change is a limit line", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER.replace("daily_usd: 10", "daily_usd: 25"));

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /class resolutions changed \(1\):/u);
  assert.match(run.stdout, /read\.\*: autonomous \(rule read\.\*\) -> manual \(rule read\.\*\)/u);
  assert.match(run.stdout, /carter: channels-changed \[cli\] -> \[cli, telegram\]/u);
  assert.match(run.stdout, /approval_ttl: 24h -> 1h/u);
  assert.match(run.stdout, /global\.daily_usd: 10 -> 25/u);
  assert.match(run.stdout, /load advisory: loads clean/u);
});

test("an approver deleted while a rule still names them is reported unreachable", () => {
  const dir = repoDir();
  attest(dir);
  // Delete the approver entry, leaving communicate.* naming a decider the
  // policy no longer defines. The schema permits this: it says the
  // rule-to-approver cross-reference is a runtime check.
  writePolicy(dir, BEFORE.replace("approvers:\n  carter:\n    channels: [cli]\n", ""));

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  assert.deepEqual(diff["approvers"], [
    {
      approver: "carter",
      change: "removed",
      beforeChannels: ["cli"],
      afterChannels: null,
      danglingRules: ["communicate.*"],
    },
  ]);

  // And the human rendering says it in words, in a repo of its own (the one
  // above has already been amended, so it would now be a no-op).
  const human = repoDir();
  attest(human);
  writePolicy(human, BEFORE.replace("approvers:\n  carter:\n    channels: [cli]\n", ""));
  const rendered = runCli(["policy", "amend", "--as", "human:carter", "--yes"], human);
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.match(rendered.stdout, /UNREACHABLE: still named by communicate\.\*/u);
});

test("a class that stops being named falls to defaults, and the diff says so", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(
    dir,
    policyText([
      'version: "0.1"',
      "defaults:",
      "  autonomy: supervised",
      "  approval_ttl: 24h",
      "approvers:",
      "  carter:",
      "    channels: [cli]",
      "budgets:",
      "  global:",
      "    daily_usd: 10",
    ]),
  );

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  assert.deepEqual(diff["classes"], [
    {
      class: "communicate.*",
      before: { autonomy: "manual", provenance: "rule", pattern: "communicate.*" },
      after: { autonomy: "supervised", provenance: "default", pattern: null },
    },
    {
      class: "read.*",
      before: { autonomy: "autonomous", provenance: "rule", pattern: "read.*" },
      after: { autonomy: "supervised", provenance: "default", pattern: null },
    },
  ]);
});

// ---------------------------------------------------------------------------
// (d) The seq-2 shape: an edit that does not load
// ---------------------------------------------------------------------------

test("the seq-2 shape: the advisory names the failure and a plain amend still attests", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, BROKEN);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /LOAD ADVISORY — THIS POLICY DOES NOT LOAD \(schema-invalid\)/u);
  assert.match(run.stdout, /FAIL CLOSED to all-manual/u);
  // The diff is honest about what the broken side means for every class.
  assert.match(run.stdout, /after: everything manual \(fail-closed: schema-invalid\)/u);
  // Bytes, not parse: attestation records what is on disk (see policy attest).
  assert.equal(logRecords(dir).length, 2);
  assert.equal(logRecords(dir)[1]?.["event"], "policy.updated");
});

test("--require-load refuses the same edit at exit 1 and appends nothing", () => {
  const dir = repoDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, BROKEN);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--require-load"],
    dir,
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /--require-load/u);
  assert.match(run.stderr, /schema-invalid/u);
  assert.equal(rawLog(dir), before, "--require-load appended to the log");
});

test("--require-load refuses in the frozen JSON shape", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, BROKEN);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--require-load", "--json"],
    dir,
  );

  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  const parsed = JSON.parse(run.stderr) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["error", "ok"]);
  assert.equal(parsed["ok"], false);
  assert.equal((parsed["error"] as Record<string, unknown>)["code"], "load-failed");
});

test("--require-load is silent when the policy loads", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--require-load"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(logRecords(dir).length, 2);
});

// ---------------------------------------------------------------------------
// (e) --dry-run and the confirmation
// ---------------------------------------------------------------------------

test("--dry-run reports everything and writes nothing", () => {
  const dir = repoDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--dry-run"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /class resolutions changed/u);
  assert.match(run.stdout, /--dry-run: nothing was attested, nothing was written/u);
  assert.match(run.stdout, /attested seq <seq>/u);
  assert.equal(rawLog(dir), before, "--dry-run wrote to the log");
  assert.equal(git(["status", "--porcelain", "--", "APPROVAL.md"], dir).stdout.includes("M"), true);
  // And no commit was made.
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "1");
});

test("--dry-run --json reports the diff with a null attestation", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--dry-run", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = report(run);
  assert.equal(parsed["dryRun"], true);
  assert.equal(parsed["attestation"], null);
  assert.notEqual(parsed["diff"], null);
  const gitPlan = parsed["git"] as Record<string, unknown>;
  assert.equal(gitPlan["committed"], false);
  assert.equal((gitPlan["commands"] as string[]).length, 2);
  assert.match((gitPlan["commands"] as string[])[1] as string, /attested seq <seq>/u);
});

test("without --yes and without a terminal the verb refuses rather than assuming", () => {
  const dir = repoDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter"], dir);

  assert.equal(run.code, 2);
  assert.match(run.stderr, /stdin is not a terminal/u);
  assert.match(run.stderr, /--yes/u);
  assert.match(run.stderr, /--dry-run/u);
  assert.equal(rawLog(dir), before);
});

test("--json without --yes is a usage refusal in JSON", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(errorOf(run).code, "usage");
});

// ---------------------------------------------------------------------------
// (g) The git ceremony
// ---------------------------------------------------------------------------

test("--commit lands exactly the policy and the log in one commit citing the seq", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--commit"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "3");
  const subject = git(["log", "-1", "--pretty=%s"], dir).stdout.trim();
  assert.match(subject, /^Policy: amend APPROVAL\.md.*\(attested seq 2\)$/u);
  const files = git(["show", "--name-only", "--pretty=format:", "HEAD"], dir)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  assert.deepEqual(files, [".approval/log/events.jsonl", "APPROVAL.md"]);
  // The tree is clean afterwards: the amendment left nothing behind.
  assert.equal(git(["status", "--porcelain"], dir).stdout.trim(), "");
});

test("--commit --json reports committed:true and the commands it ran", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["repo"], true);
  assert.equal(gitPlan["committed"], true);
  assert.match((gitPlan["commands"] as string[])[1] as string, /attested seq 2/u);
  assert.deepEqual(report(run)["attestation"], {
    seq: 2,
    sha256: payloadAt(dir, 1)["sha256"],
  });
});

test("--commit outside a git repository refuses BEFORE attesting", () => {
  const dir = caseDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );

  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "commit-preconditions");
  assert.match(errorOf(run).message, /nothing was attested/u);
  assert.equal(rawLog(dir), before);
});

test("--commit refuses a staged change beyond the two files, and attests nothing", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);
  writeFileSync(join(dir, "unrelated.txt"), "staged\n", "utf8");
  git(["add", "unrelated.txt"], dir);
  const before = rawLog(dir);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );

  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "commit-preconditions");
  assert.match(errorOf(run).message, /unrelated\.txt/u);
  assert.equal(rawLog(dir), before);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "2");
});

test("without --commit the two commands are printed for the human to run", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /git add .*APPROVAL\.md .*events\.jsonl/u);
  assert.match(run.stdout, /git commit -m "Policy: .*\(attested seq 2\)"/u);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "1");
});

// ---------------------------------------------------------------------------
// Identity (exit 2) and other usage
// ---------------------------------------------------------------------------

test("no declared identity is a usage error naming both ways to declare one", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--yes"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /APPROVAL_HUMAN=human:<id>/u);
  assert.equal(logRecords(dir).length, 1);
});

test("an agent actor cannot amend", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "agent:planner", "--yes"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /an agent must not perform/u);
  assert.equal(logRecords(dir).length, 1);
});

test("APPROVAL_HUMAN supplies the identity, as it does for attest", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--yes"], dir, { APPROVAL_HUMAN: "human:from-env" });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(logRecords(dir)[1]?.["actor"], "human:from-env");
});

test("an unknown flag and a stray positional are usage errors", () => {
  const dir = repoDir();
  assert.equal(runCli(["policy", "amend", "--as", "human:carter", "--nope"], dir).code, 2);
  assert.equal(
    runCli(["policy", "amend", "--as", "human:carter", "--yes", "read.web"], dir).code,
    2,
  );
  assert.deepEqual(logRecords(dir), []);
});

test("an absent policy file is an I/O error, not an amendment", () => {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 4);
  assert.equal(errorOf(run).code, "io");
  assert.match(errorOf(run).message, /no policy file found/u);
});

test("the appended amendment leaves the chain clean", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);
  assert.equal(runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir).code, 0);

  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0);
  const parsed = JSON.parse(verify.stdout) as Record<string, unknown>;
  assert.equal(parsed["status"], "clean");
  assert.equal(parsed["records"], 2);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("the help states the baseline limitation, the flags, and the refusal codes", () => {
  const dir = caseDir();
  const run = runCli(["policy", "amend", "--help"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /BASELINE/u);
  assert.match(run.stdout, /NOT\s+recoverable from the log/u);
  assert.match(run.stdout, /HASH-ONLY MODE/u);
  assert.match(run.stdout, /--require-load/u);
  assert.match(run.stdout, /commit-preconditions/u);
  assert.match(run.stdout, /EXACTLY two files/u);
  assert.deepEqual(logRecords(dir), []);
});

test("policy --help and the root help both mention amend", () => {
  const dir = caseDir();
  assert.match(runCli(["policy", "--help"], dir).stdout, /amend/u);
  assert.match(runCli(["--help"], dir).stdout, /policy amend/u);
});
