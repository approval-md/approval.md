/**
 * The dangling-advance sweep, and what it leaves for a person (APRV-264).
 *
 * ## The morning these cases are written against
 *
 * 2026-09-05, after the APRV-233 build went live. `approval status` listed FIVE
 * dangling daemon log-advance executions, left by the 2026-09-02 advance loop
 * and by the restarts after it. APRV-233's reconcile rule closes the LAST open
 * cycle and only when `publishedState` proves the push landed, so the daemon
 * refused one advance per tick naming one key each:
 *
 *   `advance-refused: the advance daemon-log-advance-1-14867 was started and
 *    its outcome was never recorded`
 *
 * — and the operator closed all five by hand, with five near-identical
 * `approval execution resolve` commands, in a second terminal window. Five
 * copy-pasted commands for one fact is the manual step the cadence exists to
 * remove.
 *
 * Three properties, three sections, matching the task's acceptance criteria.
 * Every case builds a real git topology with a bare remote and drives real
 * `git`; `gh` is the one thing stubbed, because it is the one thing that would
 * reach the network. Nothing here writes a log line by hand: every record is
 * written by the real gate through the real append path, including the dangling
 * cycles themselves, which are opened with the same three core calls
 * `authorizeAdvance` makes and then simply never closed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import {
  ADVANCE_ACTOR,
  ADVANCE_CLASS,
  RESOLVE_DANGLING_COMMAND,
  advanceActionKey,
  advanceTaskId,
} from "../src/core/advance-cycle.js";
import { danglingExecutions, startExecution } from "../src/core/execute.js";
import { register, request } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { verify } from "../src/core/verify.js";
import { logAdvance, publishedState } from "../src/cli/log-advance.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import {
  advanceArgv,
  authorizeAdvance,
  defaultCadence,
  type AdvanceCadence,
  type AdvanceInput,
} from "../src/daemon/advance.js";

/** dist/tests/daemon-advance-sweep.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-sweep-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-05T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-05";

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

function danglingKeys(repo: Repo): string[] {
  return danglingExecutions([...records(repo)]).map((entry) => entry.actionKey);
}

/** Every record for one action key, in log order. */
function eventsFor(repo: Repo, actionKey: string): string[] {
  return records(repo)
    .filter((record) => record.action_key === actionKey)
    .map((record) => record.event);
}

/** The payload of the outcome record for a key, or `{}`. */
function outcomePayload(repo: Repo, actionKey: string): Record<string, unknown> {
  const record = records(repo).find(
    (entry) => entry.action_key === actionKey && entry.event === "execution.completed",
  );
  const payload = record?.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Open one advance cycle and never close it: the 2026-09-02 residue, made to
 * order.
 *
 * The same three core calls `authorizeAdvance` makes, in the same order, with
 * the same actor, class, task shape, key shape and payload hash — register,
 * request, `startExecution` — and then nothing. Going through
 * `authorizeAdvance` itself cannot build a PILE, because since APRV-233 it
 * refuses `advance-unreconciled` over the first one; the pile was built by the
 * pre-APRV-233 daemon, which asked no such question, and by the restarts that
 * followed it.
 */
function openAdvanceCycle(repo: Repo, from: number, to: number): string {
  const actionKey = advanceActionKey(from, to);
  const task = advanceTaskId(to);
  const gate = { policy: { file: repo.policyPath } };
  const hash = payloadHash({
    argv: advanceArgv(cadence()),
    cwd: repo.dir,
    seq: { from, to },
  });
  const registered = register(
    repo.logPath,
    {
      task,
      envelope: {
        origin: { app: "approval-daemon", created_by: ADVANCE_ACTOR },
        state: "proposed",
        actions: [
          {
            class: ADVANCE_CLASS,
            idempotency_key: actionKey,
            summary: `log advance: seq ${String(from)}..${String(to)} onto ${RECORDS_BRANCH}`,
            reversible: true,
            est_cost_usd: "0",
            payload_hash: hash,
          },
        ],
      },
    },
    ADVANCE_ACTOR,
    gate,
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const asked = request(
    repo.logPath,
    {
      task,
      actionKey,
      cls: ADVANCE_CLASS,
      reversible: true,
      est_cost_usd: "0",
      summary: `log advance: seq ${String(from)}..${String(to)}`,
      payload_hash: hash,
      payload: {
        value: { argv: advanceArgv(cadence()), cwd: repo.dir, seq: { from, to } },
      },
      delivery: "self",
    },
    ADVANCE_ACTOR,
    gate,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);
  assert.equal(asked.ok && asked.proceed, true, "the fixture policy runs log.advance unasked");

  const started = startExecution(
    repo.logPath,
    actionKey,
    { policy: { file: repo.policyPath }, presentedPayloadHash: hash },
    ADVANCE_ACTOR,
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  return actionKey;
}

/** Publish everything in the working log onto the day's records branch. */
function publish(repo: Repo): void {
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
}

/**
 * One synchronous tick plus the shutdown flush, with the gh stub on PATH.
 *
 * `once` makes the whole run synchronous — the tick, the flush and the
 * `stopped` line are all emitted before `run()` returns its already-settled
 * promise — so the log is in its final state by the time this returns. It is
 * also exactly the two passes the sweep case needs: the tick sweeps and does
 * nothing else, and the flush, which ignores the interval and the count, is the
 * pass that proves the cadence resumed once the books were closed.
 */
function runOnce(repo: Repo, advance: AdvanceCadence): DaemonEvent[] {
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
    advance,
  };
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  try {
    void new Daemon(options).run();
  } finally {
    process.env["PATH"] = previous;
  }
  return events;
}

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
    intervalMs: 120,
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
    }, 40);
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

function warnings(events: DaemonEvent[]): Extract<DaemonEvent, { event: "warning" }>[] {
  return events.filter(
    (event): event is Extract<DaemonEvent, { event: "warning" }> => event.event === "warning",
  );
}

/** The `log-advance-cadence` row, from the real verb in a real child process. */
function cadenceRow(repo: Repo): { status: string; detail: string; fix?: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, "doctor", "--json"], {
    cwd: repo.dir,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  const report = JSON.parse(result.stdout.trim()) as {
    checks: { check: string; status: string; detail: string; fix?: string }[];
  };
  const row = report.checks.find((entry) => entry.check === "log-advance-cadence");
  assert.ok(row !== undefined, "approval doctor printed no log-advance-cadence row");
  return row;
}

function startedLine(events: DaemonEvent[]): Extract<DaemonEvent, { event: "started" }> {
  const line = events.find(
    (event): event is Extract<DaemonEvent, { event: "started" }> => event.event === "started",
  );
  assert.ok(line !== undefined, "the daemon printed no started line");
  return line;
}

// ===========================================================================
// AC 1 — three provable cycles, closed on one tick, and then an advance
// ===========================================================================

test("sweep: three dangling advances the trunk carries are all closed on the first tick", () => {
  const repo = newRepo();

  // Three cycles, each opened over a different owed span and none of them
  // closed. This is the 2026-09-05 pile: one per restart of the loop.
  const keys: string[] = [];
  let from = 1;
  for (const marker of ["one", "two", "three"]) {
    const filler = appendRecord(repo.dir, marker);
    assert.equal(filler.ok, true);
    keys.push(openAdvanceCycle(repo, from, filler.seq));
    from = filler.seq + 1;
  }
  assert.deepEqual(danglingKeys(repo), keys, "the fixture is the pile itself");

  // The push that really happened and whose outcome records were lost: every
  // seq those three keys named is now on the day's records branch.
  publish(repo);
  const state = publishedState(repo.dir, repo.logPath, records(repo), cadence(), TODAY);
  const ref = state.publishedRev;
  assert.ok(ref !== null, "the fixture published nothing");

  // One substantive record after the publish, so that the tick AFTER the sweep
  // has something to advance and the case can prove the cadence resumed.
  assert.equal(appendRecord(repo.dir, "after").ok, true);

  const events = runOnce(repo, cadence({ afterRecords: 1, intervalMs: 3_600_000 }));

  // All three, on one pass, each with the ref that proved it named in the line.
  const reconciled = advances(events).filter((event) => event.code === "advance-reconciled");
  assert.equal(
    reconciled.length,
    3,
    `expected three reconciliations, got ${JSON.stringify(advances(events))}`,
  );
  for (const key of keys) {
    assert.ok(
      reconciled.some((event) => event.message.includes(key) && event.message.includes(ref)),
      `${key} was not reported as reconciled against ${ref}`,
    );
    assert.deepEqual(eventsFor(repo, key), ["execution.started", "execution.completed"]);
    // The RECORD names the ref too, and says whose observation it is. A reader
    // a month later must not have to infer from the actor alone that this
    // completion came from the runtime reading its own refs.
    const payload = outcomePayload(repo, key);
    assert.equal(payload["exit_code"], 0);
    assert.equal(payload["code"], "advance-reconciled");
    assert.ok(
      String(payload["message"]).includes(ref),
      `the record does not name the ref that proved it: ${String(payload["message"])}`,
    );
    assert.match(String(payload["message"]), /not attested by a human/u);
    assert.notEqual(payload["attested_by_human"], true, "the runtime does not attest for a person");
  }
  assert.deepEqual(danglingKeys(repo), [], "the pile is gone, and the advance closed its own books");

  // And the cadence resumed: with the books closed, the flush advanced.
  assert.ok(
    advances(events).some((event) => event.outcome === "advanced"),
    `the cadence did not resume: ${JSON.stringify(advances(events).map((event) => event.outcome))}`,
  );
  assert.equal(verify(repo.logPath).status, "clean");
});

// ===========================================================================
// AC 2 — what nothing can prove is reported once, and names the bulk command
// ===========================================================================

test("sweep: an unprovable cycle is named on the started line and warned about no more", async () => {
  const repo = newRepo();
  const filler = appendRecord(repo.dir, "one");
  // Never published: no ref in this checkout carries the seq this key names.
  const key = openAdvanceCycle(repo, 1, filler.seq);
  const before = records(repo).length;

  // Twenty-odd ticks at 120 ms. Before APRV-264 the count of reports would be
  // the count of ticks.
  const events = await runFor(
    repo,
    { advance: cadence({ afterRecords: 1, intervalMs: 3_600_000 }) },
    3_000,
  );

  const started = startedLine(events);
  assert.deepEqual(
    started.dangling_advances,
    [key],
    "the started line does not name what is blocking the cadence",
  );
  const refusals = warnings(events).filter((event) => event.code === "advance-refused");
  assert.equal(
    refusals.length,
    0,
    `the started line already reported it; the ticks said it ${String(refusals.length)} more times`,
  );
  // Nothing was written for it, and nothing was pushed over it.
  assert.deepEqual(danglingKeys(repo), [key], "an unprovable outcome must not be invented");
  assert.equal(records(repo).length, before, "the sweep appended something it could not prove");
  assert.equal(
    advances(events).filter((event) => event.outcome === "advanced").length,
    0,
    "an advance was started over a cycle nobody has accounted for",
  );

  // The second surface, and the one that outlives the daemon's event stream: a
  // different process, reading only the log and git's refs, says the same thing
  // and offers the same command. An operator who was not tailing the daemon
  // must still be able to find out why the cadence stopped.
  const row = cadenceRow(repo);
  assert.ok(row.detail.includes(key), `the doctor row does not name it: ${row.detail}`);
  assert.ok(
    String(row.fix ?? "").includes(RESOLVE_DANGLING_COMMAND),
    `the doctor row does not carry the repair: ${String(row.fix)}`,
  );
  assert.equal(verify(repo.logPath).status, "clean");
});

test("sweep: a cycle that appears mid-run is warned about once, not once per tick", async () => {
  const repo = newRepo();
  assert.equal(appendRecord(repo.dir, "one").ok, true);

  let key = "";
  const events = await runFor(
    repo,
    // A cadence that will never fire on its own, so the only thing the ticks do
    // is sweep: the count below is a count of REPORTS and not of attempts.
    { advance: cadence({ afterRecords: 1_000, intervalMs: 3_600_000 }) },
    3_000,
    () => {
      if (key !== "") return;
      const filler = appendRecord(repo.dir, "mid-run");
      key = openAdvanceCycle(repo, 1, filler.seq);
    },
  );

  assert.notEqual(key, "", "the case never opened its cycle");
  assert.deepEqual(startedLine(events).dangling_advances, [], "it did not exist at startup");
  const refusals = warnings(events).filter((event) => event.code === "advance-refused");
  assert.equal(
    refusals.length,
    1,
    `expected exactly one report, got ${JSON.stringify(refusals.map((event) => event.message))}`,
  );
  const message = refusals[0]?.message ?? "";
  assert.ok(message.includes(key), `the report does not name the key: ${message}`);
  assert.ok(
    message.includes(RESOLVE_DANGLING_COMMAND),
    `the report does not carry the one command that clears it: ${message}`,
  );
  assert.equal(verify(repo.logPath).status, "clean");
});

test("sweep: the advance refusal names EVERY outstanding key and the bulk command", () => {
  const repo = newRepo();
  const first = appendRecord(repo.dir, "one");
  const keyOne = openAdvanceCycle(repo, 1, first.seq);
  const second = appendRecord(repo.dir, "two");
  const keyTwo = openAdvanceCycle(repo, first.seq + 1, second.seq);
  assert.equal(appendRecord(repo.dir, "three").ok, true);

  // The authorization, asked directly: the sweep runs before it on every tick,
  // so this is what an operator sees when the sweep could settle nothing.
  const auth = authorizeAdvance(inputFor(repo), records(repo));
  assert.equal(auth.authorized, false);
  if (auth.authorized) throw new Error("unreachable");
  assert.equal(auth.attempt.outcome, "refused");
  assert.equal(auth.attempt.code, "advance-unreconciled");
  // BOTH keys. The 2026-09-05 refusal named one, so the operator learned about
  // the second only after closing the first.
  const message = auth.attempt.message;
  assert.ok(message.includes(keyOne), message);
  assert.ok(message.includes(keyTwo), message);
  assert.ok(message.includes(RESOLVE_DANGLING_COMMAND), message);
  assert.equal(verify(repo.logPath).status, "clean");
});
