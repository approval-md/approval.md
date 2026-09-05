/**
 * The advance's outcome record, and what the cadence does when it is lost
 * (APRV-233).
 *
 * ## The incident these cases are written against
 *
 * 2026-09-02, Carter's terminal, `approval up --advance` on the build APRV-211
 * had just landed. The advance pushed `records-log-2026-09-02`, and then:
 *
 *   `execution.completed could not be appended: head moved`
 *
 * — a harness hook's record had landed between this runtime's read and its
 * append, the compare-and-append refused the stale write exactly as SPEC.md
 * §11.1 invariant 5 requires, and `daemon-log-advance-1-13984` was left open.
 * The next tick's authorization then reached `startExecution` on that same open
 * key and came back `already-executed … an idempotency key is single-use and
 * nothing here reconciles or reruns it`, reported as a refusal that fixed
 * nothing; once the owed span moved, the branch was pushed all over again.
 * Ticks two, five and eight, ninety seconds apart, under `--advance-interval`
 * of fifteen minutes. And for the whole of each of those advances every harness
 * hook on the machine refused its command with `append-failed: another writer
 * holds events.jsonl.lock; gave up after 2000ms`, because the verb held the
 * append lock across `git fetch`, `git push` and `gh pr create`.
 *
 * Four properties, four sections. Every case builds a real git topology with a
 * bare remote and drives real `git`; `gh` is the one thing stubbed, because it
 * is the one thing that would reach the network. Nothing here writes a log line
 * by hand: every record is written by the real gate through the real append
 * path.
 *
 * The two head-moved cases construct their interleaving rather than waiting for
 * it (APRV-261): the record that moves the head is appended, by another
 * process's parent, while the writer is held between its read and its append by
 * a seam. No case in this file asserts on wall-clock ordering, and the only
 * durations left in it are the ones the cadence cases are about.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { danglingExecutions } from "../src/core/execute.js";
import { register } from "../src/core/gate.js";
import { verify } from "../src/core/verify.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { logAdvance, publishedState } from "../src/cli/log-advance.js";
import { showBlob } from "../src/cli/git-scope.js";
import { silentProgress } from "../src/cli/progress.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import {
  authorizeAdvance,
  defaultCadence,
  type AdvanceCadence,
  type AdvanceInput,
} from "../src/daemon/advance.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-finish-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-01T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-01";

const SETTLE_CHILD = fileURLToPath(
  new URL("../../tests/fixtures/advance/settle-finish.mjs", import.meta.url),
);
const LOCK_HOLDING_ADVANCE = fileURLToPath(
  new URL("../../tests/fixtures/advance/lock-holding-advance.mjs", import.meta.url),
);
const SLOW_ADVANCE = fileURLToPath(
  new URL("../../tests/fixtures/advance/slow-advance.mjs", import.meta.url),
);

/** A policy in which `log.advance` runs without asking. */
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

/** A `gh` that answers `pr list` and `pr create` and REFUSES `pr merge`. */
function ghStub(): { dir: string } {
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
  return { dir };
}

interface Repo {
  dir: string;
  remote: string;
  logPath: string;
  policyPath: string;
  ghDir: string;
}

/** One appended record, through the real append path. */
function appendRecord(dir: string, marker: string): { ok: boolean; seq: number } {
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
  return { ok: result.ok, seq: result.ok ? result.record.seq : 0 };
}

/** A working checkout with a policy, an attested log, a remote, and one commit. */
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

  return { dir, remote, logPath: join(dir, LOG_RELATIVE), policyPath, ghDir: ghStub().dir };
}

function cadence(over: Partial<AdvanceCadence> = {}): AdvanceCadence {
  return { ...defaultCadence(), base: "main", ...over };
}

function inputFor(repo: Repo, over: Partial<AdvanceInput> = {}): AdvanceInput {
  return {
    logPath: repo.logPath,
    cwd: repo.dir,
    policy: { file: repo.policyPath },
    cadence: cadence(),
    today: TODAY,
    ...over,
  };
}

function records(repo: Repo) {
  const read = readVerifiedRecords(repo.logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

/** Every record for one action key, in log order. */
function eventsFor(repo: Repo, actionKey: string): string[] {
  return records(repo)
    .filter((record) => record.action_key === actionKey)
    .map((record) => record.event);
}

function danglingKeys(repo: Repo): string[] {
  return danglingExecutions([...records(repo)]).map((entry) => entry.actionKey);
}

interface SettleOutcome {
  ok: boolean;
  code: string | null;
  message: string;
  /** How many whole read-check-append cycles the writer made. */
  attempts: number;
}

/**
 * Put one record into the window between an out-of-process
 * `settleAdvanceFinish`'s read and its append, and hold the window open until
 * it is there (APRV-261).
 *
 * ## Why this is a handshake and not a race
 *
 * It used to be a race. The parent took the append lockfile, spawned the child,
 * waited for a `ready` file the child wrote BEFORE it began, slept a flat
 * 300 ms hoping the child had reached its read inside that, released the lock,
 * and appended. Two scheduling bets, both silent when lost. The first: that
 * 300 ms is enough for a cold Node to boot, import `dist`, and read a verified
 * log — when it is not, the parent's record lands first, the child then reads a
 * log that already holds it, no head moves, and the case passes having proved
 * nothing (which is what the second case's six-round `continue` is absorbing,
 * until the round budget runs out and the suite fails "the unretried writer
 * never lost the race in six rounds"). The second: that after `unlinkSync` the
 * parent completes a policy load, a verified read, a hash and a lock
 * acquisition before the child's next lock poll, which `core/log.ts` fixes at
 * 20 ms — when it does not, the child appends first, the outcome sits BELOW the
 * filler, and the case fails outright.
 *
 * Neither bet is made now. The child's seam (`AdvanceInput.afterFinishRead`,
 * forwarded to the finish path as `FinishOptions.afterRead`) fires between the
 * read and the append of the first attempt, signals `ready` from THERE, and
 * blocks until this process says `go`. So the parent's record is appended while
 * the child is demonstrably holding a read of a log without it, every time, at
 * any load, with no delay anywhere. The child is not holding the append lock
 * while it waits — its append has not started — so the filler takes the lock at
 * once.
 *
 * Returns the child's own report, which carries the number of attempts it made,
 * and the seq of the record that moved the head under it.
 */
async function interleavedFinish(
  repo: Repo,
  actionKey: string,
  attempts: "default" | number,
  marker: string,
): Promise<{ outcome: SettleOutcome; fillerSeq: number }> {
  const ready = join(repo.dir, `ready-${marker}`);
  const go = join(repo.dir, `go-${marker}`);

  const child = spawn(
    process.execPath,
    [
      SETTLE_CHILD,
      repo.logPath,
      repo.policyPath,
      repo.dir,
      actionKey,
      "0",
      attempts === "default" ? "default" : String(attempts),
      ready,
      go,
    ],
    { cwd: repo.dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (err += chunk));
  const finished = new Promise<void>((resolve) => {
    child.on("close", () => {
      closed = true;
      resolve();
    });
  });

  // A poll for a condition, never a wait for a duration: however long the child
  // takes to get there, the window opens when it arrives and not before.
  while (!existsSync(ready)) {
    assert.ok(!closed, `the settle child exited before its read: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  // The child has read the log and is inside `finishExecution`, one statement
  // above its append. This is where the 2026-09-02 hook's record landed.
  const filler = appendRecord(repo.dir, marker);
  assert.equal(filler.ok, true, "the record that moves the head could not be appended");
  writeFileSync(go, "go", "utf8");

  await finished;
  assert.ok(out.trim().length > 0, `the settle child produced no result: ${err}`);
  return { outcome: JSON.parse(out.trim()) as SettleOutcome, fillerSeq: filler.seq };
}

/** Authorize one advance for real: registered, requested, started. */
function authorized(repo: Repo): string {
  const auth = authorizeAdvance(inputFor(repo), records(repo));
  assert.equal(auth.authorized, true, auth.authorized ? "" : auth.attempt.message);
  if (!auth.authorized) throw new Error("unreachable");
  return auth.actionKey;
}

// ===========================================================================
// AC 1 — the outcome record survives a concurrent append
// ===========================================================================

test("finish: an outcome record that loses the append race re-derives and lands", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "seed");
  const actionKey = authorized(repo);

  const raced = await interleavedFinish(repo, actionKey, "default", "r1");

  // The sequence, as the writer itself reports it: two whole cycles. The first
  // read, ran `finishExecution`'s not-started / already-finished /
  // execution-delegated checks, and had its append refused by the
  // compare-and-append because the head it named was no longer the tail. The
  // second re-read, re-ran those same checks against the log as it now stood,
  // and appended against the head THAT read observed.
  assert.equal(raced.outcome.attempts, 2, JSON.stringify(raced.outcome));
  assert.equal(raced.outcome.ok, true, JSON.stringify(raced.outcome));
  assert.deepEqual(eventsFor(repo, actionKey), [
    // (a supervised advance proceeds without an approval.requested of its own)
    "execution.started",
    "execution.completed",
  ]);
  assert.deepEqual(danglingKeys(repo), [], "an execution was left dangling");
  assert.equal(verify(repo.logPath).status, "clean");
  // And the interleaving really was an interleaving: the record that moved the
  // head is BELOW the outcome, so the outcome was written after it.
  const completed = records(repo).find(
    (record) => record.action_key === actionKey && record.event === "execution.completed",
  );
  assert.ok(
    completed !== undefined && completed.seq > raced.fillerSeq,
    "the concurrent record did not land between the read and the append",
  );
});

test("finish: the pre-APRV-233 writer loses the race and leaves the execution dangling", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "seed");
  const actionKey = authorized(repo);

  // `retryOnHeadMoved: 1` is the writer as it was: one read, one set of checks,
  // one append. The same handshake, the same record in the same window, and the
  // only difference is the bound — so what follows is caused by the bound and
  // by nothing else.
  const raced = await interleavedFinish(repo, actionKey, 1, "p1");

  assert.equal(raced.outcome.attempts, 1, JSON.stringify(raced.outcome));
  assert.equal(raced.outcome.ok, false, JSON.stringify(raced.outcome));
  assert.equal(raced.outcome.code, "append-failed", JSON.stringify(raced.outcome));
  assert.deepEqual(eventsFor(repo, actionKey), ["execution.started"]);
  assert.deepEqual(danglingKeys(repo), [actionKey], "this is the 2026-09-02 residue");
  assert.equal(verify(repo.logPath).status, "clean", "the log is fine; the bookkeeping is not");
});

// ===========================================================================
// AC 2 — a failed outcome record does not reset the cadence
// ===========================================================================

/** Run a daemon for `ms`, collecting its events, and stop it cleanly. */
async function runFor(
  repo: Repo,
  options: Partial<DaemonOptions>,
  ms: number,
  during?: (events: DaemonEvent[]) => void,
): Promise<DaemonEvent[]> {
  const events: DaemonEvent[] = [];
  const daemon = new Daemon({
    logPath: repo.logPath,
    tasksDir: join(repo.dir, "backlog", "tasks"),
    queuePath: join(repo.dir, QUEUE_RELATIVE),
    policy: { file: repo.policyPath },
    cwd: repo.dir,
    intervalMs: 150,
    debounceMs: 10,
    today: TODAY,
    sink: { emit: (event) => events.push(event) },
    ...options,
  } as DaemonOptions);

  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  const run = daemon.run();
  const stopAt = Date.now() + ms;
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      during?.(events);
      if (Date.now() >= stopAt) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
  daemon.stop("test");
  await run;
  process.env["PATH"] = previous;
  return events;
}

function advances(events: DaemonEvent[]): Extract<DaemonEvent, { event: "advance" }>[] {
  return events.filter(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
}

test("cadence: a lost outcome record is settled on the next tick, and nothing advances inside the interval", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const lock = `${repo.logPath}.lock`;

  // The stub leaves the append lock held, so the advance's own
  // `execution.completed` cannot land: the 2026-09-02 shape, made to order.
  // The lock is released once the failure has been reported, which is when the
  // next tick can settle the outcome this process is still holding.
  const events = await runFor(
    repo,
    {
      advance: cadence({ afterRecords: 1, intervalMs: 3_600_000 }),
      advanceRunner: { command: process.execPath, args: [LOCK_HOLDING_ADVANCE] },
    },
    9_000,
    (seen) => {
      if (advances(seen).some((event) => event.outcome === "failed") && existsSync(lock)) {
        unlinkSync(lock);
      }
    },
  );

  const attempts = advances(events);
  const failed = attempts.filter((event) => event.outcome === "failed");
  assert.equal(failed.length, 1, `expected exactly one advance attempt, got ${String(attempts.length)}`);
  assert.equal(
    attempts.filter((event) => event.outcome === "advanced").length,
    0,
    "nothing published: the runner refused",
  );

  // The next tick recorded the outcome this process observed, on the fresh
  // head, and said so.
  const settled = attempts.filter((event) => event.code === "advance-settled");
  assert.equal(settled.length, 1, `expected one settle line, got ${JSON.stringify(attempts)}`);
  assert.deepEqual(danglingKeys(repo), [], "the execution is closed");
  assert.ok(
    records(repo).some((record) => record.event === "execution.failed"),
    "the outcome the runtime observed is the outcome the log holds",
  );

  // And the interval was honoured: ~60 ticks ran in nine seconds and exactly
  // one of them attempted an advance, under a one-record count trigger that
  // before APRV-233 would have fired on every free tick.
  assert.equal(
    attempts.filter((event) => event.outcome !== "nothing-owed").length,
    1,
    `the cadence re-attempted inside the interval: ${JSON.stringify(attempts.map((a) => a.outcome))}`,
  );
});

test("cadence: an advance left open by another process is reconciled from the git evidence, not re-run", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  // Publish for real, then leave the cycle open: `authorizeAdvance` writes the
  // registration, the request and the `execution.started`, `logAdvance` pushes
  // the branch, and nothing writes the outcome — which is precisely the state
  // the daemon found itself in, and precisely the state in which its next
  // authorization came back `already-executed`.
  const actionKey = authorized(repo);
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  const advanced = logAdvance({
    cwd: repo.dir,
    remote: "origin",
    base: "main",
    pr: false,
    branch: RECORDS_BRANCH,
    today: TODAY,
  });
  process.env["PATH"] = previous;
  assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.message);
  assert.deepEqual(danglingKeys(repo), [actionKey]);

  const events = await runFor(
    repo,
    { advance: cadence({ afterRecords: 1, intervalMs: 3_600_000 }) },
    3_000,
  );

  const attempts = advances(events);
  assert.equal(
    attempts.filter((event) => event.code === "advance-reconciled").length,
    1,
    `expected one reconciliation, got ${JSON.stringify(attempts)}`,
  );
  assert.deepEqual(danglingKeys(repo), [], "the cycle is closed");
  assert.deepEqual(eventsFor(repo, actionKey), ["execution.started", "execution.completed"]);
  assert.equal(
    attempts.filter((event) => event.outcome === "advanced").length,
    0,
    "reconciling is not advancing: nothing was pushed a second time",
  );
});

// ===========================================================================
// AC 3 — the append lock is not held across the git side effect
// ===========================================================================

test("lock: a concurrent append lands within two seconds while an advance child runs", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  let elapsed = Number.POSITIVE_INFINITY;
  let landed = false;
  let tried = false;
  await runFor(
    repo,
    {
      advance: cadence({ afterRecords: 1, intervalMs: 3_600_000 }),
      advanceRunner: { command: process.execPath, args: [SLOW_ADVANCE] },
    },
    2_500,
    () => {
      // Half a second in, the tick has spawned the child and the child has
      // four and a half seconds left to run. This is the window in which every
      // harness hook on Carter's machine was refusing `append-failed`.
      if (tried) return;
      tried = true;
      const started = Date.now();
      landed = appendRecord(repo.dir, "during-advance").ok;
      elapsed = Date.now() - started;
    },
  );

  assert.equal(landed, true, "a writer could not append while an advance child was running");
  assert.ok(
    elapsed < 2_000,
    `the append took ${String(elapsed)}ms; the hook gives up at 2000ms and denies the command`,
  );
});

test("lock: the verb itself releases the lock before it fetches, pushes or opens a pull request", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  // The verb's own regression, and the one that matters: the child moved off
  // the daemon's loop in APRV-211, but `logAdvance` still wrapped `git fetch`,
  // `commitOnBase`, `git push` and `gh pr create` in `withAppendLock`, so the
  // lock was held in the child for the whole of each advance. The progress
  // seam is the observation point — a phase line is emitted immediately before
  // the push — and the assertion is that an ordinary writer gets in.
  let duringPush: { ok: boolean; seq: number; ms: number } | null = null;
  const progress = {
    ...silentProgress,
    phase: (text: string): void => {
      if (!text.startsWith("pushing") || duringPush !== null) return;
      const started = Date.now();
      const appended = appendRecord(repo.dir, "during-push");
      duringPush = { ...appended, ms: Date.now() - started };
    },
  };

  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  const advanced = logAdvance({
    cwd: repo.dir,
    remote: "origin",
    base: "main",
    pr: true,
    branch: RECORDS_BRANCH,
    today: TODAY,
    progress,
  });
  process.env["PATH"] = previous;

  assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.message);
  assert.ok(duringPush !== null, "the push phase was never reported");
  const observed = duringPush as unknown as { ok: boolean; seq: number; ms: number };
  assert.equal(observed.ok, true, "a writer was locked out during the push");
  assert.ok(observed.ms < 2_000, `the append took ${String(observed.ms)}ms`);

  // And the commit carries the bytes that were VERIFIED, not the bytes the file
  // grew into while the lock was down: the record appended during the push is
  // in the working log and not in the committed one.
  if (!advanced.ok) throw new Error("unreachable");
  const committed = showBlob(repo.dir, advanced.report.commit ?? "", LOG_RELATIVE);
  assert.ok(committed !== null, "the advance commit has no log blob");
  const lines = (committed as Buffer).toString("utf8").trim().split("\n");
  const lastSeq = (JSON.parse(lines[lines.length - 1] ?? "{}") as { seq?: number }).seq ?? 0;
  assert.ok(
    lastSeq < observed.seq,
    `the commit carried seq ${String(lastSeq)}, a record appended after the snapshot was taken`,
  );
  assert.equal(
    readFileSync(repo.logPath, "utf8").trim().split("\n").length,
    lines.length + 1,
    "the working log is the committed log plus exactly the record that raced it",
  );
  assert.equal(
    publishedState(repo.dir, repo.logPath, records(repo), cadence(), TODAY).pending,
    1,
    "and the one unpublished record is that one",
  );
});
