/**
 * The autonomy split (APRV-127): `supervised-live` and `supervised-retro`.
 *
 * Four claims are under test here, and each one is a property rather than an
 * example:
 *
 * 1. **The grammar.** A policy may declare `supervised-live` with a `live_rate`
 *    or `supervised-retro`; the bare `supervised` still parses, still means
 *    retro, and now says so out loud through a load-time note. Everything the
 *    schema must reject fails CLOSED — all-manual — rather than half-understood.
 * 2. **No re-roll.** Live selection is HMAC over the action's `payload_hash`
 *    under an operator-held secret, so identical bytes select identically,
 *    always. The property test below hammers that from both ends: the same
 *    request repeated many times never changes its verdict, and a corpus of
 *    distinct payloads splits the same way on every evaluation.
 * 3. **Bit for bit.** A sampled `supervised-live` action's `approval.requested`
 *    is byte-identical to the record a `manual` class would have produced from
 *    the same registration. Nothing in the log says "this one was sampled",
 *    because a marker would be a distinction an approver could act on, and the
 *    verdict is recomputable by anyone holding the secret anyway.
 * 4. **Reconciliation.** A retrospective denial cannot undo anything, so it
 *    obliges and records; the obligation is loud while open and closable only by
 *    a person, and a `gated-revert` is checked against the chain, not the claim.
 *
 * Every record here comes from the real append path, and every scenario that
 * writes ends by walking the chain: a refusal that leaves a broken log has still
 * failed. Timestamps are injected as clocks (amended SPEC.md §8, A2).
 *
 * The sampling secret lives in a TEST-SCOPED variable name passed as an explicit
 * environment object, never exported into this process — a suite that set a
 * real-looking variable in `process.env` would be one import away from changing
 * another suite's behaviour.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { main } from "../src/cli/main.js";
import {
  obligationFor,
  openObligations,
  reconciliationObligations,
  sampleSupervised,
  satisfyObligation,
  supervisedExecutions,
} from "../src/core/audit.js";
import type { EventRecord } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { LIVE_SELECTION, resolveLiveSelector, selectionValue } from "../src/core/sampler.js";
import { verify } from "../src/core/verify.js";
import {
  appendAttestation,
  decide,
  finishExecution,
  register,
  request,
  startExecution,
} from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-autonomy-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

/** The reviewer's identity, passed explicitly rather than through the shell. */
const AS_CARTER = ["--as", "human:carter"] as const;

const TEST_SECRET_ENV = "APPROVAL_TEST_LIVE_SECRET";
const SECRET = "operator-held-secret-never-in-the-log";
const ENV: NodeJS.ProcessEnv = { [TEST_SECRET_ENV]: SECRET };

/** The content binding a registration declares, and the live selection's input. */
function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: { policy: { file: string }; env?: NodeJS.ProcessEnv };
}

function policyText(classes: string[], withSecretEnv = true): string {
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
    ...(withSecretEnv
      ? ["audit:", "  supervised_sample_rate: 1", `  sampling_secret_env: ${TEST_SECRET_ENV}`]
      : []),
    "classes:",
    ...classes,
    "```",
    "",
  ].join("\n");
}

function newCase(text: string): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, text, "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath }, env: ENV },
  };
}

/** One action per class under test, each with its own declared reversibility. */
function envelopeFor(
  actions: Array<{ key: string; cls: string; reversible?: boolean }>,
): Record<string, unknown> {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: actions.map((action) => ({
      class: action.cls,
      summary: `do ${action.key}`,
      est_cost_usd: "0.01",
      idempotency_key: action.key,
      payload_hash: bindingFor(action.key),
      ...(action.reversible === undefined ? {} : { reversible: action.reversible }),
    })),
  };
}

function ready(
  text: string,
  actions: Array<{ key: string; cls: string; reversible?: boolean }>,
): Case {
  const unit = newCase(text);
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok,
    true,
    "attestation append failed",
  );
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: envelopeFor(actions) },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
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

/**
 * Execute a `supervised-retro` action and sample it, returning the seq of the
 * `audit.sampled` record. The whole path is the real one: the executor appends
 * the start, and the sampler draws it at rate 1 with the operator's secret.
 */
function sampleOne(unit: Case, key: string, minutes: number): number {
  // Started AND finished: a dangling execution is its own `status` finding, and
  // a test about reconciliation noise should not be reading it.
  runRevert(unit, key, minutes);
  const swept = sampleSupervised(unit.logPath, unit.dir, {
    policy: { file: unit.policyPath },
    env: ENV,
    clock: () => at(minutes + 2),
  });
  assert.equal(swept.ok, true);
  if (!swept.ok) return 0;
  assert.equal(swept.appended.length, 1, "the sweep drew nothing to review");
  return swept.appended[0]?.record.seq ?? 0;
}

/** Run one action to completion through the executor, so the chain shows it ran. */
function runRevert(unit: Case, key: string, minutes: number): void {
  const started = startExecution(
    unit.logPath,
    key,
    { ...unit.options, presentedPayloadHash: bindingFor(key) },
    at(minutes),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  const finished = finishExecution(unit.logPath, key, 0, at(minutes + 1), "agent:claude");
  assert.equal(finished.ok, true, finished.ok ? "" : finished.message);
}

/** Ask for one action, at `minutes` after T0, as the agent. */
function ask(unit: Case, key: string, cls: string, minutes: number, reversible?: boolean) {
  return request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: key,
      cls,
      est_cost_usd: "0.01",
      ...(reversible === undefined ? {} : { reversible }),
    },
    at(minutes),
    "agent:claude",
    unit.options,
  );
}

// ===========================================================================
// 1. The grammar (AC 1)
// ===========================================================================

test("bare supervised parses as supervised-retro, with a load-time note", async () => {
  const unit = newCase(policyText(["  files.write.*:", "    autonomy: supervised"]));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const resolution = resolve(load, "files.write.local");
  assert.equal(resolution.autonomy, "supervised");
  assert.equal(resolution.declaredAutonomy, "supervised");
  assert.equal(resolution.supervision, "retro");
  assert.equal(resolution.liveRate, null);

  // The note is the whole point of keeping the alias: an author who reads the
  // split for the first time could reasonably think `supervised` now means
  // "supervised somehow, possibly live". It does not, and the runtime says so
  // rather than reinterpreting quietly.
  assert.equal(load.notes.length, 1);
  assert.equal(load.notes[0]?.code, "supervised-alias");
  assert.equal(load.notes[0]?.where, "classes.files.write.*");
  assert.match(load.notes[0]?.message ?? "", /supervised-retro/u);
});

test("a policy with no bare supervised carries no notes", async () => {
  const unit = newCase(
    policyText([
      "  files.write.*:",
      "    autonomy: supervised-retro",
      "  policy.edit:",
      "    autonomy: supervised-live",
      "    live_rate: 0.25",
    ]),
  );
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.deepEqual(load.notes, []);

  const retro = resolve(load, "files.write.local");
  assert.equal(retro.declaredAutonomy, "supervised-retro");
  assert.equal(retro.supervision, "retro");
  assert.equal(retro.liveRate, null);

  const live = resolve(load, "policy.edit");
  assert.equal(live.autonomy, "supervised");
  assert.equal(live.declaredAutonomy, "supervised-live");
  assert.equal(live.supervision, "live");
  assert.equal(live.liveRate, 0.25);
});

test("the grammar's mistakes fail the whole policy closed, never half-understood", async () => {
  const cases: Array<[string, string[]]> = [
    ["supervised-live with no live_rate", ["  policy.edit:", "    autonomy: supervised-live"]],
    [
      "live_rate on a class that is not live",
      ["  policy.edit:", "    autonomy: manual", "    live_rate: 0.5"],
    ],
    [
      "a live_rate of zero, which is spelled supervised-retro",
      ["  policy.edit:", "    autonomy: supervised-live", "    live_rate: 0"],
    ],
    [
      "a live_rate above one",
      ["  policy.edit:", "    autonomy: supervised-live", "    live_rate: 1.5"],
    ],
  ];

  for (const [label, classes] of cases) {
    const unit = newCase(policyText(classes));
    const load = loadPolicy({ file: unit.policyPath });
    assert.equal(load.ok, false, `${label} was accepted`);
    if (load.ok) continue;
    assert.equal(load.code, "schema-invalid", label);
    // And the consequence every load failure carries: everything is manual.
    assert.equal(resolve(load, "policy.edit").autonomy, "manual", label);
    assert.equal(resolve(load, "read.web").provenance, "fail-closed", label);
  }
});

test("defaults.autonomy cannot be supervised-live: there is nowhere to put the rate", async () => {
  const unit = newCase(
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: supervised-live",
      "```",
      "",
    ].join("\n"),
  );
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, false);
  if (load.ok) return;
  assert.equal(load.code, "schema-invalid");
});

// ===========================================================================
// 2. Selection: deterministic, secret-keyed, and never re-rolled (AC 2)
// ===========================================================================

const LIVE_CLASS = ["  files.write.*:", "    autonomy: supervised-live", "    live_rate: 0.5"];

test("selection is a pure function of the secret, the payload hash and the rate", async () => {
  const unit = newCase(policyText(LIVE_CLASS));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const selector = resolveLiveSelector(load, ENV);
  assert.equal(selector.available, true);
  if (!selector.available) return;

  // The whole corpus, evaluated a hundred times over. Not one verdict moves —
  // this is "no re-roll" stated as an experiment rather than as a comment.
  const corpus = Array.from({ length: 200 }, (_, index) => bindingFor(`payload-${String(index)}`));
  const draw = (): boolean[] => corpus.map((hash): boolean => selector.selects(hash, 0.5));
  const first = draw();
  for (let round = 0; round < 100; round += 1) {
    assert.deepEqual(draw(), first, "a verdict changed between evaluations of identical bytes");
  }

  // It is a fraction, not a coin that always lands the same way: at 0.5 over 200
  // payloads both answers occur. A selector that said "no" to everything would
  // pass the determinism check above and be no control at all.
  assert.ok(first.includes(true) && first.includes(false), "the rate selected nothing, or all");

  // Monotone in the rate, which is what makes `live_rate` mean what it says: an
  // action gated at rate r is gated at every rate above r.
  for (const hash of corpus.slice(0, 20)) {
    const value = selectionValue(SECRET, hash);
    assert.equal(selector.selects(hash, Math.min(1, value + 1e-9)), true);
    assert.equal(selector.selects(hash, value), false);
  }
});

test("a different secret is a different draw: the agent cannot compute its own luck", async () => {
  const unit = newCase(policyText(LIVE_CLASS));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const mine = resolveLiveSelector(load, ENV);
  const theirs = resolveLiveSelector(load, { [TEST_SECRET_ENV]: "a-different-operator-secret" });
  assert.equal(mine.available && theirs.available, true);
  if (!mine.available || !theirs.available) return;

  const corpus = Array.from({ length: 400 }, (_, index) => bindingFor(`guess-${String(index)}`));
  const differences = corpus.filter(
    (hash) => mine.selects(hash, 0.5) !== theirs.selects(hash, 0.5),
  ).length;
  // Two independent keyed PRFs at rate 0.5 disagree about half the time. Any
  // large disagreement proves the draw is keyed; an identical split would mean
  // the secret was decorative and the payload alone decided.
  assert.ok(differences > 100, `the two secrets drew alike ${String(differences)} times`);
});

test("live selection FAILS CLOSED: no usable secret gates every action in the class", async () => {
  const unit = newCase(policyText(LIVE_CLASS));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const unset = resolveLiveSelector(load, {});
  assert.equal(unset.available, false);
  if (unset.available) return;
  assert.equal(unset.reason, "secret-unset");
  assert.equal(unset.secretEnv, TEST_SECRET_ENV);
  assert.ok(!unset.message.includes(SECRET), "the secret must never appear in a message");

  // The asymmetry with retrospective sampling, asserted rather than assumed:
  // "gate every one of them" needs no selection function, so the strict reading
  // is available here and this control does not fail open.
  const gated = ready(policyText(LIVE_CLASS), [{ key: "task-042:draft", cls: "files.write.local" }]);
  const result = request(
    gated.logPath,
    { task: "task-042", actionKey: "task-042:draft", cls: "files.write.local", est_cost_usd: 0.01 },
    at(1),
    "agent:claude",
    { policy: { file: gated.policyPath }, env: {} },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proceed, false, "an unconfigured live class must gate, not proceed");
  assert.equal(result.live?.gated, true);
  // APRV-208 refined the REASON without touching the property. `secret-unset` no
  // longer settles the question on its own: a process with no secret asks the
  // operator's daemon, and there is no daemon here, so the verdict names which
  // delegated refusal happened. Gated either way, and now gated for a reason an
  // operator can act on ("start the daemon") rather than one they must not
  // ("export the secret into the agent's environment", which SPEC.md §5.2
  // forbids and which is why this failed closed for a fortnight, APRV-184).
  assert.equal(result.live?.reason, "draw-daemon-absent");
  assertClean(gated);
});

test("a retried request over identical bytes gets the identical verdict", async () => {
  // The evasion this closes: ask, dislike the answer, ask again until the draw
  // comes up unsampled. There is nothing to re-roll — the input is the payload
  // hash, so the only way to change the verdict is to change the action.
  const unit = ready(policyText(LIVE_CLASS), [
    { key: "task-042:draft", cls: "files.write.local" },
  ]);
  const verdicts = new Set<string>();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = ask(unit, "task-042:draft", "files.write.local", 1 + attempt);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    verdicts.add(`${String(result.live?.gated)}:${String(result.live?.reason)}`);
    // A gated request lands an approval.requested and the next attempt is a
    // duplicate, which is a different (correct) refusal; stop there.
    if (result.live?.gated === true) break;
  }
  assert.equal(verdicts.size, 1, `the verdict moved across retries: ${[...verdicts].join(", ")}`);
  assertClean(unit);
});

// ===========================================================================
// 3. The sampled action follows the manual path, bit for bit (AC 3)
// ===========================================================================

/** A rate that certainly selects `key`, and one that certainly does not. */
function ratesFor(key: string): { gating: number; sparing: number } {
  const value = selectionValue(SECRET, bindingFor(key));
  return { gating: Math.min(1, value + 1e-6), sparing: Math.max(1e-9, value - 1e-6) };
}

test("a sampled supervised-live request is byte-identical to a manual one", async () => {
  const key = "task-042:draft";
  const { gating } = ratesFor(key);

  const live = ready(
    policyText(["  files.write.*:", "    autonomy: supervised-live", `    live_rate: ${String(gating)}`]),
    [{ key, cls: "files.write.local" }],
  );
  const manual = ready(policyText(["  files.write.*:", "    autonomy: manual"]), [
    { key, cls: "files.write.local" },
  ]);

  const liveResult = ask(live, key, "files.write.local", 1);
  const manualResult = ask(manual, key, "files.write.local", 1);
  assert.equal(liveResult.ok && manualResult.ok, true);
  if (!liveResult.ok || !manualResult.ok) return;

  assert.equal(liveResult.live?.gated, true, "the chosen rate must select this payload");
  assert.equal(liveResult.live?.reason, "selected");
  assert.equal(liveResult.live?.selection, LIVE_SELECTION);
  assert.equal(liveResult.autonomy, "manual");
  assert.equal(liveResult.proceed, false);

  const liveRecord = liveResult.record;
  const manualRecord = manualResult.record;
  assert.ok(liveRecord !== null && manualRecord !== null);
  if (liveRecord === null || manualRecord === null) return;

  // Everything a reader could branch on is the same. The two logs differ only in
  // the policy they were attested against, which is exactly the one field that
  // SHOULD differ — the policies really are different files.
  assert.equal(liveRecord.event, manualRecord.event);
  assert.equal(liveRecord.actor, manualRecord.actor);
  assert.equal(liveRecord.task, manualRecord.task);
  assert.equal(liveRecord.action_key, manualRecord.action_key);

  const strip = (record: EventRecord): Record<string, unknown> => {
    const payload = { ...(record.payload as Record<string, unknown>) };
    delete payload["policy_sha256"];
    return payload;
  };
  assert.deepEqual(strip(liveRecord), strip(manualRecord));
  assert.deepEqual(Object.keys(liveRecord.payload as object), Object.keys(manualRecord.payload as object));

  // And nothing anywhere in the sampled log names the draw. A "this one was
  // sampled" marker would be a distinction an approver could act on, and the
  // whole value of the mechanism is that a sampled action is answered exactly as
  // a manual one is.
  const bytes = readFileSync(live.logPath, "utf8");
  assert.ok(!bytes.includes("supervised-live"), "the log named the mode");
  assert.ok(!bytes.includes(LIVE_SELECTION), "the log named the selection");
  assert.ok(!bytes.includes(SECRET), "the secret reached the log");
  assertClean(live);
  assertClean(manual);
});

test("a sampled action is granted, tokened and spent exactly as a manual one", async () => {
  const key = "task-042:draft";
  const { gating } = ratesFor(key);
  const unit = ready(
    policyText(["  files.write.*:", "    autonomy: supervised-live", `    live_rate: ${String(gating)}`]),
    [{ key, cls: "files.write.local" }],
  );

  const asked = ask(unit, key, "files.write.local", 1);
  assert.equal(asked.ok, true);
  if (!asked.ok) return;
  assert.equal(asked.live?.gated, true);

  // Without the token the executor refuses, even though the CLASS still resolves
  // supervised. This is the half of the split that would silently bypass the
  // human if the executor asked the policy instead of the log.
  const bare = startExecution(unit.logPath, key, unit.options, at(2), "agent:claude");
  assert.equal(bare.ok, false);
  if (bare.ok) return;
  assert.equal(bare.code, "token-required");
  assert.match(bare.message, /approval\.requested/u);

  const granted = decide(unit.logPath, key, "grant", "human:carter", at(3), unit.options);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.equal(typeof granted.token, "string");

  const started = startExecution(
    unit.logPath,
    key,
    { ...unit.options, token: granted.token ?? "", presentedPayloadHash: bindingFor(key) },
    at(4),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  if (!started.ok) return;
  assert.equal(started.autonomy, "manual");
  assertClean(unit);
});

test("an unsampled supervised-live action proceeds and still enters the retro pool", async () => {
  const key = "task-042:draft";
  const { sparing } = ratesFor(key);
  const unit = ready(
    policyText(["  files.write.*:", "    autonomy: supervised-live", `    live_rate: ${String(sparing)}`]),
    [{ key, cls: "files.write.local" }],
  );

  const asked = ask(unit, key, "files.write.local", 1);
  assert.equal(asked.ok, true);
  if (!asked.ok) return;
  assert.equal(asked.live?.gated, false);
  assert.equal(asked.live?.reason, "not-selected");
  assert.equal(asked.proceed, true);
  assert.equal(asked.autonomy, "supervised");
  assert.equal(asked.record, null, "an unsampled action appends no approval event");

  const started = startExecution(
    unit.logPath,
    key,
    { ...unit.options, presentedPayloadHash: bindingFor(key) },
    at(2),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);

  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  const pool = supervisedExecutions(records(unit), load);
  assert.deepEqual(
    pool.map((candidate) => candidate.actionKey),
    [key],
    "an unsampled live action must still be eligible for retrospective review",
  );
  assertClean(unit);
});

test("a SAMPLED action is not drawn a second time into the retrospective pool", async () => {
  const key = "task-042:draft";
  const { gating } = ratesFor(key);
  const unit = ready(
    policyText(["  files.write.*:", "    autonomy: supervised-live", `    live_rate: ${String(gating)}`]),
    [{ key, cls: "files.write.local" }],
  );

  assert.equal(ask(unit, key, "files.write.local", 1).ok, true);
  const granted = decide(unit.logPath, key, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.equal(
    startExecution(
      unit.logPath,
      key,
      { ...unit.options, token: granted.token ?? "", presentedPayloadHash: bindingFor(key) },
      at(3),
      "agent:claude",
    ).ok,
    true,
  );

  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  // A person already answered this action. Asking them to review the answer they
  // themselves gave would be supervision theatre.
  assert.deepEqual(supervisedExecutions(records(unit), load), []);
  assertClean(unit);
});

// ===========================================================================
// 4. The irreversibility floor, as a floor and not a proof (AC 5)
// ===========================================================================

test("supervised-retro refuses an action declaring reversible: false", async () => {
  const unit = newCase(policyText(["  files.write.*:", "    autonomy: supervised-retro"]));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const floored = resolve(load, "files.write.local", { reversible: false });
  assert.equal(floored.autonomy, "manual");
  assert.equal(floored.declaredAutonomy, "manual");
  assert.equal(floored.supervision, null);
  assert.equal(floored.liveRate, null);
  assert.equal(floored.floorApplied, true);
  assert.equal(floored.provenance, "floor");
});

test("supervised-live refuses an irreversible action too, at every rate", async () => {
  for (const rate of ["0.01", "0.5", "1"]) {
    const unit = newCase(
      policyText(["  files.write.*:", "    autonomy: supervised-live", `    live_rate: ${rate}`]),
    );
    const load = loadPolicy({ file: unit.policyPath });
    assert.equal(load.ok, true, `rate ${rate}`);
    if (!load.ok) continue;
    const floored = resolve(load, "files.write.local", { reversible: false });
    assert.equal(floored.autonomy, "manual", `rate ${rate}`);
    assert.equal(floored.floorApplied, true, `rate ${rate}`);
    // Not "gated at this rate": gated, full stop. A fraction of an irreversible
    // class is still a fraction that runs unreviewed.
    assert.equal(floored.supervision, null, `rate ${rate}`);
  }
});

test("the floor is a floor, not a proof: a claim of reversible cannot raise scrutiny", async () => {
  const unit = newCase(policyText(["  files.write.*:", "    autonomy: supervised-retro"]));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  // Only `false` moves anything, and only towards manual. `true` and "unstated"
  // land in exactly the same place — the class's own declaration — so the field
  // can raise scrutiny and can never reduce it (global invariant 4). What answers
  // a FALSE claim of reversibility is not this function: it is writing `manual`
  // for the class, which no declaration can loosen.
  const claimed = resolve(load, "files.write.local", { reversible: true });
  const unstated = resolve(load, "files.write.local");
  assert.deepEqual(claimed, unstated);
  assert.equal(claimed.autonomy, "supervised");
  assert.equal(claimed.floorApplied, false);
});

// ===========================================================================
// 5. Reconciliation (AC 4)
// ===========================================================================

const RETRO_CLASS = ["  files.write.*:", "    autonomy: supervised-retro"];

test("a retro denial obliges a gated revert for an action declared reversible", async () => {
  const key = "task-042:draft";
  const unit = ready(policyText(RETRO_CLASS), [
    { key, cls: "files.write.local", reversible: true },
  ]);
  const sample = sampleOne(unit, key, 1);

  const review = await runCli(
    unit,
    ["audit", "review", String(sample), "--deny", "--note", "should not have been written", "--json", ...AS_CARTER],
  );
  assert.equal(review.code, 0, review.err);
  const answer = JSON.parse(review.out) as { verdict: string; obligation_seq: number };
  assert.equal(answer.verdict, "denied");
  assert.ok(answer.obligation_seq > 0);

  const open = openObligations(records(unit));
  assert.equal(open.length, 1);
  assert.equal(open[0]?.obligation, "gated-revert");
  assert.equal(open[0]?.actionKey, key);
  assert.equal(open[0]?.class, "files.write.local");
  assert.equal(open[0]?.reversible, true);

  // The obligation is the runtime's derivation, not the reviewer's opinion: it
  // is authored by the system, and the reviewer could not have worded it.
  const obligationRecord = records(unit).find((r) => r.event === "reconciliation.required");
  assert.equal(obligationRecord?.actor, "system:audit");
  assertClean(unit);
});

test("a denial of an action that declared no reversibility records a policy finding", async () => {
  const key = "task-042:draft";
  // Nothing declared. The fail-closed reading is the heavier obligation: a
  // revert nobody said was possible is one that gets closed dishonestly.
  const unit = ready(policyText(RETRO_CLASS), [{ key, cls: "files.write.local" }]);
  const sample = sampleOne(unit, key, 1);

  const review = await runCli(
    unit,
    ["audit", "review", String(sample), "--deny", "--note", "the class is too loose", "--json", ...AS_CARTER],
  );
  assert.equal(review.code, 0, review.err);

  const open = openObligations(records(unit));
  assert.equal(open.length, 1);
  assert.equal(open[0]?.obligation, "policy-finding");
  assert.equal(open[0]?.reversible, null);
  assertClean(unit);
});

test("the obligation shape is a pure function of the declared reversibility", async () => {
  assert.equal(obligationFor(true), "gated-revert");
  assert.equal(obligationFor(false), "policy-finding");
  assert.equal(obligationFor(null), "policy-finding");
});

test("an ordinary review obliges nothing", async () => {
  const key = "task-042:draft";
  const unit = ready(policyText(RETRO_CLASS), [
    { key, cls: "files.write.local", reversible: true },
  ]);
  const sample = sampleOne(unit, key, 1);

  const review = await runCli(unit, ["audit", "review", String(sample), "--json", ...AS_CARTER]);
  assert.equal(review.code, 0, review.err);
  const answer = JSON.parse(review.out) as { verdict: string; obligation_seq: number | null };
  assert.equal(answer.verdict, "ok");
  assert.equal(answer.obligation_seq, null);
  assert.deepEqual(reconciliationObligations(records(unit)), []);
  assertClean(unit);
});

test("satisfaction is human-only, needs a note, and a gated revert needs the chain", async () => {
  const key = "task-042:draft";
  const unit = ready(policyText(RETRO_CLASS), [
    { key, cls: "files.write.local", reversible: true },
  ]);
  const sample = sampleOne(unit, key, 1);
  assert.equal(
    (await runCli(unit, ["audit", "review", String(sample), "--deny", "--note", "no", ...AS_CARTER]))
      .code,
    0,
  );
  const seq = openObligations(records(unit))[0]?.seq ?? 0;
  assert.ok(seq > 0);

  const asAgent = satisfyObligation(unit.logPath, seq, "agent:claude", { note: "done" });
  assert.equal(asAgent.ok, false);
  if (!asAgent.ok) assert.equal(asAgent.code, "actor-not-human");

  const noNote = satisfyObligation(unit.logPath, seq, "human:carter", { note: "   " });
  assert.equal(noNote.ok, false);
  if (!noNote.ok) assert.equal(noNote.code, "note-required");

  const noRevert = satisfyObligation(unit.logPath, seq, "human:carter", { note: "reverted it" });
  assert.equal(noRevert.ok, false);
  if (!noRevert.ok) assert.equal(noRevert.code, "revert-required");

  // Named, but nothing in the chain shows it ran. The runtime checks the chain
  // rather than the claim, or the backlog would be one a sentence could empty.
  const unproven = satisfyObligation(unit.logPath, seq, "human:carter", {
    note: "reverted it",
    revertActionKey: "task-042:restore",
  });
  assert.equal(unproven.ok, false);
  if (!unproven.ok) assert.equal(unproven.code, "revert-required");

  // Nothing above wrote anything.
  assert.equal(openObligations(records(unit)).length, 1);
  assertClean(unit);
});

test("a completed gated revert closes the obligation, and only once", async () => {
  const key = "task-042:draft";
  const revertKey = "task-042:restore";
  const unit = ready(policyText(RETRO_CLASS), [
    { key, cls: "files.write.local", reversible: true },
    { key: revertKey, cls: "files.write.local", reversible: true },
  ]);
  const sample = sampleOne(unit, key, 1);
  assert.equal(
    (await runCli(unit, ["audit", "review", String(sample), "--deny", "--note", "no", ...AS_CARTER]))
      .code,
    0,
  );
  const seq = openObligations(records(unit))[0]?.seq ?? 0;

  // The revert is itself a side-effecting action and goes through the gate: this
  // class is retro, so it starts and finishes through the executor, and the loop
  // closes inside the chain.
  runRevert(unit, revertKey, 5);

  const satisfied = satisfyObligation(unit.logPath, seq, "human:carter", {
    note: "restored the file",
    revertActionKey: revertKey,
  });
  assert.equal(satisfied.ok, true, satisfied.ok ? "" : satisfied.message);
  assert.deepEqual(openObligations(records(unit)), []);

  const again = satisfyObligation(unit.logPath, seq, "human:carter", {
    note: "restored the file",
    revertActionKey: revertKey,
  });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "already-satisfied");
  assertClean(unit);
});

test("an open obligation is loud: status is unhealthy and doctor fails", async () => {
  const key = "task-042:draft";
  const unit = ready(policyText(RETRO_CLASS), [
    { key, cls: "files.write.local", reversible: true },
  ]);
  const sample = sampleOne(unit, key, 1);

  const before = await runCli(unit, ["status", "--json", "--policy", unit.policyPath]);
  assert.equal(before.code, 0, before.err);
  assert.deepEqual((JSON.parse(before.out) as { reconciliation: unknown[] }).reconciliation, []);

  assert.equal(
    (await runCli(unit, ["audit", "review", String(sample), "--deny", "--note", "no", ...AS_CARTER]))
      .code,
    0,
  );

  const after = await runCli(unit, ["status", "--json", "--policy", unit.policyPath]);
  assert.equal(after.code, 1, "an unreconciled denial must not read as healthy");
  const body = JSON.parse(after.out) as {
    healthy: boolean;
    reconciliation: Array<{ obligation: string; action_key: string }>;
  };
  assert.equal(body.healthy, false);
  assert.equal(body.reconciliation.length, 1);
  assert.equal(body.reconciliation[0]?.obligation, "gated-revert");
  assert.equal(body.reconciliation[0]?.action_key, key);

  const listed = await runCli(unit, ["audit", "obligations", "--json"]);
  assert.equal(listed.code, 0, listed.err);
  assert.equal((JSON.parse(listed.out) as { open: number }).open, 1);
  assertClean(unit);
});
