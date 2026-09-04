/**
 * The day's records branch when the trunk moves under it (APRV-234).
 *
 * ## The incident
 *
 * 2026-09-02. `records-log-2026-09-02` (PR #240) was opened by the daemon's
 * cadence advance. Then the seq 13704 ceremony commit landed on main carrying
 * its own copy of the log, and the branch no longer contained the trunk. The
 * daemon went on stacking advance commits on the branch tip — 13986, 13990,
 * 13994, 13997, 14002, 14006 — each of them built on a base that was missing
 * main's copy, so the pull request went DIRTY and stayed DIRTY until the
 * orchestrator merged it by hand with `git merge -X ours origin/main`. (`-X
 * theirs` truncates the log: git's "theirs" is the branch being merged IN.)
 *
 * APRV-203 had already made the ceremony verbs build their commit on the remote
 * tip through a scratch index; the same-day reuse of an existing branch went
 * around it. These cases pin the repair: the branch is REBUILT on the current
 * trunk rather than stacked, the working log is a superset of the trunk's or
 * nothing is pushed, and both the daemon's event stream and the doctor row say
 * that it happened and on what.
 *
 * Real git throughout, with a bare remote; `gh` is stubbed because it is the
 * one thing that would reach the network. No log line is written by hand.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { lastAdvance } from "../src/core/advance-cycle.js";
import { register } from "../src/core/gate.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { commandDoctor } from "../src/cli/doctor.js";
import { logAdvance, type LogAdvanceReport } from "../src/cli/log-advance.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import { defaultCadence, type AdvanceCadence } from "../src/daemon/advance.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-rebuild-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-01T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-01";

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
  "  log.advance:",
  "    autonomy: supervised",
  "```",
  "",
].join("\n");

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `gh` stub whose `pr list` is stateful and whose `pr merge` fails loudly.
 *
 * `PROTECT` (a file beside it) makes nothing here refuse: the push refusal that
 * drives the fallback branch is a git-side refusal, and it is installed with a
 * pre-receive hook on the bare remote rather than with `gh`.
 */
function ghStub(): string {
  counter += 1;
  const dir = join(scratch, `gh-bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, "pr-open");
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '  pr) case "$2" in',
    `    list) if [ -f ${JSON.stringify(marker)} ]; then echo '[{"url":"https://example.invalid/pr/1"}]'; else echo '[]'; fi; exit 0 ;;`,
    `    create) : > ${JSON.stringify(marker)}; echo "https://example.invalid/pr/1"; exit 0 ;;`,
    '    merge) echo "the daemon must never merge" >&2; exit 3 ;;',
    "  esac ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
  const path = join(dir, "gh");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

interface Repo {
  dir: string;
  remote: string;
  logPath: string;
  policyPath: string;
  ghDir: string;
}

function appendRecord(dir: string, marker: string): number {
  const result = register(
    join(dir, LOG_RELATIVE),
    {
      task: `filler-${marker}`,
      envelope: {
        origin: { app: "fixture", created_by: "human:tester" },
        state: "proposed",
        actions: [{ class: "read.local", idempotency_key: `filler-${marker}` }],
      },
    },
    "human:tester",
    { policy: { file: join(dir, "APPROVAL.md") } },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.ok ? result.record.seq : 0;
}

function newRepo(): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), `${MARKER_RELATIVE}\n`, "utf8");

  const attested = appendAttestation(join(dir, LOG_RELATIVE), policyPath, "human:carter");
  assert.equal(attested.ok, true, attested.ok ? "" : attested.error.message);

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch).code, 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "seed"], dir).code, 0);
  assert.equal(git(["remote", "add", "origin", remote], dir).code, 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir).code, 0);

  return { dir, remote, logPath: join(dir, LOG_RELATIVE), policyPath, ghDir: ghStub() };
}

/** Run the verb with the `gh` stub on PATH. */
function advance(repo: Repo, over: Record<string, unknown> = {}) {
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  try {
    return logAdvance({
      cwd: repo.dir,
      remote: "origin",
      base: "main",
      pr: false,
      branch: RECORDS_BRANCH,
      today: TODAY,
      ...over,
    });
  } finally {
    process.env["PATH"] = previous;
  }
}

/**
 * A ceremony landing on main with its own copy of the log, as the seq 13704
 * amend did.
 *
 * Made in a SECOND clone, never in the working checkout: the verb under test
 * exists because a log-touching commit made where the live log lives is how
 * `events.jsonl` gets rewound under its own appender.
 */
function ceremonyOnMain(repo: Repo, logText: string, queueText: string): void {
  counter += 1;
  const clone = join(scratch, `ceremony-${String(counter)}`);
  assert.equal(git(["clone", "-q", repo.remote, clone], scratch).code, 0);
  git(["config", "user.email", "test@example.invalid"], clone);
  git(["config", "user.name", "Test"], clone);
  mkdirSync(join(clone, ".approval", "log"), { recursive: true });
  writeFileSync(join(clone, LOG_RELATIVE), logText, "utf8");
  writeFileSync(join(clone, QUEUE_RELATIVE), queueText, "utf8");
  // Something outside the three paths an advance carries, so a rebuilt commit
  // can be shown not to revert the ceremony's own work.
  writeFileSync(join(clone, "CEREMONY.md"), "# the ceremony was here\n", "utf8");
  assert.equal(git(["add", "-A"], clone).code, 0);
  assert.equal(git(["commit", "-qm", "Policy amend: seq 13704 (ceremony)"], clone).code, 0);
  assert.equal(git(["push", "-q", "origin", "main"], clone).code, 0);
}

/** The log blob a rev carries, as text. */
function logAt(repo: Repo, rev: string): string {
  const shown = git(["show", `${rev}:${LOG_RELATIVE}`], repo.remote);
  assert.equal(shown.code, 0, shown.stderr);
  return shown.stdout;
}

function records(repo: Repo) {
  const read = readVerifiedRecords(repo.logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

function cadence(over: Partial<AdvanceCadence> = {}): AdvanceCadence {
  return { ...defaultCadence(), base: "main", ...over };
}

// ===========================================================================
// AC 1 — a trunk that moved is a branch that gets rebuilt, not stacked on
// ===========================================================================

test("rebuild: main moving the log after the branch was pushed produces a mergeable branch", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  const first = advance(repo);
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  if (!first.ok) throw new Error("unreachable");
  assert.equal(first.report.rebuilt, false, "nothing to rebuild on the first advance of a day");

  // main gains a ceremony commit carrying its own copy of the log — the log as
  // it stands right now, which the branch's base does not have — plus a queue
  // projection nobody else touched.
  ceremonyOnMain(repo, readFileSync(repo.logPath, "utf8"), "# queue (amended by the ceremony)\n");

  // More decisions are recorded, and the cadence comes round again.
  appendRecord(repo.dir, "two");
  appendRecord(repo.dir, "three");
  const second = advance(repo);
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (!second.ok) throw new Error("unreachable");
  const report: LogAdvanceReport = second.report;

  assert.equal(report.rebuilt, true, "the branch did not contain the trunk and was not rebuilt");
  assert.equal(report.rebuiltOn?.ref, "origin/main");
  assert.notEqual(report.reusedRecordsBranch, true, "it was rebuilt, not reused");
  assert.equal(report.recordsBranch, RECORDS_BRANCH, "the same branch, rebuilt in place");

  // The branch now contains the trunk, so the pull request is mergeable, and
  // the merge leaves the committed log byte-identical to the working one.
  assert.equal(
    git(["merge-base", "--is-ancestor", "main", RECORDS_BRANCH], repo.remote).code,
    0,
    "the records branch still does not contain main: the pull request is DIRTY",
  );
  counter += 1;
  const verifyClone = join(scratch, `merge-check-${String(counter)}`);
  assert.equal(git(["clone", "-q", repo.remote, verifyClone], scratch).code, 0);
  const merged = git(["merge", "--no-edit", `origin/${RECORDS_BRANCH}`], verifyClone);
  assert.equal(merged.code, 0, `the records branch does not merge cleanly: ${merged.stderr}`);
  assert.equal(
    readFileSync(join(verifyClone, LOG_RELATIVE), "utf8"),
    readFileSync(repo.logPath, "utf8"),
    "main's log after the merge is not the working log",
  );
  // And the ceremony's own work survived the rebuild: nothing outside the three
  // paths an advance carries was reverted. (The queue projection IS one of the
  // three, and the advance owns it: a rebuilt commit lays the working
  // projection over the trunk's, which is what publishing it means.)
  assert.equal(readFileSync(join(verifyClone, "CEREMONY.md"), "utf8"), "# the ceremony was here\n");
  assert.equal(readFileSync(join(verifyClone, QUEUE_RELATIVE), "utf8"), "# queue\n");
  assert.equal(logAt(repo, RECORDS_BRANCH), readFileSync(repo.logPath, "utf8"));
});

test("rebuild: a branch that still contains the trunk is stacked on, exactly as before", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const first = advance(repo);
  assert.equal(first.ok, true, first.ok ? "" : first.message);

  appendRecord(repo.dir, "two");
  const second = advance(repo);
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (!second.ok) throw new Error("unreachable");
  assert.equal(second.report.rebuilt, false);
  assert.equal(second.report.reusedRecordsBranch, true);
  assert.equal(second.report.parent?.ref, `origin/${RECORDS_BRANCH}`);
  // Two commits on one branch, the second parented on the first: the APRV-204
  // one-branch-per-day property is untouched.
  const listed = git(["log", "--format=%H", `main..${RECORDS_BRANCH}`], repo.remote);
  assert.equal(listed.stdout.trim().split("\n").length, 2);
});

test("rebuild: a branch that will not take the rebuilt commit gets a fresh one, named", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  assert.equal(advance(repo).ok, true);
  ceremonyOnMain(repo, readFileSync(repo.logPath, "utf8"), "# queue\n");
  appendRecord(repo.dir, "two");

  // The remote refuses to update THAT ref: a protected-branch ruleset (GH006),
  // or a pull request the merge queue has already taken. The records still have
  // to reach a branch somebody can merge.
  mkdirSync(join(repo.remote, "hooks"), { recursive: true });
  const hook = join(repo.remote, "hooks", "update");
  writeFileSync(
    hook,
    ["#!/bin/sh", `[ "$1" = "refs/heads/${RECORDS_BRANCH}" ] || exit 0`, "echo 'GH006: Protected branch update failed' >&2", "exit 1", ""].join(
      "\n",
    ),
    "utf8",
  );
  chmodSync(hook, 0o755);

  const result = advance(repo);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.report.rebuilt, true);
  assert.equal(result.report.recordsBranch, `${RECORDS_BRANCH}-2`, "no fallback branch was opened");
  assert.equal(result.report.fallbackFrom, RECORDS_BRANCH, "the report does not say which");
  assert.equal(logAt(repo, `${RECORDS_BRANCH}-2`), readFileSync(repo.logPath, "utf8"));
  assert.equal(
    git(["merge-base", "--is-ancestor", "main", `${RECORDS_BRANCH}-2`], repo.remote).code,
    0,
    "the fallback branch does not contain main either",
  );
});

// ===========================================================================
// AC 2 — nothing is pushed over a log the working copy is not a superset of
// ===========================================================================

test("rebuild: a working log the trunk's is not a prefix of refuses and pushes nothing", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const first = advance(repo);
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  const branchBefore = git(["rev-parse", RECORDS_BRANCH], repo.remote).stdout.trim();

  // main gains records this checkout does not have: a log that is AHEAD of the
  // working one. Rebuilding on it would publish a chain shorter than the one
  // the trunk already carries.
  const ahead = join(scratch, `ahead-${String(counter)}.jsonl`);
  copyFileSync(repo.logPath, ahead);
  appendRecord(repo.dir, "only-on-main");
  ceremonyOnMain(repo, readFileSync(repo.logPath, "utf8"), "# queue\n");
  // Put the working log back to where it was: main now carries a record this
  // checkout does not.
  copyFileSync(ahead, repo.logPath);

  const refused = advance(repo);
  assert.equal(refused.ok, false, "an advance was allowed over a trunk this log is behind");
  if (refused.ok) throw new Error("unreachable");
  assert.equal(refused.code, "log-advance-behind-remote", refused.message);
  assert.equal(
    git(["rev-parse", RECORDS_BRANCH], repo.remote).stdout.trim(),
    branchBefore,
    "the records branch moved despite the refusal",
  );
});

// ===========================================================================
// AC 3 — the event stream and the doctor row say it happened
// ===========================================================================

test("rebuild: the daemon's advance event and the doctor row name the rebuild and its base", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const first = advance(repo);
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  ceremonyOnMain(repo, readFileSync(repo.logPath, "utf8"), "# queue (ceremony)\n");
  appendRecord(repo.dir, "two");

  const events: DaemonEvent[] = [];
  const options: DaemonOptions = {
    logPath: repo.logPath,
    tasksDir: join(repo.dir, "backlog", "tasks"),
    queuePath: join(repo.dir, QUEUE_RELATIVE),
    policy: { file: repo.policyPath },
    cwd: repo.dir,
    intervalMs: 30_000,
    debounceMs: 10,
    once: true,
    today: TODAY,
    sink: { emit: (event) => events.push(event) },
    advance: cadence({ afterRecords: 1, intervalMs: 3_600_000 }),
  };
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  await new Daemon(options).run();
  process.env["PATH"] = previous;

  const advanced = events.filter(
    (event): event is Extract<DaemonEvent, { event: "advance" }> =>
      event.event === "advance" && event.outcome === "advanced",
  );
  assert.equal(advanced.length, 1, `expected one advance, got ${JSON.stringify(events)}`);
  assert.equal(advanced[0]?.rebuilt, true, "the event does not say the branch was rebuilt");
  assert.equal(advanced[0]?.rebuilt_on, "origin/main");

  // The same fact, read back out of the LOG by a different surface: the
  // completion carries the note, and the cadence row prints it.
  const last = lastAdvance(records(repo));
  assert.equal(last?.outcome, "completed");
  assert.equal(last?.code, "advance-rebuilt", last?.message ?? "");

  let stdout = "";
  await commandDoctor(
    ["--json", "--dir", repo.dir, "--policy", repo.policyPath],
    { out: (text: string) => (stdout += text), err: () => undefined },
    repo.dir,
  );
  const parsed = JSON.parse(stdout) as { checks: { check: string; detail: string }[] };
  const row = parsed.checks.find((check) => check.check === "log-advance-cadence");
  assert.ok(row !== undefined, "there is no log-advance-cadence row");
  assert.match(
    row.detail,
    /advance-rebuilt/,
    `the doctor row does not name the rebuild: ${row.detail}`,
  );
  assert.match(row.detail, /origin\/main/, `the doctor row does not name the base: ${row.detail}`);
});
