/**
 * The audit lifecycle (APRV-40): sample → backlog → review.
 *
 * Every record here is produced by the real append path — `core/gate.ts`,
 * `core/token.ts`, `core/execute.ts`, and `core/audit.ts` calling `appendEvent`.
 * Nothing hand-writes a log line, so no assertion rests on a record the write
 * boundary would have rejected, and every scenario ends by walking the chain: a
 * refusal that leaves a broken log has still failed.
 *
 * Timestamps are injected as clocks (amended SPEC.md §8, A2). `audit.*` is
 * gate-typed, so no public function here takes a `ts`.
 *
 * The secret comes from a TEST-SCOPED variable name that is passed in as an
 * explicit environment object, never exported into this process: a suite that
 * set a real-looking variable in `process.env` would be one import away from
 * changing another suite's behavior.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderQueue } from "../src/channels/render-queue.js";
import {
  AUDIT_ACTOR,
  AUDIT_REFUSAL_CODES,
  TRANSIENT_APPEND_CODES,
  isTransientAppendError,
  openSamples,
  parseSubjectRef,
  reviewSample,
  sampleSupervised,
  sampledSubjects,
  supervisedExecutions,
} from "../src/core/audit.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { namesApprover } from "../src/core/gate.js";
import { verify } from "../src/core/verify.js";
import { resetAuditSweepNotices, sweepAuditSampling } from "../src/daemon/audit.js";
import { main } from "../src/cli/main.js";
import {
  appendAttestation,
  consumeToken,
  decide,
  register,
  request,
  startExecution,
} from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-audit-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function fixedClock(ts: string): () => string {
  return () => ts;
}

const TEST_SECRET_ENV = "APPROVAL_TEST_SAMPLING_SECRET";
const SECRET = "operator-held-secret-never-in-the-log";
const ENV: NodeJS.ProcessEnv = { [TEST_SECRET_ENV]: SECRET };

/** Rate 1: every supervised execution is selected, so the lifecycle is exercised
 * without depending on which subjects a particular secret happens to pick. The
 * selection function itself is `tests/sampler.test.ts`'s subject. */
function policyText(audit: string[]): string {
  return [
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
    "  files.write.*:",
    "    autonomy: supervised",
    "  communicate.email.external:",
    "    autonomy: manual",
    "budgets:",
    "  global:",
    "    daily_usd: 10",
    "    daily_actions: 50",
    ...audit,
    "```",
    "",
  ].join("\n");
}

const SAMPLE_EVERYTHING = [
  "audit:",
  "  supervised_sample_rate: 1",
  `  sampling_secret_env: ${TEST_SECRET_ENV}`,
];

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: { policy: { file: string } };
}

function newCase(audit: string[] = SAMPLE_EVERYTHING): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText(audit), "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: "task-042:chaser",
      payload_hash: bindingFor("task-042:chaser"),
    },
    {
      class: "files.write.local",
      summary: "Write the draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft",
      payload_hash: bindingFor("task-042:draft"),
    },
    {
      class: "files.write.local",
      summary: "Write the second draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft2",
      payload_hash: bindingFor("task-042:draft2"),
    },
    {
      class: "read.inbox",
      summary: "Read the inbox",
      reversible: true,
      est_cost_usd: "0",
      idempotency_key: "task-042:read",
      payload_hash: bindingFor("task-042:read"),
    },
  ],
};

/** Attest + register: the baseline every scenario starts from. */
function ready(audit: string[] = SAMPLE_EVERYTHING): Case {
  const unit = newCase(audit);
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok,
    true,
    "attestation append failed",
  );
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: ENVELOPE },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

/**
 * Start a supervised execution. No token: supervised actions have no grant, so
 * the declaration is what authorizes and the executor states its bytes against
 * it (APRV-140).
 */
function startSupervised(unit: Case, key: string, minutes: number): void {
  const started = startExecution(
    unit.logPath,
    key,
    { ...unit.options, presentedPayloadHash: bindingFor(key) },
    at(minutes),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
}

function records(unit: Case): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(unit.logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

function sweep(unit: Case, minutes: number, env: NodeJS.ProcessEnv = ENV) {
  return sampleSupervised(unit.logPath, unit.dir, {
    policy: { file: unit.policyPath },
    env,
    clock: fixedClock(at(minutes)),
  });
}

async function runCli(unit: Case, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main([...argv, "--log", unit.logPath], {
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
// The frozen vocabulary
// ===========================================================================

test("the audit refusal-code union is frozen public API", async () => {
  assert.deepEqual(
    [...AUDIT_REFUSAL_CODES],
    [
      "actor-not-human",
      // APRV-483. Beside the identity code it refines, and spelled as the
      // gate spells it: a review is held to the roster a grant is.
      "actor-not-approver",
      // APRV-483 refutation: the roster is read from attested bytes only.
      "policy-not-attested",
      // PR #614 refutation F1: attested bytes that do not load name no roster.
      "policy-invalid",
      "not-sampled",
      "already-reviewed",
      "ambiguous-subject",
      // APRV-481. Beside the subject codes because, like them, it is a fact
      // about the sample the log holds: the surface named bytes the sampled
      // execution did not bind to.
      "rendered-payload-mismatch",
      // APRV-127's reconciliation codes. Additive: every code above kept its
      // name and its meaning, so a supervisor branching on the pre-split union
      // is unaffected, and the new ones only ever come from the new verbs.
      "not-obliged",
      "already-satisfied",
      "note-required",
      // APRV-239. Placed here, immediately after the code it is judged beside,
      // because both rules are properties of a review's own arguments and both
      // are settled before the log is read. Additive again: nothing above moved.
      "reaction-conflicts-verdict",
      // APRV-482. Beside the two rules it is judged with: all three are
      // properties of the review's own arguments, settled before the log is read.
      "verdict-required",
      "revert-required",
      "obligation-not-appended",
      "log-unreadable",
      "log-torn-tail",
      "log-corrupt",
      "append-failed",
    ],
  );
});

test("the sampler's actor is a system identity, distinct from the daemon's", async () => {
  assert.equal(AUDIT_ACTOR, "system:audit");
  assert.match(AUDIT_ACTOR, /^system:/u);
});

// ===========================================================================
// Eligibility is derived, never self-reported
// ===========================================================================

test("only supervised executions are candidates", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:read", 3); // autonomous

  // The manual action goes through the token path, which also writes
  // execution.started — and must not be a candidate.
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
      payload_hash: bindingFor("task-042:chaser"),
    },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(requested.ok, true);
  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(1), unit.options);
  assert.equal(granted.ok, true);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");
  const consumed = consumeToken(
    unit.logPath,
    "task-042:chaser",
    granted.token,
    at(4),
    "agent:claude",
    { policyFile: unit.policyPath, presentedPayloadHash: bindingFor("task-042:chaser") },
  );
  assert.equal(consumed.ok, true, consumed.ok ? "" : consumed.message);

  const candidates = supervisedExecutions(records(unit), loadPolicy({ file: unit.policyPath }));
  assert.deepEqual(
    candidates.map((candidate) => candidate.actionKey),
    ["task-042:draft"],
    "the candidate set must hold exactly the supervised execution",
  );
  assertClean(unit);
});

test("eligibility follows the policy, not anything written into the event", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const all = records(unit);

  assert.equal(supervisedExecutions(all, loadPolicy({ file: unit.policyPath })).length, 1);

  // Same log, a policy under which the class resolves manual: the candidate is
  // gone. Nothing in the log changed, so nothing in the log decided this.
  const strict = join(unit.dir, "STRICT.md");
  writeFileSync(
    strict,
    policyText(SAMPLE_EVERYTHING).replace("  files.write.*:\n    autonomy: supervised", "  files.write.*:\n    autonomy: manual"),
    "utf8",
  );
  assert.equal(supervisedExecutions(all, loadPolicy({ file: strict })).length, 0);
});

test("an unloadable policy makes everything manual, so nothing is a candidate", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const load = loadPolicy({ file: join(unit.dir, "does-not-exist.md") });
  assert.equal(load.ok, false);
  assert.deepEqual(supervisedExecutions(records(unit), load), []);
});

test("the derivation reads the registration and the policy, never a claimed autonomy", async () => {
  // Structural, in the spirit of tests/ratchet.test.ts: global invariant 4 says
  // self-reported fields never reduce scrutiny, and the cheapest way for that to
  // break here is for a future edit to start trusting a payload key. There is
  // no field an authoring agent can write that this function reads.
  const source = readFileSync(
    new URL("../../src/core/audit.ts", import.meta.url),
    "utf8",
  );
  const body = source.slice(source.indexOf("export function supervisedExecutions"));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  assert.match(fn, /findDeclaration/u, "the class must come from the registration record");
  assert.match(fn, /resolve\(load, declared\.class\)/u, "the autonomy must be re-resolved");
  assert.equal(
    /payloadOf|payload\[/u.test(fn),
    false,
    "supervisedExecutions read a payload field; eligibility must be derived, never self-reported",
  );
});

// ===========================================================================
// Sampling
// ===========================================================================

test("a sweep appends one audit.sampled per selected supervised execution", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);

  const result = sweep(unit, 5);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sampler.enabled, true);
  assert.deepEqual(
    result.appended.map((entry) => entry.candidate.actionKey),
    ["task-042:draft", "task-042:draft2"],
  );

  const sampled = records(unit).filter((record) => record.event === "audit.sampled");
  assert.equal(sampled.length, 2);
  const first = sampled[0] as EventRecord;
  assert.equal(first.actor, AUDIT_ACTOR);
  assert.equal(first.action_key, "task-042:draft");
  assert.equal(first.task, "task-042");
  assert.equal(first.ts, at(5), "the ts is the injected write-boundary clock, not the caller's");
  const payload = first.payload as Record<string, unknown>;
  assert.equal(payload["subject_event"], "execution.started");
  assert.equal(payload["class"], "files.write.local");
  assert.equal(payload["rate"], 1);
  assert.equal(typeof payload["subject_hash"], "string");
  assert.equal(typeof payload["subject_seq"], "number");
  assertClean(unit);
});

test("the secret appears nowhere in the log a sweep produced", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const raw = readFileSync(unit.logPath, "utf8");
  assert.equal(raw.includes(SECRET), false, "the sampling secret reached the log");
  assert.equal(
    raw.includes(TEST_SECRET_ENV),
    false,
    "even the variable name has no business in the log; the policy already carries it",
  );
});

test("a second sweep appends nothing: exactly once per subject", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);

  assert.equal(sweep(unit, 5).ok, true);
  const afterFirst = records(unit).length;

  const second = sweep(unit, 6);
  assert.equal(second.ok, true);
  if (second.ok) assert.deepEqual(second.appended, []);
  assert.equal(records(unit).length, afterFirst, "the second sweep appended something");
  assert.equal(records(unit).filter((record) => record.event === "audit.sampled").length, 1);
  assertClean(unit);
});

test("a new supervised execution after a sweep is sampled by the next one", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  startSupervised(unit, "task-042:draft2", 6);

  const again = sweep(unit, 7);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(
    again.appended.map((entry) => entry.candidate.actionKey),
    ["task-042:draft2"],
  );
  assertClean(unit);
});

test("rate 0 samples nothing and says so", async () => {
  const unit = ready([
    "audit:",
    "  supervised_sample_rate: 0",
    `  sampling_secret_env: ${TEST_SECRET_ENV}`,
  ]);
  startSupervised(unit, "task-042:draft", 2);
  const result = sweep(unit, 5);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sampler.enabled, false);
  if (!result.sampler.enabled) assert.equal(result.sampler.reason, "rate-zero");
  assert.deepEqual(result.appended, []);
  assert.equal(records(unit).filter((record) => record.event === "audit.sampled").length, 0);
});

test("a missing secret disables sampling and appends nothing", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const before = records(unit).length;

  const result = sweep(unit, 5, {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sampler.enabled, false);
  if (!result.sampler.enabled) assert.equal(result.sampler.reason, "secret-unset");
  assert.equal(records(unit).length, before, "a disabled sampler wrote to the log");
  assertClean(unit);
});

test("a partial rate samples a subset and leaves the rest unsampled", async () => {
  const unit = ready([
    "audit:",
    "  supervised_sample_rate: 0.5",
    `  sampling_secret_env: ${TEST_SECRET_ENV}`,
  ]);
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);

  const result = sweep(unit, 5);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const sampledKeys = result.appended.map((entry) => entry.candidate.actionKey);
  assert.ok(sampledKeys.length <= 2);
  // Whatever this secret picks, a re-sweep picks exactly the same set: the
  // selection is reproducible, which is what makes an operator able to check it.
  const again = sweep(unit, 6);
  assert.equal(again.ok, true);
  if (again.ok) assert.deepEqual(again.appended, []);
  assertClean(unit);
});

// ===========================================================================
// The daemon hook
// ===========================================================================

test("the daemon sweep appends through the same path and warns on nothing", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const warnings: string[] = [];

  const summary = sweepAuditSampling({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    cwd: unit.dir,
    clock: fixedClock(at(5)),
    env: ENV,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(summary, { sampled: 1, disabled: null });
  assert.deepEqual(warnings, []);
  assert.equal(records(unit).filter((record) => record.event === "audit.sampled").length, 1);
  assertClean(unit);
});

test("the daemon sweep reports a disabled sampler without warning and without writing", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const warnings: string[] = [];
  const notices: string[] = [];
  const before = records(unit).length;

  const summary = sweepAuditSampling({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    cwd: unit.dir,
    clock: fixedClock(at(5)),
    env: {},
    warn: (message) => warnings.push(message),
    notice: (message) => notices.push(message),
  });

  assert.deepEqual(summary, { sampled: 0, disabled: "secret-unset" });
  assert.deepEqual(warnings, [], "a configuration fact must not use the failure channel");
  assert.equal(notices.length, 1);
  assert.match(notices[0] as string, /audit sampling is OFF \(secret-unset\)/u);
  assert.equal(
    notices[0]?.includes(SECRET),
    false,
    "the notice quoted the secret",
  );
  assert.equal(records(unit).length, before);
});

// ===========================================================================
// Contention: a deferred sample and a real refusal (APRV-381)
// ===========================================================================

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA_DIR = join(REPO_ROOT, "schema");

/**
 * Run `body` while an outside party holds the append lock.
 *
 * The lockfile is what every writer in this repository contends for, so holding
 * it here is the same contention the primary daemon met on 2026-09-19: no stub,
 * no injected error, and the refusal comes from `core/log.ts`'s own acquisition.
 */
function underHeldLock<T>(unit: Case, body: () => T): T {
  mkdirSync(dirname(unit.logPath), { recursive: true });
  const lock = `${unit.logPath}.lock`;
  closeSync(openSync(lock, "wx"));
  try {
    return body();
  } finally {
    unlinkSync(lock);
  }
}

/**
 * A copy of `schema/` with `audit.sampled` struck from `event.schema.json`'s
 * enum, so the sample is refused at the real write boundary.
 *
 * The rest of the schema is copied byte for byte: the refusal under test is the
 * write boundary's own `validation`, which is the shape a retry cannot repair.
 */
function schemaDirRejectingSamples(): string {
  counter += 1;
  const dir = join(scratch, `schema-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(SCHEMA_DIR)) {
    if (!entry.endsWith(".json")) continue;
    copyFileSync(join(SCHEMA_DIR, entry), join(dir, entry));
  }
  const path = join(dir, "event.schema.json");
  const schema = JSON.parse(readFileSync(path, "utf8")) as {
    properties: { event: { enum: string[] } };
  };
  const enumeration = schema.properties.event.enum;
  const index = enumeration.indexOf("audit.sampled");
  assert.notEqual(index, -1, "audit.sampled is not in the event enum");
  enumeration.splice(index, 1);
  writeFileSync(path, JSON.stringify(schema, null, 2), "utf8");
  return dir;
}

/** The three sinks, collected, so a case can assert which channel spoke. */
interface Heard {
  warnings: string[];
  deferrals: string[];
  samples: { actionKey: string; retry: boolean }[];
}

function listening(): Heard {
  return { warnings: [], deferrals: [], samples: [] };
}

function daemonSweep(
  unit: Case,
  minutes: number,
  heard: Heard,
  extra: { schemaDir?: string; withDeferSink?: boolean } = {},
) {
  return sweepAuditSampling({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    cwd: unit.dir,
    clock: fixedClock(at(minutes)),
    env: ENV,
    ...(extra.schemaDir === undefined ? {} : { schemaDir: extra.schemaDir }),
    warn: (message) => heard.warnings.push(message),
    ...(extra.withDeferSink === false
      ? {}
      : { defer: (message: string) => heard.deferrals.push(message) }),
    sampled: (sample, retry) =>
      heard.samples.push({ actionKey: sample.candidate.actionKey, retry }),
  });
}

test("the transient append codes are the two that decide nothing", () => {
  // A closed list, and closed in the fail-closed direction: a code added to
  // `core/log.ts` later is a refusal until someone decides it is a deferral.
  assert.deepEqual([...TRANSIENT_APPEND_CODES], ["lock-timeout", "head-moved"]);
  assert.equal(isTransientAppendError({ code: "lock-timeout", message: "" }), true);
  assert.equal(isTransientAppendError({ code: "head-moved", message: "" }), true);
  for (const code of ["validation", "canonicalization", "corrupt-tail", "io"] as const) {
    assert.equal(isTransientAppendError({ code, message: "" }), false, code);
  }
});

test("a held lock defers the sample by name, and the next sweep appends it as the retry", async () => {
  resetAuditSweepNotices();
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const before = records(unit).length;
  const heard = listening();

  const started = Date.now();
  const blocked = underHeldLock(unit, () => daemonSweep(unit, 5, heard));
  const waited = Date.now() - started;

  assert.deepEqual(blocked, { sampled: 0, disabled: null });
  assert.deepEqual(heard.warnings, [], "a deferral must not use the channel a real refusal uses");
  assert.deepEqual(heard.samples, []);
  assert.equal(heard.deferrals.length, 1);
  const line = heard.deferrals[0] as string;
  assert.match(line, /task-042:draft/u, "the line must name the action key");
  assert.match(line, /lock-timeout/u);
  assert.match(line, /retries it on the next tick/u);
  assert.match(line, /NOT lost/u);
  assert.equal(records(unit).length, before, "a deferred sample wrote to the log");
  // The decision recorded in `daemon/audit.ts`: the sweep pays `core/log.ts`'s own
  // wait and does not raise it for itself. A longer wait would show up here.
  assert.ok(waited >= 1_000, `the sweep gave up after ${String(waited)}ms`);

  // The lock is gone. Nothing was remembered about the sample being DUE: the
  // sweep re-derives that from the log, which is why the deferral cost nothing.
  const retried = daemonSweep(unit, 6, heard);
  assert.deepEqual(retried, { sampled: 1, disabled: null });
  assert.deepEqual(heard.warnings, []);
  assert.equal(heard.deferrals.length, 1, "the deferral was said once, not once per sweep");
  assert.deepEqual(heard.samples, [{ actionKey: "task-042:draft", retry: true }]);
  assert.equal(records(unit).filter((record) => record.event === "audit.sampled").length, 1);

  // Third sweep: nothing pending, nothing said, and no stale retry claim.
  const idle = daemonSweep(unit, 7, heard);
  assert.deepEqual(idle, { sampled: 0, disabled: null });
  assert.equal(heard.samples.length, 1);
  assertClean(unit);
});

test("a sweep that never deferred claims no retry", async () => {
  resetAuditSweepNotices();
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const heard = listening();

  const summary = daemonSweep(unit, 5, heard);

  assert.deepEqual(summary, { sampled: 1, disabled: null });
  assert.deepEqual(heard.samples, [{ actionKey: "task-042:draft", retry: false }]);
  assert.deepEqual(heard.deferrals, []);
  assertClean(unit);
});

test("a caller with no defer sink is still told about the deferral", async () => {
  resetAuditSweepNotices();
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const before = records(unit).length;
  const heard = listening();

  const blocked = underHeldLock(unit, () =>
    daemonSweep(unit, 5, heard, { withDeferSink: false }),
  );

  assert.deepEqual(blocked, { sampled: 0, disabled: null });
  assert.deepEqual(heard.deferrals, []);
  assert.equal(heard.warnings.length, 1, "a deferral nobody prints is a dropped sample");
  assert.match(heard.warnings[0] as string, /task-042:draft/u);
  assert.match(heard.warnings[0] as string, /retries it on the next tick/u);
  assert.equal(records(unit).length, before);
  assertClean(unit);
});

test("a refusal a retry cannot fix keeps the append-refused form", async () => {
  resetAuditSweepNotices();
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  const before = records(unit).length;
  const heard = listening();

  const summary = daemonSweep(unit, 5, heard, { schemaDir: schemaDirRejectingSamples() });

  assert.deepEqual(summary, { sampled: 0, disabled: null });
  assert.deepEqual(heard.deferrals, [], "a schema refusal is not a deferral");
  assert.deepEqual(heard.samples, []);
  assert.equal(heard.warnings.length, 1);
  const warning = heard.warnings[0] as string;
  assert.match(
    warning,
    /^audit sampling: append-failed: audit\.sampled for task-042:draft was not appended \(validation\)/u,
    "the pre-APRV-381 form is what a real refusal still reads as",
  );
  assert.doesNotMatch(warning, /retries it on the next tick/u);
  assert.equal(records(unit).length, before);
  assertClean(unit);

  // And the sample is still owed: a refusal changed no eligibility. With the real
  // schema the very next sweep appends it, with no retry claim, because this
  // process deferred nothing.
  const good = daemonSweep(unit, 6, heard);
  assert.deepEqual(good, { sampled: 1, disabled: null });
  assert.deepEqual(heard.samples, [{ actionKey: "task-042:draft", retry: false }]);
  assertClean(unit);
});

// ===========================================================================
// The backlog and the queue projection
// ===========================================================================

test("QUEUE.md's sampled-audit backlog fills on sample and clears on review", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);

  const empty = renderQueue(unit.logPath, { policy: { file: unit.policyPath } }, at(4));
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.auditBacklog, 0);
    assert.match(empty.markdown, /_Empty\._ No `audit\.sampled` event/u);
  }

  sweep(unit, 5);
  const filled = renderQueue(unit.logPath, { policy: { file: unit.policyPath } }, at(6));
  assert.equal(filled.ok, true);
  if (filled.ok) {
    assert.equal(filled.auditBacklog, 1);
    assert.match(filled.markdown, /1 sampled action\(s\) with no later `audit\.reviewed`/u);
    assert.match(filled.markdown, /task-042:draft/u);
  }

  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;
  const reviewed = reviewSample(
    unit.logPath,
    { kind: "seq", seq: sample.seq },
    "human:carter",
    "spot-checked the written file",
    { ...unit.options, verdict: "ok", clock: fixedClock(at(7)) },
  );
  assert.equal(reviewed.ok, true, reviewed.ok ? "" : reviewed.message);

  const cleared = renderQueue(unit.logPath, { policy: { file: unit.policyPath } }, at(8));
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.auditBacklog, 0);
  assert.deepEqual(openSamples(records(unit)), []);
  assertClean(unit);
});

test("a review that precedes its sample does not close it", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const firstSample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;
  assert.equal(
    reviewSample(unit.logPath, { kind: "seq", seq: firstSample.seq }, "human:carter", null, { ...unit.options,
      verdict: "ok",
      clock: fixedClock(at(6)),
    }).ok,
    true,
  );

  // A second sample of a different action, appended AFTER that review. The
  // earlier review must not be read as covering it.
  startSupervised(unit, "task-042:draft2", 7);
  sweep(unit, 8);
  const open = openSamples(records(unit));
  assert.equal(open.length, 1);
  assert.equal(open[0]?.actionKey, "task-042:draft2");
  assertClean(unit);
});

// ===========================================================================
// approval audit review — the human-only verb
// ===========================================================================

test("review is human-only in core", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  for (const actor of ["agent:claude", "system:daemon", "carter"]) {
    const result = reviewSample(unit.logPath, { kind: "action-key", actionKey: "task-042:draft" }, actor, null, { ...unit.options, verdict: "ok" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "actor-not-human");
  }
  assert.equal(records(unit).length, before, "a refused review wrote to the log");
  assertClean(unit);
});

test("review refuses not-sampled, already-reviewed and ambiguous-subject", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);

  const missing = reviewSample(unit.logPath, { kind: "seq", seq: 999 }, "human:carter", null, { ...unit.options, verdict: "ok" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "not-sampled");

  const unknownKey = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:nope" },
    "human:carter",
    null,
    { ...unit.options, verdict: "ok" },
  );
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) assert.equal(unknownKey.code, "not-sampled");

  const first = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:carter",
    null,
    { ...unit.options, verdict: "ok", clock: fixedClock(at(6)) },
  );
  assert.equal(first.ok, true);

  const again = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:carter",
    null,
    { ...unit.options, verdict: "ok", clock: fixedClock(at(7)) },
  );
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "already-reviewed");
  assertClean(unit);
});

test("the reviewed event names the sample and carries the note", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;

  const result = reviewSample(
    unit.logPath,
    { kind: "seq", seq: sample.seq },
    "human:carter",
    "the file matches what was declared",
    { ...unit.options, verdict: "ok", clock: fixedClock(at(9)) },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.record.event, "audit.reviewed");
  assert.equal(result.record.actor, "human:carter");
  assert.equal(result.record.action_key, "task-042:draft");
  assert.equal(result.record.task, "task-042");
  assert.equal(result.record.ts, at(9));
  const payload = result.record.payload as Record<string, unknown>;
  assert.equal(payload["subject_seq"], sample.seq);
  assert.equal(payload["reviewed"], true);
  assert.equal(payload["note"], "the file matches what was declared");
  assertClean(unit);
});

test("APRV-481: a new review names its sample, the execution it judged, and its verdict", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;
  const sampled = sample.payload as Record<string, unknown>;

  const result = reviewSample(unit.logPath, { kind: "seq", seq: sample.seq }, "human:carter", null, { ...unit.options,
    clock: fixedClock(at(9)),
    verdict: "ok",
  });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  const payload = result.record.payload as Record<string, unknown>;
  assert.equal(payload["subject_seq"], sample.seq, "subject_seq is not the sample's seq");
  assert.equal(
    payload["sampled_subject_hash"],
    sampled["subject_hash"],
    "sampled_subject_hash is not the hash the sample recorded",
  );
  const started = records(unit).find((record) => record.seq === sampled["subject_seq"]) as EventRecord;
  assert.equal(started.event, "execution.started");
  assert.equal(payload["sampled_subject_hash"], started.hash, "the hash does not join to the execution");
  assert.equal(payload["verdict"], "ok");
  // No surface said it showed the bytes, so the record claims no reading of them.
  assert.equal("payload_hash" in payload, false, "a review nobody showed bytes recorded a payload hash");
  assertClean(unit);
});

test("APRV-481: the payload hash is recorded only when the surface showed the bound bytes", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);
  sweep(unit, 5);
  const samples = records(unit).filter((record) => record.event === "audit.sampled");
  const before = records(unit).length;

  // Bytes that are not the binding: refused, and nothing written.
  const wrong = reviewSample(
    unit.logPath,
    { kind: "seq", seq: (samples[0] as EventRecord).seq },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(9)), verdict: "ok", renderedPayloadHash: bindingFor("task-042:draft2") },
  );
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, "rendered-payload-mismatch");
  assert.equal(records(unit).length, before, "a mismatched payload hash wrote to the log");

  // The binding itself: recorded.
  const shown = reviewSample(
    unit.logPath,
    { kind: "seq", seq: (samples[0] as EventRecord).seq },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(10)), verdict: "ok", renderedPayloadHash: bindingFor("task-042:draft") },
  );
  assert.equal(shown.ok, true, shown.ok ? "" : shown.message);
  if (shown.ok) {
    assert.equal((shown.record.payload as Record<string, unknown>)["payload_hash"], bindingFor("task-042:draft"));
  }

  // Shown nothing: absent.
  const unseen = reviewSample(
    unit.logPath,
    { kind: "seq", seq: (samples[1] as EventRecord).seq },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(11)), verdict: "ok" },
  );
  assert.equal(unseen.ok, true, unseen.ok ? "" : unseen.message);
  if (unseen.ok) assert.equal("payload_hash" in (unseen.record.payload as Record<string, unknown>), false);
  assertClean(unit);
});

test("APRV-481: a review written before the fields were required still verifies", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;
  // An old review, written under the pre-APRV-481 schema: no verdict and no
  // subject hash. Appended through the real writer with that schema, so the
  // chain is a real chain and the only thing under test is the read boundary.
  const oldSchemaDir = join(unit.dir, "schema-pre-481");
  mkdirSync(oldSchemaDir, { recursive: true });
  const schemaRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");
  for (const name of readdirSync(schemaRoot)) {
    if (!name.endsWith(".schema.json")) continue;
    let text = readFileSync(join(schemaRoot, name), "utf8");
    if (name === "event.schema.json") {
      const parsed = JSON.parse(text) as { $defs: Record<string, unknown> };
      parsed.$defs["audit_reviewed_record"] = parsed.$defs["audit_reviewed_record_historical"];
      text = JSON.stringify(parsed);
    }
    writeFileSync(join(oldSchemaDir, name), text, "utf8");
  }
  const appended = appendEvent(
    unit.logPath,
    {
      ts: at(6),
      event: "audit.reviewed",
      actor: "human:carter",
      task: "task-042",
      action_key: "task-042:draft",
      payload: { subject_seq: sample.seq, subject_event: "audit.sampled", reviewed: true },
    },
    { schemaDir: oldSchemaDir },
  );
  assert.equal(appended.ok, true, JSON.stringify(appended));
  assertClean(unit);
  assert.deepEqual(openSamples(records(unit)), [], "the old review no longer closes its sample");
});

test("the note is optional", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;
  const result = reviewSample(unit.logPath, { kind: "seq", seq: sample.seq }, "human:carter", null, { ...unit.options,
    verdict: "ok",
    clock: fixedClock(at(9)),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.record.payload as Record<string, unknown>)["note"], undefined);
});

// ===========================================================================
// Graded reactions (APRV-239)
// ===========================================================================

test("a review records the reaction beside the verdict", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;

  const result = reviewSample(
    unit.logPath,
    { kind: "seq", seq: sample.seq },
    "human:carter",
    "exactly the file I wanted, and it said so in the summary",
    { ...unit.options, verdict: "ok", clock: fixedClock(at(9)), reaction: "loved" },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;

  const payload = result.record.payload as Record<string, unknown>;
  assert.equal(payload["reaction"], "loved");
  // The enforcement field is still the enforcement field, and it is untouched
  // by the grade sitting next to it.
  assert.equal(payload["verdict"], "ok");
  assert.equal(payload["reviewed"], true);
  assertClean(unit);
});

test("an omitted reaction leaves no key: absence is never `indifferent`", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;

  const result = reviewSample(unit.logPath, { kind: "seq", seq: sample.seq }, "human:carter", null, { ...unit.options,
    verdict: "ok",
    clock: fixedClock(at(9)),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const payload = result.record.payload as Record<string, unknown>;
  assert.ok(!("reaction" in payload), "an omitted reaction wrote a key anyway");
  assertClean(unit);
});

test("`indifferent` and `liked` need no note; `loved` and `disliked` refuse note-required", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);
  sweep(unit, 5);
  const samples = records(unit).filter((record) => record.event === "audit.sampled");
  assert.equal(samples.length, 2);

  // The two ordinary readings: one tap, no form.
  const ok = reviewSample(
    unit.logPath,
    { kind: "seq", seq: (samples[0] as EventRecord).seq },
    "human:carter",
    null,
    { ...unit.options, verdict: "ok", clock: fixedClock(at(6)), reaction: "indifferent" },
  );
  assert.equal(ok.ok, true, ok.ok ? "" : ok.message);

  const liked = reviewSample(
    unit.logPath,
    { kind: "seq", seq: (samples[1] as EventRecord).seq },
    "human:carter",
    null,
    { ...unit.options, verdict: "ok", clock: fixedClock(at(7)), reaction: "liked" },
  );
  assert.equal(liked.ok, true, liked.ok ? "" : liked.message);

  // The two that require the human's own words. Blank is not a note: an empty
  // string satisfies a presence check and tells a reader exactly as much as the
  // absent field would.
  const before = records(unit).length;
  for (const [reaction, note] of [
    ["loved", null],
    ["loved", "   "],
    ["disliked", null],
    ["disliked", ""],
  ] as Array<[("loved" | "disliked"), string | null]>) {
    const refused = reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      "human:carter",
      note,
      { ...unit.options, verdict: "ok", clock: fixedClock(at(8)), reaction },
    );
    assert.equal(refused.ok, false, `${reaction} with ${JSON.stringify(note)} was accepted`);
    if (!refused.ok) {
      assert.equal(refused.code, "note-required");
      assert.match(refused.message, /--note/u);
    }
  }
  assert.equal(records(unit).length, before, "a refused review wrote to the log");
  assertClean(unit);
});

test("--deny with liked or loved refuses reaction-conflicts-verdict", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  for (const reaction of ["liked", "loved"] as const) {
    const refused = reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      "human:carter",
      "a note, so this is not note-required",
      { ...unit.options, clock: fixedClock(at(6)), verdict: "denied", reaction },
    );
    assert.equal(refused.ok, false, `denied + ${reaction} was accepted`);
    if (!refused.ok) assert.equal(refused.code, "reaction-conflicts-verdict");
  }

  // The other two grades say the same direction as the verdict and are legal.
  const disliked = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:carter",
    "should not have gone out",
    { ...unit.options, clock: fixedClock(at(7)), verdict: "denied", reaction: "disliked" },
  );
  assert.equal(disliked.ok, true, disliked.ok ? "" : disliked.message);
  if (disliked.ok) {
    const payload = disliked.record.payload as Record<string, unknown>;
    assert.equal(payload["verdict"], "denied");
    assert.equal(payload["reaction"], "disliked");
  }
  // One reviewed + one reconciliation.required from the denial; the four
  // refusals above added nothing.
  assert.equal(records(unit).length, before + 2);
  assertClean(unit);
});

test("both reaction rules are settled after the actor check and before the log is read", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);

  // AFTER the actor check: a non-human caller is told it is not human, not that
  // its reaction conflicts. Identity is the first question.
  const notHuman = reviewSample(
    unit.logPath,
    { kind: "seq", seq: 999 },
    "agent:claude",
    null,
    { ...unit.options, verdict: "denied", reaction: "loved" },
  );
  assert.equal(notHuman.ok, false);
  if (!notHuman.ok) assert.equal(notHuman.code, "actor-not-human");

  // BEFORE the verified read: a subject that does not exist would answer
  // `not-sampled`, and a log that does not exist would answer `log-unreadable`.
  // Both are reached only by reading, so a reaction refusal from either proves
  // nothing was read.
  const noSubject = reviewSample(
    unit.logPath,
    { kind: "seq", seq: 999 },
    "human:carter",
    "worded, so this is the conflict rule and not note-required",
    { ...unit.options, verdict: "denied", reaction: "loved" },
  );
  assert.equal(noSubject.ok, false);
  if (!noSubject.ok) assert.equal(noSubject.code, "reaction-conflicts-verdict");

  const noLog = reviewSample(
    join(unit.dir, "nowhere", "events.jsonl"),
    { kind: "seq", seq: 1 },
    "human:carter",
    null,
    { verdict: "ok", reaction: "disliked" },
  );
  assert.equal(noLog.ok, false);
  if (!noLog.ok) assert.equal(noLog.code, "note-required");
  assertClean(unit);
});

test("a seq argument names the sample, not the execution it sampled", async () => {
  assert.deepEqual(parseSubjectRef("12"), { kind: "seq", seq: 12 });
  assert.deepEqual(parseSubjectRef("task-042:draft"), {
    kind: "action-key",
    actionKey: "task-042:draft",
  });
  assert.deepEqual(parseSubjectRef("0"), { kind: "action-key", actionKey: "0" });
});

// ===========================================================================
// The CLI
// ===========================================================================

test("approval audit list reports the backlog and whether sampling is on", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);

  const listed = await runCli(unit, ["audit", "list", "--policy", unit.policyPath, "--json"]);
  assert.equal(listed.code, 0, listed.err);
  const body = JSON.parse(listed.out) as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["open"], 1);
  const sampling = body["sampling"] as Record<string, unknown>;
  // The secret is NOT in this process's environment, so the CLI reports the
  // sampler as off — and reports the variable NAME, never a value.
  assert.equal(sampling["secret_env"], TEST_SECRET_ENV);
  assert.equal(listed.out.includes(SECRET), false);
});

test("approval audit review appends through the CLI and clears the backlog", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;

  const run = await runCli(unit, [
    "audit",
    "review",
    "--ok",
    String(sample.seq),
    "--note",
    "looked at the diff",
    "--as",
    "human:carter",
    "--json",
  ]);
  assert.equal(run.code, 0, run.err);
  const body = JSON.parse(run.out) as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["sample_seq"], sample.seq);
  assert.equal(body["actor"], "human:carter");
  assert.deepEqual(openSamples(records(unit)), []);
  assertClean(unit);
});

test("approval audit review --reaction reports the grade on both output forms", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);
  sweep(unit, 5);

  const json = await runCli(unit, [
    "audit",
    "review",
    "--ok",
    "task-042:draft",
    "--reaction",
    "loved",
    "--note",
    "the file is exactly what was declared",
    "--as",
    "human:carter",
    "--json",
  ]);
  assert.equal(json.code, 0, json.err);
  const body = JSON.parse(json.out) as Record<string, unknown>;
  assert.equal(body["reaction"], "loved");
  assert.equal(body["verdict"], "ok");

  // Human output says the grade AND says what kind of thing it is, because a
  // word printed beside a verdict with no framing reads as a second verdict.
  const human = await runCli(unit, [
    "audit",
    "review",
    "--ok",
    "task-042:draft2",
    "--reaction",
    "indifferent",
    "--as",
    "human:carter",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /reaction: indifferent/u);
  assert.match(human.out, /guidance, not policy/u);

  // Absent means absent on the JSON surface too: the key is present and null,
  // so a consumer can tell "no reaction" from "this build has no such field".
  const unit2 = ready();
  startSupervised(unit2, "task-042:draft", 2);
  sweep(unit2, 5);
  const silent = await runCli(unit2, [
    "audit",
    "review",
    "--ok",
    "task-042:draft",
    "--as",
    "human:carter",
    "--json",
  ]);
  assert.equal(silent.code, 0, silent.err);
  assert.equal((JSON.parse(silent.out) as Record<string, unknown>)["reaction"], null);
  assert.equal(silent.out.includes("indifferent"), false);
  assertClean(unit);
  assertClean(unit2);
});

test("approval audit review refuses a misspelled --reaction at exit 2", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  const run = await runCli(unit, [
    "audit",
    "review",
    "--ok",
    "task-042:draft",
    "--reaction",
    "love",
    "--as",
    "human:carter",
    "--json",
  ]);
  assert.equal(run.code, 2);
  assert.match(run.err, /disliked \| indifferent \| liked \| loved/u);
  assert.equal(records(unit).length, before, "a usage error wrote to the log");
});

test("approval audit review surfaces both reaction refusals with exit 1", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  const conflict = await runCli(unit, [
    "audit",
    "review",
    "task-042:draft",
    "--deny",
    "--reaction",
    "loved",
    "--note",
    "worded",
    "--as",
    "human:carter",
    "--json",
  ]);
  assert.equal(conflict.code, 1);
  assert.equal(
    (JSON.parse(conflict.err) as { error: { code: string } }).error.code,
    "reaction-conflicts-verdict",
  );

  const wordless = await runCli(unit, [
    "audit",
    "review",
    "--ok",
    "task-042:draft",
    "--reaction",
    "disliked",
    "--as",
    "human:carter",
    "--json",
  ]);
  assert.equal(wordless.code, 1);
  assert.equal(
    (JSON.parse(wordless.err) as { error: { code: string } }).error.code,
    "note-required",
  );

  assert.equal(records(unit).length, before, "a refused review wrote to the log");
  assertClean(unit);
});

test("approval audit review refuses an agent identity as a usage error", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  const run = await runCli(unit, ["audit", "review", "task-042:draft", "--as", "agent:claude", "--json"]);
  assert.equal(run.code, 2, "a non-human identity is rejected before core is called");
  assert.match(run.err, /human:<id>/u);
  assert.equal(records(unit).length, before);
});

test("approval audit review on an unsampled action refuses with exit 1", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);

  const run = await runCli(unit, ["audit", "review", "task-042:draft", "--ok", "--as", "human:carter", "--json"]);
  assert.equal(run.code, 1);
  const body = JSON.parse(run.err) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not-sampled");
});

// ===========================================================================
// The roster (APRV-483)
// ===========================================================================

/** `unit`'s policy with a roster: `carter` on `files.write.*`, `bob` declared but not on it. */
function withRoster(unit: Case, roster: boolean): void {
  const text = readFileSync(unit.policyPath, "utf8")
    .replace(
      "classes:\n",
      ["approvers:", "  carter:", "    channels: [cli]", "  bob:", "    channels: [cli]", "classes:", ""].join("\n"),
    )
    .replace(
      "  files.write.*:\n    autonomy: supervised\n",
      `  files.write.*:\n    autonomy: supervised\n${roster ? "    approvers: [carter]\n" : ""}`,
    );
  writeFileSync(unit.policyPath, text, "utf8");
  const loaded = loadPolicy({ file: unit.policyPath });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  // Re-attested, so the supervised start below runs under the edited bytes.
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter", at(1)).ok, true);
}

test("APRV-483: a reviewer the class's roster does not name is refused actor-not-approver", async () => {
  const unit = ready();
  withRoster(unit, true);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  const stranger = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:bob",
    null,
    { ...unit.options, clock: fixedClock(at(6)), verdict: "ok" },
  );
  assert.equal(stranger.ok, false, "a non-roster reviewer was recorded");
  if (!stranger.ok) assert.equal(stranger.code, "actor-not-approver");
  assert.equal(records(unit).length, before, "a refused reviewer wrote to the log");

  const named = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(7)), verdict: "ok" },
  );
  assert.equal(named.ok, true, named.ok ? "" : named.message);
  assertClean(unit);
});

test("APRV-483: --as cannot name a reviewer off the roster; it can name one on it", async () => {
  const unit = ready();
  withRoster(unit, true);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  const asBob = await runCli(unit, [
    "audit", "review", "task-042:draft", "--ok", "--policy", unit.policyPath, "--as", "human:bob", "--json",
  ]);
  assert.equal(asBob.code, 1, asBob.err);
  assert.equal((JSON.parse(asBob.err) as { error: { code: string } }).error.code, "actor-not-approver");
  assert.equal(records(unit).length, before, "--as off the roster wrote to the log");

  const asCarter = await runCli(unit, [
    "audit", "review", "task-042:draft", "--ok", "--policy", unit.policyPath, "--as", "human:carter", "--json",
  ]);
  assert.equal(asCarter.code, 0, asCarter.err);
  assertClean(unit);
});

test("APRV-483: a rule that names no roster restricts no reviewer, as for grants", async () => {
  const unit = ready();
  withRoster(unit, false);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const result = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:bob",
    null,
    { ...unit.options, clock: fixedClock(at(6)), verdict: "ok" },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assertClean(unit);
});

test("APRV-483 refutation: the roster cannot come from a file the reviewer chose or nobody attested", async () => {
  const unit = ready();
  withRoster(unit, true);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;
  const review = (options: Record<string, unknown>) =>
    reviewSample(unit.logPath, { kind: "action-key", actionKey: "task-042:draft" }, "human:bob", null, {
      clock: fixedClock(at(6)),
      verdict: "ok",
      ...options,
    });

  // 1. `--policy` pointed at a roster-free file the reviewer wrote.
  const elsewhere = join(unit.dir, "elsewhere.md");
  writeFileSync(elsewhere, policyText(SAMPLE_EVERYTHING), "utf8");
  const chosen = review({ policy: { file: elsewhere } });
  assert.equal(chosen.ok, false, "a reviewer-chosen policy supplied the roster");
  if (!chosen.ok) assert.equal(chosen.code, "policy-not-attested");
  const cli = await runCli(unit, [
    "audit", "review", "task-042:draft", "--ok", "--policy", elsewhere, "--as", "human:bob", "--json",
  ]);
  assert.equal(cli.code, 1, cli.err);
  assert.equal((JSON.parse(cli.err) as { error: { code: string } }).error.code, "policy-not-attested");

  // 2. The attested file edited to drop the roster, and not re-attested.
  const attestedText = readFileSync(unit.policyPath, "utf8");
  writeFileSync(unit.policyPath, attestedText.replace("    approvers: [carter]\n", ""), "utf8");
  const drifted = review(unit.options);
  assert.equal(drifted.ok, false, "an unattested edit dropped the roster");
  if (!drifted.ok) assert.equal(drifted.code, "policy-not-attested");

  // 3. No policy file at all: unreadable is not "no roster".
  unlinkSync(unit.policyPath);
  const missing = review(unit.options);
  assert.equal(missing.ok, false, "a missing policy restricted nobody");
  if (!missing.ok) assert.equal(missing.code, "policy-not-attested");

  writeFileSync(unit.policyPath, attestedText, "utf8");
  assert.equal(records(unit).length, before, "a refused review wrote to the log");
  // Restored bytes are the attested ones: the roster binds again, and its member records.
  const named = reviewSample(unit.logPath, { kind: "action-key", actionKey: "task-042:draft" }, "human:carter", null, {
    ...unit.options,
    clock: fixedClock(at(7)),
    verdict: "ok",
  });
  assert.equal(named.ok, true, named.ok ? "" : named.message);
  assertClean(unit);
});

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("PR #614 refutation F1: an attested policy that does not load names no roster, so every reviewer is refused", async () => {
  // Three ways to break the bytes the loader refuses and `policy attest` does
  // not: a glob in a roster, a roster entry that is not an identifier, and a
  // YAML typo. Each is attested, so the refusal cannot be policy-not-attested.
  const breakages: Array<[string, (text: string) => string]> = [
    ["glob entry", (text) => text.replace("    approvers: [carter]\n", '    approvers: [carter, "*"]\n')],
    ["non-identifier", (text) => text.replace("    approvers: [carter]\n", '    approvers: [carter, "Carter "]\n')],
    ["yaml typo", (text) => text.replace("    approvers: [carter]\n", "    approvers: [carter\n")],
  ];
  for (const [name, breakIt] of breakages) {
    const unit = ready();
    withRoster(unit, true);
    startSupervised(unit, "task-042:draft", 2);
    const validText = readFileSync(unit.policyPath, "utf8");
    const brokenText = breakIt(validText);
    writeFileSync(unit.policyPath, brokenText, "utf8");
    assert.equal(loadPolicy({ file: unit.policyPath }).ok, false, `${name}: the broken policy loaded`);
    assert.equal(
      appendAttestation(unit.logPath, unit.policyPath, "human:carter", at(4)).ok,
      true,
      `${name}: attestation of the broken bytes failed, so the probe tests nothing`,
    );
    const brokenSha = sha256Of(unit.policyPath);
    // The sweep reads the working file, so it samples under the valid text and
    // pins the policy in force, which is the broken attestation (PR #614 F2).
    // With the broken bytes back on disk the review reaches the pinned policy
    // and the only thing left to refuse it is that the policy does not load.
    writeFileSync(unit.policyPath, validText, "utf8");
    sweep(unit, 5);
    writeFileSync(unit.policyPath, brokenText, "utf8");
    assert.equal(sampledSubjects(records(unit))[0]?.policySha256, brokenSha, `${name}: the sample pinned another policy`);
    const before = records(unit).length;
    for (const reviewer of ["human:bob", "human:carter"]) {
      const result = reviewSample(
        unit.logPath,
        { kind: "action-key", actionKey: "task-042:draft" },
        reviewer,
        null,
        { ...unit.options, clock: fixedClock(at(6)), verdict: "ok" },
      );
      assert.equal(result.ok, false, `${name}: ${reviewer} recorded a review under a policy that names nobody`);
      if (!result.ok) assert.equal(result.code, "policy-invalid", `${name}: ${reviewer}: ${result.message}`);
    }
    const cli = await runCli(unit, ["audit", "review", "task-042:draft", "--ok", "--as", "human:bob", "--json"]);
    assert.equal(cli.code, 1, cli.err);
    assert.equal((JSON.parse(cli.err) as { error: { code: string } }).error.code, "policy-invalid");
    assert.equal(records(unit).length, before, `${name}: a refused review wrote to the log`);
    assertClean(unit);
  }
});

test("PR #614 refutation F2: a sample pins the attested policy, and a re-attestation that renames the rule cannot open the review", async () => {
  const unit = ready();
  withRoster(unit, true);
  const pinned = sha256Of(unit.policyPath);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const sample = records(unit).find((record) => record.event === "audit.sampled") as EventRecord;
  assert.equal((sample.payload as Record<string, unknown>)["policy_sha256"], pinned);
  assert.equal(sampledSubjects(records(unit))[0]?.policySha256, pinned);

  // The probe: the class's rule renamed away and the result attested.
  const attestedText = readFileSync(unit.policyPath, "utf8");
  writeFileSync(unit.policyPath, attestedText.replace("  files.write.*:\n", "  files.remote.*:\n"), "utf8");
  assert.equal(loadPolicy({ file: unit.policyPath }).ok, true);
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter", at(5)).ok, true);
  const before = records(unit).length;
  for (const reviewer of ["human:bob", "human:carter"]) {
    const result = reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      reviewer,
      null,
      { ...unit.options, clock: fixedClock(at(6)), verdict: "ok" },
    );
    assert.equal(result.ok, false, `${reviewer} reviewed under a policy that no longer names the class`);
    if (!result.ok) {
      assert.equal(result.code, "policy-not-attested");
      assert.match(result.message, new RegExp(pinned, "u"), "the refusal does not name the hash the review needs");
    }
  }
  assert.equal(records(unit).length, before, "a refused review wrote to the log");

  // The pinned path: the bytes the sample was taken under are back on disk, so
  // the roster is that policy's. Its member reviews; anyone else is refused.
  writeFileSync(unit.policyPath, attestedText, "utf8");
  const stranger = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:bob",
    null,
    { ...unit.options, clock: fixedClock(at(7)), verdict: "ok" },
  );
  assert.equal(stranger.ok, false);
  if (!stranger.ok) assert.equal(stranger.code, "actor-not-approver");
  const named = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(8)), verdict: "ok" },
  );
  assert.equal(named.ok, true, named.ok ? "" : named.message);
  assertClean(unit);
});

test("PR #614 refutation F2: a class that matches no rule in the pinned policy is refused actor-not-approver", async () => {
  const unit = ready();
  // `files.write.*` gone and the defaults supervised: the class resolves
  // supervised with no rule, so the policy names no roster for it.
  const text = readFileSync(unit.policyPath, "utf8")
    .replace("defaults:\n  autonomy: manual\n", "defaults:\n  autonomy: supervised\n")
    .replace("  files.write.*:\n    autonomy: supervised\n", "");
  writeFileSync(unit.policyPath, text, "utf8");
  assert.equal(loadPolicy({ file: unit.policyPath }).ok, true);
  assert.equal(appendAttestation(unit.logPath, unit.policyPath, "human:carter", at(1)).ok, true);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;
  const result = reviewSample(
    unit.logPath,
    { kind: "action-key", actionKey: "task-042:draft" },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(6)), verdict: "ok" },
  );
  assert.equal(result.ok, false, "a class no rule names was approvable by anyone");
  if (!result.ok) {
    assert.equal(result.code, "actor-not-approver");
    assert.match(result.message, /matches no rule/u);
  }
  assert.equal(records(unit).length, before, "a refused review wrote to the log");
  assertClean(unit);
});

test("PR #614 refutation F2: a sample written before samples pinned a policy reads as not pinned", () => {
  const subjects = sampledSubjects([
    {
      seq: 1,
      ts: T0,
      event: "audit.sampled",
      actor: AUDIT_ACTOR,
      action_key: "task-042:draft",
      payload: { subject_seq: 1, subject_hash: "f".repeat(64) },
      alg: "sha256/jcs",
      prev: null,
      hash: "e".repeat(64),
    } as unknown as EventRecord,
  ]);
  assert.equal(subjects[0]?.policySha256, null);
});

test("PR #614 refutation F5: every review the runtime writes says its verdict was explicit", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);
  sweep(unit, 5);
  const ok = reviewSample(unit.logPath, { kind: "action-key", actionKey: "task-042:draft" }, "human:carter", null, {
    ...unit.options,
    clock: fixedClock(at(6)),
    verdict: "ok",
  });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.message);
  const cli = await runCli(unit, ["audit", "review", "task-042:draft2", "--deny", "--as", "human:carter"]);
  assert.equal(cli.code, 0, cli.err);
  const reviews = records(unit).filter((record) => record.event === "audit.reviewed");
  assert.equal(reviews.length, 2);
  for (const review of reviews) {
    assert.equal((review.payload as Record<string, unknown>)["verdict_source"], "explicit");
  }
  assertClean(unit);
});

test("PR #614 refutation N7: a key two tasks declare is refused, never reviewed under a guessed roster", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  // Only a tampered log reaches this: registration refuses the collision, so
  // the second declaration goes through the writer directly, as tampering would.
  const registered = records(unit).find((record) => record.event === "task.registered") as EventRecord;
  const collided = appendEvent(unit.logPath, {
    ts: at(5),
    event: "task.registered",
    actor: registered.actor,
    task: "task-043",
    ...(registered.payload === undefined ? {} : { payload: registered.payload }),
  });
  assert.equal(collided.ok, true, JSON.stringify(collided));
  const before = records(unit).length;
  const result = reviewSample(unit.logPath, { kind: "action-key", actionKey: "task-042:draft" }, "human:carter", null, {
    ...unit.options,
    clock: fixedClock(at(6)),
    verdict: "ok",
  });
  assert.equal(result.ok, false, "a review was recorded under a collided declaration");
  if (!result.ok) {
    assert.equal(result.code, "actor-not-approver");
    assert.match(result.message, /more than one task/u);
  }
  assert.equal(records(unit).length, before, "a refused review wrote to the log");
});

test("APRV-481/483 refutation: a sample that names no subject hash or no class is refused, never reviewed", async () => {
  const unit = ready();
  withRoster(unit, true);
  const before = records(unit).length;
  // Two hand-written samples through the real writer: one naming no subject
  // hash, one naming a hash but no action key and no class. Both pin the
  // attested policy (PR #614 F2), so the refusals below are about the sample.
  const pinned = createHash("sha256").update(readFileSync(unit.policyPath)).digest("hex");
  const noHash = appendEvent(unit.logPath, {
    ts: at(3),
    event: "audit.sampled",
    actor: AUDIT_ACTOR,
    payload: { subject_seq: 1, policy_sha256: pinned },
  });
  assert.equal(noHash.ok, true, JSON.stringify(noHash));
  const noClass = appendEvent(unit.logPath, {
    ts: at(4),
    event: "audit.sampled",
    actor: AUDIT_ACTOR,
    payload: { subject_seq: 1, subject_hash: "f".repeat(64), policy_sha256: pinned },
  });
  assert.equal(noClass.ok, true, JSON.stringify(noClass));
  const appended = records(unit).length;

  const hashless = reviewSample(
    unit.logPath,
    { kind: "seq", seq: noHash.ok ? noHash.record.seq : 0 },
    "human:carter",
    null,
    { ...unit.options, clock: fixedClock(at(6)), verdict: "ok" },
  );
  assert.equal(hashless.ok, false, "a review of a hashless sample was recorded");
  if (!hashless.ok) assert.equal(hashless.code, "not-sampled");

  const classless = reviewSample(
    unit.logPath,
    { kind: "seq", seq: noClass.ok ? noClass.record.seq : 0 },
    "human:bob",
    null,
    { ...unit.options, clock: fixedClock(at(7)), verdict: "ok" },
  );
  assert.equal(classless.ok, false, "a classless sample let an unrostered reviewer through");
  if (!classless.ok) assert.equal(classless.code, "actor-not-approver");

  // An empty roster names nobody (the schema's minItems 1 makes it unreachable
  // from a valid policy; the comparison itself is the backstop).
  assert.equal(namesApprover([], "human:carter"), false);

  assert.equal(records(unit).length, appended, "a refused review wrote to the log");
  assert.ok(appended > before);
  assertClean(unit);
});

// ===========================================================================
// An explicit affirmative (APRV-482)
// ===========================================================================

test("APRV-482: a review with no verdict is refused verdict-required, after the roster check (PR #614 N6)", async () => {
  const unit = ready();
  withRoster(unit, true);
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  // No verdict, with and without a grade, or a verdict that is neither word:
  // none is an approval. A lone `loved` is told it lacks a verdict, not a note
  // (the note rule judges a grade beside a verdict).
  for (const options of [
    {},
    { reaction: "liked" as const },
    { reaction: "indifferent" as const },
    { reaction: "loved" as const },
    { verdict: "maybe" as unknown as "ok" },
  ]) {
    const refused = reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      "human:carter",
      null,
      { ...unit.options, clock: fixedClock(at(6)), ...options },
    );
    assert.equal(refused.ok, false, `a review with no verdict was recorded (${JSON.stringify(options)})`);
    if (!refused.ok) assert.equal(refused.code, "verdict-required");
  }
  // N6: who may review is said before what the review lacks. A reviewer off
  // the roster tapping a grade is told actor-not-approver at once.
  for (const options of [{}, { reaction: "liked" as const }]) {
    const off = reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      "human:bob",
      null,
      { ...unit.options, clock: fixedClock(at(6)), ...options },
    );
    assert.equal(off.ok, false);
    if (!off.ok) assert.equal(off.code, "actor-not-approver");
  }
  // After the actor: a non-human is told it is not human first.
  const agent = reviewSample(unit.logPath, { kind: "seq", seq: 1 }, "agent:claude", null);
  assert.equal(agent.ok, false);
  if (!agent.ok) assert.equal(agent.code, "actor-not-human");

  assert.equal(records(unit).length, before, "a verdict-less review wrote to the log");
  assertClean(unit);
});

test("APRV-482: a bare CLI review is refused; --ok and --deny are the explicit forms", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  sweep(unit, 5);
  const before = records(unit).length;

  const bare = await runCli(unit, ["audit", "review", "task-042:draft", "--as", "human:carter", "--json"]);
  assert.equal(bare.code, 1, bare.err);
  assert.equal((JSON.parse(bare.err) as { error: { code: string } }).error.code, "verdict-required");

  const graded = await runCli(unit, [
    "audit", "review", "task-042:draft", "--reaction", "liked", "--as", "human:carter", "--json",
  ]);
  assert.equal(graded.code, 1, graded.err);
  assert.equal((JSON.parse(graded.err) as { error: { code: string } }).error.code, "verdict-required");

  const both = await runCli(unit, ["audit", "review", "task-042:draft", "--ok", "--deny", "--as", "human:carter"]);
  assert.equal(both.code, 2, "two opposite verdicts were not a usage error");
  assert.equal(records(unit).length, before, "a refused CLI review wrote to the log");

  const ok = await runCli(unit, ["audit", "review", "task-042:draft", "--ok", "--as", "human:carter", "--json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal((JSON.parse(ok.out) as { verdict: string }).verdict, "ok");
  const review = records(unit).find((record) => record.event === "audit.reviewed") as EventRecord;
  assert.equal((review.payload as Record<string, unknown>)["verdict"], "ok");
  assertClean(unit);
});

test("approval audit rejects an unknown subcommand and offers no way to sample", async () => {
  const unit = ready();
  const unknown = await runCli(unit, ["audit", "sample", "--json"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown subcommand/u);

  const help = await runCli(unit, ["audit", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /THERE IS NO "approval audit sample"/u);
});

test("audit list and QUEUE.md agree about what is outstanding", async () => {
  const unit = ready();
  startSupervised(unit, "task-042:draft", 2);
  startSupervised(unit, "task-042:draft2", 3);
  sweep(unit, 5);

  const rendered = renderQueue(unit.logPath, { policy: { file: unit.policyPath } }, at(6));
  assert.equal(rendered.ok, true);
  const listed = await runCli(unit, ["audit", "list", "--json"]);
  const body = JSON.parse(listed.out) as Record<string, unknown>;
  assert.equal(body["open"], rendered.ok ? rendered.auditBacklog : -1);
  assert.equal(sampledSubjects(records(unit)).length, 2);
});
