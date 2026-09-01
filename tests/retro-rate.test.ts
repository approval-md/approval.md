/**
 * Per-class retrospective sampling rates (APRV-183): `classes.<pattern>.retro_rate`.
 *
 * Four claims are under test, each a property rather than an example:
 *
 * 1. **The grammar.** A supervised class may declare its own `retro_rate`; a
 *    `manual` or `autonomous` one may not, and the attempt fails the whole
 *    policy CLOSED rather than sitting there as a review fraction nothing reads.
 *    That is `live_rate`'s convention, mirrored deliberately.
 * 2. **One mechanism.** Selection under a class rate is the same HMAC over the
 *    same event hash under the same secret; only the threshold moves. So the
 *    verdict is a pure function of (secret, hash, rate), identical bytes select
 *    identically forever, and the fraction a class draws tracks the class's rate
 *    rather than the global one.
 * 3. **The alias holds.** A class written as the pre-split `supervised` honours
 *    a `retro_rate` exactly as `supervised-retro` does, and still carries its
 *    load-time alias note.
 * 4. **Honesty is per class.** A policy whose only rate is per class samples
 *    those classes and says plainly that the rest are uncovered, in a
 *    machine-readable reason, through the same doctor check and the same
 *    `approval audit list` report that already spoke for the global rate.
 *
 * Every event this suite reads was written by the real append path, and every
 * scenario that writes ends by verifying the chain.
 *
 * The sampling secret lives in a TEST-SCOPED variable name. Core calls take it
 * as an explicit environment object; the two CLI cases need it in `process.env`
 * because a spawned verb reads the ambient environment, so it is set here and
 * removed in `after`, under a name no operator would choose.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { commandDoctor } from "../src/cli/doctor.js";
import { main } from "../src/cli/main.js";
import { sampleSupervised } from "../src/core/audit.js";
import type { EventRecord } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { classSampling, isSampled, resolveSampler } from "../src/core/sampler.js";
import { verify } from "../src/core/verify.js";
import {
  appendAttestation,
  finishExecution,
  register,
  startExecution,
} from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-retro-rate-"));
let counter = 0;

const TEST_SECRET_ENV = "APPROVAL_TEST_RETRO_RATE_SECRET";
const SECRET = "operator-held-secret-never-in-the-log";
const ENV: NodeJS.ProcessEnv = { [TEST_SECRET_ENV]: SECRET };

before(() => {
  process.env[TEST_SECRET_ENV] = SECRET;
});

after(() => {
  delete process.env[TEST_SECRET_ENV];
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

/** Deterministic stand-ins for record hashes: 64 lowercase hex, distinct. */
function hashes(count: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(createHash("sha256").update(`record-${String(index)}`, "utf8").digest("hex"));
  }
  return out;
}

interface PolicyOptions {
  /** `audit.supervised_sample_rate`, omitted when null. */
  global?: number | null;
  /** Name the sampling secret variable. */
  secret?: boolean;
}

function policyText(classes: string[], options: PolicyOptions = {}): string {
  const global = options.global === undefined ? 0.02 : options.global;
  const secret = options.secret !== false;
  const audit = [
    ...(global === null ? [] : [`  supervised_sample_rate: ${String(global)}`]),
    ...(secret ? [`  sampling_secret_env: ${TEST_SECRET_ENV}`] : []),
  ];
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "budgets:",
    "  global:",
    "    daily_usd: 10",
    "    daily_actions: 50",
    ...(audit.length === 0 ? [] : ["audit:", ...audit]),
    "classes:",
    ...classes,
    "```",
    "",
  ].join("\n");
}

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
}

function newCase(text: string): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, text, "utf8");
  return { dir, logPath: join(dir, ".approval", "log", "events.jsonl"), policyPath };
}

function loadAt(text: string): ReturnType<typeof loadPolicy> {
  return loadPolicy({ file: newCase(text).policyPath });
}

function samplerFor(text: string, env: NodeJS.ProcessEnv = ENV) {
  return resolveSampler(loadAt(text), env);
}

/** The one class shape most cases need: a retro class carrying its own rate. */
const HALF = ["  record.write.stage:", "    autonomy: supervised-retro", "    retro_rate: 0.5"];
/** A second supervised class that declares no rate of its own. */
const BARE = ["  record.write.draft:", "    autonomy: supervised-retro"];

// ===========================================================================
// 1. The grammar
// ===========================================================================

test("a supervised class may declare its own retro_rate, at every supervised spelling", () => {
  const cases: Array<[string[], string]> = [
    [HALF, "record.write.stage"],
    [["  record.write.draft:", "    autonomy: supervised", "    retro_rate: 0.5"], "record.write.draft"],
    [
      [
        "  files.write.*:",
        "    autonomy: supervised-live",
        "    live_rate: 0.1",
        "    retro_rate: 0.5",
      ],
      "files.write.local",
    ],
  ];
  for (const [classes, actionClass] of cases) {
    const load = loadAt(policyText(classes));
    assert.equal(load.ok, true, load.ok ? "" : load.message);
    const resolution = resolve(load, actionClass);
    assert.equal(resolution.autonomy, "supervised");
    assert.equal(resolution.retroRate, 0.5, `${actionClass} lost its declared retro_rate`);
  }
});

test("supervised-live carries a retro_rate because its unsampled remainder is reviewed", () => {
  const load = loadAt(
    policyText([
      "  files.write.*:",
      "    autonomy: supervised-live",
      "    live_rate: 0.25",
      "    retro_rate: 1",
    ]),
  );
  const resolution = resolve(load, "files.write.local");
  assert.equal(resolution.supervision, "live");
  assert.equal(resolution.liveRate, 0.25);
  assert.equal(resolution.retroRate, 1);
});

test("a retro_rate the grammar forbids fails the whole policy closed", () => {
  const cases: Array<[string, string[]]> = [
    ["retro_rate on a manual class", ["  policy.edit:", "    autonomy: manual", "    retro_rate: 0.5"]],
    [
      "retro_rate on an autonomous class",
      ["  read.web:", "    autonomy: autonomous", "    retro_rate: 0.5"],
    ],
    [
      "a retro_rate of zero, which is a review budget nobody filled in",
      ["  record.write.stage:", "    autonomy: supervised-retro", "    retro_rate: 0"],
    ],
    [
      "a retro_rate above one",
      ["  record.write.stage:", "    autonomy: supervised-retro", "    retro_rate: 1.5"],
    ],
    [
      "a retro_rate that is not a number",
      ["  record.write.stage:", "    autonomy: supervised-retro", '    retro_rate: "half"'],
    ],
  ];
  for (const [name, classes] of cases) {
    const load = loadAt(policyText(classes));
    assert.equal(load.ok, false, `${name} should not load`);
    // Fail closed, all the way: every class is manual and says why.
    for (const actionClass of ["record.write.stage", "policy.edit", "read.web"]) {
      const resolution = resolve(load, actionClass);
      assert.equal(resolution.autonomy, "manual", name);
      assert.equal(resolution.provenance, "fail-closed", name);
      assert.equal(resolution.retroRate, null, name);
    }
  }
});

test("a class declaring no retro_rate stays on the global rate", () => {
  const load = loadAt(policyText([...HALF, ...BARE]));
  assert.equal(resolve(load, "record.write.draft").retroRate, null);
  const sampler = resolveSampler(load, ENV);
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;
  assert.deepEqual(sampler.rateFor("record.write.draft"), {
    rate: 0.02,
    source: "global",
    pattern: "record.write.draft",
  });
  assert.deepEqual(sampler.rateFor("record.write.stage"), {
    rate: 0.5,
    source: "class",
    pattern: "record.write.stage",
  });
});

test("the irreversibility floor clears the class rate along with the supervision", () => {
  const load = loadAt(policyText(HALF));
  const gated = resolve(load, "record.write.stage", { reversible: false });
  assert.equal(gated.autonomy, "manual");
  assert.equal(gated.retroRate, null);
});

// ===========================================================================
// 2. One mechanism: the class rate moves the threshold and nothing else
// ===========================================================================

test("selection under a class rate is the same HMAC at a different threshold", () => {
  const sampler = samplerFor(policyText([...HALF, ...BARE]));
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;

  let disagreements = 0;
  for (const hash of hashes(400)) {
    assert.equal(
      sampler.selectsFor("record.write.stage", hash),
      isSampled(SECRET, hash, 0.5),
      "a class rate must select exactly as the shared construction does at that rate",
    );
    assert.equal(
      sampler.selectsFor("record.write.draft", hash),
      isSampled(SECRET, hash, 0.02),
      "a class with no rate of its own must select at the global rate",
    );
    if (
      sampler.selectsFor("record.write.stage", hash) !== sampler.selectsFor("record.write.draft", hash)
    ) {
      disagreements += 1;
    }
  }
  // The two rates must actually differ in effect, or the assertions above would
  // hold for a sampler that ignored the class rate entirely.
  assert.ok(disagreements > 0, "the class rate made no difference to any verdict");
});

test("identical bytes select identically, across calls and across samplers", () => {
  const text = policyText(HALF);
  const first = samplerFor(text);
  const second = samplerFor(text);
  assert.equal(first.enabled && second.enabled, true);
  if (!first.enabled || !second.enabled) return;

  for (const hash of hashes(200)) {
    const verdict = first.selectsFor("record.write.stage", hash);
    for (let repeat = 0; repeat < 5; repeat += 1) {
      assert.equal(first.selectsFor("record.write.stage", hash), verdict, "a re-roll appeared");
    }
    assert.equal(
      second.selectsFor("record.write.stage", hash),
      verdict,
      "two samplers over the same policy and secret disagreed",
    );
  }
});

test("the sampled fraction tracks the CLASS rate, not the global one", () => {
  const sampler = samplerFor(policyText([...HALF, ...BARE]));
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;

  const corpus = hashes(2000);
  const classSelected = corpus.filter((h) => sampler.selectsFor("record.write.stage", h)).length;
  const globalSelected = corpus.filter((h) => sampler.selectsFor("record.write.draft", h)).length;
  const classFraction = classSelected / corpus.length;
  const globalFraction = globalSelected / corpus.length;
  assert.ok(
    classFraction > 0.45 && classFraction < 0.55,
    `class rate 0.5 drew ${String(classFraction)}`,
  );
  assert.ok(globalFraction < 0.05, `global rate 0.02 drew ${String(globalFraction)}`);
});

test("a class rate of 1 draws everything and the global rate cannot lower it", () => {
  const sampler = samplerFor(
    policyText(["  record.write.stage:", "    autonomy: supervised-retro", "    retro_rate: 1"], {
      global: 0.0001,
    }),
  );
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;
  for (const hash of hashes(100)) {
    assert.equal(sampler.selectsFor("record.write.stage", hash), true);
  }
});

// ===========================================================================
// 3. The alias
// ===========================================================================

test("bare supervised honours a retro_rate exactly as supervised-retro does", () => {
  const alias = samplerFor(
    policyText(["  record.write.stage:", "    autonomy: supervised", "    retro_rate: 0.5"]),
  );
  const explicit = samplerFor(policyText(HALF));
  assert.equal(alias.enabled && explicit.enabled, true);
  if (!alias.enabled || !explicit.enabled) return;

  for (const hash of hashes(300)) {
    assert.equal(
      alias.selectsFor("record.write.stage", hash),
      explicit.selectsFor("record.write.stage", hash),
      "the alias drew a different sample from the spelling it aliases",
    );
  }
  assert.deepEqual(
    alias.rateFor("record.write.stage"),
    explicit.rateFor("record.write.stage"),
    "the alias resolved a different rate",
  );
});

test("the alias note survives a class that also declares a retro_rate", () => {
  const load = loadAt(
    policyText(["  record.write.stage:", "    autonomy: supervised", "    retro_rate: 0.5"]),
  );
  assert.equal(load.ok, true);
  if (!load.ok) return;
  const note = load.notes.find((entry) => entry.where === "classes.record.write.stage");
  assert.equal(note?.code, "supervised-alias");
});

// ===========================================================================
// 4. Honesty, per class
// ===========================================================================

test("a policy whose only rate is per class samples that class and states the rest", () => {
  const sampler = samplerFor(policyText([...HALF, ...BARE], { global: null }));
  assert.equal(sampler.enabled, true, "a class rate alone must keep the sampler running");
  if (!sampler.enabled) return;
  assert.equal(sampler.rate, null);
  assert.equal(sampler.fallbackReason, "rate-absent");

  // The rateless class is not sampled, and says so rather than borrowing a rate.
  assert.deepEqual(sampler.rateFor("record.write.draft"), {
    rate: null,
    source: "none",
    pattern: "record.write.draft",
  });
  for (const hash of hashes(100)) {
    assert.equal(sampler.selectsFor("record.write.draft", hash), false);
  }

  const report = classSampling(loadAt(policyText([...HALF, ...BARE], { global: null })), sampler);
  assert.deepEqual(
    report.map((entry) => [entry.pattern, entry.rate, entry.source, entry.enabled, entry.reason]),
    [
      ["record.write.draft", null, "none", false, "rate-absent"],
      ["record.write.stage", 0.5, "class", true, null],
    ],
  );
});

test("a global rate of zero leaves the class rates running and names itself", () => {
  const text = policyText([...HALF, ...BARE], { global: 0 });
  const sampler = samplerFor(text);
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;
  assert.equal(sampler.fallbackReason, "rate-zero");
  const report = classSampling(loadAt(text), sampler);
  assert.equal(report.find((e) => e.pattern === "record.write.draft")?.reason, "rate-zero");
  assert.equal(report.find((e) => e.pattern === "record.write.stage")?.rate, 0.5);
});

test("no rate anywhere is still a plainly disabled sampler", () => {
  const sampler = samplerFor(policyText(BARE, { global: null }));
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "rate-absent");
});

test("an unset secret disables every class, whatever rates they declare", () => {
  const text = policyText([...HALF, ...BARE]);
  const sampler = samplerFor(text, {});
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "secret-unset");
  for (const entry of classSampling(loadAt(text), sampler)) {
    assert.equal(entry.enabled, false);
    assert.equal(entry.reason, "secret-unset");
  }
});

test("a class rate with no secret named is refused for the same reason a global one is", () => {
  const sampler = samplerFor(policyText(HALF, { global: null, secret: false }));
  assert.equal(sampler.enabled, false);
  if (sampler.enabled) return;
  assert.equal(sampler.reason, "secret-env-unnamed");
  assert.ok(sampler.message.includes("retro_rate"), "the message must name the key that asked");
  assert.ok(!sampler.message.includes(SECRET));
});

test("the serialized sampler carries the rates and never the secret", () => {
  const sampler = samplerFor(policyText([...HALF, ...BARE]));
  assert.equal(sampler.enabled, true);
  if (!sampler.enabled) return;
  const serialized = JSON.stringify(sampler);
  assert.deepEqual(JSON.parse(serialized), {
    enabled: true,
    rate: 0.02,
    secret_env: TEST_SECRET_ENV,
    class_rates: { "record.write.stage": 0.5 },
  });
  assert.ok(!serialized.includes(SECRET));
});

// ===========================================================================
// 5. The sweep, through the real append path
// ===========================================================================

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

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

/** Register two actions, run both to completion, and return the case. */
function ranBoth(text: string): Case {
  const unit = newCase(text);
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok,
    true,
    "attestation append failed",
  );
  const registered = register(
    unit.logPath,
    {
      task: "task-042",
      envelope: {
        origin: { app: "example-capture", created_by: "human:carter" },
        state: "proposed",
        actions: [
          {
            class: "record.write.stage",
            summary: "stage a record",
            est_cost_usd: "0.01",
            idempotency_key: "task-042:stage",
            payload_hash: bindingFor("task-042:stage"),
          },
          {
            class: "record.write.draft",
            summary: "draft a record",
            est_cost_usd: "0.01",
            idempotency_key: "task-042:draft",
            payload_hash: bindingFor("task-042:draft"),
          },
        ],
      },
    },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  let minute = 1;
  for (const key of ["task-042:stage", "task-042:draft"]) {
    const started = startExecution(
      unit.logPath,
      key,
      { policy: { file: unit.policyPath }, presentedPayloadHash: bindingFor(key) },
      at(minute),
      "agent:claude",
    );
    assert.equal(started.ok, true, started.ok ? "" : started.message);
    const finished = finishExecution(unit.logPath, key, 0, at(minute + 1), "agent:claude");
    assert.equal(finished.ok, true, finished.ok ? "" : finished.message);
    minute += 2;
  }
  return unit;
}

test("a sweep draws the class at rate 1 and leaves the rateless class alone", () => {
  const unit = ranBoth(
    policyText(
      ["  record.write.stage:", "    autonomy: supervised-retro", "    retro_rate: 1", ...BARE],
      { global: null },
    ),
  );
  const swept = sampleSupervised(unit.logPath, unit.dir, {
    policy: { file: unit.policyPath },
    env: ENV,
    clock: () => at(10),
  });
  assert.equal(swept.ok, true);
  if (!swept.ok) return;
  assert.equal(swept.appended.length, 1, "exactly the class carrying a rate should be drawn");
  assert.equal(swept.appended[0]?.candidate.class, "record.write.stage");

  // The record states the rate the verdict was compared against, which is the
  // class's own and not the (absent) global fallback.
  const sampled = records(unit).find((record) => record.event === "audit.sampled");
  const payload = sampled?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.["rate"], 1);
  assert.equal(payload?.["selection"], "hmac-sha256/event-hash");
  assert.equal(verify(unit.logPath).status, "clean");
});

// ===========================================================================
// 6. Reporting: doctor and `approval audit list`
// ===========================================================================

function runCli(unit: Case, argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main(argv, {
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

test("doctor names which classes sample at which rate, and which do not", async () => {
  const unit = ranBoth(policyText([...HALF, ...BARE], { global: null }));
  // `doctor` is asynchronous (two checks touch the network stack), so it is
  // called directly rather than through `main`, which hands its promise to
  // `process.exitCode` and returns before the report is written.
  let out = "";
  await commandDoctor(["--json", "--log", unit.logPath], {
    out: (text) => {
      out += text;
    },
    err: () => undefined,
  }, unit.dir);
  const body = JSON.parse(out) as { checks: Array<{ check: string; detail: string }> };
  const sampling = body.checks.find((check) => check.check === "audit-sampling");
  assert.ok(sampling !== undefined, "doctor no longer reports the sampler");
  assert.ok(
    sampling.detail.includes("record.write.stage 0.5 (class)"),
    `class rate missing from doctor: ${sampling.detail}`,
  );
  assert.ok(
    sampling.detail.includes("record.write.draft none (rate-absent)"),
    `uncovered class missing from doctor: ${sampling.detail}`,
  );
  assert.ok(!sampling.detail.includes(SECRET));
});

test("approval audit list reports the per-class coverage beside the backlog", () => {
  const unit = ranBoth(policyText([...HALF, ...BARE]));
  const run = runCli(unit, ["audit", "list", "--json", "--log", unit.logPath]);
  assert.equal(run.code, 0, run.err);
  const body = JSON.parse(run.out) as {
    sampling: {
      enabled: boolean;
      rate: number | null;
      classes: Array<{ pattern: string; rate: number | null; source: string; enabled: boolean }>;
    };
  };
  assert.equal(body.sampling.enabled, true);
  assert.equal(body.sampling.rate, 0.02);
  assert.deepEqual(
    body.sampling.classes.map((entry) => [entry.pattern, entry.rate, entry.source, entry.enabled]),
    [
      ["record.write.draft", 0.02, "global", true],
      ["record.write.stage", 0.5, "class", true],
    ],
  );

  const text = runCli(unit, ["audit", "list", "--log", unit.logPath]);
  assert.ok(text.out.includes("record.write.stage: rate 0.5 (class)"), text.out);
  assert.ok(!text.out.includes(SECRET));
});
