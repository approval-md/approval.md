/**
 * The harness cap, and the window it leaves (APRV-423).
 *
 * The failure this is about, from the log on 2026-09-20 (APRV-410): a hook
 * opened a request, the harness killed the hook before a human answered, the
 * tool call was denied, and the tap that arrived eleven minutes later was
 * recorded as an ordinary `approval.granted` on a call nobody was holding. Two
 * records about one request, disagreeing about it.
 *
 * The fix is ordering, so ordering is what this file asserts, and it asserts it
 * on an injected clock rather than by waiting: nothing here sleeps, and every
 * instant a verdict is judged at is a parameter. The shape follows
 * `tests/daemon-projection.test.ts` — the daemon's TTL sweep IS
 * `lapsedRequests` followed by `expire` (`Daemon.sweepTtl`), so driving those
 * two with a fixed clock drives the sweep, and the process-level suites are
 * left to prove the daemon reaches the same answers on its own clock.
 *
 * No log line is hand-written. Every record goes through `core/gate.ts`'s real
 * append path, and every case ends by walking the chain.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { decide, expire, findHarnessCarry, register, request } from "../src/core/gate.js";
import {
  HARNESS_CAP_MARGIN_MS,
  harnessCapFitsMargin,
  harnessCappedTtlMs,
} from "../src/core/harness-wait.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { requestState } from "../src/core/state.js";
import { DEFAULT_INTERVAL_MS } from "../src/daemon/daemon.js";
import { lapsedRequests } from "../src/daemon/projection.js";
import {
  assertClean,
  attest,
  fixedClock,
  newScenario,
  payloadOf,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const { root, cleanup } = scratchRoot("harness-cap");
after(cleanup);

/** dist/tests/harness-cap-ttl.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const KEY = "task-042:chaser";
const CLS = "communicate.email.external";
/** The bound bytes. One payload for every case, so a carry can be asked about. */
const PAYLOAD = { command: "send the deposit chaser", cwd: "/repo" };

/** Five minutes: Hermes's own documented per-entry maximum. */
const CAP_MS = 300_000;
/** What a 5m cap leaves once the margin is taken off it. */
const WINDOW_MS = CAP_MS - HARNESS_CAP_MARGIN_MS;

/** An instant `ms` after {@link T0}. The suite's whole clock. */
function after0(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

/**
 * The policy every case uses unless it says otherwise: a one-hour TTL, which is
 * twelve times the cap, so a window that comes out at four minutes came out of
 * the cap and nothing else.
 */
const POLICY_TTL_1H = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  `  ${CLS}:`,
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/** The same policy with no `defaults.approval_ttl` at all: nothing lapses. */
const POLICY_NO_TTL = POLICY_TTL_1H.split("\n")
  .filter((line) => !line.includes("approval_ttl"))
  .join("\n");

/**
 * The hash the gate binds to, computed the way the runtime computes it so the
 * registration and the request agree without either of them stating a literal.
 */
const BOUND = payloadHash(PAYLOAD);

/** A scenario with the policy attested and the action declared, both at T0. */
function ready(policyText: string): Scenario {
  const unit = newScenario(root, policyText);
  attest(unit, T0);
  const registered = register(
    unit.logPath,
    {
      task: "task-042",
      envelope: {
        origin: { app: "claude-code-hook", created_by: "agent:claude-code" },
        state: "proposed",
        actions: [
          {
            class: CLS,
            summary: "send the deposit chaser",
            idempotency_key: KEY,
            payload_hash: BOUND,
          },
        ],
      },
    },
    "agent:claude-code",
    { ...unit.options, clock: fixedClock(T0) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

/** Open the harness request at T0, with `capMs` declared or none. */
function opened(unit: Scenario, capMs: number | null): void {
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: KEY,
      cls: CLS,
      summary: "send the deposit chaser",
      payload_hash: BOUND,
      payload: { value: PAYLOAD },
      execution: "harness",
      ...(capMs === null ? {} : { harnessCapMs: capMs }),
    },
    "agent:claude-code",
    { ...unit.options, clock: fixedClock(T0) },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

/** The state the gate derives for {@link KEY} at `ms` after T0. */
function stateAt(unit: Scenario, ms: number, ttlMs: number | null): string {
  return requestState(records(unit), KEY, after0(ms), ttlMs).state;
}

/** One sweep, exactly as `Daemon.sweepTtl` performs it. */
function sweep(
  unit: Scenario,
  ms: number,
  ttlMs: number | null,
): { candidates: number; expired: EventRecord | null } {
  const ts = after0(ms);
  const candidates = lapsedRequests(records(unit), ts, ttlMs);
  if (candidates.length === 0) return { candidates: 0, expired: null };
  const result = expire(unit.logPath, KEY, { ...unit.options, clock: fixedClock(ts) });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return { candidates: candidates.length, expired: result.ok ? result.record : null };
}

// ---------------------------------------------------------------------------
// The arithmetic, on its own
// ---------------------------------------------------------------------------

test("a cap may only shorten: the effective window is the smaller of the two", () => {
  // No cap: the policy alone.
  assert.equal(harnessCappedTtlMs(3_600_000, null), 3_600_000);
  // A cap longer than the TTL buys nothing.
  assert.equal(harnessCappedTtlMs(3_600_000, 86_400_000), 3_600_000);
  // A cap shorter than the TTL shortens it, by the margin.
  assert.equal(harnessCappedTtlMs(3_600_000, CAP_MS), WINDOW_MS);
  // No TTL and a cap: the cap bounds what the policy did not.
  assert.equal(harnessCappedTtlMs(null, CAP_MS), WINDOW_MS);
  // Neither: nothing lapses, and no duration is invented.
  assert.equal(harnessCappedTtlMs(null, null), null);
  // A cap under the margin has no window left in it.
  assert.equal(harnessCappedTtlMs(3_600_000, HARNESS_CAP_MARGIN_MS), 0);
  assert.equal(harnessCapFitsMargin(HARNESS_CAP_MARGIN_MS), false);
  assert.equal(harnessCapFitsMargin(HARNESS_CAP_MARGIN_MS + 1), true);
});

test("the margin leaves the daemon a whole sweep interval inside the cap", () => {
  // The claim the constant is chosen for, asserted rather than left in prose:
  // the daemon ticks every 30s, so a lapse landing just after one tick is
  // recorded at the next, and the margin has to cover that with room over.
  assert.equal(HARNESS_CAP_MARGIN_MS, 2 * DEFAULT_INTERVAL_MS);
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — the ordering
// ---------------------------------------------------------------------------

test("the sweep expires a capped request strictly before the harness cap elapses", () => {
  const unit = ready(POLICY_TTL_1H);
  opened(unit, CAP_MS);

  const requested = records(unit).find((record) => record.event === "approval.requested");
  assert.ok(requested !== undefined);
  assert.equal(payloadOf(requested)["harness_cap_ms"], CAP_MS);
  assert.equal(requested.ts, T0, "the request carries the write-boundary clock");

  // One millisecond before the window closes: live, and no candidate.
  assert.equal(stateAt(unit, WINDOW_MS - 1, 3_600_000), "requested");
  assert.equal(sweep(unit, WINDOW_MS - 1, 3_600_000).candidates, 0);

  // One millisecond after: lapsed, and the sweep materialises it.
  assert.equal(stateAt(unit, WINDOW_MS + 1, 3_600_000), "expired");
  const swept = sweep(unit, WINDOW_MS + 1, 3_600_000);
  assert.equal(swept.candidates, 1);
  const expired = swept.expired;
  assert.ok(expired !== null);
  assert.equal(expired.event, "approval.expired");
  assert.equal(expired.actor, "system:gate");

  // THE ORDERING, which is the whole point: the record lands before the harness
  // gives up, with the margin to spare.
  const capElapsesAt = Date.parse(T0) + CAP_MS;
  const expiredAt = Date.parse(expired.ts);
  assert.ok(expiredAt < capElapsesAt, `${expired.ts} must precede the cap at ${String(capElapsesAt)}`);
  assert.equal(capElapsesAt - expiredAt, HARNESS_CAP_MARGIN_MS - 1);

  // And the record says what window it closed, and why that window was short.
  assert.equal(payloadOf(expired)["ttl_ms"], WINDOW_MS);
  assert.equal(payloadOf(expired)["harness_cap_ms"], CAP_MS);
  assert.equal(payloadOf(expired)["requested_ts"], T0);

  // Idempotent with itself, exactly as it is without a cap.
  assert.equal(lapsedRequests(records(unit), after0(WINDOW_MS + 2), 3_600_000).length, 0);
  assertClean(unit);
});

test("a policy TTL shorter than the cap still wins, and the cap changes nothing", () => {
  const unit = ready(
    POLICY_TTL_1H.replace('approval_ttl: "1h"', 'approval_ttl: "30s"'),
  );
  opened(unit, CAP_MS);
  assert.equal(stateAt(unit, 29_000, 30_000), "requested");
  assert.equal(stateAt(unit, 31_000, 30_000), "expired");
  const swept = sweep(unit, 31_000, 30_000);
  assert.equal(swept.candidates, 1);
  assert.equal(payloadOf(swept.expired as EventRecord)["ttl_ms"], 30_000);
  assertClean(unit);
});

test("a cap bounds a request the policy declares no TTL for", () => {
  const unit = ready(POLICY_NO_TTL);
  opened(unit, CAP_MS);
  // The policy bounds nothing, so the cap is the only deadline there is.
  assert.equal(stateAt(unit, WINDOW_MS - 1, null), "requested");
  assert.equal(lapsedRequests(records(unit), after0(WINDOW_MS - 1), null).length, 0);
  assert.equal(stateAt(unit, WINDOW_MS + 1, null), "expired");
  const swept = sweep(unit, WINDOW_MS + 1, null);
  assert.equal(swept.candidates, 1);
  assert.ok(Date.parse((swept.expired as EventRecord).ts) < Date.parse(T0) + CAP_MS);
  assertClean(unit);
});

test("without a cap, a policy that declares no TTL still expires nothing", () => {
  const unit = ready(POLICY_NO_TTL);
  opened(unit, null);
  assert.equal(stateAt(unit, 86_400_000, null), "requested");
  assert.equal(lapsedRequests(records(unit), after0(86_400_000), null).length, 0);
  const refused = expire(unit.logPath, KEY, {
    ...unit.options,
    clock: fixedClock(after0(86_400_000)),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? "" : refused.code, "not-expired");
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// AC3 — the late tap
// ---------------------------------------------------------------------------

test("a tap after the capped window is refused expired and never becomes a grant", () => {
  const unit = ready(POLICY_TTL_1H);
  opened(unit, CAP_MS);

  // The daemon got there first, which is the ordinary case under a cap.
  sweep(unit, WINDOW_MS + 1, 3_600_000);

  const tapped = decide(unit.logPath, KEY, "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(after0(WINDOW_MS + 30_000)),
  });
  assert.equal(tapped.ok, false);
  assert.equal(tapped.ok ? "" : tapped.code, "expired");
  assert.match(tapped.ok ? "" : tapped.message, /an expired request is terminal/u);
  assert.equal(
    records(unit).filter((record) => record.event === "approval.granted").length,
    0,
    "a late tap must not be recorded as a grant",
  );
  // Still inside the policy's own hour, which is exactly the tap APRV-410 saw
  // become a grant.
  assert.ok(WINDOW_MS + 30_000 < 3_600_000);
  assertClean(unit);
});

test("a tap the sweep never reached is refused too, and materialises the lapse first", () => {
  const unit = ready(POLICY_TTL_1H);
  opened(unit, CAP_MS);

  // No sweep ran: the daemon was asleep. The verdict must not depend on it.
  const tapped = decide(unit.logPath, KEY, "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(after0(WINDOW_MS + 1)),
  });
  assert.equal(tapped.ok, false);
  assert.equal(tapped.ok ? "" : tapped.code, "expired");
  assert.match(
    tapped.ok ? "" : tapped.message,
    /declared a 300000ms harness ceiling/u,
    "the refusal says which ceiling shortened the window",
  );

  const written = records(unit);
  assert.equal(written.filter((record) => record.event === "approval.granted").length, 0);
  const expired = written.filter((record) => record.event === "approval.expired");
  assert.equal(expired.length, 1, "the refusal materialised the lapse it derived");
  assert.equal((expired[0] as EventRecord).actor, "system:gate");
  assert.equal(payloadOf(expired[0] as EventRecord)["ttl_ms"], WINDOW_MS);
  assertClean(unit);
});

test("a retry cannot adopt a question the cap already closed", () => {
  const unit = ready(POLICY_TTL_1H);
  opened(unit, CAP_MS);
  const hash = BOUND;

  // Inside the window the retry adopts it, which is APRV-117's carryover.
  const live = findHarnessCarry(records(unit), hash, CLS, after0(WINDOW_MS - 1), 3_600_000);
  assert.equal(live?.kind, "pending");

  // Past it there is nothing to adopt, and the retry asks afresh instead of
  // waiting out a second window on a question that is already dead.
  const dead = findHarnessCarry(records(unit), hash, CLS, after0(WINDOW_MS + 1), 3_600_000);
  assert.equal(dead, null);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The write boundary
// ---------------------------------------------------------------------------

test("a cap on a token-minting request is refused at the write boundary", () => {
  const unit = ready(POLICY_TTL_1H);
  const before = records(unit).length;
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: KEY,
      cls: CLS,
      summary: "send the deposit chaser",
      payload_hash: BOUND,
      payload: { value: PAYLOAD },
      // No `execution: "harness"`, so this grant would mint a token whose shelf
      // life is the request's window — and the cap would make that window
      // shorter than the authorization it produced.
      harnessCapMs: CAP_MS,
    },
    "agent:claude-code",
    { ...unit.options, clock: fixedClock(T0) },
  );
  assert.equal(result.ok, false);
  assert.equal(records(unit).length, before, "nothing was appended");
  assertClean(unit);
});

test("an unreadable cap reads as no cap, and the policy's TTL governs alone", () => {
  const unit = ready(POLICY_TTL_1H);
  opened(unit, CAP_MS);
  // The field as a reader sees it, mangled the way a hand-edited or
  // foreign-written record could mangle it. `requestState` is pure over
  // records, so this asks the question without touching the log on disk.
  const mangled = records(unit).map((record) =>
    record.event === "approval.requested"
      ? { ...record, payload: { ...payloadOf(record), harness_cap_ms: "300s" } }
      : record,
  );
  const derived = requestState(mangled, KEY, after0(WINDOW_MS + 1), 3_600_000);
  assert.equal(derived.declared.harness_cap_ms, null);
  assert.equal(derived.effectiveTtlMs, 3_600_000);
  assert.equal(derived.state, "requested");
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The hook's own words (AC2, second half)
// ---------------------------------------------------------------------------

let cliCase = 0;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A hook-shaped case directory: policy on disk, attested by a human. */
function hookCase(): string {
  cliCase += 1;
  const dir = join(root, `hook-${cliCase}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: manual",
      '  approval_ttl: "1h"',
      "  on_expiry: reject",
      "classes:",
      "  read.*:",
      "    autonomy: autonomous",
      "  network.call:",
      "    autonomy: manual",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

/** One PreToolUse event, as Claude Code sends it. */
function bashEvent(command: string, toolUseId: string): string {
  return JSON.stringify({
    session_id: "sess-cap",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "harmless" },
    tool_use_id: toolUseId,
  });
}

function verdictOf(run: Run): { permission: string; reason: string } {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = parsed["hookSpecificOutput"] as Record<string, unknown>;
  return {
    permission: String(output["permissionDecision"]),
    reason: String(output["permissionDecisionReason"]),
  };
}

test("the hook's block message names the expiry the cap produced", () => {
  const dir = hookCase();
  const run = runCli(
    [
      "hook",
      "claude-code",
      "--timeout",
      "1s",
      "--interval",
      "200ms",
      "--harness-cap",
      "300s",
    ],
    dir,
    bashEvent("curl -X POST https://example.com -d hello", "tu-cap-1"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(verdict.reason, /harness ceiling this hook runs under bounds the question/u);

  // The instant named is the one the gate will judge by: the request's own
  // write-boundary ts plus the window the cap leaves.
  const log = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  const requested = log
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord)
    .find((record) => record.event === "approval.requested");
  assert.ok(requested !== undefined);
  const payload = (requested.payload ?? {}) as Record<string, unknown>;
  assert.equal(payload["harness_cap_ms"], 300_000);
  const expected = new Date(Date.parse(requested.ts) + WINDOW_MS).toISOString();
  assert.ok(
    verdict.reason.includes(`expire at ${expected}`),
    `the deny names ${expected}: ${verdict.reason}`,
  );

  // The announce line says it too, before the wait, so a human watching the
  // agent's error stream knows how long they have.
  assert.match(run.stderr, new RegExp(`The request expires at ${expected}`, "u"));
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("a harness ceiling with no room for a human is refused before anything is written", () => {
  const dir = hookCase();
  const before = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--harness-cap", "30s"],
    dir,
    bashEvent("curl -X POST https://example.com -d hello", "tu-cap-2"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-harness-cap-too-short: /u);
  assert.match(verdict.reason, /nothing was registered, nothing was requested/u);

  const after = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  const grew = after
    .slice(before.length)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
  assert.equal(
    grew.filter((record) => record.event === "approval.requested").length,
    0,
    "no question reached a phone",
  );
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("an uncapped hook deny is unchanged, and names no instant", () => {
  const dir = hookCase();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "200ms"],
    dir,
    bashEvent("curl -X POST https://example.com -d hello", "tu-cap-3"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  // The policy alone bounds this one, and its deadline is stated where its
  // reader can see it. A varying instant here would also make two invocations
  // of one command produce two different denies.
  assert.ok(!/expire at /u.test(verdict.reason), verdict.reason);
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});
