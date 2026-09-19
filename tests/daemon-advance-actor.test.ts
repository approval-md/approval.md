/**
 * Who may advance without asking (APRV-382).
 *
 * `log.advance.daemon` is autonomous in this repository's policy and
 * `log.advance` is not, so the cycle has to know which of the two it is asking
 * under — and it must not be told by a caller. `core/daemon-actor.ts` is the
 * answer (this process, marked by the `Daemon` constructor) and
 * `core/advance-cycle.ts`'s `advanceRoute` is the rule.
 *
 * Four properties, three of them through the real append path over a real git
 * topology, in the shape `tests/daemon-advance.test.ts` established: the seed
 * records come from `core/attest.ts` and `core/gate.ts`, every record the
 * daemon writes is written by the gate, and `gh` is the only thing stubbed.
 *
 * The process mark is process-wide, so each case states which actor it is
 * rather than inheriting one: the non-daemon case clears the mark, and the
 * daemon cases construct a `Daemon`, which is what sets it in production.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

import {
  ADVANCE_ACTOR_REFUSAL,
  ADVANCE_CLASS,
  ADVANCE_DAEMON_CLASS,
  advanceRoute,
} from "../src/core/advance-cycle.js";
import { appendAttestation } from "../src/core/attest.js";
import { clearDaemonProcess, isDaemonProcess } from "../src/core/daemon-actor.js";
import { register } from "../src/core/gate.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { payloadOf, readVerifiedRecords } from "../src/core/state.js";
import { Daemon, type DaemonEvent, type DaemonOptions } from "../src/daemon/daemon.js";
import { authorizeAdvance, defaultCadence, type AdvanceInput } from "../src/daemon/advance.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-actor-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-19T09:00:00.000Z";

/** The policy the proposal page asks for: the daemon's class, and nobody else's. */
const POLICY_DAEMON_AUTONOMOUS = [
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
  "  log.advance.daemon:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

/** The policy as it stands before the page is applied: one class, no daemon line. */
const POLICY_NO_DAEMON_LINE = [
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

/** The loosening this refusal exists for: the base class granted to everybody. */
const POLICY_BASE_AUTONOMOUS = POLICY_NO_DAEMON_LINE.replace(
  "    autonomy: manual\n```",
  "    autonomy: autonomous\n```",
);

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

/** A `gh` that answers `pr list`, `pr create` and `pr merge` and reaches nothing. */
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
    '    merge) echo "armed"; exit 0 ;;',
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
  logPath: string;
  ghDir: string;
}

/** One appended record through the real append path, so an advance is owed. */
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

/** A working checkout with a policy, an attested log, a remote, and one commit. */
function newRepo(policyText: string): Repo {
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

  return { dir, logPath: join(dir, LOG_RELATIVE), ghDir: ghStub() };
}

function inputFor(repo: Repo): AdvanceInput {
  return {
    logPath: repo.logPath,
    cwd: repo.dir,
    policy: { file: join(repo.dir, "APPROVAL.md") },
    cadence: { ...defaultCadence(), base: "main", pr: false },
    today: TODAY,
  };
}

function records(repo: Repo) {
  const read = readVerifiedRecords(repo.logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

/** One daemon tick with the gh stub on PATH, as the cadence runs it. */
function runDaemon(repo: Repo): DaemonEvent[] {
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
    advance: { ...defaultCadence(), base: "main", afterRecords: 1, pr: false },
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

/** The classes the advance cycle's `task.registered` records declare. */
function registeredClasses(repo: Repo): string[] {
  const found: string[] = [];
  for (const record of records(repo)) {
    if (record.event !== "task.registered") continue;
    if (record.task?.startsWith("daemon-advance-") !== true) continue;
    const declared = payloadOf(record)["actions"];
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      const item = entry as Record<string, unknown>;
      if (typeof item["class"] === "string") found.push(item["class"]);
    }
  }
  return found;
}

function advanceEvents(events: DaemonEvent[]): Extract<DaemonEvent, { event: "advance" }>[] {
  return events.filter(
    (event): event is Extract<DaemonEvent, { event: "advance" }> => event.event === "advance",
  );
}

// ===========================================================================
// 1. The rule itself, over loaded policies, both actors
// ===========================================================================

test("advanceRoute: the daemon takes its own class only where a rule declares it", () => {
  const withLine = loadPolicyText("APPROVAL.md", POLICY_DAEMON_AUTONOMOUS);
  const daemon = advanceRoute(true, withLine);
  assert.equal(daemon.ok && daemon.cls, ADVANCE_DAEMON_CLASS);

  // No daemon line: the cadence is exactly where it was. This is the state the
  // primary checkout is in between the day this code ships and the day the
  // proposal page is applied, and gating the cadence at the fail-closed default
  // there would be a phone tap per advance for a policy that decided nothing.
  const without = loadPolicyText("APPROVAL.md", POLICY_NO_DAEMON_LINE);
  const fallback = advanceRoute(true, without);
  assert.equal(fallback.ok && fallback.cls, ADVANCE_CLASS);

  // A policy that does not load at all is the same story, more strictly: no
  // rule declares the daemon's class, so the base class is what is asked, and
  // the gate refuses it as it refuses everything under a broken policy.
  const broken = loadPolicyText("APPROVAL.md", "# no policy block here\n");
  const closed = advanceRoute(true, broken);
  assert.equal(closed.ok && closed.cls, ADVANCE_CLASS);
});

test("advanceRoute: a non-daemon actor is refused where the route would be autonomous", () => {
  const loosened = loadPolicyText("APPROVAL.md", POLICY_BASE_AUTONOMOUS);
  const refused = advanceRoute(false, loosened);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, ADVANCE_ACTOR_REFUSAL);

  // And the ordinary case, which is not a refusal: a supervised or manual class
  // is a class the gate can decide about, so a session asks under it as it
  // always has.
  const ordinary = advanceRoute(false, loadPolicyText("APPROVAL.md", POLICY_NO_DAEMON_LINE));
  assert.equal(ordinary.ok && ordinary.cls, ADVANCE_CLASS);

  // The daemon's own class never lets a non-daemon actor past either: the
  // route it gets is the base class, whatever the daemon line says.
  const withLine = advanceRoute(false, loadPolicyText("APPROVAL.md", POLICY_DAEMON_AUTONOMOUS));
  assert.equal(withLine.ok && withLine.cls, ADVANCE_CLASS);
});

// ===========================================================================
// 2. The daemon, through the gate and the real append path
// ===========================================================================

test("the daemon advances unasked under log.advance.daemon while log.advance stays manual", () => {
  const repo = newRepo(POLICY_DAEMON_AUTONOMOUS);
  appendRecord(repo.dir, "one");

  const advances = advanceEvents(runDaemon(repo));
  assert.equal(advances.length, 1, `expected one advance, got ${String(advances.length)}`);
  assert.equal(
    advances[0]?.outcome,
    "advanced",
    `the cadence did not run unattended: ${advances[0]?.message ?? ""}`,
  );

  // The class the cycle actually declared, read back off the log.
  assert.deepEqual(registeredClasses(repo), [ADVANCE_DAEMON_CLASS]);

  // Nothing was asked: an autonomous route opens no question, and the base
  // class being `manual` in this fixture is what proves the daemon's line is
  // the one that decided.
  const asked = records(repo).filter((record) => record.event === "approval.requested");
  assert.deepEqual(asked, []);
});

test("with no daemon line the cadence gates exactly as it did, under log.advance", () => {
  const repo = newRepo(POLICY_NO_DAEMON_LINE);
  appendRecord(repo.dir, "one");

  const advances = advanceEvents(runDaemon(repo));
  assert.equal(advances.length, 1);
  assert.equal(advances[0]?.outcome, "gated", advances[0]?.message ?? "");

  assert.deepEqual(registeredClasses(repo), [ADVANCE_CLASS]);
  const asked = records(repo).filter((record) => record.event === "approval.requested");
  assert.equal(asked.length, 1);
  const question = asked[0];
  assert.ok(question !== undefined);
  assert.equal(payloadOf(question)["class"], ADVANCE_CLASS);
});

// ===========================================================================
// 3. A non-daemon actor, through the same path
// ===========================================================================

test("a non-daemon actor under an autonomous rule is refused, and appends nothing", () => {
  const repo = newRepo(POLICY_BASE_AUTONOMOUS);
  appendRecord(repo.dir, "one");
  const before = records(repo).length;

  // This process is not the daemon: no `Daemon` was constructed for this
  // repository, and any mark an earlier case in this file left behind is
  // cleared here rather than assumed away.
  clearDaemonProcess();
  assert.equal(isDaemonProcess(), false);

  const auth = authorizeAdvance(inputFor(repo), records(repo));
  assert.equal(auth.authorized, false, "a session was authorized to publish the committed log");
  if (auth.authorized) return;
  assert.equal(auth.attempt.outcome, "refused");
  assert.equal(auth.attempt.code, ADVANCE_ACTOR_REFUSAL);
  assert.match(auth.attempt.message, /not the daemon/u);

  // The refusal is before the first append: no registration, no question, no
  // execution, and the log is the log it was.
  assert.equal(records(repo).length, before);
  assert.deepEqual(registeredClasses(repo), []);
});
