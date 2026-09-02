/**
 * The open window, core half (APRV-214, amended SPEC.md §5.2).
 *
 * Every record here is produced by the real append path: `openWindow`,
 * `closeWindow`, `recordGateBypass`, or `core/log.ts`'s `appendEvent` for the
 * records the ceremony would never write (a hand-authored duration, a claimed
 * expiry beyond the derived one, a close naming somebody else's opening). No
 * JSONL line is written by hand anywhere in this file, and every flow ends at a
 * verified read.
 *
 * The clock is injected everywhere, so expiry is exercised without sleeping.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  closeWindow,
  DEFAULT_WINDOW,
  GATE_WINDOW_REFUSAL_CODES,
  GATE_WINDOW_SCOPE,
  MAX_WINDOW_MS,
  openGateWindow,
  openWindow,
  recordGateBypass,
  remainingMs,
  type GateWindowOptions,
} from "../src/core/gate-window.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { SUMMARY_LIMIT } from "../src/cli/hook.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-gate-window-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function logPath(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`, ".approval", "log");
  mkdirSync(dir, { recursive: true });
  return join(dir, "events.jsonl");
}

const T0 = "2026-09-02T12:00:00.000Z";

/** A clock stuck at one instant, the shape every write here is given. */
function at(instant: string): GateWindowOptions {
  return { clock: () => instant };
}

/** Every record in the log, read back through the verified path. */
function records(path: string): EventRecord[] {
  const read = readVerifiedRecords(path, { cache: null });
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  return (read as { ok: true; records: EventRecord[] }).records;
}

/** The log's bytes, for the assertions that nothing was appended. */
function raw(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function plus(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/** Open a window the ordinary way, and fail loudly if the ceremony refused. */
function opened(
  path: string,
  overrides: { at?: string; durationText?: string; durationMs?: number; reason?: string } = {},
): number {
  const result = openWindow(
    path,
    {
      durationText: overrides.durationText ?? DEFAULT_WINDOW,
      durationMs: overrides.durationMs ?? 30 * 60_000,
      reason: overrides.reason ?? "the attestation is drifted and every command dies",
    },
    "human:carter",
    at(overrides.at ?? T0),
  );
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  return (result as { ok: true; record: EventRecord }).record.seq;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

test("an empty log has no open window", () => {
  assert.equal(openGateWindow([], Date.parse(T0)), null);
});

test("an opened window is derived from the log alone (APRV-214)", () => {
  const path = logPath();
  const seq = opened(path);

  const window = openGateWindow(records(path), Date.parse(T0) + 60_000);
  assert.notEqual(window, null);
  assert.equal(window?.seq, seq);
  assert.equal(window?.openedBy, "human:carter");
  assert.equal(window?.durationMs, 30 * 60_000);
  // The default is 30m and the expiry is the record's own ts plus it: one tick
  // supplies both, so the two can never disagree by a scheduling delay.
  assert.equal(window?.expiresAt, plus(T0, 30 * 60_000));
  assert.equal(window?.bypassCount, 0);
  assert.equal(remainingMs(window!, Date.parse(T0) + 60_000), 29 * 60_000);
});

test("a window lapses with nothing appended (APRV-214)", () => {
  const path = logPath();
  opened(path);
  const before = raw(path);

  assert.equal(openGateWindow(records(path), Date.parse(T0) + 30 * 60_000 - 1) !== null, true);
  // At the expiry instant exactly, and after it, the window is gone.
  assert.equal(openGateWindow(records(path), Date.parse(T0) + 30 * 60_000), null);
  assert.equal(openGateWindow(records(path), Date.parse(T0) + 60 * 60_000), null);
  assert.equal(raw(path), before, "expiry appends nothing");
});

test("a close ends the window it names (APRV-214)", () => {
  const path = logPath();
  const seq = opened(path);

  const closed = closeWindow(path, "human:carter", { ...at(plus(T0, 60_000)), note: "repaired" });
  assert.equal(closed.ok, true, closed.ok ? "" : closed.message);
  assert.equal((closed as { ok: true; closed: { seq: number } }).closed.seq, seq);
  assert.equal(openGateWindow(records(path), Date.parse(T0) + 120_000), null);
});

test("a close naming another opening closes nothing (APRV-214)", () => {
  const path = logPath();
  const seq = opened(path);

  const head = records(path);
  const stray = appendEvent(path, {
    ts: plus(T0, 60_000),
    event: "gate.closed",
    actor: "human:carter",
    payload: { opened_seq: seq + 500 },
  }, { expectedHead: { seq: head[head.length - 1]!.seq, hash: head[head.length - 1]!.hash } });
  assert.equal(stray.ok, true, stray.ok ? "" : stray.error.message);

  const window = openGateWindow(records(path), Date.parse(T0) + 120_000);
  assert.equal(window?.seq, seq, "a close that names a different seq is not this window's close");
});

test("a duration over the cap is clamped at READ time (APRV-214)", () => {
  const path = logPath();
  // The ceremony refuses this, so it is written the only other way a record
  // could reach a log: straight through the write boundary.
  const written = appendEvent(path, {
    ts: T0,
    event: "gate.opened",
    actor: "human:carter",
    payload: {
      expires_at: plus(T0, 7 * 24 * 60 * 60_000),
      duration: "7d",
      reason: "a week, claimed by a record the ceremony would never have written",
      scope: GATE_WINDOW_SCOPE,
    },
  }, { expectedHead: null });
  assert.equal(written.ok, true, written.ok ? "" : written.error.message);

  const window = openGateWindow(records(path), Date.parse(T0) + 60_000);
  assert.equal(window?.durationMs, MAX_WINDOW_MS);
  assert.equal(window?.expiresAt, plus(T0, MAX_WINDOW_MS));
  assert.equal(openGateWindow(records(path), Date.parse(T0) + MAX_WINDOW_MS), null);
});

test("a claimed expiry may only SHORTEN the window (APRV-214)", () => {
  const longer = logPath();
  const written = appendEvent(longer, {
    ts: T0,
    event: "gate.opened",
    actor: "human:carter",
    payload: {
      // Two hours claimed on a thirty-minute duration: the claim is a
      // convenience for a human reading the log, never the authority.
      expires_at: plus(T0, 2 * 60 * 60_000),
      duration: "30m",
      reason: "claiming more time than the duration bought",
      scope: GATE_WINDOW_SCOPE,
    },
  }, { expectedHead: null });
  assert.equal(written.ok, true, written.ok ? "" : written.error.message);
  assert.equal(openGateWindow(records(longer), Date.parse(T0) + 45 * 60_000), null);

  const shorter = logPath();
  const second = appendEvent(shorter, {
    ts: T0,
    event: "gate.opened",
    actor: "human:carter",
    payload: {
      expires_at: plus(T0, 5 * 60_000),
      duration: "30m",
      reason: "claiming less time than the duration bought",
      scope: GATE_WINDOW_SCOPE,
    },
  }, { expectedHead: null });
  assert.equal(second.ok, true, second.ok ? "" : second.error.message);
  // The shorter of the two wins in this direction too: every ambiguity here
  // resolves by closing the window sooner.
  assert.equal(openGateWindow(records(shorter), Date.parse(T0) + 6 * 60_000), null);
  assert.notEqual(openGateWindow(records(shorter), Date.parse(T0) + 4 * 60_000), null);
});

test("an unreadable duration yields no window at all (APRV-214)", () => {
  const path = logPath();
  const written = appendEvent(path, {
    ts: T0,
    event: "gate.opened",
    actor: "human:carter",
    payload: {
      expires_at: plus(T0, 60 * 60_000),
      duration: "an hour or so",
      reason: "a duration nobody can parse",
      scope: GATE_WINDOW_SCOPE,
    },
  }, { expectedHead: null });
  assert.equal(written.ok, true, written.ok ? "" : written.error.message);
  assert.equal(openGateWindow(records(path), Date.parse(T0) + 60_000), null);
});

test("only the LATEST opening is a window (APRV-214)", () => {
  const path = logPath();
  const first = opened(path);
  const closed = closeWindow(path, "human:carter", at(plus(T0, 60_000)));
  assert.equal(closed.ok, true);
  const second = opened(path, { at: plus(T0, 120_000) });

  const window = openGateWindow(records(path), Date.parse(T0) + 180_000);
  assert.equal(window?.seq, second);
  assert.notEqual(window?.seq, first);
});

// ---------------------------------------------------------------------------
// open / close refusals
// ---------------------------------------------------------------------------

test("an agent may not open a window, and appends nothing (APRV-214)", () => {
  const path = logPath();
  const before = raw(path);
  for (const actor of ["agent:claude-code", "system:daemon", "carter", ""]) {
    const result = openWindow(
      path,
      { durationText: "5m", durationMs: 5 * 60_000, reason: "let me in" },
      actor,
      at(T0),
    );
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, "actor-not-human");
  }
  assert.equal(raw(path), before, "a refused ceremony leaves the log byte-identical");
});

test("a window needs a reason and a duration inside the cap (APRV-214)", () => {
  const path = logPath();
  const before = raw(path);

  const blank = openWindow(
    path,
    { durationText: "5m", durationMs: 5 * 60_000, reason: "   " },
    "human:carter",
    at(T0),
  );
  assert.equal((blank as { code: string }).code, "gate-reason-required");

  const long = openWindow(
    path,
    { durationText: "25h", durationMs: 25 * 60 * 60_000, reason: "a long day" },
    "human:carter",
    at(T0),
  );
  assert.equal((long as { code: string }).code, "gate-duration-too-long");

  const zero = openWindow(
    path,
    { durationText: "0m", durationMs: 0, reason: "no time at all" },
    "human:carter",
    at(T0),
  );
  assert.equal((zero as { code: string }).code, "gate-duration-too-long");

  assert.equal(raw(path), before);

  // Exactly the cap is accepted: the refusal is "longer than", not "as long as".
  const capped = openWindow(
    path,
    { durationText: "24h", durationMs: MAX_WINDOW_MS, reason: "a full day of repair" },
    "human:carter",
    at(T0),
  );
  assert.equal(capped.ok, true, capped.ok ? "" : capped.message);
});

test("a second open refuses, a close with no window refuses (APRV-214)", () => {
  const path = logPath();
  opened(path);
  const before = raw(path);

  const again = openWindow(
    path,
    { durationText: "5m", durationMs: 5 * 60_000, reason: "again" },
    "human:carter",
    at(plus(T0, 60_000)),
  );
  assert.equal((again as { code: string }).code, "gate-already-open");
  assert.equal(raw(path), before);

  // Once it lapses, a close still has nothing to do: lapse appends nothing and
  // needs no closing record.
  const late = closeWindow(path, "human:carter", at(plus(T0, 60 * 60_000)));
  assert.equal((late as { code: string }).code, "gate-not-open");
  assert.equal(raw(path), before);
});

test("an agent may not close a window either (APRV-214)", () => {
  const path = logPath();
  opened(path);
  const before = raw(path);
  const result = closeWindow(path, "agent:claude-code", at(plus(T0, 60_000)));
  assert.equal((result as { code: string }).code, "actor-not-human");
  assert.equal(raw(path), before);
});

// ---------------------------------------------------------------------------
// bypass
// ---------------------------------------------------------------------------

const BYPASS = {
  tool: "Bash",
  summary: "npm install --save-dev oxlint",
  classes: ["deps.add"],
  payloadHash: "4d0a9c2b7e5f13860ad4c9b217e3f508cc61a7d2394b8e05f7ca61d3b8092e4f",
  sessionId: "sess-1",
  toolUseId: "toolu-9",
  cwd: "/repo",
};

test("a bypass names the window it ran under, and counts (APRV-214)", () => {
  const path = logPath();
  const seq = opened(path);

  const first = recordGateBypass(path, BYPASS, "agent:claude-code", at(plus(T0, 60_000)));
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  const record = (first as { ok: true; record: EventRecord }).record;
  assert.deepEqual(record.payload, {
    opened_seq: seq,
    tool: "Bash",
    summary: "npm install --save-dev oxlint",
    classes: ["deps.add"],
    payload_hash: BYPASS.payloadHash,
    session_id: "sess-1",
    tool_use_id: "toolu-9",
    cwd: "/repo",
  });

  const second = recordGateBypass(path, BYPASS, "agent:claude-code", at(plus(T0, 120_000)));
  assert.equal(second.ok, true);
  assert.equal(openGateWindow(records(path), Date.parse(T0) + 180_000)?.bypassCount, 2);
});

test("nothing may be bypassed with no window open (APRV-214)", () => {
  const path = logPath();
  const before = raw(path);
  const result = recordGateBypass(path, BYPASS, "agent:claude-code", at(T0));
  assert.equal((result as { code: string }).code, "gate-not-open");
  assert.equal(raw(path), before);

  opened(path);
  const afterOpen = raw(path);
  // A lapsed window is the same fact: the hook denies exactly as it does with
  // no window at all.
  const late = recordGateBypass(path, BYPASS, "agent:claude-code", at(plus(T0, 60 * 60_000)));
  assert.equal((late as { code: string }).code, "gate-not-open");
  assert.equal(raw(path), afterOpen);
});

test("a moved head re-derives the window and appends once (APRV-214)", () => {
  const path = logPath();
  opened(path);

  // The seam: the clock is read AFTER the verified read and before the append,
  // so a writer here lands between the two and the append's precondition fails.
  let ticks = 0;
  const interleaving = (): string => {
    ticks += 1;
    if (ticks === 1) {
      const current = records(path);
      const head = current[current.length - 1]!;
      const wedge = appendEvent(path, {
        ts: plus(T0, 30_000),
        event: "audit.sampled",
        actor: "system:daemon",
      }, { expectedHead: { seq: head.seq, hash: head.hash } });
      assert.equal(wedge.ok, true, wedge.ok ? "" : wedge.error.message);
    }
    return plus(T0, 60_000);
  };

  const result = recordGateBypass(path, BYPASS, "agent:claude-code", { clock: interleaving });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  assert.equal(ticks, 2, "exactly one retry");
  const written = records(path).filter((record) => record.event === "gate.bypassed");
  assert.equal(written.length, 1, "the losing attempt wrote nothing");
});

test("a caller may lower the retry bound, and a lost race then refuses (APRV-214)", () => {
  const path = logPath();
  opened(path);

  let ticks = 0;
  const interleaving = (): string => {
    ticks += 1;
    const current = records(path);
    const head = current[current.length - 1]!;
    const wedge = appendEvent(path, {
      ts: plus(T0, 30_000),
      event: "audit.sampled",
      actor: "system:daemon",
    }, { expectedHead: { seq: head.seq, hash: head.hash } });
    assert.equal(wedge.ok, true, wedge.ok ? "" : wedge.error.message);
    return plus(T0, 60_000);
  };

  const result = recordGateBypass(path, BYPASS, "agent:claude-code", {
    clock: interleaving,
    retryOnHeadMoved: 1,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "append-failed");
  assert.equal((result as { append?: { code: string } }).append?.code, "head-moved");
  assert.equal(ticks, 1);
  assert.equal(
    records(path).filter((record) => record.event === "gate.bypassed").length,
    0,
    "a refused bypass appends nothing",
  );
});

// ---------------------------------------------------------------------------
// The frozen union
// ---------------------------------------------------------------------------

test("the gate-window refusal codes are a frozen union (SPEC.md §11.1 invariant 6)", () => {
  assert.deepEqual(
    [...GATE_WINDOW_REFUSAL_CODES],
    [
      "actor-not-human",
      "gate-reason-required",
      "gate-duration-too-long",
      "gate-already-open",
      "gate-not-open",
      "gate-stdin-not-tty",
      "gate-confirmation-mismatch",
      "log-unreadable",
      "log-torn-tail",
      "log-corrupt",
      "append-failed",
    ],
  );
  assert.equal(new Set(GATE_WINDOW_REFUSAL_CODES).size, GATE_WINDOW_REFUSAL_CODES.length);
});

test("the bypass summary cap is the hook's own SUMMARY_LIMIT (APRV-214)", () => {
  const schema = JSON.parse(
    readFileSync(join(DEFAULT_SCHEMA_DIR, "event.schema.json"), "utf8"),
  ) as { allOf: Array<Record<string, unknown>> };
  const block = schema.allOf.find((entry) => {
    const target = (entry["if"] as { properties?: { event?: { const?: string } } } | undefined)
      ?.properties?.event?.const;
    return target === "gate.bypassed";
  });
  assert.notEqual(block, undefined);
  const summary = (
    (block!["then"] as {
      properties: { payload: { properties: { summary: { maxLength: number } } } };
    }).properties.payload.properties.summary
  );
  assert.equal(
    summary.maxLength,
    SUMMARY_LIMIT,
    "the schema's cap and the hook's headline limit are one number",
  );
});
