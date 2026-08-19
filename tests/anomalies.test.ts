/**
 * Timestamp anomalies (APRV-40): the non-fatal channel `core/verify.ts` gained.
 *
 * SPEC.md §8: "verification treats gate-type events with implausible skew
 * relative to their neighbors as a reportable anomaly, never silently accepted".
 *
 * The whole point of this suite is the word *reportable*. Every case asserts two
 * things at once — that the skew is named, and that naming it changed nothing:
 * not the status, not the exit code, not a refusal, not what the log authorizes.
 * An anomaly channel that quietly became an enforcement path would be a breaking
 * change disguised as a diagnostic, so the "changed nothing" half is asserted as
 * carefully as the detection half.
 *
 * Every record is produced by the real append path. The skewed timestamps are
 * real writes made with a clock injected backwards, which is exactly what a host
 * whose clock stepped (or a writer that authored its own `ts`) produces — not a
 * hand-edited line, which would fail the chain and never reach this code.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { main } from "../src/cli/main.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import {
  chainAnomalies,
  CHAIN_ANOMALY_KINDS,
  GATE_TS_SKEW_TOLERANCE_MS,
  skewToleranceMsOf,
  verify,
} from "../src/core/verify.js";
import { appendAttestation, decide, register, request } from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-anomalies-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "24h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "```",
  "",
].join("\n");

/** The same policy with an `audit.skew_tolerance` (APRV-58). */
function policyWithSkew(tolerance: string): string {
  return POLICY.replace(
    "```\n",
    ["audit:", `  skew_tolerance: "${tolerance}"`, "```\n"].join("\n"),
  );
}

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: { policy: { file: string } };
}

function newCase(): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: 0.02,
      idempotency_key: "task-042:chaser",
      payload_hash: "a".repeat(64),
    },
  ],
};

/**
 * A log with `approval.requested` at `requestedMs` and `approval.granted` at
 * `grantedMs`, both gate-typed and both stamped from an injected clock.
 */
function scenario(requestedMs: number, grantedMs: number): Case {
  const unit = newCase();
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok, true);
  assert.equal(
    register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, T0, "agent:claude").ok,
    true,
  );
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      cls: "communicate.email.external",
      est_cost_usd: 0.02,
      reversible: false,
      summary: "Send deposit chaser",
      payload_hash: "a".repeat(64),
    },
    at(requestedMs),
    "agent:claude",
    unit.options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);
  const granted = decide(
    unit.logPath,
    "task-042:chaser",
    "grant",
    "human:carter",
    at(grantedMs),
    unit.options,
  );
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  return unit;
}

function records(unit: Case): EventRecord[] {
  return readFileSync(unit.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function runCli(unit: Case, argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main([...argv, "--log", unit.logPath], {
    cwd: unit.dir,
    streams: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
  });
  return { code, out, err };
}

// ===========================================================================
// The frozen vocabulary and the threshold
// ===========================================================================

test("the anomaly-kind union is frozen public API", () => {
  assert.deepEqual([...CHAIN_ANOMALY_KINDS], ["gate-ts-regression"]);
});

test("the skew tolerance is pinned at 2 seconds", () => {
  // The DEFAULT since APRV-58, and still drafted rather than spec-derived:
  // amended SPEC.md §8 names `audit.skew_tolerance` and leaves the absent case
  // to the implementation. Pinned here so a change to it is a deliberate edit
  // with a test in the diff, never a quiet retune.
  assert.equal(GATE_TS_SKEW_TOLERANCE_MS, 2_000);
});

// ===========================================================================
// The policy knob (amended SPEC.md §8, APRV-58)
// ===========================================================================

test("audit.skew_tolerance tightens the threshold; absent means the default", () => {
  // 3s of backwards step: inside no policy's business at 2s? No — past the
  // default, so the shipped behavior reports it, and a policy declaring 5s
  // must not.
  const unit = scenario(600_000, 600_000 - 3_000);
  assert.equal(verify(unit.logPath).anomalies.length, 1, "the default reports a 3s step");

  writeFileSync(unit.policyPath, policyWithSkew("5s"), "utf8");
  assert.deepEqual(
    verify(unit.logPath, { policy: { file: unit.policyPath } }).anomalies,
    [],
    "a policy that widens the allowance must be read",
  );

  // And the other direction: a tighter allowance reports a step the default
  // would have called ordinary clock disagreement.
  const small = scenario(600_000, 600_000 - 500);
  assert.deepEqual(verify(small.logPath).anomalies, [], "500ms is inside the default");
  writeFileSync(small.policyPath, policyWithSkew("250ms"), "utf8");
  const tightened = verify(small.logPath, { policy: { file: small.policyPath } });
  assert.equal(tightened.status, "clean", "a threshold never moves the verdict");
  assert.equal(tightened.anomalies.length, 1);
  assert.match(tightened.anomalies[0]?.message ?? "", /larger than 250ms/u);
  assert.match(tightened.anomalies[0]?.message ?? "", /nothing is refused/u);
});

test("a policy declaring no tolerance, and one that will not load, leave the default in force", () => {
  const unit = scenario(600_000, 600_000 - 3_000);
  const withPolicy = verify(unit.logPath, { policy: { file: unit.policyPath } });
  assert.equal(withPolicy.anomalies.length, 1, "the fixture policy declares no tolerance");

  // Fail closed to the SHIPPED number, not to zero: a zero allowance would
  // report every healthy fleet's ordinary clock disagreement, and an anomaly
  // channel that cries wolf is one operators stop reading.
  writeFileSync(unit.policyPath, "# Policy\n\nno block at all\n", "utf8");
  const unloadable = verify(unit.logPath, { policy: { file: unit.policyPath } });
  assert.equal(unloadable.status, "clean");
  assert.deepEqual(
    unloadable.anomalies.map((anomaly) => anomaly.skewMs),
    withPolicy.anomalies.map((anomaly) => anomaly.skewMs),
  );
  assert.equal(skewToleranceMsOf({ file: unit.policyPath }), GATE_TS_SKEW_TOLERANCE_MS);
  assert.equal(skewToleranceMsOf({ file: join(unit.dir, "nowhere.md") }), GATE_TS_SKEW_TOLERANCE_MS);
});

test("an unparseable tolerance fails the whole policy, exactly as a bad approval_ttl does", () => {
  const unit = newCase();
  writeFileSync(unit.policyPath, policyWithSkew("1h30m"), "utf8");
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, false, "the schema's duration pattern must reject a compound form");
  if (!load.ok) assert.equal(load.code, "schema-invalid");
  // Fail closed: an unreadable policy is every class manual AND the shipped
  // tolerance, so the operator loses nothing they were being shown.
  assert.equal(skewToleranceMsOf({ file: unit.policyPath }), GATE_TS_SKEW_TOLERANCE_MS);
});

test("the configured tolerance is report-only: it moves no verdict and no exit code", () => {
  const unit = scenario(600_000, 600_000 - 500);
  writeFileSync(unit.policyPath, policyWithSkew("250ms"), "utf8");
  // An edited policy is inoperative until a human re-attests it (SPEC.md §5.2),
  // and an unattested policy would make `status` unhealthy for a reason that has
  // nothing to do with this threshold. The re-attestation is forward in time, so
  // it adds no anomaly of its own.
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", at(900_000)).ok,
    true,
  );

  // `log verify` resolves the policy from its working directory, where the
  // fixture wrote APPROVAL.md.
  const run = runCli(unit, ["log", "verify", "--json"]);
  assert.equal(run.code, 0, "an anomaly the policy asked for still exits 0");
  const body = JSON.parse(run.out) as Record<string, unknown>;
  assert.equal(body["status"], "clean");
  assert.equal((body["anomalies"] as unknown[]).length, 1);

  const status = runCli(unit, ["status", "--policy", unit.policyPath, "--json"]);
  assert.equal(status.code, 0);
  const health = JSON.parse(status.out) as Record<string, unknown>;
  assert.equal(health["healthy"], true, "a tightened threshold must not move health");
  assert.equal((health["anomalies"] as unknown[]).length, 1);
});

test("chainAnomalies takes the threshold as an argument and stays pure", () => {
  const unit = scenario(600_000, 600_000 - 500);
  const all = records(unit);
  assert.deepEqual(chainAnomalies(all), [], "the default is the parameter's default");
  const tight = chainAnomalies(all, 250);
  assert.equal(tight.length, 1);
  assert.deepEqual(chainAnomalies(all, 250), tight, "same records and threshold, same answer");
});

// ===========================================================================
// Detection
// ===========================================================================

test("an ordinary forward-moving log has no anomalies", () => {
  const unit = scenario(1_000, 60_000);
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean");
  assert.deepEqual(result.anomalies, []);
});

test("a backwards step inside the tolerance is not an anomaly", () => {
  const unit = scenario(10_000, 10_000 - (GATE_TS_SKEW_TOLERANCE_MS - 1));
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean");
  assert.deepEqual(
    result.anomalies,
    [],
    "sub-tolerance skew is ordinary clock disagreement between two hosts, not evidence",
  );
});

test("a backwards step beyond the tolerance is reported", () => {
  const unit = scenario(600_000, 600_000 - 300_000);
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", "the chain still verifies");

  assert.equal(result.anomalies.length, 1);
  const anomaly = result.anomalies[0];
  assert.equal(anomaly?.kind, "gate-ts-regression");
  assert.equal(anomaly?.event, "approval.granted");
  assert.equal(anomaly?.skewMs, 300_000);
  assert.equal(anomaly?.previousTs, at(600_000));
  assert.match(anomaly?.message ?? "", /nothing is refused/u);
});

test("exactly at the tolerance is not yet an anomaly; one millisecond past it is", () => {
  const boundary = scenario(600_000, 600_000 - GATE_TS_SKEW_TOLERANCE_MS);
  assert.deepEqual(verify(boundary.logPath).anomalies, []);

  const past = scenario(600_000, 600_000 - GATE_TS_SKEW_TOLERANCE_MS - 1);
  assert.equal(verify(past.logPath).anomalies.length, 1);
});

test("a non-gate-typed event's timestamp is never compared", () => {
  // `task.registered` is written directly, and SPEC.md §8 leaves direct writers
  // free to supply their own `ts` (an importer replaying history is the case).
  // Comparing them would manufacture anomalies out of correct behavior.
  const unit = scenario(600_000, 700_000);
  const appended = appendEvent(unit.logPath, {
    ts: at(-86_400_000),
    event: "task.registered",
    actor: "agent:importer",
    task: "task-042",
    payload: { actions: [] },
  });
  assert.equal(appended.ok, true);
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean");
  assert.deepEqual(result.anomalies, []);
});

test("the comparison is against the previous GATE-TYPED record, not the previous record", () => {
  const unit = scenario(600_000, 700_000);
  // A far-past non-gate record between two gate records must neither raise an
  // anomaly of its own nor become the baseline the next gate record is judged by.
  assert.equal(
    appendEvent(unit.logPath, {
      ts: at(-86_400_000),
      event: "route.proposed",
      actor: "agent:claude",
      task: "task-042",
      payload: {},
    }).ok,
    true,
  );
  assert.equal(
    decide(unit.logPath, "task-042:chaser", "revoke", "human:carter", at(800_000), unit.options).ok,
    true,
  );
  assert.deepEqual(verify(unit.logPath).anomalies, []);
});

test("one backdated record produces one anomaly, not two", () => {
  // The forward jump back to normal time on the NEXT record is the same
  // disagreement seen from the other end. Reporting it again would double every
  // entry without adding a fact.
  const unit = scenario(600_000, 100_000);
  assert.equal(
    decide(unit.logPath, "task-042:chaser", "revoke", "human:carter", at(700_000), unit.options).ok,
    true,
  );
  const anomalies = verify(unit.logPath).anomalies;
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]?.event, "approval.granted");
});

test("chainAnomalies is pure: same records, same answer, no clock", () => {
  const unit = scenario(600_000, 100_000);
  const all = records(unit);
  const first = chainAnomalies(all);
  assert.deepEqual(chainAnomalies(all), first);
  assert.deepEqual(chainAnomalies([...all]), first);
  assert.equal(first.length, 1);
});

test("an empty log has no anomalies", () => {
  const unit = newCase();
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean");
  assert.deepEqual(result.anomalies, []);
});

// ===========================================================================
// Anomalies change nothing
// ===========================================================================

test("a log full of anomalies is still clean, and log verify still exits 0", () => {
  const unit = scenario(600_000, 100_000);
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean");
  assert.equal(result.anomalies.length, 1);

  const run = runCli(unit, ["log", "verify", "--json"]);
  assert.equal(run.code, 0, "an anomaly moved the exit code");
  const body = JSON.parse(run.out) as Record<string, unknown>;
  assert.equal(body["status"], "clean");
  assert.equal((body["anomalies"] as unknown[]).length, 1);
  assert.equal(run.err, "", "--json answers in one object on stdout and says nothing on stderr");

  const human = runCli(unit, ["log", "verify"]);
  assert.equal(human.code, 0);
  assert.match(human.out, /^clean: /u, "the verdict is still the verdict");
  assert.match(human.err, /timestamp anomaly\(ies\)/u);
  assert.match(human.err, /NOTHING is refused/u);
  assert.match(human.err, /gate-ts-regression/u);
});

test("the anomalies field is additive: absent when there is nothing to report", () => {
  const unit = scenario(1_000, 60_000);
  const run = runCli(unit, ["log", "verify", "--json"]);
  assert.equal(run.code, 0);
  const body = JSON.parse(run.out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["status", "records", "head"]);
  assert.equal(run.err, "", "a log with no anomaly must print nothing to stderr");
});

test("a corrupt log reports the corruption and no anomalies", () => {
  const unit = scenario(600_000, 100_000);
  // Truncate the chain to a state that cannot verify: a hand-appended junk line
  // is the one thing in this suite that does not go through the append path,
  // deliberately, because the case under test is a log the writer would refuse
  // to produce.
  writeFileSync(unit.logPath, `${readFileSync(unit.logPath, "utf8")}{"not":"a record"}\n`, "utf8");
  const result = verify(unit.logPath);
  assert.equal(result.status, "corrupt");
  assert.deepEqual(
    result.anomalies,
    [],
    "a chain that does not verify gets no anomaly report: the corruption is the finding",
  );

  const run = runCli(unit, ["log", "verify", "--json"]);
  assert.equal(run.code, 1);
  const body = JSON.parse(run.out) as Record<string, unknown>;
  assert.equal(body["status"], "corrupt");
  assert.equal(body["anomalies"], undefined);
});

test("status reports anomalies without moving health or the exit code", () => {
  const unit = scenario(600_000, 100_000);
  const run = runCli(unit, ["status", "--policy", unit.policyPath, "--json"]);
  const body = JSON.parse(run.out) as Record<string, unknown>;
  assert.equal(body["healthy"], true, "an anomaly must not move the health verdict");
  assert.equal(run.code, 0, "an anomaly must not move the exit code");
  assert.equal((body["anomalies"] as unknown[]).length, 1);

  const clean = scenario(1_000, 60_000);
  const cleanRun = runCli(clean, ["status", "--policy", clean.policyPath, "--json"]);
  const cleanBody = JSON.parse(cleanRun.out) as Record<string, unknown>;
  assert.equal(cleanBody["anomalies"], undefined, "the field is additive");
  assert.match(cleanRun.out, /"healthy":true/u);
});

test("status's human output names anomalies and still says health: ok", () => {
  const unit = scenario(600_000, 100_000);
  const run = runCli(unit, ["status", "--policy", unit.policyPath]);
  assert.equal(run.code, 0);
  // APRV-91 #14 turned status into an aligned table: the colon after each key
  // became a column of spaces. The claim under test is unchanged — an anomaly
  // is reported and health still says ok.
  assert.match(run.out, /^health {2,}ok$/mu);
  assert.match(run.out, /^timestamp anomalies {2,}1 \(reported, NOT refused/mu);
});

test("verification is unchanged by anomalies: the records still verify one by one", () => {
  const unit = scenario(600_000, 100_000);
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean");
  if (result.status !== "clean") return;
  assert.equal(result.records, records(unit).length);
  assert.equal(result.head?.seq, records(unit).length);
});
