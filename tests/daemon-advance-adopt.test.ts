/**
 * The daemon's advance adopts its open request (APRV-211).
 *
 * Three defects observed live on 2026-09-02 (primary log, seq 10166-10205) and
 * one case per defect here:
 *
 *  1. the advance re-asked on every tick, because the idempotency key embedded
 *     the log head and the head moved with the daemon's own bookkeeping;
 *  2. a grant on a daemon-minted action printed the raw execution token on the
 *     listener's terminal, the APRV-166 relay path meant for a requester in
 *     another process;
 *  3. the advance's git work ran on the same loop as the channel, so taps that
 *     arrived while it ran were answered past Telegram's window.
 *
 * Same discipline as `tests/daemon-advance.test.ts`: a real git topology with a
 * bare remote, a stubbed `gh`, and no log line written by hand. Every record is
 * written by the real gate.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,

  mkdirSync,
  mkdtempSync,

  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TelegramChannel } from "../src/channels/telegram.js";
import { lastAdvance } from "../src/core/advance-cycle.js";
import { appendAttestation } from "../src/core/attest.js";
import { decide, register } from "../src/core/gate.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import { defaultCadence, type AdvanceCadence } from "../src/daemon/advance.js";
import { assertLocal, callbackUpdate, startMockBotApi } from "./telegram-mock.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-adopt-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-01T09:00:00.000Z";

/** A plausible-looking but entirely fake bot token, as in the main suite. */
const BOT_TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";
const CHAT = "9911";

/** The advance child that holds itself open, for the one case that needs one. */
const SLOW_ADVANCE = fileURLToPath(
  new URL("../../tests/fixtures/advance/slow-advance.mjs", import.meta.url),
);

/**
 * Poll `probe` until it answers, or fail after `limitMs`.
 *
 * A loop over `setTimeout` rather than a fixed wait: the child settles when it
 * settles, and a test that slept for a guessed duration would be a flake on a
 * loaded machine and slow on an idle one.
 */
async function until<T>(probe: () => T | null, limitMs: number): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const answer = probe();
    if (answer !== null) return answer;
    if (Date.now() > deadline) throw new Error(`nothing settled within ${String(limitMs)}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every advance stops for a human, which is the shape the incident had. */
const POLICY_MANUAL = [
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
  "    autonomy: manual",
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
    '    merge) echo "the daemon must never merge" >&2; exit 3 ;;',
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

interface Repo {
  dir: string;
  remote: string;
  logPath: string;
  ghDir: string;
}

function appendRecord(dir: string, marker: string): void {
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
}

function newRepo(policyText: string = POLICY_MANUAL): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), `${MARKER_RELATIVE}\n`, "utf8");

  const attested = appendAttestation(
    join(dir, LOG_RELATIVE),
    join(dir, "APPROVAL.md"),
    "human:carter",
  );
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
  return { dir, remote, logPath: join(dir, LOG_RELATIVE), ghDir: stub.dir };
}

function runDaemon(repo: Repo, advance: AdvanceCadence): DaemonEvent[] {
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
  return events;
}

function cadence(over: Partial<AdvanceCadence> = {}): AdvanceCadence {
  return { ...defaultCadence(), base: "main", afterRecords: 1, intervalMs: 0, ...over };
}

function records(repo: Repo) {
  const read = readVerifiedRecords(repo.logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

function requestsIn(repo: Repo): string[] {
  return records(repo)
    .filter((record) => record.event === "approval.requested")
    .map((record) => record.action_key ?? "");
}

// ===========================================================================
// AC 1 — one owed advance, one question
// ===========================================================================

test("adopt: three gated ticks with nobody answering open exactly one question", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  runDaemon(repo, cadence());
  runDaemon(repo, cadence());
  runDaemon(repo, cadence());

  const keys = requestsIn(repo);
  assert.equal(
    keys.length,
    1,
    `three ticks over one owed advance opened ${String(keys.length)} questions: ${keys.join(", ")}`,
  );
});

// ===========================================================================
// AC 6 — a daemon-minted action mints nothing a surface can print
// ===========================================================================

test("self-delivery: a grant on a daemon-minted action hands the granting surface no token", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence());

  const key = requestsIn(repo)[0];
  assert.ok(key !== undefined, "the gated tick opened no question to grant");

  const granted = decide(repo.logPath, key ?? "", "grant", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  assert.equal(
    granted.token,
    undefined,
    "the grant handed the granting surface a raw token for an action the daemon requested and will consume itself",
  );
});

// ===========================================================================
// AC 2 — the decision authorises exactly one advance
// ===========================================================================

test("adopt: a grant on the open request authorises one advance on the next tick", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence());

  const key = requestsIn(repo)[0] ?? "";
  const granted = decide(repo.logPath, key, "grant", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  const events = runDaemon(repo, cadence());
  const advances = events.filter(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
  assert.equal(advances[0]?.outcome, "advanced", advances[0]?.message ?? "no advance event");
  assert.deepEqual(requestsIn(repo), [key], "the granted tick opened a second question");

  // And the authorisation is spent: the next tick has no grant left to ride on.
  const after2 = runDaemon(repo, cadence());
  const second = after2.filter(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
  assert.notEqual(second[0]?.outcome, "advanced", "one grant authorised two advances");
});

test("adopt: a rejection is honoured and nothing re-asks until the owed span changes", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence());

  const key = requestsIn(repo)[0] ?? "";
  const rejected = decide(repo.logPath, key, "reject", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.message);

  runDaemon(repo, cadence());
  runDaemon(repo, cadence());
  assert.deepEqual(requestsIn(repo), [key], "a rejected advance was asked again");

  // A new substantive record is a new owed span, and a new question.
  appendRecord(repo.dir, "two");
  runDaemon(repo, cadence());
  const keys = requestsIn(repo);
  assert.equal(keys.length, 2, "a changed owed span did not open a fresh question");
  assert.notEqual(keys[1], key, "the fresh question reused the rejected key");
});

// ===========================================================================
// AC 4 — the payload hash still moves with the owed span
// ===========================================================================

/**
 * Note the shape of this one. The span is moved between the two questions by
 * ANSWERING the first, not by letting records pile up behind it: while a
 * question is open the tick adopts it however much the owed span has grown,
 * because a grant on it publishes the log as it stands and a second question
 * about the same work is the tap this task exists to remove. What AC4 asks for —
 * one draw per DISTINCT advance, never a re-roll of the same one — is a property
 * of distinct spans, and two distinct spans are what this builds.
 */
test("hash: a different owed span is a different action, with a different payload hash", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence());
  runDaemon(repo, cadence());
  const first = records(repo).filter((record) => record.event === "approval.requested");
  assert.equal(first.length, 1, "an unanswered question was asked twice");

  const key = requestsIn(repo)[0] ?? "";
  const rejected = decide(repo.logPath, key, "reject", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.message);

  appendRecord(repo.dir, "two");
  runDaemon(repo, cadence());
  const all = records(repo).filter((record) => record.event === "approval.requested");
  assert.equal(all.length, 2);
  const hashes = all.map((record) => (record.payload as Record<string, unknown>)["payload_hash"]);
  assert.notEqual(hashes[0], hashes[1], "a different owed span reused the same payload hash");
  assert.notEqual(all[0]?.action_key, all[1]?.action_key, "two distinct spans shared one key");
});

// ===========================================================================
// AC 3 — a failed advance says why
// ===========================================================================

/**
 * What the live failure was cannot be recovered, and that IS the defect: seq
 * 10186 records `execution.failed` with `exit_code: 1` and nothing else, so the
 * only surface that outlives the daemon's event stream could not say why. What
 * is reproduced here is the SHAPE — a granted advance whose git work fails —
 * and the property is that the reason now travels with the outcome, onto
 * `execution.failed` and through `lastAdvance` onto the doctor's row. The cause
 * chosen is an unreachable remote, because it fails inside the verb, in one
 * phase, on every platform.
 */
test("failure: a failed advance is reported by code and message, not as exit 1", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  const key = (() => {
    runDaemon(repo, cadence());
    return requestsIn(repo)[0] ?? "";
  })();
  const granted = decide(repo.logPath, key, "grant", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  // The remote goes away between the decision and the advance.
  assert.equal(
    git(["remote", "set-url", "origin", join(scratch, "no-such-remote.git")], repo.dir).code,
    0,
  );

  const events = runDaemon(repo, cadence());
  const advance = events.find(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
  assert.ok(advance !== undefined, "no advance event was emitted");
  assert.equal(advance?.outcome, "failed", `the advance did not fail: ${advance?.message ?? ""}`);
  assert.ok(
    (advance?.code ?? "").startsWith("log-advance-"),
    `the failure carried no verb refusal code: ${JSON.stringify(advance?.code)}`,
  );
  const failure = records(repo).find((record) => record.event === "execution.failed");
  assert.ok(failure !== undefined, "the failure was not recorded in the log");
  const payload = (failure?.payload ?? {}) as Record<string, unknown>;
  assert.equal(payload["exit_code"], 1, "the failure lost its exit code");
  assert.equal(
    payload["code"],
    advance?.code,
    "execution.failed carried an exit code and no reason",
  );
  assert.equal(typeof payload["message"], "string");

  // And the doctor's row — the surface an operator reads hours later, in
  // another process — carries the same two fields off the log.
  const last = lastAdvance(records(repo));
  assert.equal(last?.outcome, "failed");
  assert.equal(last?.code, advance?.code, "the doctor row could not say why the advance failed");
  assert.equal(typeof last?.message, "string");
});

// ===========================================================================
// AC 7 — the advance runs off the channel loop
// ===========================================================================

/**
 * The second half of the 2026-09-02 incident: `answerCallbackQuery: HTTP 400`,
 * repeatedly, around the grants. Telegram drops a callback query that is not
 * answered inside its window; `approval up` runs the daemon and the listener on
 * ONE loop; and the advance is `spawnSync` from `git fetch` to `gh pr create`.
 * So every tap that arrived during an advance waited for the push, and the
 * human got a button that never toasted.
 *
 * The pre-fix behaviour needs no test to be established, because it is not a
 * bug in any branch: synchronous work on a single-threaded loop delays
 * everything else on that loop, by construction, whatever it is wrapped in.
 * What needs proving is that the advance no longer runs there. So: a real
 * daemon, a real Bot API listener over loopback, and an advance child that
 * holds itself open for five seconds. The tap must be answered while it is
 * still open.
 */
test("off the loop: a tap is answered while an advance is in flight", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence());

  const key = requestsIn(repo)[0] ?? "";
  const granted = decide(repo.logPath, key, "grant", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  const mock = await startMockBotApi(BOT_TOKEN);
  const events: DaemonEvent[] = [];
  const daemon = new Daemon({
    logPath: repo.logPath,
    tasksDir: join(repo.dir, "backlog", "tasks"),
    queuePath: join(repo.dir, QUEUE_RELATIVE),
    policy: { file: join(repo.dir, "APPROVAL.md") },
    cwd: repo.dir,
    // One tick and no second: this is about what happens DURING the first.
    intervalMs: 3_600_000,
    debounceMs: 10,
    once: false,
    today: TODAY,
    sink: { emit: (event) => events.push(event) },
    advance: cadence(),
    advanceRunner: { command: process.execPath, args: [SLOW_ADVANCE] },
  });

  const channel = new TelegramChannel({
    token: BOT_TOKEN,
    chatId: CHAT,
    apiBase: assertLocal(mock.url),
    pollTimeoutSeconds: 0,
    requestTimeoutMs: 3_000,
    backoffMs: 5,
    maxBackoffMs: 20,
    log: () => {},
  });

  // The tick runs on this stack: it adopts the grant, appends
  // `execution.started`, spawns the child, and returns to the loop.
  const stopped = daemon.run();
  const advancesSoFar = (): number => events.filter((event) => event.event === "advance").length;
  assert.equal(advancesSoFar(), 0, "the advance settled on the tick's own stack");
  assert.equal(
    records(repo).filter((record) => record.event === "execution.started").length,
    1,
    "the tick did not start the execution it was authorised for",
  );

  // A tap arrives. Nothing about it touches the log — an unplaceable callback is
  // acked and dropped — because what is being measured is the LOOP, and a loop
  // held by a synchronous advance answers nothing at all.
  mock.queueUpdate(callbackUpdate({ data: "not-a-callback", chatId: CHAT }));
  const asked = performance.now();
  await channel.pollOnce();
  const waited = performance.now() - asked;

  assert.equal(mock.answerTexts().length, 1, "the tap was never answered");
  assert.ok(waited < 1_000, `the tap waited ${String(Math.round(waited))}ms for an ack`);
  assert.equal(advancesSoFar(), 0, "the advance had already finished; nothing was in flight");

  // And it does settle, in the daemon's own process, with the child's refusal
  // reason carried onto the event stream and into the log.
  const settled = await until(() => (advancesSoFar() > 0 ? events : null), 20_000);
  const advance = settled.find(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
  assert.equal(advance?.outcome, "failed");
  assert.equal(advance?.code, "log-advance-push-rejected");

  daemon.stop("test over");
  await stopped;
  await mock.close();

  const failure = records(repo).find((record) => record.event === "execution.failed");
  assert.ok(failure !== undefined, "the child's outcome was never recorded");
  assert.equal(
    ((failure?.payload ?? {}) as Record<string, unknown>)["code"],
    "log-advance-push-rejected",
    "the child's reason did not reach the log",
  );
});
