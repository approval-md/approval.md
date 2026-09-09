/**
 * The daemon's cadence advance, end to end (APRV-204).
 *
 * Every case builds a REAL git topology — a bare remote and a working clone,
 * driven with real `git` — for the reason `tests/cli-log-verbs.test.ts` states:
 * the subject is what git actually does, and a fake git would test the fake.
 * `gh` is the one thing stubbed, because it is the one thing that would reach
 * the network; the stub is a script on PATH, so the production code path
 * (`spawnSync("gh", …)`) is exercised unchanged.
 *
 * Nothing here writes a log line by hand. The seed records come from
 * `core/attest.ts`'s real append path, and every record the daemon writes is
 * written by `core/gate.ts` and `core/execute.ts` through the gate.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { EXEMPT_PREFIXES } from "../src/core/protected-path-guard.js";
import { register } from "../src/core/gate.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import { lastAdvance } from "../src/core/advance-cycle.js";
import { publishedState } from "../src/cli/log-advance.js";
import { advanceArgv, defaultCadence, type AdvanceCadence } from "../src/daemon/advance.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-daemon-advance-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
/** The day every case's records branch is named for. Injected, never read. */
const TODAY = "2026-09-01T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-01";

/** A policy in which `log.advance` runs without asking. */
const POLICY_SUPERVISED = [
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

/** The same policy with the class raised: every advance stops for a human. */
const POLICY_MANUAL = POLICY_SUPERVISED.replace("autonomy: supervised", "autonomy: manual");

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
 * A `gh` that answers `pr list`, `pr create` and `pr merge`, logging every call.
 *
 * `pr merge` answered rather than refused since APRV-284: the daemon arms the
 * day's records pull request (`--merge --auto`) and still merges nothing, so
 * the assertion moved from the exit status to the argv — the call log below
 * distinguishes an arm from a merge, which an exit code cannot. The list answer
 * is stateful — empty until a pull request has been created, one entry after —
 * which is exactly the state the one-PR-per-day rule reads.
 */
function ghStub(): { dir: string; log: string } {
  counter += 1;
  const dir = join(scratch, `gh-bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.txt");
  const marker = join(dir, "pr-open");
  const script = [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s ' "$arg" >> ${JSON.stringify(log)}; done`,
    `printf '\\n' >> ${JSON.stringify(log)}`,
    'case "$1" in',
    '  pr) case "$2" in',
    `    list) if [ -f ${JSON.stringify(marker)} ]; then echo '[{"url":"https://example.invalid/pr/1"}]'; else echo '[]'; fi; exit 0 ;;`,
    `    create) : > ${JSON.stringify(marker)}; echo "https://example.invalid/pr/1"; exit 0 ;;`,
    // APRV-284: `pr merge --auto` ARMS a merge; it does not perform one. The
    // stub answers it the way a repository with auto-merge enabled does, and
    // the cases below assert on the argv rather than on the exit code.
    '    merge) echo "armed"; exit 0 ;;',
    "  esac ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
  const path = join(dir, "gh");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return { dir, log };
}

/** Every `gh` invocation the stub saw, one line per call. */
function ghCalls(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
}

interface Repo {
  dir: string;
  remote: string;
  logPath: string;
  ghLog: string;
  ghDir: string;
}

/**
 * One appended record, through the real append path: a task registration.
 *
 * A registration rather than an attestation, which is what
 * `tests/cli-log-verbs.test.ts` uses for the same purpose. The reason is the
 * gate: `checkAttestation` matches the LAST attestation in the log against the
 * live policy bytes, so a fixture that attested a marker file after attesting
 * the policy would leave every gate operation refusing `policy-unattested` —
 * correctly, and for a reason that has nothing to do with the cadence.
 */
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
  if (!result.ok) throw new Error("unreachable");
  return result.record.seq;
}

/** A working checkout with a policy, an attested log, a remote, and one commit. */
function newRepo(policyText: string = POLICY_SUPERVISED): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), `${MARKER_RELATIVE}\n`, "utf8");

  // The attestation the gate requires, through the real append path.
  const attested = appendAttestation(join(dir, LOG_RELATIVE), join(dir, "APPROVAL.md"), "human:carter");
  assert.equal(attested.ok, true, attested.ok ? "" : attested.error.message);

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch).code, 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "seed"], dir).code, 0);
  assert.equal(git(["remote", "add", "origin", remote], dir).code, 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir).code, 0);

  const stub = ghStub();
  return { dir, remote, logPath: join(dir, LOG_RELATIVE), ghLog: stub.log, ghDir: stub.dir };
}

/**
 * Run one daemon tick (and its shutdown flush) with the gh stub on PATH.
 *
 * `once` makes the whole run synchronous — the tick, the flush and the
 * `stopped` line are all emitted before `run()` returns its (already settled)
 * promise — so the events are in hand by the time this function returns and
 * PATH can be restored immediately.
 */
function runDaemon(repo: Repo, advance: AdvanceCadence): { events: DaemonEvent[] } {
  const events: DaemonEvent[] = [];
  const options: DaemonOptions = {
    logPath: repo.logPath,
    tasksDir: join(repo.dir, "backlog", "tasks"),
    queuePath: join(repo.dir, QUEUE_RELATIVE),
    policy: { file: join(repo.dir, "APPROVAL.md") },
    cwd: repo.dir,
    intervalMs: 30_000,
    debounceMs: 10,
    once: true,
    today: TODAY,
    sink: { emit: (event) => events.push(event) },
    advance,
  };

  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  try {
    void new Daemon(options).run();
  } finally {
    process.env["PATH"] = previous;
  }
  return { events };
}

/** The cadence every case starts from: publish eagerly, one day, one branch. */
function cadence(over: Partial<AdvanceCadence> = {}): AdvanceCadence {
  return { ...defaultCadence(), base: "main", ...over };
}

function advanceEvents(events: DaemonEvent[]): Extract<DaemonEvent, { event: "advance" }>[] {
  return events.filter(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
}

function records(repo: Repo) {
  const read = readVerifiedRecords(repo.logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

/** The commits the records branch carries that the trunk does not, oldest first. */
function branchCommits(repo: Repo, branch: string): string[] {
  const listed = git(["log", "--format=%H", `main..${branch}`], repo.remote);
  if (listed.code !== 0) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();
}

// ===========================================================================
// AC 1 — the cadence trigger
// ===========================================================================

test("cadence: enough unpublished records advance the log on a tick", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  appendRecord(repo.dir, "two");
  const headBefore = git(["rev-parse", "HEAD"], repo.dir).stdout.trim();

  const { events } = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 3_600_000 }));
  const advances = advanceEvents(events);
  assert.equal(advances.length, 1, `expected exactly one advance, got ${String(advances.length)}`);
  const advance = advances[0];
  assert.equal(advance?.outcome, "advanced", advance?.message ?? "");
  assert.equal(advance?.flush, false, "the tick trigger fired, so the flush had nothing left to do");
  assert.equal(advance?.pr_created, true);
  assert.equal(advance?.pr_url, "https://example.invalid/pr/1");

  // The records reached the remote, and the checkout did not move: HEAD is
  // where it was, and the only paths the working tree shows as changed are the
  // three the advance carries — nothing was checked out, staged or reverted.
  assert.equal(branchCommits(repo, RECORDS_BRANCH).length, 1);
  assert.equal(git(["rev-parse", "HEAD"], repo.dir).stdout.trim(), headBefore);
  assert.equal(git(["diff", "--cached", "--name-only"], repo.dir).stdout.trim(), "");
  const dirty = git(["status", "--porcelain"], repo.dir)
    .stdout.split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
  for (const path of dirty) assert.ok(path.startsWith(".approval/"), `${path} was touched`);

  // And the gate wrote the cycle: registered, started, completed, as agent:daemon.
  const mine = records(repo).filter((record) => record.task?.startsWith("daemon-advance-") === true);
  assert.deepEqual(
    mine.map((record) => record.event),
    ["task.registered", "execution.started", "execution.completed"],
  );
  for (const record of mine) assert.equal(record.actor, "agent:daemon");
  assert.equal(lastAdvance(records(repo))?.outcome, "completed");
});

test("cadence: the daemon's own bookkeeping does not trigger another advance", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));

  // The completion record of the first advance is now the only unpublished
  // record. A second daemon, configured to advance at the first record it sees,
  // must still do nothing: counting its own bookkeeping is how a cadence over an
  // idle repository would advance forever.
  const state = publishedState(repo.dir, repo.logPath, records(repo), cadence(), TODAY);
  assert.ok(state.pending > 0, "the completion record should be unpublished");
  assert.equal(state.substantive, 0, "nothing but the daemon's own records is owed");

  const { events } = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));
  assert.deepEqual(advanceEvents(events), []);
  assert.equal(branchCommits(repo, RECORDS_BRANCH).length, 1, "a second commit was pushed");
});

// ===========================================================================
// AC 1 — the shutdown flush
// ===========================================================================

test("shutdown: a clean stop with records owed advances even when no trigger fired", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  // Neither trigger can fire: twenty records are not owed, and the interval has
  // not elapsed since the daemon started. Only the flush is left.
  const { events } = runDaemon(repo, cadence({ afterRecords: 999, intervalMs: 3_600_000 }));
  const advances = advanceEvents(events);
  assert.equal(advances.length, 1);
  assert.equal(advances[0]?.outcome, "advanced", advances[0]?.message ?? "");
  assert.equal(advances[0]?.flush, true, "the advance was not the shutdown flush");
  assert.equal(branchCommits(repo, RECORDS_BRANCH).length, 1);

  // The flush line comes before the stopped line: a reader tailing the daemon
  // sees what it published on the way out.
  const kinds = events.map((event) => event.event);
  assert.ok(kinds.indexOf("advance") < kinds.indexOf("stopped"));
});

// ===========================================================================
// AC 2 — the gate's answer is honoured
// ===========================================================================

test("refusal: a manual log.advance stops the cadence, records the question, and retries", () => {
  const repo = newRepo(POLICY_MANUAL);
  appendRecord(repo.dir, "one");

  const first = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));
  const advances = advanceEvents(first.events);
  assert.ok(advances.length >= 1);
  assert.equal(advances[0]?.outcome, "gated", advances[0]?.message ?? "");
  assert.equal(advances[0]?.commit, null);

  // Nothing was committed and nothing was pushed.
  assert.deepEqual(branchCommits(repo, RECORDS_BRANCH), []);
  assert.equal(git(["diff", "--cached", "--name-only"], repo.dir).stdout.trim(), "");

  // The question is IN THE LOG, as a request a human can answer.
  const requested = records(repo).filter((record) => record.event === "approval.requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.actor, "agent:daemon");

  // It is reported as a warning, not swallowed.
  const warnings = first.events.filter(
    (event) => event.event === "warning" && event.code === "advance-refused",
  );
  assert.equal(warnings.length >= 1, true);

  // And the next tick tries again rather than giving up or looping in place —
  // by ADOPTING the standing question, not by opening a second one.
  //
  // This assertion read `2` until APRV-211, under the message below, which is
  // how the defect survived a test suite: the message said the retry must not
  // open a second question and the number said it had. Three ticks over one
  // owed advance put three questions on a human's phone on 2026-09-02. One owed
  // advance is one question, however many ticks pass under it.
  const second = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));
  assert.equal(advanceEvents(second.events)[0]?.outcome, "gated");
  assert.equal(
    records(repo).filter((record) => record.event === "approval.requested").length,
    1,
    "the retry opened a second question",
  );
  // The daemon never merges, whatever the gate says.
  assert.equal(
    ghCalls(repo.ghLog).some((line) => line.includes("merge")),
    false,
  );
});

// ===========================================================================
// AC 1/4 — one pull request per day, and a records-tier commit shape
// ===========================================================================

test("one pull request per day: the second advance updates the branch and opens nothing", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));
  appendRecord(repo.dir, "two");
  const { events } = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));

  const advance = advanceEvents(events)[0];
  assert.equal(advance?.outcome, "advanced", advance?.message ?? "");
  assert.equal(advance?.pr_created, false, "a second pull request was opened for the same day");
  assert.equal(advance?.pr_url, "https://example.invalid/pr/1");

  // One branch, two commits, the second parented on the first: a fast-forward
  // update of the branch the day's pull request is open on.
  const commits = branchCommits(repo, RECORDS_BRANCH);
  assert.equal(commits.length, 2);
  const parent = git(["rev-parse", `${commits[1] ?? ""}^`], repo.remote).stdout.trim();
  assert.equal(parent, commits[0]);

  // Exactly one `gh pr create`, however many advances ran.
  assert.equal(
    ghCalls(repo.ghLog).filter((line) => line.startsWith("pr create")).length,
    1,
  );
});

test("records tier: every path a daemon advance commits is an exempt evidence path", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));

  const commit = branchCommits(repo, RECORDS_BRANCH)[0];
  assert.ok(commit !== undefined, "nothing was pushed");
  const changed = git(["show", "--name-only", "--format=", commit ?? ""], repo.remote)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert.ok(changed.length > 0);
  for (const path of changed) {
    assert.ok(
      EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix)),
      `${path} is not one of the evidence paths the protected-path guard exempts, so a records pull request carrying it would need a grant`,
    );
  }
});

/**
 * APRV-284 replaced "the daemon never merges" with "the daemon never merges
 * ITSELF, and arms the merge instead".
 *
 * The source grep that used to stand here (no `"merge"` literal anywhere in
 * `daemon/advance.ts`) still holds and still means something: the merge argv
 * lives in `cli/log-advance.ts`, where the session path and the daemon path
 * share one spelling of it, and this module contributes a boolean. What it no
 * longer means is that nothing merges, so the behaviour is pinned below on the
 * calls the stub actually sees.
 */
test("the module spells no merge of its own: the argv is `logAdvance`'s, shared with the session path", () => {
  const source = readFileSync(new URL("../../src/daemon/advance.ts", import.meta.url), "utf8");
  assert.equal(/["'`]merge["'`]/u.test(source), false);
});

test("a cadence advance arms auto-merge on the day's pull request", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const { events } = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0 }));

  const advance = advanceEvents(events)[0];
  assert.equal(advance?.outcome, "advanced", advance?.message ?? "");
  assert.equal(advance?.auto_merge, "armed");
  assert.equal(advance?.auto_merge_note, null);
  assert.match(advance?.message ?? "", /auto-merge armed/u);

  // `--auto`, and never a bare `--merge`: what is armed lands when CI and the
  // branch rules allow it, which is the whole difference between arming a
  // records pull request and a daemon merging its own evidence.
  assert.deepEqual(
    ghCalls(repo.ghLog).filter((line) => line.startsWith("pr merge")),
    [`pr merge ${RECORDS_BRANCH} --merge --auto`],
  );
});

test("--no-advance-auto-merge: the advance publishes and no merge is armed", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const { events } = runDaemon(repo, cadence({ afterRecords: 1, intervalMs: 0, autoMerge: false }));

  const advance = advanceEvents(events)[0];
  assert.equal(advance?.outcome, "advanced", advance?.message ?? "");
  assert.equal(advance?.pr_created, true, "the pull request itself is unaffected");
  assert.equal(advance?.auto_merge, "off");
  assert.match(advance?.message ?? "", /auto-merge not armed/u);
  assert.deepEqual(
    ghCalls(repo.ghLog).filter((line) => line.startsWith("pr merge")),
    [],
    "an arm reached gh even though the cadence option is off",
  );
});

test("the argv the payload binds to names the arm only when it is off", () => {
  // The default cadence's argv must be byte-identical to what it was before the
  // arm existed: it is what the payload hash and the idempotency key are built
  // from, and a changed argv under a running daemon re-asks a question that was
  // already answered.
  assert.deepEqual(advanceArgv(cadence()), [
    "approval",
    "log",
    "advance",
    "--pr",
    "--remote",
    "origin",
    "--base",
    "main",
  ]);
  assert.ok(advanceArgv(cadence({ autoMerge: false })).includes("--no-auto-merge"));
  assert.equal(advanceArgv(cadence({ pr: false, autoMerge: false })).includes("--no-auto-merge"), false);
});
