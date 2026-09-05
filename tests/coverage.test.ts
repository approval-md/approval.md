/**
 * `core/coverage.ts` — the join (APRV-245).
 *
 * The claim under test is one sentence: an observed effect is covered when the
 * VERIFIED log holds an earlier-or-simultaneous record of a matching class
 * inside the effect's window, and it is a gap otherwise. Every branch of that
 * sentence gets a case, because each of them is a way to report a green line
 * over a side effect nobody approved.
 *
 * **Nothing here writes a log line by hand.** The records come out of the real
 * CLI — `policy attest`, `register`, `request`, `grant`, `run` — and are read
 * back off disk, exactly as the enforcement paths read them. A suite that
 * fabricated `events.jsonl` would be testing a fixture's idea of the log, and
 * the whole point of this module is that the log is the thing being trusted.
 *
 * The effect timestamps are derived from the records that came back, so no case
 * depends on a wall clock: "one minute after the registration" is expressed as
 * arithmetic on the registration's own `ts`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_AHEAD_MS,
  COVERAGE_LOOKBACK_MS,
  classFamily,
  coverageReport,
  type ObservedEffect,
} from "../src/core/coverage.js";
import type { EventRecord } from "../src/core/log.js";
import type { GuardReport } from "../src/core/protected-path-guard.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "approval-md-coverage-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PAYLOAD_HASH = "3".repeat(64);

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
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const TASK = [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: example-capture",
  '    created_by: "human:carter"',
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send deposit chaser"',
  "      reversible: false",
  '      est_cost_usd: "0.02"',
  '      idempotency_key: "task-042:chaser"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "---",
  "",
  "## Description",
  "Body.",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function recordsOf(dir: string): EventRecord[] {
  if (!existsSync(logPath(dir))) return [];
  return readFileSync(logPath(dir), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

/**
 * A directory with an attested policy and one registered task, built by the CLI.
 *
 * `register` is what puts a `task.registered` carrying
 * `communicate.email.external` in the log, and that record is the evidence most
 * of the cases below look for.
 */
function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(dir, "backlog", "tasks", "task-042.md"), TASK, "utf8");
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  const registered = runCli(
    ["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"],
    dir,
  );
  assert.equal(registered.code, 0, registered.stderr);
  return dir;
}

/** The `task.registered` record's timestamp, in milliseconds. */
function registeredAt(records: readonly EventRecord[]): number {
  const record = records.find((entry) => entry.event === "task.registered");
  assert.ok(record !== undefined, "the CLI did not append task.registered");
  return Date.parse(record.ts);
}

function seqOf(records: readonly EventRecord[], event: string): number {
  const record = records.find((entry) => entry.event === event);
  assert.ok(record !== undefined, `no ${event} in the log`);
  return record.seq;
}

/** One observed effect, with everything but the fields a case cares about fixed. */
function effect(overrides: Partial<ObservedEffect> & { at: string }): ObservedEffect {
  return {
    source: "git",
    id: "abc123",
    class: "communicate.email.external",
    actorHint: null,
    detail: "an effect",
    ...overrides,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Evidence found, and not found
// ---------------------------------------------------------------------------

test("an effect of a registered class inside the window cites the registration", () => {
  const dir = ready();
  const records = recordsOf(dir);
  const report = coverageReport(
    [effect({ at: iso(registeredAt(records) + 60_000) })],
    records,
  );

  assert.equal(report.observed, 1);
  assert.equal(report.covered, 1);
  const entry = report.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.match, "exact");
  assert.deepEqual(entry.evidence, {
    seq: seqOf(records, "task.registered"),
    event: "task.registered",
  });
  assert.deepEqual(report.bySource, [{ key: "git", observed: 1, covered: 1 }]);
  assert.deepEqual(report.byClass, [
    { key: "communicate.email.external", observed: 1, covered: 1 },
  ]);
});

test("an effect against an empty log is a gap, and the report says so in the totals", () => {
  const report = coverageReport([effect({ at: "2026-09-01T12:00:00.000Z" })], []);
  assert.equal(report.covered, 0);
  assert.deepEqual(report.entries[0]?.evidence, null);
  assert.equal(report.entries[0]?.match, "none");
  assert.deepEqual(report.bySource, [{ key: "git", observed: 1, covered: 0 }]);
});

test("a class the log never declared is a gap even with a record in the window", () => {
  const dir = ready();
  const records = recordsOf(dir);
  // Same instant as the case that passes above; only the class differs. The
  // window is not what refuses this one.
  const report = coverageReport(
    [effect({ at: iso(registeredAt(records) + 60_000), class: "release.publish" })],
    records,
  );
  assert.equal(report.covered, 0);
  assert.equal(report.entries[0]?.match, "none");
});

test("a FAMILY match is reported as family and never as exact", () => {
  const dir = ready();
  const records = recordsOf(dir);
  // `communicate.email.internal` shares the first two segments with the
  // declared `communicate.email.external` and shares neither with anything
  // else, so this is the only rule that can find it.
  const report = coverageReport(
    [
      effect({
        at: iso(registeredAt(records) + 60_000),
        class: "communicate.email.internal",
      }),
    ],
    records,
  );
  assert.equal(report.covered, 1);
  assert.equal(report.entries[0]?.match, "family");
  assert.equal(classFamily("communicate.email.internal"), "communicate.email");
  // Two segments, never one: a single segment would make every `vcs.*` record
  // evidence for every other, and pushes and commits are different decisions.
  assert.notEqual(classFamily("vcs.push.main"), classFamily("vcs.commit.branch"));
});

// ---------------------------------------------------------------------------
// The window, on both sides
// ---------------------------------------------------------------------------

test("a record more than the lookback BEFORE the effect does not cover it", () => {
  const dir = ready();
  const records = recordsOf(dir);
  const at = registeredAt(records) + COVERAGE_LOOKBACK_MS + 60_000;
  assert.equal(coverageReport([effect({ at: iso(at) })], records).covered, 0);
  // One minute inside the same boundary still covers, so the case above is
  // measuring the bound and not some other refusal.
  const inside = registeredAt(records) + COVERAGE_LOOKBACK_MS - 60_000;
  assert.equal(coverageReport([effect({ at: iso(inside) })], records).covered, 1);
});

test("a record more than the skew allowance AFTER the effect does not cover it", () => {
  const dir = ready();
  const records = recordsOf(dir);
  // The record lands an hour after the effect, so it is a record about some
  // other action whatever its class: five minutes is clock skew, not an
  // ordering allowance.
  const at = registeredAt(records) - 60 * 60_000;
  assert.equal(coverageReport([effect({ at: iso(at) })], records).covered, 0);
  const inside = registeredAt(records) - (COVERAGE_AHEAD_MS - 60_000);
  assert.equal(coverageReport([effect({ at: iso(inside) })], records).covered, 1);
});

test("an effect whose timestamp does not parse is a gap, never a match", () => {
  const dir = ready();
  const records = recordsOf(dir);
  const report = coverageReport([effect({ at: "not a timestamp" })], records);
  assert.equal(report.covered, 0);
  assert.equal(report.entries[0]?.match, "none");
});

// ---------------------------------------------------------------------------
// A protected path takes the guard's verdict
// ---------------------------------------------------------------------------

function guardReport(findings: GuardReport["findings"]): GuardReport {
  return {
    ok: findings.every((finding) => finding.ok),
    findings,
    exempt: [],
    window: { firstSeq: null, lastSeq: null, firstTs: null, lastTs: null, base: "a", head: "b" },
  };
}

test("a protected path with a passing guard finding takes the guard's verdict", () => {
  const dir = ready();
  const records = recordsOf(dir);
  // Deliberately OUTSIDE the window and of a class no record declares, so the
  // only thing that can cover it is the guard. Bytes outrank time.
  const observed = effect({
    at: "1999-01-01T00:00:00.000Z",
    class: "policy.edit",
    path: "SPEC.md",
  });
  const report = coverageReport([observed], records, {
    guard: guardReport([
      { path: "SPEC.md", ok: true, evidence: "attested", detail: "attested by the human" },
    ]),
  });
  assert.equal(report.covered, 1);
  assert.equal(report.entries[0]?.match, "protected-path");
  assert.deepEqual(report.entries[0]?.evidence, { verdict: "attested" });
});

test("the guard's weakest verdict is not surfaced beside its byte-level ones", () => {
  const dir = ready();
  const records = recordsOf(dir);
  const observed = effect({
    at: "1999-01-01T00:00:00.000Z",
    class: "policy.edit",
    path: "SPEC.md",
  });
  // `granted-command` attributes a change by TIME, which is the same strength
  // of claim the class-and-window rule makes. Printing it under the same column
  // as `attested` would flatten the distinction, so it falls through and is
  // labelled by whichever rule actually answered.
  const report = coverageReport([observed], records, {
    guard: guardReport([
      { path: "SPEC.md", ok: true, evidence: "granted-command", detail: "a granted run" },
    ]),
  });
  assert.equal(report.entries[0]?.match, "none");
  assert.deepEqual(report.entries[0]?.evidence, null);
});

test("a FAILING guard finding does not cover the path either", () => {
  const dir = ready();
  const report = coverageReport(
    [effect({ at: "1999-01-01T00:00:00.000Z", class: "policy.edit", path: "SPEC.md" })],
    recordsOf(dir),
    {
      guard: guardReport([
        { path: "SPEC.md", ok: false, code: "uncovered-hunk", detail: "no grant covered it" },
      ]),
    },
  );
  assert.equal(report.covered, 0);
});

// ---------------------------------------------------------------------------
// actorHint is printed, never matched on
// ---------------------------------------------------------------------------

test("an agent: actorHint with no records is a gap, and the hint is carried through", () => {
  // SPEC.md §11.1 invariant 4: a self-reported field never reduces scrutiny. An
  // effect claiming to have been made by `agent:claude` is exactly as uncovered
  // as one claiming nothing, because the claim is the party under oversight's.
  const report = coverageReport(
    [effect({ at: "2026-09-01T12:00:00.000Z", actorHint: "agent:claude" })],
    [],
  );
  assert.equal(report.covered, 0);
  assert.equal(report.entries[0]?.effect.actorHint, "agent:claude");
});

test("an actorHint changes nothing about a match that the log already justifies", () => {
  const dir = ready();
  const records = recordsOf(dir);
  const at = iso(registeredAt(records) + 60_000);
  const anonymous = coverageReport([effect({ at })], records);
  const claimed = coverageReport([effect({ at, actorHint: "agent:claude" })], records);
  assert.deepEqual(claimed.entries[0]?.evidence, anonymous.entries[0]?.evidence);
});

// ---------------------------------------------------------------------------
// Determinism and totals
// ---------------------------------------------------------------------------

test("entries come back in the order given and the totals are sorted by key", () => {
  const dir = ready();
  const records = recordsOf(dir);
  const at = iso(registeredAt(records) + 60_000);
  const report = coverageReport(
    [
      effect({ at, source: "gh", id: "pr-1", class: "vcs.pr.open" }),
      effect({ at, source: "agentmail", id: "msg-1" }),
      effect({ at, source: "git", id: "sha-1" }),
    ],
    records,
  );
  assert.deepEqual(
    report.entries.map((entry) => entry.effect.id),
    ["pr-1", "msg-1", "sha-1"],
  );
  // Sorted by key regardless of the order the effects arrived in, so a `--json`
  // consumer can pin the whole object with a `deepEqual`.
  assert.deepEqual(
    report.bySource.map((total) => total.key),
    ["agentmail", "gh", "git"],
  );
  assert.equal(report.observed, 3);
  assert.equal(report.covered, 2);
});

test("the join reads its inputs and returns; it opens no file and appends nothing", () => {
  const dir = ready();
  const before = readFileSync(logPath(dir), "utf8");
  coverageReport([effect({ at: "2026-09-01T12:00:00.000Z" })], recordsOf(dir));
  assert.equal(readFileSync(logPath(dir), "utf8"), before, "the join wrote to the log");
});
