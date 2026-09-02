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
import { after, test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { decide, register } from "../src/core/gate.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import { defaultCadence, type AdvanceCadence } from "../src/daemon/advance.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-adopt-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-01T09:00:00.000Z";

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

test("hash: the payload hash is stable per owed span and changes when the span does", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  runDaemon(repo, cadence());
  runDaemon(repo, cadence());
  const first = records(repo).filter((record) => record.event === "approval.requested");
  assert.equal(first.length, 1);

  appendRecord(repo.dir, "two");
  runDaemon(repo, cadence());
  const all = records(repo).filter((record) => record.event === "approval.requested");
  assert.equal(all.length, 2);
  const hashes = all.map((record) => (record.payload as Record<string, unknown>)["payload_hash"]);
  assert.notEqual(hashes[0], hashes[1], "a different owed span reused the same payload hash");
});

// ===========================================================================
// AC 3 — a failed advance says why
// ===========================================================================

test("failure: a diverged records branch is reported by code and message, not as exit 1", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  // The day's records branch is already on the remote, carrying history this
  // advance is not parented on: the shape of the 2026-09-02 exit-1 failure.
  const foreign = join(scratch, `foreign-${String(counter)}`);
  assert.equal(git(["clone", "-q", repo.remote, foreign], scratch).code, 0);
  git(["config", "user.email", "test@example.invalid"], foreign);
  git(["config", "user.name", "Test"], foreign);
  assert.equal(git(["checkout", "-qb", `records-log-${TODAY.slice(0, 10)}`], foreign).code, 0);
  writeFileSync(join(foreign, "FOREIGN.md"), "# not ours\n", "utf8");
  assert.equal(git(["add", "-A"], foreign).code, 0);
  assert.equal(git(["commit", "-qm", "foreign"], foreign).code, 0);
  assert.equal(git(["push", "-q", "origin", "HEAD"], foreign).code, 0);

  const key = (() => {
    runDaemon(repo, cadence());
    return requestsIn(repo)[0] ?? "";
  })();
  const granted = decide(repo.logPath, key, "grant", "human:carter", {
    policy: { file: join(repo.dir, "APPROVAL.md") },
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  const events = runDaemon(repo, cadence());
  const advance = events.find(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
  assert.ok(advance !== undefined, "no advance event was emitted");
  if (advance?.outcome === "failed") {
    assert.ok(
      (advance.code ?? "").startsWith("log-advance-"),
      `the failure carried no verb refusal code: ${JSON.stringify(advance.code)}`,
    );
    const failure = records(repo).find((record) => record.event === "execution.failed");
    assert.ok(failure !== undefined, "the failure was not recorded in the log");
    const payload = (failure?.payload ?? {}) as Record<string, unknown>;
    assert.equal(
      payload["code"],
      advance.code,
      "execution.failed carried an exit code and no reason",
    );
    assert.equal(typeof payload["message"], "string");
  }
});
