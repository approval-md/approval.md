/**
 * `approval daemon run --git-evidence` — SPEC.md §8's optional hardening (APRV-42).
 *
 * The claim under test is not "the daemon can run git". It is that there are
 * **two independent evidence layers**, that they are independent, and that the
 * opt-in refuses every layout in which the second layer would be evidence its
 * own subject can rewrite.
 *
 * So the cases here split three ways:
 *
 * - the refusals, one per distinct precondition, checked as machine-readable
 *   codes and exit codes rather than as message text;
 * - the commits, checked against `git log` in a real repository — message,
 *   identity, batching, idempotence;
 * - the tamper demonstration, which mutates a committed log line in place and
 *   asserts that **both** layers notice: `approval log verify` fails on the
 *   chain, and `git status` reports the file as modified against HEAD.
 *
 * Every log is built through the real CLI verbs; nothing here fabricates a
 * record. The one mutation is the tamper case's, which is the point of it, and
 * it happens in a temp directory that no part of this repository's own log
 * shares. No git command in this file is run anywhere but inside those temp
 * repositories.
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

import {
  APPROVALD_VERSION,
  GIT_EVIDENCE_AUTHOR_EMAIL,
  GIT_EVIDENCE_AUTHOR_NAME,
  GIT_EVIDENCE_REFUSAL_CODES,
  evidenceRootFor,
} from "../src/daemon/git-evidence.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-evidence-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------

const PAYLOAD_HASH = "3".repeat(64);

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
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "```",
  "",
].join("\n");

const TASK = [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: example-capture",
  '    created_by: "human:carter"',
  "  state: proposed",
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
  "---",
  "",
  "## Description",
  "Body.",
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
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** git, inside a temp repository and nowhere else. */
function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `git failed to run: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

/** A case directory with a policy, a task file, and no git repository at all. */
function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(dir, "backlog", "tasks", "task-042.md"), TASK, "utf8");
  return dir;
}

/** Attested policy, registered task: the state every case starts from. */
function ready(): string {
  const dir = caseDir();
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

/** `git init` in the log's evidence root — the standalone log deployment. */
function initEvidenceRepo(dir: string): string {
  const root = evidenceRootFor(logPath(dir));
  mkdirSync(root, { recursive: true });
  assert.equal(git(["init", "--initial-branch=main"], root).code, 0);
  return root;
}

function daemonOnce(dir: string, extra: string[] = []): { run: Run; lines: Record<string, unknown>[] } {
  const run = runCli(["daemon", "run", "--once", "--json", ...extra], dir);
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { run, lines };
}

function errorOf(run: Run): Record<string, unknown> {
  const line = run.stderr
    .split("\n")
    .filter((text) => text.trim().startsWith("{"))
    .at(-1);
  assert.ok(line !== undefined, `no JSON error on stderr: ${run.stderr}`);
  return (JSON.parse(line) as { error: Record<string, unknown> }).error;
}

function records(dir: string): Record<string, unknown>[] {
  if (!existsSync(logPath(dir))) return [];
  return readFileSync(logPath(dir), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function commitCount(root: string): number {
  const run = git(["rev-list", "--count", "--all", "HEAD"], root);
  if (run.code !== 0) return 0;
  return Number(run.stdout.trim());
}

// ===========================================================================
// The frozen vocabulary
// ===========================================================================

test("the git-evidence refusal codes are the frozen union, in order", () => {
  assert.deepEqual(
    [...GIT_EVIDENCE_REFUSAL_CODES],
    ["git-unavailable", "log-dir-missing", "log-dir-not-repo", "log-dir-nested"],
    "GIT_EVIDENCE_REFUSAL_CODES is a frozen, additive-only union: an operator's supervisor branches on these to tell `install git` apart from `your layout is wrong`. Codes may be appended; none may be renamed or repurposed.",
  );
});

test("the daemon's git identity is pinned to the package version", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(
    APPROVALD_VERSION,
    pkg.version,
    "APPROVALD_VERSION is stamped into every evidence commit's author name. It is a constant rather than a runtime read of package.json, so this test is what keeps the two honest.",
  );
  assert.equal(GIT_EVIDENCE_AUTHOR_NAME, `approvald ${pkg.version}`);
  assert.equal(GIT_EVIDENCE_AUTHOR_EMAIL, "approvald@noreply.approval.md");
});

test("the evidence root is the log's home, so the payload store is inside it", () => {
  assert.equal(evidenceRootFor("/srv/.approval/log/events.jsonl"), "/srv/.approval");
  assert.equal(evidenceRootFor("/srv/logs/events.jsonl"), "/srv/logs");
});

// ===========================================================================
// Preconditions (AC #2)
// ===========================================================================

test("refusal: the log home is not a git repository", () => {
  const dir = ready();
  request(dir, "task-042:chaser");

  const { run } = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(run.code, 2, run.stderr);
  const error = errorOf(run);
  assert.equal(error["code"], "log-dir-not-repo");
  assert.match(String(error["message"]), /git init/u);

  // Nothing was appended and nothing was committed on the way out.
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

test("refusal: the log home is inside an outer working tree", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  // The project-repository shape: an outer repo tracks .approval/ and the log
  // home is not a root of its own. This is exactly this project's dogfood
  // layout, and it is refused.
  assert.equal(git(["init", "--initial-branch=main"], dir).code, 0);

  const { run } = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(run.code, 2, run.stderr);
  const error = errorOf(run);
  assert.equal(error["code"], "log-dir-nested");
  assert.match(String(error["message"]), /merge/u);
});

test("refusal: an own-root log repository nested inside an outer working tree", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  // Both are repositories now: `git rev-parse` inside the log home answers with
  // the log home itself, so only the parent reveals the containment. Refused
  // anyway — an outer repository still relocates and rewrites what it contains.
  const root = initEvidenceRepo(dir);
  assert.equal(git(["init", "--initial-branch=main"], dir).code, 0);

  const { run } = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(run.code, 2, run.stderr);
  assert.equal(errorOf(run)["code"], "log-dir-nested");
  assert.equal(commitCount(root), 0, "a refused daemon committed something anyway");
});

test("refusal: the log home does not exist", () => {
  const dir = ready();
  const { run } = daemonOnce(dir, [
    "--git-evidence",
    "--log",
    join(dir, "nowhere", "log", "events.jsonl"),
  ]);
  assert.equal(run.code, 4, run.stderr);
  assert.equal(errorOf(run)["code"], "log-dir-missing");
});

// ===========================================================================
// Disabled by default (AC #4)
// ===========================================================================

test("without the flag the daemon touches no git repository at all", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  const root = initEvidenceRepo(dir);

  const before = records(dir).length;
  const { run } = daemonOnce(dir);
  assert.equal(run.code, 0, run.stderr);

  assert.equal(
    commitCount(root),
    0,
    "a daemon without --git-evidence committed to the log repository; the opt-in is the only thing that may",
  );
  assert.ok(
    git(["status", "--porcelain", "--untracked-files=all"], root).stdout.includes("events.jsonl"),
    "the log should be sitting uncommitted in the repository nobody was asked to use",
  );
  assert.ok(records(dir).length >= before);
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

test("the daemon's own output is unchanged by the opt-in being absent", () => {
  // Two identical deployments, one with a repository in the log home and one
  // without, produce the same daemon narrative: git evidence adds lines only
  // when it is asked for.
  const plain = ready();
  request(plain, "task-042:chaser");
  const repo = ready();
  request(repo, "task-042:chaser");
  initEvidenceRepo(repo);

  const a = daemonOnce(plain).lines.map((line) => line["event"]);
  const b = daemonOnce(repo).lines.map((line) => line["event"]);
  assert.deepEqual(b, a);
  assert.ok(!a.includes("git_evidence"));
});

// ===========================================================================
// Commits (AC #1)
// ===========================================================================

test("each committing tick names the verified head and is authored by the daemon", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  const root = initEvidenceRepo(dir);

  const { run, lines } = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(run.code, 0, run.stderr);

  const evidence = lines.find((line) => line["event"] === "git_evidence");
  assert.ok(evidence !== undefined, `no git_evidence line: ${run.stdout}\n${run.stderr}`);

  const all = records(dir);
  const head = all.at(-1) as Record<string, unknown>;
  assert.equal(evidence["seq"], head["seq"]);
  assert.equal(evidence["hash"], head["hash"]);
  assert.equal(
    evidence["records"],
    all.length,
    "the first commit covers every record in the log as it stands",
  );

  assert.equal(commitCount(root), 1);
  const subject = git(["log", "-1", "--pretty=%s"], root).stdout.trim();
  assert.equal(subject, `seq ${String(head["seq"])} sha256:${String(head["hash"])}`);

  const who = git(["log", "-1", "--pretty=%an%n%ae%n%cn%n%ce"], root).stdout.trim().split("\n");
  assert.deepEqual(who, [
    GIT_EVIDENCE_AUTHOR_NAME,
    GIT_EVIDENCE_AUTHOR_EMAIL,
    GIT_EVIDENCE_AUTHOR_NAME,
    GIT_EVIDENCE_AUTHOR_EMAIL,
  ]);

  // The log itself is committed, not merely present.
  const tracked = git(["ls-files"], root).stdout;
  assert.match(tracked, /log\/events\.jsonl/u);
  assert.equal(
    git(["status", "--porcelain", "--", "log/events.jsonl"], root).stdout.trim(),
    "",
    "the log should be clean against HEAD immediately after an evidence commit",
  );
  // QUEUE.md is a projection, rewritten every tick, and is deliberately NOT
  // committed: witnessing a derived file would fill the evidence history with
  // TTL countdowns and prove nothing the log does not already prove.
  assert.ok(
    !git(["ls-files"], root).stdout.includes("QUEUE.md"),
    "the queue projection was committed; only the log and the payload store are evidence",
  );
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

test("one commit per tick, covering every record the tick observed, and none when nothing moved", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  const root = initEvidenceRepo(dir);

  // First tick: the baseline commit.
  assert.equal(daemonOnce(dir, ["--git-evidence"]).run.code, 0);
  assert.equal(commitCount(root), 1);
  const baseline = records(dir).length;

  // Two appends land between ticks. The batching choice is one commit per tick,
  // and the message reports how many records that commit covers.
  request(dir, "task-042:followup");
  assert.equal(runCli(["grant", "task-042:chaser", "--as", "human:carter"], dir).code, 0);

  const second = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(second.run.code, 0, second.run.stderr);
  assert.equal(commitCount(root), 2, "a tick that observed two appends made one commit");

  const evidence = second.lines.find((line) => line["event"] === "git_evidence");
  assert.ok(evidence !== undefined, second.run.stdout);
  const all = records(dir);
  assert.equal(evidence["seq"], (all.at(-1) as Record<string, unknown>)["seq"]);
  assert.equal(
    evidence["records"],
    all.length - baseline,
    "the batch size is counted from git, so it survives the daemon restart between ticks",
  );
  assert.match(
    git(["log", "-1", "--pretty=%B"], root).stdout,
    /record\(s\) since the previous commit/u,
  );

  // A tick with nothing new commits nothing: the head has already been witnessed.
  const third = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(third.run.code, 0, third.run.stderr);
  assert.equal(commitCount(root), 2);
  assert.equal(third.lines.filter((line) => line["event"] === "git_evidence").length, 0);
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

// ===========================================================================
// Two layers, independently (AC #3)
// ===========================================================================

test("tamper: rewriting a committed log line fails the chain AND diverges from git", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  request(dir, "task-042:followup");
  const root = initEvidenceRepo(dir);

  assert.equal(daemonOnce(dir, ["--git-evidence"]).run.code, 0);
  assert.equal(commitCount(root), 1);
  const committed = git(["rev-parse", "HEAD"], root).stdout.trim();

  // The mutation an attacker with write access would make: an existing record
  // edited in place, leaving a well-formed JSONL file of the same shape. Not an
  // append — the chain is what makes appends detectable, and the interesting
  // case is the one that tries to change history.
  const lines = readFileSync(logPath(dir), "utf8").split("\n");
  const target = lines.findIndex((line) => line.includes('"approval.requested"'));
  assert.ok(target > 0, "no requested record to tamper with");
  lines[target] = (lines[target] as string).replace("agent:claude", "agent:mallory");
  writeFileSync(logPath(dir), lines.join("\n"), "utf8");

  // Layer one: the hash chain. `approval log verify` never consults git.
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 1, `the chain accepted a rewritten record: ${verify.stdout}`);
  assert.notEqual(
    (JSON.parse(verify.stdout) as Record<string, unknown>)["status"],
    "clean",
    "log verify reported a tampered log as clean",
  );

  // Layer two: git. Independent of the chain — it compares bytes against a
  // commit, and would notice even a mutation that somehow re-hashed cleanly.
  const status = git(["status", "--porcelain"], root).stdout;
  assert.match(status, /M.*log\/events\.jsonl/u, `git saw no divergence: ${status}`);
  const diff = git(["diff", "--stat", "HEAD", "--", "log/events.jsonl"], root).stdout;
  assert.match(diff, /events\.jsonl/u, "git diff against HEAD showed no change");
  assert.match(
    git(["diff", "HEAD", "--", "log/events.jsonl"], root).stdout,
    /agent:mallory/u,
    "the diff should name the substituted actor",
  );

  // And the commit that witnessed the pre-tamper bytes is still there to be
  // cloned, mirrored, and diffed from somewhere the tamperer does not control.
  assert.equal(git(["rev-parse", "HEAD"], root).stdout.trim(), committed);
  assert.match(
    git(["show", `${committed}:log/events.jsonl`], root).stdout,
    /agent:claude/u,
    "the committed copy no longer holds the original record",
  );
});

test("a daemon whose git evidence fails keeps running and keeps the log clean", () => {
  const dir = ready();
  request(dir, "task-042:chaser");
  const root = initEvidenceRepo(dir);
  assert.equal(daemonOnce(dir, ["--git-evidence"]).run.code, 0);

  // Break the repository under the daemon's feet, the way a crashed `git` or a
  // concurrent operator command would: a stale index.lock leaves the repository
  // perfectly valid to inspect and impossible to stage into. Git evidence is
  // hardening on top of the chain; losing it must not stop approvals.
  writeFileSync(join(root, ".git", "index.lock"), "", "utf8");
  request(dir, "task-042:followup");

  const { run, lines } = daemonOnce(dir, ["--git-evidence"]);
  assert.equal(run.code, 0, `a git failure stopped the daemon: ${run.stderr}`);
  assert.ok(lines.some((line) => line["event"] === "tick"));
  assert.match(run.stderr, /git_evidence_failed/u, run.stderr);
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});
