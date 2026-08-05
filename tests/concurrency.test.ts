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
  append?: { code: string; message: string };
  record?: EventRecord;
}

interface RaceCase {
  dir: string;
  logPath: string;
  policyPath: string;
  token: string;
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
        origin: { app: "cartsos", created_by: "human:carter" },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            summary: "Send deposit chaser",
            reversible: false,
            est_cost_usd: 0.02,
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
      est_cost_usd: 0.02,
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
