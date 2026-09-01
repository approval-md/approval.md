/**
 * Genuine concurrency: two processes racing to spend one execution token
 * (APRV-20 finding B1, human-named requirement).
 *
 * Everything else in this suite exercises the runtime one call at a time. This
 * file is the one place where two *real* OS processes hold the same log at the
 * same time, because the property under test — a single-use token cannot be
 * spent twice — is a property of the interleaving, and an interleaving cannot be
 * faked by calling a function twice.
 *
 * ## How the race is made deterministic
 *
 * A plain `spawn` of two consumers is a coin flip: whichever reads the log after
 * the winner wrote sees the winner's `execution.started` and refuses
 * `token-consumed`, which proves the *other* guard rather than compare-and-append.
 * So the parent forces the interesting interleaving:
 *
 * 1. the parent takes the append lockfile itself, before either child starts;
 * 2. both children start and block on a sentinel file, then call `consumeToken`;
 * 3. each child's read of the log therefore happens while the lock is held, so
 *    **both children verify against the same log** — neither can observe the
 *    other's write, because no write is possible yet;
 * 4. both children then block inside `appendEvent`, waiting for the lock;
 * 5. the parent releases the lock. One child takes it and appends. The other
 *    takes it next, finds the head moved under the lock, and is refused.
 *
 * The lock is held across both children's reads, which is what makes the
 * head-moved refusal the *expected* outcome rather than a lucky one. The
 * invariant that matters — never two `execution.started` records — is asserted
 * on every round regardless.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { decide, register, request, appendAttestation } from "./clock-adapters.js";
import type { EventRecord } from "../src/core/log.js";
import { verify } from "../src/core/verify.js";

/** dist/tests/concurrency.test.js -> dist/src/core/token.js */
const TOKEN_MODULE = fileURLToPath(new URL("../src/core/token.js", import.meta.url));

/** Same relationship, for the APRV-106 grant/withdraw race. */
const GATE_MODULE = fileURLToPath(new URL("../src/core/gate.js", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "approval-md-race-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";
const ACTION_KEY = "task-042:chaser";

/** The content binding both racers present (amended SPEC.md §6.2, §10, A1). */
const PAYLOAD_HASH = "2".repeat(64);

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/**
 * The child: waits on the `go` sentinel, then spends the token.
 *
 * Written as a file rather than `-e` so the import specifier is a real path and
 * the child runs exactly the module the parent is testing.
 */
const CHILD_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { consumeToken } from ${JSON.stringify(TOKEN_MODULE)};

const [logPath, actionKey, token, ts, actor, policyFile, payloadHash, ready, go] =
  process.argv.slice(2);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

writeFileSync(ready, "ready", "utf8");
while (!existsSync(go)) sleep(2);

// A2: no ts parameter — the runtime stamps gate events. The race needs a fixed
// instant, so it is injected as a clock, which is the sanctioned path.
// A1: the payload binding is presented, exactly as \`approval run\` presents it.
const result = consumeToken(logPath, actionKey, token, actor, {
  policyFile,
  presentedPayloadHash: payloadHash,
  clock: () => ts,
});
process.stdout.write(JSON.stringify(result));
`;

interface Consumer {
  ok: boolean;
  code?: string;
  message?: string;
  append?: { code: string; message: string };
  record?: EventRecord;
}

interface RaceCase {
  dir: string;
  logPath: string;
  policyPath: string;
  token: string;
}

/**
 * Attested, registered and requested: one PENDING request, undecided.
 *
 * The state the APRV-106 race starts from — the moment the message is on the
 * approver's phone and the requester's clock is still running.
 */
function pendingCase(): RaceCase {
  counter += 1;
  const dir = join(scratch, `race-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const options = { policy: { file: policyPath } };

  assert.equal(appendAttestation(logPath, policyPath, "human:carter", T0).ok, true);
  const registered = register(
    logPath,
    {
      task: "task-042",
      envelope: {
        origin: { app: "example-capture", created_by: "human:carter" },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            summary: "Send deposit chaser",
            reversible: false,
            est_cost_usd: "0.02",
            idempotency_key: ACTION_KEY,
            payload_hash: PAYLOAD_HASH,
          },
        ],
      },
    },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const requested = request(
    logPath,
    {
      task: "task-042",
      actionKey: ACTION_KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      payload_hash: PAYLOAD_HASH,
    },
    at(1),
    "agent:claude",
    options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);

  return { dir, logPath, policyPath, token: "" };
}

/** Attested, registered, requested and granted: exactly one live token. */
function grantedCase(): RaceCase {
  counter += 1;
  const dir = join(scratch, `race-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const options = { policy: { file: policyPath } };

  assert.equal(appendAttestation(logPath, policyPath, "human:carter", T0).ok, true);
  const registered = register(
    logPath,
    {
      task: "task-042",
      envelope: {
        origin: { app: "example-capture", created_by: "human:carter" },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            summary: "Send deposit chaser",
            reversible: false,
            est_cost_usd: "0.02",
            idempotency_key: ACTION_KEY,
            payload_hash: PAYLOAD_HASH,
          },
        ],
      },
    },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const requested = request(
    logPath,
    {
      task: "task-042",
      actionKey: ACTION_KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      payload_hash: PAYLOAD_HASH,
    },
    at(1),
    "agent:claude",
    options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);

  const granted = decide(logPath, ACTION_KEY, "grant", "human:carter", at(2), options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");

  return { dir, logPath, policyPath, token: granted.token };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function records(logPath: string): EventRecord[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function runChild(script: string, args: string[]): Promise<Consumer> {
  return new Promise((resolveOutcome, reject) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      if (stdout.length === 0) {
        reject(new Error(`consumer produced no output; stderr: ${stderr}`));
        return;
      }
      resolveOutcome(JSON.parse(stdout) as Consumer);
    });
  });
}

/**
 * The APRV-106 race: the approver's thumb and the requester's timeout.
 *
 * This is the interleaving the incident produces in miniature. A human is
 * looking at the Telegram message and taps Approve at the same instant the
 * requesting process gives up and withdraws. Both read a log that says
 * `requested`; both are therefore authorized, by their own lights, to append.
 *
 * The invariant is that the log records exactly ONE of them — never a grant
 * whose request was withdrawn out from under it, and never a withdrawal that
 * quietly erased a human's answer — and that the loser learns it lost on the
 * compare-and-append precondition (SPEC.md §11.1(5)) rather than by re-reading.
 * Either winner is correct; which one wins is a coin flip and the test does not
 * care, because both outcomes are states the rest of the runtime handles.
 *
 * Same mechanism as the token race above: the parent holds the append lock
 * across both children's reads, so both verify against the same log.
 */
const DECIDER_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { decide, withdraw } from ${JSON.stringify(GATE_MODULE)};

const [verb, logPath, actionKey, actor, ts, policyFile, ready, go] = process.argv.slice(2);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

writeFileSync(ready, "ready", "utf8");
while (!existsSync(go)) sleep(2);

const options = { policy: { file: policyFile }, clock: () => ts };
const result =
  verb === "grant"
    ? decide(logPath, actionKey, "grant", actor, options)
    : withdraw(logPath, actionKey, actor, { ...options, reason: "timeout" });
process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code, append: result.append }));
`;

test("a grant and a withdrawal race one pending request: exactly one lands", async () => {
  const script = join(scratch, "decide-or-withdraw.mjs");
  writeFileSync(script, DECIDER_SOURCE, "utf8");

  for (let round = 1; round <= 3; round += 1) {
    const unit = pendingCase();
    const go = join(unit.dir, "go");
    const readyA = join(unit.dir, "ready-a");
    const readyB = join(unit.dir, "ready-b");
    const lock = `${unit.logPath}.lock`;

    closeSync(openSync(lock, "wx"));

    const granting = runChild(script, [
      "grant",
      unit.logPath,
      ACTION_KEY,
      "human:carter",
      at(3),
      unit.policyPath,
      readyA,
      go,
    ]);
    const withdrawing = runChild(script, [
      "withdraw",
      unit.logPath,
      ACTION_KEY,
      "agent:claude",
      at(3),
      unit.policyPath,
      readyB,
      go,
    ]);

    const deadline = Date.now() + 10_000;
    while (!(existsSync(readyA) && existsSync(readyB))) {
      assert.ok(Date.now() < deadline, "children never signalled ready");
      sleep(5);
    }

    writeFileSync(go, "go", "utf8");
    sleep(250);
    unlinkSync(lock);

    const outcomes = await Promise.all([granting, withdrawing]);
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `round ${round}: expected exactly one winner`);
    assert.equal(losers.length, 1, `round ${round}: expected exactly one loser`);

    // THE invariant: the request was settled once. Never a grant AND a
    // withdrawal for the same request.
    const settling = records(unit.logPath).filter(
      (record) =>
        record.action_key === ACTION_KEY &&
        (record.event === "approval.granted" || record.event === "approval.withdrawn"),
    );
    assert.equal(settling.length, 1, `round ${round}: the request was settled twice`);

    const loser = losers[0] as Consumer;
    assert.equal(loser.code, "append-failed", `round ${round}: ${JSON.stringify(loser)}`);
    assert.equal(loser.append?.code, "head-moved", `round ${round}: ${JSON.stringify(loser)}`);

    assert.equal(verify(unit.logPath).status, "clean", `round ${round}: log not clean`);
  }
});

test("two concurrent processes race one token: exactly one execution.started", async () => {
  const script = join(scratch, "consume.mjs");
  writeFileSync(script, CHILD_SOURCE, "utf8");

  // Three rounds. The invariant is asserted on every one of them: a single
  // passing round could be luck, and the property is worth more than one sample.
  for (let round = 1; round <= 3; round += 1) {
    const unit = grantedCase();
    const go = join(unit.dir, "go");
    const readyA = join(unit.dir, "ready-a");
    const readyB = join(unit.dir, "ready-b");
    const lock = `${unit.logPath}.lock`;

    // The parent takes the append lock first: nothing can be appended until it
    // lets go, so both children necessarily read the same log.
    closeSync(openSync(lock, "wx"));

    const first = runChild(script, [
      unit.logPath,
      ACTION_KEY,
      unit.token,
      at(3),
      "agent:claude",
      unit.policyPath,
      PAYLOAD_HASH,
      readyA,
      go,
    ]);
    const second = runChild(script, [
      unit.logPath,
      ACTION_KEY,
      unit.token,
      at(3),
      "agent:mallory",
      unit.policyPath,
      PAYLOAD_HASH,
      readyB,
      go,
    ]);

    // Both children are up and blocked on the sentinel.
    const deadline = Date.now() + 10_000;
    while (!(existsSync(readyA) && existsSync(readyB))) {
      assert.ok(Date.now() < deadline, "children never signalled ready");
      sleep(5);
    }

    writeFileSync(go, "go", "utf8");
    // Both children read the log and reach `appendEvent` inside this window,
    // where they block on the lock the parent still holds.
    sleep(250);
    unlinkSync(lock);

    const outcomes = await Promise.all([first, second]);

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `round ${round}: expected exactly one winner`);
    assert.equal(losers.length, 1, `round ${round}: expected exactly one loser`);

    // THE invariant: one token, one execution.
    const started = records(unit.logPath).filter(
      (record) => record.event === "execution.started" && record.action_key === ACTION_KEY,
    );
    assert.equal(started.length, 1, `round ${round}: expected exactly one execution.started`);

    // The loser lost under the lock, on the compare-and-append precondition —
    // not by re-reading, because the core never retries.
    const loser = losers[0] as Consumer;
    assert.equal(loser.code, "append-failed", `round ${round}: ${JSON.stringify(loser)}`);
    assert.equal(loser.append?.code, "head-moved", `round ${round}: ${JSON.stringify(loser)}`);
    assert.match(String(loser.append?.message), /head moved/);

    // And the log the winner left behind is a clean chain.
    assert.equal(verify(unit.logPath).status, "clean", `round ${round}: log not clean`);
  }
});

// ===========================================================================
// The benign race the hook used to lose (APRV-150)
// ===========================================================================

/**
 * The incident, in miniature. Two sessions run under the Claude Code hook at
 * the same time. Each resolves its command to an autonomous class, each reads
 * the log head, each appends its own `execution.started` against that head. One
 * lands second and is refused `head-moved` — correctly, because its checks were
 * made against an older log — and the hook printed a DENY for a `git status` no
 * human had a question about.
 *
 * The same harness as the two races above, and the same reason for it: the
 * parent holds the append lock across both children's reads, so both are
 * provably authorized by the same log and the second append provably meets a
 * moved head. Nothing here writes a record by hand — every event in these logs
 * is written by the real gate through the real append path.
 *
 * `attempts` is the seam that lets one harness pin both shapes. `1` is the
 * pre-APRV-150 writer (one read, one set of checks, one append); the default is
 * the fix.
 */
const STARTER_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { startHarnessExecution } from ${JSON.stringify(GATE_MODULE)};

const [logPath, task, actionKey, cls, hash, ts, actor, policyFile, attempts, ready, go] =
  process.argv.slice(2);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

writeFileSync(ready, "ready", "utf8");
while (!existsSync(go)) sleep(2);

const options = { policy: { file: policyFile }, clock: () => ts };
if (attempts !== "default") options.retryOnHeadMoved = Number(attempts);

const result = startHarnessExecution(
  logPath,
  { task, actionKey, cls, payload_hash: hash },
  actor,
  options,
);
process.stdout.write(
  JSON.stringify({
    ok: result.ok,
    code: result.code,
    message: result.message,
    append: result.append,
  }),
);
`;

const HARNESS_TASK = "task-150";
const HARNESS_CLASS = "read.shell";

/** An attested policy where `read.shell` needs no human, with an optional ceiling. */
function harnessPolicy(dailyActions: number | null): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    ...(dailyActions === null
      ? []
      : ["budgets:", "  global:", `    daily_actions: ${String(dailyActions)}`]),
    "classes:",
    `  ${HARNESS_CLASS}:`,
    "    autonomy: autonomous",
    "```",
    "",
  ].join("\n");
}

/** A log holding exactly one attestation: the state a fresh session starts in. */
function harnessCase(dailyActions: number | null = null): RaceCase {
  counter += 1;
  const dir = join(scratch, `race-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, harnessPolicy(dailyActions), "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");

  assert.equal(appendAttestation(logPath, policyPath, "human:carter", T0).ok, true);
  return { dir, logPath, policyPath, token: "" };
}

/** Two harness starts, forced to authorize themselves against the same log. */
async function raceHarnessStarts(
  script: string,
  unit: RaceCase,
  keys: [string, string],
  attempts: "default" | number,
): Promise<Consumer[]> {
  const go = join(unit.dir, "go");
  const readyA = join(unit.dir, "ready-a");
  const readyB = join(unit.dir, "ready-b");
  const lock = `${unit.logPath}.lock`;

  // Nothing can be appended until the parent lets go, so both children
  // necessarily verify against the same head.
  closeSync(openSync(lock, "wx"));

  const children = keys.map((key, index) =>
    runChild(script, [
      unit.logPath,
      HARNESS_TASK,
      key,
      HARNESS_CLASS,
      PAYLOAD_HASH,
      at(3),
      index === 0 ? "agent:claude" : "agent:mallory",
      unit.policyPath,
      attempts === "default" ? "default" : String(attempts),
      index === 0 ? readyA : readyB,
      go,
    ]),
  );

  const deadline = Date.now() + 10_000;
  while (!(existsSync(readyA) && existsSync(readyB))) {
    assert.ok(Date.now() < deadline, "children never signalled ready");
    sleep(5);
  }

  writeFileSync(go, "go", "utf8");
  // Both children read the log and reach `appendEvent` inside this window,
  // where they block on the lock the parent still holds.
  sleep(250);
  unlinkSync(lock);

  return await Promise.all(children);
}

function startsIn(logPath: string): EventRecord[] {
  return records(logPath).filter((record) => record.event === "execution.started");
}

test("an unretried harness start that loses the race is denied head-moved (the pre-APRV-150 shape)", async () => {
  const script = join(scratch, "harness-start.mjs");
  writeFileSync(script, STARTER_SOURCE, "utf8");

  for (let round = 1; round <= 3; round += 1) {
    const unit = harnessCase();
    const outcomes = await raceHarnessStarts(
      script,
      unit,
      [`${HARNESS_TASK}:a`, `${HARNESS_TASK}:b`],
      1,
    );

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `round ${round}: expected exactly one winner`);
    assert.equal(losers.length, 1, `round ${round}: expected exactly one loser`);

    // The defect, pinned: two commands, two different idempotency keys, no
    // shared verdict of any kind, and one of them denied because the other
    // wrote first.
    const loser = losers[0] as Consumer;
    assert.equal(loser.code, "append-failed", `round ${round}: ${JSON.stringify(loser)}`);
    assert.equal(loser.append?.code, "head-moved", `round ${round}: ${JSON.stringify(loser)}`);
    assert.equal(startsIn(unit.logPath).length, 1, `round ${round}: expected one start`);
    assert.equal(verify(unit.logPath).status, "clean", `round ${round}: log not clean`);
  }
});

test("a harness start that loses the race re-derives its verdict and lands (APRV-150)", async () => {
  const script = join(scratch, "harness-start.mjs");
  writeFileSync(script, STARTER_SOURCE, "utf8");

  for (let round = 1; round <= 3; round += 1) {
    const unit = harnessCase();
    const outcomes = await raceHarnessStarts(
      script,
      unit,
      [`${HARNESS_TASK}:a`, `${HARNESS_TASK}:b`],
      "default",
    );

    // Both commands were autonomous under an attested policy and neither
    // verdict depended on the other's record. Both run.
    for (const outcome of outcomes) {
      assert.equal(outcome.ok, true, `round ${round}: ${JSON.stringify(outcome)}`);
    }
    assert.equal(startsIn(unit.logPath).length, 2, `round ${round}: expected two starts`);
    assert.equal(verify(unit.logPath).status, "clean", `round ${round}: log not clean`);
  }
});

test("the retry re-derives rather than re-appends: a spent key is refused already-executed", async () => {
  const script = join(scratch, "harness-start.mjs");
  writeFileSync(script, STARTER_SOURCE, "utf8");

  for (let round = 1; round <= 3; round += 1) {
    const unit = harnessCase();
    // The state that flips between the read and the append: both racers hold
    // the SAME idempotency key, so the winner's record makes the loser's key
    // single-use-spent. A blind re-append would write a second start for one
    // key; re-running the checks refuses it.
    const outcomes = await raceHarnessStarts(
      script,
      unit,
      [`${HARNESS_TASK}:shared`, `${HARNESS_TASK}:shared`],
      "default",
    );

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `round ${round}: expected exactly one winner`);
    assert.equal(losers.length, 1, `round ${round}: expected exactly one loser`);

    const loser = losers[0] as Consumer;
    // The NEW verdict, in the gate's own vocabulary: not the stale one, and not
    // the lost race.
    assert.equal(loser.code, "already-executed", `round ${round}: ${JSON.stringify(loser)}`);
    assert.equal(startsIn(unit.logPath).length, 1, `round ${round}: an idempotency key ran twice`);
    assert.equal(verify(unit.logPath).status, "clean", `round ${round}: log not clean`);
  }
});

test("the retry re-derives the budget: a ceiling reached in the window is enforced", async () => {
  const script = join(scratch, "harness-start.mjs");
  writeFileSync(script, STARTER_SOURCE, "utf8");

  for (let round = 1; round <= 3; round += 1) {
    // One action a day, globally. Both racers pass the budget check against the
    // log they read; the winner's start consumes the whole ceiling.
    const unit = harnessCase(1);
    const outcomes = await raceHarnessStarts(
      script,
      unit,
      [`${HARNESS_TASK}:a`, `${HARNESS_TASK}:b`],
      "default",
    );

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `round ${round}: expected exactly one winner`);
    assert.equal(losers.length, 1, `round ${round}: expected exactly one loser`);

    const loser = losers[0] as Consumer;
    assert.equal(loser.code, "budget-exceeded", `round ${round}: ${JSON.stringify(loser)}`);
    assert.equal(startsIn(unit.logPath).length, 1, `round ${round}: the ceiling was exceeded`);
    assert.equal(
      records(unit.logPath).filter((record) => record.event === "budget.exceeded").length,
      1,
      `round ${round}: the refusal left no budget.exceeded record`,
    );
    assert.equal(verify(unit.logPath).status, "clean", `round ${round}: log not clean`);
  }
});
